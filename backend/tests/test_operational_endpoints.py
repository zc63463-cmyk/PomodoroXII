"""Operations credential lifecycle contracts."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest
from sqlalchemy import select


@pytest.mark.asyncio
async def test_operations_credential_is_digest_only_and_rotation_revokes_old_token() -> None:
    from app.db.meta_session import get_meta_session, init_meta_db
    from app.db.models.meta import MetaSetting
    from app.errors import AuthorizationError
    from app.ops.credentials import OperationsCredentialStore

    await init_meta_db()
    async for session in get_meta_session():
        store = OperationsCredentialStore(session)
        issued = await store.issue()
        assert len(issued.token_bytes) == 32
        assert await store.verify(issued.token) == issued.principal

        stored_digest = await session.scalar(
            select(MetaSetting.value).where(MetaSetting.key == "operations_token_sha256")
        )
        assert stored_digest == hashlib.sha256(issued.token.encode("ascii")).hexdigest()
        assert issued.token not in stored_digest

        rotated = await store.rotate()
        with pytest.raises(AuthorizationError):
            await store.verify(issued.token)
        assert await store.verify(rotated.token) == rotated.principal

        await store.revoke()
        with pytest.raises(AuthorizationError):
            await store.verify(rotated.token)
        break


# --------------------------------------------------------------------------- #
# CLI: python -m app.ops credentials issue|rotate|revoke
# --------------------------------------------------------------------------- #


def _invoke_credentials_cli(
    args: list[str], monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> int:
    import app.ops.cli as ops_cli

    return ops_cli.main(args)


def test_credentials_issue_prints_raw_token_once_and_json_receipt_has_no_token(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    import app.ops.cli as ops_cli
    from app.db.meta_session import init_meta_db

    async def _prepare() -> None:
        await init_meta_db()

    import asyncio

    asyncio.run(_prepare())

    data_root = tmp_path
    exit_code = _invoke_credentials_cli(
        ["credentials", "issue", "--data-root", str(data_root)],
        monkeypatch,
        capsys,
    )
    assert exit_code == 0
    stdout = capsys.readouterr().out
    token = stdout.strip()
    assert len(token) > 20
    assert stdout.count(token) == 1

    # JSON mode must not contain the raw token (revoke first so issue succeeds).
    exit_code = _invoke_credentials_cli(
        ["credentials", "revoke", "--data-root", str(data_root), "--json"],
        monkeypatch,
        capsys,
    )
    assert exit_code == 0
    capsys.readouterr()
    exit_code = _invoke_credentials_cli(
        ["credentials", "issue", "--data-root", str(data_root), "--json"],
        monkeypatch,
        capsys,
    )
    assert exit_code == 0
    captured = capsys.readouterr()
    payload = json.loads(captured.out)
    assert payload["ok"] is True
    assert "token" not in json.dumps(payload)


def test_credentials_rotate_revokes_old_and_issue_conflicts_when_exists(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    import asyncio
    import json

    import app.ops.cli as ops_cli
    from app.db.meta_session import init_meta_db

    asyncio.run(init_meta_db())

    exit_code = _invoke_credentials_cli(
        ["credentials", "issue", "--data-root", str(tmp_path)],
        monkeypatch,
        capsys,
    )
    assert exit_code == 0
    first = capsys.readouterr().out.strip()

    # issue again -> conflict, exit 2
    exit_code = _invoke_credentials_cli(
        ["credentials", "issue", "--data-root", str(tmp_path), "--json"],
        monkeypatch,
        capsys,
    )
    assert exit_code == 2
    payload = json.loads(capsys.readouterr().out)
    assert payload["ok"] is False
    assert payload["error"]["code"] in {"conflict", "argument_error", "already_exists"}

    # rotate -> old token invalid, new token printed once
    exit_code = _invoke_credentials_cli(
        ["credentials", "rotate", "--data-root", str(tmp_path)],
        monkeypatch,
        capsys,
    )
    assert exit_code == 0
    second = capsys.readouterr().out.strip()
    assert second != first

    from app.db.meta_session import get_meta_session
    from app.errors import AuthorizationError
    from app.ops.credentials import OperationsCredentialStore

    async def _verify() -> None:
        async for session in get_meta_session():
            store = OperationsCredentialStore(session)
            with pytest.raises(AuthorizationError):
                await store.verify(first)
            assert await store.verify(second) == (
                await store.verify(second)
            )
            break

    asyncio.run(_verify())


def test_credentials_revoke_disables_metrics_access(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    import asyncio
    import json

    import app.ops.cli as ops_cli
    from app.db.meta_session import get_meta_session, init_meta_db
    from app.ops.credentials import OperationsCredentialStore

    asyncio.run(init_meta_db())

    exit_code = _invoke_credentials_cli(
        ["credentials", "issue", "--data-root", str(tmp_path)],
        monkeypatch,
        capsys,
    )
    assert exit_code == 0
    token = capsys.readouterr().out.strip()

    exit_code = _invoke_credentials_cli(
        ["credentials", "revoke", "--data-root", str(tmp_path), "--json"],
        monkeypatch,
        capsys,
    )
    assert exit_code == 0

    async def _verify() -> None:
        from app.errors import AuthorizationError

        async for session in get_meta_session():
            store = OperationsCredentialStore(session)
            with pytest.raises(AuthorizationError):
                await store.verify(token)
            break

    asyncio.run(_verify())
