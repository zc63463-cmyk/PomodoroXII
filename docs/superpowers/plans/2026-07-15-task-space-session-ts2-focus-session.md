# Task Space + FocusSession TS2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the authoritative FocusSession lifecycle, append-only review history, immutable task-command reconciliation, one-active-Session coordination, and offline activation conflict flow defined by the approved Task Space + FocusSession design.

**Architecture:** TS2 implements exactly the TS0 `FocusSessionModule` and `ActiveSessionCoordinator` Protocols from `app.focus_session.contracts`. Master-scoped `/api/v1/active-session` is the only public running-lifecycle surface; its Coordinator authorizes and opens the owning Space, then calls `FocusSessionModule`. Space-scoped `/api/v1/focus-sessions` exposes only historical read, review, and command reconciliation. FocusSession writes use the existing S3 `MutationUnitOfWork` and registered `MutationDomainPolicy`; Meta `ActiveSessionLocator` coordinates recoverable `claiming -> active -> releasing` operations without claiming a cross-database transaction.

**Tech Stack:** Python 3.13, FastAPI, Pydantic v2, SQLAlchemy 2 async, SQLite, S2 authorized Space runtime, S3 `MutationUnitOfWork`, TS0 ORM/schema/contracts, TS1 Task Space module, pytest/pytest-asyncio, Ruff, OpenAPI.

## Global Constraints

- The approved authority is `docs/superpowers/specs/2026-07-15-task-space-session-integration-design.md`. S3, TS0, and TS1 are hard prerequisites and are consumed at their approved heads.
- The only FocusSession contract import is `app.focus_session.contracts`. TS2 does not create a parallel command, outcome, router, or public provider family.
- The exact TS0 Protocol method sets are `FocusSessionModule.get/start/pause/resume/end/update_note/set_current_plan_item/set_completion_draft/add_plan_item/remove_plan_item/submit_review/reconcile_commands` and `ActiveSessionCoordinator.locate/start/activate_provisional/heartbeat/pause/resume/takeover/end/update_note/set_current_plan_item/set_completion_draft/add_plan_item/remove_plan_item/resolve_activation_conflict`.
- Session history vocabulary comes only from TS0: Plan source is `before_start|during_session|review_materialized`, Outcome result is `completed|progressed|stuck|untouched|cancelled`, state command is `complete|cancel|none`, and persona/progress/mood use the exact TS0 enums. TS2 creates no aliases such as `start|running`, `not_touched|blocked`, or `start_progress`.
- `ActiveSessionCommand.space_id` is `str | None` and serializes as wire `spaceId`. Start and provisional activation require a nonempty `space_id` and require `ownership_epoch is None`; a master token has no implicit current Space. Locator-bound actions reject caller-selected `space_id` and derive the owner from Meta.
- Public start, heartbeat, pause, resume, takeover, end, owner-bound Session note/running-plan changes, and conflict resolution exist only below master-scoped `/api/v1/active-session`. No Space-scoped route may expose those running mutations.
- Space-scoped `/api/v1/focus-sessions` exposes exactly `GET /{session_id}`, `POST /{session_id}/review`, and `POST /{session_id}/commands/reconcile`.
- The Coordinator opens a Space only through `AuthorizedSpaceScope.open(principal, space_id, mode="read" | "write")`; it receives no path, database target, or caller-created runtime handle.
- The Coordinator calls only the public `FocusSessionModule` methods. It does not construct a UoW, call the FocusSession policy, or depend on concrete Module-private lifecycle methods.
- Python contract fields and the canonical command business payload passed to S3 hash helpers use transport-neutral snake_case top-level keys. Every HTTP envelope and operation payload is camelCase; each TS0 operation-specific Pydantic schema/Adapter explicitly maps its named fields before hash verification and generic-command construction. There is no generic recursive casing converter. Nested WorkItemNote document content keeps its version-1 camelCase aliases as domain values. OpenAPI and response mappings in `FocusSessionView.value` and `ActiveSessionView.value` remain camelCase.
- `clock_state` is never an ORM column, migration field, command payload field, journal field, or Sync post-image field. `clockState` is derived for a view from `started_at`, `pause_started_at`, and `ended_at`.
- Every external command verifies its declared payload hash with S3 `require_payload_hash` before authorization, locator reads, runtime open, UoW entry, journal lookup, or business write. Server-authored child commands use S3 `canonical_payload_hash` over their exact business payload.
- `MutationRequest.request_hash` remains S3's complete internal request identity. TS2 never accepts it from a client, returns it as `payloadHash`, or substitutes it for `canonical_payload_hash`/`require_payload_hash`.
- S3 `MutationUnitOfWork.execute(scope, request, operation_id)` remains unchanged and owns Space-exclusive acquisition, recovery-before-compile, journal persistence, fencing, commit, and final visibility. TS2 does not add a second execution path.
- `FocusSessionMutationPolicy` owns all five TS0 Session business entity keys: `focus_session`, `session_task_context`, `session_attribution_revision`, `session_work_item_plan`, and `session_work_item_outcome`. S4 `EntityCommand.from_sync_event()` must enter this policy for create/update/delete; none may fall through S3 generic CRUD.
- Session persistence and immutable command envelopes commit before Task Space dispatch. Note failure or one task-command failure cannot roll back time, review, another receipt, or another successful command.
- `work_items.effort_actual_seconds` is the materialized level-2 EffortProjection. Its only writer is `FocusSessionMutationPolicy`, which recomputes from valid terminal Session facts plus the one effective attribution revision in the same S3 UoW; Task Space, REST, and S4 entity input cannot assign it.
- `ActiveSessionLocator` remains the sole global locator, while TS0 `ActiveSessionOperation` is the internal Meta intent/phase journal. The locator states are exactly `claiming`, `active`, and `releasing` and store routing/operation/owner fields only. `ActiveSessionCoordinationStore` changes the locator plus its operation row in one Meta transaction. Every owner-sensitive Space mutation first reserves `active -> claiming` with the same operation ID, so takeover cannot cross the interval between policy validation and Space commit.
- All operation IDs are stable ASCII IDs of at most 128 bytes. Every envelope, receipt, conflict, ownership, and recovery child calls S3 `bounded_child_operation_id(parent_id, suffix)`; no TS2 string concatenation may overflow a valid 128-byte parent. Recovery reuses the original operation ID or that persisted deterministic child ID and never invents a new semantic command after an unknown outcome.
- TS2 is backend-only. Dexie, Zustand, Timer UI, cross-Tab presentation, final Sync/MCP convergence, and final 95+ certification remain TS3-S6 work.
- Run backend commands from the active checkout's repository-relative `backend/` directory and add `-p no:cacheprovider` to every pytest invocation. No command may embed a developer-machine absolute checkout path.

## File Map

### Inputs Consumed Without Modification

- `backend/app/focus_session/contracts.py`: TS0 enums, `FocusSessionCommand`, `ActiveSessionCommand`, views, and the two generic Protocols.
- `backend/app/models/focus_session.py`: `FocusSession` and immutable `SessionTaskContext`.
- `backend/app/models/session_revision.py`: attribution, plan, and outcome revisions.
- `backend/app/models/session_command.py`: immutable command envelopes and one current receipt per envelope.
- `backend/app/db/models/meta.py`: TS0 `ActiveSessionLocator` singleton row.
- `backend/app/schemas/focus_session.py`: strict camelCase request/response schemas.
- `backend/app/routes/v1/focus_sessions.py`: TS0 Space-scoped history/review/reconciliation Adapter.
- `backend/app/routes/v1/active_session.py`: TS0 master-scoped Coordinator Adapter.
- `backend/app/mutation/types.py`: `MutationRequest`, `MutationCommand`, `MutationRuleViolation`, `canonical_payload_hash`, and `require_payload_hash`.
- `backend/app/mutation/unit_of_work.py`: `MutationCompileContext`, `MutationDomainPolicy`, `MutationCompiler`, and `MutationUnitOfWork`.
- `backend/app/task_space/contracts.py`: TS1 `MutateWorkItem`, outcomes, and `TaskSpaceCommandModule`.
- `backend/app/task_space/compiler.py`: TS1 `TaskSpaceCompiler`, which remains installed.

### TS2 Files Created

- `backend/app/focus_session/commands.py`: closed action names, exact caller-business-payload extraction, hash verification, and S3 request construction from `FocusSessionCommand`.
- `backend/app/focus_session/policy.py`: registered S3 policy for lifecycle, review/revisions, provisional activation, and receipt writes.
- `backend/app/focus_session/query.py`: explicit row-to-camelCase aggregate projection for historical reads; no write authority.
- `backend/app/focus_session/effort_projection.py`: sole derived level-2 actual-effort recomputation, verification, and rebuild helper.
- `backend/app/focus_session/module.py`: exact concrete `FocusSessionModule` implementation and camelCase view projection.
- `backend/app/focus_session/command_reconciler.py`: immutable envelope dispatch, stored-outcome lookup, query-original-first retry, and receipt recording.
- `backend/app/focus_session/coordinator.py`: exact `ActiveSessionCoordinator`, one `ActiveSessionCoordinationStore` for locator+operation transactions, and conditional Meta transitions.
- `backend/app/focus_session/recovery.py`: startup/request recovery for locator operations and restored ambiguity.
- `backend/tests/test_focus_session_hash_contract.py`
- `backend/tests/test_focus_session_policy.py`
- `backend/tests/test_focus_session_sync_policy.py`
- `backend/tests/test_focus_session_module.py`
- `backend/tests/test_focus_session_revisions.py`
- `backend/tests/test_session_command_reconciliation.py`
- `backend/tests/test_active_session_coordinator.py`
- `backend/tests/test_active_session_recovery.py`
- `backend/tests/test_offline_session_activation.py`
- `backend/tests/test_focus_session_routes.py`
- `backend/tests/test_active_session_routes.py`

### Existing Files Modified By TS2

- `backend/app/deps.py`: retain `TaskSpaceCompiler` and append `FocusSessionMutationPolicy` in the one S3 compiler provider.
- `backend/app/routes/v1/contract_dependencies.py`: replace only the TS0 FocusSession and active-session sentinel providers.
- `backend/app/routes/v1/__init__.py`: mount the final TS0 routers.
- `backend/app/runtime/bootstrap.py`: construct one locator+operation coordination store, Module, receipt lookup, recovery service, then Coordinator before readiness.
- `backend/tests/test_openapi_contract.py`: exact path, scope, and camelCase assertions.
- `backend/tests/test_runtime_bootstrap.py`: one composition graph and recovery ordering.
- `frontend/src/types/api-generated.ts`: generated OpenAPI output only.

---

### Task 1: Lock The Generic Commands And Payload-Hash Boundary

**Files:**
- Create: `backend/app/focus_session/commands.py`
- Create: `backend/tests/test_focus_session_hash_contract.py`
- Create: `backend/tests/test_focus_session_policy.py`

**Interfaces:**
- Consumes: TS0 `FocusSessionCommand`; S3 `MutationRequest.from_payload`, `canonical_payload_hash`, `require_payload_hash`, and `validate_expected_version`.
- Produces: `focus_business_payload(action, payload)`, `active_business_payload(action, payload)`, `build_focus_request(action, command)`, and `build_server_focus_command(...)` without defining another public command type.

- [ ] **Step 1: Write the failing Protocol and import-boundary test**

```python
# backend/tests/test_focus_session_hash_contract.py
from app.focus_session.contracts import (
    ActiveSessionCoordinator,
    FocusSessionCommand,
    FocusSessionModule,
)


def public_methods(protocol: type) -> set[str]:
    return {
        name
        for name, value in protocol.__dict__.items()
        if callable(value) and not name.startswith("_")
    }


def test_ts2_consumes_the_exact_ts0_protocol_surface() -> None:
    assert public_methods(FocusSessionModule) == {
        "get", "start", "pause", "resume", "end",
        "update_note", "set_current_plan_item", "set_completion_draft",
        "add_plan_item", "remove_plan_item", "submit_review",
        "reconcile_commands",
    }
    assert public_methods(ActiveSessionCoordinator) == {
        "locate", "start", "activate_provisional", "heartbeat",
        "pause", "resume", "takeover", "end",
        "update_note", "set_current_plan_item", "set_completion_draft",
        "add_plan_item", "remove_plan_item", "resolve_activation_conflict",
    }
    assert FocusSessionCommand.__module__ == "app.focus_session.contracts"
```

Add an AST assertion over `app/focus_session/{commands,policy,module,coordinator,recovery}.py` that permits FocusSession contract imports only from `app.focus_session.contracts` and rejects any second class named `FocusSessionCommand`, `ActiveSessionCommand`, `FocusSessionModule`, or `ActiveSessionCoordinator`.

- [ ] **Step 2: Write hash-precedence and canonical-vector tests**

```python
import pytest

from app.focus_session.commands import (
    build_focus_request,
    build_server_focus_command,
    focus_business_payload,
)
from app.focus_session.contracts import FocusSessionCommand
from app.mutation.types import InvalidPayloadHashError, canonical_payload_hash


def start_command(*, declared: str) -> FocusSessionCommand:
    return FocusSessionCommand(
        command_id="start-1",
        space_id="space-a",
        session_id="fs-1",
        ownership_epoch=1,
        payload_hash=declared,
        payload={
            "level2_work_item_id": "l2-a",
            "level3_work_item_ids": ("l3-a",),
            "planned_seconds": 1500,
            "started_at": "2026-07-15T08:00:00Z",
            "owner_device_id": "device-a",
            "owner_tab_id": "tab-a",
            "expected_work_item_versions": {"l2-a": 4, "l3-a": 2},
        },
    )


def test_caller_hash_covers_business_payload_not_cas_or_request_identity() -> None:
    raw = start_command(declared="0" * 64)
    business = focus_business_payload("start", raw.payload)
    command = start_command(declared=canonical_payload_hash(business))
    request = build_focus_request("start", command)

    assert "expected_work_item_versions" not in business
    assert request.payload["payload_hash"] == command.payload_hash
    assert request.request_hash != command.payload_hash


@pytest.mark.asyncio
async def test_invalid_payload_hash_fails_before_any_scope_or_uow_call(
    focus_module_fixture,
) -> None:
    command = start_command(declared="0" * 64)
    with pytest.raises(InvalidPayloadHashError):
        await focus_module_fixture.module.start(
            focus_module_fixture.poison_scope, command
        )
    assert focus_module_fixture.uow_calls == []
    assert focus_module_fixture.locator_reads == 0


@pytest.mark.parametrize(
    "action",
    ("mark_activation_conflict", "resolve_activation_conflict", "claim_owner"),
)
def test_server_authored_hash_excludes_cas_and_epoch_guards(action: str) -> None:
    common = {
        "decision": "preserve",
        "expected_ownership_epoch": 7,
    }
    first = build_server_focus_command(
        command_id=f"{action}-1",
        space_id="space-a",
        session_id="fs-1",
        ownership_epoch=7,
        action=action,
        payload={**common, "expected_version": 2},
    )
    second = build_server_focus_command(
        command_id=f"{action}-1",
        space_id="space-a",
        session_id="fs-1",
        ownership_epoch=7,
        action=action,
        payload={
            **common,
            "expected_version": 9,
            "expected_ownership_epoch": 9,
        },
    )

    assert first.payload_hash == second.payload_hash
    assert build_focus_request(action, first).request_hash != (
        build_focus_request(action, second).request_hash
    )
```

The closed hash shapes are:

| Action | Hashed business fields | Excluded identity/CAS fields |
|---|---|---|
| `start` | level-2 ID, ordered level-3 IDs, planned seconds, start timestamp, owner device/tab | command ID, Space/session IDs, ownership epoch, expected WorkItem versions |
| `pause` / `resume` | occurrence timestamp and current owner device/tab | command ID, Space/session IDs, ownership epoch, expected Session version |
| `end` | occurrence timestamp, timer completion, validity, validity reason, and current owner device/tab | command ID, Space/session IDs, ownership epoch, expected Session version |
| `update_note` | Session note and current owner device/tab | command ID, Space/session IDs, ownership epoch, expected Session version |
| `set_current_plan_item` | selected WorkItem ID or null and current owner device/tab | command ID, Space/session IDs, ownership epoch, expected Plan versions |
| `set_completion_draft` | Plan item ID, draft Boolean, and current owner device/tab | command ID, Space/session IDs, ownership epoch, expected Plan version |
| `add_plan_item` | WorkItem ID, rank, add timestamp, and current owner device/tab | command ID, Space/session IDs, ownership epoch, expected WorkItem version |
| `remove_plan_item` | Plan item ID, removal timestamp/reason, and current owner device/tab | command ID, Space/session IDs, ownership epoch, expected Plan version |
| `submit_review` | validity, review state, reviewed timestamp, ordered outcomes without expected versions | envelope IDs, Space/session IDs, ownership epoch, Session/WorkItem expected versions |
| `reconcile_commands` | ordered selected command IDs, explicit replay decision, ordered abandonment subset, and canonical decision timestamp | command ID and Space/session IDs; no Session CAS |
| `activate_provisional` | cached timestamp and frozen Session/WorkItem facts | command ID, Space/session IDs, cached ownership epoch, expected versions |
| `heartbeat` | owner device/tab and heartbeat timestamp | command ID, locator-derived Space/session IDs, ownership epoch |
| `takeover` | new owner device/tab | command ID, locator-derived Space/session IDs, expected ownership epoch |
| `resolve_activation_conflict` | persisted-pair winner role and explicit correction decision | command ID, all Session/Space identities, expected ownership epoch |
| server-authored conflict/owner actions | exact decision/correction fields | operation selector, all CAS versions, all ownership/cached epochs |

The TS0 Adapter uses this closed wire-to-command mapping before hashing:

| Action | camelCase fields inside wire `payload` | snake_case command payload; guards excluded from hash |
|---|---|---|
| start | `level2WorkItemId`, `level3WorkItemIds`, `plannedSeconds`, `startedAt`, `ownerDeviceId`, `ownerTabId`, `expectedWorkItemVersions` | corresponding snake_case keys; exclude `expected_work_item_versions` |
| heartbeat | `ownerDeviceId`, `ownerTabId`, `heartbeatAt` | `owner_device_id`, `owner_tab_id`, `heartbeat_at`; all are business fields |
| pause/resume | `expectedVersion`, `occurredAt`, `ownerDeviceId`, `ownerTabId` | `expected_version`, `occurred_at`, `owner_device_id`, `owner_tab_id`; exclude `expected_version` only |
| end | `expectedVersion`, `occurredAt`, `timerCompletion`, `validity`, `validityReason`, `ownerDeviceId`, `ownerTabId` | snake_case equivalents; exclude `expected_version` only |
| note | `expectedVersion`, `sessionNote`, `ownerDeviceId`, `ownerTabId` | `expected_version`, `session_note`, `owner_device_id`, `owner_tab_id`; exclude `expected_version` only |
| plan current | `workItemId`, `expectedPlanVersions`, `ownerDeviceId`, `ownerTabId` | snake_case equivalents; exclude `expected_plan_versions` only |
| completion draft | `planItemId`, `expectedPlanVersion`, `completionDraft`, owner device/tab | snake_case equivalents; exclude `expected_plan_version` only |
| plan add | `workItemId`, `expectedWorkItemVersion`, `planRank`, `addedAt`, owner device/tab | snake_case equivalents; exclude `expected_work_item_version` only |
| plan remove | `planItemId`, `expectedPlanVersion`, `removedAt`, `removalReason`, owner device/tab | snake_case equivalents; exclude `expected_plan_version` only |
| takeover | `newOwnerDeviceId`, `newOwnerTabId` | `new_owner_device_id`, `new_owner_tab_id`; both hashed |
| resolve | `winnerRole: "active"|"candidate"`, `decisionAt`, strict `validityCorrection = {loserValidity: "invalid", loserValidityReason: "activation_conflict_loser"}` | `winner_role`, `decision_at`, and correction are hashed; candidate identities come only from persisted conflict intent; no Session/Space selector |
| review | `expectedVersion`, `validity`, `reviewState`, `reviewedAt`; each ordered Outcome has `workItemId`, `touched`, `result`, optional `executionPersona`/`personaSwitched`/`personaNote`, `stateCommand`, and `expectedWorkItemVersion` | explicit review/Outcome mapper produces every snake_case equivalent; exclude top-level `expected_version` and each nested `expected_work_item_version` only |
| reconcile | `commandIds`, `replaySafe`, `abandonCommandIds`, `decisionAt` | explicit snake_case fields all hashed; abandonment IDs are a unique subset and require the timestamp; no `expectedVersion` field |
| activate provisional | `cachedAt`, `cachedOwnershipEpoch`, owner device/tab, strict `snapshot = {session, context, plan}`, `expectedWorkItemVersions` | recursively explicit snake_case snapshot; exclude cached epoch and expected-version map only |

Root `commandId`, `spaceId`, `sessionId`, `ownershipEpoch`, and `payloadHash` never enter the business payload hash. Each action uses an explicit named-field mapper; WorkItemNote document values pass through their TS0 content-v1 model without key rewriting.

The shared golden review vectors contain every required and optional Outcome
field from the table. Independently changing `touched`, `result`, persona,
persona-switch flag, persona note, state command, Outcome order, validity,
review state, or review timestamp changes the hash. Changing only the top-level
Session expected version or a nested WorkItem expected version does not change
the hash but still changes CAS validation. Unknown Outcome fields fail the TS0
schema rather than being silently included or discarded.

For the two cross-Space operations, TS0's generated schemas are the sole wire
authority. `ActivateProvisionalPayload` contains:

```text
cachedAt
cachedOwnershipEpoch?
ownerDeviceId
ownerTabId
snapshot.session
  sessionRevision, startedAt, pauseStartedAt?
  plannedSeconds, grossSeconds, pausedSeconds, breakSeconds, focusedSeconds
  validity="pending", validityReason?, reviewState="not_required"
  ownershipState="local_provisional", sessionNote
snapshot.context
  projectId, projectTitleSnapshot, level2WorkItemId, level2TitleSnapshot
  level2ParentIdSnapshot?, level2StatusDefinitionIdSnapshot
  level2VersionSnapshot, level2EffortLowerSecondsSnapshot?
  level2EffortUpperSecondsSnapshot?, linkedAt, linkMethod
snapshot.plan[]
  id, workItemId, titleSnapshot, level2WorkItemIdSnapshot
  workItemVersionSnapshot, planRank, source, addedAt, removedAt?
  removalReason?, currentDuringSession, completionDraft
expectedWorkItemVersions
```

The command payload stores these same fields with explicit snake_case names.
The business-hash builder drops only `cached_ownership_epoch` and
`expected_work_item_versions`; nested version snapshots remain hashed because
they are immutable history facts. It does not drop owner identity or any other
snapshot field. The expected-version map must exactly equal the Context L2 and
all Plan WorkItem snapshot versions before Space open or UoW entry.

`ResolveActivationConflictPayload.winnerRole` is the only caller decision and
selects `active` or `candidate` from the exact persisted conflict pair; it never
selects by Session ID or Space. `validityCorrection` is the TS0 closed object,
not a scalar or arbitrary JSON. P0 preserves raw duration counters in both
Sessions, leaves the continuing winner pending until its normal end decision,
ends the loser as `interrupted`, and marks only the loser `invalid` with reason
`activation_conflict_loser`. Therefore conflict resolution cannot manufacture
a duration rewrite. A future time-correction mode requires a versioned schema,
new hash vectors, and a migration; it cannot widen this v1 object in place.

Add golden Adapter tests that parse the TS0 camelCase models, assert the exact
snake_case command payloads, and compare RFC 8785 SHA-256 vectors. Mutating a
snapshot title, timestamp, duration, owner, Plan order, or correction field
must change the hash. Mutating only cached ownership epoch or the
expected-version map must not; the changed guard must still affect validation.
Extra/missing nested fields, scalar `validityCorrection`, a terminal Session
field, or a bool/float version must fail schema parsing before either
Coordinator method is called.

`review_materialized` remains a reserved final history enum but P0 has no
producer for it. The nonterminal provisional snapshot schema accepts only
`before_start|during_session`; TS2 activation and S4 provisional import reject
`review_materialized` before Meta claim or business effects.

- [ ] **Step 3: Implement exact business-payload extraction and request construction**

```python
# backend/app/focus_session/commands.py
from __future__ import annotations

from collections.abc import Mapping

from app.focus_session.contracts import FocusSessionCommand
from app.mutation.types import (
    MutationRequest,
    bounded_child_operation_id,
    canonical_payload_hash,
    require_payload_hash,
    validate_expected_version,
    validate_operation_id,
)


ACTIONS = frozenset({
    "start", "pause", "resume", "end", "update_note", "submit_review",
    "reconcile_commands",
    "correct_attribution", "set_current_plan_item",
    "set_completion_draft", "add_plan_item", "remove_plan_item",
    "activate_provisional", "mark_activation_conflict",
    "resolve_activation_conflict", "claim_owner", "record_receipt",
    "rebuild_effort_projection",
})


def _without(mapping: Mapping[str, object], *keys: str) -> dict[str, object]:
    excluded = frozenset(keys)
    return {key: value for key, value in mapping.items() if key not in excluded}


HASH_GUARD_FIELDS = (
    "operation",
    "expected_version",
    "expected_work_item_versions",
    "expected_work_item_version",
    "expected_plan_version",
    "expected_plan_versions",
    "expected_source_work_item_version",
    "ownership_epoch",
    "expected_ownership_epoch",
    "cached_ownership_epoch",
)
RECEIPT_RESERVATION_STATES = (
    "not_needed", "pending", "succeeded", "failed", "conflict", "unknown",
)


def focus_business_payload(
    action: str, payload: Mapping[str, object]
) -> Mapping[str, object]:
    if action not in ACTIONS:
        raise ValueError(f"unsupported FocusSession action: {action}")
    payload = _without(payload, *HASH_GUARD_FIELDS)
    if action == "submit_review":
        cleaned = dict(payload)
        outcomes = cleaned.get("outcomes", ())
        if not isinstance(outcomes, (tuple, list)):
            return cleaned
        cleaned["outcomes"] = tuple(
            _without(item, "expected_work_item_version")
            if isinstance(item, Mapping) else item
            for item in outcomes
        )
        return cleaned
    return dict(payload)


def active_business_payload(
    action: str, payload: Mapping[str, object]
) -> Mapping[str, object]:
    if action in {
        "start", "pause", "resume", "end", "update_note",
        "set_current_plan_item", "set_completion_draft", "add_plan_item",
        "remove_plan_item", "activate_provisional",
    }:
        return focus_business_payload(action, payload)
    if action in {"heartbeat", "takeover", "resolve_activation_conflict"}:
        return _without(payload, *HASH_GUARD_FIELDS)
    raise ValueError(f"unsupported active Session action: {action}")


def build_focus_request(
    action: str, command: FocusSessionCommand
) -> MutationRequest:
    business = focus_business_payload(action, command.payload)
    require_payload_hash(command.payload_hash, business)
    expected_version = command.payload.get("expected_version")
    validate_expected_version(expected_version)
    return MutationRequest.from_payload(
        name=f"focus_session.{action}",
        entity_type="focus_session",
        entity_id=command.session_id or command.command_id,
        payload={
            **dict(command.payload),
            "action": action,
            "command_id": command.command_id,
            "space_id": command.space_id,
            "session_id": command.session_id,
            "ownership_epoch": command.ownership_epoch,
            "payload_hash": command.payload_hash,
        },
        expected_version=expected_version,
        client_updated_at=None,
    )


def validate_reconcile_shape(command: FocusSessionCommand) -> None:
    if command.ownership_epoch is not None:
        raise ValueError("post-terminal reconciliation requires no owner epoch")
    command_ids = command.payload.get("command_ids", ())
    if not isinstance(command_ids, (tuple, list)) or any(
        not isinstance(item, str) or not item for item in command_ids
    ):
        raise ValueError("command_ids must be an ordered string collection")
    if not isinstance(command.payload.get("replay_safe"), bool):
        raise ValueError("replay_safe must be a boolean")
    abandon_ids = command.payload.get("abandon_command_ids", ())
    if not isinstance(abandon_ids, (tuple, list)) or any(
        not isinstance(item, str) or not item for item in abandon_ids
    ):
        raise ValueError("abandon_command_ids must be an ordered string collection")
    if len(set(command_ids)) != len(command_ids) or len(set(abandon_ids)) != len(abandon_ids):
        raise ValueError("reconciliation command IDs must be unique")
    if not set(abandon_ids) <= set(command_ids):
        raise ValueError("abandon_command_ids must be a command_ids subset")
    decision_at = command.payload.get("decision_at")
    if bool(abandon_ids) != isinstance(decision_at, str):
        raise ValueError("decision_at is required exactly for abandonment")
    validate_operation_id(command.command_id)
    for operation_id in (*command_ids, *abandon_ids):
        validate_operation_id(operation_id)
    reserved_receipt_ids = tuple(
        bounded_child_operation_id(envelope_id, f"receipt:{state}")
        for envelope_id in command_ids
        for state in RECEIPT_RESERVATION_STATES
    )
    root_scoped_receipt_ids = tuple(
        bounded_child_operation_id(
            command.command_id, f"receipt:{envelope_id}:{state}"
        )
        for envelope_id in command_ids
        for state in RECEIPT_RESERVATION_STATES
    )
    operation_namespace = (
        command.command_id, *command_ids, *reserved_receipt_ids,
        *root_scoped_receipt_ids,
    )
    if len(set(operation_namespace)) != len(operation_namespace):
        raise ValueError("reconciliation operation namespace collision")


def build_server_focus_command(
    *, command_id: str, space_id: str, session_id: str,
    ownership_epoch: int | None, action: str,
    payload: Mapping[str, object],
) -> FocusSessionCommand:
    internal_payload = {**dict(payload), "operation": action}
    business = focus_business_payload(action, internal_payload)
    return FocusSessionCommand(
        command_id=command_id,
        space_id=space_id,
        session_id=session_id,
        ownership_epoch=ownership_epoch,
        payload_hash=canonical_payload_hash(business),
        payload=internal_payload,
    )
```

`build_focus_request` must call `require_payload_hash` before reading `expected_version`, checking Scope identity, or entering S3. A malformed declared hash therefore has precedence over version, ownership, authorization, and business errors and leaves zero durable side effects.

- [ ] **Step 4: Run the focused hash and S3 vector tests**

Run:

```powershell
.\.venv\Scripts\python.exe -m pytest -q tests/test_focus_session_hash_contract.py tests/test_mutation_journal.py -p no:cacheprovider
```

Expected: PASS; RFC 8785 vectors match S3, changed business data changes `payloadHash`, changed CAS metadata changes only the S3 request identity, and a false declaration fails before any injected collaborator is touched.

- [ ] **Step 5: Commit the generic command boundary**

```powershell
git add -- app/focus_session/commands.py tests/test_focus_session_hash_contract.py tests/test_focus_session_policy.py
git commit -m "feat(session): lock generic focus command boundary"
```

---

### Task 2: Implement Lifecycle Persistence And Derived Clock Views

**Files:**
- Create: `backend/app/focus_session/policy.py`
- Create: `backend/app/focus_session/query.py`
- Create: `backend/app/focus_session/module.py`
- Create: `backend/tests/test_focus_session_module.py`
- Create: `backend/tests/test_focus_session_sync_policy.py`
- Modify: `backend/tests/test_focus_session_policy.py`

**Interfaces:**
- Consumes: TS0 `FocusSessionModule`, `FocusSessionCommand`, `FocusSessionView`, and ORM rows; S3 `MutationDomainPolicy` and `MutationUnitOfWork.execute`.
- Produces: `FocusSessionMutationPolicy.entity_types == FOCUS_SESSION_POLICY_TYPES` for the exact five TS0 Session business keys, closed Sync create/update/delete routing, `DefaultFocusSessionModule` with the exact TS0 signatures, and `derive_clock_state`/`focus_session_view` projection helpers.

- [ ] **Step 1: Write atomic-start, clock, and no-persisted-clock tests**

```python
# backend/tests/test_focus_session_module.py
import inspect

import pytest

from app.focus_session.contracts import FocusSessionModule
from app.focus_session.module import DefaultFocusSessionModule


@pytest.mark.asyncio
async def test_start_persists_all_initial_facts_in_one_s3_command(focus_fixture) -> None:
    command = focus_fixture.command(
        "start", session_id="fs-1", space_id="space-a", ownership_epoch=1
    )
    view = await focus_fixture.module.start(focus_fixture.scope, command)

    assert view.value["session"]["id"] == "fs-1"
    assert view.value["session"]["clockState"] == "running"
    assert view.value["context"]["level2WorkItemId"] == "l2-a"
    assert view.value["attribution"]["revision"] == 1
    assert [row["workItemId"] for row in view.value["plan"]] == ["l3-a"]
    assert focus_fixture.initial_row_counts() == (1, 1, 1, 1)


@pytest.mark.asyncio
async def test_clock_state_is_derived_and_never_persisted(focus_fixture) -> None:
    await focus_fixture.started("fs-1")
    paused = await focus_fixture.module.pause(
        focus_fixture.scope,
        focus_fixture.command("pause", session_id="fs-1", ownership_epoch=1),
    )
    resumed = await focus_fixture.module.resume(
        focus_fixture.scope,
        focus_fixture.command("resume", session_id="fs-1", ownership_epoch=1),
    )
    ended = await focus_fixture.module.end(
        focus_fixture.scope,
        focus_fixture.command("end", session_id="fs-1", ownership_epoch=1),
    )

    assert paused.value["session"]["clockState"] == "paused"
    assert resumed.value["session"]["clockState"] == "running"
    assert ended.value["session"]["clockState"] == "ended"
    assert "clock_state" not in focus_fixture.focus_session_columns()
    assert "clockState" not in focus_fixture.persisted_focus_session_payload("fs-1")


def test_concrete_module_signatures_match_ts0_protocol() -> None:
    for name in (
        "get", "start", "pause", "resume", "end",
        "update_note", "set_current_plan_item", "set_completion_draft",
        "add_plan_item", "remove_plan_item", "submit_review",
        "reconcile_commands",
    ):
        assert inspect.signature(DefaultFocusSessionModule.__dict__[name]) == (
            inspect.signature(FocusSessionModule.__dict__[name])
        )
```

Add fault injection after every initial DB plan and every invisible Sync event. Each failure must converge through S3 recovery to either all initial rows plus all visible events or no initial rows and no visible events. Add a parameterized `reconcile_commands` test for a non-null ownership epoch and a Scope/command Space mismatch. Both cases must fail after payload-hash verification but before root admission, and must leave zero root journal rows, zero receipt children, zero Task Space calls, and zero Sync/business-row effects.

- [ ] **Step 2: Implement the exact public Module signatures**

```python
# backend/app/focus_session/module.py
from __future__ import annotations

from collections.abc import Mapping

from app.focus_session.commands import build_focus_request, validate_reconcile_shape
from app.focus_session.contracts import (
    FocusSessionCommand,
    FocusSessionModule,
    FocusSessionView,
)
from app.mutation.unit_of_work import MutationUnitOfWork
from app.runtime.space import SpaceRuntimeHandle


def derive_clock_state(*, started_at: str, pause_started_at: str | None,
                       ended_at: str | None) -> str:
    if ended_at is not None:
        return "ended"
    if pause_started_at is not None:
        return "paused"
    if started_at:
        return "running"
    raise ValueError("FocusSession requires started_at")


def require_focus_scope(
    scope: SpaceRuntimeHandle,
    space_id: str,
    session_id: str | None,
) -> None:
    if space_id != scope.scope.space_id:
        raise ValueError("space_scope_mismatch")
    if session_id is None:
        raise ValueError("FocusSession command requires session_id")


def focus_session_view(value: Mapping[str, object]) -> Mapping[str, object]:
    aggregate = dict(value)
    raw_session = aggregate.get("session")
    if not isinstance(raw_session, Mapping):
        raise TypeError("FocusSession aggregate requires session mapping")
    session = dict(raw_session)
    started_at = session.get("startedAt")
    pause_started_at = session.get("pauseStartedAt")
    ended_at = session.get("endedAt")
    if not isinstance(started_at, str):
        raise TypeError("FocusSession view requires startedAt")
    if pause_started_at is not None and not isinstance(pause_started_at, str):
        raise TypeError("pauseStartedAt must be a string or null")
    if ended_at is not None and not isinstance(ended_at, str):
        raise TypeError("endedAt must be a string or null")
    session["clockState"] = derive_clock_state(
        started_at=started_at,
        pause_started_at=pause_started_at,
        ended_at=ended_at,
    )
    aggregate["session"] = session
    return aggregate


class DefaultFocusSessionModule(FocusSessionModule):
    def __init__(self, uow: MutationUnitOfWork, query, reconciler) -> None:
        self._uow = uow
        self._query = query
        self._reconciler = reconciler

    async def get(
        self, scope: SpaceRuntimeHandle, session_id: str
    ) -> FocusSessionView:
        stored = await self._query.load(scope, session_id)
        return FocusSessionView(value=focus_session_view(stored))

    async def start(
        self, scope: SpaceRuntimeHandle, command: FocusSessionCommand
    ) -> FocusSessionView:
        action = str(command.payload.get("operation", "start"))
        if action not in {
            "start", "activate_provisional", "mark_activation_conflict",
            "resolve_activation_conflict", "claim_owner",
        }:
            raise ValueError(f"invalid FocusSession start operation: {action}")
        return await self._execute(scope, action, command)

    async def pause(
        self, scope: SpaceRuntimeHandle, command: FocusSessionCommand
    ) -> FocusSessionView:
        return await self._execute(scope, "pause", command)

    async def resume(
        self, scope: SpaceRuntimeHandle, command: FocusSessionCommand
    ) -> FocusSessionView:
        return await self._execute(scope, "resume", command)

    async def end(
        self, scope: SpaceRuntimeHandle, command: FocusSessionCommand
    ) -> FocusSessionView:
        return await self._execute(scope, "end", command)

    async def update_note(
        self, scope: SpaceRuntimeHandle, command: FocusSessionCommand
    ) -> FocusSessionView:
        return await self._execute(scope, "update_note", command)

    async def set_current_plan_item(
        self, scope: SpaceRuntimeHandle, command: FocusSessionCommand
    ) -> FocusSessionView:
        return await self._execute(scope, "set_current_plan_item", command)

    async def set_completion_draft(
        self, scope: SpaceRuntimeHandle, command: FocusSessionCommand
    ) -> FocusSessionView:
        return await self._execute(scope, "set_completion_draft", command)

    async def add_plan_item(
        self, scope: SpaceRuntimeHandle, command: FocusSessionCommand
    ) -> FocusSessionView:
        return await self._execute(scope, "add_plan_item", command)

    async def remove_plan_item(
        self, scope: SpaceRuntimeHandle, command: FocusSessionCommand
    ) -> FocusSessionView:
        return await self._execute(scope, "remove_plan_item", command)

    async def submit_review(
        self, scope: SpaceRuntimeHandle, command: FocusSessionCommand
    ) -> FocusSessionView:
        return await self._execute(scope, "submit_review", command)

    async def reconcile_commands(
        self, scope: SpaceRuntimeHandle, command: FocusSessionCommand
    ) -> FocusSessionView:
        request = build_focus_request("reconcile_commands", command)
        require_focus_scope(scope, command.space_id, command.session_id)
        validate_reconcile_shape(command)
        admission = await self._uow.execute(scope, request, command.command_id)
        return await self._reconciler.reconcile(
            scope, command, admission=admission.value
        )

    async def _execute(
        self, scope: SpaceRuntimeHandle, action: str,
        command: FocusSessionCommand,
    ) -> FocusSessionView:
        request = build_focus_request(action, command)
        if action == "submit_review" and command.ownership_epoch is not None:
            raise ValueError("post-terminal review requires no owner epoch")
        require_focus_scope(scope, command.space_id, command.session_id)
        stored = await self._uow.execute(scope, request, command.command_id)
        return FocusSessionView(value=focus_session_view(stored.value))
```

`backend/app/focus_session/query.py::FocusSessionQuery.load(scope, session_id) -> Mapping[str, object]` reads the Session, immutable context, latest/effective revisions, plans, envelopes, and receipts through the supplied read handle and explicitly projects camelCase keys. Policy result values use the same projector before `context.command(...)`. The TS0 Space Adapter maps a caller mismatch to the registered `space_scope_mismatch` error before calling the Module; `require_focus_scope` is an unreachable-defense assertion for Coordinator/internal misuse and runs before UoW entry. `focus_session_view` adds derived `clockState` only to the returned mapping.

- [ ] **Step 3: Register the exact S3 policy interface**

```python
# backend/app/focus_session/policy.py
from app.mutation.types import MutationCommand, MutationRequest, MutationRuleViolation
from app.mutation.unit_of_work import MutationCompileContext, MutationDomainPolicy


FOCUS_SESSION_POLICY_TYPES = frozenset({
    "focus_session",
    "session_task_context",
    "session_attribution_revision",
    "session_work_item_plan",
    "session_work_item_outcome",
})


def entity_action(request: MutationRequest) -> str | None:
    action = request.name.rsplit(".", 1)[-1]
    return action if action in {"create", "update", "delete"} else None


class FocusSessionMutationPolicy(MutationDomainPolicy):
    entity_types = FOCUS_SESSION_POLICY_TYPES

    def __init__(self, locator_reader) -> None:
        self._locator = locator_reader

    async def compile(
        self,
        context: MutationCompileContext,
        request: MutationRequest,
    ) -> MutationCommand:
        handlers = {
            "focus_session.start": self._compile_start,
            "focus_session.pause": self._compile_pause,
            "focus_session.resume": self._compile_resume,
            "focus_session.end": self._compile_end,
            "focus_session.update_note": self._compile_note,
            "focus_session.submit_review": self._compile_review,
            "focus_session.reconcile_commands": self._compile_reconcile_admission,
            "focus_session.correct_attribution": self._compile_attribution,
            "focus_session.set_current_plan_item": self._compile_set_current,
            "focus_session.set_completion_draft": self._compile_completion_draft,
            "focus_session.add_plan_item": self._compile_add_plan,
            "focus_session.remove_plan_item": self._compile_remove_plan,
            "focus_session.activate_provisional": self._compile_activation,
            "focus_session.mark_activation_conflict": self._compile_conflict,
            "focus_session.resolve_activation_conflict": self._compile_resolution,
            "focus_session.claim_owner": self._compile_owner_claim,
            "focus_session.record_receipt": self._compile_receipt,
            "focus_session.rebuild_effort_projection": self._compile_rebuild_effort,
        }
        handler = handlers.get(request.name)
        if handler is not None:
            return await handler(context, request)
        action = entity_action(request)
        if action is not None:
            return await self._compile_sync_entity(
                context, request, action=action
            )
        raise RuntimeError(f"unregistered FocusSession command: {request.name}")
```

The policy imports `MutationCompileContext` and `MutationDomainPolicy` from `app.mutation.unit_of_work`, matching S3. The internal key `focus_session` has two closed name families: TS2 domain commands (`focus_session.start`, pause, review, and coordination names) and S3 `EntityCommand` create/update/delete requests for the real FocusSession Sync entity. The other four keys are real child Sync entities only. Every branch returns S3 `MutationCommand` through `context.command(...)`; it does not create a second compiler, interpreter, journal, or transaction owner.

- [ ] **Step 4: Close every S4 EntityCommand branch inside the policy**

```python
# backend/tests/test_focus_session_sync_policy.py
import pytest

from app.focus_session.policy import FOCUS_SESSION_POLICY_TYPES
from app.mutation.types import MutationRuleViolation


EXPECTED_TYPES = frozenset({
    "focus_session",
    "session_task_context",
    "session_attribution_revision",
    "session_work_item_plan",
    "session_work_item_outcome",
})
SYNC_MATRIX = (
    ("focus_session", "create", True),
    ("focus_session", "update", True),
    ("focus_session", "delete", False),
    ("session_task_context", "create", True),
    ("session_task_context", "update", False),
    ("session_task_context", "delete", False),
    ("session_attribution_revision", "create", True),
    ("session_attribution_revision", "update", False),
    ("session_attribution_revision", "delete", False),
    ("session_work_item_plan", "create", True),
    ("session_work_item_plan", "update", True),
    ("session_work_item_plan", "delete", False),
    ("session_work_item_outcome", "create", True),
    ("session_work_item_outcome", "update", False),
    ("session_work_item_outcome", "delete", False),
)


def test_policy_owns_every_real_ts0_session_entity() -> None:
    assert FOCUS_SESSION_POLICY_TYPES == EXPECTED_TYPES


@pytest.mark.parametrize("entity_type,action,conditionally_allowed", SYNC_MATRIX)
@pytest.mark.asyncio
async def test_entity_command_never_reaches_generic_fallback(
    sync_policy_fixture, entity_type, action, conditionally_allowed,
) -> None:
    request = sync_policy_fixture.from_sync_event(
        entity_type=entity_type,
        action=action,
        payload=sync_policy_fixture.valid_provisional_payload(entity_type, action),
    )
    if conditionally_allowed:
        command = await sync_policy_fixture.compile(request)
        assert command.request is request
    else:
        with pytest.raises(MutationRuleViolation) as captured:
            await sync_policy_fixture.compile(request)
        assert captured.value.code == "work_item_structure_changed"
    assert sync_policy_fixture.generic_fallback_calls == 0
```

The matrix marks branches that may be accepted only after the following under-lease rules; it does not grant generic CRUD:

| Entity type | `create` | `update` | `delete` |
|---|---|---|---|
| `focus_session` | only a complete offline `local_provisional`/`activation_conflict` post-image with `validity=pending`; reuse provisional start/time validation | only strict-CAS time/note changes while the authoritative row is still provisional/conflicted and pending; reuse legal clock/timestamp/duration helpers; cannot promote ownership/validity/review | always reject history deletion |
| `session_task_context` | once, only beneath the provisional parent; reuse the same level-2/Project/version/snapshot validator as start | reject immutable context rewrite | reject |
| `session_attribution_revision` | revision 1 or exact next append only; reuse attribution-chain/effective-row compilation | reject generic revision rewrite | reject |
| `session_work_item_plan` | only same-parent frozen L3 facts beneath a provisional/conflicted parent; reuse add-plan validation | only current/completion-draft/removal transitions while that parent remains provisional/conflicted and pending; authoritative-active rows require Coordinator commands | reject physical deletion; removal is a domain transition |
| `session_work_item_outcome` | exact next append through the review/outcome helper; keep task commands held while validity is pending | reject generic revision rewrite | reject |

`_compile_sync_entity` derives only `create|update|delete` from the S3 `EntityCommand` request name, dispatches by `(request.entity_type, action)`, and raises `MutationRuleViolation("work_item_structure_changed", details)` for immutable/update/delete branches before creating plans. An authoritative FocusSession update without a matching Coordinator claim raises `stale_session_owner`; Sync cannot manufacture ownership authority. Allowed branches call the same `_validate_start_context`, `_compile_clock_facts`, `_compile_attribution_append`, `_compile_plan_transition`, and `_compile_outcome_append` helpers used by REST/domain commands. They do not copy those invariants into a Sync-specific compiler.

The five owner-bound domain handlers (`update_note`, current item, completion
draft, add, remove) require an `ActiveSessionOperation` claim whose operation
ID, Session, Space, epoch, owner device, and owner Tab match the command. Note
uses strict Session CAS; plan operations use their TS0 Plan/WorkItem version
guards and preserve frozen snapshots. They publish complete post-images through
S3. An ordinary S4 `EntityCommand` carrying an authoritative-active Session or
Plan row is rejected even if its entity version matches, because Sync metadata
cannot manufacture the Meta claim. Tests poison generic fallback and prove an
observer outbox event has zero Session/event side effects.

Add a prepared-batch test ordered `focus_session create -> context create -> attribution revision 1 create -> plan create`. It must compile against S3 `AuthorityOverlay`, commit all-or-none, retain `validity=pending`, emit no command envelope/effort effect, and reject a cross-parent plan or mutated context with zero visible events. Add a second test proving an authoritative post-image update and every forbidden update/delete remain rejected even when version CAS matches.

S4 continues to call only `EntityCommand.from_sync_event()`. Its output reaches this policy through `MutationCompiler` registration; S4 must not recognize Session types, special-case the matrix, or construct TS2 domain commands.

- [ ] **Step 5: Compile start and owner-sensitive clock transitions**

`_compile_start` performs, in this order while S3 holds Space-exclusive:

1. `context.require_space(request.payload["space_id"])`.
2. Read the locator and require matching `claiming` state, `operation_id`, Space ID, Session ID, and ownership epoch.
3. Read the level-2 WorkItem and every ordered level-3 WorkItem from `context.authority`; verify exact expected versions, depth 2/3, same Project, and same level-2 parent.
4. Reject terminal or incompatible formal statuses without reopening or transitioning them.
5. Create one `FocusSession`, immutable `SessionTaskContext`, attribution revision 1, and ordered plan rows.
6. Build complete canonical post-image Sync events for Sync-enabled rows and return one `context.command(...)`.

`_compile_pause`, `_compile_resume`, and `_compile_end` require a `claiming` locator with matching operation ID, Session, Space, and epoch. The Coordinator created that claim from the previously active row before opening the Space. They then verify Session CAS and allow only `running -> paused`, `paused -> running`, and `running|paused -> ended`. `_compile_owner_claim` performs the same matching-claim/nonterminal-Session checks and returns a zero-business-effect S3 command whose durable receipt lets takeover recovery distinguish success from unknown.

One shared integer-second helper owns online lifecycle, provisional import, and
S4 policy validation. For canonical UTC `occurred_at`, it computes
`gross_seconds = floor((occurred_at - started_at) / 1000)`, adds
`floor((occurred_at - pause_started_at) / 1000)` exactly once to the persisted
`paused_seconds` when the prior row is paused, and computes
`focused_seconds = max(0, gross_seconds - paused_seconds - break_seconds)`.
It rejects time regression, non-integer/negative counters, and
`paused_seconds + break_seconds > gross_seconds`. Resume and end-while-paused
consume that final pause interval once and clear `pause_started_at`; pause sets
it without adding elapsed pause. No transition reads or writes `clock_state`,
and no timer completion value changes WorkItem status. Backend online and S4
post-image tests consume the same clock vectors as TS3, including nonzero break,
multiple pauses, end while paused, exact sub-second flooring, and the rejected
`paused+break>gross` boundary; every persisted counter must match byte-for-byte.

- [ ] **Step 6: Run lifecycle, Sync-policy, fencing, S3 recovery, and ORM parity tests**

Run:

```powershell
.\.venv\Scripts\python.exe -m pytest -q tests/test_focus_session_policy.py tests/test_focus_session_sync_policy.py tests/test_focus_session_module.py tests/test_entity_invariants.py tests/test_entity_concurrency.py tests/test_mutation_journal.py tests/test_mutation_recovery.py tests/test_parity_registry_orm.py -p no:cacheprovider
```

Expected: PASS; S3 recovery precedes every compiler read, stale locator epochs produce `stale_session_owner` with no row/event change, and the final ORM has no `clock_state` field.

- [ ] **Step 7: Commit lifecycle persistence**

```powershell
git add -- app/focus_session/policy.py app/focus_session/query.py app/focus_session/module.py tests/test_focus_session_policy.py tests/test_focus_session_sync_policy.py tests/test_focus_session_module.py
git commit -m "feat(session): persist fenced focus lifecycle"
```

---

### Task 3: Append Attribution, Outcome, Review, And Command Envelopes

**Files:**
- Modify: `backend/app/focus_session/policy.py`
- Modify: `backend/app/focus_session/module.py`
- Create: `backend/app/focus_session/effort_projection.py`
- Create: `backend/tests/test_focus_session_revisions.py`
- Create: `backend/tests/test_effort_projection.py`

**Interfaces:**
- Consumes: TS0 final Session revision/envelope rows, authoritative WorkItem rows, and Task 2 Module.
- Produces: append-only attribution/outcome compilation, deterministic materialized level-2 EffortProjection, and durable review plus immutable envelopes before any Task Space dispatch.

- [ ] **Step 1: Write append-only and review-order tests**

```python
# backend/tests/test_focus_session_revisions.py
@pytest.mark.asyncio
async def test_attribution_correction_never_rewrites_start_context(focus_fixture) -> None:
    await focus_fixture.started("fs-1", level2_id="l2-a")
    before = await focus_fixture.task_context("fs-1")
    await focus_fixture.correct_attribution("fs-1", level2_id="l2-b")

    assert await focus_fixture.attribution_rows("fs-1") == (
        (1, "l2-a", False),
        (2, "l2-b", True),
    )
    assert await focus_fixture.task_context("fs-1") == before


@pytest.mark.asyncio
async def test_review_commits_before_command_dispatch(focus_fixture) -> None:
    await focus_fixture.ended("fs-1", validity="valid")
    focus_fixture.task_space.raise_on_execute = RuntimeError("dispatch fault")
    command = focus_fixture.review_command(
        "fs-1",
        outcomes=(("l3-a", "completed", "complete"),),
    )

    view = await focus_fixture.module.submit_review(focus_fixture.scope, command)

    assert view.value["session"]["reviewState"] == "completed"
    assert await focus_fixture.review_state("fs-1") == "completed"
    assert await focus_fixture.outcome_rows("fs-1") == ((1, "l3-a", True),)
    assert await focus_fixture.envelope_ids("fs-1") == (
        "review-fs-1:command:0000",
    )
    assert focus_fixture.task_space.calls == []


@pytest.mark.asyncio
@pytest.mark.parametrize("clock_state", ("running", "paused"))
async def test_nonterminal_session_cannot_be_reviewed(
    focus_fixture, clock_state
) -> None:
    await focus_fixture.in_clock_state("fs-1", clock_state)
    before = await focus_fixture.all_revision_and_envelope_rows("fs-1")

    with pytest.raises(MutationRejectedError):
        await focus_fixture.module.submit_review(
            focus_fixture.scope,
            focus_fixture.review_command(
                "fs-1", outcomes=(("l3-a", "completed", "complete"),)
            ),
        )

    assert await focus_fixture.all_revision_and_envelope_rows("fs-1") == before
```

Also test that a corrected Outcome appends a new effective revision while the old unresolved envelope remains visible, and that plan `current_during_session`/`completion_draft` changes never mutate a WorkItem row.

- [ ] **Step 2: Compile review facts and envelopes in one S3 command**

`_compile_review` must:

1. Verify Session CAS and canonical `reviewed_at >= ended_at` (and strictly
   monotonic correction timestamps), then require persisted `ended_at` and
   derived `clockState="ended"`; running/paused Sessions reject
   before any revision, envelope, WorkItem, journal, or ledger effect.
2. Validate every Outcome against the frozen Session plan and snapshot identity.
3. Mark the previous Outcome revision ineffective and append the new effective revision; never update the old revision's content.
4. Create no envelope for `state_command="none"`.
5. For `complete` or `cancel`, resolve the corresponding seeded system status
   ID and compute the envelope hash exactly as
   `canonical_payload_hash({"status_definition_id": resolved_id})`, the same
   TS1 transition business payload. The `operation="transition"` selector and
   every target/CAS field stay outside that hash. Store that hash with the
   stable command ID, current Space/Session/revision, WorkItem ID, expected
   WorkItem version, closed target transition, server-declared `replay_safe`,
   and created timestamp. `replay_safe` comes from the Task Space policy, never
   from review input.
6. Update Session validity/review fields and publish all complete post-images in the same S3 command.
7. Return only after the Session transaction and S3 final visibility barrier succeeds. Task Space dispatch begins only through the separate `reconcile_commands` call.

The stable envelope ID is `bounded_child_operation_id(review_command_id,
f"command:{zero_padded_index}")` from S3. A result that fits retains the
injective readable `childp:<parent-byte-length>:<parent>:<suffix>` form; an
otherwise legal long result uses the shared `childh:<sha256>` form and remains
at most 128 ASCII bytes. A corrected
Outcome never changes an existing envelope or receipt; a user-approved retry
creates a new review command ID and therefore a new envelope ID.

- [ ] **Step 3: Materialize EffortProjection from authoritative Session facts**

Create `EffortProjectionCompiler`, called only by
`FocusSessionMutationPolicy` while S3 holds the Space-exclusive authority
overlay. For each impacted level-2 WorkItem it recomputes, never increments by
delta:

```text
SUM(focus_session.focused_seconds)
WHERE focus_session.ended_at IS NOT NULL
  AND focus_session.validity = 'valid'
  AND the joined session_attribution_revision is the sole effective revision
  AND effective_revision.level2_work_item_id = impacted WorkItem
```

`pending`, `invalid`, and `activation_conflict` Sessions contribute zero. A
terminal `local_provisional` import is pending by construction and also
contributes zero until explicit post-terminal adjudication validates it. The
compiler validates exactly one effective attribution per
Session, a real level-2 target in the same Project/Space, and a nonnegative
safe-integer sum. It recomputes both old and new targets when attribution
changes, and the current target whenever terminal focused seconds or validity
changes. If a total changes, the same S3 command updates only
`effort_actual_seconds`, server `updated_at`, and `version=version+1`, then emits
the complete canonical WorkItem Sync post-image. No separate commit,
timestamp-LWW event, or client-supplied actual effort is allowed.

```python
# backend/tests/test_effort_projection.py
@pytest.mark.asyncio
async def test_projection_recomputes_valid_terminal_sessions_only(effort_fixture) -> None:
    await effort_fixture.sessions(
        ("valid-a", "l2-a", 900, "valid", "authoritative", True),
        ("pending", "l2-a", 600, "pending", "authoritative", True),
        ("invalid", "l2-a", 300, "invalid", "authoritative", True),
        ("conflict", "l2-a", 500, "pending", "activation_conflict", True),
        ("running", "l2-a", 700, "valid", "authoritative", False),
    )
    await effort_fixture.rebuild()

    assert await effort_fixture.actual_seconds("l2-a") == 900
    assert await effort_fixture.last_work_item_event("l2-a") == (
        await effort_fixture.complete_work_item_post_image("l2-a")
    )


@pytest.mark.asyncio
async def test_attribution_and_validity_corrections_recompute_both_sides(
    effort_fixture,
) -> None:
    await effort_fixture.valid_terminal("fs-1", "l2-a", focused_seconds=1200)
    await effort_fixture.correct_attribution("fs-1", from_id="l2-a", to_id="l2-b")
    assert await effort_fixture.actual_seconds("l2-a") == 0
    assert await effort_fixture.actual_seconds("l2-b") == 1200

    await effort_fixture.correct_validity("fs-1", "invalid")
    assert await effort_fixture.actual_seconds("l2-b") == 0


@pytest.mark.asyncio
async def test_projection_is_independent_from_task_command_receipts(effort_fixture) -> None:
    await effort_fixture.end_and_review_valid("fs-1", "l2-a", focused_seconds=750)
    effort_fixture.task_commands.fail_all()
    await effort_fixture.reconcile_all("fs-1")
    assert await effort_fixture.actual_seconds("l2-a") == 750
```

The helper exposes read-only `verify_all(scope)` and server-authored
`compile_rebuild(context)` using the same formula. Recovery/certification
compares every materialized value with a fresh recomputation. Explicit repair
runs through the registered policy as one S3 command with bounded child IDs and
complete WorkItem events. Fault tests cover every WorkItem row/event/visibility
boundary and prove all-old or all-new state. Replay cannot double-count because
incremental paths and rebuild both derive totals from source rows.

The policy handler map binds
`focus_session.rebuild_effort_projection -> _compile_rebuild_effort`; the
handler calls only `EffortProjectionCompiler.compile_rebuild(context)` and
returns its `context.command(...)`. `EffortProjectionRepairService` is an
internal maintenance service, not a REST/MCP route or Protocol expansion. It
accepts an operator/recovery-supplied stable operation ID, builds the closed
server command `{operation: "rebuild_effort_projection", requested_at}` with
S3 `canonical_payload_hash`, and calls the same
`MutationUnitOfWork.execute(scope, request, operation_id)` used by every TS2
write. Reusing an ID with a changed timestamp is an idempotency conflict.

```python
@pytest.mark.asyncio
async def test_rebuild_enters_real_policy_and_uow(effort_fixture) -> None:
    await effort_fixture.corrupt_materialized_totals_for_test_only(
        {"l2-a": 1, "l2-b": 999}
    )
    report = await effort_fixture.repair_service.rebuild(
        effort_fixture.scope,
        operation_id="repair-effort-1",
        requested_at="2026-07-15T12:00:00.000Z",
    )

    assert report.mismatches_repaired == 2
    assert effort_fixture.policy_calls == [
        "focus_session.rebuild_effort_projection"
    ]
    assert effort_fixture.generic_fallback_calls == 0
    assert await effort_fixture.verify_all() == ()
```

Terminal offline Sessions follow the S4 import boundary as complete
`local_provisional`, `validity=pending` histories and never claim the active
locator. `submit_review` is their explicit adjudication seam: before accepting
`valid`, it revalidates the immutable terminal chronology, effective
attribution, and frozen WorkItem identity/version facts, then sets
`ownership_state=authoritative` and `validity=valid` in the same Session command
that recomputes effort. An `invalid` decision remains zero. Multiple imported
terminal histories, including overlapping device intervals, are never
auto-promoted or merged; each remains pending/zero until its own explicit
decision. Tests prove one reviewed import counts once, an idempotent review
does not double-count, and two unreviewed imports remain zero.

- [ ] **Step 4: Keep post-terminal review independent of the locator**

`submit_review` requires authorized Space scope, matching Session identity, expected Session version, and valid payload hash. It deliberately does not require an active locator or ownership epoch, because locator release follows terminal clock facts and may complete before review. The command must use `ownership_epoch=None` after terminal release.

- [ ] **Step 5: Run revision, projection, review, and fault tests**

Run:

```powershell
.\.venv\Scripts\python.exe -m pytest -q tests/test_focus_session_revisions.py tests/test_effort_projection.py tests/test_focus_session_module.py tests/test_mutation_recovery.py -p no:cacheprovider
```

Expected: PASS; historical revisions remain queryable, exactly one attribution/outcome revision is effective, projection equals fresh authoritative recomputation, and dispatch faults do not roll back review, time, or valid effort.

- [ ] **Step 6: Commit append-only review and projection facts**

```powershell
git add -- app/focus_session/policy.py app/focus_session/module.py app/focus_session/effort_projection.py tests/test_focus_session_revisions.py tests/test_effort_projection.py
git commit -m "feat(session): append review and materialize effort"
```

---

### Task 4: Reconcile Immutable Commands With Partial Receipts

**Files:**
- Create: `backend/app/focus_session/command_reconciler.py`
- Modify: `backend/app/focus_session/module.py`
- Modify: `backend/app/focus_session/policy.py`
- Create: `backend/tests/test_session_command_reconciliation.py`

**Interfaces:**
- Consumes: TS1 `TaskSpaceCommandModule`, immutable envelopes, S3 stored operation receipts, and TS0 `FocusSessionModule.reconcile_commands`.
- Produces: fully defined internal `StoredTaskCommandLookup`, concrete S3 journal adapter, independent dispatch, and one durable Session receipt per envelope.

Reconciliation intentionally has no Session `expectedVersion`. It selects
immutable envelopes by Session ID plus ordered command IDs, queries the original
operation result before replay, and appends receipts even if review or Outcome
revisions advanced after the envelope was created. The strict wire schema is
exactly `{commandIds, replaySafe, abandonCommandIds, decisionAt}` inside the
command payload; all four fields are hashed. Tests reject an extra
`expectedVersion` so a decorative, unvalidated CAS guard cannot reappear.

- [ ] **Step 1: Write partial-success and query-original-first tests**

```python
# backend/tests/test_session_command_reconciliation.py
import asyncio
import json

from app.mutation.types import bounded_child_operation_id, canonical_payload_hash


@pytest.mark.asyncio
async def test_each_envelope_has_an_independent_terminal_receipt(reconcile_fixture) -> None:
    await reconcile_fixture.envelopes(
        ("cmd-a", "l3-a", "complete"),
        ("cmd-b", "l3-b", "cancel"),
        ("cmd-c", "l3-c", "complete"),
    )
    reconcile_fixture.task_space.outcomes = {
        "cmd-a": "succeeded", "cmd-b": "conflict", "cmd-c": "failed",
    }

    view = await reconcile_fixture.module.reconcile_commands(
        reconcile_fixture.scope,
        reconcile_fixture.command(command_ids=("cmd-a", "cmd-b", "cmd-c")),
    )

    assert [(row["commandId"], row["state"])
            for row in view.value["commandReceipts"]] == [
        ("cmd-a", "succeeded"),
        ("cmd-b", "conflict"),
        ("cmd-c", "failed"),
    ]


@pytest.mark.asyncio
async def test_unknown_queries_original_before_replay(reconcile_fixture) -> None:
    await reconcile_fixture.unknown("cmd-unknown", replay_safe=True)
    reconcile_fixture.stored_lookup.outcome("cmd-unknown", "succeeded")

    await reconcile_fixture.reconcile("cmd-unknown")

    assert reconcile_fixture.calls == [
        ("query-original", "cmd-unknown"),
        ("record-receipt", "cmd-unknown", "succeeded"),
    ]
    assert reconcile_fixture.task_space.execution_count("cmd-unknown") == 0


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("requested", "server_declared", "expected_executions"),
    ((False, False, 0), (False, True, 0), (True, False, 0), (True, True, 1)),
)
async def test_replay_requires_caller_and_server_permission(
    reconcile_fixture, requested, server_declared, expected_executions,
) -> None:
    await reconcile_fixture.unknown(
        "cmd-unknown", replay_safe=server_declared
    )
    reconcile_fixture.stored_lookup.missing("cmd-unknown")

    await reconcile_fixture.reconcile(
        "cmd-unknown", requested_replay_safe=requested
    )

    assert reconcile_fixture.calls[0] == ("query-original", "cmd-unknown")
    assert reconcile_fixture.task_space.execution_count(
        "cmd-unknown"
    ) == expected_executions


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "change", ("selection", "replay_permission", "abandonment", "decision_at")
)
async def test_reconcile_root_id_cannot_change_intent(
    reconcile_fixture, change
) -> None:
    original = reconcile_fixture.command(
        operation_id="reconcile-root-1",
        command_ids=("cmd-a",),
        requested_replay_safe=False,
    )
    await reconcile_fixture.module.reconcile_commands(
        reconcile_fixture.scope, original
    )
    changed = reconcile_fixture.change_and_rehash(original, change)

    with pytest.raises(AppError) as captured:
        await reconcile_fixture.module.reconcile_commands(
            reconcile_fixture.scope, changed
        )

    assert captured.value.code == "idempotency_conflict"
    assert reconcile_fixture.task_space.calls_after(changed.command_id) == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "collision", ("envelope", "ordinary_receipt_child", "root_scoped_receipt_child")
)
async def test_reconcile_root_namespace_collision_has_zero_rows(
    reconcile_fixture, collision
) -> None:
    envelope_id = "cmd-collision"
    root_id = "reconcile-root-collision"
    command_ids = (envelope_id,)
    if collision == "envelope":
        root_id = envelope_id
    elif collision == "ordinary_receipt_child":
        root_id = bounded_child_operation_id(envelope_id, "receipt:unknown")
    else:
        command_ids = (
            envelope_id,
            bounded_child_operation_id(
                root_id, f"receipt:{envelope_id}:unknown"
            ),
        )
    command = reconcile_fixture.command(
        operation_id=root_id, command_ids=command_ids,
        requested_replay_safe=False,
    )

    with pytest.raises(ValueError, match="operation namespace collision"):
        await reconcile_fixture.module.reconcile_commands(
            reconcile_fixture.scope, command
        )
    assert reconcile_fixture.root_journal_rows(root_id) == 0
    assert reconcile_fixture.receipt_child_rows(envelope_id) == 0
    assert reconcile_fixture.task_space.calls == []


@pytest.mark.asyncio
@pytest.mark.parametrize("changed_field", ("work_item_id", "expected_version"))
async def test_original_lookup_requires_complete_task_space_request_identity(
    reconcile_fixture, changed_field
) -> None:
    envelope = await reconcile_fixture.envelope(
        command_id="same-operation", work_item_id="l3-a", expected_version=4,
        target_transition="complete",
    )
    changed = (
        {"work_item_id": "l3-b"}
        if changed_field == "work_item_id"
        else {"expected_version": 9}
    )
    reconcile_fixture.stored_lookup.operation_with_same_business_hash(
        envelope, **changed
    )

    with pytest.raises(AppError) as captured:
        await reconcile_fixture.reconcile("same-operation")

    assert captured.value.code == "idempotency_conflict"
    assert await reconcile_fixture.receipt("same-operation") is None
    assert reconcile_fixture.task_space.calls == []


@pytest.mark.asyncio
async def test_subset_reconcile_keeps_unselected_sibling_receipts(
    reconcile_fixture,
) -> None:
    await reconcile_fixture.receipts(
        ("cmd-a", "succeeded"), ("cmd-b", "conflict"), ("cmd-c", "unknown")
    )
    reconcile_fixture.stored_lookup.outcome("cmd-c", "failed")

    view = await reconcile_fixture.reconcile("cmd-c")

    assert [(row["commandId"], row["state"])
            for row in view.value["commandReceipts"]] == [
        ("cmd-a", "succeeded"), ("cmd-b", "conflict"), ("cmd-c", "failed")
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("state_command", "status_key"),
    (("complete", "completed"), ("cancel", "cancelled")),
)
async def test_real_review_envelope_hash_runs_through_real_task_space_module(
    integration_fixture, state_command, status_key
) -> None:
    await integration_fixture.ended_session_with_work_item("fs-1", "wi-1")
    reviewed = await integration_fixture.submit_review(
        session_id="fs-1", work_item_id="wi-1", state_command=state_command
    )
    envelope = reviewed.value["commandEnvelopes"][0]
    expected_payload = {
        "status_definition_id": integration_fixture.system_status_id(status_key)
    }
    assert envelope["payloadHash"] == canonical_payload_hash(expected_payload)

    await integration_fixture.real_focus_module.reconcile_commands(
        integration_fixture.scope,
        integration_fixture.reconcile_command(
            session_id="fs-1",
            command_ids=(envelope["commandId"],),
            replay_safe=True,
        ),
    )

    assert await integration_fixture.work_item_status("wi-1") == status_key
    assert await integration_fixture.receipt_state(envelope["commandId"]) == "succeeded"


@pytest.mark.asyncio
async def test_unknown_envelope_target_is_rejected_before_task_space_call(
    reconcile_fixture,
) -> None:
    await reconcile_fixture.corrupt_envelope_target("cmd-bad", "start")
    with pytest.raises(ValueError, match="complete or cancel"):
        await reconcile_fixture.reconcile("cmd-bad")
    assert reconcile_fixture.task_space.calls == []


@pytest.mark.asyncio
async def test_repeated_unknown_reuses_first_receipt_time_then_can_finish(
    reconcile_fixture,
) -> None:
    await reconcile_fixture.unknown("cmd-unknown", replay_safe=True)
    reconcile_fixture.stored_lookup.missing("cmd-unknown")
    first = await reconcile_fixture.reconcile("cmd-unknown")
    first_time = first.value["commandReceipts"][0]["updatedAt"]

    reconcile_fixture.clock.advance(seconds=30)
    second = await reconcile_fixture.reconcile("cmd-unknown")
    assert second.value["commandReceipts"][0]["updatedAt"] == first_time
    assert reconcile_fixture.receipt_operation_count(
        "cmd-unknown", "unknown"
    ) == 1

    reconcile_fixture.stored_lookup.outcome("cmd-unknown", "succeeded")
    terminal = await reconcile_fixture.reconcile("cmd-unknown")
    assert terminal.value["commandReceipts"][0]["state"] == "succeeded"
    assert reconcile_fixture.receipt_operation_count(
        "cmd-unknown", "succeeded"
    ) == 1


@pytest.mark.asyncio
async def test_no_receipt_without_double_permission_persists_pending(
    reconcile_fixture,
) -> None:
    await reconcile_fixture.envelopes(("cmd-held", "l3-a", "complete"))
    reconcile_fixture.stored_lookup.missing("cmd-held")

    view = await reconcile_fixture.reconcile(
        "cmd-held", requested_replay_safe=False
    )

    assert reconcile_fixture.task_space.calls == []
    assert await reconcile_fixture.receipt_state("cmd-held") == "pending"
    assert view.value["commandReceipts"][0]["state"] == "pending"


@pytest.mark.asyncio
async def test_pending_later_uses_original_terminal_result_without_replay(
    reconcile_fixture,
) -> None:
    await reconcile_fixture.envelopes(("cmd-pending", "l3-a", "complete"))
    reconcile_fixture.stored_lookup.missing("cmd-pending")
    await reconcile_fixture.reconcile("cmd-pending", requested_replay_safe=False)
    reconcile_fixture.stored_lookup.succeeded("cmd-pending")

    view = await reconcile_fixture.reconcile(
        "cmd-pending", requested_replay_safe=True
    )

    assert view.value["commandReceipts"][0]["state"] == "succeeded"
    assert reconcile_fixture.task_space.calls == []
    assert reconcile_fixture.receipt_operation_states("cmd-pending") == (
        "pending", "succeeded",
    )


@pytest.mark.asyncio
async def test_pending_later_double_permission_replays_once_and_converges(
    reconcile_fixture,
) -> None:
    await reconcile_fixture.unknown("cmd-permitted", replay_safe=True)
    reconcile_fixture.stored_lookup.missing("cmd-permitted")
    await reconcile_fixture.reconcile("cmd-permitted", requested_replay_safe=False)
    reconcile_fixture.task_space.succeeds("cmd-permitted")

    first = await reconcile_fixture.reconcile(
        "cmd-permitted", requested_replay_safe=True
    )
    second = await reconcile_fixture.reconcile(
        "cmd-permitted", requested_replay_safe=True
    )

    assert first.value == second.value
    assert reconcile_fixture.task_space.execution_count("cmd-permitted") == 1
    assert reconcile_fixture.receipt_operation_states("cmd-permitted") == (
        "pending", "succeeded",
    )


@pytest.mark.asyncio
async def test_abandon_queries_original_first_and_real_terminal_result_wins(
    reconcile_fixture,
) -> None:
    await reconcile_fixture.unknown("cmd-finished", replay_safe=True)
    reconcile_fixture.stored_lookup.succeeded("cmd-finished")

    view = await reconcile_fixture.reconcile(
        "cmd-finished",
        abandon_command_ids=("cmd-finished",),
        decision_at="2026-07-15T10:15:00.000Z",
    )

    assert view.value["commandReceipts"][0]["state"] == "succeeded"
    assert reconcile_fixture.receipt_operation_count(
        "cmd-finished", "abandoned"
    ) == 0


@pytest.mark.asyncio
async def test_abandon_records_terminal_decision_without_deleting_envelope(
    reconcile_fixture,
) -> None:
    envelope = await reconcile_fixture.unknown("cmd-stop", replay_safe=True)
    reconcile_fixture.stored_lookup.missing("cmd-stop")

    first = await reconcile_fixture.reconcile(
        "cmd-stop",
        abandon_command_ids=("cmd-stop",),
        decision_at="2026-07-15T10:16:00.000Z",
    )
    second = await reconcile_fixture.retry_same_root_command()

    assert first.value == second.value
    assert first.value["commandReceipts"][0]["state"] == "abandoned"
    assert await reconcile_fixture.envelope("cmd-stop") == envelope
    assert reconcile_fixture.task_space.calls == []
    assert reconcile_fixture.receipt_operation_states("cmd-stop") == (
        "unknown", "abandoned",
    )


@pytest.mark.asyncio
async def test_abandoned_envelope_fences_direct_task_space_execution(
    reconcile_fixture,
) -> None:
    envelope = await reconcile_fixture.unknown("cmd-fenced", replay_safe=True)
    reconcile_fixture.stored_lookup.missing("cmd-fenced")
    await reconcile_fixture.reconcile(
        "cmd-fenced", abandon_command_ids=("cmd-fenced",),
        decision_at="2026-07-15T10:16:30.000Z",
    )

    direct = envelope_to_task_space_command(envelope)
    outcome = await reconcile_fixture.task_space.execute(
        reconcile_fixture.scope, direct
    )
    assert outcome.code == "idempotency_conflict"
    assert outcome.details["reason"] == "session_command_not_replay_claimed"
    assert await reconcile_fixture.receipt_state("cmd-fenced") == "abandoned"
    assert reconcile_fixture.task_space.business_effect_count("cmd-fenced") == 0
    assert reconcile_fixture.task_space.sync_effect_count("cmd-fenced") == 0


@pytest.mark.asyncio
@pytest.mark.parametrize("admission_winner", ("replay", "abandon"))
async def test_concurrent_replay_and_abandon_have_one_durable_decision(
    reconcile_fixture, admission_winner
) -> None:
    await reconcile_fixture.unknown("cmd-race-decision", replay_safe=True)
    reconcile_fixture.stored_lookup.absent("cmd-race-decision")
    reconcile_fixture.order_root_admissions(admission_winner)

    replay, abandon = await asyncio.gather(
        reconcile_fixture.reconcile(
            "cmd-race-decision", requested_replay_safe=True
        ),
        reconcile_fixture.reconcile(
            "cmd-race-decision",
            abandon_command_ids=("cmd-race-decision",),
            decision_at="2026-07-15T10:17:00.000Z",
        ),
        return_exceptions=True,
    )

    state = await reconcile_fixture.receipt_state("cmd-race-decision")
    assert state == ("succeeded" if admission_winner == "replay" else "abandoned")
    assert reconcile_fixture.task_space.execution_count("cmd-race-decision") == (
        1 if admission_winner == "replay" else 0
    )
    assert not (
        state == "abandoned"
        and reconcile_fixture.task_space.execution_count("cmd-race-decision")
    )
    assert reconcile_fixture.decision_claim_count("cmd-race-decision") == 1
    assert all(
        not isinstance(value, BaseException)
        or getattr(value, "code", None) == "command_result_unknown"
        for value in (replay, abandon)
    )


@pytest.mark.asyncio
async def test_replay_claim_survives_restart_and_only_its_root_can_resume(
    reconcile_fixture,
) -> None:
    await reconcile_fixture.unknown("cmd-claimed", replay_safe=True)
    root_id = await reconcile_fixture.commit_replay_claim_then_crash("cmd-claimed")
    assert await reconcile_fixture.coordination("cmd-claimed") == {
        "kind": "replay_claimed", "root_command_id": root_id,
    }
    public = await reconcile_fixture.module.get(
        reconcile_fixture.scope, reconcile_fixture.session_id
    )
    public_json = json.dumps(public.value, sort_keys=True)
    assert "_reconcileCoordination" not in public_json
    assert "rootCommandId" not in public_json

    await reconcile_fixture.restart()
    with pytest.raises(AppError, match="command_result_unknown"):
        await reconcile_fixture.reconcile(
            "cmd-claimed", abandon_command_ids=("cmd-claimed",),
            decision_at="2026-07-15T10:18:00.000Z",
        )
    recovered = await reconcile_fixture.retry_root(root_id)
    assert recovered.value["commandReceipts"][0]["state"] == "succeeded"
    assert reconcile_fixture.task_space.execution_count("cmd-claimed") == 1


@pytest.mark.asyncio
async def test_finished_unknown_releases_claim_for_later_abandon(
    reconcile_fixture,
) -> None:
    await reconcile_fixture.unknown("cmd-timeout", replay_safe=True)
    original_unknown = await reconcile_fixture.immutable_receipt_operation(
        "cmd-timeout", "receipt:unknown"
    )
    old_root_id = await reconcile_fixture.replay_and_finish_unknown("cmd-timeout")
    assert (await reconcile_fixture.coordination("cmd-timeout"))["kind"] == (
        "replay_finished_unknown"
    )
    assert await reconcile_fixture.immutable_receipt_operation(
        "cmd-timeout", "receipt:unknown"
    ) == original_unknown
    assert reconcile_fixture.root_scoped_receipt_transition_count(
        "cmd-timeout", "unknown"
    ) == 1
    attempts = reconcile_fixture.task_space.execution_count("cmd-timeout")
    old_retry = await reconcile_fixture.retry_root(old_root_id)
    assert old_retry.value["commandReceipts"][0]["state"] == "unknown"
    assert reconcile_fixture.task_space.execution_count("cmd-timeout") == attempts

    abandoned = await reconcile_fixture.reconcile(
        "cmd-timeout", abandon_command_ids=("cmd-timeout",),
        decision_at="2026-07-15T10:19:00.000Z",
    )
    assert abandoned.value["commandReceipts"][0]["state"] == "abandoned"
    assert await reconcile_fixture.coordination("cmd-timeout") is None
    old_retry_after_abandon = await reconcile_fixture.retry_root(old_root_id)
    assert old_retry_after_abandon.value["commandReceipts"][0]["state"] == "abandoned"
    assert reconcile_fixture.task_space.execution_count("cmd-timeout") == attempts


@pytest.mark.asyncio
async def test_late_terminal_truth_beats_finished_unknown_abandon(
    reconcile_fixture,
) -> None:
    await reconcile_fixture.unknown("cmd-late", replay_safe=True)
    await reconcile_fixture.replay_and_finish_unknown("cmd-late")
    reconcile_fixture.stored_lookup.succeeded("cmd-late")

    view = await reconcile_fixture.reconcile(
        "cmd-late", abandon_command_ids=("cmd-late",),
        decision_at="2026-07-15T10:20:00.000Z",
    )
    assert view.value["commandReceipts"][0]["state"] == "succeeded"
    assert reconcile_fixture.receipt_operation_count("cmd-late", "abandoned") == 0


@pytest.mark.asyncio
async def test_old_replay_root_adopts_late_terminal_after_finished_unknown(
    reconcile_fixture,
) -> None:
    await reconcile_fixture.unknown("cmd-old-late", replay_safe=True)
    old_root_id = await reconcile_fixture.replay_and_finish_unknown("cmd-old-late")
    attempts = reconcile_fixture.task_space.execution_count("cmd-old-late")
    reconcile_fixture.stored_lookup.succeeded("cmd-old-late")

    view = await reconcile_fixture.retry_root(old_root_id)
    assert view.value["commandReceipts"][0]["state"] == "succeeded"
    assert reconcile_fixture.task_space.execution_count("cmd-old-late") == attempts
    assert await reconcile_fixture.coordination("cmd-old-late") is None


@pytest.mark.asyncio
async def test_concurrent_same_state_receipt_converges_to_first_timestamp(
    reconcile_fixture,
) -> None:
    await reconcile_fixture.unknown("cmd-race", replay_safe=True)
    reconcile_fixture.stored_lookup.missing("cmd-race")
    reconcile_fixture.clock.return_distinct_concurrent_values()

    first, second = await asyncio.gather(
        reconcile_fixture.reconcile("cmd-race"),
        reconcile_fixture.reconcile("cmd-race"),
    )

    assert first.value["commandReceipts"] == second.value["commandReceipts"]
    assert reconcile_fixture.receipt_operation_count("cmd-race", "unknown") == 1
```

The integration fixture above uses `DefaultFocusSessionModule` and
`DefaultTaskSpaceCommandModule` with the real TS1 compiler/UoW, not fake
outcomes. It proves review and transition share one hash authority. Add a crash
fixture after Task Space success but before Session receipt commit. After
restart, the reconciler must query the original S3 operation, record its
original terminal outcome, and keep Task Space execution count at one.

- [ ] **Step 2: Define the internal lookup and reconciliation algorithm**

```python
# backend/app/focus_session/command_reconciler.py
from __future__ import annotations

from collections.abc import Mapping
from typing import Protocol

from app.errors import AppError
from app.focus_session.commands import focus_business_payload, validate_reconcile_shape
from app.focus_session.contracts import (
    CommandReceiptState, FocusSessionCommand, FocusSessionView,
)
from app.focus_session.module import focus_session_view, require_focus_scope
from app.focus_session.query import FocusSessionQuery
from app.focus_session.receipts import decode_reconcile_coordination, receipt_view
from app.models.session_command import SessionCommandEnvelope
from app.mutation.types import (
    MutationRequest,
    require_payload_hash,
    validate_canonical_client_timestamp_or_none,
    validate_operation_id,
)
from app.runtime.space import SpaceRuntimeHandle
from app.task_space.contracts import (
    MutateWorkItem,
    SYSTEM_STATUS_IDS,
    TaskSpaceCommandModule,
    TaskSpaceOutcome,
)
from app.task_space.module import build_task_space_request


class StoredTaskCommandLookup(Protocol):
    async def query_original(
        self,
        scope: SpaceRuntimeHandle,
        command_id: str,
        expected_request: MutationRequest,
    ) -> TaskSpaceOutcome | None: ...


class ReceiptWriter(Protocol):
    async def record_pending(
        self,
        scope: SpaceRuntimeHandle,
        envelope: SessionCommandEnvelope,
    ) -> Mapping[str, object]: ...

    async def record(
        self,
        scope: SpaceRuntimeHandle,
        envelope: SessionCommandEnvelope,
        outcome: TaskSpaceOutcome | None,
        *,
        expected_coordination: Mapping[str, object] | None = None,
    ) -> Mapping[str, object]: ...

TRANSITION_STATUS_ID = {
    "complete": SYSTEM_STATUS_IDS["completed"],
    "cancel": SYSTEM_STATUS_IDS["cancelled"],
}


def expected_replay_coordination(
    decision: Mapping[str, object],
) -> Mapping[str, object] | None:
    if decision["kind"] != "replay_claimed":
        return None
    root_command_id = str(decision["root_command_id"])
    validate_operation_id(root_command_id)
    return {"kind": "replay_claimed", "root_command_id": root_command_id}


def current_replay_coordination(receipt) -> Mapping[str, object] | None:
    if receipt is None:
        return None
    value = decode_reconcile_coordination(
        state=CommandReceiptState(str(receipt.state)),
        result_json=receipt.result_json,
    )
    if value is None:
        return None
    return {"kind": value["kind"], "root_command_id": value["rootCommandId"]}


def require_exact_admission_decisions(
    admission: Mapping[str, object], command_ids: tuple[str, ...],
) -> Mapping[str, Mapping[str, object]]:
    if set(admission) != {"ordered_command_ids", "decisions"}:
        raise AppError(code="active_session_recovery_required")
    ordered = admission["ordered_command_ids"]
    if not isinstance(ordered, (tuple, list)) or any(
        not isinstance(value, str) for value in ordered
    ) or tuple(ordered) != command_ids:
        raise AppError(code="active_session_recovery_required")
    decisions = admission["decisions"]
    if not isinstance(decisions, Mapping) or set(decisions) != set(command_ids):
        raise AppError(code="active_session_recovery_required")
    return {
        command_id: require_closed_admission_decision(decisions[command_id])
        for command_id in command_ids
    }


def require_closed_admission_decision(
    value: object,
) -> Mapping[str, object]:
    if not isinstance(value, Mapping) or not isinstance(value.get("kind"), str):
        raise AppError(code="active_session_recovery_required")
    kind = value["kind"]
    if kind == "replay_claimed":
        expected_keys = {"kind", "root_command_id"}
    elif kind == "abandoned":
        expected_keys = {"kind", "root_command_id", "decision_at"}
    elif kind == "observe":
        expected_keys = {"kind", "receipt_state"}
    else:
        raise AppError(code="active_session_recovery_required")
    if set(value) != expected_keys:
        raise AppError(code="active_session_recovery_required")
    if kind in {"replay_claimed", "abandoned"}:
        root_command_id = value["root_command_id"]
        if not isinstance(root_command_id, str):
            raise AppError(code="active_session_recovery_required")
        try:
            validate_operation_id(root_command_id)
        except (TypeError, ValueError) as exc:
            raise AppError(code="active_session_recovery_required") from exc
    if kind == "abandoned":
        decision_at = value["decision_at"]
        if not isinstance(decision_at, str):
            raise AppError(code="active_session_recovery_required")
        try:
            validate_canonical_client_timestamp_or_none(decision_at)
        except (TypeError, ValueError) as exc:
            raise AppError(code="active_session_recovery_required") from exc
    if kind == "observe":
        receipt_state = value["receipt_state"]
        if not isinstance(receipt_state, str) or receipt_state not in {
            "not_needed", "pending", "succeeded", "failed", "conflict", "unknown",
            "abandoned",
        }:
            raise AppError(code="active_session_recovery_required")
    return value


def require_receipt(receipt):
    if receipt is None:
        raise AppError(code="active_session_recovery_required")
    return receipt


def validate_reconcile_command(
    scope: SpaceRuntimeHandle, command: FocusSessionCommand
) -> None:
    require_payload_hash(
        command.payload_hash,
        focus_business_payload("reconcile_commands", command.payload),
    )
    require_focus_scope(scope, command.space_id, command.session_id)
    validate_reconcile_shape(command)


def envelope_to_task_space_command(
    envelope: SessionCommandEnvelope,
) -> MutateWorkItem:
    if envelope.target_transition not in TRANSITION_STATUS_ID:
        raise ValueError("stored Session command target must be complete or cancel")
    status_definition_id = TRANSITION_STATUS_ID[envelope.target_transition]
    return MutateWorkItem(
        command_id=envelope.command_id,
        space_id=envelope.space_id,
        work_item_id=envelope.work_item_id,
        expected_version=envelope.expected_version,
        payload_hash=envelope.payload_hash,
        payload={
            "operation": "transition",
            "status_definition_id": status_definition_id,
        },
    )


class SessionCommandReconciler:
    def __init__(self, task_space: TaskSpaceCommandModule,
                 stored: StoredTaskCommandLookup, receipt_writer: ReceiptWriter,
                 query: FocusSessionQuery) -> None:
        self._task_space = task_space
        self._stored = stored
        self._receipt_writer = receipt_writer
        self._query = query

    async def reconcile(
        self, scope: SpaceRuntimeHandle, command: FocusSessionCommand,
        *, admission: Mapping[str, object],
    ) -> FocusSessionView:
        validate_reconcile_command(scope, command)
        session_id = command.session_id
        if session_id is None:
            raise ValueError("reconciliation requires session_id")
        envelopes = await self._query.selected_envelopes_by_ids(
            scope, session_id, tuple(command.payload["command_ids"])
        )
        decisions = require_exact_admission_decisions(
            admission, tuple(envelope.command_id for envelope in envelopes)
        )
        for envelope in envelopes:
            await self._reconcile_one(
                scope, envelope, root_command=command,
                decision=decisions[envelope.command_id],
            )
        view = await self._query.load(scope, session_id)
        return FocusSessionView(value=focus_session_view(view))

    async def _reconcile_one(
        self, scope, envelope, *, root_command: FocusSessionCommand,
        decision: Mapping[str, object],
    ) -> Mapping[str, object]:
        local = await self._query.receipt(scope, envelope.command_id)
        if local is not None and local.state in {
            "succeeded", "failed", "conflict", "abandoned",
        }:
            return receipt_view(local)
        task_command = envelope_to_task_space_command(envelope)
        expected_request = build_task_space_request(task_command)
        original = await self._stored.query_original(
            scope, envelope.command_id, expected_request
        )
        if original is not None:
            if local is not None and local.state == "abandoned":
                raise AppError(code="active_session_recovery_required")
            return await self._receipt_writer.record(
                scope, envelope, original,
                expected_coordination=current_replay_coordination(local),
            )
        if decision["kind"] == "abandoned":
            if local is None or local.state != "abandoned":
                raise AppError(code="active_session_recovery_required")
            return receipt_view(local)
        if decision["kind"] != "replay_claimed":
            if local is None:
                raise AppError(code="active_session_recovery_required")
            return receipt_view(local)
        if local is None:
            raise AppError(code="active_session_recovery_required")
        coordination = decode_reconcile_coordination(
            state=CommandReceiptState(str(local.state)), result_json=local.result_json
        )
        if coordination is not None and (
            coordination["kind"] == "replay_finished_unknown"
        ):
            return receipt_view(local)
        expected_coordination = expected_replay_coordination(decision)
        if expected_coordination is None:
            raise AppError(code="active_session_recovery_required")
        if coordination != {
            "kind": expected_coordination["kind"],
            "rootCommandId": expected_coordination["root_command_id"],
        }:
            raise AppError(code="active_session_recovery_required")
        if decision["root_command_id"] != root_command.command_id:
            return receipt_view(require_receipt(local))
        if not root_command.payload["replay_safe"] or not envelope.replay_safe:
            raise AppError(code="active_session_recovery_required")
        try:
            outcome = await self._task_space.execute(
                scope, task_command
            )
        except TimeoutError:
            outcome = None
        return await self._receipt_writer.record(
            scope, envelope, outcome,
            expected_coordination=expected_replay_coordination(decision),
        )
```

`S3StoredTaskCommandLookup` is implemented in this file and reads the
already-persisted S3 operation receipt by `command_id`. TS2 first maps the
immutable envelope to the exact Task Space command and calls TS1's public-
internal `build_task_space_request`; the lookup compares the stored complete
S3 `request_hash` with that expected request before mapping an outcome. The hash
never leaves backend internals. Same operation ID/business hash with a different
WorkItem, expected version, transition, Space, or other request identity is
`idempotency_conflict`, not this envelope's result. The lookup performs no
compile, stage, replay, or write. The admission compiler additionally
distinguishes absent from nonterminal.

`_compile_reconcile_admission` validates that the Session exists and the
selected ordered command IDs are unique members of its immutable envelope set.
While the root S3 UoW still holds Space-exclusive, it rechecks each original
Task Space operation as absent/nonterminal/terminal and the current receipt,
then atomically writes only reconciliation coordination facts (zero WorkItem or
Sync effects): `replay_claimed` with the root command ID, terminal `abandoned`
with decision timestamp, or an observe/no-replay marker. Abandon is admitted
only when the original operation is absent, no replay claim exists, and no
terminal receipt exists. Replay is admitted only with caller+envelope permission
and no abandonment/other-root claim; an existing nonterminal original is joined
for recovery rather than executed again. Its `context.command(...)` result is a
closed decision map consumed above. Thus two different roots cannot both pass a
check and later choose replay versus abandon.

That root value has exactly
`{ordered_command_ids: [...], decisions: {command_id: <closed decision>}}`.
`require_exact_admission_decisions` compares the ordered list and exact decision
key set with the immutable envelopes before any child loop; missing, extra,
retyped, or cross-Session decision data is recovery-required.

The current claim lives in the existing `session_command_receipts.result_json`;
TS2 adds no table or column. For `pending|unknown`, the only internal projection
is canonical JSON
`{"_reconcileCoordination":{"kind":"replay_claimed|replay_finished_unknown",`
`"rootCommandId":"<validated CommandId>"}}`. `replay_claimed` grants execution
only to that exact root operation. A different root may observe/join the current
receipt but cannot execute or abandon it. When that root finishes an attempted
replay without a terminal original result, the receipt atomically moves to
`unknown` with `replay_finished_unknown`; a later Space-exclusive admission may
then claim a new replay root or write `abandoned`. A discovered terminal original
always wins before either transition. Success/failure/conflict replace the
internal projection with the public terminal result; abandonment replaces it
with its closed decision result. The TS0-owned
`app.focus_session.receipts.receipt_view` uses
`public_receipt_result(...)`; `FocusSessionQuery.load`, policy result projection,
reconciliation, active locate, and REST all use that projector and never expose
`_reconcileCoordination`.

The root operation binds ordered IDs, replay permission, abandonment subset,
decision timestamp, and the resulting decision claims before child processing.
After a crash, exact root retry returns the same admission and continues from
its claims; a changed selection/replay/abandon/decision field is an idempotency
conflict before any child call. The root has zero formal WorkItem business and
zero Sync-event effects, but is intentionally not a zero-row operation because
its durable decision claim is the serialization boundary.

`_compile_receipt` must preserve `replay_claimed(root)` while that root owns the
attempt and may change it only to a terminal receipt or
`replay_finished_unknown(root)`. A receipt upsert from another root cannot erase,
replace, or consume it. This projection plus the immutable S3 root operation
result is the restart authority: after a crash between admission and child
execution, only an exact retry of the persisted root ID resumes the named child.
That immutable admission is not a perpetual execution grant: immediately before
the Task Space call, the reconciler must still observe the current receipt's
exact `replay_claimed(root)` projection. `replay_finished_unknown`, a later
`abandoned` receipt, or any other root short-circuits to the current receipt
after the original-result query and cannot revive the old claim.

TS1's `TransitionWorkItem` compiler also reads this coordination under the same
Space-exclusive UoW whenever its operation ID matches a Session envelope. It
requires complete envelope/request identity plus `replay_claimed`; missing,
finished-unknown, or abandoned coordination produces the durable
`idempotency_conflict` reason `session_command_not_replay_claimed` before any
WorkItem/status read or Sync effect. Therefore an abandon that wins admission
cannot be bypassed later through the public Task Space route. If the exact Task
Space operation wins first, abandonment's original-result query adopts that
terminal truth instead of writing `abandoned`.

Both first execution and exact root retry load the immutable envelopes named by
the original ordered `command_ids`, including envelopes whose receipts have
since become terminal. They never derive the stored admission identity from the
mutable unresolved-envelope projection. `_reconcile_one` then short-circuits a
terminal receipt. This keeps the decision map stable after success or
abandonment and makes an exact root retry return the original result.

- [ ] **Step 3: Persist receipts through the FocusSession policy**

`receipt_writer.record` creates a server-authored `FocusSessionCommand`. An
ordinary first observation uses deterministic operation ID
`bounded_child_operation_id(envelope.command_id, f"receipt:{receipt_state}")`.
When it consumes current `replay_claimed(root)` or
`replay_finished_unknown(root)` coordination, it instead uses the root-scoped ID
`bounded_child_operation_id(root_command_id,`
`f"receipt:{envelope.command_id}:{receipt_state}")`. Its payload contains
Session ID, envelope command ID/hash, state, error code, retryable flag, details,
frozen result mapping, recorded timestamp, and the exact expected coordination
kind/root. It computes the declared hash with S3 `canonical_payload_hash`; it
never copies an S3 complete-request hash.

Terminal original-result convergence always passes
`current_replay_coordination(local)`, not the immutable root admission's older
claim phase. This lets an old root replace `replay_finished_unknown` with the
real terminal receipt without issuing another Task Space execution; the compiler
still CASes the exact current kind/root and clears coordination atomically.

Before reading the clock, `receipt_writer.record` queries that deterministic
child operation and the current receipt. An existing matching terminal S3
result or same transition returns the original receipt, including its first
`recorded_at`; a hash/envelope/coordination mismatch is
`idempotency_conflict`. Only an absent child allocates `recorded_at` from the
injected canonical clock and freezes it inside the new operation intent/hash.
Thus a replay timeout never attempts to rewrite an earlier envelope-scoped
`receipt:unknown` operation: it creates one root-scoped transition whose compiler
CASes `replay_claimed(root) -> replay_finished_unknown(root)`. A later
`unknown -> succeeded|failed|conflict` transition also uses the owning root when
it consumes a claim and atomically replaces the current receipt while preserving
all earlier S3 operation histories.

The root `_compile_reconcile_admission` writes an `abandoned` receipt and closed
result `{decision: "abandoned", decision_at, root_command_id}` inside its locked
decision transaction; there is no post-lock `record_abandoned` call. Its
immutable decision timestamp comes from the validated caller payload, not the
server clock. It never deletes the envelope or any earlier pending/unknown S3
operation history.

Two writers may both observe that child as absent before either UoW commits.
If the second insert loses only the deterministic child-ID race because the
first writer froze a different `recorded_at`, `ReceiptWriter` catches that
specific S3 idempotency/unique-key conflict, re-queries the child and current
receipt, and compares the immutable envelope ID/hash plus normalized
state/error/retryability/details/result with `recorded_at` excluded. It returns
the first receipt only when every compared fact matches. Any envelope, state,
outcome, or normalized-result difference re-raises `idempotency_conflict`; no
blanket conflict retry or timestamp overwrite is permitted.

`_compile_receipt` verifies the immutable envelope ID/hash and upserts the one current receipt without modifying the envelope. State mapping is exact:

- `TaskSpaceAccepted` -> `succeeded`;
- version/status/tree rejection -> `conflict`;
- other explicit rejection -> `failed`;
- timeout/no terminal stored outcome -> `unknown`;
- no requested formal command -> `not_needed`;
- explicit user abandonment after an empty original-result query -> `abandoned`.

A terminal receipt is immutable for the same envelope. An `unknown` receipt may transition only after querying the original operation first. Replay is allowed only when that query returns no terminal outcome and the stored envelope explicitly marks replay safe.

The complete nonterminal transition matrix is closed: `pending` or `unknown`
first queries the original S3 operation; a discovered terminal outcome advances
to `succeeded|failed|conflict` without replay. If no terminal outcome exists,
missing caller or envelope permission retains `pending`/`unknown` unchanged;
double permission may execute once and advance `pending -> unknown|terminal` or
`unknown -> terminal`. Outcome receipt states use bounded child operation IDs;
the locked root admission owns an abandonment decision. Older pending/unknown
S3 history remains immutable while the one current receipt advances.
`not_needed`, `abandoned`, and other terminal states never replay or transition.

- [ ] **Step 4: Run receipt, Task Space, and restart tests**

Run:

```powershell
.\.venv\Scripts\python.exe -m pytest -q tests/test_session_command_reconciliation.py tests/test_task_space_project.py tests/test_task_space_tree.py tests/test_mutation_recovery.py -p no:cacheprovider
```

Expected: PASS; successful siblings remain successful, conflicts/failures/unknown are independently visible, and crash recovery never blindly replays an unknown command.

- [ ] **Step 5: Commit command reconciliation**

```powershell
git add -- app/focus_session/command_reconciler.py app/focus_session/module.py app/focus_session/policy.py tests/test_session_command_reconciliation.py
git commit -m "feat(session): reconcile immutable command receipts"
```

---

### Task 5: Implement The Master ActiveSession Coordinator

**Files:**
- Create: `backend/app/focus_session/coordinator.py`
- Create: `backend/tests/test_active_session_coordinator.py`

**Interfaces:**
- Consumes: exact TS0 `ActiveSessionCoordinator`/`ActiveSessionCommand`, `AuthorizedSpaceScope.open`, `ActiveSessionLocator`, `ActiveSessionOperation`, S3 bounded child IDs, and public `FocusSessionModule`.
- Produces: one `ActiveSessionCoordinationStore` whose Meta transactions bind canonical operation intent/phase to conditional singleton transitions, plus exact `locate/start/heartbeat/pause/resume/takeover/end/update_note/set_current_plan_item/set_completion_draft/add_plan_item/remove_plan_item` methods. Task 7 adds provisional activation and conflict resolution.

- [ ] **Step 1: Write command-shape, concurrent-start, and Coordinator-delegation tests**

```python
# backend/tests/test_active_session_coordinator.py
import asyncio
import inspect

import pytest

from app.errors import AppError
from app.focus_session.contracts import ActiveSessionCoordinator
from app.focus_session.coordinator import DefaultActiveSessionCoordinator


@pytest.mark.asyncio
async def test_start_requires_explicit_space_and_null_epoch(active_fixture) -> None:
    for command in (
        active_fixture.command("start", space_id=None, ownership_epoch=None),
        active_fixture.command("start", space_id="space-a", ownership_epoch=1),
    ):
        with pytest.raises(ValueError):
            await active_fixture.coordinator.start(active_fixture.master, command)
    assert active_fixture.authorized_opens == []


@pytest.mark.asyncio
async def test_concurrent_cross_space_start_has_one_claim(active_fixture) -> None:
    first, second = await asyncio.gather(
        active_fixture.coordinator.start(
            active_fixture.master,
            active_fixture.command("start", space_id="space-a", session_id="fs-a"),
        ),
        active_fixture.coordinator.start(
            active_fixture.master,
            active_fixture.command("start", space_id="space-b", session_id="fs-b"),
        ),
        return_exceptions=True,
    )
    values = (first, second)
    assert sum(not isinstance(value, BaseException) for value in values) == 1
    assert [getattr(value, "code", None) for value in values].count(
        "active_session_exists"
    ) == 1


@pytest.mark.asyncio
async def test_occupied_start_rejection_is_stable_after_locator_clears(
    active_fixture,
) -> None:
    await active_fixture.active("space-a", "existing", epoch=2)
    command = active_fixture.command(
        "start", space_id="space-b", session_id="new", operation_id="start-held"
    )
    with pytest.raises(AppError) as first:
        await active_fixture.coordinator.start(active_fixture.master, command)
    assert first.value.code == "active_session_exists"
    assert active_fixture.operation_phase("start-held") == "rejected"

    await active_fixture.end_and_clear("existing")
    before = active_fixture.side_effect_snapshot()
    with pytest.raises(AppError) as retried:
        await active_fixture.coordinator.start(active_fixture.master, command)

    assert retried.value.to_safe_dict() == first.value.to_safe_dict()
    assert active_fixture.side_effect_snapshot() == before
    assert active_fixture.focus_calls_for("start-held") == []

    changed = active_fixture.change_business_payload_and_hash(command)
    with pytest.raises(AppError) as conflict:
        await active_fixture.coordinator.start(active_fixture.master, changed)
    assert conflict.value.code == "idempotency_conflict"


@pytest.mark.asyncio
async def test_pause_derives_space_and_calls_public_module(active_fixture) -> None:
    await active_fixture.active("space-a", "fs-a", epoch=4)
    command = active_fixture.command(
        "pause", space_id=None, session_id="fs-a", ownership_epoch=4
    )
    await active_fixture.coordinator.pause(active_fixture.master, command)

    assert active_fixture.authorized_opens == [("space-a", "write")]
    assert active_fixture.focus_calls == [("pause", "space-a", "fs-a", 4)]
    assert active_fixture.locator_transitions == [
        ("active", "claiming", command.command_id, 4),
        ("claiming", "active", command.command_id, 4),
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "action",
    (
        "pause", "resume", "end", "update_note", "set_current_plan_item",
        "set_completion_draft", "add_plan_item", "remove_plan_item",
    ),
)
async def test_observer_tab_cannot_mutate_with_public_epoch(
    active_fixture, action
) -> None:
    await active_fixture.active(
        "space-a", "fs-a", epoch=4, owner=("device-a", "owner-tab")
    )
    command = active_fixture.valid_owner_command(
        action, space_id=None, session_id="fs-a", ownership_epoch=4,
        owner_device_id="device-a", owner_tab_id="observer-tab",
    )

    with pytest.raises(AppError) as captured:
        await getattr(active_fixture.coordinator, action)(
            active_fixture.master, command
        )

    assert getattr(captured.value, "code") == "stale_session_owner"
    assert active_fixture.locator_transitions == []
    assert active_fixture.authorized_opens == []
    assert active_fixture.focus_calls == []


@pytest.mark.asyncio
@pytest.mark.parametrize("action", ("end", "takeover"))
async def test_lost_success_response_exact_retry_returns_stored_result_first(
    active_fixture, action
) -> None:
    command = await active_fixture.valid_completed_command_with_lost_response(action)
    stored = await active_fixture.reconstruct_operation_result(command.command_id)
    before = active_fixture.side_effect_snapshot()

    retried = await getattr(active_fixture.coordinator, action)(
        active_fixture.master, command
    )

    assert retried.value == stored
    assert active_fixture.side_effect_snapshot() == before

    changed = active_fixture.change_business_payload_and_hash(command)
    with pytest.raises(AppError) as captured:
        await getattr(active_fixture.coordinator, action)(
            active_fixture.master, changed
        )
    assert captured.value.code == "idempotency_conflict"


@pytest.mark.asyncio
async def test_old_heartbeat_retry_is_locator_only_after_session_changes(
    active_fixture,
) -> None:
    heartbeat = await active_fixture.heartbeat_committed_then_lose_response()
    stored = await active_fixture.reconstruct_operation_result(heartbeat.command_id)
    assert "session" not in stored

    await active_fixture.owner_note_update("new note after heartbeat")
    before = active_fixture.side_effect_snapshot()
    retried = await active_fixture.coordinator.heartbeat(
        active_fixture.master, heartbeat
    )

    assert retried.value == stored
    assert active_fixture.side_effect_snapshot() == before


@pytest.mark.asyncio
@pytest.mark.parametrize("action", ("start", "pause"))
async def test_terminal_rejection_exact_retry_rethrows_original(
    active_fixture, action
) -> None:
    command, original = await active_fixture.terminally_rejected(action)
    before = active_fixture.side_effect_snapshot()

    with pytest.raises(AppError) as captured:
        await getattr(active_fixture.coordinator, action)(
            active_fixture.master, command
        )

    assert (captured.value.code, captured.value.details) == (
        original.code, original.details
    )
    assert active_fixture.side_effect_snapshot() == before


@pytest.mark.asyncio
async def test_coordinator_uses_injected_canonical_clock(active_fixture) -> None:
    active_fixture.clock.set("2026-07-15T10:00:00.000Z")
    view = await active_fixture.coordinator.start(
        active_fixture.master,
        active_fixture.command("start", space_id="space-a", session_id="fs-a"),
    )
    assert view.value["updatedAt"] == "2026-07-15T10:00:00.000Z"
    assert active_fixture.ambient_clock_calls == 0


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "action",
    (
        "start", "heartbeat", "pause", "resume", "takeover", "end",
        "update_note", "set_current_plan_item", "set_completion_draft",
        "add_plan_item", "remove_plan_item",
    ),
)
async def test_concurrent_same_command_has_one_effect_and_identical_result(
    active_fixture, action
) -> None:
    command = await active_fixture.prepare_valid_command(action)
    active_fixture.clock.return_distinct_concurrent_values()

    first, second = await asyncio.gather(
        getattr(active_fixture.coordinator, action)(active_fixture.master, command),
        getattr(active_fixture.coordinator, action)(active_fixture.master, command),
    )

    assert first.value == second.value
    assert active_fixture.operation_count(command.command_id) == 1
    assert active_fixture.space_effect_count(command.command_id) == 1
    assert active_fixture.operation_created_at_write_count(command.command_id) == 1


@pytest.mark.asyncio
async def test_concurrent_same_id_different_payload_conflicts_before_second_effect(
    active_fixture,
) -> None:
    original = active_fixture.command(
        "start", space_id="space-a", session_id="fs-a", operation_id="same-id"
    )
    changed = active_fixture.change_business_payload_and_hash(original)
    values = await asyncio.gather(
        active_fixture.coordinator.start(active_fixture.master, original),
        active_fixture.coordinator.start(active_fixture.master, changed),
        return_exceptions=True,
    )

    assert [getattr(value, "code", None) for value in values].count(
        "idempotency_conflict"
    ) == 1
    assert active_fixture.operation_count("same-id") == 1
    assert active_fixture.space_effect_count("same-id") == 1


@pytest.mark.asyncio
async def test_takeover_cannot_cross_an_owner_mutation_claim(active_fixture) -> None:
    await active_fixture.active("space-a", "fs-a", epoch=4)
    pause = active_fixture.pause_in_background(epoch=4, stop_after="claiming")
    await active_fixture.wait_for("claiming")

    with pytest.raises(AppError) as captured:
        await active_fixture.coordinator.takeover(
            active_fixture.master,
            active_fixture.command(
                "takeover", space_id=None, session_id="fs-a", ownership_epoch=4
            ),
        )
    assert getattr(captured.value, "code") == "stale_session_owner"

    active_fixture.continue_pause()
    await pause
    assert (await active_fixture.locator()).state == "active"


def test_concrete_coordinator_signatures_match_ts0_protocol() -> None:
    for name in (
        "locate", "start", "activate_provisional", "heartbeat", "pause",
        "resume", "takeover", "end", "update_note",
        "set_current_plan_item", "set_completion_draft", "add_plan_item",
        "remove_plan_item", "resolve_activation_conflict",
    ):
        assert inspect.signature(
            DefaultActiveSessionCoordinator.__dict__[name]
        ) == inspect.signature(ActiveSessionCoordinator.__dict__[name])
```

Add an AST test that `coordinator.py` imports `FocusSessionModule` from `app.focus_session.contracts` and contains no imports from `app.focus_session.policy` or S3 UoW modules.

- [ ] **Step 2: Lock per-operation command validation**

Validation happens after `require_payload_hash` and before the first locator/runtime operation:

| Coordinator method | `command.space_id` | `command.ownership_epoch` | Additional check |
|---|---|---|---|
| `start` | required target | must be `None` | Session ID required; target authorized before `claiming` insert |
| `activate_provisional` | required target | must be `None` | cached facts and cached epoch validated in Task 7 |
| `heartbeat` | must be `None` | required positive int | owner device/tab must match active locator |
| `pause` / `resume` / `end` | must be `None` | required positive int | active locator Session/epoch and owner device/tab must match |
| note / current / draft / add / remove | must be `None` | required positive int | same owner match plus operation-specific Session/Plan/WorkItem CAS guards |
| `takeover` | must be `None` | required positive int | locator CAS increments exactly once |
| `resolve_activation_conflict` | must be `None` | required positive int | candidate Spaces derived from persisted rows, never caller-selected |

After static operation-specific validation, the Coordinator looks up
`command_id` before applying current locator/epoch predicates. An existing row
must match kind, payload hash, Session/root identity, owner/epoch proof, and
every caller-derived intent field. A mismatch is `idempotency_conflict`. If its
strict `result_descriptor_json` is present, the Coordinator reauthorizes every
    referenced Space in read mode, queries each descriptor-named original S3
    operation result, and verifies its stored canonical hash. A success descriptor
    rebuilds and returns the strict response. A Space-backed rejection descriptor
    names the original S3 rejection operation and its canonical error hash; retry
    re-reads that rejection, applies the shared error mapping, rebuilds code/
    details/retryability, hash-checks the assembled error, and only then rethrows
    it. A Meta-precondition rejection has no S3 child: its descriptor carries the
    closed rejection kind, frozen Meta-owned locator/pair projection, and canonical
    error hash, so retry rebuilds and hash-checks the error directly from those
    persisted Meta facts. Every branch has zero locator, Module, or S3 mutation.
This ordering is required for a completed `end` whose locator is now absent and
for takeover/resolution whose successful epoch has advanced. A matching
nonterminal row enters single-flight recovery for that same operation; it never
starts a second operation or fails merely because the current locator is
`claiming`.

That fast lookup is not the concurrency authority. Every `claim`/`begin_*`/
`heartbeat` store call performs insert-or-verify and locator CAS in one Meta
transaction and returns a tagged `OperationBegin(disposition, phase,
stored_intent, descriptor)`. Its disposition is exactly
`new_claim|new_rejection|existing`; only `new_claim` may execute a Space child.
An `existing` result never executes a Space child: completed/rejected rows are
reconstructed immediately, while a matching nonterminal row joins recovery for
that operation and returns its reconstructed result. A changed payload hash or
caller-intent field under the same ID is `idempotency_conflict` in that same
transaction.

Server-generated timestamps are not part of competing caller intent. Every
`claim`/`begin_*`/`heartbeat` call supplies a candidate from the injected clock.
The insert-or-verify Meta transaction stores that candidate exactly once as the
new `ActiveSessionOperation.created_at`; a concurrent/existing branch compares
only caller intent and ignores its second timestamp candidate, then returns the
persisted first `created_at` in `OperationBegin`. Locator `updated_at`, lease
expiry, descriptor hashes, and reconstructed responses derive only from that
persisted value. There is no separate server-facts column or post-begin freeze
step, so a crash cannot leave a winning operation without its authoritative
time. Thus two processes with different live clocks cannot produce two response
hashes for one command ID. A keyed process-local single-flight may reduce
duplicate waits but is never required for correctness.

- [ ] **Step 3: Implement conditional Meta operations**

`ActiveSessionCoordinationStore` owns these exact durable transitions. Every
method first inserts or idempotently verifies the immutable
`ActiveSessionOperation(kind, payload_hash, intent_json)` and changes its phase
in the same Meta transaction as the locator CAS. Begin methods return the tagged
`OperationBegin`, including the persisted operation `created_at`. Each creating
method accepts `createdAtCandidate`; the candidate participates only in a unique
insert and is ignored by the existing-row intent comparison:

```text
claim(intent, target, owner)                       empty -> claiming(epoch=1), op -> claimed
finish_claim(operationId, locator, descriptor)    claiming -> active, op -> completed+descriptor
reject_claim(operationId, descriptor)             claiming -> empty, op -> rejected+descriptor
begin_action(intent, sessionId, epoch, owner)      active -> claiming(same epoch), op -> claimed
finish_action(operationId, locator, descriptor)   claiming -> active, op -> completed+descriptor
reject_action(operationId, descriptor)            claiming -> active(same epoch), op -> rejected+descriptor
reject_conflict_claim(operationId, descriptor)    claiming -> prior active(same epoch), op -> rejected+descriptor
record_precondition_rejection(intent, descriptor) locator unchanged, op -> rejected+descriptor
begin_takeover(intent, epoch, newOwner)            active -> claiming(epoch+1), op -> claimed
finish_takeover(operationId, locator, descriptor) claiming -> active, op -> completed+descriptor
begin_release(operationId, epoch)                  claiming -> releasing, op -> space_committed
clear_release(operationId, descriptor)            releasing -> empty, op -> completed+descriptor
heartbeat(intent, sessionId, epoch, owner, descriptor) active -> active(new expiry), op -> completed+descriptor
```

For every row above, locator time and lease arithmetic uses the returned
operation `created_at` plus the one closed integer-seconds formula; it never uses
the losing candidate or reads the clock again. Recovery reads the same persisted
`created_at` before rebuilding any locator, descriptor, response, or lease.

`intent_json` is built by one closed kind-specific encoder before the store call
and includes every field required to replay the operation; it is never a raw
wire mapping. Every transition predicates singleton ID, operation ID, source
state, Space ID, Session ID, expected epoch, and owner whenever owner-bound.
After authorization and static shape/hash checks, each begin transaction locks
or conditionally reads the singleton and chooses exactly one durable result: a
successful locator transition, or `record_precondition_rejection` for a
Meta-provable `stale_session_owner`, `active_session_exists`, or persisted-pair
mismatch. It does not attempt a locator CAS and then roll back the operation
insert. The precondition descriptor contains only rejection schema/kind, the
Meta-owned locator/pair projection needed to reconstruct it, and canonical
error hash; it contains no Space aggregate or caller error mapping. An
authorization failure and pre-Meta schema/hash failure create no operation.
A repeated identical operation returns its stored phase/result even if the
locator later changes; a reused operation ID with different kind, payload hash,
or intent returns `idempotency_conflict` before locator mutation.

Every `descriptor` is built by the Coordinator from the validated response but
contains only schema/kind, Meta-owned locator fields, intent-named Space/
Session/child operation references, and the full canonical response/error hash.
A rejection descriptor stores no code, details, message, retryability, or other
Space-owned outcome projection. It is at most 8 KiB and contains no Space
business aggregate. The store writes it atomically
with the listed locator/phase transition. Recovery uses the same finish methods
and therefore persists the descriptor before making the operation returnable.
Conflict `awaiting_resolution` and completed resolution transitions follow the
same rule even though the former remains a nonterminal ownership decision.

`reject_claim` requires the still-matching start claim and a verified terminal
S3 rejection with no Session; it deletes the singleton and marks the operation
rejected with the rejection descriptor in one Meta transaction. `begin_action`
freezes the prior active
locator's completed `operation_id` inside the immutable action intent.
`reject_action` requires the still-matching action/takeover claim plus the
verified matching nonterminal Session; it restores the exact prior active
target, owner, epoch, and completed locator `operation_id` from that intent
while marking the rejected action operation with its rejection descriptor in
the same Meta transaction.
Thus an active locator never points at a rejected operation. Neither method
accepts a caller-supplied replacement target. Repetition is idempotent only for
the same closed intent and terminal proof; injected faults prove there is no
rejected operation paired with an un-restored locator, or restored locator
paired with a claimed operation.

- [ ] **Step 4: Implement start by calling the public FocusSession Module**

```python
# backend/app/focus_session/coordinator.py
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Protocol

from app.auth.authority import Principal
from app.db.models.meta import ActiveSessionLocator
from app.errors import MutationRejectedError
from app.focus_session.commands import active_business_payload
from app.focus_session.contracts import (
    ActiveSessionCommand,
    ActiveSessionCoordinator,
    ActiveSessionView,
    FocusSessionCommand,
    FocusSessionModule,
)
from app.mutation.types import require_payload_hash
from app.runtime.scope import AuthorizedSpaceScope


@dataclass(frozen=True, slots=True)
class LocatorOwner:
    device_id: str
    tab_id: str


class ActiveSessionRecoveryGate(Protocol):
    async def recover_if_needed(self, principal: Principal) -> None: ...


def require_start_shape(command: ActiveSessionCommand) -> str:
    if not isinstance(command.space_id, str) or not command.space_id:
        raise ValueError("start requires space_id")
    if command.ownership_epoch is not None:
        raise ValueError("start requires ownership_epoch=None")
    if not command.session_id:
        raise ValueError("start requires session_id")
    if "operation" in command.payload:
        raise ValueError("operation is server-authored")
    return command.space_id


def owner_from_payload(payload: Mapping[str, object]) -> LocatorOwner:
    device_id = payload.get("owner_device_id")
    tab_id = payload.get("owner_tab_id")
    if not isinstance(device_id, str) or not device_id:
        raise ValueError("owner_device_id is required")
    if not isinstance(tab_id, str) or not tab_id:
        raise ValueError("owner_tab_id is required")
    return LocatorOwner(device_id=device_id, tab_id=tab_id)


def locator_view(row: ActiveSessionLocator) -> dict[str, object]:
    return {
        "spaceId": row.space_id,
        "sessionId": row.session_id,
        "operationId": row.operation_id,
        "state": row.state,
        "ownerDeviceId": row.owner_device_id,
        "ownerTabId": row.owner_tab_id,
        "ownershipEpoch": row.ownership_epoch,
        "leaseExpiresAt": row.lease_expires_at,
        "updatedAt": row.updated_at,
    }


class DefaultActiveSessionCoordinator(ActiveSessionCoordinator):
    def __init__(self, coordination: ActiveSessionCoordinationStore,
                 authorized_spaces: AuthorizedSpaceScope,
                 focus: FocusSessionModule,
                 recovery: ActiveSessionRecoveryGate,
                 clock: Callable[[], str]) -> None:
        self._coordination = coordination
        self._authorized_spaces = authorized_spaces
        self._focus = focus
        self._recovery = recovery
        self._clock = clock

    async def locate(self, principal: Principal) -> ActiveSessionView | None:
        await self._recovery.recover_if_needed(principal)
        row = await self._coordination.get_locator()
        if row is None or row.state != "active":
            return None
        async with await self._authorized_spaces.open(
            principal, row.space_id, mode="read"
        ) as scope:
            session_view = await self._focus.get(scope, row.session_id)
        return ActiveSessionView(value={
            **locator_view(row), "session": session_view.value,
        })

    async def start(
        self, principal: Principal, command: ActiveSessionCommand
    ) -> ActiveSessionView:
        require_payload_hash(
            command.payload_hash,
            active_business_payload("start", command.payload),
        )
        space_id = require_start_shape(command)
        owner = owner_from_payload(command.payload)
        intent = active_operation_intent("start", command)
        replayed = await self._replay_or_recover_existing(
            principal, command=command, intent=intent
        )
        if replayed is not None:
            return replayed
        await self._recovery.recover_if_needed(principal)
        async with await self._authorized_spaces.open(
            principal, space_id, mode="write"
        ) as scope:
            begin = await self._coordination.claim(
                intent=intent,
                space_id=space_id,
                session_id=command.session_id,
                owner=owner,
                created_at_candidate=self._clock(),
            )
            if begin.phase == "rejected":
                await self._raise_stored_rejection(principal, begin)
            if begin.disposition == "existing":
                return await self._recover_existing_begin(
                    principal, command=command, begin=begin
                )
            claim = begin.claim
            focus_command = FocusSessionCommand(
                command_id=command.command_id,
                space_id=space_id,
                session_id=command.session_id,
                ownership_epoch=claim.ownership_epoch,
                payload_hash=command.payload_hash,
                payload=command.payload,
            )
            try:
                session_view = await self._focus.start(scope, focus_command)
            except MutationRejectedError as rejected:
                descriptor = build_rejection_descriptor(
                    rejected,
                    space_results=((space_id, command.session_id,
                                    command.command_id),),
                )
                await self._coordination.reject_claim(
                    command.command_id, descriptor=descriptor
                )
                raise
            completed_at = begin.created_at
            active = claim.as_active(updated_at=completed_at)
            response = ActiveSessionView(value={
                **locator_view(active), "session": session_view.value,
            })
            descriptor = build_active_result_descriptor(
                response.value,
                space_results=((space_id, command.session_id,
                                command.command_id),),
            )
            await self._coordination.finish_claim(
                command.command_id, locator=active, descriptor=descriptor
            )
            return response
```

`_replay_or_recover_existing` implements Task 5 Step 2's operation-first gate:
it validates exact kind/hash/intent, reauthorizes descriptor Spaces, returns a
completed original result, or single-flight recovers the same nonterminal
operation. It returns `None` only when the command ID is absent, but the atomic
`OperationBegin` result remains the authority for a concurrent insert after
that lookup. The injected clock value used to build `active` is frozen once in
Meta before the Space call and is the exact value supplied to the locator CAS;
`build_active_result_descriptor` stores only references/locator/hash, never
`session_view.value`. The implementation catches only S3's existing
`MutationRejectedError`, which proves a terminal rejection. Cancellation,
timeout, I/O failure, or unknown Space commit leaves `claiming` for Task 6
recovery.

`locate`, successful start, pause, resume, takeover, all five running-content
commands, and successful resolution share one camelCase active shape: root
locator fields (`spaceId`, `sessionId`, `operationId`, `state`, owner fields,
`ownershipEpoch`, lease/update timestamps) plus `session`, whose value is the
nested FocusSession aggregate (`session`, `context`, `attribution`, `plan`,
`outcomes`, `commandEnvelopes`, `commandReceipts`). `end` returns the strict
terminal shape `{session: <ended aggregate>, locator: null}`. Heartbeat returns
only the strict root locator projection and never embeds Space-owned Session
content. The nested FocusSession entity keeps its TS0 Sync identity as
`session.id`; only locator/candidate routing metadata uses `sessionId`. `locate`
opens `locator.space_id` with authorized read mode and calls
`FocusSessionModule.get`; locator metadata never becomes Session business
authority.

- [ ] **Step 5: Implement locator-bound actions through public Module calls**

For pause/resume/end and the five running-content commands, the shared sequence is:

1. Verify the external payload hash.
2. Reject non-null `command.space_id`; require the operation's epoch.
3. Read and compare the `active` locator's Session/epoch and the caller's owner device/tab.
4. Authorize and open `locator.space_id` with `mode="write"`; a typed authorization rejection leaves both Meta tables byte-for-byte unchanged.
5. While holding that authorized scope, atomically persist the exact operation intent and reserve `active -> claiming` with the same command ID, epoch, device, and Tab.
6. Construct `FocusSessionCommand` using the locator-derived Space and the caller's unchanged business payload/hash.
7. Call the one matching public `FocusSessionModule` method; its policy accepts only the matching claim and exact operation-specific CAS guards.
8. Finish pause/resume/note/plan changes as `claiming -> active`; finish end as `claiming -> releasing -> empty` after the returned derived clock is terminal.

The Coordinator-to-Module dispatch table is closed and tested without a generic
method name supplied by the caller:

```text
update_note              -> FocusSessionModule.update_note
set_current_plan_item    -> FocusSessionModule.set_current_plan_item
set_completion_draft     -> FocusSessionModule.set_completion_draft
add_plan_item             -> FocusSessionModule.add_plan_item
remove_plan_item          -> FocusSessionModule.remove_plan_item
```

Heartbeat first authorizes a read-open, calls `get` only to prove the derived
clock is nonterminal, and then renews with one operation-row plus
`active`/owner/epoch Meta transaction. Its bounded result descriptor contains
the complete locator-only response, so an exact retry remains stable after a
later Session mutation and needs no Space business snapshot. Pause, resume, and
end carry the same owner identity in their hashed business payload; an observer
with the correct public Session ID and epoch but a different Tab fails
`stale_session_owner` before claim or Space open. Takeover authorizes the locator
Space before conditionally changing `active -> claiming` with epoch+1, then
calls `FocusSessionModule.start` with a deterministic server-authored
`claim_owner` command; after its durable S3 receipt it finishes
`claiming -> active`. Authorization failure creates no operation row and cannot
wedge the locator. A competing old pause/resume/end can no longer compile once
takeover owns the claim. Review/receipt state is deliberately ignored during
release.

Parameterize heartbeat, pause, resume, end, takeover, and all five
running-content commands with an injected `AuthorizedSpaceScope.open` denial.
Each case asserts the typed authorization error, zero
`ActiveSessionOperation` rows, an unchanged active locator/epoch, zero Module
calls, and that the next authorized request succeeds without recovery.

Add an integration test using `DefaultActiveSessionCoordinator` and the real
`DefaultFocusSessionModule`, not a fake Module. It performs takeover from epoch
3 to 4, asserts the Module's public `start` seam accepts `operation=claim_owner`,
proves the registered `focus_session.claim_owner` policy persists its receipt,
and then proves an epoch-3 pause is rejected as `stale_session_owner`. An AST or
fake-call assertion alone is insufficient because it cannot catch a public
Module action whitelist that blocks the policy.

A proven terminal pause/resume/end or running-content rejection restores the
same claim to `active` without changing the epoch. Cancellation, timeout, I/O
failure, or any unknown S3 outcome leaves `claiming`; Task 6 queries that
original operation before deciding whether to restore `active`, finish
`active`, or release a terminal Session.

- [ ] **Step 6: Run Coordinator, concurrency, authorization, and stale-owner tests**

Run:

```powershell
.\.venv\Scripts\python.exe -m pytest -q tests/test_active_session_coordinator.py tests/test_focus_session_policy.py tests/test_routes_auth_spaces.py -p no:cacheprovider
```

Expected: PASS; exactly one concurrent start wins, the master current Space is never consulted, every opened Space is authorized, and takeover fences the delayed old owner before its S3 compiler produces plans.

- [ ] **Step 7: Commit the Coordinator**

```powershell
git add -- app/focus_session/coordinator.py tests/test_active_session_coordinator.py
git commit -m "feat(session): coordinate one active session"
```

---

### Task 6: Recover Claiming, Active, Releasing, And Unknown Operations

**Files:**
- Create: `backend/app/focus_session/recovery.py`
- Modify: `backend/app/runtime/bootstrap.py`
- Create: `backend/tests/test_active_session_recovery.py`
- Modify: `backend/tests/test_runtime_bootstrap.py`

**Interfaces:**
- Consumes: S2 read-open recovery gate, S3 stored child-operation lookup, TS0 `ActiveSessionOperation` intent/phase rows, `ActiveSessionCoordinationStore`, registered Space catalog, and public `FocusSessionModule.get`.
- Produces: fully defined `ActiveSessionRecoveryReport`, startup `recover(principal)`, and single-flight request gate `recover_if_needed(principal)` constructed before and injected into the Coordinator.

- [ ] **Step 1: Write the full cross-database fault matrix**

```python
# backend/tests/test_active_session_recovery.py
@pytest.mark.parametrize(
    "fault",
    (
        "after_claiming",
        "after_space_commit",
        "after_finish_claim",
        "after_pause_claim",
        "after_pause_commit",
        "after_takeover_claim",
        "after_owner_claim_receipt",
        "after_conflict_claim",
        "after_candidate_conflict_receipt",
        "after_active_conflict_receipt",
        "after_conflict_awaiting_resolution",
        "after_resolution_transfer",
        "after_winner_resolution_receipt",
        "after_loser_interrupted_receipt",
        "after_session_end",
        "after_releasing",
    ),
)
@pytest.mark.asyncio
async def test_restart_converges_each_locator_boundary(recovery_fixture, fault) -> None:
    await recovery_fixture.crash_at(fault)
    restarted = recovery_fixture.restart()
    report = await restarted.recovery.recover(restarted.system_principal)

    assert report.manual_intervention_required is False
    assert await restarted.valid_locator_session_relation()


@pytest.mark.asyncio
async def test_unknown_claim_is_preserved_and_blocks_readiness(recovery_fixture) -> None:
    await recovery_fixture.claiming_without_session_or_terminal_receipt(
        "space-a", "fs-a", "start-a"
    )
    report = await recovery_fixture.recovery.recover(
        recovery_fixture.system_principal
    )

    assert report.manual_intervention_required is True
    assert report.reason == "active_session_recovery_required"
    assert (await recovery_fixture.locator()).state == "claiming"


@pytest.mark.asyncio
async def test_lost_response_recovers_on_next_request_without_restart(
    recovery_fixture,
) -> None:
    await recovery_fixture.pause_committed_then_timeout("pause-a")

    view = await recovery_fixture.coordinator.locate(
        recovery_fixture.system_principal
    )

    assert view is not None
    assert view.value["state"] == "active"
    assert await recovery_fixture.operation_phase("pause-a") == "completed"


@pytest.mark.asyncio
async def test_live_unknown_returns_typed_recovery_required(recovery_fixture) -> None:
    await recovery_fixture.unknown_claim("pause-unknown")

    with pytest.raises(AppError) as captured:
        await recovery_fixture.coordinator.locate(
            recovery_fixture.system_principal
        )

    assert captured.value.code == "active_session_recovery_required"
    assert (await recovery_fixture.locator()).state == "claiming"


@pytest.mark.asyncio
@pytest.mark.parametrize("action", ("start", "pause"))
async def test_terminal_rejection_recovery_never_activates_rejected_operation(
    recovery_fixture, action
) -> None:
    prior = await recovery_fixture.prepare_rejected_claim(action)
    restarted = recovery_fixture.restart()
    report = await restarted.recovery.recover(restarted.system_principal)

    assert report.manual_intervention_required is False
    assert await restarted.operation_phase(prior.rejected_operation_id) == "rejected"
    locator = await restarted.locator()
    if action == "start":
        assert locator is None
    else:
        assert locator.state == "active"
        assert locator.operation_id == prior.completed_operation_id
    assert not await restarted.locator_names_operation(prior.rejected_operation_id)


@pytest.mark.asyncio
async def test_recovery_report_preserves_same_session_id_in_two_spaces(
    recovery_fixture,
) -> None:
    await recovery_fixture.ambiguous_authority(
        ("space-a", "same-id"), ("space-b", "same-id")
    )
    report = await recovery_fixture.recovery.recover(
        recovery_fixture.system_principal
    )
    assert report.conflicting_session_identities == (
        ("space-a", "same-id"), ("space-b", "same-id"),
    )
    assert report.manual_intervention_required is True
```

Add restored-state tests for a locator pointing to a missing Space/Session, a releasing locator whose Session remains nonterminal, and multiple authoritative nonterminal Sessions. Every ambiguous case preserves all rows and blocks readiness.

- [ ] **Step 2: Define the recovery report and decision table**

```python
# backend/app/focus_session/recovery.py
from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class ActiveSessionRecoveryReport:
    completed_operation_ids: tuple[str, ...]
    conflicting_session_identities: tuple[tuple[str, str], ...]
    manual_intervention_required: bool
    reason: str | None


class ActiveSessionRecovery(ActiveSessionRecoveryGate):
    def __init__(self, coordination, stored_lookup, authorized_spaces, focus):
        self._singleflight = asyncio.Lock()
        # store the injected authorities; no second runtime graph

    async def recover_if_needed(self, principal: Principal) -> None:
        if not await self._coordination.has_incomplete_operation():
            return
        async with self._singleflight:
            report = await self.recover(principal)
        if report.manual_intervention_required:
            raise AppError(code="active_session_recovery_required")
```

After an authorized read-open has caused S2/S3 recovery to converge, apply this table:

| Locator state | Meta operation phase plus verified Space child facts | Recovery action |
|---|---|---|
| `claiming` | simple operation `claimed`; exact original child is terminal-success with matching nonterminal Session | finish operation and locator to `active` using the claimed epoch |
| `claiming` | end operation `claimed`; exact original child is terminal-success and the matching Session is ended | atomically advance to `releasing`/`space_committed`, then clear and complete the operation |
| `claiming` | end operation `space_committed`; matching Session is ended | transition locator to `releasing`, then clear and complete operation |
| `claiming` | terminal rejected start with no Session | clear locator and mark operation rejected |
| `claiming` | terminal rejected pause/resume/end/running-content/owner claim with matching nonterminal Session | restore `active` without changing epoch; mark rejected |
| `claiming` | provisional-conflict operation `claimed`; candidate rejection is the sole observed child, active child is absent, no child is terminal-success, and no child outcome is unknown | atomically restore the exact prior active locator/operation chain with `reject_conflict_claim`, mark the activation operation rejected with the typed descriptor, and rethrow that stable candidate rejection |
| `claiming` | provisional-conflict operation `claimed`; zero/one/two named child outcomes, with every present outcome terminal-success | query first and replay only missing replay-safe deterministic children from stored intent; after two matching terminal-success receipts, set phase `awaiting_resolution` and keep locator `claiming` |
| `claiming` | provisional-conflict operation after any terminal-success, or with hash/intent mismatch, terminal rejection outside the zero-success candidate-first case, or a still-unknown child after original-result query | preserve locator, operation, both Space facts, and all child outcomes; raise `active_session_recovery_required` without compensation or user resolution |
| `claiming` | provisional-conflict `awaiting_resolution` | return the exact persisted conflict pair for user resolution; do not finish active and do not block runtime readiness |
| `claiming` | resolution operation `transferred`; every present winner/loser child outcome terminal-success and one or both missing | query first and replay only missing replay-safe deterministic children from stored resolution intent; after two matching terminal-success receipts, finish exactly the transferred winner `active` and complete both operation rows |
| `claiming` | resolution operation with either winner/loser child terminal-rejected, hash/intent-mismatched, or still unknown after original-result query | preserve transferred locator, both operation rows, both Space histories, and all child outcomes; raise `active_session_recovery_required` and never expose the winner as active |
| `claiming` | missing/corrupt operation row, mismatched intent hash, unnamed child, or unknown original result | preserve both tables and raise `active_session_recovery_required` |
| `active` | completed matching operation plus matching nonterminal Session | keep `active` |
| `active` | matching ended Session and recoverable end operation | transition to `releasing`, then clear |
| `active` | missing/mismatched Session or operation authority | preserve and require recovery |
| `releasing` | matching end/rejection operation and proven terminal/no-Session fact | clear and complete operation |
| `releasing` | nonterminal/missing/unknown fact | preserve and require recovery |

The `after_session_end` fault case specifically persists an ended Space Session
while the Meta end operation remains `claimed`; startup and request-time
recovery must take the claimed-end row above and converge to empty without
replaying the business end command.

The Meta operation row is the recovery root. Its exact decoded intent names the
kind, target/pair, owners, epochs, payload hash, and deterministic child IDs;
recovery never derives these by scanning Sessions. For each named Space child,
the stored lookup queries the original operation ID before any execution
attempt. Recovery does not synthesize Session facts, choose an offline winner,
rewrite an epoch, or delete an ambiguous locator. `recover_if_needed` uses one
process-local single-flight lock only to collapse duplicate work; correctness
comes from Meta/Space CAS and survives multiple processes.

- [ ] **Step 3: Install recovery after S3 Space recovery and before readiness**

`bootstrap_runtime()` constructs one recovery service in the same `RuntimeServices` graph used by FastAPI and FastMCP. The order is:

```text
construct coordination store, stored lookup, and FocusSessionModule
-> construct ActiveSessionRecovery
-> construct Coordinator with that recovery gate
-> S2 prepare registered Spaces
-> S3 recover every Space under its approved lease discipline
-> TS2 inspect/recover ActiveSessionLocator operations
-> reject ambiguous restored authority
-> publish runtime ready
```

No route-local startup hook, background best-effort task, or second runtime
graph is allowed. After readiness, `locate` invokes the gate before reading the
locator; every mutating method invokes it after strict schema/hash verification
and before reading or claiming Meta. A still-unknown operation raises
`active_session_recovery_required`; `locate` never returns `None` merely because
the durable row is `claiming` or `releasing`.

- [ ] **Step 4: Run recovery, cleanup-order, and readiness tests**

Run:

```powershell
.\.venv\Scripts\python.exe -m pytest -q tests/test_active_session_recovery.py tests/test_runtime_bootstrap.py tests/test_mutation_recovery.py tests/test_space_lifecycle.py tests/test_mcp_http_lifespan.py -p no:cacheprovider
```

Expected: PASS; all proven operations converge, unknown operations remain durable, cleanup keeps primary-first errors, and neither server entrypoint reports ready on ambiguous authority.

- [ ] **Step 5: Commit locator recovery**

```powershell
git add -- app/focus_session/recovery.py app/runtime/bootstrap.py tests/test_active_session_recovery.py tests/test_runtime_bootstrap.py
git commit -m "feat(session): recover active session operations"
```

---

### Task 7: Reconcile Offline Provisional Activation Without Losing Either Session

**Files:**
- Modify: `backend/app/focus_session/coordinator.py`
- Modify: `backend/app/focus_session/policy.py`
- Modify: `backend/app/focus_session/recovery.py`
- Create: `backend/tests/test_offline_session_activation.py`

**Interfaces:**
- Consumes: TS0 `activate_provisional` and `resolve_activation_conflict` Coordinator methods, cached WorkItem versions, registered Space catalog, and public `FocusSessionModule`.
- Produces: authoritative activation, same-Session resume, explicit activation conflict, and deterministic winner/loser resolution with both histories preserved.

- [ ] **Step 1: Write the three activation outcomes and resolution tests**

```python
# backend/tests/test_offline_session_activation.py
@pytest.mark.asyncio
async def test_no_locator_promotes_provisional_to_authoritative(offline_fixture) -> None:
    view = await offline_fixture.coordinator.activate_provisional(
        offline_fixture.master,
        offline_fixture.activate_command(space_id="space-a", session_id="offline-a"),
    )
    assert view.value["kind"] == "authoritative"
    assert view.value["session"]["session"]["ownershipState"] == "authoritative"


@pytest.mark.asyncio
async def test_competing_activation_preserves_both_and_holds_effects(offline_fixture) -> None:
    await offline_fixture.active("space-a", "online-a", epoch=3)
    view = await offline_fixture.coordinator.activate_provisional(
        offline_fixture.master,
        offline_fixture.activate_command(space_id="space-b", session_id="offline-b"),
    )

    assert view.value["kind"] == "activation_conflict"
    assert set(view.value) == {"kind", "active", "candidate"}
    assert view.value["candidate"]["sessionId"] == "offline-b"
    assert view.value["candidate"]["session"]["session"]["id"] == "offline-b"
    assert await offline_fixture.sessions_exist("online-a", "offline-b")
    assert await offline_fixture.effort_seconds("online-a") == 0
    assert await offline_fixture.effort_seconds("offline-b") == 0
    assert await offline_fixture.dispatched_commands() == ()


@pytest.mark.asyncio
async def test_candidate_rejection_before_any_success_restores_prior_active(
    offline_fixture,
) -> None:
    await offline_fixture.active("space-a", "online-a", epoch=3)
    command = offline_fixture.activate_command(
        space_id="space-b", session_id="stale-offline"
    )
    offline_fixture.reject_candidate_child(
        command.command_id, code="work_item_structure_changed"
    )

    with pytest.raises(AppError) as captured:
        await offline_fixture.coordinator.activate_provisional(
            offline_fixture.master, command
        )

    assert captured.value.code == "work_item_structure_changed"
    assert await offline_fixture.locator_identity() == (
        "space-a", "online-a", 3,
    )
    assert offline_fixture.successful_conflict_children(command.command_id) == ()
    assert offline_fixture.active_child_operation(command.command_id) is None
    assert offline_fixture.operation_phase(command.command_id) == "rejected"

    before = await offline_fixture.all_durable_facts()
    with pytest.raises(AppError) as retried:
        await offline_fixture.coordinator.activate_provisional(
            offline_fixture.master, command
        )
    assert retried.value.to_safe_dict() == captured.value.to_safe_dict()
    assert await offline_fixture.all_durable_facts() == before


@pytest.mark.asyncio
async def test_locate_after_restart_returns_exact_persisted_conflict_pair(
    offline_fixture,
) -> None:
    original = await offline_fixture.persist_conflict(
        authoritative=("space-a", "online-a"),
        provisional=("space-b", "offline-b"),
        epoch=3,
    )
    restarted = await offline_fixture.restart_coordinator()

    located = await restarted.locate(offline_fixture.master)

    assert located is not None
    assert located.value == original.value
    assert located.value["kind"] == "activation_conflict"
    assert set(located.value) == {"kind", "active", "candidate"}
    assert located.value["active"]["session"]["session"]["id"] == "online-a"
    assert located.value["candidate"]["session"]["session"]["id"] == "offline-b"


@pytest.mark.asyncio
async def test_resolution_uses_persisted_role_not_caller_identity(offline_fixture) -> None:
    await offline_fixture.conflict(
        authoritative=("space-a", "online-a"),
        provisional=("space-b", "offline-b"),
        epoch=3,
    )
    command = offline_fixture.resolve_command(
        space_id=None,
        ownership_epoch=3,
        winner_role="candidate",
    )
    view = await offline_fixture.coordinator.resolve_activation_conflict(
        offline_fixture.master, command
    )

    assert view.value["kind"] == "authoritative"
    assert view.value["sessionId"] == "offline-b"
    assert (await offline_fixture.session("online-a"))["timerCompletion"] == "interrupted"
    assert await offline_fixture.sessions_exist("online-a", "offline-b")
    assert offline_fixture.locator_states_during_resolution == [
        "claiming", "claiming", "active",
    ]
    assert "empty" not in offline_fixture.locator_states_during_resolution
    assert (await offline_fixture.locator()).ownership_epoch == 4


@pytest.mark.asyncio
async def test_resolution_root_session_is_only_a_stale_locator_guard(
    offline_fixture,
) -> None:
    pair = await offline_fixture.conflict(
        authoritative=("space-a", "online-a"),
        provisional=("space-b", "offline-b"), epoch=3,
    )
    forged = offline_fixture.resolve_command(
        space_id=None, session_id="forged-root", ownership_epoch=3,
        winner_role="candidate",
    )

    with pytest.raises(AppError) as captured:
        await offline_fixture.coordinator.resolve_activation_conflict(
            offline_fixture.master, forged
        )
    assert captured.value.code == "stale_session_owner"
    assert offline_fixture.resolution_transfer_count == 0
    assert offline_fixture.resolution_child_count == 0
    assert await offline_fixture.persisted_conflict_pair() == pair


@pytest.mark.asyncio
async def test_lost_resolution_response_retries_from_journal_result(
    offline_fixture,
) -> None:
    command = await offline_fixture.resolve_committed_then_lose_response(
        winner=("space-b", "offline-b"), loser=("space-a", "online-a"), epoch=3
    )
    stored = await offline_fixture.reconstruct_operation_result(command.command_id)
    before = await offline_fixture.all_durable_facts()

    retried = await offline_fixture.coordinator.resolve_activation_conflict(
        offline_fixture.master, command
    )

    assert retried.value == stored
    assert await offline_fixture.all_durable_facts() == before

    forged = offline_fixture.flip_winner_role_and_rehash(command)
    with pytest.raises(AppError) as captured:
        await offline_fixture.coordinator.resolve_activation_conflict(
            offline_fixture.master, forged
        )
    assert captured.value.code == "idempotency_conflict"


@pytest.mark.asyncio
async def test_same_session_id_in_another_space_is_competing_not_resumed(
    offline_fixture,
) -> None:
    await offline_fixture.active("space-a", "same-id", epoch=3)
    result = await offline_fixture.coordinator.activate_provisional(
        offline_fixture.master,
        offline_fixture.activate_command(
            space_id="space-b", session_id="same-id"
        ),
    )
    assert result.value["kind"] == "activation_conflict"
    assert await offline_fixture.sessions_exist_in_spaces(
        ("space-a", "same-id"), ("space-b", "same-id")
    )
    resolved = await offline_fixture.coordinator.resolve_activation_conflict(
        offline_fixture.master,
        offline_fixture.resolve_command(
            space_id=None, ownership_epoch=3, winner_role="candidate"
        ),
    )
    assert resolved.value["spaceId"] == "space-b"
    assert resolved.value["sessionId"] == "same-id"


@pytest.mark.asyncio
async def test_same_identity_resume_is_journaled_and_exactly_retryable(
    offline_fixture,
) -> None:
    await offline_fixture.active("space-a", "same-id", epoch=3)
    command = offline_fixture.activate_command(
        space_id="space-a", session_id="same-id", operation_id="resume-same-1"
    )
    await offline_fixture.resume_committed_then_lose_response(command)
    stored = await offline_fixture.reconstruct_operation_result(command.command_id)

    retried = await offline_fixture.coordinator.activate_provisional(
        offline_fixture.master, command
    )
    assert retried.value == stored
    assert retried.value["kind"] == "resumed"
    assert retried.value["operationId"] == command.command_id
    assert (await offline_fixture.locator()).operation_id == command.command_id
    assert offline_fixture.space_mutation_count == 0
    assert offline_fixture.operation_count(command.command_id) == 1

    changed = offline_fixture.change_cached_snapshot_and_rehash(command)
    with pytest.raises(AppError) as captured:
        await offline_fixture.coordinator.activate_provisional(
            offline_fixture.master, changed
        )
    assert captured.value.code == "idempotency_conflict"


@pytest.mark.asyncio
@pytest.mark.parametrize("scenario", ("activate", "resolve"))
async def test_concurrent_same_offline_command_is_single_effect(
    offline_fixture, scenario
) -> None:
    command, invoke = await offline_fixture.prepare_concurrent_scenario(scenario)
    offline_fixture.clock.return_distinct_concurrent_values()

    first, second = await asyncio.gather(invoke(command), invoke(command))

    assert first.value == second.value
    assert offline_fixture.operation_count(command.command_id) == 1
    assert offline_fixture.operation_created_at_write_count(command.command_id) == 1
    assert offline_fixture.each_named_child_executed_once(command.command_id)


@pytest.mark.asyncio
async def test_same_space_different_sessions_reuse_one_write_handle(
    offline_fixture,
) -> None:
    await offline_fixture.active("space-a", "online-a", epoch=3)
    conflict = await offline_fixture.coordinator.activate_provisional(
        offline_fixture.master,
        offline_fixture.activate_command(space_id="space-a", session_id="offline-b"),
    )
    assert conflict.value["kind"] == "activation_conflict"
    assert offline_fixture.unique_write_space_ids_for_last_operation == ("space-a",)
    assert offline_fixture.max_concurrent_write_handles("space-a") == 1
    assert offline_fixture.last_child_receipt_roles == ("candidate", "active")

    resolved = await offline_fixture.coordinator.resolve_activation_conflict(
        offline_fixture.master,
        offline_fixture.resolve_command(
            space_id=None, ownership_epoch=3, winner_role="candidate"
        ),
    )
    assert resolved.value["sessionId"] == "offline-b"
    assert offline_fixture.unique_write_space_ids_for_last_operation == ("space-a",)
    assert offline_fixture.max_concurrent_write_handles("space-a") == 1
    assert offline_fixture.last_child_receipt_roles == ("winner", "loser")
```

- [ ] **Step 2: Validate provisional start before opening a Space**

`activate_provisional` first parses the exact TS0 `ActivateProvisionalRequest`,
maps its payload field-by-field, validates the declared hash, then requires
`command.space_id` and `ownership_epoch=None`. It accepts only the closed
nonterminal `snapshot.session + snapshot.context + snapshot.plan` shape listed
in Task 1, canonical timestamps, and the exact expected-version map. It rejects
`ended_at`, `timer_completion`, outcomes, envelopes, formal WorkItem
creation/promotion fields, unknown nested fields, and noncanonical timestamps.
It reuses the online clock/context/plan validators; it does not construct a
second provisional-only interpretation of those facts. A terminal offline
provisional Session follows the closed S4 Session-entity import path and never
claims `ActiveSessionLocator`.

Only after those checks does the Coordinator authorize and open `command.space_id`. The public Adapter passes the wire `spaceId` into `ActiveSessionCommand.space_id`; it does not hide the field inside a generic payload.

- [ ] **Step 3: Implement the three deterministic activation branches**

1. **No locator:** reserve `claiming`, call `FocusSessionModule.start` with a server-authored `activate_provisional` payload, verify cached structure/version facts in the policy, set `ownership_state=authoritative`, and finish `active`.
2. **Same locator identity:** resume only when both `command.space_id == locator.space_id` and `command.session_id == locator.session_id`, then require cached epoch/owner proof, open that exact Space, and call `FocusSessionModule.get`; the same Session ID in another Space is a competing identity, never an alias. Task 7 adds `complete_same_session_resume(intent, descriptor)` to `ActiveSessionCoordinationStore`: in one Meta transaction it inserts/idempotently verifies this `activate_provisional` operation, predicates the still-active locator's exact target/epoch/owner/operation chain, keeps `active -> active`, atomically replaces `locator.operation_id` with the current command ID, and stores a completed result descriptor for `kind="resumed"`. The returned root `operationId` is that same command ID. The descriptor references the prior locator chain's latest verified Space result operation (following heartbeat's descriptor link when necessary), so it copies no Session aggregate. A lost response retries from this journal row before current-locator rejection; changed cached snapshot/hash/guards under the same command ID are `idempotency_conflict`. No S3 Space mutation or new ownership epoch occurs.
3. **Different locator identity:** authorize both exact composite identities before Meta mutation. Derive the sorted unique Space-ID set from those persisted/caller-validated identities, preauthorize each Space without retaining a write lease, and never acquire the same non-reentrant Space runtime twice. In one Meta transaction, `begin_conflict()` inserts/verifies an `activate_provisional` operation whose canonical intent freezes both `(space_id, session_id)` identities, both owners, cached snapshot/hash, expected epoch, and every bounded child ID, then CASes the existing `active -> claiming` under that operation. Execute the candidate child first. A terminal candidate rejection proves zero child success, so the active child is not invoked and `reject_conflict_claim` atomically restores the exact prior active locator/operation chain while storing the rejection descriptor. Candidate timeout/unknown remains recoverable `claiming`; once the candidate succeeds, any later active-child rejection or unknown is partial and cannot use this rollback. Open each unique Space for write in deterministic Space-ID order; when both Sessions share one Space, reuse that one handle and execute `mark_activation_conflict:candidate` then `mark_activation_conflict:active` sequentially through the public Module. Each child keeps an independent operation ID/receipt and validates the same Meta claim and full pair. Only after both durable receipts are verified terminal-success may the operation become `awaiting_resolution`; keep the locator `claiming` and anchored to that conflict operation. Both Session records remain durable with `ownershipState="activation_conflict"`; neither contributes effort or dispatches task commands.

Authoritative and resumed activation return the Task 5 active shape with `kind="authoritative"` or `kind="resumed"`. A successful conflict resolution returns that same active shape with `kind="authoritative"`; the kind participates in the canonical response hash and completed result descriptor so lost-response reconstruction cannot omit or change it. Competing activation returns exactly `{kind: "activation_conflict", active: <active shape>, candidate: {spaceId, sessionId, session: <nested FocusSession aggregate>}}`, built from the persisted operation intent plus both verified aggregates. The candidate root uses routing `sessionId`; its nested entity remains `candidate.session.session.id`. A conflict is a normal user-decision state, so runtime readiness remains available even though the locator intentionally stays `claiming`; `locate` returns this conflict shape rather than `None`.

Task 7 replaces Task 5's provisional `row.state != "active" -> None` branch.
After request-time recovery, `locate` returns `None` only when the singleton is
absent. For `active` it keeps the Task 5 path. For `claiming` it loads the exact
operation named by `locator.operation_id`; only an `activate_provisional`
operation in `awaiting_resolution` is runtime-readable. The Coordinator
authorizes and read-opens both intent-frozen Spaces, loads both exact Sessions,
verifies their pair identity and `activation_conflict` ownership state, and
rebuilds the shape above. Any other residual `claiming`/`releasing` state,
missing aggregate, or mismatched pair raises `active_session_recovery_required`
rather than masquerading as no active Session.

Every server-authored child command uses S3 `bounded_child_operation_id` and `canonical_payload_hash` over its exact business payload. The immutable Meta intent lists those IDs before the first Space write. Fault injection at claim, either child receipt, or the `awaiting_resolution` phase leaves a fully named recoverable state; Task 6 queries/completes those same children rather than deleting, scanning, or re-pairing records. Tests inject terminal rejection independently for the candidate and former-active child, plus a success/rejection split and an original result that remains unknown. None may expose an activation-conflict choice; all preserve evidence and require operator recovery.

- [ ] **Step 4: Resolve by persisted candidates and registered-Space authorization**

The resolve payload carries only `winnerRole`, `decisionAt`, and TS0's exact
loser-invalid `validityCorrection`; it carries no candidate Session ID or
Space. The request root `sessionId` remains the locator-derived stale/CAS guard
shared by all owner-bound active commands and is never a winner selector; it
must equal the anchored locator Session before any write. The Coordinator
accepts `active|candidate`, loads the exact pair from the
locator-anchored `awaiting_resolution` Meta operation, and derives the winner
and loser composite `(space_id, session_id)` identities from that role. This is
unambiguous even when the two Session IDs are equal. It requires matching
`activation_conflict`/pending rows and rejects a scalar correction, any
alternate reason/value, an unknown role, a noncanonical decision timestamp, or
a stale/nonmatching persisted conflict before a business write. It then:

1. authorizes both persisted identities, deduplicates their sorted Space IDs, and resolves the winner owner from the conflict intent, never from caller-selected identity data; each unique Space write handle is opened once, and same-Space winner/loser children run sequentially with independent receipts;
2. in one Meta transaction, inserts/verifies the immutable resolution operation linked to the conflict operation and CAS-transfers the locator `claiming(conflict, old target, epoch=E) -> claiming(resolve, winner target, epoch=E+1)`; there is no `empty` state and therefore no ABA/start-steal window;
3. calls public `FocusSessionModule` methods with the named bounded children to mark the winner authoritative while retaining pending validity, and to end the loser as `interrupted` plus the exact invalid correction while preserving raw duration facts; both policies validate the transferred claim and persisted pair;
4. after both child receipts are independently verified terminal-success with
   matching intent/hash, atomically finish the winner locator `claiming -> active`,
   mark the resolution operation completed, and mark the old conflict operation
   resolved by this operation.

No time, plan, outcome, note, or command history is merged. A crash at any
boundary is resolved from the two Meta intents plus their original deterministic
child receipts. The locator epoch is monotonic across transfer, including when
the original active Session wins. Normal start/takeover cannot enter while an
unresolved conflict operation anchors `claiming`, and takeover cannot resolve
an activation conflict.

Resolution tests terminal-reject the winner child and loser child separately,
exercise success/rejection in both orders, and retain a post-query unknown. A
partial resolution has no automatic compensation in P0: it stays `claiming`,
keeps both raw histories and operation rows, returns
`active_session_recovery_required`, and never presents the selected winner as
authoritative.

- [ ] **Step 5: Run offline, recovery, and fencing tests**

Run:

```powershell
.\.venv\Scripts\python.exe -m pytest -q tests/test_offline_session_activation.py tests/test_active_session_coordinator.py tests/test_active_session_recovery.py tests/test_focus_session_policy.py -p no:cacheprovider
```

Expected: PASS; neither conflict record contributes duplicate effort, no command dispatch occurs while validity is pending, and resolution preserves both histories while installing exactly one active locator.

- [ ] **Step 6: Commit offline activation reconciliation**

```powershell
git add -- app/focus_session/coordinator.py app/focus_session/policy.py app/focus_session/recovery.py tests/test_offline_session_activation.py
git commit -m "feat(session): reconcile provisional activation"
```

---

### Task 8: Compose Both Policies And Mount Only The Final Adapters

**Files:**
- Modify: `backend/app/deps.py`
- Modify: `backend/app/routes/v1/contract_dependencies.py`
- Modify: `backend/app/routes/v1/__init__.py`
- Modify: `backend/app/runtime/bootstrap.py`
- Create: `backend/tests/test_focus_session_routes.py`
- Create: `backend/tests/test_active_session_routes.py`
- Modify: `backend/tests/test_openapi_contract.py`
- Modify: `frontend/src/types/api-generated.ts`

**Interfaces:**
- Consumes: TS0 routers/schemas/contracts, TS1 compiler/module, TS2 services, and one S3 composition root.
- Produces: exact Space/master route scopes, one runtime graph, compiler policies `(TaskSpaceCompiler, FocusSessionMutationPolicy)`, and regenerated camelCase OpenAPI types.

- [ ] **Step 1: Write exact path/scope/delegation tests**

```python
# backend/tests/test_focus_session_routes.py
from app.mutation.types import canonical_payload_hash


SPACE_PATHS = {
    "/api/v1/focus-sessions/{session_id}",
    "/api/v1/focus-sessions/{session_id}/review",
    "/api/v1/focus-sessions/{session_id}/commands/reconcile",
}
FORBIDDEN_SPACE_LIFECYCLE = {
    "/api/v1/focus-sessions",
    "/api/v1/focus-sessions/{session_id}/pause",
    "/api/v1/focus-sessions/{session_id}/resume",
    "/api/v1/focus-sessions/{session_id}/end",
}


def test_space_surface_is_history_review_and_reconciliation_only(openapi) -> None:
    paths = set(openapi["paths"])
    actual = {
        path for path in paths if path.startswith("/api/v1/focus-sessions")
    }
    assert actual == SPACE_PATHS
    assert FORBIDDEN_SPACE_LIFECYCLE.isdisjoint(actual)


def test_space_wire_is_camel_case(space_client, fake_focus_module) -> None:
    business_payload = {
        "validity": "valid",
        "review_state": "completed",
        "reviewed_at": "2026-07-15T09:00:00Z",
        "outcomes": (),
    }
    declared_hash = canonical_payload_hash(business_payload)
    assert declared_hash != canonical_payload_hash({
        "validity": "valid",
        "reviewState": "completed",
        "reviewedAt": "2026-07-15T09:00:00Z",
        "outcomes": (),
    })
    response = space_client.post(
        "/api/v1/focus-sessions/fs-a/review",
        json={
            "commandId": "review-a",
            "spaceId": "space-a",
            "sessionId": "fs-a",
            "ownershipEpoch": None,
            "payloadHash": declared_hash,
            "payload": {
                "expectedVersion": 3,
                "validity": "valid",
                "reviewState": "completed",
                "reviewedAt": "2026-07-15T09:00:00Z",
                "outcomes": [],
            },
        },
    )
    assert response.status_code == 200
    method, _, command = fake_focus_module.calls[-1]
    assert method == "submit_review"
    assert command.payload_hash == declared_hash
    assert command.payload["expected_version"] == 3
    assert command.payload["review_state"] == "completed"
    assert command.payload["reviewed_at"] == "2026-07-15T09:00:00Z"
    assert "expectedVersion" not in command.payload
    assert "reviewState" not in command.payload
    assert set(response.json()["session"]) >= {
        "clockState", "timerCompletion", "reviewState", "ownershipState"
    }
```

```python
# backend/tests/test_active_session_routes.py
MASTER_PATHS = {
    "/api/v1/active-session",
    "/api/v1/active-session/start",
    "/api/v1/active-session/activate-provisional",
    "/api/v1/active-session/heartbeat",
    "/api/v1/active-session/pause",
    "/api/v1/active-session/resume",
    "/api/v1/active-session/takeover",
    "/api/v1/active-session/end",
    "/api/v1/active-session/note",
    "/api/v1/active-session/plan/current",
    "/api/v1/active-session/plan/completion-draft",
    "/api/v1/active-session/plan/add",
    "/api/v1/active-session/plan/remove",
    "/api/v1/active-session/resolve-activation-conflict",
}
MASTER_ACTIONS = (
    ("post", "start", "start", 201),
    ("post", "activate-provisional", "activate_provisional", 200),
    ("post", "heartbeat", "heartbeat", 200),
    ("post", "pause", "pause", 200),
    ("post", "resume", "resume", 200),
    ("post", "takeover", "takeover", 200),
    ("post", "end", "end", 200),
    ("put", "note", "update_note", 200),
    ("post", "plan/current", "set_current_plan_item", 200),
    ("post", "plan/completion-draft", "set_completion_draft", 200),
    ("post", "plan/add", "add_plan_item", 200),
    ("post", "plan/remove", "remove_plan_item", 200),
    ("post", "resolve-activation-conflict", "resolve_activation_conflict", 200),
)


def test_master_surface_is_exact(openapi) -> None:
    actual = {
        path for path in openapi["paths"]
        if path.startswith("/api/v1/active-session")
    }
    assert actual == MASTER_PATHS


def test_master_actions_delegate_once_to_coordinator(master_client, fake_coordinator) -> None:
    for http_method, action, method, expected_status in MASTER_ACTIONS:
        body = fake_coordinator.valid_wire_body(action)
        response = getattr(master_client, http_method)(
            f"/api/v1/active-session/{action}", json=body
        )
        assert response.status_code == expected_status
    assert [call.method for call in fake_coordinator.calls] == [
        method for _, _, method, _ in MASTER_ACTIONS
    ]


@pytest.mark.parametrize("command_id", ("雪" * 64, "a" * 129, "has space"))
def test_invalid_command_id_fails_before_coordinator_or_meta(
    master_client, fake_coordinator, meta_probe, command_id
) -> None:
    body = fake_coordinator.valid_wire_body("start")
    body["commandId"] = command_id
    response = master_client.post("/api/v1/active-session/start", json=body)
    assert response.status_code == 422
    assert fake_coordinator.calls == []
    assert meta_probe.operation_and_locator_rows() == (0, 0)


def test_idempotency_header_must_equal_body_before_coordinator(
    master_client, fake_coordinator, meta_probe
) -> None:
    body = fake_coordinator.valid_wire_body("start")
    response = master_client.post(
        "/api/v1/active-session/start",
        json=body,
        headers={"Idempotency-Key": "different-command"},
    )
    assert response.status_code == 409
    assert response.json()["code"] == "idempotency_conflict"
    assert fake_coordinator.calls == []
    assert meta_probe.operation_and_locator_rows() == (0, 0)
```

The route tests assert that start and activate-provisional accept root wire `spaceId`; later lifecycle bodies reject a supplied `spaceId`. All master routes receive only `Principal` plus `ActiveSessionCommand`. No route receives or opens a Space runtime handle.

- [ ] **Step 2: Preserve TS1 while adding the FocusSession policy**

```python
# backend/app/deps.py
from app.focus_session.policy import FocusSessionMutationPolicy
from app.mutation.unit_of_work import MutationCompiler
from app.services.time import utc_now_iso_ms
from app.task_space.compiler import TaskSpaceCompiler


def get_mutation_compiler(
    catalog=Depends(get_compiled_entity_catalog),
    locator=Depends(get_active_session_locator_store),
) -> MutationCompiler:
    return MutationCompiler(
        catalog,
        policies=(
            TaskSpaceCompiler(utc_now_iso_ms),
            FocusSessionMutationPolicy(locator),
        ),
    )
```

The S3 generic catalog fallback remains built into `MutationCompiler`. TS2 appends the FocusSession policy to the already-installed TS1 policy; it never replaces the tuple with FocusSession alone. The UoW, recovery provider, Task Space Module, FocusSession Module, and both server entrypoints consume this same compiler instance graph.

- [ ] **Step 3: Install only the two concrete TS0 providers**

`contract_dependencies.py` keeps its four typed functions. TS2 replaces only:

```python
def get_focus_session_module(request: Request) -> FocusSessionModule:
    return request.app.state.runtime_services.focus_session_module


def get_active_session_coordinator(request: Request) -> ActiveSessionCoordinator:
    return request.app.state.runtime_services.active_session_coordinator
```

The runtime graph construction order is `ActiveSessionCoordinationStore` ->
stored Task Space outcome lookup -> receipt writer/reconciler ->
`DefaultFocusSessionModule` -> `ActiveSessionRecovery` ->
`DefaultActiveSessionCoordinator(recovery=..., clock=utc_now_iso_ms)`. The
composition root binds `canonical_clock = utc_now_iso_ms` once and passes that
same callable object to `TaskSpaceCompiler`, the receipt writer, recovery, and
the Coordinator; start/result descriptors and receipt timestamps therefore use
one canonical source. FastAPI and FastMCP consume the same graph. A composition
test injects a distinct-value spy clock, proves all four consumers hold that
same instance, and verifies the start CAS timestamp equals the completed result
descriptor timestamp. It also asserts the Coordinator cannot be constructed
with a second store/recovery graph and invokes request-time recovery through the
injected instance.

- [ ] **Step 4: Mount unchanged TS0 route objects and regenerate contracts**

Mount the TS0 `focus_sessions.router` at `/api/v1/focus-sessions` and `active_session.router` at `/api/v1/active-session`. Do not create alternate route classes or copy handler bodies. The Space router has Space-token scope; the active router has master-token scope.

Run:

```powershell
.\.venv\Scripts\python.exe -m pytest -q tests/test_focus_session_routes.py tests/test_active_session_routes.py tests/test_openapi_contract.py tests/test_routes_auth_spaces.py -p no:cacheprovider
pnpm --dir ..\frontend generate:api
pnpm --dir ..\frontend exec tsc --noEmit
```

Expected: PASS; OpenAPI contains only the final paths, all fields are camelCase, generated TypeScript compiles, and no legacy `/sessions` or Space lifecycle route exists.

- [ ] **Step 5: Commit composition and Adapters**

```powershell
git add -- app/deps.py app/routes/v1/contract_dependencies.py app/routes/v1/__init__.py app/runtime/bootstrap.py tests/test_focus_session_routes.py tests/test_active_session_routes.py tests/test_openapi_contract.py ..\frontend\src\types\api-generated.ts
git commit -m "feat(session): mount final focus session contracts"
```

---

### Task 9: Run The TS2 Exit Gate

**Files:**
- Modify: `backend/tests/test_focus_session_routes.py`
- Modify: `backend/tests/test_active_session_recovery.py`
- Modify: `backend/tests/test_session_command_reconciliation.py`
- Modify: `backend/tests/test_offline_session_activation.py`
- Modify: `backend/tests/test_effort_projection.py`
- Modify: `docs/superpowers/plans/2026-07-15-task-space-session-ts2-focus-session.md`

**Interfaces:**
- Consumes: all TS2 work plus approved S3/TS0/TS1 gates.
- Produces: one reproducible evidence run and a clean TS3/S4 handoff.

- [ ] **Step 1: Add static architecture guards**

The final AST/static tests must prove:

- FocusSession contract types come only from `app.focus_session.contracts`.
- Coordinator references `FocusSessionModule` but no policy/UoW concrete implementation.
- REST handlers contain no commit, SQLAlchemy session, ledger writer, policy construction, or runtime Space open.
- `clock_state` is absent from all migration/model/table declarations and persisted event payload builders.
- Space routes contain no start/pause/resume/end operation.
- master lifecycle routes contain every required action and no Space-token dependency.
- TS2 production code calls `require_payload_hash` before its first collaborator call.
- TS2 production code never assigns a complete S3 request identity to a `payload_hash` field.
- the compiler policy tuple contains both `TaskSpaceCompiler` and `FocusSessionMutationPolicy` exactly once.
- `FocusSessionMutationPolicy.entity_types` equals the exact five-key TS0 Session set, every S3 EntityCommand create/update/delete enters it, and forbidden immutable/revision operations never reach generic fallback.

- [ ] **Step 2: Run the complete focused TS2 gate**

```powershell
.\.venv\Scripts\python.exe -m pytest -q tests/test_focus_session_hash_contract.py tests/test_focus_session_policy.py tests/test_focus_session_sync_policy.py tests/test_focus_session_module.py tests/test_focus_session_revisions.py tests/test_effort_projection.py tests/test_session_command_reconciliation.py tests/test_active_session_coordinator.py tests/test_active_session_recovery.py tests/test_offline_session_activation.py tests/test_focus_session_routes.py tests/test_active_session_routes.py -p no:cacheprovider
.\.venv\Scripts\ruff.exe check --no-cache app/focus_session app/deps.py app/routes/v1/contract_dependencies.py app/routes/v1/focus_sessions.py app/routes/v1/active_session.py app/runtime/bootstrap.py tests/test_focus_session_hash_contract.py tests/test_focus_session_policy.py tests/test_focus_session_sync_policy.py tests/test_focus_session_module.py tests/test_focus_session_revisions.py tests/test_effort_projection.py tests/test_session_command_reconciliation.py tests/test_active_session_coordinator.py tests/test_active_session_recovery.py tests/test_offline_session_activation.py tests/test_focus_session_routes.py tests/test_active_session_routes.py
```

Expected: PASS with no warnings or skipped required cases.

- [ ] **Step 3: Run adjacent S0-S3, TS0, and TS1 regressions**

```powershell
.\.venv\Scripts\python.exe -m pytest -q tests/test_mutation_migration.py tests/test_mutation_journal.py tests/test_mutation_recovery.py tests/test_entity_invariants.py tests/test_entity_concurrency.py tests/test_migration_runner.py tests/test_parity_alembic_metadata.py tests/test_parity_registry_orm.py tests/test_registry_integration.py tests/test_runtime_bootstrap.py tests/test_space_lifecycle.py tests/test_task_space_project.py tests/test_task_space_tree.py tests/test_work_item_note_cas.py tests/test_work_item_note_boundary.py tests/test_openapi_contract.py -p no:cacheprovider
```

Expected: PASS; TS2 changes no S3 state machine or TS0 schema and preserves every TS1 Task Space invariant.

- [ ] **Step 4: Run the full backend and generated-contract gate**

```powershell
.\.venv\Scripts\python.exe -m pytest -q -p no:cacheprovider
pnpm --dir ..\frontend generate:api
git diff --exit-code -- ..\frontend\src\types\api-generated.ts
pnpm --dir ..\frontend exec tsc --noEmit
```

Expected: PASS; generated output is deterministic and no handwritten frontend business file changes in TS2.

- [ ] **Step 5: Record the implementation evidence and commit the gate**

Record exact commands, exit codes, test totals, and commit SHA in the TS2 execution report. Do not claim S4 Sync/MCP parity, TS3 frontend completion, S5 recovery certification, or S6 95+ certification.

```powershell
git add -- tests/test_focus_session_routes.py tests/test_active_session_recovery.py tests/test_session_command_reconciliation.py tests/test_offline_session_activation.py tests/test_effort_projection.py docs/superpowers/plans/2026-07-15-task-space-session-ts2-focus-session.md
git commit -m "test(session): close the TS2 gate"
```

## TS2 Exit Criteria

TS2 is complete only when one reviewed commit proves all of the following:

- The implementation consumes the exact TS0 generic contracts and defines no competing public command, outcome, router, or provider family.
- Start and provisional activation carry explicit wire `spaceId`; all later active actions derive the owning Space from durable state.
- Public lifecycle is master-scoped under `/active-session`; Space `/focus-sessions` is history/review/reconciliation only.
- The Coordinator authorizes every opened Space and calls only public `FocusSessionModule` methods.
- Payload hash verification uses S3 `canonical_payload_hash`/`require_payload_hash`, precedes all side effects, and remains distinct from complete internal request identity.
- `clockState` is derived from timestamps and pause facts and is never persisted.
- Start atomically creates Session, immutable context, attribution revision 1, and ordered plan snapshots.
- Pause/resume/end obey CAS, active locator epoch fencing, and legal clock transitions.
- Review and append-only revisions commit before task-command dispatch.
- Partial command success, conflict, failure, and unknown receipts remain independently visible; unknown always queries the original command first.
- Concurrent starts yield one locator; stale owners cannot mutate after takeover.
- `claiming`, `active`, and `releasing` survive every injected crash and converge only from verified Space facts and original operation receipts.
- Offline provisional activation preserves competing histories, holds effort/commands while pending, and requires explicit winner resolution.
- The production compiler retains `TaskSpaceCompiler` and adds `FocusSessionMutationPolicy` exactly once.
- All five TS0 Session business entity types are policy-owned; S4 `EntityCommand.from_sync_event()` cannot use S3 generic CRUD to rewrite immutable context/revisions or bypass plan/outcome/provisional validation.
- Focused, adjacent, full-backend, Ruff, OpenAPI generation, and TypeScript gates all pass at the same commit.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-15-task-space-session-ts2-focus-session.md`. Execute only after the reviewed S3, TS0, and TS1 commits are present:

1. **Subagent-Driven (recommended)** - dispatch a fresh implementation agent per task with specification and quality review between tasks.
2. **Inline Execution** - execute tasks in order with `superpowers:executing-plans` and stop at each review gate.
