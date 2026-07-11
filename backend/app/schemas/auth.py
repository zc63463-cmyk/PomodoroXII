"""Pydantic response schemas for authentication routes."""

from pydantic import BaseModel


class AuthSetupResponse(BaseModel):
    """Successful first-time password setup."""

    message: str


class AuthLoginResponse(BaseModel):
    """Master-token response returned after login."""

    access_token: str
    token_type: str


class AuthVerifyResponse(BaseModel):
    """Claims exposed after verifying a bearer token."""

    valid: bool
    user_id: str
    type: str
