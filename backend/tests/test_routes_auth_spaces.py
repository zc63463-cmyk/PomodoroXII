"""Integration tests for v1 auth + spaces routes (Phase B Step 8).

Covers:
  - Auth: setup, login, verify (6 tests)
  - Spaces: create, list, get, issue token (7 tests)
"""
from __future__ import annotations

from types import SimpleNamespace

import jwt
import pytest
from sqlalchemy import select


class _ProvisionHandle:
    async def __aenter__(self):
        return self

    async def __aexit__(self, *_exc_info):
        return False


class _FakeLease:
    fence = 1

    async def release(self) -> None:
        return None


class _FakeLeases:
    async def acquire_global(self, *_args):
        return _FakeLease()

    def register_pending_lease_cleanup(self, _lease) -> None:
        return None


class _Task8RouteRuntime:
    def __init__(self) -> None:
        self.leases = _FakeLeases()
        self.provisioned = []

    async def provision(self, spec):
        from app.db.meta_session import get_meta_session
        from app.db.models.meta import Space
        from app.settings import settings

        root = settings.spaces_data_dir / spec.space_id
        root.mkdir(parents=True, exist_ok=True)
        space = Space(
            id=spec.space_id,
            name=spec.name,
            db_path=str(root / "space.db"),
            notes_dir=str(root / "notes"),
        )
        async for session in get_meta_session():
            session.add(space)
            await session.commit()
            break
        self.provisioned.append(spec)
        return _ProvisionHandle()

    async def open_resolved(
        self, scope, _mode, _global_lease, *, owns_global_lease: bool
    ):
        assert owns_global_lease is True
        return SimpleNamespace(scope=scope)

    async def get_registered(self, space_id: str):
        from app.db.meta_session import get_meta_session
        from app.db.models.meta import Space

        async for session in get_meta_session():
            return await session.scalar(select(Space).where(Space.id == space_id))
        return None


@pytest.fixture(autouse=True)
def _install_task8_runtime(request):
    if "client" not in request.fixturenames:
        return
    client = request.getfixturevalue("client")
    client._transport.app.state.runtime = _Task8RouteRuntime()


def test_create_space_delegates_provisioning_to_runtime() -> None:
    import inspect

    from app.routes.v1 import spaces

    source = inspect.getsource(spaces.create_space)
    assert "mkdir" not in source
    assert "settings.space_db_path" not in source
    assert "runtime.provision" in source


async def _setup_and_login(client) -> str:
    """Setup admin password and login, returning the master token."""
    resp = await client.post("/api/v1/auth/setup", json={"password": "test-password-123"})
    assert resp.status_code in (200, 201)
    resp = await client.post("/api/v1/auth/login", json={"password": "test-password-123"})
    assert resp.status_code == 200
    return resp.json()["access_token"]


# --------------------------------------------------------------------------- #
# Auth routes (6 tests)
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_setup_sets_admin_password(client):
    """POST /setup stores a hashed admin password in the meta DB."""
    resp = await client.post("/api/v1/auth/setup", json={"password": "test-password-123"})
    assert resp.status_code in (200, 201)
    assert resp.json() == {"message": "Password set"}

    # Verify the password was persisted (hashed) in the meta DB.
    from app.db.meta_session import get_meta_session
    from app.db.models.meta import MetaSetting

    async for session in get_meta_session():
        result = await session.execute(
            select(MetaSetting).where(MetaSetting.key == "admin_password")
        )
        setting = result.scalar_one_or_none()
        assert setting is not None
        assert setting.value is not None
        # The stored value must be a bcrypt hash, not the plain password.
        assert setting.value != "test-password-123"
        break


@pytest.mark.asyncio
async def test_setup_rejects_duplicate_password_409(client):
    """Setting up a second time returns 409 Conflict."""
    resp = await client.post("/api/v1/auth/setup", json={"password": "test-password-123"})
    assert resp.status_code in (200, 201)

    resp = await client.post("/api/v1/auth/setup", json={"password": "another-password"})
    assert resp.status_code == 409


@pytest.mark.asyncio
async def test_login_returns_master_token(client):
    """POST /login returns a master JWT whose type == 'master'."""
    resp = await client.post("/api/v1/auth/setup", json={"password": "test-password-123"})
    assert resp.status_code in (200, 201)

    resp = await client.post("/api/v1/auth/login", json={"password": "test-password-123"})
    assert resp.status_code == 200
    data = resp.json()
    assert "access_token" in data
    assert data["token_type"] == "bearer"

    from app.settings import settings
    payload = jwt.decode(
        data["access_token"], settings.secret_key, algorithms=[settings.algorithm]
    )
    assert payload["type"] == "master"
    assert payload["sub"] == "admin"


@pytest.mark.asyncio
async def test_login_wrong_password_401(client):
    """Login with the wrong password returns 401."""
    resp = await client.post("/api/v1/auth/setup", json={"password": "test-password-123"})
    assert resp.status_code in (200, 201)

    resp = await client.post("/api/v1/auth/login", json={"password": "wrong-password"})
    assert resp.status_code == 401


@pytest.mark.asyncio
async def test_verify_master_token_returns_valid(client):
    """GET /verify with a master token returns valid=true, type=master."""
    token = await _setup_and_login(client)
    resp = await client.get(
        "/api/v1/auth/verify", headers={"Authorization": f"Bearer {token}"}
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["valid"] is True
    assert data["type"] == "master"


@pytest.mark.parametrize(
    "authorization_template",
    [
        pytest.param("Bearer  {token}", id="extra-separator-whitespace"),
        pytest.param("Bearer {token}   ", id="trailing-token-whitespace"),
    ],
)
async def test_verify_accepts_bearer_token_surrounding_whitespace(
    client,
    authorization_template: str,
):
    """Bearer credentials retain the raw-header parser's whitespace tolerance."""
    token = await _setup_and_login(client)

    resp = await client.get(
        "/api/v1/auth/verify",
        headers={
            "Authorization": authorization_template.format(token=token),
        },
    )

    assert resp.status_code == 200
    assert resp.json() == {
        "valid": True,
        "user_id": "admin",
        "type": "master",
    }


@pytest.mark.parametrize(
    "authorization",
    [
        pytest.param("Bearer ", id="empty-credential"),
        pytest.param("Bearer    ", id="whitespace-only-credential"),
    ],
)
async def test_verify_empty_bearer_credential_keeps_invalid_token_error(
    client,
    authorization: str,
):
    """Empty Bearer credentials keep the legacy invalid-token response."""
    resp = await client.get(
        "/api/v1/auth/verify",
        headers={"Authorization": authorization},
    )

    assert resp.status_code == 401
    assert resp.json() == {
        "detail": "Invalid or expired token",
        "error_type": "authentication_error",
    }


@pytest.mark.parametrize(
    ("authorization", "expected_detail"),
    [
        pytest.param(
            "Basic credentials",
            "Missing or invalid Authorization header",
            id="wrong-scheme",
        ),
        pytest.param(
            "Bearer",
            "Missing or invalid Authorization header",
            id="malformed-bearer",
        ),
        pytest.param(
            "Bearer not-a-jwt",
            "Invalid or expired token",
            id="invalid-token",
        ),
    ],
)
async def test_verify_invalid_authorization_keeps_legacy_error_messages(
    client,
    authorization: str,
    expected_detail: str,
):
    """Wrong schemes, malformed Bearer, and invalid JWTs keep their messages."""
    resp = await client.get(
        "/api/v1/auth/verify",
        headers={"Authorization": authorization},
    )

    assert resp.status_code == 401
    assert resp.json() == {
        "detail": expected_detail,
        "error_type": "authentication_error",
    }


@pytest.mark.asyncio
async def test_verify_missing_token_401(client):
    """GET /verify without a token returns 401."""
    resp = await client.get("/api/v1/auth/verify")
    assert resp.status_code == 401
    assert resp.json() == {
        "detail": "Missing or invalid Authorization header",
        "error_type": "authentication_error",
    }


# --------------------------------------------------------------------------- #
# Space routes (7 tests)
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_create_space_returns_id_and_persists(client):
    """POST /spaces creates a space and returns its id + name."""
    token = await _setup_and_login(client)
    resp = await client.post(
        "/api/v1/spaces",
        json={"name": "My Space"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert resp.status_code == 201
    data = resp.json()
    assert "id" in data
    assert data["name"] == "My Space"
    assert data["db_path"]
    assert data["notes_dir"]


@pytest.mark.asyncio
async def test_create_space_requires_master_token_403(client):
    """Creating a space without a master token is forbidden."""
    # No token at all -> 401 (authentication required)
    resp = await client.post("/api/v1/spaces", json={"name": "No Auth"})
    assert resp.status_code == 401

    # Space token (not master) -> 403 (authorization required)
    master_token = await _setup_and_login(client)
    headers = {"Authorization": f"Bearer {master_token}"}

    resp = await client.post("/api/v1/spaces", json={"name": "Space A"}, headers=headers)
    assert resp.status_code == 201
    space_id = resp.json()["id"]

    resp = await client.post(f"/api/v1/spaces/{space_id}/token", headers=headers)
    assert resp.status_code == 200
    space_token = resp.json()["space_token"]

    resp = await client.post(
        "/api/v1/spaces",
        json={"name": "Space B"},
        headers={"Authorization": f"Bearer {space_token}"},
    )
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_list_spaces_returns_all(client):
    """GET /spaces returns all created spaces."""
    token = await _setup_and_login(client)
    headers = {"Authorization": f"Bearer {token}"}

    resp = await client.post("/api/v1/spaces", json={"name": "Space 1"}, headers=headers)
    assert resp.status_code == 201
    resp = await client.post("/api/v1/spaces", json={"name": "Space 2"}, headers=headers)
    assert resp.status_code == 201

    resp = await client.get("/api/v1/spaces", headers=headers)
    assert resp.status_code == 200
    assert len(resp.json()) == 2


@pytest.mark.asyncio
async def test_get_space_by_id(client):
    """GET /spaces/{id} returns the space with matching name."""
    token = await _setup_and_login(client)
    headers = {"Authorization": f"Bearer {token}"}

    resp = await client.post("/api/v1/spaces", json={"name": "Find Me"}, headers=headers)
    assert resp.status_code == 201
    space_id = resp.json()["id"]

    resp = await client.get(f"/api/v1/spaces/{space_id}", headers=headers)
    assert resp.status_code == 200
    assert resp.json()["name"] == "Find Me"


@pytest.mark.asyncio
async def test_issue_space_token_requires_master_token(client):
    """Issuing a space token without a master token is forbidden."""
    master_token = await _setup_and_login(client)
    headers = {"Authorization": f"Bearer {master_token}"}

    resp = await client.post("/api/v1/spaces", json={"name": "Token Space"}, headers=headers)
    assert resp.status_code == 201
    space_id = resp.json()["id"]

    # No token -> 401
    resp = await client.post(f"/api/v1/spaces/{space_id}/token")
    assert resp.status_code == 401

    # Space token -> 403
    resp = await client.post(f"/api/v1/spaces/{space_id}/token", headers=headers)
    assert resp.status_code == 200
    space_token = resp.json()["space_token"]

    resp = await client.post(
        f"/api/v1/spaces/{space_id}/token",
        headers={"Authorization": f"Bearer {space_token}"},
    )
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_issue_space_token_returns_space_scoped_token(client):
    """POST /spaces/{id}/token returns a JWT with type=space and matching space_id."""
    master_token = await _setup_and_login(client)
    headers = {"Authorization": f"Bearer {master_token}"}

    resp = await client.post("/api/v1/spaces", json={"name": "Scoped Space"}, headers=headers)
    assert resp.status_code == 201
    space_id = resp.json()["id"]

    resp = await client.post(f"/api/v1/spaces/{space_id}/token", headers=headers)
    assert resp.status_code == 200
    data = resp.json()
    assert "space_token" in data
    assert data["token_type"] == "bearer"

    from app.settings import settings
    payload = jwt.decode(
        data["space_token"], settings.secret_key, algorithms=[settings.algorithm]
    )
    assert payload["type"] == "space"
    assert payload["space_id"] == space_id


@pytest.mark.asyncio
async def test_space_token_decoded_by_get_space_context(client):
    """A space token issued by the API is accepted by get_space_context."""
    master_token = await _setup_and_login(client)
    headers = {"Authorization": f"Bearer {master_token}"}

    resp = await client.post("/api/v1/spaces", json={"name": "Ctx Space"}, headers=headers)
    assert resp.status_code == 201
    space_id = resp.json()["id"]

    resp = await client.post(f"/api/v1/spaces/{space_id}/token", headers=headers)
    assert resp.status_code == 200
    space_token = resp.json()["space_token"]

    from fastapi.security import HTTPAuthorizationCredentials

    from app.deps import get_current_user, get_space_context

    payload = await get_current_user(
        credentials=HTTPAuthorizationCredentials(scheme="Bearer", credentials=space_token)
    )
    ctx = await get_space_context(
        request=SimpleNamespace(app=SimpleNamespace(state=client._transport.app.state)),
        user=payload,
    )
    assert ctx["space_id"] == space_id
    assert ctx["user_id"] is not None
