from __future__ import annotations

import pytest


@pytest.mark.parametrize("password", ["", "x" * 11, "x" * 65, "密" * 22])
def test_password_policy_rejects_outside_12_to_64_utf8_bytes(password: str) -> None:
    from app.auth.security import validate_password_policy

    with pytest.raises(ValueError, match="12 to 64 UTF-8 bytes"):
        validate_password_policy(password)


@pytest.mark.parametrize("password", ["x" * 12, "x" * 64, "密" * 4, "密" * 21])
def test_password_policy_accepts_boundaries(password: str) -> None:
    from app.auth.security import validate_password_policy

    assert validate_password_policy(password) == password.encode("utf-8")


def test_bcrypt_no_longer_creates_72_byte_aliases() -> None:
    from app.auth.security import hash_password

    with pytest.raises(ValueError, match="12 to 64 UTF-8 bytes"):
        hash_password("a" * 72 + "first")
    with pytest.raises(ValueError, match="12 to 64 UTF-8 bytes"):
        hash_password("a" * 72 + "second")
