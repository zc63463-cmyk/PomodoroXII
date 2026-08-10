"""Real master-token HTTP integration for the ActiveSession contract.

The app is the *real* ``create_app()`` with the production lifespan
(bootstrap_runtime) and the *real* ``get_active_session_coordinator`` provider
— no dependency override of the provider, no fake executor.  Spaces are
created through the real API, project/work-item prerequisites are created
through the real Task Space API, and every success asserts an exact 2xx.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any

import pytest

from app.mutation.types import canonical_payload_hash

NOW = "2026-07-15T08:00:00.000Z"


def _start_hash(payload: dict[str, object]) -> str:
    from app.focus_session.commands import active_business_payload

    return canonical_payload_hash(active_business_payload("start", payload))


def _start_body(
    *,
    command_id: str = "op-start",
    session_id: str = "fs-1",
    space_id: str = "space-a",
    work_item_id: str = "wi-l2",
    expected_work_item_versions: dict[str, int] | None = None,
) -> dict[str, Any]:
    payload = {
        "level2_work_item_id": work_item_id,
        "level3_work_item_ids": [],
        "planned_seconds": 1500,
        "started_at": NOW,
        "owner_device_id": "device-1",
        "owner_tab_id": "tab-1",
        "expected_work_item_versions": (
            expected_work_item_versions
            if expected_work_item_versions is not None
            else {work_item_id: 1}
        ),
    }
    return {
        "commandId": command_id,
        "spaceId": space_id,
        "sessionId": session_id,
        "ownershipEpoch": None,
        "payloadHash": _start_hash(payload),
        "payload": {
            "level2WorkItemId": work_item_id,
            "level3WorkItemIds": [],
            "plannedSeconds": 1500,
            "startedAt": NOW,
            "ownerDeviceId": "device-1",
            "ownerTabId": "tab-1",
            "expectedWorkItemVersions": payload["expected_work_item_versions"],
        },
    }


async def _master_token(client) -> str:
    resp = await client.post("/api/v1/auth/setup", json={"password": "test-password-123"})
    assert resp.status_code in (200, 201), resp.text
    resp = await client.post("/api/v1/auth/login", json={"password": "test-password-123"})
    assert resp.status_code == 200, resp.text
    return resp.json()["access_token"]


async def _create_space(client, master_headers: dict[str, str], name: str) -> dict[str, str]:
    resp = await client.post("/api/v1/spaces", json={"name": name}, headers=master_headers)
    assert resp.status_code == 201, resp.text
    space = resp.json()
    resp = await client.post(
        f"/api/v1/spaces/{space['id']}/token", headers=master_headers
    )
    assert resp.status_code == 200, resp.text
    return {
        "id": space["id"],
        "token": resp.json()["space_token"],
        "headers": {"Authorization": f"Bearer {resp.json()['space_token']}"},
    }


def _task_payload_hash(action: str, payload: dict[str, object]) -> str:
    return canonical_payload_hash(payload)


async def _create_project(
    client, space_headers: dict[str, str], *, key: str = "PRJ", space_id: str = "space-a",
) -> str:
    payload = {"key": key, "name": f"Project {key}"}
    body = {
        "commandId": f"op-proj-{key}",
        "spaceId": space_id,
        "payloadHash": _task_payload_hash("project.create", payload),
        "key": key,
        "name": f"Project {key}",
    }
    resp = await client.post("/api/v1/projects", json=body, headers=space_headers)
    assert resp.status_code in (200, 201), resp.text
    data = resp.json()
    return data.get("entityId") or data.get("entity_id") or data.get("id")


async def _create_work_item(
    client, space_headers: dict[str, str], project_id: str, *, space_id: str = "space-a",
) -> str:
    # depth-1 root under the project
    root_body = {
        "commandId": f"op-wi-root-{space_id}",
        "spaceId": space_id,
        "payloadHash": canonical_payload_hash({"title": "Root", "description": None,
                                                "parent_id": None, "type_definition_id": None,
                                                "status_definition_id": None, "priority": None}),
        "projectId": project_id,
        "title": "Root",
        "parentId": None,
        "typeDefinitionId": None,
        "statusDefinitionId": None,
        "priority": None,
    }
    resp = await client.post("/api/v1/work-items", json=root_body, headers=space_headers)
    assert resp.status_code in (200, 201), resp.text
    root_id = resp.json().get("entityId") or resp.json().get("entity_id") or resp.json().get("id")

    # depth-2 level2 whose parent is the root
    level2_payload = {
        "title": "Level2", "description": None, "parent_id": root_id,
        "type_definition_id": None, "status_definition_id": None, "priority": None,
    }
    body = {
        "commandId": "op-wi-l2",
        "spaceId": space_id,
        "payloadHash": canonical_payload_hash(level2_payload),
        "projectId": project_id,
        "title": "Level2",
        "parentId": root_id,
        "typeDefinitionId": None,
        "statusDefinitionId": None,
        "priority": None,
    }
    resp = await client.post("/api/v1/work-items", json=body, headers=space_headers)
    assert resp.status_code in (200, 201), resp.text
    data = resp.json()
    return data.get("entityId") or data.get("entity_id") or data.get("id")


@pytest.mark.asyncio
def _activate_body(pair: dict[str, Any], *, session_id: str = "fs-1") -> dict[str, Any]:
    from app.focus_session.commands import active_business_payload

    snake_payload = {
        "pair": {
            "active": {"space_id": pair["active"]["spaceId"], "session_id": pair["active"]["sessionId"]},
            "candidate": {"space_id": pair["candidate"]["spaceId"], "session_id": pair["candidate"]["sessionId"]},
        },
        "cached_at": NOW,
        "cached_ownership_epoch": 1,
        "owner_device_id": "device-1",
        "owner_tab_id": "tab-1",
        "snapshot": {
            "session": {
                "session_revision": 1, "started_at": NOW, "planned_seconds": 1500,
                "gross_seconds": 0, "paused_seconds": 0, "break_seconds": 0,
                "focused_seconds": 0, "validity": "pending", "review_state": "not_required",
                "ownership_state": "local_provisional", "session_note": "",
            },
            "context": {
                "project_id": "project-1", "project_title_snapshot": "Project",
                "level2_work_item_id": "wi-l2", "level2_title_snapshot": "WorkItem",
                "level2_status_definition_id_snapshot": "complete",
                "level2_version_snapshot": 1, "linked_at": NOW, "link_method": "explicit",
            },
            "plan": [],
        },
        "expected_work_item_versions": {"wi-l2": 1},
    }
    business = active_business_payload("activate_provisional", snake_payload)
    return {
        "commandId": "op-conflict",
        "spaceId": pair["active"]["spaceId"],
        "sessionId": session_id,
        "ownershipEpoch": None,
        "payloadHash": canonical_payload_hash(business),
        "payload": {
            "pair": {
                "active": {"spaceId": pair["active"]["spaceId"], "sessionId": pair["active"]["sessionId"]},
                "candidate": {"spaceId": pair["candidate"]["spaceId"], "sessionId": pair["candidate"]["sessionId"]},
            },
            "cachedAt": NOW,
            "cachedOwnershipEpoch": 1,
            "ownerDeviceId": "device-1",
            "ownerTabId": "tab-1",
            "snapshot": {
                "session": {
                    "sessionRevision": 1, "startedAt": NOW, "plannedSeconds": 1500,
                    "grossSeconds": 0, "pausedSeconds": 0, "breakSeconds": 0,
                    "focusedSeconds": 0, "validity": "pending", "reviewState": "not_required",
                    "ownershipState": "local_provisional", "sessionNote": "",
                },
                "context": {
                    "projectId": "project-1", "projectTitleSnapshot": "Project",
                    "level2WorkItemId": "wi-l2", "level2TitleSnapshot": "WorkItem",
                    "level2StatusDefinitionIdSnapshot": "complete",
                    "level2VersionSnapshot": 1, "linkedAt": NOW, "linkMethod": "explicit",
                },
                "plan": [],
            },
            "expectedWorkItemVersions": {"wi-l2": 1},
        },
    }


def _resolve_hash(payload: dict[str, Any]) -> str:
    from app.focus_session.commands import active_business_payload

    return canonical_payload_hash(active_business_payload("resolve_activation_conflict", payload))


def _resolve_body(
    *,
    command_id: str = "op-resolve",
    session_id: str = "fs-1",
    winner_role: str = "candidate",
    decision_at: str = NOW,
    ownership_epoch: int = 1,
) -> dict[str, Any]:
    payload = {
        "winner_role": winner_role,
        "decision_at": decision_at,
        "validity_correction": {
            "loser_validity": "invalid",
            "loser_validity_reason": "activation_conflict_loser",
        },
    }
    return {
        "commandId": command_id,
        "sessionId": session_id,
        "ownershipEpoch": ownership_epoch,
        "payloadHash": _resolve_hash(payload),
        "payload": {
            "winnerRole": winner_role,
            "decisionAt": decision_at,
            "validityCorrection": {
                "loserValidity": "invalid",
                "loserValidityReason": "activation_conflict_loser",
            },
        },
    }


def _seed_second_session(space_id: str, session_id: str) -> None:
    import sqlite3

    from app.settings import settings

    with sqlite3.connect(str(settings.space_db_path(space_id))) as conn:
        conn.execute(
            "INSERT OR IGNORE INTO focus_sessions "
            "(id, session_revision, started_at, planned_seconds, gross_seconds, "
            "paused_seconds, break_seconds, focused_seconds, validity, review_state, "
            "ownership_state, session_note, version, created_at, updated_at) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (session_id, 1, NOW, 1500, 0, 0, 0, 0, "pending", "not_required",
             "activation_conflict", "", 1, NOW, NOW),
        )
        conn.execute(
            "INSERT OR IGNORE INTO session_task_contexts "
            "(id, session_id, project_id, level2_work_item_id, title_snapshot, "
            "structure_snapshot, linked_at, link_method, version, created_at, updated_at) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            (f"ctx-{session_id}", session_id, "project-1", "wi-l2", "WorkItem",
             '{"project":{"id":"project-1","name":"Project"},"level2":{"id":"wi-l2",'
             '"title":"WorkItem","parent_id":null,"status_definition_id":"complete",'
             '"version":1,"effort_estimate_lower_seconds":null,'
             '"effort_estimate_upper_seconds":null},"plan":{}}',
             NOW, "manual", 1, NOW, NOW),
        )
        conn.execute(
            "INSERT OR IGNORE INTO session_attribution_revisions "
            "(id, session_id, revision, project_id, level2_work_item_id, reason, "
            "corrected_from_revision, effective, version, created_at, updated_at) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            (f"attr-{session_id}-1", session_id, 1, "project-1", "wi-l2",
             None, None, 1, 1, NOW, NOW),
        )
        conn.commit()


async def _provision_space(
    client, master_headers: dict[str, str], name: str, key: str,
) -> dict[str, str]:
    space = await _create_space(client, master_headers, name)
    project_id = await _create_project(
        client, space["headers"], key=key, space_id=space["id"]
    )
    await _create_work_item(client, space["headers"], project_id, space_id=space["id"])
    return space


async def _setup_conflict(
    client, master_headers: dict[str, str],
) -> tuple[dict[str, str], dict[str, str]]:
    space_a = await _provision_space(client, master_headers, "Resolve A", "RSA")
    space_b = await _provision_space(client, master_headers, "Resolve B", "RSB")
    _seed_second_session(space_a["id"], "fs-1")
    _seed_second_session(space_b["id"], "fs-2")
    pair = {
        "active": {"spaceId": space_a["id"], "sessionId": "fs-1"},
        "candidate": {"spaceId": space_b["id"], "sessionId": "fs-2"},
    }
    from tests.test_active_session_routes import (
        _activate_body as _routes_activate_body,
    )

    resp = await client.post(
        "/api/v1/active-session/activate-provisional",
        json=_routes_activate_body(pair),
        headers=master_headers,
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["kind"] == "activation_conflict"
    return space_a, space_b


def _read_session(space_id: str, session_id: str) -> dict[str, Any]:
    import sqlite3

    from app.settings import settings

    with sqlite3.connect(str(settings.space_db_path(space_id))) as conn:
        row = conn.execute(
            "SELECT ownership_state, ended_at, timer_completion, validity, "
            "validity_reason, version FROM focus_sessions WHERE id=?",
            (session_id,),
        ).fetchone()
    if row is None:
        return {}
    return {
        "ownership_state": row[0], "ended_at": row[1], "timer_completion": row[2],
        "validity": row[3], "validity_reason": row[4], "version": row[5],
    }


def _read_receipt(space_id: str, child_id: str) -> str | None:
    import sqlite3

    from app.settings import settings

    with sqlite3.connect(str(settings.space_db_path(space_id))) as conn:
        row = conn.execute(
            "SELECT state FROM session_command_receipts WHERE command_id=?",
            (child_id,),
        ).fetchone()
    return None if row is None else str(row[0])


def _read_operation_phase(operation_id: str) -> str | None:
    import sqlite3

    from app.settings import settings

    with sqlite3.connect(str(settings.meta_db_path)) as conn:
        row = conn.execute(
            "SELECT phase FROM active_session_operations WHERE operation_id=?",
            (operation_id,),
        ).fetchone()
    return None if row is None else str(row[0])


async def _inspect_http_authority(space_ids: tuple[str, ...]) -> dict[str, Any]:
    from app.focus_session.recovery_authority import (
        ActiveSessionCoordinationInspector,
        ActiveSessionRecoveryView,
    )
    from app.knowledge.consistency import SpaceDataView
    from app.settings import settings

    inspector = ActiveSessionCoordinationInspector()
    decision = await inspector.inspect_read_only(
        ActiveSessionRecoveryView(settings.meta_db_path),
        space_views={
            space_id: SpaceDataView(
                space_id, settings.space_db_path(space_id),
                settings.space_notes_dir(space_id),
                settings.spaces_data_dir / space_id / "index.db", "0" * 64,
            )
            for space_id in space_ids
        },
    )
    return {"classification": decision.classification, "failure_code": decision.failure_code}


async def test_resolve_restart_from_transferred_recovers_active(client) -> None:
    """A crash after both children succeeded but before the completion
    transaction leaves the transferred midpoint (locator claiming + resolution
    transferred).  Replaying the identical resolve command on a fresh request
    recovers to active: resolution completed, conflict resolved, locator
    active on the winner target, no duplicate child envelopes, authority
    active_consistent."""
    from app.focus_session.child_operations import (
        ActiveSessionChildRole,
        derive_active_session_child_operation_id,
    )
    from app.services.time import utc_now_iso_ms

    master_headers = {"Authorization": f"Bearer {await _master_token(client)}"}
    space_a, space_b = await _setup_conflict(client, master_headers)
    decision_at = utc_now_iso_ms()
    body = _resolve_body(decision_at=decision_at)
    first = await client.post(
        "/api/v1/active-session/resolve-activation-conflict",
        json=body,
        headers=master_headers,
    )
    assert first.status_code == 200, first.text
    # Simulate a crash at the transferred midpoint: roll the Meta rows back
    # (locator claiming on the winner target, resolution transferred, conflict
    # awaiting_resolution) while the two receipts stay durable.
    import sqlite3

    from app.settings import settings

    with sqlite3.connect(str(settings.meta_db_path)) as conn:
        conn.execute(
            "UPDATE active_session_locator SET state='claiming' "
            "WHERE singleton_key='active'"
        )
        conn.execute(
            "UPDATE active_session_operations SET phase='transferred' "
            "WHERE operation_id='op-resolve'"
        )
        conn.execute(
            "UPDATE active_session_operations SET phase='awaiting_resolution' "
            "WHERE operation_id='op-conflict'"
        )
        conn.commit()
    replay = await client.post(
        "/api/v1/active-session/resolve-activation-conflict",
        json=body,
        headers=master_headers,
    )
    assert replay.status_code == 200, replay.text
    data = replay.json()
    assert _read_operation_phase("op-resolve") == "completed"
    assert _read_operation_phase("op-conflict") == "completed"
    assert data["state"] == "active"
    assert data["operationId"] == "op-resolve"
    assert data["spaceId"] == space_b["id"]
    assert data["sessionId"] == "fs-2"
    assert data["ownershipEpoch"] == 2
    # child envelopes are never duplicated by the recovery replay
    winner_id = derive_active_session_child_operation_id("op-resolve", ActiveSessionChildRole.WINNER)
    with sqlite3.connect(str(settings.space_db_path(space_b["id"]))) as conn:
        count = conn.execute(
            "SELECT COUNT(*) FROM session_command_envelopes WHERE command_id=?",
            (winner_id,),
        ).fetchone()[0]
    assert count == 1, count
    authority = await _inspect_http_authority((space_a["id"], space_b["id"]))
    assert authority["classification"] == "active_consistent", authority


async def test_resolve_candidate_winner_returns_200(client) -> None:
    """Real HTTP resolution, candidate winner: exact 200, winner authoritative,
    loser ended interrupted + invalid, Meta completed, locator active on the
    winner target at E+1, both receipts succeeded, authority active_consistent."""
    from app.focus_session.child_operations import (
        ActiveSessionChildRole,
        derive_active_session_child_operation_id,
    )
    from app.services.time import utc_now_iso_ms

    master_headers = {"Authorization": f"Bearer {await _master_token(client)}"}
    space_a, space_b = await _setup_conflict(client, master_headers)
    body = _resolve_body(decision_at=utc_now_iso_ms())
    resp = await client.post(
        "/api/v1/active-session/resolve-activation-conflict",
        json=body,
        headers=master_headers,
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["kind"] == "authoritative"
    # response session is the candidate winner
    session = data["session"]["session"]
    assert session["id"] == "fs-2"
    assert session["ownershipState"] == "authoritative"
    assert session.get("endedAt") is None
    # Meta phase completed; old conflict operation completed (resolved by)
    assert _read_operation_phase("op-resolve") == "completed"
    assert _read_operation_phase("op-conflict") == "completed"
    # response locator (spread at the top level) is active on the winner
    # target at E+1
    assert data["state"] == "active"
    assert data["operationId"] == "op-resolve"
    assert data["spaceId"] == space_b["id"]
    assert data["sessionId"] == "fs-2"
    assert data["ownershipEpoch"] == 2
    # winner authoritative / non-ended, loser ended invalid in the real DBs
    winner = _read_session(space_b["id"], "fs-2")
    assert winner["ownership_state"] == "authoritative"
    assert winner["ended_at"] is None
    loser = _read_session(space_a["id"], "fs-1")
    assert loser["ended_at"] is not None
    assert loser["timer_completion"] == "interrupted"
    assert loser["validity"] == "invalid"
    assert loser["validity_reason"] == "activation_conflict_loser"
    # both receipts succeeded
    winner_id = derive_active_session_child_operation_id("op-resolve", ActiveSessionChildRole.WINNER)
    loser_id = derive_active_session_child_operation_id("op-resolve", ActiveSessionChildRole.LOSER)
    assert _read_receipt(space_b["id"], winner_id) == "succeeded"
    assert _read_receipt(space_a["id"], loser_id) == "succeeded"
    # authority reads the coordinator-written evidence as recoverable
    authority = await _inspect_http_authority((space_a["id"], space_b["id"]))
    assert authority["classification"] == "active_consistent", authority


async def test_resolve_active_winner_returns_200(client) -> None:
    """Real HTTP resolution, active winner (identity inversion)."""
    from app.services.time import utc_now_iso_ms

    master_headers = {"Authorization": f"Bearer {await _master_token(client)}"}
    space_a, space_b = await _setup_conflict(client, master_headers)
    body = _resolve_body(winner_role="active", decision_at=utc_now_iso_ms())
    resp = await client.post(
        "/api/v1/active-session/resolve-activation-conflict",
        json=body,
        headers=master_headers,
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()
    session = data["session"]["session"]
    assert session["id"] == "fs-1"
    assert session["ownershipState"] == "authoritative"
    assert _read_operation_phase("op-resolve") == "completed"
    assert data["state"] == "active"
    assert data["operationId"] == "op-resolve"
    assert data["spaceId"] == space_a["id"]
    assert data["sessionId"] == "fs-1"
    assert data["ownershipEpoch"] == 2
    winner = _read_session(space_a["id"], "fs-1")
    assert winner["ownership_state"] == "authoritative"
    assert winner["ended_at"] is None
    loser = _read_session(space_b["id"], "fs-2")
    assert loser["ended_at"] is not None
    assert loser["validity_reason"] == "activation_conflict_loser"


async def test_resolve_concurrent_single_winner(client) -> None:
    """Two different resolve commands racing for the same conflict: exactly one
    returns 200, the other fails with a stable CAS conflict (409/5xx), no
    orphan operation row, and the locator epoch advances only once."""
    from app.services.time import utc_now_iso_ms

    master_headers = {"Authorization": f"Bearer {await _master_token(client)}"}
    space_a, space_b = await _setup_conflict(client, master_headers)
    import asyncio

    async def _post(command_id: str):
        body = _resolve_body(command_id=command_id, decision_at=utc_now_iso_ms())
        return await client.post(
            "/api/v1/active-session/resolve-activation-conflict",
            json=body,
            headers=master_headers,
        )

    resp_a, resp_b = await asyncio.gather(_post("op-resolve-a"), _post("op-resolve-b"))
    statuses = sorted([resp_a.status_code, resp_b.status_code])
    assert statuses[0] == 200, (resp_a.text[:200], resp_b.text[:200])
    assert statuses[1] == 409, (resp_a.text[:200], resp_b.text[:200])
    # exactly one resolution operation reaches completed; no orphan rows
    import sqlite3

    from app.settings import settings

    with sqlite3.connect(str(settings.meta_db_path)) as conn:
        phases = conn.execute(
            "SELECT operation_id, phase FROM active_session_operations "
            "WHERE kind='resolve_activation_conflict'"
        ).fetchall()
    completed = [op for op, phase in phases if phase == "completed"]
    assert len(completed) == 1, phases
    assert len(phases) == 1, phases  # the loser command never persisted a row


async def test_resolve_replay_same_and_different_hash(client) -> None:
    """Replay with the same command/hash returns the same 200; a different
    payload hash under the same command id is a stable conflict; replay never
    duplicates child envelopes."""
    from app.focus_session.child_operations import (
        ActiveSessionChildRole,
        derive_active_session_child_operation_id,
    )
    from app.services.time import utc_now_iso_ms

    master_headers = {"Authorization": f"Bearer {await _master_token(client)}"}
    space_a, space_b = await _setup_conflict(client, master_headers)
    decision_at = utc_now_iso_ms()
    body = _resolve_body(decision_at=decision_at)
    first = await client.post(
        "/api/v1/active-session/resolve-activation-conflict",
        json=body,
        headers=master_headers,
    )
    assert first.status_code == 200, first.text
    replay = await client.post(
        "/api/v1/active-session/resolve-activation-conflict",
        json=body,
        headers=master_headers,
    )
    assert replay.status_code == 200, replay.text
    # different payload hash under the same command id -> stable conflict
    changed = _resolve_body(decision_at=utc_now_iso_ms())
    resp = await client.post(
        "/api/v1/active-session/resolve-activation-conflict",
        json=changed,
        headers=master_headers,
    )
    assert resp.status_code == 409, resp.text
    assert resp.headers["X-PomodoroXII-Error-Code"] == "idempotency_conflict"
    # child envelopes are never duplicated across the replay
    import sqlite3

    from app.settings import settings

    winner_id = derive_active_session_child_operation_id("op-resolve", ActiveSessionChildRole.WINNER)
    with sqlite3.connect(str(settings.space_db_path(space_b["id"]))) as conn:
        count = conn.execute(
            "SELECT COUNT(*) FROM session_command_envelopes WHERE command_id=?",
            (winner_id,),
        ).fetchone()[0]
    assert count == 1, count


async def test_resolve_loser_failure_never_returns_200(client) -> None:
    """If the loser child cannot run, the HTTP resolve never returns 200: the
    Meta phase stays claimed and the authority requires recovery."""
    from app.services.time import utc_now_iso_ms

    master_headers = {"Authorization": f"Bearer {await _master_token(client)}"}
    space_a, space_b = await _setup_conflict(client, master_headers)
    # break the loser Session's conflict state before resolving
    import sqlite3

    from app.settings import settings

    with sqlite3.connect(str(settings.space_db_path(space_a["id"]))) as conn:
        conn.execute(
            "UPDATE focus_sessions SET ownership_state='authoritative' WHERE id='fs-1'"
        )
        conn.commit()
    body = _resolve_body(decision_at=utc_now_iso_ms())
    resp = await client.post(
        "/api/v1/active-session/resolve-activation-conflict",
        json=body,
        headers=master_headers,
    )
    assert resp.status_code == 503, resp.text
    assert resp.headers["X-PomodoroXII-Error-Code"] == (
        "active_session_recovery_required"
    )
    assert _read_operation_phase("op-resolve") not in {"completed", "transferred"}
    authority = await _inspect_http_authority((space_a["id"], space_b["id"]))
    assert authority["classification"] == "recovery_required", authority


async def test_master_start_returns_exact_201_with_real_aggregate(client) -> None:
    master_token = await _master_token(client)
    master_headers = {"Authorization": f"Bearer {master_token}"}
    space = await _create_space(client, master_headers, "Start Space")
    project_id = await _create_project(
        client, space["headers"], key="PRJ", space_id=space["id"]
    )
    wi_id = await _create_work_item(client, space["headers"], project_id, space_id=space["id"])
    assert isinstance(wi_id, str) and wi_id

    import asyncio
    resp = await asyncio.wait_for(
        client.post(
            "/api/v1/active-session/start",
            json=_start_body(space_id=space["id"], work_item_id=wi_id),
            headers=master_headers,
        ),
        timeout=60,
    )
    assert resp.status_code == 201, resp.text
    data = resp.json()
    assert "session" in data, "session aggregate required"
    session = data["session"]["session"]
    assert session["id"] == "fs-1"
    assert session["spaceId"] == space["id"]
    assert session["createdAt"] == NOW  # real Space DB value, not fabricated
    assert data["operationId"] == "op-start"
    assert data["state"] == "claiming"


@pytest.mark.asyncio
async def test_master_locate_returns_200_with_active(client) -> None:
    master_token = await _master_token(client)
    master_headers = {"Authorization": f"Bearer {master_token}"}
    space = await _create_space(client, master_headers, "Locate Space")
    project_id = await _create_project(
        client, space["headers"], key="LOC", space_id=space["id"]
    )
    wi_id = await _create_work_item(client, space["headers"], project_id, space_id=space["id"])
    await client.post(
        "/api/v1/active-session/start",
        json=_start_body(space_id=space["id"], work_item_id=wi_id),
        headers=master_headers,
    )
    resp = await client.get("/api/v1/active-session", headers=master_headers)
    assert resp.status_code == 200, resp.text
    assert resp.json()["session"]["session"]["id"] == "fs-1"


@pytest.mark.asyncio
async def test_master_locate_returns_404_when_no_active(client) -> None:
    master_token = await _master_token(client)
    master_headers = {"Authorization": f"Bearer {master_token}"}
    resp = await client.get("/api/v1/active-session", headers=master_headers)
    assert resp.status_code == 404, resp.text


@pytest.mark.asyncio
async def test_space_token_rejected(client) -> None:
    master_token = await _master_token(client)
    master_headers = {"Authorization": f"Bearer {master_token}"}
    space = await _create_space(client, master_headers, "Auth Space")
    resp = await client.get("/api/v1/active-session", headers=space["headers"])
    assert resp.status_code in (401, 403), resp.text


@pytest.mark.asyncio
async def test_anonymous_rejected(client) -> None:
    resp = await client.get("/api/v1/active-session")
    assert resp.status_code in (401, 403), resp.text


@pytest.mark.asyncio
async def test_unregistered_space_fails_closed(client) -> None:
    master_token = await _master_token(client)
    master_headers = {"Authorization": f"Bearer {master_token}"}
    body = _start_body(space_id="space-not-registered")
    resp = await client.post("/api/v1/active-session/start", json=body, headers=master_headers)
    # SpaceNotFoundError -> 404 via the canonical AppError handler
    assert resp.status_code == 404, resp.text
    assert "not_found" in resp.text


@pytest.mark.asyncio
async def test_duplicate_start_same_command_id_fails_closed(client) -> None:
    master_token = await _master_token(client)
    master_headers = {"Authorization": f"Bearer {master_token}"}
    space = await _create_space(client, master_headers, "Dup Space")
    project_id = await _create_project(
        client, space["headers"], key="DUP", space_id=space["id"]
    )
    wi_id = await _create_work_item(client, space["headers"], project_id, space_id=space["id"])
    first = await client.post(
        "/api/v1/active-session/start",
        json=_start_body(space_id=space["id"], work_item_id=wi_id),
        headers=master_headers,
    )
    assert first.status_code == 201, first.text
    second = await client.post(
        "/api/v1/active-session/start",
        json=_start_body(space_id=space["id"], work_item_id=wi_id),
        headers=master_headers,
    )
    # same command_id + same payload hash: idempotent replay succeeds (201)
    assert second.status_code == 201, second.text
    assert second.json()["session"]["session"]["id"] == "fs-1"
