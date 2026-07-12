"""PR-B: OpenAPI contract and error envelope tests.

Covers:
- B1: HTTPBearer security scheme in OpenAPI
- B2: RequestValidationError envelope consistency
- B4: OpenAPI contract gate (paths, operations, operationId uniqueness)

Uses conftest.py's async `client` fixture (httpx.AsyncClient).
"""

from __future__ import annotations

HTTP_METHODS = (
    "get",
    "put",
    "post",
    "delete",
    "options",
    "head",
    "patch",
    "trace",
)
PUBLIC_OPERATIONS = {
    ("POST", "/api/v1/auth/setup"),
    ("POST", "/api/v1/auth/login"),
    ("GET", "/api/health"),
}
ERROR_RESPONSE_REF = "#/components/schemas/ErrorResponse"
REQUEST_VALIDATION_ERROR_RESPONSE_REF = (
    "#/components/schemas/RequestValidationErrorResponse"
)
STANDARD_ERROR_COMPONENTS = {
    ERROR_RESPONSE_REF,
    REQUEST_VALIDATION_ERROR_RESPONSE_REF,
}
PROTECTED_SECURITY = [{"HTTPBearer": []}]


def _iter_operations(schema):
    for path, path_item in schema.get("paths", {}).items():
        for method in HTTP_METHODS:
            if method in path_item:
                yield method.upper(), path, path_item[method]


def _schema_refs(value):
    if isinstance(value, dict):
        if "$ref" in value:
            yield value["$ref"]
        for child in value.values():
            yield from _schema_refs(child)
    elif isinstance(value, list):
        for child in value:
            yield from _schema_refs(child)


def _is_error_status(status) -> bool:
    if isinstance(status, int):
        return 400 <= status < 600
    normalized = str(status).upper()
    if normalized in {"4XX", "5XX"}:
        return True
    return normalized.isdigit() and 400 <= int(normalized) < 600


async def _space_auth_headers(client) -> dict[str, str]:
    setup = await client.post("/api/v1/auth/setup", json={"password": "test123"})
    assert setup.status_code == 201
    login = await client.post("/api/v1/auth/login", json={"password": "test123"})
    assert login.status_code == 200
    master_headers = {
        "Authorization": f"Bearer {login.json()['access_token']}"
    }
    created = await client.post(
        "/api/v1/spaces",
        json={"name": "Contract Test Space"},
        headers=master_headers,
    )
    assert created.status_code == 201
    token = await client.post(
        f"/api/v1/spaces/{created.json()['id']}/token",
        headers=master_headers,
    )
    assert token.status_code == 200
    return {"Authorization": f"Bearer {token.json()['space_token']}"}


# ─── B1: HTTPBearer security scheme ───────────────────────────────


class TestBearerSecurityScheme:
    """B1: OpenAPI must declare HTTPBearer and apply it to protected routes."""

    async def test_openapi_contains_bearer_security_scheme(self, client):
        """securitySchemes must include HTTPBearer with type=http, scheme=bearer."""
        resp = await client.get("/openapi.json")
        assert resp.status_code == 200
        schema = resp.json()
        schemes = schema.get("components", {}).get("securitySchemes", {})
        assert "HTTPBearer" in schemes, (
            f"HTTPBearer not in securitySchemes: {list(schemes.keys())}"
        )
        bearer = schemes["HTTPBearer"]
        assert bearer.get("type") == "http"
        assert bearer.get("scheme") == "bearer"

    async def test_public_routes_have_no_security_requirement(self, client):
        """Health check and auth setup/login must not require security."""
        resp = await client.get("/openapi.json")
        schema = resp.json()
        paths = schema.get("paths", {})

        # /api/health is public
        health = paths.get("/api/health", {}).get("get", {})
        assert "security" not in health or health["security"] == [], (
            "Public /api/health must not have security requirement"
        )

        # /api/v1/auth/setup is public
        setup = paths.get("/api/v1/auth/setup", {}).get("post", {})
        assert "security" not in setup or setup["security"] == [], (
            "Public /api/v1/auth/setup must not have security requirement"
        )

        # /api/v1/auth/login is public
        login = paths.get("/api/v1/auth/login", {}).get("post", {})
        assert "security" not in login or login["security"] == [], (
            "Public /api/v1/auth/login must not have security requirement"
        )

    async def test_protected_routes_have_bearer_requirement(self, client):
        """Verify, spaces, and space-scoped endpoints must declare HTTPBearer."""
        resp = await client.get("/openapi.json")
        schema = resp.json()
        paths = schema.get("paths", {})

        # /api/v1/auth/verify requires auth
        verify = paths.get("/api/v1/auth/verify", {}).get("get", {})
        verify_security = verify.get("security", [])
        assert verify_security == PROTECTED_SECURITY, (
            "/api/v1/auth/verify must have exact HTTPBearer security: "
            f"{verify_security}"
        )

        # /api/v1/spaces (POST create) requires master token
        create_space = paths.get("/api/v1/spaces", {}).get("post", {})
        create_security = create_space.get("security", [])
        assert create_security == PROTECTED_SECURITY, (
            "POST /api/v1/spaces must have exact HTTPBearer security: "
            f"{create_security}"
        )

        # /api/v1/tasks (POST) requires space token
        create_task = paths.get("/api/v1/tasks", {}).get("post", {})
        create_security = create_task.get("security", [])
        assert create_security == PROTECTED_SECURITY, (
            "POST /api/v1/tasks must have exact HTTPBearer security: "
            f"{create_security}"
        )


# ─── B2: RequestValidationError envelope ──────────────────────────


class TestValidationEnvelope:
    """B2: FastAPI RequestValidationError must use the same envelope as AppError."""

    async def test_invalid_json_returns_422_with_error_type(self, client):
        """Malformed JSON body must return 422 with error_type=request_validation_error."""
        resp = await client.post(
            "/api/v1/auth/setup",
            content="not json",
            headers={"Content-Type": "application/json"},
        )
        assert resp.status_code == 422
        body = resp.json()
        assert "detail" in body
        assert body.get("error_type") == "request_validation_error"
        assert isinstance(body.get("errors"), list)
        assert len(body["errors"]) > 0
        assert set(body) == {"detail", "error_type", "errors"}
        assert body["detail"] == "Request validation failed"
        assert all(set(error) == {"loc", "msg", "type"} for error in body["errors"])

    async def test_missing_required_field_returns_422_with_error_type(self, client):
        """Missing required field must return 422 with error_type=request_validation_error."""
        resp = await client.post("/api/v1/auth/setup", json={})
        assert resp.status_code == 422, f"Expected 422, got {resp.status_code}: {resp.text}"
        body = resp.json()
        assert body.get("error_type") == "request_validation_error", (
            f"Expected request_validation_error, got: {body}"
        )
        assert isinstance(body.get("errors"), list)
        assert len(body["errors"]) > 0
        err = body["errors"][0]
        assert "loc" in err
        assert "msg" in err
        assert "type" in err
        assert err["loc"] == ["body", "password"]

    async def test_invalid_query_parameter_includes_query_location(self, client):
        """Out-of-range query values identify the query parameter in errors[].loc."""
        headers = await _space_auth_headers(client)
        resp = await client.get("/api/v1/notes?page=0", headers=headers)

        assert resp.status_code == 422
        body = resp.json()
        assert body["detail"] == "Request validation failed"
        assert body["error_type"] == "request_validation_error"
        assert any(error["loc"] == ["query", "page"] for error in body["errors"])

    async def test_domain_validation_error_keeps_standard_error_response(self, client):
        """Domain ValidationError remains the two-field standard error envelope."""
        headers = await _space_auth_headers(client)
        resp = await client.put(
            "/api/v1/notes/missing/content",
            json={},
            headers=headers,
        )

        assert resp.status_code == 422
        assert resp.json() == {
            "detail": "JSON body must be an object with a 'content' field",
            "error_type": "validation_error",
        }

    async def test_wrong_content_type_uses_json_request_validation_envelope(self, client):
        """FastAPI records a wrong request Content-Type as a 422 JSON validation error."""
        resp = await client.post(
            "/api/v1/auth/setup",
            content='{"password":"test123"}',
            headers={"Content-Type": "text/plain"},
        )

        assert resp.status_code == 422
        assert resp.headers["content-type"].startswith("application/json")
        body = resp.json()
        assert body["detail"] == "Request validation failed"
        assert body["error_type"] == "request_validation_error"
        assert body["errors"]
        assert body["errors"][0]["loc"] == ["body"]


# ─── B4: OpenAPI contract gate ────────────────────────────────────


class TestOpenAPIContractGate:
    """B4: Structural OpenAPI assertions to prevent contract regressions."""

    async def test_paths_count_is_stable(self, client):
        """OpenAPI must keep at least the existing 51 paths."""
        resp = await client.get("/openapi.json")
        schema = resp.json()
        paths = schema.get("paths", {})
        assert len(paths) >= 51, f"Got {len(paths)} paths, expected at least 51"

    async def test_operations_count_is_stable(self, client):
        """OpenAPI must keep at least the existing 83 operations."""
        resp = await client.get("/openapi.json")
        schema = resp.json()
        operations = list(_iter_operations(schema))
        assert len(operations) >= 83, (
            f"Got {len(operations)} operations, expected at least 83"
        )

    def test_error_status_detection_covers_numeric_and_range_keys(self):
        """Error response detection covers numeric statuses and OpenAPI ranges."""
        assert all(
            _is_error_status(status)
            for status in (400, 422, 599, "400", "422", "599", "4XX", "5XX")
        )
        assert not any(
            _is_error_status(status)
            for status in (399, 600, "399", "600", "default")
        )

    async def test_operation_ids_are_unique(self, client):
        """No two operations may share the same operationId."""
        resp = await client.get("/openapi.json")
        schema = resp.json()
        paths = schema.get("paths", {})
        seen: dict[str, str] = {}
        duplicates: list[str] = []
        for path, path_item in paths.items():
            for method in HTTP_METHODS:
                if method in path_item:
                    op = path_item[method]
                    op_id = op.get("operationId")
                    if op_id:
                        if op_id in seen:
                            duplicates.append(
                                f"{op_id} ({seen[op_id]} vs {method.upper()} {path})"
                            )
                        else:
                            seen[op_id] = f"{method.upper()} {path}"
        assert not duplicates, f"Duplicate operationIds: {duplicates}"

    async def test_security_schemes_exist(self, client):
        """securitySchemes must be non-empty."""
        resp = await client.get("/openapi.json")
        schema = resp.json()
        schemes = schema.get("components", {}).get("securitySchemes", {})
        assert len(schemes) > 0, "No securitySchemes defined"

    async def test_only_setup_login_and_health_are_security_free(self, client):
        """Exactly the three intended public operations omit HTTPBearer."""
        schema = (await client.get("/openapi.json")).json()
        security_free = {
            (method, path)
            for method, path, operation in _iter_operations(schema)
            if not operation.get("security")
        }
        assert security_free == PUBLIC_OPERATIONS

    async def test_every_other_operation_requires_http_bearer(self, client):
        """Every protected operation has only the exact HTTPBearer requirement."""
        schema = (await client.get("/openapi.json")).json()
        misconfigured = []
        for method, path, operation in _iter_operations(schema):
            if (method, path) in PUBLIC_OPERATIONS:
                continue
            security = operation.get("security")
            if security != PROTECTED_SECURITY:
                misconfigured.append(f"{method} {path}: {security!r}")
        assert not misconfigured, (
            "Protected operations must declare exactly "
            f"{PROTECTED_SECURITY!r}: {misconfigured}"
        )

    async def test_error_responses_reference_only_standard_components(self, client):
        """Documented JSON errors use ErrorResponse or request-validation errors."""
        schema = (await client.get("/openapi.json")).json()
        checked = 0
        for method, path, operation in _iter_operations(schema):
            for status, response in operation.get("responses", {}).items():
                if not _is_error_status(status):
                    continue
                label = f"{method} {path} {status}"
                content = response.get("content")
                assert isinstance(content, dict), (
                    f"{label} must document an application/json schema"
                )
                json_response = content.get("application/json")
                assert isinstance(json_response, dict), (
                    f"{label} must document an application/json schema"
                )
                json_schema = json_response.get("schema")
                assert json_schema is not None, (
                    f"{label} must document an application/json schema"
                )
                refs = set(_schema_refs(json_schema))
                expected_refs = (
                    STANDARD_ERROR_COMPONENTS
                    if str(status) == "422"
                    else {ERROR_RESPONSE_REF}
                )
                assert refs == expected_refs, (
                    f"{label} must reference exactly {expected_refs}: {refs}"
                )
                checked += 1
        assert checked > 0, "Expected documented JSON error responses"

    async def test_fastapi_http_validation_component_is_absent(self, client):
        """The custom request-validation contract replaces HTTPValidationError."""
        schema = (await client.get("/openapi.json")).json()
        components = schema.get("components", {}).get("schemas", {})
        assert "HTTPValidationError" not in components

    async def test_plain_text_note_routes_document_json_422(self, client):
        """Plain-text success responses must not change the 422 media type."""
        schema = (await client.get("/openapi.json")).json()
        for path in (
            "/api/v1/notes/{id}/content",
            "/api/v1/notes/{id}/versions/{version_id}",
        ):
            content = schema["paths"][path]["get"]["responses"]["422"]["content"]
            assert set(content) == {"application/json"}, (
                f"GET {path} must document 422 as application/json: {content}"
            )
            assert set(_schema_refs(content["application/json"]["schema"])) == (
                STANDARD_ERROR_COMPONENTS
            )
