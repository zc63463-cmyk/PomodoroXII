"""Task Space live HTTP smoke — runs against a REAL uvicorn server.

Environment contract (fail fast when a required value is missing):

  PXII_SMOKE_BASE       base URL of the live backend, e.g. http://127.0.0.1:8011
  PXII_SMOKE_PASSWORD   admin password (NO hardcoded default)
  PXII_SMOKE_PREFIX     optional run prefix; a random one is generated if absent

The script drives a full workflow over the wire: setup -> login -> space ->
space token -> project -> root work item -> L2 child -> L3 child -> legal move
(authoritative rank) -> status transition -> Note create/update/read.  Every
fixture identifier is scoped by the run prefix so repeated runs are isolated;
nothing is written to any persistent/production environment.

Note verification asserts the GET returns the canonical document (exact
structural equality) and that a PUT update advances the version by exactly +1.
"""

from __future__ import annotations

import os
import random
import string
import sys

import httpx

from app.mutation.types import canonical_payload_hash


class SmokeError(RuntimeError):
    """A live-smoke failure with a sanitised request/response summary."""


def _require_env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise SmokeError(f"missing required env {name}")
    return value


def _run_prefix() -> str:
    explicit = os.environ.get("PXII_SMOKE_PREFIX")
    if explicit:
        return explicit
    return "".join(random.choices(string.ascii_uppercase + string.digits, k=6))


def _expect(response: httpx.Response, *statuses: int, what: str) -> dict:
    if response.status_code not in statuses:
        raise SmokeError(
            f"{what}: unexpected status {response.status_code} (expected "
            f"{statuses}); method={response.request.method} "
            f"path={response.request.url.path} "
            f"body={response.text[:300]}"
        )
    return response.json()


def main() -> int:
    base = _require_env("PXII_SMOKE_BASE").rstrip("/")
    password = _require_env("PXII_SMOKE_PASSWORD")
    prefix = _run_prefix()

    client = httpx.Client(base_url=base, timeout=30)

    def post(path: str, body: dict, headers: dict | None = None) -> httpx.Response:
        return client.post(path, json=body, headers=headers or {})

    def put(path: str, body: dict, headers: dict | None = None) -> httpx.Response:
        return client.put(path, json=body, headers=headers or {})

    # 1. auth setup + login (setup may already be done by a readiness probe)
    setup = post("/api/v1/auth/setup", {"password": password})
    _expect(setup, 201, 409, what="auth setup")
    login = post("/api/v1/auth/login", {"password": password})
    master_login = _expect(login, 200, what="auth login")
    master = {"Authorization": f"Bearer {master_login['access_token']}"}

    # 2. create space + space token
    created = post("/api/v1/spaces", {"name": f"Live Smoke {prefix}"}, master)
    created_body = _expect(created, 201, what="space create")
    space_id = created_body["id"]
    token = post(f"/api/v1/spaces/{space_id}/token", {}, master)
    token_body = _expect(token, 200, what="space token")
    headers = {"Authorization": f"Bearer {token_body['space_token']}"}

    # 3. project (random, isolated key)
    project_payload = {"key": f"L{prefix}", "name": f"Live {prefix}", "description": None}
    resp = post(
        "/api/v1/projects",
        {
            "commandId": f"{prefix}-proj",
            "spaceId": space_id,
            "payloadHash": canonical_payload_hash(project_payload),
            "key": project_payload["key"],
            "name": project_payload["name"],
        },
        {**headers, "Idempotency-Key": f"{prefix}-proj"},
    )
    project_body = _expect(resp, 201, what="project create")
    project_id = project_body["entityId"]

    # 4. root work item
    wi_payload = {
        "title": "Root",
        "description": None,
        "parent_id": None,
        "type_definition_id": None,
        "status_definition_id": None,
        "priority": None,
    }
    resp = post(
        "/api/v1/work-items",
        {
            "commandId": f"{prefix}-root",
            "spaceId": space_id,
            "projectId": project_id,
            "payloadHash": canonical_payload_hash(wi_payload),
            "title": "Root",
        },
        {**headers, "Idempotency-Key": f"{prefix}-root"},
    )
    root_body = _expect(resp, 201, what="root work item create")
    root = root_body["value"]
    if root["depth"] != 1 or root["childRank"] != 0:
        raise SmokeError(f"root projection wrong: depth={root['depth']} rank={root['childRank']}")

    # 5. L2 child
    l2_payload = {**wi_payload, "title": "Child", "parent_id": root["id"]}
    resp = post(
        "/api/v1/work-items",
        {
            "commandId": f"{prefix}-l2",
            "spaceId": space_id,
            "projectId": project_id,
            "payloadHash": canonical_payload_hash(l2_payload),
            "title": "Child",
            "parentId": root["id"],
        },
        {**headers, "Idempotency-Key": f"{prefix}-l2"},
    )
    l2_body = _expect(resp, 201, what="L2 work item create")
    l2 = l2_body["value"]
    if l2["depth"] != 2:
        raise SmokeError(f"L2 depth wrong: {l2['depth']}")

    # 6. L3 child
    l3_payload = {**wi_payload, "title": "Grandchild", "parent_id": l2["id"]}
    resp = post(
        "/api/v1/work-items",
        {
            "commandId": f"{prefix}-l3",
            "spaceId": space_id,
            "projectId": project_id,
            "payloadHash": canonical_payload_hash(l3_payload),
            "title": "Grandchild",
            "parentId": l2["id"],
        },
        {**headers, "Idempotency-Key": f"{prefix}-l3"},
    )
    l3_body = _expect(resp, 201, what="L3 work item create")
    l3 = l3_body["value"]
    if l3["depth"] != 3:
        raise SmokeError(f"L3 depth wrong: {l3['depth']}")

    # 7. legal move (authoritative rank on the now-empty root sibling set)
    move_payload = {"new_parent_id": None}
    resp = post(
        f"/api/v1/work-items/{l2['id']}/move",
        {
            "commandId": f"{prefix}-move",
            "spaceId": space_id,
            "expectedVersion": l2["version"],
            "payloadHash": canonical_payload_hash(move_payload),
            "projectId": project_id,
            "parentId": None,
        },
        {**headers, "Idempotency-Key": f"{prefix}-move"},
    )
    move_body = _expect(resp, 200, what="work item move")
    moved = move_body["value"]
    if moved["childRank"] != 1:
        raise SmokeError(f"move rank wrong: {moved['childRank']} (expected 1)")

    # 8. status transition (not-started -> in-progress)
    transition_status = "sys-status-in-progress"
    # The canonical business payload is the mutation payload minus the
    # "operation" discriminator (see task_space.module._business_payload).
    transition_payload = {"status_definition_id": transition_status}
    resp = post(
        f"/api/v1/work-items/{l2['id']}/transition",
        {
            "commandId": f"{prefix}-transition",
            "spaceId": space_id,
            "expectedVersion": moved["version"],
            "payloadHash": canonical_payload_hash(transition_payload),
            "statusDefinitionId": transition_status,
        },
        {**headers, "Idempotency-Key": f"{prefix}-transition"},
    )
    transition_body = _expect(resp, 200, what="work item transition")
    if transition_body["value"]["statusDefinitionId"] != transition_status:
        raise SmokeError("transition did not set status_definition_id")

    note_path = f"/api/v1/work-items/{l2['id']}/note"

    def read_note() -> dict:
        read = client.get(note_path, headers=headers)
        body = _expect(read, 200, what="note read")
        return body

    # 9. Note create via PUT, then verify GET returns the canonical document + version
    note_document = {
        "contentVersion": 1,
        "blocks": [{"type": "paragraph", "blockId": "n1", "text": "Live note"}],
    }
    note_payload = {"document": note_document}
    resp = put(
        note_path,
        {
            "commandId": f"{prefix}-note",
            "spaceId": space_id,
            "expectedVersion": None,
            "payloadHash": canonical_payload_hash(note_payload),
            "document": note_document,
        },
        {**headers, "Idempotency-Key": f"{prefix}-note"},
    )
    _expect(resp, 200, what="note create")
    note_v1 = read_note()
    if note_v1["document"] != note_document:
        raise SmokeError(f"note create document mismatch: {note_v1['document']}")
    note_version = note_v1["version"]

    # 10. Note update with expectedVersion, then read back: canonical document
    #     equal AND version advanced by exactly +1 (no extra write).
    updated_document = {
        "contentVersion": 1,
        "blocks": [
            {"type": "paragraph", "blockId": "n1", "text": "Live note"},
            {"type": "paragraph", "blockId": "n2", "text": "Updated"},
        ],
    }
    updated_payload = {"document": updated_document}
    resp = put(
        note_path,
        {
            "commandId": f"{prefix}-note-2",
            "spaceId": space_id,
            "expectedVersion": note_version,
            "payloadHash": canonical_payload_hash(updated_payload),
            "document": updated_document,
        },
        {**headers, "Idempotency-Key": f"{prefix}-note-2"},
    )
    _expect(resp, 200, what="note update")
    read_note_v2 = read_note()
    if read_note_v2["version"] != note_version + 1:
        raise SmokeError(
            f"note version did not advance by exactly +1: {note_version} -> {read_note_v2['version']}"
        )
    if read_note_v2["document"] != updated_document:
        raise SmokeError(f"note update document mismatch: {read_note_v2['document']}")

    print(
        f"LIVE SMOKE OK prefix={prefix} project={project_id} "
        f"root_depth={root['depth']} l2_depth={l2['depth']} l3_depth={l3['depth']} "
        f"moved_rank={moved['childRank']} "
        f"note_version={note_version}->{read_note_v2['version']}"
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except SmokeError as error:
        print(f"LIVE SMOKE FAIL: {error}", file=sys.stderr)
        raise SystemExit(1)
