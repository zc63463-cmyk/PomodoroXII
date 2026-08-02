"""Task Space REST route integration tests.

Verifies that the TS0 contract routers are mounted in the production v1
router, that legacy routes are absent, that the runtime bootstrap uses
the shared compiler factory with all domain policies, and that
provider-backed integration works end-to-end through the real app.
"""
from __future__ import annotations

from pathlib import Path

import pytest

from app.main import app

HTTP_METHODS = {"get", "put", "post", "patch", "delete"}


# --------------------------------------------------------------------------- #
# OpenAPI route presence tests
# --------------------------------------------------------------------------- #


class TestTaskSpaceRoutePresence:
    """Task Space routes must be mounted in the production v1 router."""

    def test_openapi_contains_project_routes(self) -> None:
        schema = app.openapi()
        paths = schema["paths"]
        assert "/api/v1/projects" in paths
        assert "get" in paths["/api/v1/projects"]
        assert "post" in paths["/api/v1/projects"]
        assert "/api/v1/projects/definitions" in paths
        assert "/api/v1/projects/{project_id}" in paths

    def test_openapi_contains_work_item_routes(self) -> None:
        schema = app.openapi()
        paths = schema["paths"]
        assert "/api/v1/work-items" in paths
        assert "get" in paths["/api/v1/work-items"]
        assert "post" in paths["/api/v1/work-items"]
        assert "/api/v1/work-items/{work_item_id}" in paths
        assert "/api/v1/work-items/{work_item_id}/move" in paths
        assert "/api/v1/work-items/{work_item_id}/transition" in paths

    def test_openapi_contains_note_routes_with_correct_methods(self) -> None:
        schema = app.openapi()
        paths = schema["paths"]
        expected_note_methods = {
            "/api/v1/work-items/{work_item_id}/note": {"get", "put"},
            "/api/v1/work-items/{work_item_id}/note/append-blocks": {"post"},
            "/api/v1/work-items/{work_item_id}/note/toggle-checklist-item": {"post"},
        }
        actual_note_methods = {
            path: set(path_item) & HTTP_METHODS
            for path, path_item in paths.items()
            if path.startswith("/api/v1/work-items/{work_item_id}/note")
        }
        assert actual_note_methods == expected_note_methods

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

    def test_openapi_excludes_generic_note_commands(self) -> None:
        schema = app.openapi()
        for path in schema["paths"]:
            assert "/note/commands" not in path

    def test_toggle_checklist_request_schema_uses_camel_case(self) -> None:
        schema = app.openapi()
        toggle_path = (
            "/api/v1/work-items/{work_item_id}/note/toggle-checklist-item"
        )
        assert toggle_path in schema["paths"]
        toggle_op = schema["paths"][toggle_path]["post"]
        request_ref = (
            toggle_op["requestBody"]["content"]["application/json"]["schema"]["$ref"]
        )
        request_schema = schema["components"]["schemas"][
            request_ref.rsplit("/", 1)[-1]
        ]
        assert {
            "commandId",
            "spaceId",
            "expectedVersion",
            "payloadHash",
            "blockId",
            "itemId",
            "checked",
        } <= set(request_schema["properties"])
        assert "command_id" not in request_schema["properties"]


# --------------------------------------------------------------------------- #
# Compiler composition tests
# --------------------------------------------------------------------------- #


class TestCompilerComposition:
    """Runtime bootstrap must use the shared compiler factory."""

    def test_bootstrap_does_not_directly_construct_mutation_compiler(self) -> None:
        """bootstrap.py must not construct MutationCompiler directly."""
        bootstrap_path = (
            Path(__file__).resolve().parents[1]
            / "app"
            / "runtime"
            / "bootstrap.py"
        )
        source = bootstrap_path.read_text(encoding="utf-8")
        assert "MutationCompiler(" not in source, (
            "bootstrap.py must use the shared factory instead of directly "
            "constructing MutationCompiler"
        )

    def test_bootstrap_uses_shared_compiler_factory(self) -> None:
        """bootstrap.py must import and call build_mutation_compiler."""
        bootstrap_path = (
            Path(__file__).resolve().parents[1]
            / "app"
            / "runtime"
            / "bootstrap.py"
        )
        source = bootstrap_path.read_text(encoding="utf-8")
        assert "build_mutation_compiler" in source

    def test_shared_compiler_factory_includes_all_policies(self) -> None:
        """The shared factory must include all four domain policies."""
        from app.deps import build_mutation_compiler
        from app.registry import CATALOG

        compiler = build_mutation_compiler(CATALOG)
        policy_types = {type(p).__name__ for p in compiler._policies.values()}
        assert "TaskSpaceCompiler" in policy_types
        assert "FolderDomainPolicy" in policy_types
        assert "RelationDomainPolicy" in policy_types
        assert "KnowledgeDomainPolicy" in policy_types

    def test_only_one_mutation_compiler_constructor_in_app(self) -> None:
        """Only deps.py may construct MutationCompiler; no shadow compilers."""
        backend_root = Path(__file__).resolve().parents[1] / "app"
        constructors: list[str] = []
        for source_path in backend_root.rglob("*.py"):
            source = source_path.read_text(encoding="utf-8")
            if "MutationCompiler(" in source:
                constructors.append(
                    source_path.relative_to(backend_root).as_posix()
                )
        assert constructors == ["deps.py"], (
            "MutationCompiler must only be constructed in deps.py, "
            f"found: {constructors}"
        )


# --------------------------------------------------------------------------- #
# Provider-backed integration tests
# --------------------------------------------------------------------------- #


async def _setup_space_and_get_headers(client) -> tuple[dict[str, str], str]:
    """Set up auth and create a space; return headers and space_id."""
    setup = await client.post(
        "/api/v1/auth/setup", json={"password": "test-password-123"}
    )
    assert setup.status_code == 201
    login = await client.post(
        "/api/v1/auth/login", json={"password": "test-password-123"}
    )
    assert login.status_code == 200
    master_headers = {
        "Authorization": f"Bearer {login.json()['access_token']}"
    }
    created = await client.post(
        "/api/v1/spaces",
        json={"name": "Task Space Test Space"},
        headers=master_headers,
    )
    assert created.status_code == 201
    space_id = created.json()["id"]
    token = await client.post(
        f"/api/v1/spaces/{space_id}/token",
        headers=master_headers,
    )
    assert token.status_code == 200
    headers = {"Authorization": f"Bearer {token.json()['space_token']}"}
    return headers, space_id


@pytest.mark.provisioned_space_storage
class TestTaskSpaceIntegration:
    """Provider-backed integration tests through the real app."""

    async def test_project_create_returns_operation_id(self, client) -> None:
        from app.mutation.types import canonical_payload_hash

        headers, space_id = await _setup_space_and_get_headers(client)
        business_payload = {"key": "RM", "name": "Roadmap"}
        body = {
            "commandId": "rest-project-one",
            "spaceId": space_id,
            "payloadHash": canonical_payload_hash(business_payload),
            "key": " rm ",
            "name": "Roadmap",
        }
        resp = await client.post(
            "/api/v1/projects",
            json=body,
            headers={**headers, "Idempotency-Key": "rest-project-one"},
        )
        assert resp.status_code == 201
        body = resp.json()
        assert body["value"]["key"] == "RM"
        assert body["commandId"] == "rest-project-one"

    async def test_project_create_is_idempotent(self, client) -> None:
        from app.mutation.types import canonical_payload_hash

        headers, space_id = await _setup_space_and_get_headers(client)
        business_payload = {"key": "IDEM", "name": "Idempotent"}
        body = {
            "commandId": "rest-project-idem",
            "spaceId": space_id,
            "payloadHash": canonical_payload_hash(business_payload),
            "key": "idem",
            "name": "Idempotent",
        }
        req_headers = {**headers, "Idempotency-Key": "rest-project-idem"}
        first = await client.post("/api/v1/projects", json=body, headers=req_headers)
        second = await client.post("/api/v1/projects", json=body, headers=req_headers)
        assert first.status_code == second.status_code == 201
        assert first.json() == second.json()

    async def test_note_replace_requires_document_body(self, client) -> None:
        from app.mutation.types import canonical_payload_hash

        headers, space_id = await _setup_space_and_get_headers(client)
        project_body = {
            "commandId": "note-proj",
            "spaceId": space_id,
            "payloadHash": canonical_payload_hash({"key": "NP", "name": "NoteProj"}),
            "key": "np",
            "name": "NoteProj",
        }
        project = await client.post(
            "/api/v1/projects",
            json=project_body,
            headers={**headers, "Idempotency-Key": "note-proj"},
        )
        assert project.status_code == 201

        wi_body = {
            "commandId": "note-wi",
            "spaceId": space_id,
            "projectId": project.json()["entityId"],
            "payloadHash": canonical_payload_hash(
                {"title": "Note WI", "description": None, "parent_id": None,
                 "type_definition_id": None, "status_definition_id": None,
                 "priority": None}
            ),
            "title": "Note WI",
        }
        work_item = await client.post(
            "/api/v1/work-items",
            json=wi_body,
            headers={**headers, "Idempotency-Key": "note-wi"},
        )
        assert work_item.status_code == 201
        wi_id = work_item.json()["entityId"]

        missing = await client.put(
            f"/api/v1/work-items/{wi_id}/note",
            json={
                "commandId": "bad-note",
                "spaceId": space_id,
                "expectedVersion": None,
                "payloadHash": canonical_payload_hash({}),
            },
            headers={**headers, "Idempotency-Key": "bad-note"},
        )
        assert missing.status_code == 422

    async def test_work_item_list_passes_project_filter(self, client) -> None:
        from app.mutation.types import canonical_payload_hash

        headers, space_id = await _setup_space_and_get_headers(client)
        project_body = {
            "commandId": "filter-proj",
            "spaceId": space_id,
            "payloadHash": canonical_payload_hash({"key": "FP", "name": "FilterProj"}),
            "key": "fp",
            "name": "FilterProj",
        }
        project = await client.post(
            "/api/v1/projects",
            json=project_body,
            headers={**headers, "Idempotency-Key": "filter-proj"},
        )
        assert project.status_code == 201
        project_id = project.json()["entityId"]

        listed = await client.get(
            "/api/v1/work-items",
            params={"projectId": project_id},
            headers=headers,
        )
        assert listed.status_code == 200
        assert "items" in listed.json()

    async def test_note_toggle_checklist_rejects_stale_version(self, client) -> None:
        """Toggle with a stale expectedVersion must 409 without mutating state."""
        from app.mutation.types import canonical_payload_hash

        headers, space_id = await _setup_space_and_get_headers(client)

        # --- Create project and work item ---
        project_body = {
            "commandId": "cas-proj",
            "spaceId": space_id,
            "payloadHash": canonical_payload_hash({"key": "CAS", "name": "CasProj"}),
            "key": "cas",
            "name": "CasProj",
        }
        project = await client.post(
            "/api/v1/projects",
            json=project_body,
            headers={**headers, "Idempotency-Key": "cas-proj"},
        )
        assert project.status_code == 201

        wi_payload = {
            "title": "Cas WI",
            "description": None,
            "parent_id": None,
            "type_definition_id": None,
            "status_definition_id": None,
            "priority": None,
        }
        wi_body = {
            "commandId": "cas-wi",
            "spaceId": space_id,
            "projectId": project.json()["entityId"],
            "payloadHash": canonical_payload_hash(wi_payload),
            "title": "Cas WI",
        }
        work_item = await client.post(
            "/api/v1/work-items",
            json=wi_body,
            headers={**headers, "Idempotency-Key": "cas-wi"},
        )
        assert work_item.status_code == 201
        wi_id = work_item.json()["entityId"]

        # --- Create a v1 note with a checklist block ---
        note_document = {
            "contentVersion": 1,
            "blocks": [
                {
                    "type": "checklist",
                    "blockId": "cb1",
                    "items": [
                        {
                            "itemId": "ci1",
                            "text": "Review PR",
                            "checked": False,
                            "children": [],
                        }
                    ],
                }
            ],
        }
        note_payload = {"document": note_document}
        note_body = {
            "commandId": "cas-note",
            "spaceId": space_id,
            "expectedVersion": None,
            "payloadHash": canonical_payload_hash(note_payload),
            "document": note_document,
        }
        note_resp = await client.put(
            f"/api/v1/work-items/{wi_id}/note",
            json=note_body,
            headers={**headers, "Idempotency-Key": "cas-note"},
        )
        assert note_resp.status_code == 200
        note_version = note_resp.json()["version"]
        assert note_version == 1

        # --- Snapshot the note before the conflict attempt ---
        before = await client.get(
            f"/api/v1/work-items/{wi_id}/note",
            headers=headers,
        )
        assert before.status_code == 200
        before_value = before.json()["value"]

        # --- Toggle with a stale expectedVersion (current - 1 = 0) ---
        toggle_payload = {"block_id": "cb1", "item_id": "ci1", "checked": True}
        toggle_body = {
            "commandId": "cas-toggle",
            "spaceId": space_id,
            "expectedVersion": note_version - 1,
            "payloadHash": canonical_payload_hash(toggle_payload),
            "blockId": "cb1",
            "itemId": "ci1",
            "checked": True,
        }
        conflict = await client.post(
            f"/api/v1/work-items/{wi_id}/note/toggle-checklist-item",
            json=toggle_body,
            headers={**headers, "Idempotency-Key": "cas-toggle"},
        )
        assert conflict.status_code == 409
        conflict_json = conflict.json()
        assert conflict_json["detail"]["code"] == "version_conflict"

        # --- Verify version and document are unchanged ---
        after = await client.get(
            f"/api/v1/work-items/{wi_id}/note",
            headers=headers,
        )
        assert after.status_code == 200
        after_value = after.json()["value"]
        assert after_value["version"] == before_value["version"]
        assert after_value["document_json"] == before_value["document_json"]
