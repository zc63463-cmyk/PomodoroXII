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
# Test-local backup scheduler isolation
# --------------------------------------------------------------------------- #


@pytest.fixture(autouse=True)
def _isolate_route_tests_from_backup_scheduler(
    _isolate_env, monkeypatch
) -> None:
    """Keep Task Space client/lifespan tests free of the recovery scheduler.

    These route tests exercise the Task Space HTTP contract through the real
    app lifespan and do not verify the backup scheduler.  ``backup_enabled``
    defaults to true in production with a mandatory external target, so it is
    disabled only for this test module -- without inventing a fake backup
    target and without mocking the lifespan.  The production default must
    stay true.
    """
    import app.settings as settings_module

    monkeypatch.setattr(settings_module.settings, "backup_enabled", False)



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
        """The shared factory must include every domain policy."""
        from app.deps import build_mutation_compiler
        from app.registry import CATALOG

        compiler = build_mutation_compiler(CATALOG)
        policy_types = {type(p).__name__ for p in compiler._policies.values()}
        assert "TaskSpaceCompiler" in policy_types
        assert "FolderDomainPolicy" in policy_types
        assert "RelationDomainPolicy" in policy_types
        assert "KnowledgeDomainPolicy" in policy_types
        assert "FocusSessionMutationPolicy" in policy_types

        from app.focus_session.policy import FOCUS_SESSION_POLICY_TYPES

        for entity_type in FOCUS_SESSION_POLICY_TYPES:
            assert type(compiler._policies[entity_type]).__name__ == (
                "FocusSessionMutationPolicy"
            )

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
class TestProjectPayloadHashContract:
    """Project create canonical-payload contract between frontend and backend.

    Frozen rule (RED regression for nullable description):
      - the canonical business payload for CreateProject is ALWAYS
        ``{key, name, description}`` — ``description`` is kept as ``null``
        when the client omits it or sends ``null`` explicitly;
      - the frontend hashes ``{name, key, description: null}`` (see
        frontend/src/services/task-space-api.ts createProject), so the route
        must build the same field set for the backend canonical hash;
      - a duplicate key must return a stable ``409 project_key_conflict`` and
        must never be confused with a payload-hash rejection.
    """

    async def test_null_description_accepts_frontend_canonical_payload(self, client) -> None:
        """description=null must hash as {key,name,description:null} and succeed."""
        from app.mutation.types import canonical_payload_hash

        headers, space_id = await _setup_space_and_get_headers(client)
        business_payload = {"key": "NULL", "name": "Null Description", "description": None}
        resp = await client.post(
            "/api/v1/projects",
            json={
                "commandId": "rest-project-null-desc",
                "spaceId": space_id,
                "payloadHash": canonical_payload_hash(business_payload),
                "key": "null",
                "name": "Null Description",
                "description": None,
            },
            headers={**headers, "Idempotency-Key": "rest-project-null-desc"},
        )
        assert resp.status_code == 201, resp.text
        body = resp.json()
        assert body["value"]["key"] == "NULL"
        assert body["value"]["description"] is None

    async def test_omitted_description_equals_null_canonical_payload(self, client) -> None:
        """An omitted wire description must canonicalize to description=null."""
        from app.mutation.types import canonical_payload_hash

        headers, space_id = await _setup_space_and_get_headers(client)
        # Same canonical payload as the explicit-null request above: the wire
        # simply omits the description key.
        business_payload = {"key": "OMIT", "name": "Omitted Description", "description": None}
        resp = await client.post(
            "/api/v1/projects",
            json={
                "commandId": "rest-project-omitted-desc",
                "spaceId": space_id,
                "payloadHash": canonical_payload_hash(business_payload),
                "key": "omit",
                "name": "Omitted Description",
            },
            headers={**headers, "Idempotency-Key": "rest-project-omitted-desc"},
        )
        assert resp.status_code == 201, resp.text
        assert resp.json()["value"]["description"] is None

    async def test_non_null_description_hash_stays_consistent(self, client) -> None:
        """description="demo" must hash with the description field and succeed."""
        from app.mutation.types import canonical_payload_hash

        headers, space_id = await _setup_space_and_get_headers(client)
        business_payload = {"key": "DEMO", "name": "Demo Description", "description": "demo"}
        resp = await client.post(
            "/api/v1/projects",
            json={
                "commandId": "rest-project-demo-desc",
                "spaceId": space_id,
                "payloadHash": canonical_payload_hash(business_payload),
                "key": "demo",
                "name": "Demo Description",
                "description": "demo",
            },
            headers={**headers, "Idempotency-Key": "rest-project-demo-desc"},
        )
        assert resp.status_code == 201, resp.text
        assert resp.json()["value"]["description"] == "demo"

    async def test_duplicate_key_returns_stable_409_project_key_conflict(self, client) -> None:
        """A repeated key must 409 with code project_key_conflict, not 422."""
        from app.mutation.types import canonical_payload_hash

        headers, space_id = await _setup_space_and_get_headers(client)
        business_payload = {"key": "DUPL", "name": "Duplicate", "description": None}
        first = await client.post(
            "/api/v1/projects",
            json={
                "commandId": "rest-project-dup-first",
                "spaceId": space_id,
                "payloadHash": canonical_payload_hash(business_payload),
                "key": "dupl",
                "name": "Duplicate",
                "description": None,
            },
            headers={**headers, "Idempotency-Key": "rest-project-dup-first"},
        )
        assert first.status_code == 201, first.text

        second = await client.post(
            "/api/v1/projects",
            json={
                "commandId": "rest-project-dup-second",
                "spaceId": space_id,
                "payloadHash": canonical_payload_hash(business_payload),
                "key": "dupl",
                "name": "Duplicate",
                "description": None,
            },
            headers={**headers, "Idempotency-Key": "rest-project-dup-second"},
        )
        assert second.status_code == 409, second.text
        assert second.json()["detail"]["code"] == "project_key_conflict"
        assert "invalid_payload_hash" not in second.text

        page = (await client.get("/api/v1/projects", headers=headers)).json()
        matches = [item for item in page["items"] if item["key"] == "DUPL"]
        assert len(matches) == 1

    async def test_same_operation_id_replay_is_idempotent(self, client) -> None:
        """Replaying the same operation_id and payload must not duplicate."""
        from app.mutation.types import canonical_payload_hash

        headers, space_id = await _setup_space_and_get_headers(client)
        business_payload = {"key": "REPL", "name": "Replay", "description": None}
        body = {
            "commandId": "rest-project-replay",
            "spaceId": space_id,
            "payloadHash": canonical_payload_hash(business_payload),
            "key": "repl",
            "name": "Replay",
            "description": None,
        }
        req_headers = {**headers, "Idempotency-Key": "rest-project-replay"}
        first = await client.post("/api/v1/projects", json=body, headers=req_headers)
        second = await client.post("/api/v1/projects", json=body, headers=req_headers)
        assert first.status_code == second.status_code == 201, (first.text, second.text)
        assert first.json() == second.json()

        page = (await client.get("/api/v1/projects", headers=headers)).json()
        matches = [item for item in page["items"] if item["key"] == "REPL"]
        assert len(matches) == 1


@pytest.mark.provisioned_space_storage
class TestTaskSpaceIntegration:
    """Provider-backed integration tests through the real app."""

    async def test_project_create_returns_operation_id(self, client) -> None:
        from app.mutation.types import canonical_payload_hash

        headers, space_id = await _setup_space_and_get_headers(client)
        business_payload = {"key": "RM", "name": "Roadmap", "description": "Daily planning"}
        body = {
            "commandId": "rest-project-one",
            "spaceId": space_id,
            "payloadHash": canonical_payload_hash(business_payload),
            "key": " rm ",
            "name": "Roadmap",
            "description": "Daily planning",
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
        business_payload = {"key": "IDEM", "name": "Idempotent", "description": None}
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
            "payloadHash": canonical_payload_hash({"key": "NP", "name": "NoteProj", "description": None}),
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
            "payloadHash": canonical_payload_hash({"key": "FP", "name": "FilterProj", "description": None}),
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

    async def test_task_space_reads_return_complete_authoritative_wire_rows(self, client) -> None:
        """Read routes expose the fields consumed by the strict frontend schemas."""
        from app.mutation.types import canonical_payload_hash

        headers, space_id = await _setup_space_and_get_headers(client)
        project_payload = {"key": "FULL", "name": "Complete rows", "description": None}
        project = await client.post(
            "/api/v1/projects",
            json={
                "commandId": "complete-project",
                "spaceId": space_id,
                "payloadHash": canonical_payload_hash(project_payload),
                "key": "full",
                "name": "Complete rows",
            },
            headers={**headers, "Idempotency-Key": "complete-project"},
        )
        assert project.status_code == 201
        project_id = project.json()["entityId"]

        work_item_payload = {
            "title": "Complete task",
            "description": None,
            "parent_id": None,
            "type_definition_id": None,
            "status_definition_id": None,
            "priority": "high",
        }
        created = await client.post(
            "/api/v1/work-items",
            json={
                "commandId": "complete-work-item",
                "spaceId": space_id,
                "projectId": project_id,
                "payloadHash": canonical_payload_hash(work_item_payload),
                "title": "Complete task",
                "priority": "high",
            },
            headers={**headers, "Idempotency-Key": "complete-work-item"},
        )
        assert created.status_code == 201
        created_value = created.json()
        work_item_id = created_value["entityId"]
        assert created_value["value"]["depth"] == 1
        assert created_value["value"]["createdAt"]
        assert created_value["value"]["updatedAt"]

        project_read = await client.get(f"/api/v1/projects/{project_id}", headers=headers)
        assert project_read.status_code == 200
        project_value = project_read.json()
        assert set(project_value) == {
            "id", "spaceId", "key", "name", "description",
            "nextWorkItemNumber", "rank", "archivedAt", "version",
            "createdAt", "updatedAt",
        }
        assert project_value["spaceId"] == space_id
        assert project_value["createdAt"]
        assert project_value["updatedAt"]

        work_item_read = await client.get(
            f"/api/v1/work-items/{work_item_id}", headers=headers
        )
        assert work_item_read.status_code == 200
        work_item_value = work_item_read.json()
        assert set(work_item_value) == {
            "id", "spaceId", "projectId", "displayKey", "title", "description",
            "typeDefinitionId", "statusDefinitionId", "priority", "parentId",
            "childRank", "depth", "completionWindowStart", "completionWindowEnd",
            "reviewPoint", "hardDeadline", "effortEstimateLowerSeconds",
            "effortEstimateUpperSeconds", "effortActualSeconds", "confidence",
            "completedAt", "cancelledAt", "archivedAt", "markedAsAttention",
            # D5 Y: read-only labelIds projection on work item reads.
            "labelIds",
            "version", "createdAt", "updatedAt",
        }
        assert work_item_value["spaceId"] == space_id
        assert work_item_value["depth"] == 1
        assert work_item_value["priority"] == "high"
        assert work_item_value["createdAt"]
        assert work_item_value["updatedAt"]

        note_document = {
            "contentVersion": 1,
            "blocks": [{"type": "paragraph", "blockId": "p1", "text": "Body"}],
        }
        note_payload = {"document": note_document}
        note = await client.put(
            f"/api/v1/work-items/{work_item_id}/note",
            json={
                "commandId": "complete-note",
                "spaceId": space_id,
                "expectedVersion": None,
                "payloadHash": canonical_payload_hash(note_payload),
                "document": note_document,
            },
            headers={**headers, "Idempotency-Key": "complete-note"},
        )
        assert note.status_code == 200
        note_read = await client.get(
            f"/api/v1/work-items/{work_item_id}/note", headers=headers
        )
        assert note_read.status_code == 200
        note_value = note_read.json()
        assert set(note_value) == {
            "spaceId", "noteId", "workItemId", "document", "version",
            "createdAt", "updatedAt",
        }
        assert note_value["spaceId"] == space_id
        assert note_value["workItemId"] == work_item_id
        assert note_value["document"] == note_document
        assert note_value["createdAt"]
        assert note_value["updatedAt"]

    async def test_note_toggle_checklist_rejects_stale_version(self, client) -> None:
        """Toggle with a stale expectedVersion must 409 without mutating state."""
        from app.mutation.types import canonical_payload_hash

        headers, space_id = await _setup_space_and_get_headers(client)

        # --- Create project and work item ---
        project_body = {
            "commandId": "cas-proj",
            "spaceId": space_id,
            "payloadHash": canonical_payload_hash({"key": "CAS", "name": "CasProj", "description": None}),
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
        before_value = before.json()
        assert before_value["document"] == note_document

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
        after_value = after.json()
        assert after_value["version"] == before_value["version"]
        assert after_value["document"] == before_value["document"]


# --------------------------------------------------------------------------- #
# WorkItem mutation contract (TS-W2 Task 1): update / transition / move /
# idempotency against the real ASGI app and isolated temporary data root.
# --------------------------------------------------------------------------- #


async def _create_project(client, headers, space_id: str, command_id: str, key: str, name: str) -> str:
    from app.mutation.types import canonical_payload_hash

    project_payload = {"key": key, "name": name, "description": None}
    resp = await client.post(
        "/api/v1/projects",
        json={
            "commandId": command_id,
            "spaceId": space_id,
            "payloadHash": canonical_payload_hash(project_payload),
            "key": key,
            "name": name,
        },
        headers={**headers, "Idempotency-Key": command_id},
    )
    assert resp.status_code == 201, resp.text
    return resp.json()["entityId"]


async def _create_work_item(
    client, headers, space_id: str, command_id: str, project_id: str,
    *, title: str = "Task", parent_id: str | None = None, priority: str | None = None,
) -> dict:
    from app.mutation.types import canonical_payload_hash

    wi_payload = {
        "title": title,
        "description": None,
        "parent_id": parent_id,
        "type_definition_id": None,
        "status_definition_id": None,
        "priority": priority,
    }
    resp = await client.post(
        "/api/v1/work-items",
        json={
            "commandId": command_id,
            "spaceId": space_id,
            "projectId": project_id,
            "payloadHash": canonical_payload_hash(wi_payload),
            "title": title,
            "parentId": parent_id,
            "priority": priority,
        },
        headers={**headers, "Idempotency-Key": command_id},
    )
    assert resp.status_code == 201, resp.text
    body = resp.json()
    return {"id": body["entityId"], "version": body["version"], "value": body["value"]}


async def _first_in_progress_status(client, headers) -> str:
    resp = await client.get("/api/v1/projects/definitions", headers=headers)
    assert resp.status_code == 200, resp.text
    statuses = resp.json()["statuses"]
    in_progress = next((s for s in statuses if s["category"] == "in_progress"), None)
    assert in_progress is not None, "expected a seeded in_progress status"
    return str(in_progress["id"])


@pytest.mark.provisioned_space_storage
class TestWorkItemMutationContract:
    """Freeze the WorkItem update / transition / move REST contract.

    RED contract for TS-W2 Task 1:
      - update / transition / move accept the flat camelCase wire body and the
        canonical business payload hash defined by TaskSpaceCommandModule;
      - stale expectedVersion returns a stable 409 with
        ``detail.code == "version_conflict"``;
      - an accepted mutation returns the enriched post-image with version+1;
      - replaying the same commandId+payload is idempotent; a different
        payload under the same commandId is a stable 409.
    """

    async def test_work_item_create_l2_post_image(self, client) -> None:
        """A legal L2 create returns a complete accepted post-image."""
        headers, space_id = await _setup_space_and_get_headers(client)
        project_id = await _create_project(client, headers, space_id, "wi-l2-proj", "L2P", "L2 Project")
        l1 = await _create_work_item(client, headers, space_id, "wi-l2-l1", project_id, title="Parent")
        l2 = await _create_work_item(
            client, headers, space_id, "wi-l2-l2", project_id, title="Child", parent_id=l1["id"]
        )
        assert l2["value"]["parentId"] == l1["id"]
        assert l2["value"]["depth"] == 2
        assert l2["value"]["version"] == 1
        assert l2["value"]["title"] == "Child"
        assert l2["value"]["projectId"] == project_id
        assert l2["value"]["statusDefinitionId"]

    async def test_work_item_update_patch_post_image(self, client) -> None:
        """PATCH title/description/priority returns version+1 with the patch applied."""
        from app.mutation.types import canonical_payload_hash

        headers, space_id = await _setup_space_and_get_headers(client)
        project_id = await _create_project(client, headers, space_id, "wi-up-proj", "UPP", "Update Project")
        item = await _create_work_item(client, headers, space_id, "wi-up-item", project_id, title="Original")

        update_payload = {"patch": {"title": "Edited", "description": None, "priority": "low"}}
        resp = await client.patch(
            f"/api/v1/work-items/{item['id']}",
            json={
                "commandId": "wi-up-edit",
                "spaceId": space_id,
                "expectedVersion": item["version"],
                "payloadHash": canonical_payload_hash(update_payload),
                "title": "Edited",
                "description": None,
                "priority": "low",
            },
            headers={**headers, "Idempotency-Key": "wi-up-edit"},
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["entityType"] == "work_item"
        assert body["entityId"] == item["id"]
        assert body["commandId"] == "wi-up-edit"
        assert body["version"] == item["version"] + 1
        assert body["value"]["title"] == "Edited"
        assert body["value"]["description"] is None
        assert body["value"]["priority"] == "low"
        assert body["value"]["version"] == item["version"] + 1

    async def test_work_item_update_stale_version_conflict(self, client) -> None:
        """A stale expectedVersion must 409 version_conflict without mutating."""
        from app.mutation.types import canonical_payload_hash

        headers, space_id = await _setup_space_and_get_headers(client)
        project_id = await _create_project(client, headers, space_id, "wi-cas-proj", "WCP", "CAS Project")
        item = await _create_work_item(client, headers, space_id, "wi-cas-item", project_id, title="Stable")

        update_payload = {"patch": {"title": "Nope"}}
        stale = await client.patch(
            f"/api/v1/work-items/{item['id']}",
            json={
                "commandId": "wi-cas-stale",
                "spaceId": space_id,
                "expectedVersion": item["version"] - 1,
                "payloadHash": canonical_payload_hash(update_payload),
                "title": "Nope",
            },
            headers={**headers, "Idempotency-Key": "wi-cas-stale"},
        )
        assert stale.status_code == 409, stale.text
        assert stale.json()["detail"]["code"] == "version_conflict"

        fresh = await client.get(f"/api/v1/work-items/{item['id']}", headers=headers)
        assert fresh.status_code == 200
        assert fresh.json()["version"] == item["version"]
        assert fresh.json()["title"] == "Stable"

    async def test_work_item_transition_post_image(self, client) -> None:
        """Transition to a real definition returns version+1 with the new status."""
        from app.mutation.types import canonical_payload_hash

        headers, space_id = await _setup_space_and_get_headers(client)
        project_id = await _create_project(client, headers, space_id, "wi-tr-proj", "TRP", "Transition Project")
        item = await _create_work_item(client, headers, space_id, "wi-tr-item", project_id, title="Flow")
        target_status = await _first_in_progress_status(client, headers)
        assert item["value"]["statusDefinitionId"] != target_status

        transition_payload = {"status_definition_id": target_status}
        resp = await client.post(
            f"/api/v1/work-items/{item['id']}/transition",
            json={
                "commandId": "wi-tr-transition",
                "spaceId": space_id,
                "expectedVersion": item["version"],
                "payloadHash": canonical_payload_hash(transition_payload),
                "statusDefinitionId": target_status,
            },
            headers={**headers, "Idempotency-Key": "wi-tr-transition"},
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["version"] == item["version"] + 1
        assert body["value"]["statusDefinitionId"] == target_status
        assert body["value"]["version"] == item["version"] + 1

    async def test_work_item_transition_stale_version_conflict(self, client) -> None:
        """Transition with a stale expectedVersion must 409 version_conflict."""
        from app.mutation.types import canonical_payload_hash

        headers, space_id = await _setup_space_and_get_headers(client)
        project_id = await _create_project(client, headers, space_id, "wi-tc-proj", "TCP", "Transition CAS")
        item = await _create_work_item(client, headers, space_id, "wi-tc-item", project_id, title="CAS Flow")
        target_status = await _first_in_progress_status(client, headers)

        transition_payload = {"status_definition_id": target_status}
        stale = await client.post(
            f"/api/v1/work-items/{item['id']}/transition",
            json={
                "commandId": "wi-tc-stale",
                "spaceId": space_id,
                "expectedVersion": item["version"] - 1,
                "payloadHash": canonical_payload_hash(transition_payload),
                "statusDefinitionId": target_status,
            },
            headers={**headers, "Idempotency-Key": "wi-tc-stale"},
        )
        assert stale.status_code == 409, stale.text
        assert stale.json()["detail"]["code"] == "version_conflict"

    async def test_work_item_move_updates_parent_and_rank(self, client) -> None:
        """Move under a same-project parent returns parentId/depth/childRank."""
        from app.mutation.types import canonical_payload_hash

        headers, space_id = await _setup_space_and_get_headers(client)
        project_id = await _create_project(client, headers, space_id, "wi-mv-proj", "MVP", "Move Project")
        first = await _create_work_item(client, headers, space_id, "wi-mv-a", project_id, title="Alpha")
        second = await _create_work_item(client, headers, space_id, "wi-mv-b", project_id, title="Beta")

        move_payload = {"new_parent_id": second["id"]}
        resp = await client.post(
            f"/api/v1/work-items/{first['id']}/move",
            json={
                "commandId": "wi-mv-move",
                "spaceId": space_id,
                "expectedVersion": first["version"],
                "payloadHash": canonical_payload_hash(move_payload),
                "projectId": project_id,
                "parentId": second["id"],
            },
            headers={**headers, "Idempotency-Key": "wi-mv-move"},
        )
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["version"] == first["version"] + 1
        assert body["value"]["parentId"] == second["id"]
        assert body["value"]["depth"] == 2
        assert body["value"]["childRank"] == 0
        assert body["value"]["version"] == first["version"] + 1

    async def test_work_item_move_cross_project_rejected(self, client) -> None:
        """Moving into another project must 409 invalid_work_item_tree."""
        from app.mutation.types import canonical_payload_hash

        headers, space_id = await _setup_space_and_get_headers(client)
        project_a = await _create_project(client, headers, space_id, "wi-xp-pa", "XPA", "XP Project A")
        project_b = await _create_project(client, headers, space_id, "wi-xp-pb", "XPB", "XP Project B")
        item = await _create_work_item(client, headers, space_id, "wi-xp-item", project_a, title="A Item")

        move_payload = {"new_parent_id": None}
        resp = await client.post(
            f"/api/v1/work-items/{item['id']}/move",
            json={
                "commandId": "wi-xp-move",
                "spaceId": space_id,
                "expectedVersion": item["version"],
                "payloadHash": canonical_payload_hash(move_payload),
                "projectId": project_b,
                "parentId": None,
            },
            headers={**headers, "Idempotency-Key": "wi-xp-move"},
        )
        assert resp.status_code == 409, resp.text
        assert resp.json()["detail"]["code"] == "invalid_work_item_tree"

    async def test_work_item_create_replay_is_idempotent(self, client) -> None:
        """Replaying the exact same commandId+payload must not create a second row."""
        from app.mutation.types import canonical_payload_hash

        headers, space_id = await _setup_space_and_get_headers(client)
        project_id = await _create_project(client, headers, space_id, "wi-re-proj", "REP", "Replay Project")
        wi_payload = {
            "title": "Once",
            "description": None,
            "parent_id": None,
            "type_definition_id": None,
            "status_definition_id": None,
            "priority": None,
        }
        body = {
            "commandId": "wi-re-replay",
            "spaceId": space_id,
            "projectId": project_id,
            "payloadHash": canonical_payload_hash(wi_payload),
            "title": "Once",
        }
        first = await client.post(
            "/api/v1/work-items", json=body,
            headers={**headers, "Idempotency-Key": "wi-re-replay"},
        )
        assert first.status_code == 201, first.text
        second = await client.post(
            "/api/v1/work-items", json=body,
            headers={**headers, "Idempotency-Key": "wi-re-replay"},
        )
        assert second.status_code == 201, second.text
        assert second.json()["entityId"] == first.json()["entityId"]

        listed = await client.get(
            "/api/v1/work-items", params={"projectId": project_id}, headers=headers
        )
        assert listed.status_code == 200
        assert len(listed.json()["items"]) == 1

    async def test_work_item_operation_payload_mismatch_conflict(self, client) -> None:
        """The same commandId with a different canonical payload must 409."""
        from app.mutation.types import canonical_payload_hash

        headers, space_id = await _setup_space_and_get_headers(client)
        project_id = await _create_project(client, headers, space_id, "wi-om-proj", "OMP", "Op Mismatch")
        base_payload = {
            "title": "One",
            "description": None,
            "parent_id": None,
            "type_definition_id": None,
            "status_definition_id": None,
            "priority": None,
        }
        first = await client.post(
            "/api/v1/work-items",
            json={
                "commandId": "wi-om-same",
                "spaceId": space_id,
                "projectId": project_id,
                "payloadHash": canonical_payload_hash(base_payload),
                "title": "One",
            },
            headers={**headers, "Idempotency-Key": "wi-om-same"},
        )
        assert first.status_code == 201, first.text

        altered_payload = {
            "title": "Two",
            "description": None,
            "parent_id": None,
            "type_definition_id": None,
            "status_definition_id": None,
            "priority": None,
        }
        conflict = await client.post(
            "/api/v1/work-items",
            json={
                "commandId": "wi-om-same",
                "spaceId": space_id,
                "projectId": project_id,
                "payloadHash": canonical_payload_hash(altered_payload),
                "title": "Two",
            },
            headers={**headers, "Idempotency-Key": "wi-om-same"},
        )
        assert conflict.status_code == 409, conflict.text
        assert conflict.json()["detail"]["code"] == "idempotency_conflict"
