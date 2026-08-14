"""S5 Task 3: canonical operations CLI contract.

``python -m app.ops snapshot|verify|restore|cutover|relocate`` must reuse the
recovery coordinator through ``LocalRecoveryService`` (no re-implementation of
recovery algorithms), emit exactly one canonical JSON document in ``--json``
mode, and map DomainFailure/argument errors to exit 2 and unexpected internal
errors to exit 1.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

from tests.test_recovery import _coordinator


def _invoke_cli(args: list[str], monkeypatch: pytest.MonkeyPatch, service_factory=None):
    """Run the real ``app.ops.cli.main`` with an injectable service factory."""
    import app.ops.cli as ops_cli

    if service_factory is not None:
        monkeypatch.setattr(ops_cli, "LocalRecoveryService", service_factory)
    return ops_cli.main(args)


def _canonical_service_factory(active_root: Path):
    """Return a factory that builds a real LocalRecoveryService for a root."""
    from app.recovery.local_service import LocalRecoveryService

    def _factory(root: Path):
        return LocalRecoveryService(root)

    return _factory


def test_snapshot_cli_emits_single_canonical_json_line(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    coordinator, _leases, active_root, engines = _coordinator(tmp_path)

    class FakeCoordinator:
        async def snapshot(self, _target: Path):
            return SimpleNamespace(
                root=tmp_path / "snapshots" / "published",
                manifest_sha256="a" * 64,
            )

    class FakeService:
        def __init__(self, root: Path) -> None:
            assert root == active_root.absolute()
            self.coordinator = FakeCoordinator()

        async def aclose(self) -> None:
            return None

    exit_code = _invoke_cli(
        ["snapshot", "--target", str(tmp_path / "snapshots"), "--data-root", str(active_root), "--json"],
        monkeypatch,
        service_factory=FakeService,
    )

    out = capsys.readouterr().out
    assert exit_code == 0
    assert out.count("\n") == 1
    body = json.loads(out.strip())
    assert body["ok"] is True
    assert body["command"] == "snapshot"
    assert body["result"]["manifest_sha256"] == "a" * 64
    assert capsys.readouterr().err == ""


def test_snapshot_cli_domain_failure_returns_exit_2(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    from app.recovery import DomainFailure

    coordinator, _leases, active_root, engines = _coordinator(tmp_path)

    class FailingCoordinator:
        async def snapshot(self, _target: Path):
            raise DomainFailure("snapshot_invalid", "snapshot target is invalid")

    class FailingService:
        def __init__(self, root: Path) -> None:
            self.coordinator = FailingCoordinator()

        async def aclose(self) -> None:
            return None

    exit_code = _invoke_cli(
        ["snapshot", "--target", str(tmp_path / "snapshots"), "--data-root", str(active_root), "--json"],
        monkeypatch,
        service_factory=FailingService,
    )

    out = capsys.readouterr().out
    assert exit_code == 2
    body = json.loads(out.strip())
    assert body["ok"] is False
    assert body["command"] == "snapshot"
    assert body["error"]["code"] == "snapshot_invalid"
    assert "traceback" not in out.lower()
    assert "Traceback" not in capsys.readouterr().err


def test_cli_argument_error_returns_exit_2(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    exit_code = _invoke_cli(
        ["snapshot", "--json"],  # missing required --target
        monkeypatch,
    )
    assert exit_code == 2
    out = capsys.readouterr().out
    body = json.loads(out.strip())
    assert body["ok"] is False
    assert body["error"]["code"] in {"argument_error", "usage_error"}


def test_cli_unknown_command_returns_exit_2(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    exit_code = _invoke_cli(["not-a-command", "--json"], monkeypatch)
    assert exit_code == 2


def test_cli_unexpected_internal_error_returns_exit_1(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    coordinator, _leases, active_root, engines = _coordinator(tmp_path)

    class ExplodingCoordinator:
        async def snapshot(self, _target: Path):
            raise RuntimeError("unexpected internal boom")

    class ExplodingService:
        def __init__(self, root: Path) -> None:
            self.coordinator = ExplodingCoordinator()

        async def aclose(self) -> None:
            return None

    exit_code = _invoke_cli(
        ["snapshot", "--target", str(tmp_path / "snapshots"), "--data-root", str(active_root), "--json"],
        monkeypatch,
        service_factory=ExplodingService,
    )

    assert exit_code == 1
    out = capsys.readouterr().out
    body = json.loads(out.strip())
    assert body["ok"] is False
    assert body["error"]["code"] == "internal_error"
    assert "Traceback" not in out


def test_cli_five_commands_are_registered() -> None:
    import app.ops.cli as ops_cli

    assert set(ops_cli.COMMANDS) == {
        "snapshot",
        "verify",
        "restore",
        "cutover",
        "relocate",
    }


def test_verify_cli_reuses_coordinator_verify(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    coordinator, _leases, active_root, engines = _coordinator(tmp_path)

    class FakeCoordinator:
        async def verify(self, _snapshot: Path):
            return SimpleNamespace(
                valid=True,
                manifest_sha256="b" * 64,
                failures=(),
                checked_files=3,
                checked_spaces=1,
            )

    class FakeService:
        def __init__(self, root: Path) -> None:
            self.coordinator = FakeCoordinator()

        async def aclose(self) -> None:
            return None

    exit_code = _invoke_cli(
        ["verify", "--snapshot", str(tmp_path / "published-snapshot"), "--data-root", str(active_root), "--json"],
        monkeypatch,
        service_factory=FakeService,
    )

    assert exit_code == 0
    body = json.loads(capsys.readouterr().out.strip())
    assert body["ok"] is True
    assert body["command"] == "verify"
    assert body["result"]["valid"] is True


def test_cutover_cli_rejects_force_flag(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    exit_code = _invoke_cli(
        [
            "cutover",
            "--receipt",
            str(tmp_path / "staged-receipt.json"),
            "--force",
            "--json",
        ],
        monkeypatch,
    )
    assert exit_code == 2
    body = json.loads(capsys.readouterr().out.strip())
    assert body["ok"] is False
