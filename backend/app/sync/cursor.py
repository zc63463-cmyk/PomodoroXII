"""Authenticated opaque Sync v2 cursor tokens.

This module is the only S4 Task 2 boundary that translates a public cursor
string into an allocated ledger sequence.  Callers receive a fixed safe
``cursor_expired`` error for every malformed or tampered token.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import json
import re
from dataclasses import dataclass

from app.errors import SyncCursorExpiredError

_IDENTIFIER = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")
_CATALOG_HASH = re.compile(r"^[0-9a-f]{64}$")
_MIN_TOKEN_BYTES = 16
_MAX_TOKEN_BYTES = 2048
_CURSOR_FIELDS = frozenset(
    {"catalog_hash", "client_id", "generation", "sequence", "space_id", "version"}
)


def _validate_identifier(value: object, *, field: str) -> str:
    if not isinstance(value, str) or _IDENTIFIER.fullmatch(value) is None:
        raise ValueError(f"{field} is invalid")
    return value


@dataclass(frozen=True, slots=True)
class CursorPosition:
    """A server ledger position bound to one Space/client/generation."""

    sequence: int
    catalog_hash: str
    space_id: str
    client_id: str
    generation: int

    def __post_init__(self) -> None:
        if type(self.sequence) is not int or self.sequence < 0:
            raise ValueError("sequence must be a nonnegative integer")
        if not isinstance(self.catalog_hash, str) or _CATALOG_HASH.fullmatch(
            self.catalog_hash
        ) is None:
            raise ValueError("catalog_hash must be 64 lowercase hexadecimal characters")
        _validate_identifier(self.space_id, field="space_id")
        _validate_identifier(self.client_id, field="client_id")
        if type(self.generation) is not int or self.generation < 0:
            raise ValueError("generation must be a nonnegative integer")


def _decode_base64url_segment(segment: str) -> bytes:
    if not isinstance(segment, str) or not segment or "=" in segment:
        raise ValueError("invalid base64url segment")
    try:
        raw = segment.encode("ascii")
    except UnicodeEncodeError as exc:
        raise ValueError("invalid base64url segment") from exc
    if len(raw) % 4 == 1:
        raise ValueError("invalid base64url length")
    try:
        decoded = base64.b64decode(
            raw + b"=" * (-len(raw) % 4), altchars=b"-_", validate=True
        )
    except (binascii.Error, ValueError) as exc:
        raise ValueError("invalid base64url segment") from exc
    # Reject alternate spellings accepted by a permissive base64 decoder.
    canonical = base64.urlsafe_b64encode(decoded).rstrip(b"=")
    if canonical != raw:
        raise ValueError("non-canonical base64url segment")
    return decoded


class SyncCursorCodec:
    """Encode/decode HMAC-authenticated opaque cursor strings."""

    def __init__(self, secret: bytes) -> None:
        if not isinstance(secret, bytes) or len(secret) < 32:
            raise ValueError("cursor secret must be at least 32 bytes")
        self._secret = secret

    def encode(self, position: CursorPosition) -> str:
        if not isinstance(position, CursorPosition):
            raise TypeError("position must be a CursorPosition")
        payload = json.dumps(
            {
                "catalog_hash": position.catalog_hash,
                "client_id": position.client_id,
                "generation": position.generation,
                "sequence": position.sequence,
                "space_id": position.space_id,
                "version": 2,
            },
            sort_keys=True,
            separators=(",", ":"),
        ).encode("ascii")
        signature = hmac.digest(self._secret, payload, "sha256")
        payload_segment = base64.urlsafe_b64encode(payload).rstrip(b"=").decode("ascii")
        signature_segment = base64.urlsafe_b64encode(signature).rstrip(b"=").decode("ascii")
        token = f"{payload_segment}.{signature_segment}"
        if not _MIN_TOKEN_BYTES <= len(token.encode("ascii")) <= _MAX_TOKEN_BYTES:
            raise ValueError("cursor token must be 16..2048 ASCII bytes")
        return token

    def decode(self, token: str) -> CursorPosition:
        try:
            if not isinstance(token, str) or token.strip() != token:
                raise ValueError("token")
            token_bytes = token.encode("ascii")
            if not _MIN_TOKEN_BYTES <= len(token_bytes) <= _MAX_TOKEN_BYTES:
                raise ValueError("token length")
            parts = token.split(".")
            if len(parts) != 2 or not all(parts):
                raise ValueError("segments")
            payload = _decode_base64url_segment(parts[0])
            signature = _decode_base64url_segment(parts[1])
            if len(signature) != hashlib.sha256().digest_size:
                raise ValueError("signature length")
            expected = hmac.digest(self._secret, payload, "sha256")
            if not hmac.compare_digest(signature, expected):
                raise ValueError("signature")
            data = json.loads(payload.decode("ascii"))
            if not isinstance(data, dict) or set(data) != _CURSOR_FIELDS:
                raise ValueError("fields")
            if type(data["version"]) is not int or data["version"] != 2:
                raise ValueError("version")
            if type(data["sequence"]) is not int or data["sequence"] < 0:
                raise ValueError("sequence")
            if type(data["generation"]) is not int or data["generation"] < 0:
                raise ValueError("generation")
            if not isinstance(data["catalog_hash"], str) or _CATALOG_HASH.fullmatch(
                data["catalog_hash"]
            ) is None:
                raise ValueError("catalog")
            return CursorPosition(
                data["sequence"],
                data["catalog_hash"],
                _validate_identifier(data["space_id"], field="space_id"),
                _validate_identifier(data["client_id"], field="client_id"),
                data["generation"],
            )
        except (
            binascii.Error,
            KeyError,
            TypeError,
            UnicodeError,
            ValueError,
            json.JSONDecodeError,
        ) as exc:
            raise SyncCursorExpiredError(recovery_action="full_recovery") from exc


__all__ = ["CursorPosition", "SyncCursorCodec"]
