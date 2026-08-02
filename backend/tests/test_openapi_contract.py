"""PR-B: OpenAPI contract and error envelope tests.

Covers:
- B1: HTTPBearer security scheme in OpenAPI
- B2: RequestValidationError envelope consistency
- B4: OpenAPI contract gate (paths, operations, operationId uniqueness)

Uses conftest.py's async `client` fixture (httpx.AsyncClient).
"""

from __future__ import annotations

import json

import pytest

from app.main import app
from app.models.work_item import WorkItem

pytestmark = pytest.mark.provisioned_space_storage

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
    ("GET", "/api/ready"),
}
ERROR_RESPONSE_REF = "#/components/schemas/ErrorResponse"
CANONICAL_ERROR_RESPONSE_REF = "#/components/schemas/CanonicalErrorResponse"
CANONICAL_ERROR_MEDIA_TYPE = "application/vnd.pomodoroxii.error+json;version=2"
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
    setup = await client.post("/api/v1/auth/setup", json={"password": "test-password-123"})
    assert setup.status_code == 201
    login = await client.post("/api/v1/auth/login", json={"password": "test-password-123"})
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

        # /api/v1/habits (POST) requires space token
        create_habit = paths.get("/api/v1/habits", {}).get("post", {})
        create_security = create_habit.get("security", [])
        assert create_security == PROTECTED_SECURITY, (
            "POST /api/v1/habits must have exact HTTPBearer security: "
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
            content='{"password":"test-password-123"}',
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
        """OpenAPI must keep the 47 paths remaining after the TS0 cutover."""
        resp = await client.get("/openapi.json")
        schema = resp.json()
        paths = schema.get("paths", {})
        assert len(paths) >= 47, f"Got {len(paths)} paths, expected at least 47"

    async def test_operations_count_is_stable(self, client):
        """OpenAPI must keep the 73 operations remaining after the cutover."""
        resp = await client.get("/openapi.json")
        schema = resp.json()
        operations = list(_iter_operations(schema))
        assert len(operations) >= 73, (
            f"Got {len(operations)} operations, expected at least 73"
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
        """Exactly the intended public operations omit HTTPBearer."""
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
            assert set(content) == {
                "application/json",
                CANONICAL_ERROR_MEDIA_TYPE,
            }, (
                f"GET {path} must document both error media types: {content}"
            )
            assert set(_schema_refs(content["application/json"]["schema"])) == (
                STANDARD_ERROR_COMPONENTS
            )
            assert set(_schema_refs(content[CANONICAL_ERROR_MEDIA_TYPE]["schema"])) == {
                CANONICAL_ERROR_RESPONSE_REF
            }


# ─── Task 5: WorkItemNote v1 boundary absence gate ───────────────


def test_v1_openapi_and_orm_have_no_richer_note_or_promotion_surface() -> None:
    """WorkItemNote v1 must not expose richer blocks or promotion surfaces."""
    schema = app.openapi()
    serialized = json.dumps(schema, sort_keys=True)

    assert not any(
        path.endswith("/note/promote-list-item")
        for path in schema["paths"]
    )

    for forbidden in (
        '"heading"',
        '"ordered_list"',
        '"unordered_list"',
        '"work_item_ref"',
        '"PromoteListItem"',
    ):
        assert forbidden not in serialized

    assert {
        "source_note_id",
        "source_block_id",
        "source_item_id",
    }.isdisjoint(WorkItem.__table__.columns.keys())


# ─── Task 6: Task Space route presence and legacy absence gate ─────


class TestTaskSpaceOpenAPIGate:
    """Task Space routes must be present and legacy routes absent."""

    def test_openapi_contains_task_space_project_routes(self) -> None:
        schema = app.openapi()
        paths = schema["paths"]
        assert "/api/v1/projects" in paths
        assert "get" in paths["/api/v1/projects"]
        assert "post" in paths["/api/v1/projects"]
        assert "/api/v1/projects/definitions" in paths
        assert "/api/v1/projects/{project_id}" in paths

    def test_openapi_contains_task_space_work_item_routes(self) -> None:
        schema = app.openapi()
        paths = schema["paths"]
        assert "/api/v1/work-items" in paths
        assert "get" in paths["/api/v1/work-items"]
        assert "post" in paths["/api/v1/work-items"]
        assert "/api/v1/work-items/{work_item_id}" in paths

    def test_openapi_contains_task_space_note_routes(self) -> None:
        schema = app.openapi()
        paths = schema["paths"]
        note_paths = {
            path
            for path in paths
            if path.startswith("/api/v1/work-items/{work_item_id}/note")
        }
        assert (
            "/api/v1/work-items/{work_item_id}/note" in note_paths
        )
        assert (
            "/api/v1/work-items/{work_item_id}/note/append-blocks"
            in note_paths
        )
        assert (
            "/api/v1/work-items/{work_item_id}/note/toggle-checklist-item"
            in note_paths
        )

    def test_openapi_excludes_legacy_tasks_route(self) -> None:
        schema = app.openapi()
        assert "/api/v1/tasks" not in schema["paths"]

    def test_openapi_excludes_work_items_tree_route(self) -> None:
        schema = app.openapi()
        assert "/api/v1/work-items/tree" not in schema["paths"]
        assert not any(
            path.endswith("/work-items/tree")
            for path in schema["paths"]
        )

    def test_openapi_excludes_generic_note_command_routes(self) -> None:
        schema = app.openapi()
        for path in schema["paths"]:
            assert "/note/commands" not in path


# ─── TS1 Task 7: Typed response schemas and camelCase serialization ─


class TestTypedResponseSchemas:
    """TS1 Task 7: Task Space routes must expose typed, independent response schemas."""

    def test_project_response_is_independent_schema(self) -> None:
        """ProjectResponse must be a named component with camelCase fields."""
        schema = app.openapi()
        component = schema["components"]["schemas"]["ProjectResponse"]
        props = set(component["properties"])
        assert props == {"id", "key", "name", "nextWorkItemNumber"}
        assert "next_work_item_number" not in props

    def test_work_item_response_is_independent_schema(self) -> None:
        """WorkItemResponse must be a named component with camelCase fields."""
        schema = app.openapi()
        component = schema["components"]["schemas"]["WorkItemResponse"]
        props = set(component["properties"])
        assert props == {"id", "displayKey", "projectId", "title"}
        assert "display_key" not in props
        assert "project_id" not in props

    def test_work_item_note_response_is_independent_schema(self) -> None:
        """WorkItemNoteResponse must be a named component with camelCase fields."""
        schema = app.openapi()
        component = schema["components"]["schemas"]["WorkItemNoteResponse"]
        props = set(component["properties"])
        assert props == {
            "id", "workItemId", "documentJson", "contentVersion",
            "writeSupported", "version",
        }
        assert "work_item_id" not in props
        assert "content_version" not in props
        assert "write_supported" not in props

    def test_project_get_route_references_project_response(self) -> None:
        """GET /api/v1/projects/{project_id} must return ProjectResponse."""
        schema = app.openapi()
        response_schema = (
            schema["paths"]["/api/v1/projects/{project_id}"]["get"]
            ["responses"]["200"]["content"]["application/json"]["schema"]
        )
        assert response_schema == {"$ref": "#/components/schemas/ProjectResponse"}

    def test_work_item_get_route_references_work_item_response(self) -> None:
        """GET /api/v1/work-items/{work_item_id} must return WorkItemResponse."""
        schema = app.openapi()
        response_schema = (
            schema["paths"]["/api/v1/work-items/{work_item_id}"]["get"]
            ["responses"]["200"]["content"]["application/json"]["schema"]
        )
        assert response_schema == {"$ref": "#/components/schemas/WorkItemResponse"}

    def test_note_get_route_references_work_item_note_response(self) -> None:
        """GET /api/v1/work-items/{work_item_id}/note must return WorkItemNoteResponse."""
        schema = app.openapi()
        response_schema = (
            schema["paths"]["/api/v1/work-items/{work_item_id}/note"]["get"]
            ["responses"]["200"]["content"]["application/json"]["schema"]
        )
        assert response_schema == {"$ref": "#/components/schemas/WorkItemNoteResponse"}

    def test_project_page_response_uses_typed_items(self) -> None:
        """ProjectPageResponse.items must reference ProjectResponse, not generic dict."""
        schema = app.openapi()
        component = schema["components"]["schemas"]["ProjectPageResponse"]
        items = component["properties"]["items"]
        assert items["type"] == "array"
        assert items["items"] == {"$ref": "#/components/schemas/ProjectResponse"}

    def test_work_item_page_response_uses_typed_items(self) -> None:
        """WorkItemPageResponse.items must reference WorkItemResponse, not generic dict."""
        schema = app.openapi()
        component = schema["components"]["schemas"]["WorkItemPageResponse"]
        items = component["properties"]["items"]
        assert items["type"] == "array"
        assert items["items"] == {"$ref": "#/components/schemas/WorkItemResponse"}

    def test_paragraph_block_is_independent_schema(self) -> None:
        """ParagraphBlock must be a named component with camelCase blockId."""
        schema = app.openapi()
        component = schema["components"]["schemas"]["ParagraphBlock"]
        props = set(component["properties"])
        assert props == {"type", "blockId", "text"}
        assert "block_id" not in props

    def test_checklist_block_is_independent_schema(self) -> None:
        """ChecklistBlock must be a named component with camelCase blockId."""
        schema = app.openapi()
        component = schema["components"]["schemas"]["ChecklistBlock"]
        props = set(component["properties"])
        assert props == {"type", "blockId", "items"}
        assert "block_id" not in props

    def test_checklist_item_uses_camel_case_fields(self) -> None:
        """ChecklistItem must use camelCase itemId, not snake_case."""
        schema = app.openapi()
        component = schema["components"]["schemas"]["ChecklistItem"]
        props = set(component["properties"])
        assert "itemId" in props
        assert "item_id" not in props

    def test_note_document_uses_camel_case_content_version(self) -> None:
        """WorkItemNoteDocumentV1 must use camelCase contentVersion in properties."""
        schema = app.openapi()
        for name, component in schema["components"]["schemas"].items():
            props = component.get("properties", {})
            if "contentVersion" in props:
                assert "content_version" not in props, (
                    f"{name} must use camelCase contentVersion, not content_version"
                )

    def test_three_canonical_note_command_routes_exist(self) -> None:
        """The three canonical Note command routes must be present."""
        schema = app.openapi()
        paths = schema["paths"]
        assert "put" in paths["/api/v1/work-items/{work_item_id}/note"]
        assert "post" in paths[
            "/api/v1/work-items/{work_item_id}/note/append-blocks"
        ]
        assert "post" in paths[
            "/api/v1/work-items/{work_item_id}/note/toggle-checklist-item"
        ]


# ─── TS1 Task 7: Idempotency and session behavior non-regression ──


class TestIdempotencyNonRegression:
    """TS1 Task 7: idempotency_conflict and session behavior must not regress."""

    def test_idempotency_conflict_remains_registered(self) -> None:
        """idempotency_conflict must still be in MUTATION_REJECTION_SPECS."""
        from app.errors import MUTATION_REJECTION_SPECS

        assert "idempotency_conflict" in MUTATION_REJECTION_SPECS

    def test_space_scope_mismatch_remains_registered(self) -> None:
        """space_scope_mismatch must still be in MUTATION_REJECTION_SPECS."""
        from app.errors import MUTATION_REJECTION_SPECS

        assert "space_scope_mismatch" in MUTATION_REJECTION_SPECS

    def test_idempotency_conflict_not_in_compiler_producer_set(self) -> None:
        """idempotency_conflict must NOT appear in compiler.py's producer set."""
        from pathlib import Path

        from tests.ast_helpers import literal_exception_codes

        backend_root = Path(__file__).resolve().parents[1]
        compiler_path = backend_root / "app" / "task_space" / "compiler.py"
        raw_producer = literal_exception_codes(compiler_path, "MutationRuleViolation")
        assert "idempotency_conflict" not in raw_producer

    def test_space_scope_mismatch_in_compiler_producer_set(self) -> None:
        """space_scope_mismatch MUST appear in compiler.py's producer set."""
        from pathlib import Path

        from tests.ast_helpers import literal_exception_codes

        backend_root = Path(__file__).resolve().parents[1]
        compiler_path = backend_root / "app" / "task_space" / "compiler.py"
        raw_producer = literal_exception_codes(compiler_path, "MutationRuleViolation")
        assert "space_scope_mismatch" in raw_producer

    def test_idempotency_conflict_in_unit_of_work_producer_set(self) -> None:
        """idempotency_conflict must appear in unit_of_work.py's producer set."""
        from pathlib import Path

        from tests.ast_helpers import literal_exception_codes

        backend_root = Path(__file__).resolve().parents[1]
        uow_path = backend_root / "app" / "mutation" / "unit_of_work.py"
        raw_producer = literal_exception_codes(uow_path, "MutationRuleViolation")
        assert "idempotency_conflict" in raw_producer
