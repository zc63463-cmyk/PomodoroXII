"""TS-03: the closed MCP task-space write gateway.

Two layers are covered:

1. **Contract / rejection layer** (no runtime opened): the tool accepts exactly
   nine command kinds, rejects unknown and dormant fields before any runtime
   opens, and refuses to run before registration.
2. **Real integration layer** (production runtime + real UoW + real journal):
   all nine command kinds succeed end to end, replay is idempotent, a changed
   payload or reordered payload under the same ``batchId`` is rejected, a
   cross-Space batch is refused before budget is spent, and admission is
   charged per subcommand with a REST-compatible ``rate_limit_exceeded``.

The integration layer authenticates through a real space token and the real
``PomodoroTokenVerifier``, so authorization is exercised rather than mocked.
"""
from __future__ import annotations

import json
from typing import Any

import pytest
from fastmcp.exceptions import ToolError

from app.mcp.admission import MCP_WRITE_ADMISSION_BURST, McpWriteAdmission

SPACE_ID = "spc_test"


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #


def _payload(error: ToolError) -> dict[str, Any]:
    return json.loads(str(error))


async def _invoke(**kwargs: Any) -> dict[str, Any]:
    from app.mcp.task_space_tools import execute_task_space_commands

    return await execute_task_space_commands(**kwargs)


@pytest.fixture(autouse=True)
def _restore_gateway():
    import app.mcp.task_space_tools as module

    original = module._gateway_factory
    try:
        yield
    finally:
        module._gateway_factory = original


@pytest.fixture(autouse=True)
def _authenticated_principal(monkeypatch):
    """Authenticate the contract layer like an HTTP transport would.

    The gateway resolves its principal from the transport only — never from
    tool arguments — so contract tests pin the transport's access token and
    then assert on validation/admission behavior.
    """
    from fastmcp.server.auth import AccessToken

    import app.mcp.auth as mcp_auth

    access = AccessToken(
        token="contract-token",
        client_id="contract-subject",
        subject="contract-subject",
        scopes=[f"space:{SPACE_ID}"],
        expires_at=4_102_444_800,
        claims={
            "sub": "contract-subject",
            "type": "space",
            "space_id": SPACE_ID,
            "epoch": 1,
        },
    )
    monkeypatch.setattr(mcp_auth, "get_access_token", lambda: access)
    yield access


def _install_gateway(provider: Any, admission: McpWriteAdmission | None = None) -> McpWriteAdmission:
    import app.mcp.task_space_tools as module

    resolved = admission or McpWriteAdmission()
    module._gateway_factory = module.McpTaskSpaceWriteGateway(
        provider, admission=resolved
    )
    return resolved


class _NeverOpenedProvider:
    """Opening a runtime for a rejected call must fail the test loudly."""

    def __call__(self) -> Any:
        raise AssertionError("runtime must not be opened for a rejected call")


def _runtime_services_provider(client: Any) -> Any:
    """Return the exact RuntimeServices the production app booted with.

    ``run_mcp`` installs the same object into the MCP surface; driving the
    real one keeps MCP authorization, leases and the UoW identical to REST.
    """

    def provider() -> Any:
        app = client._transport.app  # type: ignore[attr-defined]
        services = getattr(app.state, "runtime_services", None)
        if services is None:
            raise RuntimeError("production runtime services are not booted")
        return services

    return provider


# --------------------------------------------------------------------------- #
# Layer 1: closed surface, no runtime opened
# --------------------------------------------------------------------------- #


def test_command_surface_is_exactly_the_nine_documented_kinds() -> None:
    from app.mcp.task_space_tools import ALLOWED_COMMAND_KINDS

    assert ALLOWED_COMMAND_KINDS == {
        "work_item.create",
        "work_item.update",
        "work_item.move",
        "work_item.transition",
        "work_item.add_labels",
        "work_item.remove_labels",
        "relation.create",
        "relation.remove",
        "relation.resolve",
    }


def test_registration_gate_matches_wire_union() -> None:
    from app.mcp.task_space_tools import _assert_closed_surface

    _assert_closed_surface()


def test_write_gateway_exposes_no_arbitrary_mutation_dispatch() -> None:
    """No public parameter can name a mutation, a Space, or a client budget."""
    import inspect

    from app.mcp.task_space_tools import McpTaskSpaceWriteGateway

    execute_params = set(inspect.signature(McpTaskSpaceWriteGateway.execute).parameters)
    assert execute_params == {"self", "scope", "commands", "batch_id"}
    check_params = set(inspect.signature(McpWriteAdmission.check).parameters)
    assert check_params == {"self", "principal", "space_id", "units"}


def test_tool_signature_accepts_only_batch_id_and_commands() -> None:
    import inspect

    from app.mcp.task_space_tools import execute_task_space_commands

    assert set(inspect.signature(execute_task_space_commands).parameters) == {
        "batch_id",
        "commands",
    }


def test_registered_mcp_surface_includes_the_single_write_tool() -> None:
    import asyncio

    from app.mcp.server import mcp

    tools = asyncio.run(mcp.list_tools())
    names = {tool.name for tool in tools}
    assert "execute_task_space_commands" in names
    # Exactly one write-capable tool: the read tools are untouched.
    assert "sync_push" in names  # sync writes travel the Sync v2 path, not this one


@pytest.mark.asyncio
async def test_gateway_cannot_be_used_before_registration() -> None:
    import app.mcp.task_space_tools as module

    module._gateway_factory = None
    with pytest.raises(RuntimeError):
        await _invoke(batch_id="b", commands=[{"kind": "work_item.create"}])


@pytest.mark.asyncio
async def test_empty_batch_is_rejected() -> None:
    _install_gateway(_NeverOpenedProvider())
    with pytest.raises(ToolError) as rejected:
        await _invoke(batch_id="b-empty", commands=[])
    assert _payload(rejected.value)["code"] == "validation_error"


@pytest.mark.asyncio
async def test_non_list_commands_are_rejected() -> None:
    _install_gateway(_NeverOpenedProvider())
    with pytest.raises(ToolError):
        await _invoke(batch_id="b-shape", commands={"kind": "work_item.create"})


@pytest.mark.asyncio
async def test_unknown_command_kind_is_rejected_before_runtime_open() -> None:
    _install_gateway(_NeverOpenedProvider())
    with pytest.raises(ToolError):
        await _invoke(
            batch_id="b-unknown",
            commands=[
                {
                    "kind": "work_item.archive",
                    "commandId": "c1",
                    "spaceId": SPACE_ID,
                }
            ],
        )


@pytest.mark.asyncio
async def test_unknown_field_is_rejected_before_runtime_open() -> None:
    _install_gateway(_NeverOpenedProvider())
    with pytest.raises(ToolError):
        await _invoke(
            batch_id="b-extra",
            commands=[
                {
                    "kind": "work_item.create",
                    "commandId": "c1",
                    "spaceId": SPACE_ID,
                    "projectId": "p1",
                    "title": "T",
                    "payloadHash": "0" * 64,
                    "arbitrary": "mutation",
                }
            ],
        )


@pytest.mark.asyncio
async def test_dormant_flexible_plan_fields_are_rejected() -> None:
    """The wire whitelist still forbids dormant A7 fields through MCP."""
    _install_gateway(_NeverOpenedProvider())
    with pytest.raises(ToolError):
        await _invoke(
            batch_id="b-dormant",
            commands=[
                {
                    "kind": "work_item.create",
                    "commandId": "c1",
                    "spaceId": SPACE_ID,
                    "projectId": "p1",
                    "title": "T",
                    "payloadHash": "0" * 64,
                    "hardDeadline": "2026-01-01T00:00:00.000Z",
                }
            ],
        )


@pytest.mark.asyncio
async def test_server_managed_resolution_fields_are_not_writable() -> None:
    """D2/D6 boundary: relation.resolve carries no server-managed post-image."""
    _install_gateway(_NeverOpenedProvider())
    with pytest.raises(ToolError):
        await _invoke(
            batch_id="b-resolved",
            commands=[
                {
                    "kind": "relation.resolve",
                    "commandId": "c1",
                    "spaceId": SPACE_ID,
                    "fromWorkItemId": "a",
                    "toWorkItemId": "b",
                    "relationType": "relates_to",
                    "expectedVersion": 1,
                    "payloadHash": "0" * 64,
                    "resolution": "done",
                }
            ],
        )


@pytest.mark.asyncio
async def test_duplicate_command_ids_are_rejected_before_runtime_open() -> None:
    from app.task_space.batch import BATCH_DUPLICATE_IDS_MESSAGE

    _install_gateway(_NeverOpenedProvider())
    with pytest.raises(ToolError) as rejected:
        await _invoke(
            batch_id="b-dup",
            commands=[
                {
                    "kind": "work_item.create",
                    "commandId": "same-id",
                    "spaceId": SPACE_ID,
                    "projectId": "p1",
                    "title": "A",
                    "payloadHash": "0" * 64,
                },
                {
                    "kind": "work_item.create",
                    "commandId": "same-id",
                    "spaceId": SPACE_ID,
                    "projectId": "p1",
                    "title": "B",
                    "payloadHash": "0" * 64,
                },
            ],
        )
    assert BATCH_DUPLICATE_IDS_MESSAGE in json.dumps(_payload(rejected.value))


# --------------------------------------------------------------------------- #
# Layer 2: real integration
# --------------------------------------------------------------------------- #


@pytest.mark.provisioned_space_storage
@pytest.mark.asyncio
async def test_nine_command_kinds_execute_end_to_end(client, monkeypatch) -> None:
    """All nine allowed kinds succeed through MCP against a real Space."""
    from app.mcp.auth import PomodoroTokenVerifier
    from app.mutation.types import canonical_payload_hash

    await client.post("/api/v1/auth/setup", json={"password": "test-password-123"})
    login = await client.post(
        "/api/v1/auth/login", json={"password": "test-password-123"}
    )
    assert login.status_code == 200, login.text
    master_headers = {"Authorization": f"Bearer {login.json()['access_token']}"}
    created = await client.post(
        "/api/v1/spaces", json={"name": "TS-03 MCP"}, headers=master_headers
    )
    assert created.status_code == 201, created.text
    space_id = created.json()["id"]
    token_response = await client.post(
        f"/api/v1/spaces/{space_id}/token", headers=master_headers
    )
    assert token_response.status_code == 200, token_response.text
    space_token = token_response.json()["space_token"]

    # Authenticate exactly as the HTTP transport does.
    access = await PomodoroTokenVerifier().verify_token(space_token)
    assert access is not None
    import app.mcp.auth as mcp_auth

    monkeypatch.setattr(mcp_auth, "get_access_token", lambda: access)

    import app.mcp.task_space_tools as module

    admission = McpWriteAdmission()
    module._gateway_factory = module.McpTaskSpaceWriteGateway(
        _runtime_services_provider(client), admission=admission
    )

    space_headers = {"Authorization": f"Bearer {space_token}"}
    project_payload = {"key": "MCPX", "name": "MCP Project", "description": None}
    project = await client.post(
        "/api/v1/projects",
        json={
            "commandId": "mcp-project",
            "spaceId": space_id,
            "payloadHash": canonical_payload_hash(project_payload),
            **project_payload,
        },
        headers={**space_headers, "Idempotency-Key": "mcp-project"},
    )
    assert project.status_code in (200, 201), project.text
    project_id = project.json()["value"]["id"]

    label_payload = {"name": "MCP Label", "color": None}
    label = await client.post(
        "/api/v1/labels",
        json={
            "commandId": "mcp-label",
            "spaceId": space_id,
            "payloadHash": canonical_payload_hash(label_payload),
            **label_payload,
        },
        headers={**space_headers, "Idempotency-Key": "mcp-label"},
    )
    assert label.status_code in (200, 201), label.text
    label_id = label.json()["value"]["id"]

    def create_payload(title: str) -> dict[str, Any]:
        return {
            "title": title,
            "description": None,
            "parent_id": None,
            "type_definition_id": None,
            "status_definition_id": None,
            "priority": None,
        }

    # 1) work_item.create
    first = await _invoke(
        batch_id="mcp-nine-create",
        commands=[
            {
                "kind": "work_item.create",
                "commandId": "mcp-item-a",
                "spaceId": space_id,
                "projectId": project_id,
                "payloadHash": canonical_payload_hash(create_payload("A")),
                "title": "A",
            },
            {
                "kind": "work_item.create",
                "commandId": "mcp-item-b",
                "spaceId": space_id,
                "projectId": project_id,
                "payloadHash": canonical_payload_hash(create_payload("B")),
                "title": "B",
            },
        ],
    )
    assert first["acceptedCount"] == 2 and first["rejectedCount"] == 0, first
    item_a = first["items"][0]["entityId"]
    item_b = first["items"][1]["entityId"]
    version_a = first["items"][0]["version"]

    # 2) work_item.update
    updated = await _invoke(
        batch_id="mcp-nine-update",
        commands=[
            {
                "kind": "work_item.update",
                "commandId": "mcp-update",
                "spaceId": space_id,
                "workItemId": item_a,
                "expectedVersion": version_a,
                "payloadHash": canonical_payload_hash({"patch": {"title": "A2"}}),
                "title": "A2",
            }
        ],
    )
    assert updated["acceptedCount"] == 1, updated
    version_a = updated["items"][0]["version"]

    # 3) work_item.move (child under A)
    moved = await _invoke(
        batch_id="mcp-nine-move",
        commands=[
            {
                "kind": "work_item.move",
                "commandId": "mcp-move",
                "spaceId": space_id,
                "workItemId": item_b,
                "expectedVersion": first["items"][1]["version"],
                # Move's canonical business payload excludes project_id and
                # child_rank: only the new parent is business content.
                "payloadHash": canonical_payload_hash({"new_parent_id": item_a}),
                "projectId": project_id,
                "parentId": item_a,
            }
        ],
    )
    assert moved["acceptedCount"] == 1, moved
    version_b = moved["items"][0]["version"]

    # 4) work_item.transition
    transitioned = await _invoke(
        batch_id="mcp-nine-transition",
        commands=[
            {
                "kind": "work_item.transition",
                "commandId": "mcp-transition",
                "spaceId": space_id,
                "workItemId": item_b,
                "expectedVersion": version_b,
                "payloadHash": canonical_payload_hash(
                    {"status_definition_id": "sys-status-in-progress"}
                ),
                "statusDefinitionId": "sys-status-in-progress",
            }
        ],
    )
    assert transitioned["acceptedCount"] == 1, transitioned
    version_b = transitioned["items"][0]["version"]

    # 5) work_item.add_labels
    added = await _invoke(
        batch_id="mcp-nine-addlabels",
        commands=[
            {
                "kind": "work_item.add_labels",
                "commandId": "mcp-add-labels",
                "spaceId": space_id,
                "workItemId": item_b,
                "expectedVersion": version_b,
                "payloadHash": canonical_payload_hash({"label_ids": [label_id]}),
                "labelIds": [label_id],
            }
        ],
    )
    assert added["acceptedCount"] == 1, added
    version_b = added["items"][0]["version"]

    # 6) work_item.remove_labels
    removed = await _invoke(
        batch_id="mcp-nine-removelabels",
        commands=[
            {
                "kind": "work_item.remove_labels",
                "commandId": "mcp-remove-labels",
                "spaceId": space_id,
                "workItemId": item_b,
                "expectedVersion": version_b,
                # Label set semantics: the complete target set, sorted.
                "payloadHash": canonical_payload_hash({"label_ids": []}),
                "labelIds": [],
            }
        ],
    )
    assert removed["acceptedCount"] == 1, removed
    version_b = removed["items"][0]["version"]

    # 7) relation.create — a blocking edge, because resolve only applies to
    #    blocking edges (relates_to is fail-closed by the compiler).
    #    The canonical business payload is the logical edge (from, to, type);
    #    relation_id is derived from those three plus the Space and is never sent.
    edge = {
        "from_work_item_id": item_a,
        "to_work_item_id": item_b,
        "relation_type": "depends_on",
    }
    relation_created = await _invoke(
        batch_id="mcp-nine-relcreate",
        commands=[
            {
                "kind": "relation.create",
                "commandId": "mcp-rel-create",
                "spaceId": space_id,
                "fromWorkItemId": item_a,
                "toWorkItemId": item_b,
                "relationType": "depends_on",
                "payloadHash": canonical_payload_hash(edge),
            }
        ],
    )
    assert relation_created["acceptedCount"] == 1, relation_created
    relation_id = relation_created["items"][0]["entityId"]
    relation_version = relation_created["items"][0]["version"]

    # 8) relation.resolve — idempotent acknowledgement of an upstream cancel.
    resolved = await _invoke(
        batch_id="mcp-nine-relresolve",
        commands=[
            {
                "kind": "relation.resolve",
                "commandId": "mcp-rel-resolve",
                "spaceId": space_id,
                "fromWorkItemId": item_a,
                "toWorkItemId": item_b,
                "relationType": "depends_on",
                "expectedVersion": relation_version,
                "payloadHash": canonical_payload_hash(edge),
            }
        ],
    )
    assert resolved["acceptedCount"] == 1, resolved

    # 9) relation.remove
    relation_removed = await _invoke(
        batch_id="mcp-nine-relremove",
        commands=[
            {
                "kind": "relation.remove",
                "commandId": "mcp-rel-remove",
                "spaceId": space_id,
                "fromWorkItemId": item_a,
                "toWorkItemId": item_b,
                "relationType": "depends_on",
                "expectedVersion": resolved["items"][0]["version"],
                "payloadHash": canonical_payload_hash(edge),
            }
        ],
    )
    assert relation_removed["acceptedCount"] == 1, relation_removed

    # The writes really landed: read them back over REST.
    read = await client.get(
        f"/api/v1/work-items/{item_a}", headers=space_headers
    )
    assert read.status_code == 200, read.text
    assert read.json()["title"] == "A2"
    assert relation_id  # relation identity was derived, not echoed


@pytest.mark.provisioned_space_storage
@pytest.mark.asyncio
async def test_replay_changed_payload_and_reordering_are_rejected(client, monkeypatch) -> None:
    """Idempotency binds batchId to canonical content and input order."""
    from app.mcp.auth import PomodoroTokenVerifier
    from app.mutation.types import canonical_payload_hash

    await client.post("/api/v1/auth/setup", json={"password": "test-password-123"})
    login = await client.post(
        "/api/v1/auth/login", json={"password": "test-password-123"}
    )
    master_headers = {"Authorization": f"Bearer {login.json()['access_token']}"}
    created = await client.post(
        "/api/v1/spaces", json={"name": "TS-03 Idem"}, headers=master_headers
    )
    space_id = created.json()["id"]
    token_response = await client.post(
        f"/api/v1/spaces/{space_id}/token", headers=master_headers
    )
    space_token = token_response.json()["space_token"]

    access = await PomodoroTokenVerifier().verify_token(space_token)
    assert access is not None
    import app.mcp.auth as mcp_auth

    monkeypatch.setattr(mcp_auth, "get_access_token", lambda: access)

    import app.mcp.task_space_tools as module

    module._gateway_factory = module.McpTaskSpaceWriteGateway(
        _runtime_services_provider(client), admission=McpWriteAdmission()
    )

    space_headers = {"Authorization": f"Bearer {space_token}"}
    project_payload = {"key": "IDEM", "name": "Idem", "description": None}
    project = await client.post(
        "/api/v1/projects",
        json={
            "commandId": "idem-project",
            "spaceId": space_id,
            "payloadHash": canonical_payload_hash(project_payload),
            **project_payload,
        },
        headers={**space_headers, "Idempotency-Key": "idem-project"},
    )
    project_id = project.json()["value"]["id"]

    def create_payload(title: str) -> dict[str, Any]:
        return {
            "title": title,
            "description": None,
            "parent_id": None,
            "type_definition_id": None,
            "status_definition_id": None,
            "priority": None,
        }

    def command(command_id: str, title: str) -> dict[str, Any]:
        return {
            "kind": "work_item.create",
            "commandId": command_id,
            "spaceId": space_id,
            "projectId": project_id,
            "payloadHash": canonical_payload_hash(create_payload(title)),
            "title": title,
        }

    batch_id = "mcp-idem-batch"
    original = [command("idem-a", "One"), command("idem-b", "Two")]
    first = await _invoke(batch_id=batch_id, commands=original)
    assert first["acceptedCount"] == 2, first

    # Same batchId + same content → the durable receipt is replayed.
    replay = await _invoke(batch_id=batch_id, commands=original)
    assert replay == first

    # Same batchId + changed payload → idempotency conflict.
    with pytest.raises(ToolError) as changed:
        await _invoke(
            batch_id=batch_id,
            commands=[command("idem-a", "One"), command("idem-b", "Edited")],
        )
    assert _payload(changed.value)["code"] == "idempotency_conflict"

    # Same batchId + reordered payloads → also a conflict (order is content).
    with pytest.raises(ToolError) as reordered:
        await _invoke(
            batch_id=batch_id,
            commands=[command("idem-b", "Two"), command("idem-a", "One")],
        )
    assert _payload(reordered.value)["code"] == "idempotency_conflict"


@pytest.mark.provisioned_space_storage
@pytest.mark.asyncio
async def test_cross_space_batch_is_refused_before_budget_is_spent(
    client, monkeypatch
) -> None:
    from app.mcp.auth import PomodoroTokenVerifier

    await client.post("/api/v1/auth/setup", json={"password": "test-password-123"})
    login = await client.post(
        "/api/v1/auth/login", json={"password": "test-password-123"}
    )
    master_headers = {"Authorization": f"Bearer {login.json()['access_token']}"}
    created = await client.post(
        "/api/v1/spaces", json={"name": "TS-03 Cross"}, headers=master_headers
    )
    space_id = created.json()["id"]
    token_response = await client.post(
        f"/api/v1/spaces/{space_id}/token", headers=master_headers
    )
    space_token = token_response.json()["space_token"]

    access = await PomodoroTokenVerifier().verify_token(space_token)
    assert access is not None
    import app.mcp.auth as mcp_auth

    monkeypatch.setattr(mcp_auth, "get_access_token", lambda: access)

    import app.mcp.task_space_tools as module

    admission = McpWriteAdmission()
    module._gateway_factory = module.McpTaskSpaceWriteGateway(
        _runtime_services_provider(client), admission=admission
    )

    # A batch naming a Space the caller is not authorized for is refused by
    # the Space authority itself: an authorization failure (HTTP 403
    # semantics), never an exhausted budget or a partial write.
    with pytest.raises(ToolError) as refused:
        await _invoke(
            batch_id="mcp-cross-space",
            commands=[
                {
                    "kind": "work_item.create",
                    "commandId": "cross-1",
                    "spaceId": "spc_somewhere_else",
                    "projectId": "p1",
                    "title": "T",
                    "payloadHash": "0" * 64,
                }
            ],
        )
    payload = _payload(refused.value)
    assert payload["code"] == "forbidden"
    assert payload["retryable"] is False

    # A batch whose commands disagree with each other about the Space is
    # refused before execution, so no write is applied to either Space.
    with pytest.raises(ToolError) as mixed:
        await _invoke(
            batch_id="mcp-mixed-space",
            commands=[
                {
                    "kind": "work_item.create",
                    "commandId": "mixed-1",
                    "spaceId": space_id,
                    "projectId": "p1",
                    "title": "T",
                    "payloadHash": "0" * 64,
                },
                {
                    "kind": "work_item.create",
                    "commandId": "mixed-2",
                    "spaceId": "spc_somewhere_else",
                    "projectId": "p1",
                    "title": "T",
                    "payloadHash": "0" * 64,
                },
            ],
        )
    assert _payload(mixed.value)["code"] == "space_scope_mismatch"

    # The refused call burned no admission budget: the whole window is intact.
    lease = await admission.check(
        type("P", (), {"subject": access.subject})(), space_id, MCP_WRITE_ADMISSION_BURST
    )
    await lease.commit()


@pytest.mark.provisioned_space_storage
@pytest.mark.asyncio
async def test_unauthenticated_mcp_write_is_rejected(client, monkeypatch) -> None:
    import app.mcp.auth as mcp_auth
    import app.mcp.task_space_tools as module

    monkeypatch.setattr(mcp_auth, "get_access_token", lambda: None)
    module._gateway_factory = module.McpTaskSpaceWriteGateway(
        _runtime_services_provider(client), admission=McpWriteAdmission()
    )

    with pytest.raises(ToolError) as rejected:
        await _invoke(
            batch_id="mcp-anon",
            commands=[
                {
                    "kind": "work_item.create",
                    "commandId": "anon-1",
                    "spaceId": SPACE_ID,
                    "projectId": "p1",
                    "title": "T",
                    "payloadHash": "0" * 64,
                }
            ],
        )
    assert _payload(rejected.value)["code"] == "auth_required"


@pytest.mark.provisioned_space_storage
@pytest.mark.asyncio
async def test_admission_is_charged_per_subcommand_and_reports_retry(
    client, monkeypatch
) -> None:
    from app.mcp.auth import PomodoroTokenVerifier
    from app.mutation.types import canonical_payload_hash

    await client.post("/api/v1/auth/setup", json={"password": "test-password-123"})
    login = await client.post(
        "/api/v1/auth/login", json={"password": "test-password-123"}
    )
    master_headers = {"Authorization": f"Bearer {login.json()['access_token']}"}
    created = await client.post(
        "/api/v1/spaces", json={"name": "TS-03 Budget"}, headers=master_headers
    )
    space_id = created.json()["id"]
    token_response = await client.post(
        f"/api/v1/spaces/{space_id}/token", headers=master_headers
    )
    space_token = token_response.json()["space_token"]

    access = await PomodoroTokenVerifier().verify_token(space_token)
    assert access is not None
    import app.mcp.auth as mcp_auth

    monkeypatch.setattr(mcp_auth, "get_access_token", lambda: access)

    import app.mcp.server as server
    import app.mcp.task_space_tools as module

    admission = McpWriteAdmission(burst=2, window_seconds=60.0)
    module._gateway_factory = module.McpTaskSpaceWriteGateway(
        _runtime_services_provider(client), admission=admission
    )

    space_headers = {"Authorization": f"Bearer {space_token}"}
    project_payload = {"key": "BUD", "name": "Budget", "description": None}
    project = await client.post(
        "/api/v1/projects",
        json={
            "commandId": "budget-project",
            "spaceId": space_id,
            "payloadHash": canonical_payload_hash(project_payload),
            **project_payload,
        },
        headers={**space_headers, "Idempotency-Key": "budget-project"},
    )
    project_id = project.json()["value"]["id"]

    def command(command_id: str, title: str) -> dict[str, Any]:
        return {
            "kind": "work_item.create",
            "commandId": command_id,
            "spaceId": space_id,
            "projectId": project_id,
            "payloadHash": canonical_payload_hash(
                {
                    "title": title,
                    "description": None,
                    "parent_id": None,
                    "type_definition_id": None,
                    "status_definition_id": None,
                    "priority": None,
                }
            ),
            "title": title,
        }

    # A two-command batch consumes the whole capacity of two.
    accepted = await _invoke(
        batch_id="mcp-budget-1", commands=[command("bud-1", "One"), command("bud-2", "Two")]
    )
    assert accepted["acceptedCount"] == 2

    with pytest.raises(ToolError) as exhausted:
        await _invoke(batch_id="mcp-budget-2", commands=[command("bud-3", "Three")])
    payload = _payload(exhausted.value)
    assert payload["code"] == "rate_limit_exceeded"
    assert payload["retryable"] is True
    assert payload["details"]["scope"] == "process_local"
    assert payload["details"]["retryAfterSeconds"] >= 1
