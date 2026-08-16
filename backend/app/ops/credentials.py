"""Digest-only credentials for operational endpoints."""

from __future__ import annotations

import base64
import hashlib
import hmac
import secrets
import uuid
from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models.meta import MetaSetting
from app.errors import AuthorizationError, ConflictError

_TOKEN_DIGEST_KEY = "operations_token_sha256"
_TOKEN_EPOCH_KEY = "operations_token_epoch"


@dataclass(frozen=True, slots=True)
class OperationsPrincipal:
    scope: str
    epoch: int


@dataclass(frozen=True, slots=True)
class IssuedCredential:
    token: str
    token_bytes: bytes
    principal: OperationsPrincipal


class OperationsCredentialStore:
    """Issue, rotate, revoke, and verify one Meta-backed operations token."""

    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    @staticmethod
    def _new_token() -> tuple[str, bytes]:
        raw = secrets.token_bytes(32)
        token = base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")
        return token, raw

    async def _epoch(self) -> int:
        value = await self._session.scalar(
            select(MetaSetting.value).where(MetaSetting.key == _TOKEN_EPOCH_KEY)
        )
        return int(value) if value is not None else 0

    async def _store(self, token: str, *, require_existing: bool) -> IssuedCredential:
        existing = await self._session.scalar(
            select(MetaSetting).where(MetaSetting.key == _TOKEN_DIGEST_KEY)
        )
        if require_existing and existing is None:
            raise AuthorizationError("Operations credential is not configured")
        if not require_existing and existing is not None:
            raise ConflictError("Operations credential already exists")

        epoch = await self._epoch() + 1
        digest = hashlib.sha256(token.encode("ascii")).hexdigest()
        if existing is None:
            self._session.add(
                MetaSetting(id=uuid.uuid4().hex, key=_TOKEN_DIGEST_KEY, value=digest)
            )
        else:
            existing.value = digest

        epoch_setting = await self._session.scalar(
            select(MetaSetting).where(MetaSetting.key == _TOKEN_EPOCH_KEY)
        )
        if epoch_setting is None:
            self._session.add(
                MetaSetting(id=uuid.uuid4().hex, key=_TOKEN_EPOCH_KEY, value=str(epoch))
            )
        else:
            epoch_setting.value = str(epoch)
        try:
            await self._session.commit()
        except IntegrityError as exc:
            await self._session.rollback()
            raise ConflictError("Operations credential already exists") from exc
        return IssuedCredential(
            token=token,
            token_bytes=base64.urlsafe_b64decode(token + "=" * (-len(token) % 4)),
            principal=OperationsPrincipal(scope="operations", epoch=epoch),
        )

    async def issue(self) -> IssuedCredential:
        token, _ = self._new_token()
        return await self._store(token, require_existing=False)

    async def rotate(self) -> IssuedCredential:
        token, _ = self._new_token()
        return await self._store(token, require_existing=True)

    async def revoke(self) -> None:
        setting = await self._session.scalar(
            select(MetaSetting).where(MetaSetting.key == _TOKEN_DIGEST_KEY)
        )
        if setting is None:
            raise AuthorizationError("Operations credential is not configured")
        await self._session.delete(setting)
        epoch_setting = await self._session.scalar(
            select(MetaSetting).where(MetaSetting.key == _TOKEN_EPOCH_KEY)
        )
        epoch = await self._epoch() + 1
        if epoch_setting is None:
            self._session.add(
                MetaSetting(id=uuid.uuid4().hex, key=_TOKEN_EPOCH_KEY, value=str(epoch))
            )
        else:
            epoch_setting.value = str(epoch)
        await self._session.commit()

    async def verify(self, token: str) -> OperationsPrincipal:
        expected = await self._session.scalar(
            select(MetaSetting.value).where(MetaSetting.key == _TOKEN_DIGEST_KEY)
        )
        try:
            supplied = hashlib.sha256(token.encode("ascii")).hexdigest()
        except (UnicodeEncodeError, AttributeError):
            supplied = ""
        if expected is None or not hmac.compare_digest(expected, supplied):
            raise AuthorizationError("Operations credential required")
        return OperationsPrincipal(scope="operations", epoch=await self._epoch())
