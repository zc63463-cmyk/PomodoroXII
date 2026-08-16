"""Password hashing and JWT token utilities (PyJWT + bcrypt).

Two token flavours exist in PomodoroXII:

- ``master`` token: long-lived (7d), grants access to the meta layer
  (space registry, global settings). ``type == "master"``.
- ``space`` token: short-lived (8h), scoped to a single space.
  Carries ``space_id`` and ``type == "space"``.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

import bcrypt
import jwt

from app.settings import settings

# --------------------------------------------------------------------------- #
# Password hashing
# --------------------------------------------------------------------------- #
MIN_PASSWORD_BYTES = 12
MAX_PASSWORD_BYTES = 64


def validate_password_policy(password: str) -> bytes:
    """Validate the non-truncating password policy and return UTF-8 bytes."""
    encoded = password.encode("utf-8")
    if not MIN_PASSWORD_BYTES <= len(encoded) <= MAX_PASSWORD_BYTES:
        raise ValueError("Password must be 12 to 64 UTF-8 bytes")
    return encoded


def hash_password(password: str) -> str:
    """Hash a plain-text password using bcrypt (12 rounds)."""
    pwd_bytes = validate_password_policy(password)
    salt = bcrypt.gensalt(rounds=12)
    hashed = bcrypt.hashpw(pwd_bytes, salt)
    return hashed.decode("utf-8")


def verify_password(password: str, hashed: str) -> bool:
    """Verify a plain-text password against a bcrypt hash."""
    try:
        pwd_bytes = validate_password_policy(password)
    except ValueError:
        return False
    hash_bytes = hashed.encode("utf-8")
    return bcrypt.checkpw(pwd_bytes, hash_bytes)


# --------------------------------------------------------------------------- #
# Token creation / decoding
# --------------------------------------------------------------------------- #
def _now() -> datetime:
    return datetime.now(timezone.utc)


def create_master_token(user_id: str, *, epoch: int) -> str:
    """Create a long-lived master JWT (7 days)."""
    expire = _now() + timedelta(days=settings.master_token_expire_days)
    payload: dict[str, Any] = {
        "sub": user_id,
        "type": "master",
        "epoch": epoch,
        "exp": expire,
    }
    return jwt.encode(payload, settings.secret_key, algorithm=settings.algorithm)


def create_space_token(space_id: str, user_id: str, *, epoch: int) -> str:
    """Create a short-lived space-scoped JWT (8 hours)."""
    expire = _now() + timedelta(hours=settings.space_token_expire_hours)
    payload: dict[str, Any] = {
        "sub": user_id,
        "type": "space",
        "space_id": space_id,
        "epoch": epoch,
        "exp": expire,
    }
    return jwt.encode(payload, settings.secret_key, algorithm=settings.algorithm)


def decode_access_token(token: str) -> dict[str, Any]:
    """Decode and validate a JWT.

    Returns the payload dict. Raises ``jwt.PyJWTError`` (or a subclass)
    on invalid/expired tokens; callers should catch and map to 401.
    """
    return jwt.decode(token, settings.secret_key, algorithms=[settings.algorithm])
