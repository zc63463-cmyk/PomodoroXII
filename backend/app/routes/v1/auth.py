"""Authentication routes: setup, login, token verification.

All auth routes operate on the *meta* database (``get_meta_db``) because
admin credentials are stored as a ``MetaSetting`` row with
``key="admin_password"``.
"""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.security import hash_password, verify_password, create_master_token
from app.db.models.meta import MetaSetting
from app.deps import get_current_user, get_meta_db
from app.errors import AuthenticationError, ConflictError

router = APIRouter()


class PasswordRequest(BaseModel):
    """Request body for password setup / login."""

    password: str


@router.post("/setup", status_code=201)
async def setup_password(
    body: PasswordRequest,
    db: AsyncSession = Depends(get_meta_db),
) -> dict:
    """First-time admin password setup.

    Stores ``hash_password(password)`` in a ``MetaSetting`` row with
    ``key="admin_password"``.  Returns 409 if a password is already set.
    """
    result = await db.execute(
        select(MetaSetting).where(MetaSetting.key == "admin_password")
    )
    existing = result.scalar_one_or_none()
    if existing is not None:
        raise ConflictError("Admin password is already set")

    setting = MetaSetting(
        id=uuid.uuid4().hex,
        key="admin_password",
        value=hash_password(body.password),
    )
    db.add(setting)
    await db.commit()
    return {"message": "Password set"}


@router.post("/login")
async def login(
    body: PasswordRequest,
    db: AsyncSession = Depends(get_meta_db),
) -> dict:
    """Verify the admin password and issue a master JWT.

    Returns 401 if the password is wrong or no password has been set.
    """
    result = await db.execute(
        select(MetaSetting).where(MetaSetting.key == "admin_password")
    )
    setting = result.scalar_one_or_none()
    if setting is None or not verify_password(body.password, setting.value or ""):
        raise AuthenticationError("Invalid password")

    return {"access_token": create_master_token("admin"), "token_type": "bearer"}


@router.get("/verify")
async def verify_token(payload: dict = Depends(get_current_user)) -> dict:
    """Verify the current Bearer token and return its claims."""
    return {"valid": True, "user_id": payload["sub"], "type": payload["type"]}
