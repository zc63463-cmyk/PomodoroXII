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
def hash_password(password: str) -> str:
    """Hash a plain-text password using bcrypt (12 rounds)."""
    # bcrypt has a 72-byte limit; truncate if necessary.
    pwd_bytes = password.encode("utf-8")[:72]
    salt = bcrypt.gensalt(rounds=12)
    hashed = bcrypt.hashpw(pwd_bytes, salt)
    return hashed.decode("utf-8")


def verify_password(password: str, hashed: str) -> bool:
    """Verify a plain-text password against a bcrypt hash."""
    pwd_bytes = password.encode("utf-8")[:72]
    hash_bytes = hashed.encode("utf-8")
    return bcrypt.checkpw(pwd_bytes, hash_bytes)


# --------------------------------------------------------------------------- #
# Token creation / decoding
# --------------------------------------------------------------------------- #
def _now() -> datetime:
    return datetime.now(timezone.utc)


def create_master_token(user_id: str) -> str:
    """Create a long-lived master JWT (7 days)."""
    expire = _now() + timedelta(days=settings.master_token_expire_days)
    payload: dict[str, Any] = {
        "sub": user_id,
        "type": "master",
        "exp": expire,
    }
    return jwt.encode(payload, settings.secret_key, algorithm=settings.algorithm)


def create_space_token(space_id: str, user_id: str) -> str:
    """Create a short-lived space-scoped JWT (8 hours)."""
    expire = _now() + timedelta(hours=settings.space_token_expire_hours)
    payload: dict[str, Any] = {
        "sub": user_id,
        "type": "space",
        "space_id": space_id,
        "exp": expire,
    }
    return jwt.encode(payload, settings.secret_key, algorithm=settings.algorithm)


def decode_access_token(token: str) -> dict[str, Any]:
    """Decode and validate a JWT.

    Returns the payload dict. Raises ``jwt.PyJWTError`` (or a subclass)
    on invalid/expired tokens; callers should catch and map to 401.
    """
    return jwt.decode(token, settings.secret_key, algorithms=[settings.algorithm])
