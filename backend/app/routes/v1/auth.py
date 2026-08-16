"""Authentication routes backed by the central credential authority."""

from __future__ import annotations

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.authority import CredentialAuthority
from app.deps import get_current_user, get_meta_db, require_master_token
from app.schemas.auth import (
    AuthLoginResponse,
    AuthRevokeResponse,
    AuthSetupResponse,
    AuthVerifyResponse,
)

router = APIRouter()


class PasswordRequest(BaseModel):
    password: str


@router.post("/setup", status_code=201, response_model=AuthSetupResponse)
async def setup_password(
    body: PasswordRequest,
    db: AsyncSession = Depends(get_meta_db),
) -> dict:
    await CredentialAuthority(db).setup(body.password)
    return {"message": "Password set"}


@router.post("/login", response_model=AuthLoginResponse)
async def login(
    body: PasswordRequest,
    db: AsyncSession = Depends(get_meta_db),
) -> dict:
    token = await CredentialAuthority(db).login(body.password)
    return {"access_token": token, "token_type": "bearer"}


@router.get("/verify", response_model=AuthVerifyResponse)
async def verify_token(payload: dict = Depends(get_current_user)) -> dict:
    return {"valid": True, "user_id": payload["sub"], "type": payload["type"]}


@router.post("/revoke", response_model=AuthRevokeResponse)
async def revoke_tokens(
    user: dict = Depends(require_master_token),
    db: AsyncSession = Depends(get_meta_db),
) -> dict:
    await CredentialAuthority(db).revoke(str(user["sub"]))
    return {"message": "Tokens revoked"}
