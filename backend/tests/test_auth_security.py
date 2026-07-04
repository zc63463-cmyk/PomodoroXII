"""Direct tests for app.auth.security — password hashing and JWT utilities."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import jwt
import pytest

from app.auth.security import (
    create_master_token,
    create_space_token,
    decode_access_token,
    hash_password,
    verify_password,
)
from app.settings import settings


# --------------------------------------------------------------------------- #
# Password hashing
# --------------------------------------------------------------------------- #
class TestHashPassword:
    def test_returns_bcrypt_hash(self):
        """hash_password should return a valid bcrypt hash string."""
        result = hash_password("mySecret123")
        assert result.startswith("$2b$12$")
        assert len(result) == 60

    def test_truncates_at_72_bytes(self):
        """bcrypt has a 72-byte limit; long passwords must not raise."""
        long_password = "x" * 200
        result = hash_password(long_password)
        assert result.startswith("$2b$")

    def test_different_calls_produce_different_hashes(self):
        """Same password should produce different hashes (random salt)."""
        h1 = hash_password("samePassword")
        h2 = hash_password("samePassword")
        assert h1 != h2


class TestVerifyPassword:
    def test_succeeds_with_correct_password(self):
        """verify_password should return True for the correct password."""
        hashed = hash_password("correctPassword")
        assert verify_password("correctPassword", hashed) is True

    def test_fails_with_wrong_password(self):
        """verify_password should return False for a wrong password."""
        hashed = hash_password("correctPassword")
        assert verify_password("wrongPassword", hashed) is False

    def test_fails_with_empty_password(self):
        """verify_password should return False for empty input."""
        hashed = hash_password("realPassword")
        assert verify_password("", hashed) is False


# --------------------------------------------------------------------------- #
# Token creation
# --------------------------------------------------------------------------- #
class TestCreateMasterToken:
    def test_contains_master_type(self):
        """Master token payload should have type == 'master' and no space_id."""
        token = create_master_token("user_1")
        payload = decode_access_token(token)
        assert payload["type"] == "master"
        assert payload["sub"] == "user_1"
        assert "space_id" not in payload

    def test_has_7d_expiry(self):
        """Master token exp should be ~7 days from now."""
        token = create_master_token("user_1")
        payload = decode_access_token(token)
        now = datetime.now(timezone.utc)
        exp = datetime.fromtimestamp(payload["exp"], tz=timezone.utc)
        delta = exp - now
        # Allow a 5-second tolerance for test execution time.
        assert timedelta(days=7) - timedelta(seconds=5) <= delta <= timedelta(days=7) + timedelta(seconds=5)


class TestCreateSpaceToken:
    def test_contains_space_id(self):
        """Space token payload should have type == 'space' and space_id."""
        token = create_space_token("spc_123", "user_1")
        payload = decode_access_token(token)
        assert payload["type"] == "space"
        assert payload["sub"] == "user_1"
        assert payload["space_id"] == "spc_123"

    def test_has_8h_expiry(self):
        """Space token exp should be ~8 hours from now."""
        token = create_space_token("spc_1", "user_1")
        payload = decode_access_token(token)
        now = datetime.now(timezone.utc)
        exp = datetime.fromtimestamp(payload["exp"], tz=timezone.utc)
        delta = exp - now
        assert timedelta(hours=8) - timedelta(seconds=5) <= delta <= timedelta(hours=8) + timedelta(seconds=5)


# --------------------------------------------------------------------------- #
# Token decoding
# --------------------------------------------------------------------------- #
class TestDecodeAccessToken:
    def test_decodes_valid_token(self):
        """A valid token should decode to its payload dict."""
        token = create_master_token("user_decode")
        payload = decode_access_token(token)
        assert payload["sub"] == "user_decode"
        assert payload["type"] == "master"

    def test_raises_on_invalid_token(self):
        """A garbage string should raise jwt.PyJWTError."""
        with pytest.raises(jwt.PyJWTError):
            decode_access_token("not.a.valid.token")

    def test_raises_on_expired_token(self):
        """An expired token should raise jwt.PyJWTError."""
        payload = {
            "sub": "user_expired",
            "type": "master",
            "exp": datetime.now(timezone.utc) - timedelta(hours=1),
        }
        expired_token = jwt.encode(payload, settings.secret_key, algorithm=settings.algorithm)
        with pytest.raises(jwt.PyJWTError):
            decode_access_token(expired_token)

    def test_raises_on_wrong_secret(self):
        """A token signed with a different secret should raise."""
        payload = {
            "sub": "user_wrong",
            "type": "master",
            "exp": datetime.now(timezone.utc) + timedelta(hours=1),
        }
        wrong_token = jwt.encode(payload, "a-completely-different-secret", algorithm=settings.algorithm)
        with pytest.raises(jwt.PyJWTError):
            decode_access_token(wrong_token)
