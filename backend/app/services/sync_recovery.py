"""Stateless, snapshot-bound proof for one-time sync recovery ACKs."""

from __future__ import annotations

from datetime import datetime
from typing import Any

import jwt

from app.errors import ConflictError
from app.services.time import utc_now
from app.settings import settings

PROOF_TYPE = "sync-recovery"
CONTINUATION_TYPE = "sync-recovery-continuation"
PROOF_VERSION = 1
_REQUIRED_CLAIMS = [
    "typ",
    "ver",
    "space",
    "user",
    "client",
    "snapshot",
    "cursor",
    "iat",
    "exp",
]


def _invalid_proof() -> ConflictError:
    return ConflictError(
        "sync recovery proof is invalid",
        error_type="sync_recovery_proof_invalid",
    )


def issue_recovery_proof(
    *,
    space_id: str,
    user_id: str,
    client_id: str,
    snapshot_token: str,
    snapshot_cursor: int,
    snapshot_expires_at: str,
) -> str:
    now = utc_now()
    try:
        expires_at = datetime.fromisoformat(snapshot_expires_at.replace("Z", "+00:00"))
    except ValueError as exc:
        raise _invalid_proof() from exc
    if expires_at <= now:
        raise _invalid_proof()
    payload: dict[str, Any] = {
        "typ": PROOF_TYPE,
        "ver": PROOF_VERSION,
        "space": space_id,
        "user": user_id,
        "client": client_id,
        "snapshot": snapshot_token,
        "cursor": snapshot_cursor,
        "iat": now,
        "exp": expires_at,
    }
    return jwt.encode(payload, settings.secret_key, algorithm=settings.algorithm)


def issue_recovery_continuation(
    *,
    space_id: str,
    user_id: str,
    client_id: str,
    snapshot_token: str,
    snapshot_cursor: int,
    expected_offset: int,
    snapshot_expires_at: str,
) -> str:
    now = utc_now()
    try:
        expires_at = datetime.fromisoformat(snapshot_expires_at.replace("Z", "+00:00"))
    except ValueError as exc:
        raise _invalid_proof() from exc
    if expires_at <= now:
        raise _invalid_proof()
    return jwt.encode(
        {
            "typ": CONTINUATION_TYPE,
            "ver": PROOF_VERSION,
            "space": space_id,
            "user": user_id,
            "client": client_id,
            "snapshot": snapshot_token,
            "cursor": snapshot_cursor,
            "offset": expected_offset,
            "iat": now,
            "exp": expires_at,
        },
        settings.secret_key,
        algorithm=settings.algorithm,
    )


def verify_recovery_continuation(
    continuation: str,
    *,
    space_id: str,
    user_id: str,
    client_id: str,
    snapshot_token: str,
    snapshot_cursor: int,
    snapshot_offset: int,
) -> None:
    try:
        claims = jwt.decode(
            continuation,
            settings.secret_key,
            algorithms=[settings.algorithm],
            options={"require": [*_REQUIRED_CLAIMS, "offset"]},
        )
        if (
            claims["typ"] != CONTINUATION_TYPE
            or claims["ver"] != PROOF_VERSION
            or claims["space"] != space_id
            or claims["user"] != user_id
            or claims["client"] != client_id
            or claims["snapshot"] != snapshot_token
            or claims["cursor"] != snapshot_cursor
            or claims["offset"] != snapshot_offset
            or not isinstance(claims["offset"], int)
        ):
            raise _invalid_proof()
    except jwt.PyJWTError as exc:
        raise _invalid_proof() from exc
    except (KeyError, TypeError, ValueError) as exc:
        raise _invalid_proof() from exc


def verify_recovery_proof(
    proof: str,
    *,
    space_id: str,
    user_id: str,
    client_id: str,
    ack_cursor: int,
) -> dict[str, Any]:
    try:
        claims = jwt.decode(
            proof,
            settings.secret_key,
            algorithms=[settings.algorithm],
            options={"require": _REQUIRED_CLAIMS},
        )
        if (
            claims["typ"] != PROOF_TYPE
            or claims["ver"] != PROOF_VERSION
            or claims["space"] != space_id
            or claims["user"] != user_id
            or claims["client"] != client_id
            or claims["cursor"] != ack_cursor
            or not isinstance(claims["snapshot"], str)
            or not claims["snapshot"]
            or not isinstance(claims["cursor"], int)
        ):
            raise _invalid_proof()
    except jwt.PyJWTError as exc:
        raise _invalid_proof() from exc
    except (KeyError, TypeError, ValueError) as exc:
        raise _invalid_proof() from exc
    return claims
