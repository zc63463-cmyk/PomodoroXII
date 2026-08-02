"""Single credential and JWT policy authority for REST and MCP adapters."""

from __future__ import annotations

import asyncio
import uuid
from dataclasses import dataclass
from typing import Literal

import jwt
from sqlalchemy import Integer, cast, select, update
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.security import (
    create_master_token,
    decode_access_token,
    hash_password,
    verify_password,
)
from app.db.meta_session import get_meta_session_factory
from app.db.models.meta import MetaSetting, Space
from app.errors import (
    AuthenticationError,
    AuthorizationError,
    ConflictError,
    NotFoundError,
    ValidationError,
)

PASSWORD_KEY = "admin_password"
EPOCH_KEY = "credential_epoch"


@dataclass(frozen=True, slots=True)
class Principal:
    subject: str
    token_type: Literal["master", "space", "trusted_stdio"]
    epoch: int
    expires_at: int | None
    space_id: str | None = None


class CredentialAuthority:
    """Own password policy, persisted credential epoch, and JWT verification."""

    def __init__(self, db: AsyncSession) -> None:
        self.db = db

    @staticmethod
    async def hash_for_storage(password: str) -> str:
        return await asyncio.to_thread(hash_password, password)

    @staticmethod
    async def verify_hash(password: str, hashed: str) -> bool:
        return await asyncio.to_thread(verify_password, password, hashed)

    async def bootstrap_epoch(self) -> int:
        statement = sqlite_insert(MetaSetting).values(
            id=uuid.uuid4().hex,
            key=EPOCH_KEY,
            value="1",
        )
        await self.db.execute(
            statement.on_conflict_do_nothing(index_elements=["key"])
        )
        await self.db.commit()
        value = await self.db.scalar(
            select(MetaSetting.value).where(MetaSetting.key == EPOCH_KEY)
        )
        if value is None:
            raise RuntimeError("credential epoch bootstrap did not persist")
        return int(value)

    async def setup(self, password: str) -> None:
        try:
            hashed = await self.hash_for_storage(password)
        except ValueError as exc:
            raise ValidationError(str(exc)) from exc

        password_insert = sqlite_insert(MetaSetting).values(
            id=uuid.uuid4().hex,
            key=PASSWORD_KEY,
            value=hashed,
        )
        result = await self.db.execute(
            password_insert.on_conflict_do_nothing(index_elements=["key"])
        )
        if result.rowcount != 1:
            await self.db.rollback()
            raise ConflictError("Admin password is already set")

        epoch_insert = sqlite_insert(MetaSetting).values(
            id=uuid.uuid4().hex,
            key=EPOCH_KEY,
            value="1",
        )
        await self.db.execute(
            epoch_insert.on_conflict_do_nothing(index_elements=["key"])
        )
        await self.db.commit()

    async def login(self, password: str) -> str:
        rows = (
            await self.db.execute(
                select(MetaSetting).where(
                    MetaSetting.key.in_([PASSWORD_KEY, EPOCH_KEY])
                )
            )
        ).scalars()
        settings_by_key = {row.key: row.value for row in rows}
        hashed = settings_by_key.get(PASSWORD_KEY)
        epoch = settings_by_key.get(EPOCH_KEY)
        if (
            hashed is None
            or epoch is None
            or not await self.verify_hash(password, hashed)
        ):
            raise AuthenticationError("Invalid password")
        return create_master_token("admin", epoch=int(epoch))

    async def verify(
        self,
        token: str,
        required_scope: Literal["master", "space"] | None,
    ) -> Principal:
        try:
            payload = decode_access_token(token)
        except jwt.PyJWTError as exc:
            raise AuthenticationError("Invalid or expired token") from exc

        subject = payload.get("sub")
        token_type = payload.get("type")
        epoch = payload.get("epoch")
        expires_at = payload.get("exp")
        if (
            not isinstance(subject, str)
            or not subject
            or token_type not in {"master", "space"}
            or type(epoch) is not int
            or type(expires_at) is not int
        ):
            raise AuthenticationError("Invalid or expired token")

        stored_epoch = await self.db.scalar(
            select(MetaSetting.value).where(MetaSetting.key == EPOCH_KEY)
        )
        if stored_epoch is None or int(stored_epoch) != epoch:
            raise AuthenticationError("Invalid or expired token")
        if required_scope is not None and token_type != required_scope:
            raise AuthorizationError(f"{required_scope.title()} token required")

        space_id = payload.get("space_id")
        if token_type == "space":
            if not isinstance(space_id, str) or not space_id:
                raise AuthenticationError("Invalid or expired token")
            if await self.db.get(Space, space_id) is None:
                raise NotFoundError(
                    "Space is not registered",
                    code="space_not_found",
                )
        else:
            space_id = None

        return Principal(
            subject=subject,
            token_type=token_type,
            epoch=epoch,
            expires_at=expires_at,
            space_id=space_id,
        )

    async def revoke(self, subject: str) -> int:
        if subject != "admin":
            raise AuthorizationError("Only the admin credential can be revoked")
        statement = (
            update(MetaSetting)
            .where(MetaSetting.key == EPOCH_KEY)
            .values(value=cast(MetaSetting.value, Integer) + 1)
            .returning(MetaSetting.value)
        )
        value = await self.db.scalar(statement)
        if value is None:
            await self.db.rollback()
            raise AuthenticationError("Invalid or expired token")
        await self.db.commit()
        return int(value)


async def bootstrap_credential_epoch() -> int:
    factory = get_meta_session_factory()
    async with factory() as db:
        return await CredentialAuthority(db).bootstrap_epoch()


async def verify_with_fresh_meta_session(
    token: str,
    required_scope: Literal["master", "space"] | None,
) -> Principal:
    factory = get_meta_session_factory()
    async with factory() as db:
        return await CredentialAuthority(db).verify(token, required_scope)
