"""Task Space live HTTP smoke — runs against a REAL uvicorn server.

Environment contract (fail fast when a required value is missing):

  PXII_SMOKE_BASE       base URL of the live backend, e.g. http://127.0.0.1:8011
  PXII_SMOKE_PASSWORD   admin password (NO hardcoded default)
  PXII_SMOKE_PREFIX     optional run prefix; a random one is generated if absent

The script drives a full workflow over the wire: setup -> login -> space ->
space token -> project -> root work item -> L2 child -> L3 child -> legal move
(authoritative rank) -> status transition -> Note create/update/read ->
dependency relation (create / minimal projection / blocked-map / cycle guard /
remove) -> focus session over the master token (start / pause / locate / resume
/ end / locate 404) -> WorkItem archive + restore.  Every fixture identifier is
scoped by the run prefix so repeated runs are isolated; nothing is written to
any persistent/production environment.

Note verification asserts the GET returns the canonical document (exact
structural equality) and that a PUT update advances the version by exactly +1.
"""

from __future__ import annotations

import os
import random
import string
import sys
from datetime import datetime, timedelta, timezone

import httpx

from app.focus_session.commands import active_business_payload
from app.mutation.types import canonical_payload_hash

# Canonical error negotiation: without this Accept the backend emits the legacy
# envelope, which carries no machine-readable ``code``.
CANONICAL_ACCEPT = "application/vnd.pomodoroxii.error+json;version=2"
DEVICE_ID = "device-1"
TAB_ID = "tab-1"


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


def _utc_at(base: datetime, offset_seconds: int) -> str:
    """CanonicalUtc timestamp: YYYY-MM-DDTHH:MM:SS.000Z."""
    return (base + timedelta(seconds=offset_seconds)).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def _clock_body(
    command_id: str,
    session_id: str,
    expected_version: int,
    occurred_at: str,
    *,
    action: str = "pause",
    epoch: int = 1,
) -> dict[str, object]:
    """Owned-clock command (pause / resume / end).

    ``expected_version`` and ``ownership_epoch`` are HASH_GUARD fields: the
    canonical hash covers the semantic payload only — never the CAS/ownership
    envelope.  ``start`` is NOT covered here (its epoch must be null and its
    payload is hashed via ``active_business_payload``).
    """
    payload: dict[str, object] = {
        "occurred_at": occurred_at,
        "owner_device_id": DEVICE_ID,
        "owner_tab_id": TAB_ID,
    }
    wire: dict[str, object] = {
        "expectedVersion": expected_version,
        "occurredAt": occurred_at,
        "ownerDeviceId": DEVICE_ID,
        "ownerTabId": TAB_ID,
    }
    if action == "end":
        payload.update({
            "timer_completion": "completed", "validity": "valid",
            "validity_reason": None,
        })
        wire.update({
            "timerCompletion": "completed", "validity": "valid",
            "validityReason": None,
        })
    return {
        "commandId": command_id,
        "sessionId": session_id,
        "ownershipEpoch": epoch,
        "payloadHash": canonical_payload_hash(payload),
        "payload": wire,
    }


def _error_code(response: httpx.Response) -> str | None:
    """Machine-readable error code, tolerating both envelope shapes.

    Some handlers emit the canonical error object at the top level, others wrap
    it in FastAPI's ``detail`` key.  The smoke only needs the code.
    """
    try:
        body = response.json()
    except ValueError:
        return None
    if not isinstance(body, dict):
        return None
    code = body.get("code")
    if isinstance(code, str):
        return code
    detail = body.get("detail")
    if isinstance(detail, dict) and isinstance(detail.get("code"), str):
        return detail["code"]
    return None


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

    # 11. Dependency domain: create -> minimal far-endpoint projection ->
    #     derived blocked-map -> cycle guard -> remove.  l3 is the depth-2 item
    #     here (l2 was moved to the root in step 7), and depth 2 is the only
    #     depth where isBlocked is asserted to be true.

    def relation_wire(
        command_id: str,
        *,
        from_id: str,
        to_id: str,
        payload_hash: str,
        expected_version: int | None = None,
    ) -> dict[str, object]:
        body: dict[str, object] = {
            "commandId": command_id,
            "spaceId": space_id,
            "payloadHash": payload_hash,
            # from = blocked side, to = upstream blocker.
            "fromWorkItemId": from_id,
            "toWorkItemId": to_id,
            "relationType": "depends_on",
        }
        # create has no CAS (existence is the check); remove does.
        if expected_version is not None:
            body["expectedVersion"] = expected_version
        return body

    relation_hash = canonical_payload_hash({
        "from_work_item_id": l3["id"],
        "to_work_item_id": l2["id"],
        "relation_type": "depends_on",
    })
    rel_create_cmd = f"{prefix}-rel-create"
    resp = post(
        "/api/v1/relations",
        relation_wire(
            rel_create_cmd, from_id=l3["id"], to_id=l2["id"],
            payload_hash=relation_hash,
        ),
        {**headers, "Idempotency-Key": rel_create_cmd},
    )
    created_relation = _expect(resp, 201, what="relation create")
    relation_id = created_relation["entityId"]

    rel_set = _expect(
        client.get("/api/v1/relations", params={"workItemId": l3["id"]}, headers=headers),
        200, what="relation set read",
    )
    blockers = rel_set["blockers"]
    if len(blockers) != 1 or blockers[0]["workItem"]["id"] != l2["id"]:
        raise SmokeError(f"relation set wrong: {rel_set}")
    projected = blockers[0]["workItem"]
    if set(projected) != {"id", "displayKey", "projectId", "title", "statusDefinitionId"}:
        raise SmokeError(f"cross-project leak guard violated: {sorted(projected)}")
    if rel_set["blocking"] != []:
        raise SmokeError(f"expected no downstream edge, got {rel_set['blocking']}")

    blocked_map = _expect(
        client.get(
            "/api/v1/relations/blocked-map", params={"projectId": project_id},
            headers=headers,
        ),
        200, what="blocked map read",
    )
    blocked_entry = blocked_map["items"].get(l3["id"])
    if not blocked_entry or not blocked_entry["blockedByDependency"] or not blocked_entry["isBlocked"]:
        raise SmokeError(f"blocked-map missing isBlocked for the depth-2 item: {blocked_entry}")

    # A reverse edge closes l3 -> l2 -> l3 and must be refused, not silently stored.
    rel_cycle_cmd = f"{prefix}-rel-cycle"
    resp = post(
        "/api/v1/relations",
        relation_wire(
            rel_cycle_cmd, from_id=l2["id"], to_id=l3["id"],
            payload_hash=canonical_payload_hash({
                "from_work_item_id": l2["id"],
                "to_work_item_id": l3["id"],
                "relation_type": "depends_on",
            }),
        ),
        {**headers, "Idempotency-Key": rel_cycle_cmd, "Accept": CANONICAL_ACCEPT},
    )
    if resp.status_code != 409 or _error_code(resp) != "cycle_detected":
        raise SmokeError(
            f"cycle guard: expected 409 cycle_detected, got {resp.status_code} "
            f"code={_error_code(resp)} {resp.text[:200]}"
        )

    rel_remove_cmd = f"{prefix}-rel-remove"
    resp = client.request(
        "DELETE",
        f"/api/v1/relations/{relation_id}",
        json=relation_wire(
            rel_remove_cmd, from_id=l3["id"], to_id=l2["id"],
            payload_hash=relation_hash,
            expected_version=created_relation["version"],
        ),
        headers={**headers, "Idempotency-Key": rel_remove_cmd},
    )
    _expect(resp, 200, what="relation remove")
    after_remove = _expect(
        client.get("/api/v1/relations", params={"workItemId": l3["id"]}, headers=headers),
        200, what="relation set after remove",
    )
    if after_remove["blockers"]:
        raise SmokeError(f"remove did not clear blockers: {after_remove['blockers']}")

    # 12. Focus session over the MASTER token (the active-session router is not
    #     space-scoped): start -> pause -> locate -> resume -> end -> locate 404.
    #     A live session rejects every new start, so clear a leftover from an
    #     aborted run first (best effort — a failure here surfaces at start).
    clock_base = datetime.now(timezone.utc).replace(microsecond=0)
    leftover = client.get("/api/v1/active-session", headers=master)
    if leftover.status_code == 200:
        stale = leftover.json()["session"]["session"]
        client.post(
            "/api/v1/active-session/end",
            json=_clock_body(
                f"{prefix}-stale-end", str(stale["id"]), int(stale["version"]),
                _utc_at(clock_base, 0), action="end",
                epoch=int(stale.get("ownershipEpoch") or 1),
            ),
            headers=master,
        )

    session_id = f"{prefix}-sess"
    start_payload: dict[str, object] = {
        "level2_work_item_id": l3["id"],
        "level3_work_item_ids": [],
        "planned_seconds": 1500,
        "started_at": _utc_at(clock_base, 0),
        "owner_device_id": DEVICE_ID,
        "owner_tab_id": TAB_ID,
        "expected_work_item_versions": {l3["id"]: l3["version"]},
    }
    resp = post(
        "/api/v1/active-session/start",
        {
            "commandId": f"{prefix}-sess-start",
            "spaceId": space_id,
            "sessionId": session_id,
            "ownershipEpoch": None,
            "payloadHash": canonical_payload_hash(
                active_business_payload("start", start_payload)
            ),
            "payload": {
                "level2WorkItemId": l3["id"],
                "level3WorkItemIds": [],
                "plannedSeconds": 1500,
                "startedAt": start_payload["started_at"],
                "ownerDeviceId": DEVICE_ID,
                "ownerTabId": TAB_ID,
                "expectedWorkItemVersions": start_payload["expected_work_item_versions"],
            },
        },
        master,
    )
    started = _expect(resp, 201, what="active session start")
    session_version = int(started["session"]["session"]["version"])

    paused = _expect(
        post(
            "/api/v1/active-session/pause",
            _clock_body(f"{prefix}-pause", session_id, session_version, _utc_at(clock_base, 60)),
            master,
        ),
        200, what="session pause",
    )
    paused_version = int(paused["session"]["session"]["version"])
    if paused_version <= session_version:
        raise SmokeError(f"pause did not advance the session version: {session_version}")

    # Same command id, different payload: the idempotency guard must refuse
    # instead of applying a second clock transition.
    conflict = client.post(
        "/api/v1/active-session/pause",
        json=_clock_body(f"{prefix}-pause", session_id, session_version, _utc_at(clock_base, 61)),
        headers={**master, "Accept": CANONICAL_ACCEPT},
    )
    if conflict.status_code != 409 or _error_code(conflict) != "idempotency_conflict":
        raise SmokeError(
            f"idempotency guard: expected 409 idempotency_conflict, got "
            f"{conflict.status_code} code={_error_code(conflict)} {conflict.text[:200]}"
        )

    located = _expect(
        client.get("/api/v1/active-session", headers=master), 200, what="session locate",
    )
    if located["session"]["session"]["id"] != session_id:
        raise SmokeError(f"locate returned a foreign session: {located['session']['session']['id']}")

    resumed = _expect(
        post(
            "/api/v1/active-session/resume",
            _clock_body(f"{prefix}-resume", session_id, paused_version, _utc_at(clock_base, 120)),
            master,
        ),
        200, what="session resume",
    )
    resumed_version = int(resumed["session"]["session"]["version"])

    _expect(
        post(
            "/api/v1/active-session/end",
            _clock_body(
                f"{prefix}-end", session_id, resumed_version,
                _utc_at(clock_base, 180), action="end",
            ),
            master,
        ),
        200, what="session end",
    )
    gone = client.get("/api/v1/active-session", headers=master)
    if gone.status_code != 404:
        raise SmokeError(f"locate after end: expected 404, got {gone.status_code}")

    # 13. WorkItem archive/restore (archived_at) — a different mechanism from
    #     the generic soft-delete trash, which only covers note / folder /
    #     quick_note.  Both are touched so the split stays visible.
    fixture_payload = {**wi_payload, "title": "Trash fixture"}
    fixture_cmd = f"{prefix}-fixture"
    resp = post(
        "/api/v1/work-items",
        {
            "commandId": fixture_cmd,
            "spaceId": space_id,
            "projectId": project_id,
            "payloadHash": canonical_payload_hash(fixture_payload),
            "title": "Trash fixture",
        },
        {**headers, "Idempotency-Key": fixture_cmd},
    )
    fixture = _expect(resp, 201, what="trash fixture create")["value"]

    # The business payload is {"operation": "trash"|"restore"}; the canonical
    # hash is taken after the operation discriminator is dropped — i.e. {}.
    empty_hash = canonical_payload_hash({})
    trash_cmd = f"{prefix}-trash"
    resp = post(
        f"/api/v1/work-items/{fixture['id']}/trash",
        {
            "commandId": trash_cmd,
            "spaceId": space_id,
            "expectedVersion": fixture["version"],
            "payloadHash": empty_hash,
        },
        {**headers, "Idempotency-Key": trash_cmd},
    )
    archived = _expect(resp, 200, what="work item trash")
    if archived["value"]["archivedAt"] is None:
        raise SmokeError("trash did not stamp archived_at")

    generic = _expect(client.get("/api/v1/trash", headers=headers), 200, what="generic trash list")
    if any(item["entity_id"] == fixture["id"] for item in generic["items"]):
        raise SmokeError("archived work item must not appear in the generic soft-delete trash")

    restore_cmd = f"{prefix}-restore"
    resp = post(
        f"/api/v1/work-items/{fixture['id']}/restore",
        {
            "commandId": restore_cmd,
            "spaceId": space_id,
            "expectedVersion": archived["value"]["version"],
            "payloadHash": empty_hash,
        },
        {**headers, "Idempotency-Key": restore_cmd},
    )
    restored = _expect(resp, 200, what="work item restore")
    if restored["value"]["archivedAt"] is not None:
        raise SmokeError("restore did not clear archived_at")

    print(
        f"LIVE SMOKE OK prefix={prefix} project={project_id} "
        f"root_depth={root['depth']} l2_depth={l2['depth']} l3_depth={l3['depth']} "
        f"moved_rank={moved['childRank']} "
        f"note_version={note_version}->{read_note_v2['version']} "
        f"relation={relation_id} is_blocked={blocked_entry['isBlocked']} "
        f"cycle_guard=409 session={session_id} "
        f"archived_at_cleared={restored['value']['archivedAt'] is None}"
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except SmokeError as error:
        print(f"LIVE SMOKE FAIL: {error}", file=sys.stderr)
        raise SystemExit(1)
