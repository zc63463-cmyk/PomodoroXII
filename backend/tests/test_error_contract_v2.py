from __future__ import annotations

import ast
from dataclasses import FrozenInstanceError, fields
from pathlib import Path

import httpx
import pytest
from fastapi import FastAPI
from httpx import ASGITransport

CANONICAL_ACCEPT = "application/vnd.pomodoroxii.error+json;version=2"


def test_domain_error_record_is_frozen() -> None:
    from app.errors import DomainErrorRecord

    record = DomainErrorRecord(
        code="auth_required",
        message="Authentication required",
        retryable=False,
        request_id="req-fixed",
        details={},
    )
    with pytest.raises(FrozenInstanceError):
        record.code = "changed"  # type: ignore[misc]
    assert [field.name for field in fields(record)] == [
        "code",
        "message",
        "retryable",
        "request_id",
        "details",
    ]


def test_domain_error_record_deep_freezes_and_thaws_nested_json() -> None:
    from app.errors import DomainErrorRecord, to_wire_json

    source = {"recovery": {"actions": ["retry"], "attempt": 1}}
    record = DomainErrorRecord(
        code="lease_timeout",
        message="Lease timed out",
        retryable=True,
        request_id="req-nested",
        details=source,
    )
    source["recovery"]["actions"].append("mutated")
    with pytest.raises(TypeError):
        record.details["new"] = True  # type: ignore[index]
    assert record.details["recovery"]["actions"] == ("retry",)

    wire = record.to_wire_json()
    assert wire == to_wire_json(record)
    assert wire["details"] == {"recovery": {"actions": ["retry"], "attempt": 1}}
    wire["details"]["recovery"]["actions"].append("wire-only")
    assert record.details["recovery"]["actions"] == ("retry",)


@pytest.mark.parametrize("invalid", [{1: "value"}, float("nan"), b"secret", Path("x")])
def test_domain_error_record_rejects_non_json_details(invalid: object) -> None:
    from app.errors import DomainErrorRecord

    with pytest.raises(TypeError):
        DomainErrorRecord(
            code="invalid",
            message="Invalid",
            retryable=False,
            request_id="req-invalid",
            details={"value": invalid},
        )


def test_errors_module_is_the_only_recursive_wire_serializer_owner() -> None:
    app_root = Path(__file__).resolve().parents[1] / "app"
    owners = []
    for source_path in app_root.rglob("*.py"):
        tree = ast.parse(source_path.read_text(encoding="utf-8"))
        if any(
            isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
            and node.name == "to_wire_json"
            for node in ast.walk(tree)
        ):
            owners.append(source_path.relative_to(app_root).as_posix())
    assert owners == ["errors.py"]
    error_source = (app_root / "errors.py").read_text(encoding="utf-8")
    assert "asdict(" not in error_source
    assert "dict(self.details)" not in error_source


@pytest.mark.asyncio
async def test_rest_v1_auth_body_remains_exact_and_adds_canonical_headers(client) -> None:
    response = await client.get(
        "/api/v1/auth/verify",
        headers={"X-Request-ID": "req-v1"},
    )
    assert response.status_code == 401
    assert response.json() == {
        "detail": "Missing or invalid Authorization header",
        "error_type": "authentication_error",
    }
    assert response.headers["X-PomodoroXII-Error-Code"] == "auth_required"
    assert response.headers["X-PomodoroXII-Retryable"] == "false"
    assert response.headers["X-Request-ID"] == "req-v1"


@pytest.mark.asyncio
async def test_rest_v2_auth_body_is_exact_canonical_record(client) -> None:
    response = await client.get(
        "/api/v1/auth/verify",
        headers={"Accept": CANONICAL_ACCEPT, "X-Request-ID": "req-v2"},
    )
    assert response.status_code == 401
    assert response.headers["content-type"].startswith(CANONICAL_ACCEPT)
    assert response.json() == {
        "code": "auth_required",
        "message": "Missing or invalid Authorization header",
        "retryable": False,
        "request_id": "req-v2",
        "details": {},
    }


@pytest.mark.asyncio
async def test_rest_v2_platform_unsupported_maps_to_501_and_non_retryable() -> None:
    from app import errors
    from app.errors import register_exception_handlers
    from app.middleware import RequestIdMiddleware

    app = FastAPI()
    app.add_middleware(RequestIdMiddleware)
    register_exception_handlers(app)

    @app.get("/native")
    async def native() -> None:
        raise errors.PlatformUnsupportedError()

    transport = ASGITransport(app=app, raise_app_exceptions=False)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as local:
        response = await local.get(
            "/native",
            headers={"Accept": CANONICAL_ACCEPT, "X-Request-ID": "req-platform"},
        )

    assert response.status_code == 501
    assert response.json() == {
        "code": "platform_unsupported",
        "message": "Native contained storage is supported only on Windows",
        "retryable": False,
        "request_id": "req-platform",
        "details": {},
    }
    assert response.headers["X-PomodoroXII-Error-Code"] == "platform_unsupported"
    assert response.headers["X-PomodoroXII-Retryable"] == "false"


@pytest.mark.asyncio
async def test_v1_validation_keys_stay_top_level_and_v2_puts_issues_in_details(
    client,
) -> None:
    legacy = await client.post("/api/v1/auth/setup", json={})
    assert set(legacy.json()) == {"detail", "error_type", "errors"}
    canonical = await client.post(
        "/api/v1/auth/setup",
        json={},
        headers={"Accept": CANONICAL_ACCEPT, "X-Request-ID": "req-validation"},
    )
    assert set(canonical.json()) == {
        "code",
        "message",
        "retryable",
        "request_id",
        "details",
    }
    assert canonical.json()["code"] == "validation_error"
    assert canonical.json()["details"]["errors"]


@pytest.mark.asyncio
async def test_rest_v2_thaws_frozen_details_and_redacts_unexpected_errors() -> None:
    from app.errors import ConflictError, register_exception_handlers
    from app.middleware import RequestIdMiddleware

    app = FastAPI()
    app.add_middleware(RequestIdMiddleware)
    register_exception_handlers(app)
    source = {"resolution": {"kind": "local", "versions": [1, 2]}}
    conflict = ConflictError(
        "Version conflict",
        code="version_conflict",
        details=source,
    )
    source["resolution"]["versions"].append(3)

    @app.get("/nested")
    async def nested() -> None:
        raise conflict

    @app.get("/boom")
    async def boom() -> None:
        raise RuntimeError("C:/secret/database.db token=hidden")

    transport = ASGITransport(app=app, raise_app_exceptions=False)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as local:
        nested_response = await local.get(
            "/nested",
            headers={"Accept": CANONICAL_ACCEPT, "X-Request-ID": "req-nested"},
        )
        boom_response = await local.get(
            "/boom",
            headers={"Accept": CANONICAL_ACCEPT, "X-Request-ID": "req-boom"},
        )

    assert nested_response.json() == {
        "code": "version_conflict",
        "message": "Version conflict",
        "retryable": False,
        "request_id": "req-nested",
        "details": {"resolution": {"kind": "local", "versions": [1, 2]}},
    }
    assert boom_response.status_code == 500
    assert boom_response.json() == {
        "code": "server_error",
        "message": "Internal server error",
        "retryable": False,
        "request_id": "req-boom",
        "details": {},
    }
    assert "secret" not in boom_response.text
    assert "hidden" not in boom_response.text


@pytest.mark.asyncio
async def test_openapi_documents_canonical_error_media_and_headers(client) -> None:
    schema = (await client.get("/openapi.json")).json()
    canonical = schema["components"]["schemas"]["CanonicalErrorResponse"]
    assert set(canonical["properties"]) == {
        "code",
        "message",
        "retryable",
        "request_id",
        "details",
    }
    checked = 0
    for path in schema["paths"].values():
        for operation in path.values():
            if not isinstance(operation, dict):
                continue
            for status, response in operation.get("responses", {}).items():
                if str(status).startswith(("4", "5")):
                    content = response.get("content", {})
                    assert "application/json" in content
                    assert CANONICAL_ACCEPT in content
                    headers = response.get("headers", {})
                    assert set(headers) >= {
                        "X-PomodoroXII-Error-Code",
                        "X-PomodoroXII-Retryable",
                        "X-Request-ID",
                    }
                    checked += 1
    assert checked > 0


# --------------------------------------------------------------------------- #
# TS1 Task 7 — Compiler rejection producer and registration parity
# --------------------------------------------------------------------------- #

EXPECTED_TS1_COMPILER_REJECTION_CODES = frozenset({
    "not_found",
    "space_scope_mismatch",
    "invalid_project_key",
    "project_key_conflict",
    "invalid_work_item_tree",
    "active_child_conflict",
    "version_conflict",
    "unsupported_content_version",
    "invalid_note_document",
    "work_item_structure_changed",
    "offline_formal_creation_forbidden",
})


def test_ts1_compiler_rejection_producer_set_is_exact() -> None:
    """The Task Space compiler file must produce exactly the 11 expected
    rejection codes — no filtering, no exclusions, no additions.

    The raw set from ``literal_exception_codes`` on ``compiler.py`` is
    asserted directly against the expected contract.  If the compiler
    produces extra codes (e.g. ``idempotency_conflict``) or is missing
    expected codes (e.g. ``space_scope_mismatch``), the test fails and the
    production boundary must be fixed — not the test.

    BLOCKER: At commit 7728be5, ``compiler.py`` produces
    ``idempotency_conflict`` (not in the expected set) and delegates
    ``space_scope_mismatch`` to ``unit_of_work.py`` instead of raising it
    directly.  Fixing this requires modifying ``compiler.py``, which is
    outside the allowed TS1 Task 7 file scope.  This test is intentionally
    RED to surface the production boundary issue.
    """
    from pathlib import Path

    from tests.ast_helpers import literal_exception_codes

    backend_root = Path(__file__).resolve().parents[1]
    compiler_path = backend_root / "app" / "task_space" / "compiler.py"

    raw_producer = literal_exception_codes(compiler_path, "MutationRuleViolation")

    assert raw_producer == EXPECTED_TS1_COMPILER_REJECTION_CODES, (
        f"TS1 compiler rejection producer codes mismatch.\n"
        f"  Raw set:   {sorted(raw_producer)}\n"
        f"  Expected:  {sorted(EXPECTED_TS1_COMPILER_REJECTION_CODES)}\n"
        f"  Missing:   {sorted(EXPECTED_TS1_COMPILER_REJECTION_CODES - raw_producer)}\n"
        f"  Unexpected:{sorted(raw_producer - EXPECTED_TS1_COMPILER_REJECTION_CODES)}"
    )


def test_all_ts1_rejection_codes_are_registered() -> None:
    """Every TS1 rejection code must be in MUTATION_REJECTION_SPECS."""
    from app.errors import MUTATION_REJECTION_SPECS

    registered = set(MUTATION_REJECTION_SPECS.keys())
    unregistered = EXPECTED_TS1_COMPILER_REJECTION_CODES - registered
    assert not unregistered, (
        f"TS1 rejection codes not registered in MUTATION_REJECTION_SPECS: "
        f"{unregistered}"
    )
