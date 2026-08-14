"""Operations credential lifecycle contracts."""

from __future__ import annotations

import hashlib

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
