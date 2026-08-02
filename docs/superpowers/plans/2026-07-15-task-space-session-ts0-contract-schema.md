# Task Space + FocusSession TS0 Contract And Schema Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the legacy Task/Session authority with the final Task Space + FocusSession contract, dual-database schema, compiled catalog, stable errors, API-first thin routers, deterministic OpenAPI, and generated TypeScript transport types.

**Architecture:** TS0 lands after S3 and before TS1/TS2. It owns immutable transport-neutral contracts, the `space_010_task_space_focus_session` and `meta_002_active_session_locator` revisions, ORM/catalog parity, and the breaking removal of legacy Task/Session backend surfaces. New contract routers are real thin Adapters over `TaskSpaceQueryModule`, `TaskSpaceCommandModule`, `FocusSessionModule`, and `ActiveSessionCoordinator`; TS0 tests them with injected fakes and exports them through a contract OpenAPI app, but production does not mount them until TS1/TS2 install the owning Modules.

**Tech Stack:** Python 3.13, FastAPI, Pydantic 2, SQLAlchemy 2 async, Alembic dual environments, SQLite, S2 `CompiledEntityCatalog`, S3 `EntityCommand`/`MutationUnitOfWork`, pytest, Ruff, OpenAPI TypeScript 7, TypeScript 5, Vitest.

## Global Constraints

- Implement against `docs/superpowers/specs/2026-07-15-task-space-session-integration-design.md`; its written user approval makes it the local conflict-resolution authority for TS0.
- Start only after S3 is merged and its exit gate is green at Space head `space_009_mutation_journal`.
- The Meta predecessor is `meta_001`; TS0 adds exactly `meta_002_active_session_locator`.
- There is no real user Task/Session data to migrate. Upgrade must fail closed if any legacy Task/Session row, junction row, legacy Sync ledger row, or matching tombstone exists; it must never silently discard one.
- Before startup performs `meta_002` or any Space migration, S2's fleet-wide read-only preflight must apply the TS0 cutover policy to Meta and every registered Space. If any Space rejects, Meta, earlier Spaces, Index/Notes, heads, WAL/SHM, and all rows remain byte-identical; per-Space revision checks are defense in depth, not the first discovery point.
- Breaking changes are accepted. Do not retain `/api/v1/tasks`, `/api/v1/sessions`, `task`, `session`, `taskQuickNote`, or `sessionQuickNote` aliases, redirects, dual reads, dual writes, conversion paths, or old-client compatibility.
- New model and router filenames are `backend/app/models/focus_session.py` and `backend/app/routes/v1/focus_sessions.py`; do not create a new `session.py` or `sessions.py`.
- Space database rows do not repeat `space_id`. `AuthorizedSpaceScope` is the logical Space authority; REST, Sync, MCP, commands, errors, and exported domain records carry `space_id` and reject mismatches before mutation.
- Project `key` is user-supplied at create time, normalized to uppercase by the owning Task Space Module before canonical validation, matched against `^[A-Z][A-Z0-9]{1,9}$`, and unique inside the current Space database. It is create-only and never client-patchable.
- Project `next_work_item_number` is a positive counter with initial/default value `1`. TS1 allocates the current value and increments it in the same Space-exclusive business transaction that creates the WorkItem; the resulting immutable `display_key` is exactly `{project.key}-{allocated_number}`.
- `next_work_item_number` is server-managed and never client-writable. Clients never submit, patch, reserve, or retry a `display_key`; idempotent replay returns the originally allocated WorkItem/result and must not consume another Project number.
- The Space revision creates exactly 14 final tables: `projects`, `status_definitions`, `type_definitions`, `labels`, `work_item_labels`, `work_items`, `work_item_notes`, `focus_sessions`, `session_task_contexts`, `session_attribution_revisions`, `session_work_item_plans`, `session_work_item_outcomes`, `session_command_envelopes`, and `session_command_receipts`.
- WorkItemNote is a DB-only whole-document aggregate. It does not use Markdown, KnowledgeStore, generic Note, QuickNote conversion, timestamp LWW, automatic Block merge, or CRDT.
- WorkItemNote document version 1 supports exactly `paragraph` and `checklist`; Checklist items use nested `children[]` at no more than two levels; Block and item IDs are unique within one document; array order is the sole order authority. Heading/list/rich-text Blocks, WorkItem-reference items, and Note Item promotion are absent.
- WorkItemNote writes use strict expected-version CAS. Only first creation through `ReplaceDocument` may carry `expected_version=None`; all other Note commands require an integer, and `ReplaceDocument` against an existing Note also requires its exact integer version. Checklist state never changes WorkItem status, completion, FocusSession outcome, effort, capacity, risk, Cycle, or review state.
- Register exactly 31 catalog entries after cutover. `workItemNote` uses `strict_cas`; command envelopes, receipts, and locator are not ordinary Sync-enabled LWW entities.
- Contract routers call only the injected owning Protocol. They contain no SQLAlchemy session, commit, UoW construction, storage path, status transition, CAS, idempotency, or Sync emission logic.
- `/api/v1/active-session` is master-scoped and is the only public running-lifecycle surface. Start and provisional activation carry an explicit target `spaceId` because a master token has no implicit current Space; `ActiveSessionCoordinator` authorizes and opens it internally. Later active actions resolve the owning Space from the locator. `/api/v1/focus-sessions` is Space-scoped history/review/reconciliation only and never accepts a payload-selected foreign Space.
- TS0 contract routers are not mounted by `build_v1_router()`. `backend/scripts/export_openapi.py` explicitly builds a contract app containing them. TS1/TS2 must mount these exact router objects after installing providers; they must not recreate the paths.
- A contract handler may raise only an owning-Module typed outcome mapped by the shared error Adapter. It must never return 501, a fabricated success body, or an in-memory fake outside tests.
- TS0 creates the deterministic OpenAPI exporter and tracked `frontend/openapi.json`; S4 consumes and re-verifies them instead of creating a second generator.
- Do not modify S4/S5/S6 plan files in this implementation. The TS0 exit report records that S4 must move its Space revision from 010 to 011 and its frontend Dexie revision behind TS3.
- Preserve unrelated dirty and untracked files. Every commit stages only files listed in its Task.

---

## File Responsibility Map

### Transport-neutral contracts

- `backend/app/task_space/contracts.py`: closed Task Space enums, commands, outcomes, query Protocol, command Protocol, Note document types, and stable system seed IDs; no FastAPI or SQLAlchemy imports.
- `backend/app/focus_session/contracts.py`: closed clock/review/outcome/receipt enums, explicit FocusSession Module Protocol, full ActiveSession Coordinator Protocol, generic wire-independent commands, and views; no FastAPI or SQLAlchemy imports.
- `backend/app/focus_session/receipts.py`: sole closed parser/encoder for internal reconciliation coordination stored in receipt `result_json`, plus the noncyclic public receipt projector; no UoW, router, or Task Space import.
- `backend/app/errors.py`: shared stable TS error records and mappings; transport rendering remains centralized.

### Space and Meta persistence

- `backend/app/models/project.py`: `Project` identity, canonical key, and authoritative next WorkItem number.
- `backend/app/models/work_item_definition.py`: `StatusDefinition`, `TypeDefinition`, `Label`, and `WorkItemLabel`.
- `backend/app/models/work_item.py`: `WorkItem` tree and planning row.
- `backend/app/models/work_item_note.py`: canonical document JSON plus entity CAS version.
- `backend/app/models/focus_session.py`: `FocusSession` and immutable `SessionTaskContext`.
- `backend/app/models/session_revision.py`: append-only attribution, plan, and outcome facts.
- `backend/app/models/session_command.py`: immutable command envelope and independent receipt.
- `backend/app/db/models/meta.py`: application-wide `ActiveSessionLocator` singleton.
- `backend/app/task_space/migration_preflight.py`: pure query-only TS0 cutover policy registered with S2's fleet gate and reused by the Alembic revision.
- `backend/alembic_space/versions/010_task_space_focus_session.py`: defense-in-depth call to the same empty-legacy policy, final 14-table DDL, system status/type seeds, and empty-schema downgrade.
- `backend/alembic_meta/versions/002_active_session_locator.py`: locator DDL and downgrade.

### Catalog and API contract

- `backend/app/registry/entities.py`: catalog conflict-policy metadata.
- `backend/app/registry/builtin.py`: final 31-entry registration set.
- `backend/app/schemas/task_space.py`: Project key/counter, definitions, labels, server-assigned WorkItem display key, move, transition, and query schemas.
- `backend/app/schemas/work_item_note.py`: discriminated document v1 and four Note command schemas.
- `backend/app/schemas/focus_session.py`: FocusSession, context, revision, plan, outcome, command receipt, active-locator, and action schemas.
- `backend/app/routes/v1/projects.py`: Project and definition query/command thin Adapters.
- `backend/app/routes/v1/work_items.py`: WorkItem query/command thin Adapters.
- `backend/app/routes/v1/work_item_notes.py`: WorkItemNote query/command thin Adapters.
- `backend/app/routes/v1/focus_sessions.py`: Space-scoped FocusSession history, review, and command-reconciliation thin Adapters; no running-lifecycle mutation.
- `backend/app/routes/v1/active_session.py`: master-scoped locate/start/provisional-activation/heartbeat/takeover/end/conflict thin Adapters.
- `backend/app/routes/v1/contract_dependencies.py`: four specifically typed provider dependencies; no generic command provider.
- `backend/app/contracts/openapi.py`: contract-only FastAPI app builder that mounts the thin routers for schema generation.
- `backend/scripts/export_openapi.py`: deterministic local OpenAPI export.
- `frontend/openapi.json`: tracked canonical generator input.
- `frontend/src/types/api-generated.ts`: generated output; never hand-edit.

---

### Task 1: Define Closed Domain Contracts And Stable Errors

**Files:**
- Create: `backend/app/task_space/__init__.py`
- Create: `backend/app/task_space/contracts.py`
- Create: `backend/app/focus_session/__init__.py`
- Create: `backend/app/focus_session/contracts.py`
- Create: `backend/app/focus_session/receipts.py`
- Modify: `backend/app/errors.py`
- Create: `backend/tests/test_task_space_contracts.py`
- Create: `backend/tests/test_focus_session_contracts.py`
- Modify: `backend/tests/test_error_contract_v2.py`

**Interfaces:**
- Consumes: S1 immutable JSON helpers and canonical error renderer; S2 `SpaceRuntimeHandle`; S3 immutable command identity and error mapping conventions.
- Produces: `TaskSpaceQueryModule`, `TaskSpaceCommandModule.execute(scope, command) -> TaskSpaceOutcome`, `FocusSessionModule` explicit methods, `ActiveSessionCoordinator` explicit methods, closed commands/enums, one receipt coordination/projector authority, the verified S3 `RESERVED_TS_CODES` mapping, and stable system seed IDs.

- [ ] **Step 1: Write failing Task Space contract tests**

```python
from dataclasses import fields
from typing import get_type_hints

import pytest

from app.runtime.space import SpaceRuntimeHandle
from app.task_space.contracts import (
    CreateWorkItem,
    PROJECT_KEY_PATTERN,
    SYSTEM_STATUS_IDS,
    BlockType,
    StatusCategory,
    TaskSpaceCommand,
    TaskSpaceCommandModule,
    TaskSpaceOutcome,
    TaskSpaceQueryModule,
    WorkItemNoteCommand,
    format_work_item_display_key,
    normalize_project_key,
)


def test_status_and_block_sets_are_closed() -> None:
    assert {item.value for item in StatusCategory} == {
        "not_started", "in_progress", "paused", "waiting", "completed", "cancelled"
    }
    assert {item.value for item in BlockType} == {"paragraph", "checklist"}
    assert set(SYSTEM_STATUS_IDS) == {item.value for item in StatusCategory}
    assert len(set(SYSTEM_STATUS_IDS.values())) == 6


def test_note_command_carries_cas_and_idempotency_identity() -> None:
    assert {field.name for field in fields(WorkItemNoteCommand)} == {
        "kind", "command_id", "space_id", "work_item_id",
        "expected_version", "payload_hash", "payload",
    }
    assert get_type_hints(WorkItemNoteCommand)["expected_version"] == int | None


def test_project_key_and_work_item_number_contract() -> None:
    assert PROJECT_KEY_PATTERN.fullmatch("PX12")
    assert normalize_project_key(" px12 ") == "PX12"
    assert format_work_item_display_key("PX12", 1) == "PX12-1"
    with pytest.raises(ValueError, match="project_key"):
        normalize_project_key("1PX")
    with pytest.raises(ValueError, match="work_item_number"):
        format_work_item_display_key("PX12", 0)
    assert "display_key" not in {field.name for field in fields(CreateWorkItem)}


def test_task_space_command_module_has_one_write_entrypoint() -> None:
    assert {
        name for name, value in TaskSpaceCommandModule.__dict__.items()
        if callable(value) and not name.startswith("_")
    } == {"execute"}
    assert TaskSpaceCommand.__args__
    assert TaskSpaceOutcome.__args__


def test_task_space_protocols_receive_space_runtime_handles() -> None:
    for method in (
        TaskSpaceQueryModule.list_projects,
        TaskSpaceQueryModule.get_project,
        TaskSpaceQueryModule.list_definitions,
        TaskSpaceQueryModule.list_work_items,
        TaskSpaceQueryModule.get_work_item,
        TaskSpaceQueryModule.read_note,
        TaskSpaceCommandModule.execute,
    ):
        hints = get_type_hints(
            method,
            globalns={**method.__globals__, "SpaceRuntimeHandle": SpaceRuntimeHandle},
        )
        assert hints["scope"] is SpaceRuntimeHandle
```

- [ ] **Step 2: Write failing FocusSession and error-set tests**

```python
from typing import get_type_hints

from app.errors import MUTATION_REJECTION_SPECS, RESERVED_TS_CODES
from app.focus_session.contracts import (
    ActiveSessionCoordinator,
    CommandReceiptState,
    FocusSessionModule,
    ReviewState,
)
from app.runtime.space import SpaceRuntimeHandle


def test_focus_session_interfaces_are_explicit() -> None:
    assert {
        name for name, value in FocusSessionModule.__dict__.items()
        if callable(value) and not name.startswith("_")
    } == {
        "get", "start", "pause", "resume", "end", "update_note",
        "set_current_plan_item", "set_completion_draft", "add_plan_item",
        "remove_plan_item", "submit_review", "reconcile_commands",
    }
    assert {
        name for name, value in ActiveSessionCoordinator.__dict__.items()
        if callable(value) and not name.startswith("_")
    } == {
        "locate", "start", "activate_provisional", "heartbeat", "pause",
        "resume", "takeover", "end", "update_note",
        "set_current_plan_item", "set_completion_draft", "add_plan_item",
        "remove_plan_item", "resolve_activation_conflict",
    }


def test_focus_session_protocol_receives_space_runtime_handle() -> None:
    for method in (
        FocusSessionModule.get,
        FocusSessionModule.start,
        FocusSessionModule.pause,
        FocusSessionModule.resume,
        FocusSessionModule.end,
        FocusSessionModule.update_note,
        FocusSessionModule.set_current_plan_item,
        FocusSessionModule.set_completion_draft,
        FocusSessionModule.add_plan_item,
        FocusSessionModule.remove_plan_item,
        FocusSessionModule.submit_review,
        FocusSessionModule.reconcile_commands,
    ):
        hints = get_type_hints(
            method,
            globalns={**method.__globals__, "SpaceRuntimeHandle": SpaceRuntimeHandle},
        )
        assert hints["scope"] is SpaceRuntimeHandle


def test_review_and_receipt_sets_are_closed() -> None:
    assert {item.value for item in ReviewState} == {
        "not_required", "pending", "completed", "skipped"
    }
    assert {item.value for item in CommandReceiptState} == {
        "not_needed", "pending", "succeeded", "failed", "conflict", "unknown",
        "abandoned",
    }


def test_ts0_error_codes_are_exact() -> None:
    assert RESERVED_TS_CODES == {
        "space_scope_mismatch", "version_conflict", "idempotency_conflict",
        "invalid_payload_hash", "invalid_project_key", "project_key_conflict",
        "unsupported_content_version", "invalid_note_document",
        "invalid_work_item_tree", "active_child_conflict", "active_session_exists",
        "stale_session_owner", "session_activation_conflict",
        "offline_formal_creation_forbidden", "command_result_unknown",
        "active_session_recovery_required", "work_item_structure_changed",
    }
    assert RESERVED_TS_CODES <= set(MUTATION_REJECTION_SPECS)
```

- [ ] **Step 3: Run the focused tests and verify missing contracts**

Run from `backend/`:

```powershell
.\.venv\Scripts\python.exe -m pytest -q tests/test_task_space_contracts.py tests/test_focus_session_contracts.py tests/test_error_contract_v2.py -p no:cacheprovider
```

Expected: FAIL because `app.task_space` and `app.focus_session` do not exist; if S3 omitted or changed a reserved TS code, the exact-set assertion also fails.

- [ ] **Step 4: Implement Task Space enums, commands, outcomes, and Protocols**

`backend/app/task_space/contracts.py` must contain these stable public shapes:

```python
from __future__ import annotations

import re
from dataclasses import dataclass
from enum import StrEnum
from typing import TYPE_CHECKING, Mapping, Protocol, TypeAlias

if TYPE_CHECKING:
    from app.runtime.space import SpaceRuntimeHandle


class StatusCategory(StrEnum):
    NOT_STARTED = "not_started"
    IN_PROGRESS = "in_progress"
    PAUSED = "paused"
    WAITING = "waiting"
    COMPLETED = "completed"
    CANCELLED = "cancelled"


class BlockType(StrEnum):
    PARAGRAPH = "paragraph"
    CHECKLIST = "checklist"


class NoteCommandKind(StrEnum):
    REPLACE_DOCUMENT = "replace_document"
    APPEND_BLOCKS = "append_blocks"
    TOGGLE_CHECKLIST_ITEM = "toggle_checklist_item"


SYSTEM_STATUS_IDS: Mapping[str, str] = {
    "not_started": "sys-status-not-started",
    "in_progress": "sys-status-in-progress",
    "paused": "sys-status-paused",
    "waiting": "sys-status-waiting",
    "completed": "sys-status-completed",
    "cancelled": "sys-status-cancelled",
}
SYSTEM_TYPE_ID = "sys-type-work-item"
PROJECT_KEY_PATTERN = re.compile(r"^[A-Z][A-Z0-9]{1,9}$")


def normalize_project_key(value: str) -> str:
    normalized = value.strip().upper()
    if PROJECT_KEY_PATTERN.fullmatch(normalized) is None:
        raise ValueError("project_key")
    return normalized


def format_work_item_display_key(project_key: str, number: int) -> str:
    canonical_key = normalize_project_key(project_key)
    if type(number) is not int or number < 1:
        raise ValueError("work_item_number")
    return f"{canonical_key}-{number}"


@dataclass(frozen=True)
class WorkItemNoteCommand:
    kind: NoteCommandKind
    command_id: str
    space_id: str
    work_item_id: str
    expected_version: int | None
    payload_hash: str
    payload: Mapping[str, object]

    def __post_init__(self) -> None:
        if self.expected_version is None and self.kind is not NoteCommandKind.REPLACE_DOCUMENT:
            raise ValueError("expected_version_required")


@dataclass(frozen=True)
class CreateProject:
    command_id: str
    space_id: str
    payload_hash: str
    payload: Mapping[str, object]


@dataclass(frozen=True)
class CreateWorkItem:
    command_id: str
    space_id: str
    project_id: str
    title: str
    description: str | None
    parent_id: str | None
    type_definition_id: str | None
    status_definition_id: str | None
    priority: str | None
    payload_hash: str


@dataclass(frozen=True)
class MutateWorkItem:
    command_id: str
    space_id: str
    work_item_id: str | None
    expected_version: int | None
    payload_hash: str
    payload: Mapping[str, object]


TaskSpaceCommand: TypeAlias = (
    CreateProject | CreateWorkItem | MutateWorkItem | WorkItemNoteCommand
)


@dataclass(frozen=True)
class TaskSpaceAccepted:
    command_id: str
    entity_type: str
    entity_id: str
    version: int
    value: Mapping[str, object]


@dataclass(frozen=True)
class TaskSpaceRejected:
    command_id: str
    code: str
    retryable: bool
    details: Mapping[str, object]


TaskSpaceOutcome: TypeAlias = TaskSpaceAccepted | TaskSpaceRejected


@dataclass(frozen=True)
class TaskSpacePageQuery:
    cursor: str | None
    limit: int
    filters: Mapping[str, object]


@dataclass(frozen=True)
class TaskSpacePage:
    items: tuple[Mapping[str, object], ...]
    next_cursor: str | None


@dataclass(frozen=True)
class TaskSpaceView:
    value: Mapping[str, object]


@dataclass(frozen=True)
class TaskSpaceDefinitionsView:
    statuses: tuple[Mapping[str, object], ...]
    types: tuple[Mapping[str, object], ...]
    labels: tuple[Mapping[str, object], ...]


class TaskSpaceQueryModule(Protocol):
    async def list_projects(
        self, scope: SpaceRuntimeHandle, query: TaskSpacePageQuery
    ) -> TaskSpacePage: ...
    async def get_project(
        self, scope: SpaceRuntimeHandle, project_id: str
    ) -> TaskSpaceView: ...
    async def list_definitions(
        self, scope: SpaceRuntimeHandle
    ) -> TaskSpaceDefinitionsView: ...
    async def list_work_items(
        self, scope: SpaceRuntimeHandle, query: TaskSpacePageQuery
    ) -> TaskSpacePage: ...
    async def get_work_item(
        self, scope: SpaceRuntimeHandle, work_item_id: str
    ) -> TaskSpaceView: ...
    async def read_note(
        self, scope: SpaceRuntimeHandle, work_item_id: str
    ) -> TaskSpaceView | None: ...


class TaskSpaceCommandModule(Protocol):
    async def execute(
        self, scope: SpaceRuntimeHandle, command: TaskSpaceCommand
    ) -> TaskSpaceOutcome: ...
```

The contract deliberately contains no client-authored `display_key`. Project `key` is accepted only by `CreateProject`; `next_work_item_number` is accepted by no client command, and neither field is admitted by a Project patch surface. TS1 must implement `CreateWorkItem` allocation with this exact transaction contract:

```text
inside one Space-exclusive MutationUnitOfWork for command.command_id:
  if the immutable idempotency result already exists:
    return that original WorkItem/result without reading or incrementing Project
  read Project.next_work_item_number as N and require N >= 1
  compare-and-set Project.next_work_item_number from N to N + 1
  create WorkItem.display_key as format_work_item_display_key(Project.key, N)
  insert the WorkItem and persist the immutable idempotency result
  commit the Project increment, WorkItem insert, Sync effects, and result together
```

The compare-and-set, increment, insert, and result receipt are one UoW under the same Space-exclusive business transaction. Any failure rolls all of them back. A retry after an unknown response queries the original command result first; it never reserves, skips, or consumes a second number.

`__init__.py` re-exports only the Protocols, commands, outcomes, enums, and seed constants used across TS plans.

- [ ] **Step 5: Implement FocusSession contracts**

`backend/app/focus_session/contracts.py` must define the following closed enums and exact method surface:

```python
from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum
from typing import TYPE_CHECKING, Mapping, Protocol

if TYPE_CHECKING:
    from app.auth.authority import Principal
    from app.runtime.space import SpaceRuntimeHandle


class ClockState(StrEnum):
    RUNNING = "running"
    PAUSED = "paused"
    ENDED = "ended"


class TimerCompletion(StrEnum):
    COMPLETED = "completed"
    ENDED_EARLY = "ended_early"
    INTERRUPTED = "interrupted"


class SessionValidity(StrEnum):
    PENDING = "pending"
    VALID = "valid"
    INVALID = "invalid"


class ReviewState(StrEnum):
    NOT_REQUIRED = "not_required"
    PENDING = "pending"
    COMPLETED = "completed"
    SKIPPED = "skipped"


class OwnershipState(StrEnum):
    AUTHORITATIVE = "authoritative"
    LOCAL_PROVISIONAL = "local_provisional"
    ACTIVATION_CONFLICT = "activation_conflict"


class SessionPlanSource(StrEnum):
    BEFORE_START = "before_start"
    DURING_SESSION = "during_session"
    REVIEW_MATERIALIZED = "review_materialized"


class SessionOutcomeResult(StrEnum):
    COMPLETED = "completed"
    PROGRESSED = "progressed"
    STUCK = "stuck"
    UNTOUCHED = "untouched"
    CANCELLED = "cancelled"


class SessionStateCommand(StrEnum):
    COMPLETE = "complete"
    CANCEL = "cancel"
    NONE = "none"


class ExecutionPersona(StrEnum):
    OX = "ox"
    PIG = "pig"
    HAJIMI = "hajimi"
    WUKONG = "wukong"


class OverallProgress(StrEnum):
    SMOOTH = "smooth"
    PROGRESSED = "progressed"
    STUCK = "stuck"
    INTERRUPTED = "interrupted"


class SessionMood(StrEnum):
    GREAT = "great"
    GOOD = "good"
    NORMAL = "normal"
    BAD = "bad"
    TERRIBLE = "terrible"


class CommandReceiptState(StrEnum):
    NOT_NEEDED = "not_needed"
    PENDING = "pending"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    CONFLICT = "conflict"
    UNKNOWN = "unknown"
    ABANDONED = "abandoned"


@dataclass(frozen=True)
class FocusSessionCommand:
    command_id: str
    space_id: str
    session_id: str | None
    ownership_epoch: int | None
    payload_hash: str
    payload: Mapping[str, object]


@dataclass(frozen=True)
class ActiveSessionCommand:
    command_id: str
    space_id: str | None
    session_id: str
    ownership_epoch: int | None
    payload_hash: str
    payload: Mapping[str, object]


@dataclass(frozen=True)
class FocusSessionView:
    value: Mapping[str, object]


@dataclass(frozen=True)
class ActiveSessionView:
    value: Mapping[str, object]


class FocusSessionModule(Protocol):
    async def get(
        self, scope: SpaceRuntimeHandle, session_id: str
    ) -> FocusSessionView: ...
    async def start(
        self, scope: SpaceRuntimeHandle, command: FocusSessionCommand
    ) -> FocusSessionView: ...
    async def pause(
        self, scope: SpaceRuntimeHandle, command: FocusSessionCommand
    ) -> FocusSessionView: ...
    async def resume(
        self, scope: SpaceRuntimeHandle, command: FocusSessionCommand
    ) -> FocusSessionView: ...
    async def end(
        self, scope: SpaceRuntimeHandle, command: FocusSessionCommand
    ) -> FocusSessionView: ...
    async def update_note(
        self, scope: SpaceRuntimeHandle, command: FocusSessionCommand
    ) -> FocusSessionView: ...
    async def set_current_plan_item(
        self, scope: SpaceRuntimeHandle, command: FocusSessionCommand
    ) -> FocusSessionView: ...
    async def set_completion_draft(
        self, scope: SpaceRuntimeHandle, command: FocusSessionCommand
    ) -> FocusSessionView: ...
    async def add_plan_item(
        self, scope: SpaceRuntimeHandle, command: FocusSessionCommand
    ) -> FocusSessionView: ...
    async def remove_plan_item(
        self, scope: SpaceRuntimeHandle, command: FocusSessionCommand
    ) -> FocusSessionView: ...
    async def submit_review(
        self, scope: SpaceRuntimeHandle, command: FocusSessionCommand
    ) -> FocusSessionView: ...
    async def reconcile_commands(
        self, scope: SpaceRuntimeHandle, command: FocusSessionCommand
    ) -> FocusSessionView: ...


class ActiveSessionCoordinator(Protocol):
    async def locate(self, principal: Principal) -> ActiveSessionView | None: ...
    async def start(
        self, principal: Principal, command: ActiveSessionCommand
    ) -> ActiveSessionView: ...
    async def activate_provisional(
        self, principal: Principal, command: ActiveSessionCommand
    ) -> ActiveSessionView: ...
    async def heartbeat(
        self, principal: Principal, command: ActiveSessionCommand
    ) -> ActiveSessionView: ...
    async def pause(
        self, principal: Principal, command: ActiveSessionCommand
    ) -> ActiveSessionView: ...
    async def resume(
        self, principal: Principal, command: ActiveSessionCommand
    ) -> ActiveSessionView: ...
    async def takeover(
        self, principal: Principal, command: ActiveSessionCommand
    ) -> ActiveSessionView: ...
    async def end(
        self, principal: Principal, command: ActiveSessionCommand
    ) -> ActiveSessionView: ...
    async def update_note(
        self, principal: Principal, command: ActiveSessionCommand
    ) -> ActiveSessionView: ...
    async def set_current_plan_item(
        self, principal: Principal, command: ActiveSessionCommand
    ) -> ActiveSessionView: ...
    async def set_completion_draft(
        self, principal: Principal, command: ActiveSessionCommand
    ) -> ActiveSessionView: ...
    async def add_plan_item(
        self, principal: Principal, command: ActiveSessionCommand
    ) -> ActiveSessionView: ...
    async def remove_plan_item(
        self, principal: Principal, command: ActiveSessionCommand
    ) -> ActiveSessionView: ...
    async def resolve_activation_conflict(
        self, principal: Principal, command: ActiveSessionCommand
    ) -> ActiveSessionView: ...
```

All thirteen mutating Coordinator methods consume the same transport-neutral
`ActiveSessionCommand`; no method accepts `open_target`, a filesystem/database
path, or `SpaceRuntimeHandle`. `start` and `activate_provisional` require
`space_id` and require `ownership_epoch=None`; the Coordinator validates master
access before opening that Space. Heartbeat, pause, resume, takeover, end, note,
and running-plan commands require an epoch and reject caller-selected
`space_id`, resolving it from the persisted locator. Conflict resolution
validates any selected provisional Space against the persisted conflict set.
`locate` is the only nonmutating method.
For a `ReplaceDocument` command, TS1 may accept `expected_version=None` only
when no WorkItemNote row exists; if a Note exists, it returns
`version_conflict`. `AppendBlocks` and `ToggleChecklistItem` reject a missing
expected version before mutation.

The Plan, Outcome, state-command, persona, progress, and mood enum values above
are copied from the approved upstream FocusSession contract and are public
history/Sync vocabulary. TS1-TS4 must import or generate from this authority.
Aliases such as `start|running`, `not_touched|blocked`, or `start_progress` are
not accepted because they would create a second semantic dialect.

`backend/app/focus_session/receipts.py` owns the only interpretation of the
reserved pending/unknown `result_json` projection:

```python
import json
from collections.abc import Mapping

from app.focus_session.contracts import CommandReceiptState
from app.mutation.types import validate_operation_id


def decode_json_value_or_none(raw: str | None) -> object | None:
    return None if raw is None else json.loads(raw)


def decode_json_object_or_none(raw: str | None) -> Mapping[str, object] | None:
    value = decode_json_value_or_none(raw)
    if value is None:
        return None
    if not isinstance(value, dict) or any(not isinstance(key, str) for key in value):
        raise ValueError("receipt result_json must be a JSON object")
    return value


def require_exact_string_mapping(value, keys: set[str]) -> Mapping[str, str]:
    if not isinstance(value, dict) or set(value) != keys or any(
        not isinstance(item, str) for item in value.values()
    ):
        raise ValueError("invalid reconciliation coordination projection")
    return value


RECONCILE_COORDINATION_KEY = "_reconcileCoordination"
RECONCILE_COORDINATION_KINDS = frozenset({
    "replay_claimed", "replay_finished_unknown",
})


def decode_reconcile_coordination(
    *, state: CommandReceiptState, result_json: str | None,
) -> Mapping[str, str] | None:
    decoded = decode_json_value_or_none(result_json)
    nonterminal = state in {CommandReceiptState.PENDING, CommandReceiptState.UNKNOWN}
    if decoded is None:
        return None
    if not isinstance(decoded, dict) or RECONCILE_COORDINATION_KEY not in decoded:
        if nonterminal:
            raise ValueError("nonterminal receipt result must be reconciliation coordination")
        return None
    if not nonterminal:
        raise ValueError("terminal receipt cannot carry reconciliation coordination")
    if set(decoded) != {RECONCILE_COORDINATION_KEY}:
        raise ValueError("coordination result_json cannot mix public result fields")
    value = require_exact_string_mapping(
        decoded[RECONCILE_COORDINATION_KEY], {"kind", "rootCommandId"}
    )
    if value["kind"] not in RECONCILE_COORDINATION_KINDS:
        raise ValueError("unknown reconciliation coordination kind")
    validate_operation_id(value["rootCommandId"])
    return value


def public_receipt_result(*, state, result_json):
    coordination = decode_reconcile_coordination(
        state=CommandReceiptState(str(state)), result_json=result_json
    )
    if coordination is not None or CommandReceiptState(str(state)) in {
        CommandReceiptState.PENDING, CommandReceiptState.UNKNOWN,
    }:
        return None
    return decode_json_value_or_none(result_json)


def receipt_view(row) -> Mapping[str, object]:
    state = CommandReceiptState(str(row.state))
    return {
        "commandId": row.command_id,
        "state": state.value,
        "errorCode": row.error_code,
        "retryable": row.retryable,
        "details": decode_json_value_or_none(row.details_json),
        "result": public_receipt_result(state=state, result_json=row.result_json),
        "updatedAt": row.updated_at,
    }
```

The matching encoder emits canonical UTF-8 JSON with exactly that top-level key
and two nested fields. `receipt_view(row)` in the same module calls
`public_receipt_result`; `FocusSessionQuery`, policy result projection,
reconciliation, active locate, and REST all call this one projector. No public
aggregate can contain `_reconcileCoordination` or `rootCommandId`. Malformed,
mixed, terminal-state, or unknown coordination values fail closed before a
Task Space command is compiled.

- [ ] **Step 6: Extend the one shared error map**

Verify the exact S3-owned reserved set in `backend/app/errors.py`; preserve S1/S3's canonical five-field renderer and default legacy renderer rules:

```python
RESERVED_TS_CODES = frozenset({
    "space_scope_mismatch", "version_conflict", "idempotency_conflict",
    "invalid_payload_hash",
    "invalid_project_key", "project_key_conflict",
    "unsupported_content_version", "invalid_note_document",
    "invalid_work_item_tree", "active_child_conflict",
    "active_session_exists", "stale_session_owner",
    "session_activation_conflict", "offline_formal_creation_forbidden",
    "command_result_unknown", "active_session_recovery_required",
    "work_item_structure_changed",
})
```

S3 must already provide one `MUTATION_REJECTION_SPECS` entry for every reserved code. TS0 changes no status/message/retryability value and does not claim a TS1/TS2 producer exists. If the S3 implementation differs from its approved plan, repair S3 before continuing TS0 rather than introducing a second error map.

- [ ] **Step 7: Run contract tests and Ruff**

Run from `backend/`:

```powershell
.\.venv\Scripts\python.exe -m pytest -q tests/test_task_space_contracts.py tests/test_focus_session_contracts.py tests/test_error_contract_v2.py -p no:cacheprovider
.\.venv\Scripts\ruff.exe check --no-cache app/task_space app/focus_session app/errors.py tests/test_task_space_contracts.py tests/test_focus_session_contracts.py tests/test_error_contract_v2.py
```

Expected: PASS; the enum/error sets are exact and no contract module imports FastAPI or SQLAlchemy.

- [ ] **Step 8: Commit the closed contracts**

```powershell
git add backend/app/task_space/__init__.py backend/app/task_space/contracts.py backend/app/focus_session/__init__.py backend/app/focus_session/contracts.py backend/app/errors.py backend/tests/test_task_space_contracts.py backend/tests/test_focus_session_contracts.py backend/tests/test_error_contract_v2.py
git commit -m "feat(domain): freeze task space and focus session contracts"
```

---

### Task 2: Add The Final Space Schema And ORM Models

**Files:**
- Create: `backend/alembic_space/versions/010_task_space_focus_session.py`
- Create: `backend/app/models/project.py`
- Create: `backend/app/models/work_item_definition.py`
- Create: `backend/app/models/work_item.py`
- Create: `backend/app/models/work_item_note.py`
- Create: `backend/app/models/focus_session.py`
- Create: `backend/app/models/session_revision.py`
- Create: `backend/app/models/session_command.py`
- Create: `backend/app/task_space/migration_preflight.py`
- Modify: `backend/app/runtime/bootstrap.py`
- Modify: `backend/app/models/__init__.py`
- Modify: `backend/app/db/metadata.py`
- Create: `backend/tests/test_task_space_session_migration.py`
- Modify: `backend/tests/test_migration_runner.py`
- Modify: `backend/tests/test_alembic_dual_environments.py`
- Modify: `backend/tests/test_parity_alembic_metadata.py`
- Modify: `backend/tests/test_migration_wal_durability.py`
- Modify: `backend/tests/test_space_lifecycle.py`

**Interfaces:**
- Consumes: Task 1 enums/seeds, S2 `MigrationPreflightPolicy`/`FrozenFleetPreflight`/`MigrationCoordinator`, S3 `space_009_mutation_journal`, current `SpaceBase`/`SyncMixin`, and empty-legacy cutover decision.
- Produces: registered `TaskSpaceCutoverPreflight`, Space head `space_010_task_space_focus_session`, 14 ORM tables, six deterministic status rows, one deterministic Type row, and strict DB constraints used by TS1/TS2/S4.

The migration and ORM use this locked column matrix. Every Sync business table also has `id`, `created_at`, `updated_at`, and nonnegative `version` from `SyncMixin`:

| Table | Domain columns beyond SyncMixin | Required keys/checks |
|---|---|---|
| `projects` | `key`, `next_work_item_number`, `name`, `description?`, `rank`, `default_status_definition_id`, `default_type_definition_id`, `archived_at?` | unique canonical key in this Space DB; key regex CHECK; counter `>= 1` with default 1; FKs to definitions |
| `status_definitions` | `name`, `category`, `icon?`, `color?`, `rank`, `system`, `archived_at?` | category six-value CHECK; unique category for seeded `system=1` rows |
| `type_definitions` | `name`, `icon?`, `color?`, `rank`, `system`, `archived_at?` | nonblank name; one seeded system Type ID |
| `labels` | `name`, `color?`, `archived_at?` | unique active name |
| `work_item_labels` | `work_item_id`, `label_id` | unique pair; both FKs |
| `work_items` | `project_id`, `display_key`, `title`, `description?`, `type_definition_id`, `status_definition_id`, `priority?`, `parent_id?`, `child_rank`, `completion_window_start?`, `completion_window_end?`, `review_point?`, `hard_deadline?`, `effort_estimate_lower_seconds?`, `effort_estimate_upper_seconds?`, `effort_actual_seconds`, `confidence?`, `completed_at?`, `cancelled_at?`, `archived_at?`, `marked_as_attention` | unique project/display key; parent self-FK; effort/priority/confidence CHECKs; no Note-promotion trace fields |
| `work_item_notes` | `work_item_id`, `document_json` | unique WorkItem FK; canonical document JSON |
| `focus_sessions` | `session_revision`, `started_at`, `ended_at?`, `pause_started_at?`, `planned_seconds`, `gross_seconds`, `paused_seconds`, `break_seconds`, `focused_seconds`, `timer_completion?`, `validity`, `validity_reason?`, `overall_progress?`, `mood?`, `session_note`, `review_state`, `ownership_state` | revision/durations nonnegative; closed enum CHECKs; no stored `clock_state` |
| `session_task_contexts` | `session_id`, `project_id`, `level2_work_item_id`, title/parent/estimate/status/structure snapshots, `linked_at`, `link_method` | unique Session; immutable in TS2; explicit/contextual-confirmed CHECK |
| `session_attribution_revisions` | `session_id`, `revision`, `project_id`, `level2_work_item_id`, `reason?`, `corrected_from_revision?`, `effective` | unique Session/revision; one partial-unique effective row |
| `session_work_item_plans` | `session_id`, `work_item_id`, title/level-2 snapshots, `plan_rank`, `source`, `added_at`, `removed_at?`, `removal_reason?`, `current_during_session`, `completion_draft` | source CHECK; nonnegative rank; same Session/WorkItem uniqueness while active |
| `session_work_item_outcomes` | `session_id`, `session_revision`, `revision`, `corrected_from_revision?`, `effective`, `work_item_id`, `touched`, `result`, persona fields, `state_command`, `command_id?`, `reviewed_at?` | unique Session/WorkItem/revision; one partial-unique effective row; closed result/persona/command CHECKs |
| `session_command_envelopes` | explicit `command_id` PK, `space_id`, `session_id`, `session_revision`, `work_item_id`, `expected_version`, `target_transition`, server-declared `replay_safe`, `payload_hash`, `created_at` | immutable; unique command ID; `target_transition IN ('complete','cancel')`; nonnegative versions; Boolean replay declaration; hash format CHECK |
| `session_command_receipts` | explicit `command_id` PK/FK, `state`, `error_code?`, `retryable?`, `details_json?`, `result_json?`, `updated_at` | seven-state CHECK including terminal `abandoned`; one receipt per envelope; pending/unknown `result_json` may contain only the closed internal replay coordination projection |

- [ ] **Step 1: Write failing revision, table, seed, and empty-legacy tests**

```python
import sqlite3

import pytest

from app.db.migrations import run_migrations
from app.task_space.contracts import SYSTEM_STATUS_IDS, SYSTEM_TYPE_ID


FINAL_TABLES = {
    "projects", "status_definitions", "type_definitions", "labels",
    "work_item_labels", "work_items", "work_item_notes", "focus_sessions",
    "session_task_contexts", "session_attribution_revisions",
    "session_work_item_plans", "session_work_item_outcomes",
    "session_command_envelopes", "session_command_receipts",
}
LEGACY_TABLES = {"tasks", "sessions", "task_quick_notes", "session_quick_notes"}


def test_space_010_creates_exact_final_tables_and_seeds(tmp_path) -> None:
    path = tmp_path / "space.db"
    run_migrations("space", path)
    with sqlite3.connect(path) as conn:
        tables = {
            row[0] for row in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            )
        }
        assert FINAL_TABLES <= tables
        assert LEGACY_TABLES.isdisjoint(tables)
        statuses = dict(conn.execute("SELECT category, id FROM status_definitions"))
        assert statuses == dict(SYSTEM_STATUS_IDS)
        assert conn.execute(
            "SELECT id FROM type_definitions WHERE system = 1"
        ).fetchone() == (SYSTEM_TYPE_ID,)
        assert conn.execute(
            "SELECT version_num FROM alembic_version_space"
        ).fetchone() == ("space_010_task_space_focus_session",)


def test_space_010_rejects_nonempty_legacy_authority(space_at_009) -> None:
    with sqlite3.connect(space_at_009) as conn:
        conn.execute(
            "INSERT INTO tasks (id,title,description,status,priority,tags,plan,completion,estimated_pomodoros,actual_pomodoros,created_at,updated_at,version) "
            "VALUES ('legacy','x','','todo','medium','[]','','',1,0,'2026-01-01T00:00:00Z','2026-01-01T00:00:00.000Z',1)"
        )
        conn.commit()
    with pytest.raises(RuntimeError, match="breaking_cutover_requires_empty_legacy"):
        run_migrations("space", space_at_009)


@pytest.mark.asyncio
async def test_ts0_fleet_preflight_rejects_late_space_before_meta_or_space_ddl(
    startup_fleet_fixture,
) -> None:
    fleet = startup_fleet_fixture(
        meta_head="meta_001",
        spaces={"a": "space_009_mutation_journal", "b": "space_009_mutation_journal"},
        legacy_rows={"b": {"tasks": 1}},
    )
    before = fleet.complete_raw_and_logical_inventory()

    with pytest.raises(RuntimeError, match="breaking_cutover_requires_empty_legacy:tasks"):
        await fleet.bootstrap()

    assert fleet.migration_calls == []
    assert fleet.complete_raw_and_logical_inventory() == before
    assert fleet.heads() == {
        "meta": "meta_001",
        "a": "space_009_mutation_journal",
        "b": "space_009_mutation_journal",
    }


def test_project_key_and_counter_constraints_are_database_enforced(space_at_010) -> None:
    insert = (
        "INSERT INTO projects "
        "(id,key,next_work_item_number,name,rank,default_status_definition_id,"
        "default_type_definition_id,created_at,updated_at,version) "
        "VALUES (?,?,?,?,?,?,?,?,?,?)"
    )
    common = (
        "Project", 0, "sys-status-not-started", "sys-type-work-item",
        "2026-07-15T00:00:00Z", "2026-07-15T00:00:00.000Z", 1,
    )
    with sqlite3.connect(space_at_010) as conn:
        conn.execute(insert, ("p1", "PX", 1, *common))
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute(insert, ("p2", "PX", 1, *common))
        for offset, invalid_key in enumerate(("px", "1PX", "P-X", "P", "P1234567890"), 3):
            with pytest.raises(sqlite3.IntegrityError):
                conn.execute(insert, (f"p{offset}", invalid_key, 1, *common))
        for offset, invalid_counter in enumerate((None, 0, -1), 20):
            with pytest.raises(sqlite3.IntegrityError):
                conn.execute(insert, (f"p{offset}", f"N{offset}", invalid_counter, *common))
        default_value = conn.execute(
            "SELECT dflt_value FROM pragma_table_info('projects') "
            "WHERE name='next_work_item_number'"
        ).fetchone()
        assert default_value == ("1",)
        conn.execute(
            "INSERT INTO projects "
            "(id,key,name,rank,default_status_definition_id,default_type_definition_id,"
            "created_at,updated_at,version) VALUES (?,?,?,?,?,?,?,?,?)",
            ("p-default", "DF", *common),
        )
        assert conn.execute(
            "SELECT next_work_item_number FROM projects WHERE id='p-default'"
        ).fetchone() == (1,)
```

Add parameterized cases for a legacy Session, both legacy junctions,
`sync_outbox.entity_type` in the internal or wire legacy key set, matching
tombstones, a nonterminal S3 mutation operation, a `FAILED_MANUAL` batch, and a
terminal command/result JSON tree containing a removed entity/table key. Every
rejection must leave the Alembic head and all old rows unchanged. The fleet case
uses S5's complete inventory algorithm over `meta.db`, every registered
`space.db`/`index.db`, Notes, and SQLite sidecars; the late Space rejection must
therefore prove byte equality for Meta and the earlier clean Space, not only the
failing database. A clean
journal and unrelated finalized operations must pass.

- [ ] **Step 2: Run migration tests and verify the missing revision**

Run from `backend/`:

```powershell
.\.venv\Scripts\python.exe -m pytest -q tests/test_task_space_session_migration.py tests/test_migration_runner.py tests/test_alembic_dual_environments.py -p no:cacheprovider
```

Expected: FAIL because `010_task_space_focus_session.py` and the final tables do not exist.

- [ ] **Step 3: Implement the seven focused ORM files**

Use `SyncMixin` for the 12 Sync business rows. `SessionCommandEnvelope` and `SessionCommandReceipt` declare explicit IDs/timestamps because they are protocol infrastructure. The essential column and constraint shape is:

```python
class Project(Base, SyncMixin):
    __tablename__ = "projects"
    key: Mapped[str] = mapped_column(String(10), nullable=False)
    next_work_item_number: Mapped[int] = mapped_column(
        Integer, nullable=False, default=1, server_default="1"
    )
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    rank: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    default_status_definition_id: Mapped[str] = mapped_column(String(36), nullable=False)
    default_type_definition_id: Mapped[str] = mapped_column(String(36), nullable=False)
    archived_at: Mapped[str | None] = mapped_column(String(32), nullable=True)
    __table_args__ = (
        UniqueConstraint("key", name="uq_projects_key"),
        CheckConstraint(
            "length(key) BETWEEN 2 AND 10 AND "
            "substr(key, 1, 1) GLOB '[A-Z]' AND "
            "key NOT GLOB '*[^A-Z0-9]*'",
            name="key_format",
        ),
        CheckConstraint(
            "next_work_item_number >= 1", name="next_work_item_number_positive"
        ),
    )


class WorkItem(Base, SyncMixin):
    __tablename__ = "work_items"
    project_id: Mapped[str] = mapped_column(String(36), nullable=False, index=True)
    display_key: Mapped[str] = mapped_column(String(64), nullable=False)
    title: Mapped[str] = mapped_column(String(500), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    type_definition_id: Mapped[str] = mapped_column(String(36), nullable=False)
    status_definition_id: Mapped[str] = mapped_column(String(36), nullable=False)
    priority: Mapped[str | None] = mapped_column(String(20), nullable=True)
    parent_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    child_rank: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    completion_window_start: Mapped[str | None] = mapped_column(String(32), nullable=True)
    completion_window_end: Mapped[str | None] = mapped_column(String(32), nullable=True)
    review_point: Mapped[str | None] = mapped_column(String(32), nullable=True)
    hard_deadline: Mapped[str | None] = mapped_column(String(32), nullable=True)
    effort_estimate_lower_seconds: Mapped[int | None] = mapped_column(Integer, nullable=True)
    effort_estimate_upper_seconds: Mapped[int | None] = mapped_column(Integer, nullable=True)
    effort_actual_seconds: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    confidence: Mapped[str | None] = mapped_column(String(20), nullable=True)
    completed_at: Mapped[str | None] = mapped_column(String(32), nullable=True)
    cancelled_at: Mapped[str | None] = mapped_column(String(32), nullable=True)
    archived_at: Mapped[str | None] = mapped_column(String(32), nullable=True)
    marked_as_attention: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    __table_args__ = (
        UniqueConstraint("project_id", "display_key", name="uq_work_items_project_display_key"),
        CheckConstraint("priority IS NULL OR priority IN ('low','medium','high','urgent')", name="priority"),
        CheckConstraint("confidence IS NULL OR confidence IN ('low','medium','high')", name="confidence"),
        CheckConstraint("effort_actual_seconds >= 0", name="effort_actual_nonnegative"),
        CheckConstraint(
            "(effort_estimate_lower_seconds IS NULL AND effort_estimate_upper_seconds IS NULL) OR "
            "(effort_estimate_lower_seconds >= 0 AND effort_estimate_upper_seconds > 0 AND "
            "effort_estimate_lower_seconds <= effort_estimate_upper_seconds)",
            name="effort_range",
        ),
    )


class WorkItemNote(Base, SyncMixin):
    __tablename__ = "work_item_notes"
    work_item_id: Mapped[str] = mapped_column(String(36), nullable=False, unique=True)
    document_json: Mapped[str] = mapped_column(Text, nullable=False)
```

`work_item_definition.py` defines `StatusDefinition(category,name,icon,color,rank,system,archived_at)`, `TypeDefinition(name,icon,color,rank,system,archived_at)`, `Label(name,color,archived_at)`, and `WorkItemLabel(work_item_id,label_id)` with a unique `(work_item_id,label_id)` pair. `focus_session.py` defines all §10 axes as independent columns; `clock_state` is not stored, while `pause_started_at`, timestamps, and nonnegative duration totals permit reconstruction. `SessionTaskContext.session_id` is unique and immutable by TS2.

`session_revision.py` defines unique `(session_id, revision)` attribution rows, unique `(session_id, work_item_id, revision)` outcome rows, plan snapshots, and partial unique indexes for one effective attribution and one effective outcome per Session/WorkItem. `session_command.py` stores the immutable envelope fields from §12 and a one-to-one receipt whose state is the seven-value receipt enum, including immutable user-decided `abandoned`.

The Alembic revision must use the same named `uq_projects_key`, `key_format`,
and `next_work_item_number_positive` constraints and the same server default
`1`. `test_parity_alembic_metadata.py` compares their names,
expressions/nullability, uniqueness, and defaults between upgraded SQLite
metadata and `Project.__table__`; it also proves the WorkItem
`(project_id, display_key)` uniqueness constraint is present in both
authorities and no Note-promotion source column exists.

- [ ] **Step 4: Implement the fleet-registered and defense-in-depth cutover preflight**

Put the pure query-only check in `app/task_space/migration_preflight.py`. S2's
fleet gate calls it for every Space before any database is migrated; the Space
revision calls the same function again at the top of `upgrade()` as defense in
depth before local DDL:

```python
import json
from collections.abc import Mapping, Sequence


LEGACY_ENTITY_TYPES = (
    "task", "session", "taskQuickNote", "sessionQuickNote",
    "task_quick_note", "session_quick_note",
)
LEGACY_TABLES = ("tasks", "sessions", "task_quick_notes", "session_quick_notes")
SAFE_MUTATION_TERMINALS = ("FINALIZED", "ABORTED", "COMPENSATED")


def _contains_removed_authority(value: object) -> bool:
    removed = frozenset((*LEGACY_ENTITY_TYPES, *LEGACY_TABLES))
    if isinstance(value, str):
        return value in removed
    if isinstance(value, Mapping):
        return any(
            _contains_removed_authority(key) or _contains_removed_authority(item)
            for key, item in value.items()
        )
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        return any(_contains_removed_authority(item) for item in value)
    return False


def require_empty_legacy_authority(connection: Connection) -> None:
    terminal_marks = ",".join("?" for _ in SAFE_MUTATION_TERMINALS)
    if connection.exec_driver_sql(
        f"SELECT 1 FROM mutation_batches WHERE state NOT IN ({terminal_marks}) LIMIT 1",
        SAFE_MUTATION_TERMINALS,
    ).first() or connection.exec_driver_sql(
        f"SELECT 1 FROM mutation_operations WHERE state NOT IN ({terminal_marks}) LIMIT 1",
        SAFE_MUTATION_TERMINALS,
    ).first():
        raise RuntimeError("breaking_cutover_requires_clean_mutation_journal")
    journal_rows = connection.exec_driver_sql(
        "SELECT command_json, db_before_json, db_after_json, result_json "
        "FROM mutation_operations"
    )
    for row in journal_rows:
        for raw in row:
            if raw is not None and _contains_removed_authority(json.loads(raw)):
                raise RuntimeError(
                    "breaking_cutover_requires_empty_legacy:mutation_journal"
                )
    for table in LEGACY_TABLES:
        if connection.exec_driver_sql(f'SELECT 1 FROM "{table}" LIMIT 1').first():
            raise RuntimeError(f"breaking_cutover_requires_empty_legacy:{table}")
    marks = ",".join("?" for _ in LEGACY_ENTITY_TYPES)
    if connection.exec_driver_sql(
        f"SELECT 1 FROM sync_outbox WHERE entity_type IN ({marks}) LIMIT 1",
        LEGACY_ENTITY_TYPES,
    ).first():
        raise RuntimeError("breaking_cutover_requires_empty_legacy:sync_outbox")
    if connection.exec_driver_sql(
        f"SELECT 1 FROM tombstones WHERE entity_type IN ({marks}) LIMIT 1",
        LEGACY_ENTITY_TYPES,
    ).first():
        raise RuntimeError("breaking_cutover_requires_empty_legacy:tombstones")


class TaskSpaceCutoverPreflight(MigrationPreflightPolicy):
    kind = "space"
    target_revision = "space_010_task_space_focus_session"

    def inspect_read_only(self, connection: Connection) -> None:
        require_empty_legacy_authority(connection)
```

Use bound parameters accepted by the migration connection; do not interpolate
an entity value. The table identifiers and terminal-state placeholders are
closed migration constants, not caller input. The S2 migration coordinator runs
the registered `TaskSpaceCutoverPreflight` across the whole frozen fleet before
Meta migration or S3 recovery. The policy rejects unresolved/manual-failure
journal rows and parses JSON structurally rather than using a substring search.
Only after every read-only probe passes may ordinary S3 recovery and Alembic run.
`010_task_space_focus_session.upgrade()` invokes
`require_empty_legacy_authority(op.get_bind())` again before its first DDL; that
local check cannot authorize a startup that skipped or only partially completed
the fleet gate.

- [ ] **Step 5: Create the 14 tables, drop legacy storage, and seed definitions**

The migration order is definitions → Project → WorkItem → Note → FocusSession → snapshots/revisions → commands. Create named PK, unique, FK, CHECK, and query indexes matching ORM metadata. Then drop `task_quick_notes`, `session_quick_notes`, `tasks`, and `sessions`; remove `quick_notes.session_id`, `time_blocks.task_id`, `reflections.related_task_ids`, and `reflections.auto_linked_session_ids` using SQLite batch alteration. Insert the stable rows with explicit timestamps and `version=1`:

```python
SYSTEM_STATUSES = (
    ("sys-status-not-started", "Not started", "not_started", 0),
    ("sys-status-in-progress", "In progress", "in_progress", 1),
    ("sys-status-paused", "Paused", "paused", 2),
    ("sys-status-waiting", "Waiting", "waiting", 3),
    ("sys-status-completed", "Completed", "completed", 4),
    ("sys-status-cancelled", "Cancelled", "cancelled", 5),
)
SYSTEM_TYPE = ("sys-type-work-item", "Work item", 0)
SEED_TIME = "2026-07-15T00:00:00.000Z"
```

`downgrade()` first refuses any non-seed row in the 14 TS0 tables, then removes all 14 tables and recreates the empty legacy tables/columns at the exact `space_009_mutation_journal` schema. The deterministic seed rows disappear with their owning definition tables. Downgrade is an empty-schema rollback; backup/restore is the data-bearing rollback path.

- [ ] **Step 6: Register all ORM models with Space metadata**

Update `backend/app/models/__init__.py` to export the 14 classes and remove `Task`, legacy `Session`, `TaskQuickNote`, and `SessionQuickNote`. Keep `get_space_metadata()` importing `app.models`; add a parity assertion that its table set equals the upgraded Space schema.

- [ ] **Step 7: Run migration, parity, WAL, and lifecycle tests**

Run from `backend/`:

```powershell
.\.venv\Scripts\python.exe -m pytest -q tests/test_task_space_session_migration.py tests/test_migration_runner.py tests/test_alembic_dual_environments.py tests/test_parity_alembic_metadata.py tests/test_migration_wal_durability.py tests/test_space_lifecycle.py -p no:cacheprovider
.\.venv\Scripts\ruff.exe check --no-cache app/models app/task_space/migration_preflight.py app/runtime/bootstrap.py alembic_space/versions/010_task_space_focus_session.py tests/test_task_space_session_migration.py tests/test_parity_alembic_metadata.py
```

Expected: PASS; fresh and 009-empty upgrades reach 010, a late nonempty Space makes the whole fleet fail before Meta/Space DDL with byte-identical inventory, direct migration keeps the same defense-in-depth rejection, ORM/Alembic constraints match, and WAL durability remains proven.

- [ ] **Step 8: Commit the final Space schema**

```powershell
git add backend/alembic_space/versions/010_task_space_focus_session.py backend/app/task_space/migration_preflight.py backend/app/runtime/bootstrap.py backend/app/models/project.py backend/app/models/work_item_definition.py backend/app/models/work_item.py backend/app/models/work_item_note.py backend/app/models/focus_session.py backend/app/models/session_revision.py backend/app/models/session_command.py backend/app/models/__init__.py backend/app/db/metadata.py backend/tests/test_task_space_session_migration.py backend/tests/test_migration_runner.py backend/tests/test_alembic_dual_environments.py backend/tests/test_parity_alembic_metadata.py backend/tests/test_migration_wal_durability.py backend/tests/test_space_lifecycle.py
git commit -m "feat(schema): add final task space and focus session tables"
```

---

### Task 3: Add The Application-Wide ActiveSession Coordination Schema

**Files:**
- Create: `backend/alembic_meta/versions/002_active_session_locator.py`
- Modify: `backend/app/db/models/meta.py`
- Modify: `backend/app/db/models/__init__.py`
- Create: `backend/tests/test_active_session_locator_migration.py`
- Modify: `backend/tests/test_meta_db.py`
- Modify: `backend/tests/test_parity_alembic_metadata.py`
- Modify: `backend/tests/test_alembic_dual_environments.py`

**Interfaces:**
- Consumes: Meta head `meta_001`, S2 Meta migration authority, and Task 1 ownership vocabulary.
- Produces: `ActiveSessionLocator` singleton plus internal `ActiveSessionOperation` journal tables/ORM classes consumed by TS2 `ActiveSessionCoordinator` and recovery.

- [ ] **Step 1: Write failing Meta migration and singleton tests**

```python
import sqlite3

import pytest

from app.db.migrations import run_migrations


def test_meta_002_creates_one_locator_slot(tmp_path) -> None:
    path = tmp_path / "meta.db"
    run_migrations("meta", path)
    with sqlite3.connect(path) as conn:
        columns = {
            row[1] for row in conn.execute("PRAGMA table_info(active_session_locator)")
        }
        assert columns == {
            "singleton_key", "space_id", "session_id", "operation_id", "state",
            "owner_device_id", "owner_tab_id", "ownership_epoch",
            "lease_expires_at", "updated_at",
        }
        operation_columns = {
            row[1] for row in conn.execute(
                "PRAGMA table_info(active_session_operations)"
            )
        }
        assert operation_columns == {
            "operation_id", "kind", "payload_hash", "intent_json", "phase",
            "result_descriptor_json", "related_operation_id", "created_at", "updated_at",
        }
        assert conn.execute(
            "SELECT version_num FROM alembic_version_meta"
        ).fetchone() == ("meta_002_active_session_locator",)


def test_locator_constraints_reject_second_slot_and_non_positive_epoch(meta_at_002) -> None:
    with sqlite3.connect(meta_at_002) as conn:
        conn.execute(
            "INSERT INTO active_session_locator VALUES (?,?,?,?,?,?,?,?,?,?)",
            ("active", "s1", "fs1", "op1", "active", "d1", "t1", 1,
             "2026-07-15T00:01:00.000Z", "2026-07-15T00:00:00.000Z"),
        )
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute(
                "INSERT INTO active_session_locator VALUES (?,?,?,?,?,?,?,?,?,?)",
                ("other", "s2", "fs2", "op2", "active", "d2", "t2", 1,
                 "2026-07-15T00:01:00.000Z", "2026-07-15T00:00:00.000Z"),
            )
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute(
                "UPDATE active_session_locator SET ownership_epoch = 0"
            )
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute(
                "UPDATE active_session_locator SET ownership_epoch = -1"
            )


def test_operation_result_descriptor_is_bounded(meta_at_002) -> None:
    with sqlite3.connect(meta_at_002) as conn:
        conn.execute(
            "INSERT INTO active_session_operations "
            "(operation_id,kind,payload_hash,intent_json,phase,"
            "result_descriptor_json,related_operation_id,created_at,updated_at) "
            "VALUES (?,?,?,?,?,?,?,?,?)",
            ("op-exact", "start", "0" * 64, "{}", "completed", "x" * 8192,
             None, "2026-07-15T00:00:00.000Z",
             "2026-07-15T00:00:00.000Z"),
        )
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute(
                "INSERT INTO active_session_operations "
                "(operation_id,kind,payload_hash,intent_json,phase,"
                "result_descriptor_json,related_operation_id,created_at,updated_at) "
                "VALUES (?,?,?,?,?,?,?,?,?)",
                ("op-large", "start", "0" * 64, "{}", "completed", "x" * 8193,
                 None, "2026-07-15T00:00:00.000Z",
                 "2026-07-15T00:00:00.000Z"),
            )
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute(
                "INSERT INTO active_session_operations "
                "(operation_id,kind,payload_hash,intent_json,phase,"
                "result_descriptor_json,related_operation_id,created_at,updated_at) "
                "VALUES (?,?,?,?,?,?,?,?,?)",
                ("op-multibyte", "start", "0" * 64, "{}", "completed",
                 "雪" * 2731, None, "2026-07-15T00:00:00.000Z",
                 "2026-07-15T00:00:00.000Z"),
            )
```

- [ ] **Step 2: Run Meta tests and verify the missing revision**

Run from `backend/`:

```powershell
.\.venv\Scripts\python.exe -m pytest -q tests/test_active_session_locator_migration.py tests/test_meta_db.py tests/test_alembic_dual_environments.py -p no:cacheprovider
```

Expected: FAIL because Meta head remains `meta_001` and the locator table is absent.

- [ ] **Step 3: Implement Meta ORM and DDL**

Add this class to `backend/app/db/models/meta.py`:

```python
class ActiveSessionLocator(MetaBase):
    __tablename__ = "active_session_locator"

    singleton_key: Mapped[str] = mapped_column(
        String(16), primary_key=True, default="active", server_default="active"
    )
    space_id: Mapped[str] = mapped_column(String(36), nullable=False)
    session_id: Mapped[str] = mapped_column(String(36), nullable=False)
    operation_id: Mapped[str] = mapped_column(String(128), nullable=False)
    state: Mapped[str] = mapped_column(String(20), nullable=False)
    owner_device_id: Mapped[str] = mapped_column(String(64), nullable=False)
    owner_tab_id: Mapped[str] = mapped_column(String(64), nullable=False)
    ownership_epoch: Mapped[int] = mapped_column(Integer, nullable=False)
    lease_expires_at: Mapped[str] = mapped_column(String(32), nullable=False)
    updated_at: Mapped[str] = mapped_column(String(32), nullable=False)

    __table_args__ = (
        CheckConstraint("singleton_key = 'active'", name="single_active_slot"),
        CheckConstraint("state IN ('claiming','active','releasing')", name="state"),
        CheckConstraint("ownership_epoch > 0", name="ownership_epoch_positive"),
    )


class ActiveSessionOperation(MetaBase):
    __tablename__ = "active_session_operations"

    operation_id: Mapped[str] = mapped_column(String(128), primary_key=True)
    kind: Mapped[str] = mapped_column(String(40), nullable=False)
    payload_hash: Mapped[str] = mapped_column(String(64), nullable=False)
    intent_json: Mapped[str] = mapped_column(Text, nullable=False)
    phase: Mapped[str] = mapped_column(String(32), nullable=False)
    result_descriptor_json: Mapped[str | None] = mapped_column(Text)
    related_operation_id: Mapped[str | None] = mapped_column(String(128))
    created_at: Mapped[str] = mapped_column(String(32), nullable=False)
    updated_at: Mapped[str] = mapped_column(String(32), nullable=False)

    __table_args__ = (
        CheckConstraint(
            "kind IN ('start','heartbeat','pause','resume','end','takeover',"
            "'update_note','set_current_plan_item','set_completion_draft',"
            "'add_plan_item','remove_plan_item','activate_provisional',"
            "'resolve_activation_conflict')",
            name="active_session_operation_kind",
        ),
        CheckConstraint(
            "phase IN ('prepared','claimed','space_committed',"
            "'awaiting_resolution','transferred','completed','rejected',"
            "'manual_intervention')",
            name="active_session_operation_phase",
        ),
        CheckConstraint(
            "payload_hash NOT GLOB '*[^0-9a-f]*' AND length(payload_hash) = 64",
            name="active_session_operation_hash",
        ),
        CheckConstraint(
            "result_descriptor_json IS NULL OR "
            "length(CAST(result_descriptor_json AS BLOB)) <= 8192",
            name="active_session_operation_result_descriptor_size",
        ),
    )
```

The migration creates the same columns/constraints and indexes locator
`space_id`, `session_id`, `operation_id`, and `lease_expires_at`, plus operation
`kind`, `phase`, and `related_operation_id`. It does not preseed a locator row;
TS2 changes locator and operation rows in the same Meta transaction.
`intent_json` is canonical JSON decoded by an exact kind-specific model; it is
never exposed as an open request payload. Reusing an operation ID with a
different `kind`, `payload_hash`, or canonical intent is an idempotency
conflict. `result_descriptor_json` is null until a response becomes durable,
then contains an immutable, canonical, at-most-8-KiB descriptor: response schema
version/kind, Meta-owned locator projection, intent-named Space/Session/child
operation references, and the SHA-256 of the fully assembled canonical response.
It contains no Session note, plan, outcome, envelope, receipt, or other
Space-owned business value. A phase transition that makes a response returnable
writes the descriptor in the same Meta transaction as its locator CAS; neither
a route nor a caller can supply it. Terminal operation rows and returnable
conflict rows are retained through the S5 recovery/backup window. Exact retries
reauthorize every referenced Space, read the original S3 operation result,
reassemble and hash-check the response, and fail with
`active_session_recovery_required` on missing/corrupt evidence rather than
copying or inferring newer Space state.

- [ ] **Step 4: Run Meta migration and parity tests**

Run from `backend/`:

```powershell
.\.venv\Scripts\python.exe -m pytest -q tests/test_active_session_locator_migration.py tests/test_meta_db.py tests/test_parity_alembic_metadata.py tests/test_alembic_dual_environments.py -p no:cacheprovider
.\.venv\Scripts\ruff.exe check --no-cache app/db/models/meta.py alembic_meta/versions/002_active_session_locator.py tests/test_active_session_locator_migration.py
```

Expected: PASS; Meta upgrade/downgrade and ORM parity agree exactly.

- [ ] **Step 5: Commit the coordination schema**

```powershell
git add backend/alembic_meta/versions/002_active_session_locator.py backend/app/db/models/meta.py backend/app/db/models/__init__.py backend/tests/test_active_session_locator_migration.py backend/tests/test_meta_db.py backend/tests/test_parity_alembic_metadata.py backend/tests/test_alembic_dual_environments.py
git commit -m "feat(meta): add active focus session locator schema"
```

---

### Task 4: Compile The Final 31-Entry Entity Catalog

**Files:**
- Modify: `backend/app/registry/entities.py`
- Modify: `backend/app/registry/catalog.py`
- Modify: `backend/app/registry/builtin.py`
- Modify: `backend/app/registry/__init__.py`
- Modify: `backend/app/registry/sync_registry.py`
- Modify: `backend/app/services/sync_entity_types.py`
- Modify: `backend/app/services/meta.py`
- Modify: `backend/app/schemas/meta.py`
- Modify: `backend/tests/test_compiled_entity_catalog.py`
- Modify: `backend/tests/test_registry.py`
- Modify: `backend/tests/test_registry_integration.py`
- Modify: `backend/tests/test_parity_registry_orm.py`
- Modify: `backend/tests/test_parity_registry_schemas.py`
- Modify: `backend/tests/test_parity_registry_sync.py`
- Modify: `backend/tests/test_build_sync_registry.py`

**Interfaces:**
- Consumes: S2 immutable `CompiledEntityCatalog`, S3 catalog-driven EntityCommand compiler, and Tasks 2/3 ORM models.
- Produces: catalog version `2`, exact 31-entry catalog, final camelCase Sync wire keys, and `EntitySpec.sync_conflict_policy` consumed by S3/TS1/S4.

- [ ] **Step 1: Write failing count, key, policy, and absence tests**

```python
from app.registry import CATALOG_VERSION, REGISTRY
from app.registry.catalog import CompiledEntityCatalog


SYNC_KEYS = {
    "project", "statusDefinition", "typeDefinition", "label", "workItemLabel",
    "workItem", "workItemNote", "focusSession", "sessionTaskContext",
    "sessionAttributionRevision", "sessionWorkItemPlan", "sessionWorkItemOutcome",
}
REMOVED = {"task", "session", "taskQuickNote", "sessionQuickNote"}


def test_ts0_catalog_is_final_and_collision_checked() -> None:
    catalog = CompiledEntityCatalog.compile(REGISTRY.list(), version=CATALOG_VERSION)
    assert CATALOG_VERSION == "2"
    assert len(REGISTRY.list()) == 31
    assert SYNC_KEYS <= {
        spec.effective_sync_entity_type for spec in catalog.list_sync_enabled()
    }
    assert REMOVED.isdisjoint(
        {spec.name for spec in REGISTRY.list()}
        | {spec.effective_sync_entity_type for spec in REGISTRY.list()}
    )
    assert catalog.get("work_item_note").sync_conflict_policy == "strict_cas"
    assert catalog.get("focus_session").sync_conflict_policy == "strict_cas"
    assert {"key", "next_work_item_number"} <= set(catalog.get("project").fields)
    assert "display_key" in set(catalog.get("work_item").fields)


def test_protocol_rows_are_not_lww_business_entities() -> None:
    for name in ("session_command_envelope", "session_command_receipt"):
        spec = REGISTRY.get(name)
        assert spec.category.value == "sync_infra"
        assert spec.sync_enabled is False
    locator = REGISTRY.get("active_session_locator")
    assert locator.category.value == "meta"
    assert locator.sync_enabled is False
```

- [ ] **Step 2: Run catalog tests and verify old keys/count remain**

Run from `backend/`:

```powershell
.\.venv\Scripts\python.exe -m pytest -q tests/test_compiled_entity_catalog.py tests/test_registry.py tests/test_registry_integration.py tests/test_parity_registry_orm.py tests/test_parity_registry_schemas.py tests/test_parity_registry_sync.py tests/test_build_sync_registry.py -p no:cacheprovider
```

Expected: FAIL because the current catalog still exposes legacy Task/Session entries and has no conflict policy.

- [ ] **Step 3: Extend EntitySpec and compiler validation**

Add the closed enum and field in `backend/app/registry/entities.py`:

```python
class SyncConflictPolicy(str, Enum):
    TIMESTAMP_LWW = "timestamp_lww"
    STRICT_CAS = "strict_cas"


@dataclass(frozen=True)
class EntitySpec:
    # existing fields remain in their established order
    sync_conflict_policy: str = SyncConflictPolicy.TIMESTAMP_LWW.value
```

`CompiledEntityCatalog.compile()` rejects any policy outside the two-value set and includes the policy in canonical hash input. S3 `EntityCommand.from_sync_event()` must branch on this field: version mismatch for `strict_cas` always yields `version_conflict` and never compares `client_updated_at`.

- [ ] **Step 4: Replace the four legacy registrations with the final entries**

Use this exact registration matrix; every model/schema path must resolve during compilation:

```python
TS0_ENTITIES = (
    ("project", "project", "business", True, "strict_cas"),
    ("status_definition", "statusDefinition", "business", True, "strict_cas"),
    ("type_definition", "typeDefinition", "business", True, "strict_cas"),
    ("label", "label", "business", True, "strict_cas"),
    ("work_item_label", "workItemLabel", "business", True, "strict_cas"),
    ("work_item", "workItem", "business", True, "strict_cas"),
    ("work_item_note", "workItemNote", "business", True, "strict_cas"),
    ("focus_session", "focusSession", "business", True, "strict_cas"),
    ("session_task_context", "sessionTaskContext", "business", True, "strict_cas"),
    ("session_attribution_revision", "sessionAttributionRevision", "business", True, "strict_cas"),
    ("session_work_item_plan", "sessionWorkItemPlan", "business", True, "strict_cas"),
    ("session_work_item_outcome", "sessionWorkItemOutcome", "business", True, "strict_cas"),
    ("session_command_envelope", None, "sync_infra", False, "strict_cas"),
    ("session_command_receipt", None, "sync_infra", False, "strict_cas"),
    ("active_session_locator", None, "meta", False, "strict_cas"),
)
```

Remove the `task`, `session`, `task_quick_note`, and `session_quick_note` registrations. Set `CATALOG_VERSION = "2"`; do not derive version from entry count. Update Meta introspection to expose version/hash and each conflict policy.

- [ ] **Step 5: Update parity tests to derive fields from mapper/schema authorities**

For every entry, assert `EntitySpec.fields` equals the mapped ORM column set and route/schema metadata resolves. In particular, `project` must contain `key` and `next_work_item_number`, while `work_item` must contain server-assigned `display_key`. Cross-check `Project.__table__`, the upgraded SQLite DDL, `ProjectCreate`/`ProjectResponse`, and catalog metadata so all authorities agree on canonical key length/format, unique-in-Space behavior, non-null positive counter, server default `1`, and client immutability. Cross-check `WorkItemCreate`/`WorkItemResponse` and the WorkItem ORM/catalog so only the response/authority contains `display_key`. For `work_item_note`, assert the Sync payload field is the complete `document_json` post-image plus normal identity/version/timestamps. For command/receipt/locator entries, assert `list_sync_enabled()` excludes them.

- [ ] **Step 6: Run catalog and S3 EntityCommand gates**

Run from `backend/`:

```powershell
.\.venv\Scripts\python.exe -m pytest -q tests/test_compiled_entity_catalog.py tests/test_registry.py tests/test_registry_integration.py tests/test_parity_registry_orm.py tests/test_parity_registry_schemas.py tests/test_parity_registry_sync.py tests/test_build_sync_registry.py tests/test_entity_invariants.py tests/test_entity_concurrency.py -p no:cacheprovider
.\.venv\Scripts\ruff.exe check --no-cache app/registry app/services/sync_entity_types.py tests/test_compiled_entity_catalog.py tests/test_registry.py tests/test_parity_registry_orm.py tests/test_parity_registry_schemas.py tests/test_parity_registry_sync.py
```

Expected: PASS; catalog hash is deterministic, count is 31, removed keys cannot resolve, and strict-CAS mismatches never execute LWW.

- [ ] **Step 7: Commit the final catalog**

```powershell
git add backend/app/registry/entities.py backend/app/registry/catalog.py backend/app/registry/builtin.py backend/app/registry/__init__.py backend/app/registry/sync_registry.py backend/app/services/sync_entity_types.py backend/app/services/meta.py backend/app/schemas/meta.py backend/tests/test_compiled_entity_catalog.py backend/tests/test_registry.py backend/tests/test_registry_integration.py backend/tests/test_parity_registry_orm.py backend/tests/test_parity_registry_schemas.py backend/tests/test_parity_registry_sync.py backend/tests/test_build_sync_registry.py backend/tests/test_entity_invariants.py backend/tests/test_entity_concurrency.py
git commit -m "feat(registry): compile final task space entity catalog"
```

---

### Task 5: Remove Every Legacy Backend Task And Session Surface

**Files:**
- Delete: `backend/app/models/task.py`
- Delete: `backend/app/models/session.py`
- Delete: `backend/app/models/task_quick_note.py`
- Delete: `backend/app/models/session_quick_note.py`
- Delete: `backend/app/schemas/task.py`
- Delete: `backend/app/schemas/session.py`
- Delete: `backend/app/services/task.py`
- Delete: `backend/app/services/session.py`
- Delete: `backend/app/routes/v1/tasks.py`
- Delete: `backend/app/routes/v1/sessions.py`
- Modify: `backend/app/routes/v1/__init__.py`
- Modify: `backend/app/models/quick_note.py`
- Modify: `backend/app/models/time_block.py`
- Modify: `backend/app/models/reflection.py`
- Modify: `backend/app/schemas/quick_note.py`
- Modify: `backend/app/schemas/time_block.py`
- Modify: `backend/app/schemas/reflection.py`
- Modify: `backend/app/services/cascade.py`
- Modify: `backend/app/services/relation.py`
- Modify: `backend/app/services/reflection.py`
- Modify: `backend/app/services/stats.py`
- Modify: `backend/app/routes/v1/reflections.py`
- Modify: `backend/app/routes/v1/stats.py`
- Create: `backend/tests/test_task_space_breaking_cutover.py`
- Modify: `backend/tests/test_base_service.py`
- Modify: `backend/tests/test_cascade_service.py`
- Modify: `backend/tests/test_openapi_contract.py`
- Modify: `backend/tests/test_note_service.py`
- Modify: `backend/tests/test_relation_service.py`
- Modify: `backend/tests/test_integration.py`
- Modify: `backend/tests/test_entity_spec_extension.py`
- Modify: `backend/tests/test_routes_v1.py`
- Modify: `backend/tests/test_routes_pagination.py`
- Modify: `backend/tests/test_parity_routes.py`
- Modify: `backend/tests/test_phase_c_completion.py`
- Modify: `backend/tests/test_response_contract.py`
- Modify: `backend/tests/test_schemas.py`
- Modify: `backend/tests/test_sync_cursor_pagination.py`
- Modify: `backend/tests/test_stats_service.py`
- Modify: `backend/tests/test_sync_integration.py`
- Modify: `backend/tests/test_sync_outbox_service.py`
- Modify: `backend/tests/test_sync_routes.py`
- Modify: `backend/tests/test_sync_safety.py`
- Modify: `backend/tests/test_sync_service.py`
- Delete: `backend/tests/test_task_service.py`
- Modify: `backend/tests/test_put_routes.py`
- Modify: `backend/tests/test_models.py`
- Modify: `backend/tests/test_services_meta.py`
- Modify: `backend/tests/test_sync_entity_alias.py`
- Modify: `backend/tests/test_sync_updated_at_indexes.py`
- Modify: `backend/tests/test_db_isolation.py`

**Interfaces:**
- Consumes: Tasks 2/4 final ORM/catalog and the explicit breaking-change decision.
- Produces: backend source, runtime OpenAPI, tests, and Sync helpers with no legacy Task/Session authority or route/key alias. New contract routers remain unmounted until Task 6's contract exporter and TS1/TS2 providers.

- [ ] **Step 1: Write the failing runtime and static absence gate**

```python
from pathlib import Path

from app.main import create_app
from app.registry import REGISTRY


ROOT = Path(__file__).resolve().parents[1] / "app"
FORBIDDEN_FILES = {
    ROOT / "models" / "task.py",
    ROOT / "models" / "session.py",
    ROOT / "services" / "task.py",
    ROOT / "services" / "session.py",
    ROOT / "routes" / "v1" / "tasks.py",
    ROOT / "routes" / "v1" / "sessions.py",
}
FORBIDDEN_TEXT = (
    "/api/v1/tasks", "/api/v1/sessions", "taskQuickNote", "sessionQuickNote",
)


def test_legacy_files_routes_and_catalog_keys_are_absent() -> None:
    assert all(not path.exists() for path in FORBIDDEN_FILES)
    openapi = create_app().openapi()
    assert "/api/v1/tasks" not in openapi["paths"]
    assert "/api/v1/sessions" not in openapi["paths"]
    catalog_names = {spec.name for spec in REGISTRY.list()}
    catalog_keys = {spec.effective_sync_entity_type for spec in REGISTRY.list()}
    assert {"task", "session", "task_quick_note", "session_quick_note"}.isdisjoint(catalog_names)
    assert {"task", "session", "taskQuickNote", "sessionQuickNote"}.isdisjoint(catalog_keys)


def test_production_python_has_no_legacy_route_or_wire_literal() -> None:
    violations = []
    for path in ROOT.rglob("*.py"):
        text = path.read_text(encoding="utf-8")
        for value in FORBIDDEN_TEXT:
            if value in text:
                violations.append((str(path.relative_to(ROOT)), value))
    assert violations == []
```

The test intentionally does not scan migrations, archived documentation, or tests because those retain audit evidence.

- [ ] **Step 2: Run the breaking gate and observe legacy failures**

Run from `backend/`:

```powershell
.\.venv\Scripts\python.exe -m pytest -q tests/test_task_space_breaking_cutover.py tests/test_openapi_contract.py tests/test_registry.py -p no:cacheprovider
```

Expected: FAIL on existing files, mounted `/tasks` and `/sessions`, and old catalog keys.

- [ ] **Step 3: Delete legacy modules and remove production route mounts**

Delete the ten listed model/schema/service/route files and both junction models. In `build_v1_router()` remove only these imports/mounts:

```python
# removed permanently
# from app.routes.v1.tasks import router as tasks_router
# from app.routes.v1.sessions import router as sessions_router
# router.include_router(tasks_router, prefix="/tasks", tags=["tasks"])
# router.include_router(sessions_router, prefix="/sessions", tags=["sessions"])
```

Do not mount `projects_router`, `work_items_router`, `work_item_notes_router`, `focus_sessions_router`, or `active_session_router` in TS0. Task 6 exports them through the contract app; TS1/TS2 mount the same objects after installing providers.

- [ ] **Step 4: Remove dangling legacy columns and services**

Remove `QuickNote.session_id`, `TimeBlock.task_id`, `Reflection.related_task_ids`, and `Reflection.auto_linked_session_ids` from ORM and Pydantic schemas. Remove task/session cascade and relation branches. Remove `task-distribution` and legacy Session statistics routes rather than renaming them to WorkItem/FocusSession semantics. Keep unrelated Note, QuickNote, schedule, habit, reflection, and time-block operations intact.

Replace `Task` as the generic `BaseService` test model with `Project`. Replace generic Sync test fixtures with `Project` or `Habit`; use `WorkItem` only when a tree/CAS assertion is relevant. Delete expectations for old keys instead of aliasing them.

- [ ] **Step 5: Update all affected backend tests to final vocabulary**

Run this inventory from `backend/` and require zero production hits after edits:

```powershell
$production = & rg -n "app\.models\.(task|session)|app\.services\.(task|session)|/api/v1/(tasks|sessions)|taskQuickNote|sessionQuickNote" app -g "*.py"
if ($LASTEXITCODE -eq 0) { $production; throw "legacy Task/Session production reference remains" }
if ($LASTEXITCODE -ne 1) { throw "rg failed with exit $LASTEXITCODE" }
```

Update the exact test files listed in this Task. Migration tests may continue mentioning old tables as rejection/downgrade evidence; no runtime test may expect an old route or wire key to succeed.

- [ ] **Step 6: Run the focused cutover and broad backend tests**

Run from `backend/`:

```powershell
.\.venv\Scripts\python.exe -m pytest -q tests/test_task_space_breaking_cutover.py tests/test_base_service.py tests/test_cascade_service.py tests/test_openapi_contract.py tests/test_relation_service.py tests/test_routes_v1.py tests/test_routes_pagination.py tests/test_parity_routes.py tests/test_phase_c_completion.py tests/test_response_contract.py tests/test_schemas.py tests/test_sync_cursor_pagination.py tests/test_stats_service.py tests/test_sync_integration.py tests/test_sync_outbox_service.py tests/test_sync_routes.py tests/test_sync_safety.py tests/test_sync_service.py tests/test_put_routes.py tests/test_models.py tests/test_services_meta.py tests/test_sync_entity_alias.py tests/test_sync_updated_at_indexes.py tests/test_db_isolation.py -p no:cacheprovider
.\.venv\Scripts\ruff.exe check --no-cache app tests/test_task_space_breaking_cutover.py
```

Expected: PASS; no old route/key/model/service remains and unrelated backend capabilities still pass.

- [ ] **Step 7: Commit the breaking cutover**

```powershell
git add -A backend/app/models/task.py backend/app/models/session.py backend/app/models/task_quick_note.py backend/app/models/session_quick_note.py backend/app/schemas/task.py backend/app/schemas/session.py backend/app/services/task.py backend/app/services/session.py backend/app/routes/v1/tasks.py backend/app/routes/v1/sessions.py backend/app/routes/v1/__init__.py backend/app/models/quick_note.py backend/app/models/time_block.py backend/app/models/reflection.py backend/app/schemas/quick_note.py backend/app/schemas/time_block.py backend/app/schemas/reflection.py backend/app/services/cascade.py backend/app/services/relation.py backend/app/services/reflection.py backend/app/services/stats.py backend/app/routes/v1/reflections.py backend/app/routes/v1/stats.py backend/tests/test_task_space_breaking_cutover.py backend/tests/test_base_service.py backend/tests/test_cascade_service.py backend/tests/test_openapi_contract.py backend/tests/test_note_service.py backend/tests/test_relation_service.py backend/tests/test_integration.py backend/tests/test_entity_spec_extension.py backend/tests/test_routes_v1.py backend/tests/test_routes_pagination.py backend/tests/test_parity_routes.py backend/tests/test_phase_c_completion.py backend/tests/test_response_contract.py backend/tests/test_schemas.py backend/tests/test_sync_cursor_pagination.py backend/tests/test_stats_service.py backend/tests/test_sync_integration.py backend/tests/test_sync_outbox_service.py backend/tests/test_sync_routes.py backend/tests/test_sync_safety.py backend/tests/test_sync_service.py backend/tests/test_task_service.py backend/tests/test_put_routes.py backend/tests/test_models.py backend/tests/test_services_meta.py backend/tests/test_sync_entity_alias.py backend/tests/test_sync_updated_at_indexes.py backend/tests/test_db_isolation.py
git commit -m "refactor(api): remove legacy task and session surfaces"
```

---

### Task 6: Define Pydantic Wire Schemas And Real Thin Contract Routers

**Files:**
- Create: `backend/app/schemas/task_space.py`
- Create: `backend/app/schemas/work_item_note.py`
- Create: `backend/app/schemas/focus_session.py`
- Create: `backend/app/routes/v1/contract_dependencies.py`
- Create: `backend/app/routes/v1/projects.py`
- Create: `backend/app/routes/v1/work_items.py`
- Create: `backend/app/routes/v1/work_item_notes.py`
- Create: `backend/app/routes/v1/focus_sessions.py`
- Create: `backend/app/routes/v1/active_session.py`
- Create: `backend/tests/test_task_space_contract_routes.py`
- Create: `backend/tests/test_focus_session_contract_routes.py`

**Interfaces:**
- Consumes: Task 1 Protocols, commands, outcomes, and errors; S1 Space/master auth dependencies; Task 4 catalog names.
- Produces: real unmounted routers, exact request/response schemas, and four typed provider dependencies that TS1/TS2 implement and mount without changing route handlers.

- [ ] **Step 1: Write failing fake-provider Task Space route tests**

```python
from fastapi import FastAPI
from fastapi.testclient import TestClient
from pydantic import ValidationError

import pytest

from app.routes.v1.contract_dependencies import (
    get_task_space_command_module,
    get_task_space_query_module,
)
from app.routes.v1.projects import router as projects_router
from app.routes.v1.work_item_notes import router as notes_router
from app.routes.v1.work_items import router as work_items_router
from app.schemas.task_space import (
    ProjectCreate,
    ProjectResponse,
    WorkItemCreate,
    WorkItemResponse,
)


def test_project_and_work_item_wire_ownership() -> None:
    assert ProjectCreate(key=" px12 ", name="Project").key == "PX12"
    assert "key" in ProjectCreate.model_fields
    assert "next_work_item_number" not in ProjectCreate.model_fields
    assert {"key", "next_work_item_number"} <= set(ProjectResponse.model_fields)
    assert "display_key" not in WorkItemCreate.model_fields
    assert "display_key" in WorkItemResponse.model_fields
    with pytest.raises(ValidationError):
        ProjectCreate(key="1px", name="Project")


def test_task_routes_delegate_once_to_injected_modules(fake_task_query, fake_task_commands) -> None:
    app = FastAPI()
    app.include_router(projects_router, prefix="/api/v1/projects")
    app.include_router(work_items_router, prefix="/api/v1/work-items")
    app.include_router(notes_router, prefix="/api/v1/work-items")
    app.dependency_overrides[get_task_space_query_module] = lambda: fake_task_query
    app.dependency_overrides[get_task_space_command_module] = lambda: fake_task_commands
    client = TestClient(app)

    response = client.post(
        "/api/v1/work-items/w1/note/toggle-checklist-item",
        json={
            "commandId": "cmd-1", "spaceId": "space-a", "expectedVersion": 2,
            "payloadHash": "a" * 64, "blockId": "b1", "itemId": "i1",
            "checked": True,
        },
    )
    assert response.status_code == 200
    assert fake_task_commands.calls == [
        ("toggle_checklist_item", "cmd-1", "space-a", "w1", 2)
    ]
```

Add one test for every Task Space path and assert the handler calls exactly one query method or one `execute()`; monkeypatch SQLAlchemy session creation, UoW construction, and `record_sync_event` to raise if a handler touches them.

- [ ] **Step 2: Write failing FocusSession and master active-session route tests**

```python
def test_active_session_uses_master_principal_and_coordinator(
    contract_app, master_client, fake_active_session_coordinator
) -> None:
    response = master_client.get("/api/v1/active-session")
    assert response.status_code == 200
    assert fake_active_session_coordinator.calls == [("locate", "master-principal")]


@pytest.mark.parametrize(
    (
        "path", "http_method", "coordinator_method", "space_id",
        "ownership_epoch", "status_code",
    ),
    (
        ("start", "POST", "start", "space-a", None, 201),
        ("activate-provisional", "POST", "activate_provisional", "space-a", None, 200),
        ("heartbeat", "POST", "heartbeat", None, 3, 200),
        ("pause", "POST", "pause", None, 3, 200),
        ("resume", "POST", "resume", None, 3, 200),
        ("takeover", "POST", "takeover", None, 3, 200),
        ("end", "POST", "end", None, 3, 200),
        ("note", "PUT", "update_note", None, 3, 200),
        ("plan/current", "POST", "set_current_plan_item", None, 3, 200),
        ("plan/completion-draft", "POST", "set_completion_draft", None, 3, 200),
        ("plan/add", "POST", "add_plan_item", None, 3, 200),
        ("plan/remove", "POST", "remove_plan_item", None, 3, 200),
        ("resolve-activation-conflict", "POST", "resolve_activation_conflict", None, 3, 200),
    ),
)
def test_active_session_mutations_delegate_one_generic_command(
    master_client, fake_active_session_coordinator, path, http_method,
    coordinator_method,
    space_id, ownership_epoch, status_code,
) -> None:
    body = valid_active_request(
        path,
        command_id=f"{coordinator_method}-1",
        session_id="session-a",
        space_id=space_id,
        ownership_epoch=ownership_epoch,
    )
    response = master_client.request(
        http_method,
        f"/api/v1/active-session/{path}",
        json=body,
    )
    assert response.status_code == status_code
    called_method, principal, command = fake_active_session_coordinator.calls[-1]
    assert called_method == coordinator_method
    assert principal == "master-principal"
    assert isinstance(command, ActiveSessionCommand)
    assert command.space_id == space_id
    assert command.ownership_epoch == ownership_epoch


def test_focus_session_review_uses_authorized_space_scope(
    contract_app, space_client, space_runtime_handle, fake_focus_session_module
) -> None:
    response = space_client.post(
        "/api/v1/focus-sessions/session-a/review",
        json={
            "commandId": "review-1", "spaceId": "space-a",
            "sessionId": "session-a", "ownershipEpoch": None,
            "payloadHash": "b" * 64, "payload": {"reviewState": "completed"},
        },
    )
    assert response.status_code == 200
    method, scope, command = fake_focus_session_module.calls[0]
    assert method == "submit_review"
    assert scope is space_runtime_handle
    assert command.space_id == "space-a"
```

Import `ActiveSessionCommand` in this test module. The active-session fake must
prove every mutating route calls exactly one matching Coordinator method with
`(principal, ActiveSessionCommand)`. Start and provisional activation require a
target `spaceId`; later lifecycle requests cannot select an owning Space and the
Coordinator obtains it from the locator/operation state. Override the S2
request-scoped runtime dependency with the injected `space_runtime_handle`;
every Space FocusSession history/review/reconciliation route must pass that same
object to `FocusSessionModule`. The FocusSession fake must prove a payload
`spaceId` mismatch is rejected before its method is called and no public Space
route delegates to start, pause, resume, or end.

`valid_active_request()` is deliberately operation-specific. It must build the
exact strict schema for the selected route; it must not hide a generic
`payload: dict[str, object]` escape hatch. In particular, the provisional and
resolution cases use these closed wire documents:

```python
PROVISIONAL_PAYLOAD = {
    "cachedAt": "2026-07-15T08:05:00Z",
    "cachedOwnershipEpoch": None,
    "ownerDeviceId": "device-a",
    "ownerTabId": "tab-a",
    "snapshot": {
        "session": {
            "sessionRevision": 0,
            "startedAt": "2026-07-15T08:00:00Z",
            "pauseStartedAt": None,
            "plannedSeconds": 1500,
            "grossSeconds": 0,
            "pausedSeconds": 0,
            "breakSeconds": 0,
            "focusedSeconds": 0,
            "validity": "pending",
            "validityReason": None,
            "reviewState": "not_required",
            "ownershipState": "local_provisional",
            "sessionNote": "",
        },
        "context": {
            "projectId": "project-a",
            "projectTitleSnapshot": "Project A",
            "level2WorkItemId": "l2-a",
            "level2TitleSnapshot": "Deliver A",
            "level2ParentIdSnapshot": "l1-a",
            "level2StatusDefinitionIdSnapshot": "sys-status-in-progress",
            "level2VersionSnapshot": 4,
            "level2EffortLowerSecondsSnapshot": 1200,
            "level2EffortUpperSecondsSnapshot": 2400,
            "linkedAt": "2026-07-15T08:00:00Z",
            "linkMethod": "explicit",
        },
        "plan": [{
            "id": "plan-a",
            "workItemId": "l3-a",
            "titleSnapshot": "Outcome A",
            "level2WorkItemIdSnapshot": "l2-a",
            "workItemVersionSnapshot": 2,
            "planRank": 0,
            "source": "before_start",
            "addedAt": "2026-07-15T08:00:00Z",
            "removedAt": None,
            "removalReason": None,
            "currentDuringSession": True,
            "completionDraft": False,
        }],
    },
    "expectedWorkItemVersions": {"l2-a": 4, "l3-a": 2},
}

RESOLUTION_PAYLOAD = {
    "winnerRole": "candidate",
    "decisionAt": "2026-07-15T08:06:00Z",
    "validityCorrection": {
        "loserValidity": "invalid",
        "loserValidityReason": "activation_conflict_loser",
    },
}
```

The provisional snapshot is nonterminal by construction: it has no
`endedAt`, `timerCompletion`, Outcome, command-envelope, formal WorkItem
creation or other formal WorkItem mutation field. A terminal offline provisional Session is not
claimed as the global active Session; S4 imports its complete pending history
through the five closed Session entity policies. P0 conflict resolution never
rewrites raw timer counters. It preserves both histories, continues the winner
with its current validity, ends the loser as `interrupted`, and applies the
explicit loser-invalid correction above so only one record can contribute
effort. A later product phase may add a versioned time-correction union; an
unversioned arbitrary JSON object is never accepted.

- [ ] **Step 3: Run route tests and verify missing routers/schemas**

Run from `backend/`:

```powershell
.\.venv\Scripts\python.exe -m pytest -q tests/test_task_space_contract_routes.py tests/test_focus_session_contract_routes.py -p no:cacheprovider
```

Expected: FAIL because the schemas, dependencies, and contract routers do not exist.

- [ ] **Step 4: Implement strict Pydantic schemas**

All new REST wire schemas serialize camelCase while Python contracts remain
snake_case. Define one base and use it for `task_space.py`, `work_item_note.py`,
and `focus_session.py`:

```python
from typing import Annotated, Self

from pydantic import AfterValidator, BaseModel, ConfigDict, model_validator
from pydantic.alias_generators import to_camel

from app.mutation.types import validate_operation_id


def _validated_command_id(value: str) -> str:
    validate_operation_id(value)
    return value


CommandId = Annotated[str, AfterValidator(_validated_command_id)]


class WireModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel,
        validate_by_alias=True,
        validate_by_name=False,
        serialize_by_alias=True,
        extra="forbid",
        strict=True,
    )


class WireResponseModel(BaseModel):
    model_config = ConfigDict(
        alias_generator=to_camel,
        validate_by_alias=True,
        validate_by_name=True,
        serialize_by_alias=True,
        from_attributes=True,
        extra="forbid",
        strict=True,
    )
```

Request/document models inherit alias-only `WireModel`; ORM/view response
models inherit `WireResponseModel`. FastAPI/OpenAPI responses serialize with
aliases, and route tests send camelCase. Snake-only and mixed camel/snake request
bodies return 422 before a Module call; internal Adapters access parsed
snake_case attributes and construct domain dataclasses directly rather than
re-validating field-name dictionaries. Query parameter `projectId` is translated by the Adapter into the
transport-neutral `TaskSpacePageQuery.filters["project_id"]`; no Module reads a
wire-cased filter key.

Every request `commandId` uses `CommandId`, which delegates to S3's exact
`validate_operation_id`: nonempty ASCII only, the approved character set, and
at most 128 encoded bytes. Character-count-only validation is forbidden.
Unicode, invalid punctuation/whitespace, and 129-byte IDs fail model parsing
before Adapter, Meta locator, operation journal, Space open, or Module access.

`work_item_note.py` uses a closed recursive ChecklistItem plus a discriminated Block
union and forbids extra fields:

```python
MAX_NOTE_DOCUMENT_BYTES = 128 * 1024
MAX_NOTE_BLOCKS = 256
MAX_NOTE_ITEMS = 2048


class ChecklistItem(WireModel):
    item_id: str = Field(min_length=1, max_length=64)
    text: str = Field(min_length=1, max_length=10_000)
    checked: bool
    children: list["ChecklistItem"] = Field(default_factory=list, max_length=MAX_NOTE_ITEMS)


class TextBlockBase(WireModel):
    block_id: str = Field(min_length=1, max_length=64)
    text: str = Field(max_length=10000)


class ParagraphBlock(TextBlockBase):
    type: Literal["paragraph"]


class ChecklistBlock(WireModel):
    type: Literal["checklist"]
    block_id: str = Field(min_length=1, max_length=64)
    items: list[ChecklistItem] = Field(max_length=MAX_NOTE_ITEMS)


NoteBlock = Annotated[
    ParagraphBlock | ChecklistBlock,
    Field(discriminator="type"),
]


class WorkItemNoteDocumentV1(WireModel):
    content_version: Literal[1]
    blocks: list[NoteBlock] = Field(max_length=MAX_NOTE_BLOCKS)
```

Model validators require nonblank Checklist item text and an explicit Boolean
`checked`; Paragraph owns only text and no item array. Validators reject every
unknown Block discriminator or item field, duplicate Block/Item IDs, a third
Checklist level, more than `MAX_NOTE_ITEMS` total items, and a canonical UTF-8
document over `MAX_NOTE_DOCUMENT_BYTES`. This yields at most two levels while
each `items`/`children` array remains the sole sibling-order authority.
`task_space.py` and `focus_session.py` mirror the ORM fields and closed enums;
all write schemas use strict non-Boolean integer versions, canonical UTC
strings, and exact 64-lowercase-hex payload hashes.

`focus_session.py` additionally defines the operation-specific active-session
schemas below. `CanonicalUtc` is the existing strict string alias whose
validator accepts only a normalized UTC `...Z` timestamp; it is not a Pydantic
`datetime` coercion. All nested models inherit `WireModel`, so missing fields,
unknown fields, booleans in integer positions, floats, and noncanonical
timestamps fail before the Coordinator is called.

```python
class ProvisionalSessionSnapshot(WireModel):
    session_revision: int = Field(ge=0)
    started_at: CanonicalUtc
    pause_started_at: CanonicalUtc | None = None
    planned_seconds: int = Field(gt=0)
    gross_seconds: int = Field(ge=0)
    paused_seconds: int = Field(ge=0)
    break_seconds: int = Field(ge=0)
    focused_seconds: int = Field(ge=0)
    validity: Literal["pending"]
    validity_reason: str | None = Field(default=None, max_length=500)
    review_state: Literal["not_required"]
    ownership_state: Literal["local_provisional"]
    session_note: str = Field(default="", max_length=20_000)


class ProvisionalTaskContextSnapshot(WireModel):
    project_id: str = Field(min_length=1, max_length=64)
    project_title_snapshot: str = Field(min_length=1, max_length=500)
    level2_work_item_id: str = Field(min_length=1, max_length=64)
    level2_title_snapshot: str = Field(min_length=1, max_length=500)
    level2_parent_id_snapshot: str | None = Field(default=None, max_length=64)
    level2_status_definition_id_snapshot: str = Field(min_length=1, max_length=64)
    level2_version_snapshot: int = Field(ge=0)
    level2_effort_lower_seconds_snapshot: int | None = Field(default=None, ge=0)
    level2_effort_upper_seconds_snapshot: int | None = Field(default=None, ge=0)
    linked_at: CanonicalUtc
    link_method: Literal["explicit", "contextual_confirmed"]


class ProvisionalPlanItemSnapshot(WireModel):
    id: str = Field(min_length=1, max_length=64)
    work_item_id: str = Field(min_length=1, max_length=64)
    title_snapshot: str = Field(min_length=1, max_length=500)
    level2_work_item_id_snapshot: str = Field(min_length=1, max_length=64)
    work_item_version_snapshot: int = Field(ge=0)
    plan_rank: int = Field(ge=0)
    source: Literal["before_start", "during_session"]
    added_at: CanonicalUtc
    removed_at: CanonicalUtc | None = None
    removal_reason: str | None = Field(default=None, max_length=500)
    current_during_session: bool
    completion_draft: bool


class ProvisionalFocusSessionSnapshot(WireModel):
    session: ProvisionalSessionSnapshot
    context: ProvisionalTaskContextSnapshot
    plan: list[ProvisionalPlanItemSnapshot]


class ActivateProvisionalPayload(WireModel):
    cached_at: CanonicalUtc
    cached_ownership_epoch: int | None = Field(default=None, gt=0)
    owner_device_id: str = Field(min_length=1, max_length=64)
    owner_tab_id: str = Field(min_length=1, max_length=64)
    snapshot: ProvisionalFocusSessionSnapshot
    expected_work_item_versions: dict[str, int]


class ActivationConflictValidityCorrection(WireModel):
    loser_validity: Literal["invalid"]
    loser_validity_reason: Literal["activation_conflict_loser"]


class ResolveActivationConflictPayload(WireModel):
    winner_role: Literal["active", "candidate"]
    decision_at: CanonicalUtc
    validity_correction: ActivationConflictValidityCorrection


class ActivateProvisionalRequest(WireModel):
    command_id: CommandId
    space_id: str = Field(min_length=1, max_length=64)
    session_id: str = Field(min_length=1, max_length=64)
    ownership_epoch: None = None
    payload_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    payload: ActivateProvisionalPayload


class ResolveActivationConflictRequest(WireModel):
    command_id: CommandId
    session_id: str = Field(min_length=1, max_length=64)
    ownership_epoch: int = Field(gt=0)
    payload_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    payload: ResolveActivationConflictPayload


class StartActiveSessionPayload(WireModel):
    level2_work_item_id: str = Field(min_length=1, max_length=64)
    level3_work_item_ids: list[str]
    planned_seconds: int = Field(gt=0)
    started_at: CanonicalUtc
    owner_device_id: str = Field(min_length=1, max_length=64)
    owner_tab_id: str = Field(min_length=1, max_length=64)
    expected_work_item_versions: dict[str, int]


class StartActiveSessionRequest(WireModel):
    command_id: CommandId
    space_id: str = Field(min_length=1, max_length=64)
    session_id: str = Field(min_length=1, max_length=64)
    ownership_epoch: None = None
    payload_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    payload: StartActiveSessionPayload


class HeartbeatPayload(WireModel):
    owner_device_id: str = Field(min_length=1, max_length=64)
    owner_tab_id: str = Field(min_length=1, max_length=64)
    heartbeat_at: CanonicalUtc


class HeartbeatRequest(WireModel):
    command_id: CommandId
    session_id: str = Field(min_length=1, max_length=64)
    ownership_epoch: int = Field(gt=0)
    payload_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    payload: HeartbeatPayload


class OwnedClockPayload(WireModel):
    expected_version: int = Field(ge=0)
    occurred_at: CanonicalUtc
    owner_device_id: str = Field(min_length=1, max_length=64)
    owner_tab_id: str = Field(min_length=1, max_length=64)


class PauseActiveSessionRequest(WireModel):
    command_id: CommandId
    session_id: str = Field(min_length=1, max_length=64)
    ownership_epoch: int = Field(gt=0)
    payload_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    payload: OwnedClockPayload


class ResumeActiveSessionRequest(PauseActiveSessionRequest):
    pass


class EndActiveSessionPayload(OwnedClockPayload):
    timer_completion: Literal["completed", "ended_early", "interrupted"]
    validity: Literal["pending", "valid", "invalid"]
    validity_reason: str | None = Field(default=None, max_length=500)


class EndActiveSessionRequest(WireModel):
    command_id: CommandId
    session_id: str = Field(min_length=1, max_length=64)
    ownership_epoch: int = Field(gt=0)
    payload_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    payload: EndActiveSessionPayload


class TakeoverPayload(WireModel):
    new_owner_device_id: str = Field(min_length=1, max_length=64)
    new_owner_tab_id: str = Field(min_length=1, max_length=64)


class TakeoverRequest(WireModel):
    command_id: CommandId
    session_id: str = Field(min_length=1, max_length=64)
    ownership_epoch: int = Field(gt=0)
    payload_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    payload: TakeoverPayload


class OwnerProofPayload(WireModel):
    owner_device_id: str = Field(min_length=1, max_length=64)
    owner_tab_id: str = Field(min_length=1, max_length=64)


class UpdateActiveSessionNotePayload(OwnerProofPayload):
    expected_version: int = Field(ge=0)
    session_note: str = Field(max_length=20_000)


class UpdateActiveSessionNoteRequest(WireModel):
    command_id: CommandId
    session_id: str = Field(min_length=1, max_length=64)
    ownership_epoch: int = Field(gt=0)
    payload_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    payload: UpdateActiveSessionNotePayload


class SetCurrentPlanItemPayload(OwnerProofPayload):
    work_item_id: str | None = Field(default=None, max_length=64)
    expected_plan_versions: dict[str, int]


class SetCurrentPlanItemRequest(WireModel):
    command_id: CommandId
    session_id: str = Field(min_length=1, max_length=64)
    ownership_epoch: int = Field(gt=0)
    payload_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    payload: SetCurrentPlanItemPayload


class SetCompletionDraftPayload(OwnerProofPayload):
    plan_item_id: str = Field(min_length=1, max_length=64)
    expected_plan_version: int = Field(ge=0)
    completion_draft: bool


class SetCompletionDraftRequest(WireModel):
    command_id: CommandId
    session_id: str = Field(min_length=1, max_length=64)
    ownership_epoch: int = Field(gt=0)
    payload_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    payload: SetCompletionDraftPayload


class AddPlanItemPayload(OwnerProofPayload):
    work_item_id: str = Field(min_length=1, max_length=64)
    expected_work_item_version: int = Field(ge=0)
    plan_rank: int = Field(ge=0)
    added_at: CanonicalUtc


class AddPlanItemRequest(WireModel):
    command_id: CommandId
    session_id: str = Field(min_length=1, max_length=64)
    ownership_epoch: int = Field(gt=0)
    payload_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    payload: AddPlanItemPayload


class RemovePlanItemPayload(OwnerProofPayload):
    plan_item_id: str = Field(min_length=1, max_length=64)
    expected_plan_version: int = Field(ge=0)
    removed_at: CanonicalUtc
    removal_reason: str = Field(min_length=1, max_length=500)


class RemovePlanItemRequest(WireModel):
    command_id: CommandId
    session_id: str = Field(min_length=1, max_length=64)
    ownership_epoch: int = Field(gt=0)
    payload_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    payload: RemovePlanItemPayload


class ReviewOutcomePayload(WireModel):
    work_item_id: str = Field(min_length=1, max_length=64)
    touched: bool
    result: Literal["completed", "progressed", "stuck", "untouched", "cancelled"]
    execution_persona: Literal["ox", "pig", "hajimi", "wukong"] | None = None
    persona_switched: bool | None = None
    persona_note: str | None = Field(default=None, max_length=2_000)
    state_command: Literal["complete", "cancel", "none"]
    expected_work_item_version: int = Field(ge=0)


class SubmitFocusSessionReviewPayload(WireModel):
    expected_version: int = Field(ge=0)
    validity: Literal["valid", "invalid"]
    review_state: Literal["completed", "skipped"]
    reviewed_at: CanonicalUtc
    outcomes: list[ReviewOutcomePayload]


class SubmitFocusSessionReviewRequest(WireModel):
    command_id: CommandId
    space_id: str = Field(min_length=1, max_length=64)
    session_id: str = Field(min_length=1, max_length=64)
    ownership_epoch: None = None
    payload_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    payload: SubmitFocusSessionReviewPayload


class ReconcileFocusSessionCommandsPayload(WireModel):
    command_ids: list[CommandId] = Field(min_length=1)
    replay_safe: bool
    abandon_command_ids: list[CommandId] = Field(default_factory=list)
    decision_at: CanonicalUtc | None = None

    @model_validator(mode="after")
    def validate_abandonment(self) -> Self:
        if len(set(self.command_ids)) != len(self.command_ids):
            raise ValueError("commandIds must be unique")
        if len(set(self.abandon_command_ids)) != len(self.abandon_command_ids):
            raise ValueError("abandonCommandIds must be unique")
        if not set(self.abandon_command_ids) <= set(self.command_ids):
            raise ValueError("abandonCommandIds must be a commandIds subset")
        if bool(self.abandon_command_ids) != (self.decision_at is not None):
            raise ValueError("decisionAt is required exactly for abandonment")
        return self


class ReconcileFocusSessionCommandsRequest(WireModel):
    command_id: CommandId
    space_id: str = Field(min_length=1, max_length=64)
    session_id: str = Field(min_length=1, max_length=64)
    ownership_epoch: None = None
    payload_hash: str = Field(pattern=r"^[0-9a-f]{64}$")
    payload: ReconcileFocusSessionCommandsPayload

    @model_validator(mode="after")
    def validate_root_operation_namespace(self) -> Self:
        if self.command_id in self.payload.command_ids:
            raise ValueError("root commandId must differ from every envelope commandId")
        return self
```

Model validators impose the cross-object invariants that field types cannot:

- Session `startedAt <= cachedAt`; `pauseStartedAt`, when present, is between
  those timestamps; duration facts pass the same TS2 clock validator used by
  online start/pause/resume.
- Context effort lower is not greater than upper. Plan IDs, WorkItem IDs, and
  ranks are each unique, and at most one nonremoved item is current.
- Every plan `level2WorkItemIdSnapshot` equals the Context level-2 ID. A
  removed item has `removedAt` and a nonblank reason; an active item has
  neither.
- `expectedWorkItemVersions` has exactly the Context level-2 ID plus every Plan
  WorkItem ID, contains no blank/extra key, and each value equals the matching
  `level2VersionSnapshot` or `workItemVersionSnapshot`.
- `winnerRole` selects exactly `active` or `candidate` from the persisted
  conflict pair. Resolve accepts no candidate Session ID or `spaceId`; the
  Coordinator derives and authorizes both composite `(spaceId, sessionId)`
  identities, including the valid case where both Session IDs are equal.
- A reconciliation root `commandId` cannot equal any selected envelope
  `commandId`; TS2 additionally rejects collisions with its deterministic
  receipt/fence child IDs before root UoW admission.

Every locator-bound heartbeat/pause/resume/takeover/end request schema likewise
uses `ownership_epoch: int = Field(gt=0)`. `cachedOwnershipEpoch` uses `None` for
"no cached locator" and a strictly positive integer otherwise. Epoch zero,
booleans, and floats fail at the wire schema rather than reaching Coordinator
error precedence.

The named route-to-schema mapping is exact:

```text
start                       -> StartActiveSessionRequest
activate-provisional        -> ActivateProvisionalRequest
heartbeat                   -> HeartbeatRequest
pause                       -> PauseActiveSessionRequest
resume                      -> ResumeActiveSessionRequest
takeover                    -> TakeoverRequest
end                         -> EndActiveSessionRequest
note                         -> UpdateActiveSessionNoteRequest
plan/current                 -> SetCurrentPlanItemRequest
plan/completion-draft        -> SetCompletionDraftRequest
plan/add                     -> AddPlanItemRequest
plan/remove                  -> RemovePlanItemRequest
resolve-activation-conflict -> ResolveActivationConflictRequest
focus review                -> SubmitFocusSessionReviewRequest
command reconcile           -> ReconcileFocusSessionCommandsRequest
```

Response schemas are operation-specific as well: heartbeat is the strict
locator-only camelCase projection; end is exactly `{session, locator: null}`;
locate/start/pause/resume/takeover/running-content/resolution use the strict
active aggregate or activation-conflict union. A generic mapping response is
not part of OpenAPI.

Start and provisional activation are the only master requests with root
`spaceId`; every locator-bound model omits it and alias-only `extra="forbid"`
rejects it. Review/reconcile are Space-authorized and require a body `spaceId`
equal to scope/path identity. Reconcile deliberately has no `expectedVersion`.
Model validators require unique nonblank ordered ID lists, exact expected-version
maps, valid Outcome persona combinations, and body/path Session identity. The
Adapter contains one explicit named mapper per payload model; it never accepts
or forwards a raw payload mapping.

The Adapter maps every named camelCase field to a named snake_case field. For
`activate_provisional`, the canonical hash document contains `cached_at`, owner
device/tab, and the recursively explicit snake_case `snapshot`; it excludes
only `cached_ownership_epoch` and `expected_work_item_versions`. Snapshot
version fields remain hashed historical facts even though the duplicate map is
a CAS guard. For resolution, `winner_role`, `decision_at`, and the complete
snake_case correction object are hashed. Candidate IDs and Spaces come only
from the persisted conflict intent and never enter the request. No generic
recursive case converter or `Mapping[str, object]` validation shortcut is
permitted.

- [ ] **Step 5: Implement four typed provider dependencies**

`contract_dependencies.py` defines no generic provider:

```python
def get_task_space_query_module() -> TaskSpaceQueryModule:
    raise RuntimeError("TaskSpaceQueryModule provider is not installed")


def get_task_space_command_module() -> TaskSpaceCommandModule:
    raise RuntimeError("TaskSpaceCommandModule provider is not installed")


def get_focus_session_module() -> FocusSessionModule:
    raise RuntimeError("FocusSessionModule provider is not installed")


def get_active_session_coordinator() -> ActiveSessionCoordinator:
    raise RuntimeError("ActiveSessionCoordinator provider is not installed")
```

Because these routers are not production-mounted in TS0, the exceptions cannot become runtime 500s. Contract tests always override all four providers. TS1/TS2 replace the dependencies before mounting.

- [ ] **Step 6: Implement the Task Space thin routers**

Lock these paths and method-to-Module mappings:

```text
GET    /api/v1/projects                         -> query.list_projects
POST   /api/v1/projects                         -> commands.execute(CreateProject)
GET    /api/v1/projects/{project_id}            -> query.get_project
GET    /api/v1/projects/definitions             -> query.list_definitions
GET    /api/v1/work-items                       -> query.list_work_items
POST   /api/v1/work-items                       -> commands.execute(CreateWorkItem)
GET    /api/v1/work-items/{work_item_id}         -> query.get_work_item
PATCH  /api/v1/work-items/{work_item_id}         -> commands.execute(MutateWorkItem:update)
POST   /api/v1/work-items/{work_item_id}/move    -> commands.execute(MutateWorkItem:move)
POST   /api/v1/work-items/{work_item_id}/transition -> commands.execute(MutateWorkItem:transition)
GET    /api/v1/work-items/{work_item_id}/note    -> query.read_note
PUT    /api/v1/work-items/{work_item_id}/note    -> commands.execute(ReplaceDocument)
POST   /api/v1/work-items/{work_item_id}/note/append-blocks -> commands.execute(AppendBlocks)
POST   /api/v1/work-items/{work_item_id}/note/toggle-checklist-item -> commands.execute(ToggleChecklistItem)
```

Each write treats the validated body `command_id` as the operation identity. A
shared TS0 Adapter helper reads an optional `Idempotency-Key`, validates it with
the same S3 validator, and requires byte-for-byte equality with body
`command_id`; a mismatch returns the stable idempotency error before any owning
Module/Coordinator call. It never replaces a body ID with S3's generated
request fallback. The Adapter then maps the schema to one immutable command,
calls `execute()` once, and maps the typed outcome through one shared helper.

Declare `/definitions` before `/{project_id}` in `projects.py`; the static route must never be captured as a Project ID. Declare all WorkItem action/note routes before the plain `/{work_item_id}` mutation route for the same reason, and add route-order assertions to `test_task_space_contract_routes.py`.

- [ ] **Step 7: Implement Space FocusSession and master active-session routers**

Lock these paths:

```text
GET   /api/v1/focus-sessions/{session_id}        -> module.get
POST  /api/v1/focus-sessions/{session_id}/review -> module.submit_review
POST  /api/v1/focus-sessions/{session_id}/commands/reconcile -> module.reconcile_commands
GET   /api/v1/active-session                     -> coordinator.locate
POST  /api/v1/active-session/start               -> coordinator.start
POST  /api/v1/active-session/activate-provisional -> coordinator.activate_provisional
POST  /api/v1/active-session/heartbeat           -> coordinator.heartbeat
POST  /api/v1/active-session/pause               -> coordinator.pause
POST  /api/v1/active-session/resume              -> coordinator.resume
POST  /api/v1/active-session/takeover            -> coordinator.takeover
POST  /api/v1/active-session/end                 -> coordinator.end
PUT   /api/v1/active-session/note                -> coordinator.update_note
POST  /api/v1/active-session/plan/current        -> coordinator.set_current_plan_item
POST  /api/v1/active-session/plan/completion-draft -> coordinator.set_completion_draft
POST  /api/v1/active-session/plan/add            -> coordinator.add_plan_item
POST  /api/v1/active-session/plan/remove         -> coordinator.remove_plan_item
POST  /api/v1/active-session/resolve-activation-conflict -> coordinator.resolve_activation_conflict
```

The three FocusSession history/review/reconciliation routes depend on
Space-token scope. Every `/active-session` route depends on master principal
only and never calls `get_space_db`, `get_space_runtime`, or accepts an owning
Space path. Start and provisional activation pass their validated command
`space_id` to the Coordinator; every later action resolves `space_id` from Meta
or persisted conflict state. The route never opens a Space or calls an
`open_target` helper itself.

- [ ] **Step 8: Run contract-route, schema, auth, and thin-adapter tests**

Run from `backend/`:

```powershell
.\.venv\Scripts\python.exe -m pytest -q tests/test_task_space_contract_routes.py tests/test_focus_session_contract_routes.py tests/test_schemas.py tests/test_openapi_contract.py tests/test_routes_auth_spaces.py -p no:cacheprovider
.\.venv\Scripts\ruff.exe check --no-cache app/schemas/task_space.py app/schemas/work_item_note.py app/schemas/focus_session.py app/routes/v1/contract_dependencies.py app/routes/v1/projects.py app/routes/v1/work_items.py app/routes/v1/work_item_notes.py app/routes/v1/focus_sessions.py app/routes/v1/active_session.py tests/test_task_space_contract_routes.py tests/test_focus_session_contract_routes.py
```

Expected: PASS; fakes receive exact commands, cross-Space mismatches call no Module, master routes call only the Coordinator, and no handler contains persistence logic.

- [ ] **Step 9: Commit schemas and contract routers**

```powershell
git add backend/app/schemas/task_space.py backend/app/schemas/work_item_note.py backend/app/schemas/focus_session.py backend/app/routes/v1/contract_dependencies.py backend/app/routes/v1/projects.py backend/app/routes/v1/work_items.py backend/app/routes/v1/work_item_notes.py backend/app/routes/v1/focus_sessions.py backend/app/routes/v1/active_session.py backend/tests/test_task_space_contract_routes.py backend/tests/test_focus_session_contract_routes.py
git commit -m "feat(api): define task space contract routers"
```

---

### Task 7: Export Deterministic OpenAPI And Generate TypeScript Types

**Files:**
- Create: `backend/app/contracts/__init__.py`
- Create: `backend/app/contracts/openapi.py`
- Create: `backend/scripts/export_openapi.py`
- Create: `backend/tests/test_task_space_openapi_contract.py`
- Create: `frontend/openapi.json`
- Modify: `frontend/package.json`
- Regenerate: `frontend/src/types/api-generated.ts`
- Create: `frontend/src/types/api-generated.contract.test.ts`

**Interfaces:**
- Consumes: Task 6 router objects and schemas plus existing production app metadata/error components.
- Produces: `create_contract_app() -> FastAPI`, deterministic exporter, tracked OpenAPI, and generated compile-time types used by TS1-TS4.

- [ ] **Step 1: Write failing contract-OpenAPI tests**

```python
from app.contracts.openapi import create_contract_app


EXPECTED_PATHS = {
    "/api/v1/projects",
    "/api/v1/projects/{project_id}",
    "/api/v1/projects/definitions",
    "/api/v1/work-items",
    "/api/v1/work-items/{work_item_id}",
    "/api/v1/work-items/{work_item_id}/move",
    "/api/v1/work-items/{work_item_id}/transition",
    "/api/v1/work-items/{work_item_id}/note",
    "/api/v1/work-items/{work_item_id}/note/append-blocks",
    "/api/v1/work-items/{work_item_id}/note/toggle-checklist-item",
    "/api/v1/focus-sessions/{session_id}",
    "/api/v1/focus-sessions/{session_id}/review",
    "/api/v1/focus-sessions/{session_id}/commands/reconcile",
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


def test_contract_openapi_has_final_paths_and_no_legacy_paths() -> None:
    document = create_contract_app().openapi()
    assert EXPECTED_PATHS <= set(document["paths"])
    assert "/api/v1/tasks" not in document["paths"]
    assert "/api/v1/sessions" not in document["paths"]


def test_active_session_security_is_master_and_focus_session_is_space() -> None:
    document = create_contract_app().openapi()
    active = document["paths"]["/api/v1/active-session"]["get"]["security"]
    focus = document["paths"]["/api/v1/focus-sessions/{session_id}"]["get"]["security"]
    assert active == [{"HTTPBearer": []}]
    assert focus == [{"HTTPBearer": []}]
    assert document["paths"]["/api/v1/active-session"]["get"]["x-token-scope"] == "master"
    assert document["paths"]["/api/v1/focus-sessions/{session_id}"]["get"]["x-token-scope"] == "space"
```

Also parameterize every Task Space, FocusSession, and active-session write
schema/route with a Unicode ID, a 129-byte ASCII ID, invalid ASCII punctuation,
a mismatching `Idempotency-Key`, and a matching key. Invalid/mismatched cases
must produce zero fake-Module/Coordinator calls and zero Meta/Space operation
rows; matching header/body identity reaches the owner once. Also assert
WorkItemNote is an exact two-variant `paragraph | checklist` discriminated union,
`contentVersion` is literal 1, public schema properties are camelCase, all
expected/entity versions are integers, no legacy Task/Session component exists,
and every write declares `Idempotency-Key` plus canonical errors.

- [ ] **Step 2: Run OpenAPI tests and verify the contract app is absent**

Run from `backend/`:

```powershell
.\.venv\Scripts\python.exe -m pytest -q tests/test_task_space_openapi_contract.py -p no:cacheprovider
```

Expected: FAIL because `app.contracts.openapi` and deterministic export do not exist.

- [ ] **Step 3: Implement the contract app without mounting routers in production**

`backend/app/contracts/openapi.py` must explicitly include the exact Task 6 routers:

```python
from fastapi import FastAPI

from app.main import create_app
from app.routes.v1.active_session import router as active_session_router
from app.routes.v1.focus_sessions import router as focus_sessions_router
from app.routes.v1.projects import router as projects_router
from app.routes.v1.work_item_notes import router as work_item_notes_router
from app.routes.v1.work_items import router as work_items_router


def create_contract_app() -> FastAPI:
    app = create_app()
    app.include_router(projects_router, prefix="/api/v1/projects", tags=["projects"])
    app.include_router(work_items_router, prefix="/api/v1/work-items", tags=["work-items"])
    app.include_router(work_item_notes_router, prefix="/api/v1/work-items", tags=["work-item-notes"])
    app.include_router(focus_sessions_router, prefix="/api/v1/focus-sessions", tags=["focus-sessions"])
    app.include_router(active_session_router, prefix="/api/v1/active-session", tags=["active-session"])
    return app
```

Start from `create_app()` so the contract document retains every existing nonlegacy production path, then include the five new router objects. Do not copy an existing route definition. Production still omits the five new router mounts until TS1/TS2.

- [ ] **Step 4: Implement deterministic local export**

`backend/scripts/export_openapi.py`:

```python
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.contracts.openapi import create_contract_app


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    document = create_contract_app().openapi()
    payload = json.dumps(
        document, ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ) + "\n"
    args.output.write_text(payload, encoding="utf-8", newline="\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
```

Running it twice must produce the same SHA-256 and byte count.

- [ ] **Step 5: Point frontend generation at the tracked local document**

Set the script exactly in `frontend/package.json`:

```json
"generate:api": "uv run --project ../backend python ../backend/scripts/export_openapi.py --output openapi.json && openapi-typescript openapi.json -o src/types/api-generated.ts"
```

Run from `frontend/`:

```powershell
npm run generate:api
```

Expected: `frontend/openapi.json` and `frontend/src/types/api-generated.ts` contain WorkItem/FocusSession paths and no Task/legacy Session path.

- [ ] **Step 6: Add generated-type contract tests**

`frontend/src/types/api-generated.contract.test.ts`:

```typescript
import { describe, expectTypeOf, it } from 'vitest'
import type { components, paths } from './api-generated'

describe('TS0 generated API contract', () => {
  it('contains final paths and strict note document version', () => {
    expectTypeOf<paths['/api/v1/work-items']>().toBeObject()
    expectTypeOf<paths['/api/v1/focus-sessions/{session_id}']>().toBeObject()
    expectTypeOf<paths['/api/v1/active-session']>().toBeObject()
    expectTypeOf<components['schemas']['WorkItemNoteDocumentV1']['contentVersion']>()
      .toEqualTypeOf<1>()
  })

  it('does not admit a numeric content version', () => {
    const document: components['schemas']['WorkItemNoteDocumentV1'] = {
      contentVersion: 1,
      blocks: [],
    }
    expectTypeOf(document.contentVersion).toEqualTypeOf<1>()
  })
})
```

Add a source assertion in the same test that `api-generated.ts` contains no `"/api/v1/tasks"` or `"/api/v1/sessions"` literal. The generated file remains unedited.

- [ ] **Step 7: Run generation, drift, frontend, and backend contract gates**

Run from the repository root:

```powershell
cd frontend
npm run generate:api
git diff --exit-code -- openapi.json src/types/api-generated.ts
npm run test -- --run src/types/api-generated.contract.test.ts
npm run typecheck
cd ..\backend
.\.venv\Scripts\python.exe -m pytest -q tests/test_task_space_openapi_contract.py tests/test_task_space_contract_routes.py tests/test_focus_session_contract_routes.py -p no:cacheprovider
.\.venv\Scripts\ruff.exe check --no-cache app/contracts scripts/export_openapi.py tests/test_task_space_openapi_contract.py
```

Expected: PASS and zero generated drift after the second generation.

- [ ] **Step 8: Commit OpenAPI and generated types**

```powershell
git add backend/app/contracts/__init__.py backend/app/contracts/openapi.py backend/scripts/export_openapi.py backend/tests/test_task_space_openapi_contract.py frontend/openapi.json frontend/package.json frontend/src/types/api-generated.ts frontend/src/types/api-generated.contract.test.ts
git commit -m "feat(contract): publish task space openapi types"
```

---

### Task 8: Run The TS0 Exit Gate And Record Cross-Wave Inputs

**Files:**
- Create: `backend/tests/test_ts0_architecture.py`
- Create: `backend/scripts/render_ts0_exit_report.py`
- Create: `docs/task-space-design/analysis/ts0-exit-report.md`

**Interfaces:**
- Consumes: Tasks 1-7 and the approved integration specification.
- Produces: one machine-enforced TS0 architecture gate and a factual handoff for TS1/TS2/S4; it does not edit later wave plans.

- [ ] **Step 1: Write the final architecture test**

```python
import ast
from pathlib import Path

from app.contracts.openapi import create_contract_app
from app.main import create_app
from app.registry import CATALOG_VERSION, REGISTRY


ROUTERS = (
    "projects.py", "work_items.py", "work_item_notes.py",
    "focus_sessions.py", "active_session.py",
)
FORBIDDEN_CALLS = {"commit", "record_sync_event", "execute_prepared_batch"}


def test_contract_routers_are_thin_and_not_production_mounted() -> None:
    base = Path(__file__).resolve().parents[1] / "app" / "routes" / "v1"
    for filename in ROUTERS:
        tree = ast.parse((base / filename).read_text(encoding="utf-8"))
        calls = {
            node.func.attr
            for node in ast.walk(tree)
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
        }
        assert FORBIDDEN_CALLS.isdisjoint(calls)
    production = create_app().openapi()["paths"]
    contract = create_contract_app().openapi()["paths"]
    assert "/api/v1/focus-sessions" not in production
    assert "/api/v1/focus-sessions" in contract


def test_ts0_heads_and_catalog_are_final(ts0_database_heads) -> None:
    assert ts0_database_heads == (
        "meta_002_active_session_locator", "space_010_task_space_focus_session"
    )
    assert CATALOG_VERSION == "2"
    assert len(REGISTRY.list()) == 31
```

- [ ] **Step 2: Run the complete backend gate and emit JUnit evidence**

Run from `backend/`:

```powershell
.\.venv\Scripts\python.exe -m pytest -q -p no:cacheprovider --junitxml=.test-artifacts/ts0-backend.xml
.\.venv\Scripts\ruff.exe check --no-cache app alembic_space alembic_meta scripts tests
```

Expected: PASS with no unexpected xfail/xpass. The complete test suite must not import a deleted legacy model or route.

- [ ] **Step 3: Run the complete frontend contract gate and emit JUnit evidence**

Run from `frontend/`:

```powershell
npm run generate:api
git diff --exit-code -- openapi.json src/types/api-generated.ts
npm run test -- --reporter=default --reporter=junit --outputFile=../backend/.test-artifacts/ts0-frontend.xml
npm run lint
npm run typecheck
```

Expected: PASS; regeneration is clean and legacy handwritten frontend stores remain untouched for TS3 without appearing in the generated server contract.

- [ ] **Step 4: Implement deterministic evidence rendering**

Create `backend/scripts/render_ts0_exit_report.py` so the report never contains manually substituted values:

```python
from __future__ import annotations

import argparse
import hashlib
import subprocess
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.registry import CATALOG_VERSION, REGISTRY


def _junit_counts(path: Path) -> tuple[int, int, int, int]:
    root = ET.parse(path).getroot()
    suites = [root] if root.tag == "testsuite" else list(root.findall("testsuite"))
    return tuple(
        sum(int(suite.attrib.get(name, "0")) for suite in suites)
        for name in ("tests", "failures", "errors", "skipped")
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--backend-junit", type=Path, required=True)
    parser.add_argument("--frontend-junit", type=Path, required=True)
    parser.add_argument("--openapi", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    backend = _junit_counts(args.backend_junit)
    frontend = _junit_counts(args.frontend_junit)
    if backend[1] + backend[2] + frontend[1] + frontend[2] != 0:
        raise SystemExit("TS0 test evidence contains a failure")
    commit = subprocess.check_output(
        ["git", "rev-parse", "HEAD"], text=True, encoding="utf-8"
    ).strip()
    digest = hashlib.sha256(args.openapi.read_bytes()).hexdigest()
    lines = [
        "# TS0 Exit Report",
        "",
        f"- Source commit: `{commit}`",
        "- Meta head: `meta_002_active_session_locator`",
        "- Space head: `space_010_task_space_focus_session`",
        f"- Catalog version: `{CATALOG_VERSION}`",
        f"- Catalog entries: `{len(REGISTRY.list())}`",
        "- Legacy runtime routes: `0`",
        "- Legacy catalog keys: `0`",
        f"- Backend pytest: `{backend[0]} tests, {backend[3]} skipped`",
        f"- Frontend Vitest: `{frontend[0]} tests, {frontend[3]} skipped`",
        f"- OpenAPI SHA-256: `{digest}`",
        "- Generated type drift: `0 files`",
        "",
        "## Required downstream changes",
        "",
        "- TS1 installs TaskSpaceQueryModule/TaskSpaceCommandModule providers and mounts the existing Project/WorkItem/WorkItemNote routers.",
        "- TS2 installs FocusSessionModule/ActiveSessionCoordinator providers and mounts the existing Space/master routers.",
        "- TS3 owns the first post-S3 business Dexie revision and removes handwritten legacy Task/Session stores.",
        "- S4 renumbers space_010_sync_clients_streaming to space_011_sync_clients_streaming and points it at space_010_task_space_focus_session.",
        "- S5/S6 freeze evidence only after the final S4 head and catalog hash exist.",
        "",
    ]
    args.output.write_text("\n".join(lines), encoding="utf-8", newline="\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
```

- [ ] **Step 5: Generate and verify the factual TS0 exit report**

Run from `backend/`:

```powershell
.\.venv\Scripts\python.exe scripts/render_ts0_exit_report.py --backend-junit .test-artifacts/ts0-backend.xml --frontend-junit .test-artifacts/ts0-frontend.xml --openapi ../frontend/openapi.json --output ../docs/task-space-design/analysis/ts0-exit-report.md
Get-Content ../docs/task-space-design/analysis/ts0-exit-report.md
```

Expected: the report contains a 40-character commit, a 64-character OpenAPI digest, catalog version 2/count 31, zero legacy surfaces, and zero test failures/errors.

- [ ] **Step 6: Run the TS0 self-review scans**

Run from the repository root:

```powershell
$legacy = & rg -n "/api/v1/(tasks|sessions)|taskQuickNote|sessionQuickNote" backend/app frontend/openapi.json frontend/src/types/api-generated.ts
if ($LASTEXITCODE -eq 0) { $legacy; throw "legacy public surface remains" }
if ($LASTEXITCODE -ne 1) { throw "rg failed with exit $LASTEXITCODE" }
$manual = & rg -n "NotImplemented|status_code\s*=\s*501" backend/app/task_space backend/app/focus_session backend/app/routes/v1/projects.py backend/app/routes/v1/work_items.py backend/app/routes/v1/work_item_notes.py backend/app/routes/v1/focus_sessions.py backend/app/routes/v1/active_session.py
if ($LASTEXITCODE -eq 0) { $manual; throw "incomplete implementation remains" }
if ($LASTEXITCODE -ne 1) { throw "rg failed with exit $LASTEXITCODE" }
```

Expected: both searches return exit code 1 and the wrapper exits successfully.

- [ ] **Step 7: Commit the TS0 gate and report**

```powershell
git add backend/tests/test_ts0_architecture.py backend/scripts/render_ts0_exit_report.py docs/task-space-design/analysis/ts0-exit-report.md
git commit -m "test(ts0): certify task space contract cutover"
```

---

## TS0 Review Gate

Reject TS0 if any of the following is true:

1. The Space head is not exactly `space_010_task_space_focus_session`, the Meta head is not exactly `meta_002_active_session_locator`, or a 15th domain table was introduced.
2. Startup can reach Meta/Space DDL, recovery write, backup, checkpoint, or replacement before one read-only preflight has accepted Meta and every registered Space; or any rejection changes a byte in the complete fleet inventory; or direct upgrade can discard a nonempty legacy Task/Session row, junction, ledger event, tombstone, or unresolved/legacy-bearing S3 journal receipt.
3. A Space business row stores a duplicate `space_id`, or a wire command can select a Space different from its authorized scope.
4. Catalog count differs from 31, a removed legacy key resolves, or WorkItemNote can enter timestamp LWW.
5. WorkItemNote uses Markdown/KnowledgeStore/generic Note, stores `parentItemId`
   or a parallel rank beside nested array order, accepts a third Checklist
   level, accepts a Block other than paragraph/checklist, exposes a
   WorkItem-reference/promotion surface, or conflates `contentVersion` with
   entity `version`.
6. Checklist mutation changes any WorkItem/FocusSession result field or bypasses the owning Task Space Module.
7. A new router opens a database, commits, builds a UoW, emits Sync directly, returns 501, or fabricates an outcome.
8. `/active-session` uses Space-token scope, accepts an owning Space path, lets a post-start action select its Space, cannot explicitly authorize the target Space for start/provisional activation, or bypasses `ActiveSessionCoordinator`.
9. `/focus-sessions` uses master scope, constructs a cross-Space payload, or publicly exposes start/pause/resume/end outside the Coordinator.
10. TS0 mounts the contract routers in production before TS1/TS2 install providers.
11. OpenAPI generation requires a live server, is nondeterministic, contains legacy paths/components, or generated types were edited by hand.
12. Any backend/frontend gate fails, generated drift is nonzero, or the exit report contains an unfilled evidence slot.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-15-task-space-session-ts0-contract-schema.md`. Two execution options:

1. **Subagent-Driven (recommended)** - dispatch a fresh subagent per Task with specification and quality review between Tasks.
2. **Inline Execution** - execute Tasks in order with `superpowers:executing-plans` and review checkpoints after each commit.
