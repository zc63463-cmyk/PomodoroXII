# Task Space Session TS1 Task Space And WorkItemNote Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the authoritative backend Task Space module for Project, seeded definitions, three-level WorkItem trees, and structured paragraph/checklist WorkItemNote v1 commands with whole-document CAS and explicit conflict preservation.

**Architecture:** TS1 is a backend domain slice over the already-merged S3 `MutationUnitOfWork` and TS0 schema/catalog. `TaskSpaceCommandModule` is the only write Interface; its registered `MutationDomainPolicy` validates Task Space invariants through S3 `MutationCompileContext` while S3 owns leases, CAS, idempotency, command hashing, result persistence, journal recovery, database application, and invisible-to-visible Sync ledger publication. REST is a thin Adapter, and frontend Dexie/store/UI work remains in TS3.

**Tech Stack:** Python 3.13, FastAPI, Pydantic v2, SQLAlchemy 2 async, SQLite, Alembic Space schema from TS0, S3 `EntityCommand`/`MutationUnitOfWork`, pytest, Ruff, OpenAPI, TypeScript type generation.

## Global Constraints

- Execute this plan only after S3 and TS0 are merged and their gates are green; TS1 does not edit S3, S4, Alembic schema, ORM models, registry declarations, or TS0 seed data.
- The revised S3 contract exposes `MutationCompileContext.command(request=..., db_plans=..., projections=(), sync_events=..., value=...)`, `MutationCompileContext.require_space(payload_space_id)`, `MutationCompileContext.authority`, the `MutationDomainPolicy.compile(context, request)` registration seam, and `MutationUnitOfWork.execute(scope, request, operation_id)`. TS1 never constructs `MutationCommand` or hashes command bytes itself.
- The revised S3 test support exposes `mutation_fixture_factory(*, policies: tuple[MutationDomainPolicy, ...]) -> MutationFixture`. The returned fixture owns `.scope`, `.uow`, `.catalog`, `.overlay_snapshot()`, `.inject_fault(name)`, `.restart()`, `.recover()`, and `.visible_events()`; `restart()` reconstructs process objects with the same constructor policy tuple. TS1 passes its policy at construction time and wraps the result in its own `TaskSpaceFixture`; it never assumes `.clock`, `.register_domain_policy(...)`, or `.with_domain(...)` exist on the S3 fixture.
- TS0 owns Space revision `space_010_task_space_focus_session` and the `Project`, `StatusDefinition`, `TypeDefinition`, `Label`, `WorkItemLabel`, `WorkItem`, and `WorkItemNote` ORM/Pydantic/catalog definitions. `StatusDefinition`, `TypeDefinition`, `Label`, and `WorkItemLabel` all come from the sole definition-model module `app.models.work_item_definition`; TS1 must not invent or import per-definition shadow model files. The final Project row includes `key` and `next_work_item_number`; WorkItem has no Note-promotion source columns.
- `Project.key` is user-provided; the server strips surrounding whitespace, uppercases it, then requires the full pattern `[A-Z][A-Z0-9]{1,9}`.
- `Project.next_work_item_number` starts at `1`; every WorkItem create allocates `{Project.key}-{Project.next_work_item_number}` while holding the S3 Space-exclusive mutation lease and increments the stored counter in the same UoW.
- Project key uniqueness and WorkItem `(project_id, display_key)` uniqueness are enforced by TS0 database constraints and rechecked by the TS1 compiler for stable domain errors.
- WorkItem depth is derived from `parent_id`; parent/child must share one Project, cycles are rejected, and moving a subtree may not produce a fourth level.
- WorkItemNote is one DB-only aggregate and one Sync entity. It does not use Markdown files, `KnowledgeStore`, knowledge-base `Note`, or QuickNote conversion.
- WorkItemNote `contentVersion` is document schema version `1`; ORM `version` is the independent entity CAS revision.
- WorkItemNote v1 supports exactly `paragraph` and `checklist`. Its fixed limits are canonical UTF-8 size `128 * 1024` bytes, at most `256` Blocks, and at most `2048` recursively counted Checklist items. Checklist depth is encoded only by nested `children[]` and is at most two; `parentItemId` does not exist. Block/Item IDs are stable and document-unique, array order is authoritative, and every Checklist item owns only `itemId`, plain `text`, Boolean `checked`, and `children`.
- WorkItemNote writes never use timestamp LWW. Every existing-document write requires `expectedVersion`, and S3 returns `version_conflict` without applying or publishing an event when CAS fails.
- Every Task Space command validates the caller's canonical business-payload hash before entering S3. TS1 imports S3's sole RFC 8785 `canonical_payload_hash`/`require_payload_hash` implementation; a mismatch returns `invalid_payload_hash` before `MutationUnitOfWork.execute(...)`, with no UoW, journal, row, or ledger side effect. The business payload excludes envelope/authority/CAS fields (`command_id`, declared `payload_hash`, `space_id`, target Project/WorkItem identity, `expected_version`, and command-kind discriminator). The separate S3 request hash covers that complete internal envelope and therefore still distinguishes changed command identity or target.
- HTTP bodies remain camelCase, but payload-hash inputs use the command-specific transport-neutral snake_case top-level keys consumed by TS1. Adapters explicitly normalize before validation; nested WorkItemNote document values retain their v1 camelCase aliases. No recursive generic key converter is permitted.
- Domain normalization precedes hashing. In particular, Project `key` is trimmed and uppercased once, and the same normalized value is used in the command payload, `payloadHash`, and persisted row; raw casing/whitespace never creates a second hash shape.
- `TaskSpaceCompiler` owns both the virtual REST command type `task_space` and every real Task Space catalog type (`project`, `status_definition`, `type_definition`, `label`, `work_item_label`, `work_item`, `work_item_note`). S3 `entity.create/update/delete` requests from S4 therefore enter this policy and can never reach generic fallback around tree, status, server-managed fields, or Note validation.
- Every Project or WorkItem create derives its <=36-character business ID deterministically from the caller command identity, never from business-payload bytes or an unconstrained raw `command_id`. Retrying one command returns the same entity; the same business payload under different command IDs creates different WorkItems and consumes distinct display numbers.
- Every Sync create/update event contains the complete authoritative post-image. In particular, every `workItem` event contains every TS0 WorkItem column plus `id`, timestamps, and `version`; patches and database defaults are never emitted as partial payloads.
- TS1 mounts TS0's routers unchanged. `POST /api/v1/work-items` constructs `CreateWorkItem`; `GET /api/v1/work-items?projectId=...` maps the wire query into `TaskSpacePageQuery.filters["project_id"]`. Note reads remain `GET .../note`; Note writes are only `PUT .../note`, `POST .../note/append-blocks`, and `POST .../note/toggle-checklist-item`. There is no generic `/note/` + `commands`, Note Item promotion, or `/work-items/tree` route, and all REST request/response fields remain camelCase on the wire.
- TS1 does not implement automatic Block merge, CRDT, Note Item promotion, Relation, Cycle, Orbit, FocusSession, frontend Dexie, frontend repositories, Zustand stores, or UI.
- Legacy `/api/v1/tasks`, the `task` Sync key, dual reads, and dual writes must already be absent after TS0; TS1 adds no compatibility Adapter.
- Run every backend command from `backend/` with `.\.venv\Scripts\python.exe` and `.\.venv\Scripts\ruff.exe`; add `-p no:cacheprovider` to every pytest invocation.
- Use file-level `git add -- ...` pathspecs. Do not stage directories wholesale and do not stage unrelated dirty or untracked files.

## File Map

### TS0 Inputs Consumed Without Modification

- `backend/app/models/project.py`: Project identity, normalized key, allocation counter, defaults, rank, archive state, and sync columns.
- `backend/app/models/work_item_definition.py`: six-category statuses, Space-level types/labels, system fallback flags, and the normalized WorkItem-to-Label junction.
- `backend/app/models/work_item.py`: WorkItem identity, Project/tree fields, definitions, status projections, scheduling fields, and sync columns; no Note-promotion trace.
- `backend/app/models/work_item_note.py`: one-to-one `work_item_id`, canonical `document_json`, and sync columns.
- `backend/app/schemas/task_space.py`: Project, status/type/label, and WorkItem create/move/transition/read schemas.
- `backend/app/schemas/work_item_note.py`: REST command union and WorkItemNote response schemas.
- `backend/app/registry/builtin.py`: final Task Space catalog and wire keys.
- `backend/app/errors.py`: `invalid_payload_hash`, `invalid_project_key`, `project_key_conflict`, `invalid_work_item_tree`, `active_child_conflict`, `invalid_note_document`, `unsupported_content_version`, `version_conflict`, `idempotency_conflict`, `offline_formal_creation_forbidden`, and `work_item_structure_changed` specifications.

### TS1 Files Created

- `backend/app/task_space/document.py`: WorkItemNote v1 Pydantic document model, validation, canonical JSON, append, and toggle.
- `backend/app/task_space/compiler.py`: registered S3 `MutationDomainPolicy` for Project, WorkItem, status, and Note request compilation against `MutationCompileContext.authority`.
- `backend/app/task_space/module.py`: concrete TS0 command Module delegating exactly once to S3 UoW and mapping stored results to TS0 outcomes.
- `backend/app/task_space/queries.py`: concrete TS0 read Module for Project/definition/flat WorkItem/Note views from a read runtime handle.
- `backend/tests/test_work_item_note_document.py`: pure document-contract tests.
- `backend/tests/test_task_space_project.py`: Project key, definition, allocation, retry, and rollback tests.
- `backend/tests/test_task_space_tree.py`: WorkItem depth, cycle, same-Project, move, ordering, and status tests.
- `backend/tests/test_work_item_note_cas.py`: Note command, CAS, idempotency, and event tests.
- `backend/tests/test_work_item_note_boundary.py`: forbidden Block, WorkItem-reference, promotion-surface, and conflict-preservation tests.
- `backend/tests/test_task_space_routes.py`: REST operation identity, error, body, and thin-Adapter tests.
- `backend/tests/task_space_fixture.py`: TS1-owned `FrozenClock` and explicit `TaskSpaceFixture` adapter over the constructor-injected S3 fixture.

### Existing Files Modified By TS1

- `backend/tests/conftest.py`: calls S3's `mutation_fixture_factory(policies=(TaskSpaceCompiler(...),))` once and returns the TS1-owned adapter; it does not mutate or clone an already-constructed UoW.
- `backend/app/deps.py`: registers `TaskSpaceCompiler` in the existing S3 UoW composition root.
- `backend/app/routes/v1/contract_dependencies.py`: replaces only the two TS0 Task Space sentinel providers.
- `backend/app/routes/v1/__init__.py`: mounts the three TS0 Task Space route groups and does not mount `/tasks`.
- `backend/tests/test_registry.py`: final entity totals and exact Task Space names.
- `backend/tests/test_services_meta.py`: final catalog health/category counts.
- `backend/tests/test_parity_registry_orm.py`: Task Space ORM parity remains fully parameterized.
- `backend/tests/test_parity_registry_schemas.py`: Task Space schema parity and the intentional `WorkItemLabel` junction exception.
- `backend/tests/test_parity_alembic_metadata.py`: confirms the TS0 Space head still matches metadata after TS1 code.
- `backend/tests/test_task_space_contract_routes.py`: keeps every TS0 Task Space route byte-stable and proves one-call Adapter delegation.
- `backend/tests/test_openapi_contract.py`: Task Space paths, command discriminator, CAS field, and legacy Task absence.
- `backend/tests/test_response_contract.py`: exact Task Space response fields.
- `backend/tests/test_error_contract_v2.py`: exact TS1 rejection producers remain a subset of the shared registered error map.
- `frontend/src/types/api-generated.ts`: generated OpenAPI types only; no handwritten frontend business code.

---

### Task 1: Implement And Lock WorkItemNote Document V1

**Files:**
- Create: `backend/app/task_space/document.py`
- Create: `backend/tests/test_work_item_note_document.py`

**Interfaces:**
- Consumes: TS0 `invalid_note_document` and `unsupported_content_version` error categories; Pydantic v2.
- Produces: `WorkItemNoteDocumentV1`, `NoteBlockV1`, `parse_document_v1(raw)`, `canonical_document_json(document)`, `append_blocks(document, blocks)`, and `set_checklist_item_checked(document, item_id, checked)`.

- [ ] **Step 1: Write the failing valid-document and canonicalization tests**

```python
from __future__ import annotations

import json

import pytest

from app.task_space.document import (
    InvalidNoteDocument,
    MAX_BLOCKS,
    MAX_DOCUMENT_BYTES,
    MAX_ITEMS,
    UnsupportedContentVersion,
    canonical_document_json,
    parse_document_v1,
)


VALID_DOCUMENT = {
    "contentVersion": 1,
    "blocks": [
        {"blockId": "p1", "type": "paragraph", "text": "Prepare the outline"},
        {
            "blockId": "c1",
            "type": "checklist",
            "items": [
                {
                    "itemId": "c1a",
                    "text": "Run review",
                    "checked": False,
                    "children": [
                        {
                            "itemId": "c1b", "text": "Check sources",
                            "checked": False, "children": [],
                        }
                    ],
                }
            ],
        },
    ],
}


def test_document_v1_accepts_only_paragraph_and_checklist_and_is_canonical() -> None:
    document = parse_document_v1(VALID_DOCUMENT)

    first = canonical_document_json(document)
    second = canonical_document_json(parse_document_v1(json.loads(first)))

    assert first == second
    assert json.loads(first) == VALID_DOCUMENT


@pytest.mark.parametrize(
    ("mutate", "message"),
    [
        (lambda value: value.update(contentVersion=2), "unsupported contentVersion"),
        (
            lambda value: value["blocks"].append(
                {"blockId": "p1", "type": "paragraph", "text": "duplicate"}
            ),
            "duplicate Note ID",
        ),
        (
            lambda value: value["blocks"][1]["items"][0]["children"][0].update(
                children=[{"itemId": "third", "text": "too deep", "checked": False, "children": []}]
            ),
            "checklist depth exceeds two",
        ),
    ],
)
def test_document_v1_rejects_unknown_version_duplicate_ids_and_third_level(
    mutate,
    message: str,
) -> None:
    value = json.loads(json.dumps(VALID_DOCUMENT))
    mutate(value)

    error = UnsupportedContentVersion if value.get("contentVersion") != 1 else InvalidNoteDocument
    with pytest.raises(error, match=message):
        parse_document_v1(value)


def test_document_v1_rejects_coerced_versions_levels_and_non_object_root() -> None:
    for invalid_version in (True, 1.0):
        value = json.loads(json.dumps(VALID_DOCUMENT))
        value["contentVersion"] = invalid_version
        with pytest.raises(InvalidNoteDocument):
            parse_document_v1(value)

    non_boolean_check = json.loads(json.dumps(VALID_DOCUMENT))
    non_boolean_check["blocks"][1]["items"][0]["checked"] = 0
    with pytest.raises(InvalidNoteDocument):
        parse_document_v1(non_boolean_check)

    with pytest.raises(InvalidNoteDocument, match="root must be an object"):
        parse_document_v1([])


def test_checklist_shape_limits_and_forbidden_variants_are_locked() -> None:
    assert (MAX_DOCUMENT_BYTES, MAX_BLOCKS, MAX_ITEMS) == (128 * 1024, 256, 2048)

    wide_document = parse_document_v1({
        "contentVersion": 1,
        "blocks": [{
            "blockId": "wide", "type": "checklist",
            "items": [
                {
                    "itemId": f"wide-{index}", "text": "x",
                    "checked": False, "children": [],
                }
                for index in range(501)
            ],
        }],
    })
    assert len(wide_document.blocks[0].items) == 501

    forbidden_parent = json.loads(json.dumps(VALID_DOCUMENT))
    forbidden_parent["blocks"][1]["items"][0]["parentItemId"] = "not-canonical"
    with pytest.raises(InvalidNoteDocument):
        parse_document_v1(forbidden_parent)

    for forbidden_type in ("heading", "ordered_list", "unordered_list"):
        value = json.loads(json.dumps(VALID_DOCUMENT))
        value["blocks"].append({"blockId": forbidden_type, "type": forbidden_type})
        with pytest.raises(InvalidNoteDocument):
            parse_document_v1(value)

    promoted = json.loads(json.dumps(VALID_DOCUMENT))
    promoted["blocks"][1]["items"][0].update(
        workItemId="wi-1", titleSnapshot="Not in v1"
    )
    with pytest.raises(InvalidNoteDocument):
        parse_document_v1(promoted)
```

- [ ] **Step 2: Run the document tests and verify the module is missing**

Run: `.\.venv\Scripts\python.exe -m pytest -q tests/test_work_item_note_document.py -p no:cacheprovider`

Expected: FAIL during collection with `ModuleNotFoundError: No module named 'app.task_space.document'`; the TS0-owned `app.task_space` package and contracts already import.

- [ ] **Step 3: Implement the closed Pydantic document model and canonical serializer**

```python
# backend/app/task_space/document.py
from __future__ import annotations

import json
import re
from copy import deepcopy
from typing import Annotated, Literal, Mapping, TypeAlias

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter, model_validator

MAX_DOCUMENT_BYTES = 128 * 1024
MAX_BLOCKS = 256
MAX_ITEMS = 2048
ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$")


class InvalidNoteDocument(ValueError):
    pass


class UnsupportedContentVersion(ValueError):
    pass


class _ClosedModel(BaseModel):
    model_config = ConfigDict(
        extra="forbid", frozen=True, populate_by_name=True, strict=True
    )


class ChecklistItemV1(_ClosedModel):
    item_id: str = Field(alias="itemId", min_length=1, max_length=64)
    text: str = Field(min_length=1, max_length=10_000)
    checked: bool
    children: tuple["ChecklistItemV1", ...] = Field(
        default=(), max_length=MAX_ITEMS
    )

    @model_validator(mode="after")
    def validate_shape(self) -> "ChecklistItemV1":
        if not ID_PATTERN.fullmatch(self.item_id):
            raise ValueError("invalid itemId")
        if not self.text.strip():
            raise ValueError("checklist item requires nonblank text")
        return self


class ParagraphBlockV1(_ClosedModel):
    block_id: str = Field(alias="blockId", min_length=1, max_length=64)
    type: Literal["paragraph"]
    text: str = Field(max_length=10_000)


class ChecklistBlockV1(_ClosedModel):
    block_id: str = Field(alias="blockId", min_length=1, max_length=64)
    type: Literal["checklist"]
    items: tuple[ChecklistItemV1, ...] = Field(max_length=MAX_ITEMS)


NoteBlockV1: TypeAlias = Annotated[
    ParagraphBlockV1 | ChecklistBlockV1,
    Field(discriminator="type"),
]
_BLOCK_ADAPTER = TypeAdapter(NoteBlockV1)


class WorkItemNoteDocumentV1(_ClosedModel):
    content_version: Literal[1] = Field(alias="contentVersion")
    blocks: tuple[NoteBlockV1, ...] = Field(max_length=MAX_BLOCKS)


def _walk_items(items: tuple[ChecklistItemV1, ...], *, depth: int):
    for item in items:
        if depth > 2:
            raise InvalidNoteDocument("checklist depth exceeds two")
        yield item
        yield from _walk_items(item.children, depth=depth + 1)


def _validate_document(document: WorkItemNoteDocumentV1) -> WorkItemNoteDocumentV1:
    seen: set[str] = set()
    item_count = 0
    for block in document.blocks:
        if not ID_PATTERN.fullmatch(block.block_id):
            raise InvalidNoteDocument("invalid blockId")
        if block.block_id in seen:
            raise InvalidNoteDocument("duplicate Note ID")
        seen.add(block.block_id)
        if isinstance(block, ChecklistBlockV1):
            for item in _walk_items(block.items, depth=1):
                item_count += 1
                if item.item_id in seen:
                    raise InvalidNoteDocument("duplicate Note ID")
                seen.add(item.item_id)
    if item_count > MAX_ITEMS:
        raise InvalidNoteDocument("Note item count exceeds limit")
    if len(canonical_document_json(document).encode("utf-8")) > MAX_DOCUMENT_BYTES:
        raise InvalidNoteDocument("Note document exceeds byte limit")
    return document


def parse_document_v1(raw: object) -> WorkItemNoteDocumentV1:
    if not isinstance(raw, Mapping):
        raise InvalidNoteDocument("Note document root must be an object")
    content_version = raw.get("contentVersion")
    if type(content_version) is int and content_version != 1:
        raise UnsupportedContentVersion("unsupported contentVersion")
    if type(content_version) is not int:
        raise InvalidNoteDocument("contentVersion must be integer 1")
    try:
        document = WorkItemNoteDocumentV1.model_validate(raw)
        return _validate_document(document)
    except UnsupportedContentVersion:
        raise
    except InvalidNoteDocument:
        raise
    except Exception as exc:
        raise InvalidNoteDocument(str(exc)) from exc


def canonical_document_json(document: WorkItemNoteDocumentV1) -> str:
    return json.dumps(
        document.model_dump(by_alias=True, mode="json", exclude_none=True),
        ensure_ascii=False,
        allow_nan=False,
        sort_keys=True,
        separators=(",", ":"),
    )
```

- [ ] **Step 4: Implement immutable append and Checklist toggle helpers**

```python
# append to backend/app/task_space/document.py
def append_blocks(
    document: WorkItemNoteDocumentV1,
    blocks: tuple[Mapping[str, object], ...],
) -> WorkItemNoteDocumentV1:
    raw = document.model_dump(by_alias=True, mode="json", exclude_none=True)
    raw["blocks"].extend(deepcopy(dict(block)) for block in blocks)
    return parse_document_v1(raw)


def _rewrite_item(
    item: dict[str, object],
    item_id: str,
    rewrite,
) -> tuple[dict[str, object], bool]:
    if item["itemId"] == item_id:
        return rewrite(deepcopy(item)), True
    rewritten_children: list[dict[str, object]] = []
    found = False
    for child in item.get("children", []):
        rewritten, matched = _rewrite_item(child, item_id, rewrite)
        rewritten_children.append(rewritten)
        found = found or matched
    output = deepcopy(item)
    output["children"] = rewritten_children
    return output, found


def _rewrite_document_item(
    document: WorkItemNoteDocumentV1,
    *,
    block_id: str | None,
    item_id: str,
    rewrite,
) -> WorkItemNoteDocumentV1:
    raw = document.model_dump(by_alias=True, mode="json", exclude_none=True)
    matches = 0
    for block in raw["blocks"]:
        if block_id is not None and block["blockId"] != block_id:
            continue
        if "items" not in block:
            continue
        items: list[dict[str, object]] = []
        for item in block["items"]:
            rewritten, found = _rewrite_item(item, item_id, rewrite)
            items.append(rewritten)
            matches += int(found)
        block["items"] = items
    if matches != 1:
        raise InvalidNoteDocument("itemId must identify exactly one item")
    return parse_document_v1(raw)


def set_checklist_item_checked(
    document: WorkItemNoteDocumentV1,
    item_id: str,
    checked: bool,
) -> WorkItemNoteDocumentV1:
    def set_checked(item: dict[str, object]) -> dict[str, object]:
        if not isinstance(item.get("checked"), bool):
            raise InvalidNoteDocument("item is not a checklist item")
        item["checked"] = checked
        return item

    return _rewrite_document_item(
        document, block_id=None, item_id=item_id, rewrite=set_checked
    )
```

- [ ] **Step 5: Keep the document implementation internal and run the focused tests**

Tests import document helpers from `app.task_space.document`. Do not add them to
TS0's public `app.task_space.__init__` export surface; that file continues to
export only the locked contracts.

Run: `.\.venv\Scripts\python.exe -m pytest -q tests/test_work_item_note_document.py -p no:cacheprovider`

Expected: PASS with exactly paragraph/checklist Blocks, exact `128 KiB`/`256`/`2048` limits and no hidden 500-item sibling cap, canonical roundtrip, nested-only Checklist `children[]`, forbidden richer Blocks/WorkItem references/`parentItemId`, duplicate-ID, unknown-version, and depth cases green.

- [ ] **Step 6: Run Ruff and commit Document v1**

Run: `.\.venv\Scripts\ruff.exe check --no-cache app/task_space/document.py tests/test_work_item_note_document.py`

Expected: `All checks passed!`

```powershell
git add -- app/task_space/document.py tests/test_work_item_note_document.py
git commit -m "feat(task-space): define work item note document v1"
```

### Task 2: Implement The TS0 Task Space Interface, Project Commands, And Definition Queries

**Files:**
- Create: `backend/app/task_space/module.py`
- Create: `backend/app/task_space/queries.py`
- Create: `backend/app/task_space/compiler.py`
- Create: `backend/tests/task_space_fixture.py`
- Create: `backend/tests/test_task_space_project.py`
- Modify: `backend/tests/conftest.py`

**Interfaces:**
- Consumes: TS0 `app.task_space.contracts` commands/outcomes/Protocols, Project/definition models and catalog; S3 `MutationRequest`, exact `entity.create/update/delete` names, `SyncEventPlan`, `MutationCompileContext.command(...)`, `MutationCompileContext.authority`, `MutationDomainPolicy` constructor registration, `MutationUnitOfWork.execute`, and `mutation_fixture_factory(*, policies=...)`.
- Produces: `DefaultTaskSpaceCommandModule.execute(scope, TaskSpaceCommand) -> TaskSpaceOutcome`, `DefaultTaskSpaceQueryModule`, public-internal `build_task_space_request(TaskSpaceCommand) -> MutationRequest`, one `TaskSpaceCompiler.compile(context, request)` that owns virtual REST commands plus all seven real Task Space entity types, and one TS1 `TaskSpaceFixture` adapter without defining a second UoW or public contract family.

- [ ] **Step 1: Write failing Project key, seeded-definition, retry, and allocation tests**

```python
from __future__ import annotations

import pytest

import app.mutation.unit_of_work as mutation_uow
from app.errors import MutationRejectedError
from app.task_space.compiler import (
    READ_ONLY_SYNC_TYPES,
    TASK_SPACE_POLICY_ENTITY_TYPES,
    _stable_id,
)
from app.task_space.contracts import TaskSpaceAccepted, TaskSpaceRejected


def test_task_space_policy_owns_virtual_and_real_catalog_types() -> None:
    assert TASK_SPACE_POLICY_ENTITY_TYPES == {
        "task_space", "project", "status_definition", "type_definition",
        "label", "work_item_label", "work_item", "work_item_note",
    }


READ_ONLY_SYNC_WIRE_TYPES = {
    "project": "project",
    "status_definition": "statusDefinition",
    "type_definition": "typeDefinition",
    "label": "label",
    "work_item_label": "workItemLabel",
}


@pytest.mark.parametrize("entity_type", sorted(READ_ONLY_SYNC_TYPES))
@pytest.mark.parametrize("action", ("create", "update", "delete"))
@pytest.mark.asyncio
async def test_every_read_only_sync_action_is_policy_owned_and_zero_effect(
    task_space_fixture,
    monkeypatch,
    entity_type: str,
    action: str,
) -> None:
    operation_id = f"sync-{entity_type}-{action}"
    before = task_space_fixture.overlay_snapshot()
    event = task_space_fixture.sync_event(
        entity_type=READ_ONLY_SYNC_WIRE_TYPES[entity_type],
        entity_id=f"{entity_type}-candidate",
        action=action,
        payload={},
        expected_version=None if action == "create" else 1,
    )
    request = task_space_fixture.entity_commands.from_sync_event(
        task_space_fixture.scope, event
    )

    async def poison_generic_fallback(*args, **kwargs):
        raise AssertionError("Task Space real entity reached generic fallback")

    monkeypatch.setattr(
        mutation_uow, "compile_catalog_entity_command", poison_generic_fallback
    )
    with pytest.raises(MutationRejectedError) as caught:
        await task_space_fixture.uow.execute(
            task_space_fixture.scope, request, operation_id
        )

    assert caught.value.rejection.code == "offline_formal_creation_forbidden"
    assert task_space_fixture.overlay_snapshot() == before
    assert await task_space_fixture.visible_events(operation_id=operation_id) == ()


@pytest.mark.asyncio
async def test_project_key_is_uppercased_and_definitions_are_seeded(task_space_fixture) -> None:
    project = await task_space_fixture.create_project(
        command_id="project-create-alpha", key=" px1 ", name="Alpha"
    )
    definitions = await task_space_fixture.queries.list_definitions(task_space_fixture.scope)

    assert project.value["id"] == _stable_id("project", "project-create-alpha")
    assert project.value["key"] == "PX1"
    assert project.value["next_work_item_number"] == 1
    fetched = await task_space_fixture.queries.get_project(
        task_space_fixture.scope, project.value["id"]
    )
    assert fetched.value == project.value
    assert {row["category"] for row in definitions.statuses} == {
        "not_started", "in_progress", "paused", "waiting", "completed", "cancelled"
    }
    assert sum(bool(row["system"]) for row in definitions.types) == 1


@pytest.mark.asyncio
async def test_invalid_and_duplicate_project_keys_are_stable_rejections(task_space_fixture) -> None:
    await task_space_fixture.create_project(command_id="p-one", key="PX")

    invalid = await task_space_fixture.create_project(command_id="p-bad", key="1bad")
    duplicate = await task_space_fixture.create_project(command_id="p-two", key="px")

    assert isinstance(invalid, TaskSpaceRejected)
    assert isinstance(duplicate, TaskSpaceRejected)
    assert invalid.code == "invalid_project_key"
    assert duplicate.code == "project_key_conflict"


@pytest.mark.asyncio
async def test_work_item_allocation_is_atomic_and_retry_returns_same_key(task_space_fixture) -> None:
    project = await task_space_fixture.create_project(command_id="p-alloc", key="TS")
    command = task_space_fixture.create_work_item_command(
        command_id="wi-first", project_id=project.value["id"], title="First"
    )

    first = await task_space_fixture.module.execute(task_space_fixture.scope, command)
    second = await task_space_fixture.module.execute(task_space_fixture.scope, command)
    stored_project = await task_space_fixture.read_project(project.value["id"])
    project_create_events = await task_space_fixture.visible_events(
        operation_id="p-alloc"
    )
    allocation_events = await task_space_fixture.visible_events(
        operation_id="wi-first"
    )

    assert first.value == second.value
    assert isinstance(first, TaskSpaceAccepted)
    assert first.value["display_key"] == "TS-1"
    assert stored_project["next_work_item_number"] == 2
    assert stored_project["version"] == project.value["version"] + 1
    assert stored_project["updated_at"] >= project.value["updated_at"]
    assert len(project_create_events) == 1
    assert project_create_events[0].payload == project.value
    assert {event.entity_type for event in allocation_events} == {
        "project",
        "workItem",
    }
    assert {
        event.entity_type: event.payload for event in allocation_events
    } == {
        "project": stored_project,
        "workItem": first.value,
    }
```

- [ ] **Step 2: Run the Project tests and verify the TS1 implementations are missing**

Run: `.\.venv\Scripts\python.exe -m pytest -q tests/test_task_space_project.py -p no:cacheprovider`

Expected: FAIL because the TS0 command/Protocol types import but the TS1 `task_space_fixture`, concrete Module, query implementation, and compiler do not yet exist.

- [ ] **Step 3: Lock consumption of the TS0 public contracts**

Append to `tests/test_task_space_project.py`:

```python
from app.models.work_item_definition import (
    Label,
    StatusDefinition,
    TypeDefinition,
    WorkItemLabel,
)
from app.mutation.types import canonical_payload_hash
from app.task_space.contracts import (
    CreateProject,
    CreateWorkItem,
    MutateWorkItem,
    TaskSpaceAccepted,
    TaskSpaceCommand,
    TaskSpaceCommandModule,
    TaskSpaceOutcome,
    TaskSpacePageQuery,
    TaskSpaceQueryModule,
    TaskSpaceRejected,
    WorkItemNoteCommand,
)
from app.task_space.module import _business_payload, _request


def test_ts1_consumes_ts0_contracts_without_shadow_types() -> None:
    assert TaskSpaceCommand.__args__
    assert TaskSpaceOutcome.__args__ == (TaskSpaceAccepted, TaskSpaceRejected)
    assert TaskSpaceCommandModule.__module__ == "app.task_space.contracts"
    assert TaskSpaceQueryModule.__module__ == "app.task_space.contracts"
    assert TaskSpacePageQuery.__module__ == "app.task_space.contracts"
    assert {CreateProject, CreateWorkItem, MutateWorkItem, WorkItemNoteCommand} <= set(
        TaskSpaceCommand.__args__
    )
    assert {
        model.__module__
        for model in (StatusDefinition, TypeDefinition, Label, WorkItemLabel)
    } == {"app.models.work_item_definition"}


def test_business_hash_excludes_envelope_but_request_hash_covers_it() -> None:
    business_payload = {
        "title": "Same payload",
        "description": None,
        "parent_id": None,
        "type_definition_id": None,
        "status_definition_id": None,
        "priority": None,
    }
    payload_hash = canonical_payload_hash(business_payload)
    first = CreateWorkItem(
        command_id="create-one",
        space_id="space-one",
        project_id="project-one",
        payload_hash=payload_hash,
        **business_payload,
    )
    second = CreateWorkItem(
        command_id="create-two",
        space_id="space-two",
        project_id="project-two",
        payload_hash=payload_hash,
        **business_payload,
    )

    assert _business_payload(first) == _business_payload(second) == business_payload
    assert build_task_space_request(first).request_hash != build_task_space_request(second).request_hash


def test_move_hash_excludes_project_guard_but_request_hash_covers_it() -> None:
    business_payload = {"new_parent_id": "parent-a", "child_rank": 3}
    payload_hash = canonical_payload_hash(business_payload)

    def command(project_id: str) -> MutateWorkItem:
        return MutateWorkItem(
            command_id="move-hash",
            space_id="space-a",
            work_item_id="work-item-a",
            expected_version=7,
            payload_hash=payload_hash,
            payload={
                "operation": "move",
                "project_id": project_id,
                **business_payload,
            },
        )

    first = command("project-a")
    second = command("project-b")
    first_request = build_task_space_request(first)
    second_request = build_task_space_request(second)

    assert _business_payload(first) == _business_payload(second) == business_payload
    assert first_request.payload["project_id"] == "project-a"
    assert second_request.payload["project_id"] == "project-b"
    assert first_request.request_hash != second_request.request_hash


@pytest.mark.asyncio
async def test_payload_hash_mismatch_rejects_before_uow(task_space_fixture) -> None:
    from app.task_space.module import DefaultTaskSpaceCommandModule

    class NeverCalledUow:
        async def execute(self, *args, **kwargs):
            raise AssertionError("invalid payload hash reached the UoW")

    command = CreateProject(
        command_id="bad-payload-hash",
        space_id=task_space_fixture.scope.scope.space_id,
        payload_hash="0" * 64,
        payload={"key": "PH", "name": "Payload hash", "description": None},
    )
    outcome = await DefaultTaskSpaceCommandModule(NeverCalledUow()).execute(
        task_space_fixture.scope, command
    )

    assert isinstance(outcome, TaskSpaceRejected)
    assert outcome.code == "invalid_payload_hash"
    assert outcome.retryable is False
```

Do not create `task_space/types.py` and do not replace TS0's
`task_space/__init__.py` or `task_space/contracts.py`.

- [ ] **Step 4: Implement the read-only TS0 query Interface**

```python
# backend/app/task_space/queries.py
from __future__ import annotations

from collections.abc import Mapping

from sqlalchemy import select

from app.errors import NotFoundError
from app.models.project import Project
from app.models.work_item_definition import Label, StatusDefinition, TypeDefinition
from app.runtime.space import SpaceRuntimeHandle
from app.task_space.contracts import (
    TaskSpaceDefinitionsView,
    TaskSpacePage,
    TaskSpacePageQuery,
    TaskSpaceView,
)


def _row(model) -> dict[str, object]:
    return {column.name: getattr(model, column.name) for column in model.__table__.columns}


def _page(rows: tuple[Mapping[str, object], ...], query: TaskSpacePageQuery) -> TaskSpacePage:
    start = 0
    if query.cursor is not None:
        ids = [str(row["id"]) for row in rows]
        if query.cursor not in ids:
            raise ValueError("invalid_task_space_cursor")
        start = ids.index(query.cursor) + 1
    selected = rows[start : start + query.limit]
    has_more = start + len(selected) < len(rows)
    return TaskSpacePage(
        items=selected,
        next_cursor=str(selected[-1]["id"]) if selected and has_more else None,
    )


class DefaultTaskSpaceQueryModule:
    async def list_definitions(
        self, scope: SpaceRuntimeHandle
    ) -> TaskSpaceDefinitionsView:
        async with scope.session_factory() as session:
            statuses = tuple(
                _row(row) for row in (
                    await session.execute(select(StatusDefinition).order_by(StatusDefinition.rank, StatusDefinition.id))
                ).scalars()
            )
            types = tuple(
                _row(row) for row in (
                    await session.execute(select(TypeDefinition).order_by(TypeDefinition.rank, TypeDefinition.id))
                ).scalars()
            )
            labels = tuple(
                _row(row) for row in (
                    await session.execute(select(Label).order_by(Label.name, Label.id))
                ).scalars()
            )
        return TaskSpaceDefinitionsView(statuses, types, labels)

    async def list_projects(
        self, scope: SpaceRuntimeHandle, query: TaskSpacePageQuery
    ) -> TaskSpacePage:
        async with scope.session_factory() as session:
            statement = select(Project).order_by(Project.rank, Project.id)
            if not bool(query.filters.get("include_archived", False)):
                statement = statement.where(Project.archived_at.is_(None))
            rows = tuple(_row(row) for row in (await session.execute(statement)).scalars())
        return _page(rows, query)

    async def get_project(
        self, scope: SpaceRuntimeHandle, project_id: str
    ) -> TaskSpaceView:
        async with scope.session_factory() as session:
            row = await session.get(Project, project_id)
        if row is None:
            raise NotFoundError("Project not found")
        return TaskSpaceView(_row(row))
```

- [ ] **Step 5: Implement the Task Space request factory, module Interface, and compiler registration**

```python
# backend/app/task_space/module.py
from __future__ import annotations

from collections.abc import Mapping

from app.errors import (
    IdempotencyConflictError,
    MutationRejectedError,
)
from app.mutation.types import (
    InvalidPayloadHashError,
    MutationRequest,
    require_payload_hash,
)
from app.mutation.unit_of_work import MutationUnitOfWork
from app.runtime.space import SpaceRuntimeHandle
from app.task_space.contracts import (
    CreateProject,
    CreateWorkItem,
    MutateWorkItem,
    NoteCommandKind,
    TaskSpaceAccepted,
    TaskSpaceCommand,
    TaskSpaceOutcome,
    TaskSpaceRejected,
    WorkItemNoteCommand,
)


NOTE_REQUEST_NAMES = {
    NoteCommandKind.REPLACE_DOCUMENT: "ReplaceDocument",
    NoteCommandKind.APPEND_BLOCKS: "AppendBlocks",
    NoteCommandKind.TOGGLE_CHECKLIST_ITEM: "ToggleChecklistItem",
}
WORK_ITEM_REQUEST_NAMES = {
    "update": "UpdateWorkItem",
    "move": "MoveWorkItem",
    "transition": "TransitionWorkItem",
}


def _business_payload(command: TaskSpaceCommand) -> Mapping[str, object]:
    if isinstance(command, CreateProject):
        return dict(command.payload)
    if isinstance(command, CreateWorkItem):
        return {
            "title": command.title,
            "description": command.description,
            "parent_id": command.parent_id,
            "type_definition_id": command.type_definition_id,
            "status_definition_id": command.status_definition_id,
            "priority": command.priority,
        }
    if isinstance(command, MutateWorkItem):
        operation = str(command.payload["operation"])
        payload = {
            key: value
            for key, value in command.payload.items()
            if key != "operation"
        }
        if operation == "move":
            # project_id is an authority guard, not Move business content.
            payload.pop("project_id", None)
        return payload
    if isinstance(command, WorkItemNoteCommand):
        return {
            key: value
            for key, value in command.payload.items()
            if key != "expected_source_work_item_version"
        }
    raise TypeError(f"unsupported TaskSpaceCommand: {type(command).__name__}")


def build_task_space_request(command: TaskSpaceCommand) -> MutationRequest:
    business_payload = _business_payload(command)
    require_payload_hash(command.payload_hash, business_payload)
    if isinstance(command, CreateProject):
        request_name = "CreateProject"
        entity_id = command.command_id
        expected_version = None
        payload: Mapping[str, object] = dict(command.payload)
    elif isinstance(command, CreateWorkItem):
        request_name = "CreateWorkItem"
        entity_id = command.command_id
        expected_version = None
        payload = {
            "project_id": command.project_id,
            "title": command.title,
            "description": command.description,
            "parent_id": command.parent_id,
            "type_definition_id": command.type_definition_id,
            "status_definition_id": command.status_definition_id,
            "priority": command.priority,
        }
    elif isinstance(command, MutateWorkItem):
        operation = str(command.payload["operation"])
        request_name = WORK_ITEM_REQUEST_NAMES[operation]
        entity_id = command.work_item_id or command.command_id
        expected_version = command.expected_version
        payload = {key: value for key, value in command.payload.items() if key != "operation"}
    elif isinstance(command, WorkItemNoteCommand):
        request_name = NOTE_REQUEST_NAMES[command.kind]
        entity_id = command.work_item_id
        expected_version = command.expected_version
        payload = {"work_item_id": command.work_item_id, **command.payload}
    else:  # closed TS0 union; fail loudly if its contract changes
        raise TypeError(f"unsupported TaskSpaceCommand: {type(command).__name__}")

    return MutationRequest.from_payload(
        name=f"task_space.{request_name}",
        entity_type="task_space",
        entity_id=entity_id,
        payload={
            "command_id": command.command_id,
            "space_id": command.space_id,
            "payload_hash": command.payload_hash,
            **payload,
        },
        expected_version=expected_version,
        client_updated_at=None,
    )


def _accepted(command: TaskSpaceCommand, value: Mapping[str, object]) -> TaskSpaceAccepted:
    primary = value.get("work_item_note", value)
    if not isinstance(primary, Mapping):
        raise TypeError("Task Space result requires one primary post-image")
    entity_type = (
        "project" if isinstance(command, CreateProject)
        else "work_item" if isinstance(command, (CreateWorkItem, MutateWorkItem))
        else "work_item_note"
    )
    return TaskSpaceAccepted(
        command_id=command.command_id,
        entity_type=entity_type,
        entity_id=str(primary["id"]),
        version=int(primary["version"]),
        value=value,
    )


class DefaultTaskSpaceCommandModule:
    def __init__(self, uow: MutationUnitOfWork) -> None:
        self._uow = uow

    async def execute(
        self,
        scope: SpaceRuntimeHandle,
        command: TaskSpaceCommand,
    ) -> TaskSpaceOutcome:
        try:
            result = await self._uow.execute(
                scope, build_task_space_request(command), command.command_id
            )
        except InvalidPayloadHashError as exc:
            return TaskSpaceRejected(
                command_id=command.command_id,
                code="invalid_payload_hash",
                retryable=False,
                details={"reason": str(exc)},
            )
        except MutationRejectedError as exc:
            rejection = exc.rejection
            return TaskSpaceRejected(
                command_id=command.command_id,
                code=rejection.code,
                retryable=rejection.retryable,
                details=rejection.details,
            )
        except IdempotencyConflictError as exc:
            return TaskSpaceRejected(
                command_id=command.command_id,
                code="idempotency_conflict",
                retryable=False,
                details=exc.details,
            )
        return _accepted(command, result.value)
```

All Task Space fixture/route command builders compute `payload_hash` from this
same `_business_payload` shape through S3 `canonical_payload_hash`; hard-coded
64-hex values are allowed only in the explicit mismatch test. Envelope,
authority, and CAS fields (`command_id`, `payload_hash`, `space_id`, target
entity/WorkItem ID, and `expected_version`)
are excluded from the caller payload hash but remain covered by the S3 request
hash.

For `MutateWorkItem:move`, `project_id` remains in the internal request as the
same-Project authority guard but is excluded from the business hash. The locked
Move hash shape is exactly `{"new_parent_id": ..., "child_rank": ...}`; the
separate S3 request hash still changes when `project_id` changes.

```python
# backend/app/task_space/compiler.py
from __future__ import annotations

from collections.abc import Callable, Mapping

from app.focus_session.contracts import CommandReceiptState
from app.focus_session.receipts import decode_reconcile_coordination
from app.mutation.types import MutationCommand, MutationRequest
from app.mutation.unit_of_work import MutationCompileContext
from app.services.time import utc_now_iso_ms
from app.task_space.document import InvalidNoteDocument, UnsupportedContentVersion


TASK_SPACE_POLICY_ENTITY_TYPES = frozenset({
    "task_space", "project", "status_definition", "type_definition", "label",
    "work_item_label", "work_item", "work_item_note",
})


class TaskSpaceCompiler:
    namespace = "task_space."
    entity_types = TASK_SPACE_POLICY_ENTITY_TYPES

    def __init__(self, now_iso_ms: Callable[[], str] = utc_now_iso_ms) -> None:
        self.now_iso_ms = now_iso_ms

    async def compile(
        self,
        context: MutationCompileContext,
        request: MutationRequest,
    ) -> MutationCommand:
        try:
            if request.entity_type != "task_space":
                return await self.compile_sync_entity(context, request)
            context.require_space(str(request.payload["space_id"]))
            handler_name = request.name.removeprefix(self.namespace)
            handler = getattr(self, f"compile_{handler_name}", None)
            if handler is None:
                raise RuntimeError(f"unregistered closed Task Space command: {request.name}")
            return await handler(context, request)
        except UnsupportedContentVersion as exc:
            from app.mutation.types import MutationRuleViolation

            raise MutationRuleViolation(
                "unsupported_content_version",
                {"reason": str(exc)},
                retryable=False,
            ) from exc
        except InvalidNoteDocument as exc:
            from app.mutation.types import MutationRuleViolation

            raise MutationRuleViolation(
                "invalid_note_document", {"reason": str(exc)}, retryable=False
            ) from exc
```

`compile_sync_entity` accepts only S3's exact `entity.create`, `entity.update`,
and `entity.delete` names. Its P0 matrix is closed:

| Catalog type | Client Sync mutation |
|---|---|
| `project`, `status_definition`, `type_definition`, `label`, `work_item_label` | reject create/update/delete with `offline_formal_creation_forbidden`; these remain pull/snapshot entities until an owning typed command is approved |
| `work_item` | reject create/delete; update compares the full candidate with authority and permits exactly one existing TS1 update, move, or transition shape, then calls the same tree/status helpers |
| `work_item_note` | permit strict-CAS create/update of one full canonical post-image through the same document/reference validator; reject delete |

Mixed WorkItem field families, client changes to Project/display/allocation/source
identity, unknown generic names, and partial Note patches fail before a command
is produced. A domain rejection remains one S3 prepared-batch child rejection;
it creates no entity or visible ledger effect. S4 remains limited to
`EntityCommand.from_sync_event()` and does not copy this matrix.

```python
# append to backend/app/task_space/compiler.py in Tasks 2-4
READ_ONLY_SYNC_TYPES = frozenset({
    "project", "status_definition", "type_definition", "label",
    "work_item_label",
})
ENTITY_ACTIONS = frozenset({"entity.create", "entity.update", "entity.delete"})


def _reject_formal_sync(request: MutationRequest, reason: str):
    from app.mutation.types import MutationRuleViolation

    raise MutationRuleViolation(
        "offline_formal_creation_forbidden",
        {"entity_type": request.entity_type, "reason": reason},
        retryable=False,
    )


async def compile_sync_entity(self, context, request):
    if request.name not in ENTITY_ACTIONS:
        raise RuntimeError(f"unregistered EntityCommand action: {request.name}")
    if request.entity_type in READ_ONLY_SYNC_TYPES:
        _reject_formal_sync(request, "typed_command_required")
    if request.entity_type == "work_item":
        return await self.compile_sync_work_item(context, request)
    if request.entity_type == "work_item_note":
        return await self.compile_sync_work_item_note(context, request)
    raise RuntimeError(f"unowned Task Space entity: {request.entity_type}")


TaskSpaceCompiler.compile_sync_entity = compile_sync_entity
```

Tasks 3 and 4 implement the two remaining methods from complete code blocks.
WorkItem planning uses a synthetic typed request only as an in-memory adapter to
the existing closed planner, then `_retain_sync_request(...)` rebuilds the final
`MutationCommand` with the original Sync request. Note planning calls
`_note_command` with the original request directly. Neither path calls the
public Module recursively or creates a second UoW; the persisted request always
retains the Sync intent hash, operation identity, client timestamp, and receipt.

- [ ] **Step 6: Implement Project compilation with canonical post-image events**

```python
# append to backend/app/task_space/compiler.py
import uuid

from app.mutation.types import DbMutationPlan, SyncEventPlan
from app.task_space.contracts import (
    SYSTEM_STATUS_IDS,
    SYSTEM_TYPE_ID,
    format_work_item_display_key,
    normalize_project_key,
)

TASK_SPACE_NAMESPACE = uuid.UUID("2d20283e-826f-45d2-9993-cf6609987aaa")


def _stable_id(kind: str, command_id: str) -> str:
    return uuid.uuid5(TASK_SPACE_NAMESPACE, f"{kind}\0{command_id}").hex


async def _compile_CreateProject(self, context, request):
    overlay = context.authority
    try:
        key = normalize_project_key(str(request.payload["key"]))
    except ValueError as exc:
        from app.mutation.types import MutationRuleViolation

        raise MutationRuleViolation(
            "invalid_project_key",
            {"key": str(request.payload["key"])},
            retryable=False,
        ) from exc
    if any(str(row["key"]) == key for row in overlay.scan("project")):
        from app.mutation.types import MutationRuleViolation

        raise MutationRuleViolation("project_key_conflict", {"key": key}, retryable=False)
    project_id = _stable_id("project", str(request.payload["command_id"]))
    now = self.now_iso_ms()
    after = {
        "id": project_id,
        "key": key,
        "name": str(request.payload["name"]).strip(),
        "description": request.payload.get("description"),
        "rank": len(overlay.scan("project")),
        "next_work_item_number": 1,
        "default_status_definition_id": SYSTEM_STATUS_IDS["not_started"],
        "default_type_definition_id": SYSTEM_TYPE_ID,
        "archived_at": None,
        "created_at": now,
        "updated_at": now,
        "version": 1,
    }
    plan = DbMutationPlan("projects", {"id": project_id}, "insert", None, None, after)
    event = SyncEventPlan("project", project_id, "create", after, 1, now)
    return context.command(
        request=request,
        db_plans=(plan,),
        sync_events=(event,),
        value=after,
    )


TaskSpaceCompiler.compile_CreateProject = _compile_CreateProject
```

- [ ] **Step 7: Add the Task Space fixture, run Project tests, and verify allocation remains red**

```python
# backend/tests/task_space_fixture.py
from __future__ import annotations

import hashlib
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

from app.commands.entity import EntityCommand
from app.mutation.types import canonical_payload_hash
from app.task_space.contracts import (
    SYSTEM_STATUS_IDS,
    CreateProject,
    CreateWorkItem,
    MutateWorkItem,
    NoteCommandKind,
    WorkItemNoteCommand,
    normalize_project_key,
)
from app.task_space.module import DefaultTaskSpaceCommandModule
from app.task_space.queries import DefaultTaskSpaceQueryModule


@dataclass
class FrozenClock:
    current: datetime = datetime(2026, 1, 1, tzinfo=timezone.utc)

    def now_iso_ms(self) -> str:
        return self.current.isoformat(timespec="milliseconds").replace("+00:00", "Z")

    def tick(self, milliseconds: int = 1) -> str:
        self.current += timedelta(milliseconds=milliseconds)
        return self.now_iso_ms()


@dataclass
class TaskSpaceFixture:
    mutation: object
    clock: FrozenClock
    module: DefaultTaskSpaceCommandModule
    queries: DefaultTaskSpaceQueryModule
    entity_commands: EntityCommand

    @property
    def scope(self):
        return self.mutation.scope

    @property
    def uow(self):
        return self.mutation.uow

    @property
    def catalog(self):
        return self.mutation.catalog

    @property
    def space_id(self) -> str:
        return str(self.scope.scope.space_id)

    def overlay_snapshot(self):
        return self.mutation.overlay_snapshot()

    async def visible_events(self, **filters):
        return await self.mutation.visible_events(**filters)

    def inject_fault(self, name: str) -> None:
        self.mutation.inject_fault(name)

    async def restart(self) -> None:
        restarted = await self.mutation.restart()
        if restarted is not None:
            self.mutation = restarted
        self.module = DefaultTaskSpaceCommandModule(self.mutation.uow)
        self.entity_commands = EntityCommand(self.mutation.catalog)

    async def recover(self) -> None:
        await self.mutation.recover()

    async def create_project(
        self,
        *,
        command_id: str,
        key: str,
        name: str | None = None,
        description: str | None = None,
    ):
        payload = {
            "key": normalize_project_key(key),
            "name": name or f"Project {key.strip()}",
            "description": description,
        }
        return await self.module.execute(
            self.scope,
            CreateProject(
                command_id=command_id,
                space_id=self.space_id,
                payload_hash=canonical_payload_hash(payload),
                payload=payload,
            ),
        )

    def create_work_item_command(
        self,
        *,
        command_id: str,
        project_id: str,
        title: str,
        parent_id: str | None = None,
        description: str | None = None,
        type_definition_id: str | None = None,
        status_definition_id: str | None = None,
        priority: str | None = None,
    ) -> CreateWorkItem:
        business = {
            "title": title,
            "description": description,
            "parent_id": parent_id,
            "type_definition_id": type_definition_id,
            "status_definition_id": status_definition_id,
            "priority": priority,
        }
        return CreateWorkItem(
            command_id=command_id,
            space_id=self.space_id,
            project_id=project_id,
            payload_hash=canonical_payload_hash(business),
            **business,
        )

    async def create_work_item(
        self,
        project_id: str,
        title: str,
        parent_id: str | None,
        command_id: str,
        **overrides,
    ):
        command = self.create_work_item_command(
            command_id=command_id,
            project_id=project_id,
            title=title,
            parent_id=parent_id,
            **overrides,
        )
        return await self.module.execute(self.scope, command)

    async def read_project(self, project_id: str) -> dict[str, object]:
        return dict((await self.queries.get_project(self.scope, project_id)).value)

    async def read_work_item(self, work_item_id: str) -> dict[str, object]:
        return dict((await self.queries.get_work_item(self.scope, work_item_id)).value)

    async def update_work_item(
        self, command_id: str, work_item_id: str, expected_version: int, patch: dict
    ):
        business = {"patch": patch}
        command = MutateWorkItem(
            command_id=command_id,
            space_id=self.space_id,
            work_item_id=work_item_id,
            expected_version=expected_version,
            payload_hash=canonical_payload_hash(business),
            payload={"operation": "update", **business},
        )
        return await self.module.execute(self.scope, command)

    async def move(
        self,
        work_item_id: str,
        project_id: str,
        new_parent_id: str | None,
        command_id: str,
        *,
        child_rank: int = 0,
    ):
        current = await self.read_work_item(work_item_id)
        business = {"new_parent_id": new_parent_id, "child_rank": child_rank}
        command = MutateWorkItem(
            command_id=command_id,
            space_id=self.space_id,
            work_item_id=work_item_id,
            expected_version=int(current["version"]),
            payload_hash=canonical_payload_hash(business),
            payload={"operation": "move", "project_id": project_id, **business},
        )
        return await self.module.execute(self.scope, command)

    async def transition_work_item(
        self,
        command_id: str,
        work_item_id: str,
        expected_version: int,
        status_definition_id: str,
    ):
        business = {"status_definition_id": status_definition_id}
        command = MutateWorkItem(
            command_id=command_id,
            space_id=self.space_id,
            work_item_id=work_item_id,
            expected_version=expected_version,
            payload_hash=canonical_payload_hash(business),
            payload={"operation": "transition", **business},
        )
        return await self.module.execute(self.scope, command)

    def status_id(self, category: str) -> str:
        return SYSTEM_STATUS_IDS[category]

    def _seed_key(self, prefix: str) -> str:
        return f"S{hashlib.sha256(prefix.encode()).hexdigest()[:5]}".upper()

    async def seed_level2(self, prefix: str) -> dict[str, object]:
        project = await self.create_project(
            command_id=f"{prefix}-project", key=self._seed_key(prefix)
        )
        root = await self.create_work_item(
            project.value["id"], "Root", None, f"{prefix}-root"
        )
        child = await self.create_work_item(
            project.value["id"], "Level 2", root.value["id"], f"{prefix}-level2"
        )
        return dict(child.value)

    async def seed_level3(self, prefix: str) -> dict[str, object]:
        level2 = await self.seed_level2(prefix)
        child = await self.create_work_item(
            str(level2["project_id"]),
            "Level 3",
            str(level2["id"]),
            f"{prefix}-level3",
        )
        return dict(child.value)

    async def seed_out_of_order_tree(self):
        project = await self.create_project(
            command_id="page-project", key=self._seed_key("page-project")
        )
        root_b = await self.create_work_item(
            project.value["id"], "Root B", None, "page-root-b"
        )
        root_a = await self.create_work_item(
            project.value["id"], "Root A", None, "page-root-a"
        )
        child = await self.create_work_item(
            project.value["id"], "Child", root_a.value["id"], "page-child"
        )
        rows = [dict(result.value) for result in (root_b, root_a, child)]
        ordered = sorted(
            rows,
            key=lambda row: (
                row["parent_id"] is not None,
                str(row["parent_id"] or ""),
                int(row["child_rank"]),
                str(row["id"]),
            ),
        )
        return SimpleNamespace(
            project_id=project.value["id"],
            ids_in_parent_child_rank_id_order=tuple(row["id"] for row in ordered),
        )

    def _note_command(
        self,
        kind: NoteCommandKind,
        command_id: str,
        work_item_id: str,
        expected_version: int | None,
        payload: dict[str, object],
    ) -> WorkItemNoteCommand:
        business = {
            key: value
            for key, value in payload.items()
            if key != "expected_source_work_item_version"
        }
        return WorkItemNoteCommand(
            kind=kind,
            command_id=command_id,
            space_id=self.space_id,
            work_item_id=work_item_id,
            expected_version=expected_version,
            payload_hash=canonical_payload_hash(business),
            payload=payload,
        )

    async def replace_document(
        self, command_id: str, work_item_id: str, expected_version, document
    ):
        raw = (
            document.model_dump(by_alias=True, mode="json", exclude_none=True)
            if hasattr(document, "model_dump")
            else document
        )
        command = self._note_command(
            NoteCommandKind.REPLACE_DOCUMENT,
            command_id,
            work_item_id,
            expected_version,
            {"document": raw},
        )
        return await self.module.execute(self.scope, command)

    async def append_blocks(
        self, command_id: str, work_item_id: str, expected_version: int, blocks
    ):
        command = self._note_command(
            NoteCommandKind.APPEND_BLOCKS,
            command_id,
            work_item_id,
            expected_version,
            {"blocks": list(blocks)},
        )
        return await self.module.execute(self.scope, command)

    async def toggle_checklist_item(
        self,
        command_id: str,
        work_item_id: str,
        expected_version: int,
        item_id: str,
        checked: bool,
        *,
        block_id: str = "c1",
    ):
        payload = {"block_id": block_id, "item_id": item_id, "checked": checked}
        command = self._note_command(
            NoteCommandKind.TOGGLE_CHECKLIST_ITEM,
            command_id,
            work_item_id,
            expected_version,
            payload,
        )
        return await self.module.execute(self.scope, command)

    async def seed_note(self, prefix: str) -> dict[str, object]:
        owner = await self.seed_level3(prefix)
        result = await self.replace_document(
            f"{prefix}-note",
            str(owner["id"]),
            None,
            {
                "contentVersion": 1,
                "blocks": [
                    {"blockId": "seed", "type": "paragraph", "text": "Seed"}
                ],
            },
        )
        return dict(result.value)

    def replace_command(self, note: dict, command_id: str, text: str):
        return self._note_command(
            NoteCommandKind.REPLACE_DOCUMENT,
            command_id,
            str(note["work_item_id"]),
            int(note["version"]),
            {
                "document": {
                    "contentVersion": 1,
                    "blocks": [
                        {"blockId": "replace", "type": "paragraph", "text": text}
                    ],
                }
            },
        )

    def sync_event(
        self,
        *,
        entity_type: str,
        entity_id: str,
        action: str,
        payload: dict[str, object],
        expected_version: int | None,
        client_updated_at: str | None = None,
    ):
        return SimpleNamespace(
            entity_type=entity_type,
            entity_id=entity_id,
            action=action,
            payload=payload,
            expected_version=expected_version,
            client_updated_at=client_updated_at or self.clock.tick(),
        )


# append to backend/tests/conftest.py
import pytest

from app.commands.entity import EntityCommand
from app.task_space.compiler import TaskSpaceCompiler
from app.task_space.module import DefaultTaskSpaceCommandModule
from app.task_space.queries import DefaultTaskSpaceQueryModule
from tests.task_space_fixture import FrozenClock, TaskSpaceFixture


@pytest.fixture
async def task_space_fixture(mutation_fixture_factory):
    clock = FrozenClock()
    policy = TaskSpaceCompiler(clock.now_iso_ms)
    mutation = mutation_fixture_factory(policies=(policy,))
    return TaskSpaceFixture(
        mutation=mutation,
        clock=clock,
        module=DefaultTaskSpaceCommandModule(mutation.uow),
        queries=DefaultTaskSpaceQueryModule(),
        entity_commands=EntityCommand(mutation.catalog),
    )


# append to backend/tests/test_task_space_project.py
import inspect
from pathlib import Path


def test_task_space_fixture_uses_constructor_policy_injection(
    mutation_fixture_factory,
) -> None:
    parameter = inspect.signature(mutation_fixture_factory).parameters["policies"]
    assert parameter.kind is inspect.Parameter.KEYWORD_ONLY
    fixture_sources = "\n".join(
        Path(path).read_text(encoding="utf-8")
        for path in ("tests/conftest.py", "tests/task_space_fixture.py")
    )
    assert "mutation_fixture.clock" not in fixture_sources
    assert ".register_domain_policy(" not in fixture_sources
    assert ".with_domain(" not in fixture_sources
```

Run: `.\.venv\Scripts\python.exe -m pytest -q tests/test_task_space_project.py -p no:cacheprovider`

Expected: the key/definition tests, constructor-injection admission test, and
five-type-by-three-action real-entity rejection matrix PASS; the allocation
test FAILS loudly with `RuntimeError: unregistered closed Task Space command:
task_space.CreateWorkItem`.

- [ ] **Step 8: Verify concrete Modules satisfy TS0 contracts and commit Project support**

Keep `app.task_space.__init__` unchanged. The focused test calls every concrete
method through variables typed as the TS0 Protocols and asserts there is still
only one public write entrypoint, `execute`.

Run: `.\.venv\Scripts\ruff.exe check --no-cache app/task_space tests/task_space_fixture.py tests/test_task_space_project.py tests/conftest.py`

Expected: `All checks passed!`

```powershell
git add -- app/task_space/module.py app/task_space/queries.py app/task_space/compiler.py tests/task_space_fixture.py tests/test_task_space_project.py tests/conftest.py
git commit -m "feat(task-space): add project command interface"
```

### Task 3: Implement WorkItem Allocation, Tree Moves, And Formal Status

**Files:**
- Modify: `backend/app/task_space/compiler.py`
- Modify: `backend/app/task_space/queries.py`
- Create: `backend/tests/test_task_space_tree.py`
- Modify: `backend/tests/test_task_space_project.py`

**Interfaces:**
- Consumes: Task 2 concrete Modules/compiler, TS0 WorkItem/Project/StatusDefinition/TypeDefinition rows, Session envelope/receipt rows plus `app.focus_session.receipts`, `TaskSpacePageQuery`, S3 overlay and multi-event command support.
- Produces: `compile_CreateWorkItem`, `compile_UpdateWorkItem`, `compile_MoveWorkItem`, `compile_TransitionWorkItem`, its same-UoW Session-envelope dispatch fence, `DefaultTaskSpaceQueryModule.list_work_items/get_work_item`, and stable `invalid_work_item_tree`, `version_conflict`, and `active_child_conflict` outcomes.

- [ ] **Step 1: Write failing allocation, depth, cycle, move, and status tests**

```python
from __future__ import annotations

import pytest

import app.mutation.unit_of_work as mutation_uow
from app.errors import MutationRejectedError
from app.task_space.compiler import _stable_id
from app.task_space.contracts import TaskSpacePageQuery, TaskSpaceRejected


WORK_ITEM_POST_IMAGE_FIELDS = {
    "id",
    "project_id",
    "display_key",
    "title",
    "description",
    "type_definition_id",
    "status_definition_id",
    "priority",
    "parent_id",
    "child_rank",
    "completion_window_start",
    "completion_window_end",
    "review_point",
    "hard_deadline",
    "effort_estimate_lower_seconds",
    "effort_estimate_upper_seconds",
    "effort_actual_seconds",
    "confidence",
    "completed_at",
    "cancelled_at",
    "archived_at",
    "marked_as_attention",
    "created_at",
    "updated_at",
    "version",
}


@pytest.mark.asyncio
async def test_project_counter_allocates_monotonic_display_keys(task_space_fixture) -> None:
    project = await task_space_fixture.create_project(command_id="tree-project", key="TREE")
    one = await task_space_fixture.create_work_item(project.value["id"], "Root one", None, "root-one")
    two = await task_space_fixture.create_work_item(project.value["id"], "Root two", None, "root-two")

    assert one.value["display_key"] == "TREE-1"
    assert two.value["display_key"] == "TREE-2"
    assert (await task_space_fixture.read_project(project.value["id"]))["next_work_item_number"] == 3


@pytest.mark.parametrize(
    ("category", "has_completed_at", "has_cancelled_at"),
    (("completed", True, False), ("cancelled", False, True)),
)
@pytest.mark.asyncio
async def test_create_work_item_projects_explicit_terminal_status_timestamp(
    task_space_fixture,
    category: str,
    has_completed_at: bool,
    has_cancelled_at: bool,
) -> None:
    project = await task_space_fixture.create_project(
        command_id=f"terminal-project-{category}", key=f"T{category[0].upper()}"
    )
    item = await task_space_fixture.create_work_item(
        project.value["id"],
        f"Initially {category}",
        None,
        f"terminal-item-{category}",
        status_definition_id=task_space_fixture.status_id(category),
    )

    assert (item.value["completed_at"] is not None) is has_completed_at
    assert (item.value["cancelled_at"] is not None) is has_cancelled_at


@pytest.mark.asyncio
async def test_root_child_rank_is_scoped_to_its_project(task_space_fixture) -> None:
    first_project = await task_space_fixture.create_project(
        command_id="rank-project-a", key="RA"
    )
    second_project = await task_space_fixture.create_project(
        command_id="rank-project-b", key="RB"
    )
    first_root = await task_space_fixture.create_work_item(
        first_project.value["id"], "First root", None, "rank-root-a"
    )
    second_root = await task_space_fixture.create_work_item(
        second_project.value["id"], "Second root", None, "rank-root-b"
    )

    assert first_root.value["child_rank"] == second_root.value["child_rank"] == 0


@pytest.mark.asyncio
async def test_same_payload_with_distinct_command_ids_allocates_distinct_work_items(
    task_space_fixture,
) -> None:
    project = await task_space_fixture.create_project(command_id="identity-project", key="IDENT")
    second_command_id = "i" * 128
    first = await task_space_fixture.create_work_item(
        project.value["id"], "Same payload", None, "identity-one"
    )
    second = await task_space_fixture.create_work_item(
        project.value["id"], "Same payload", None, second_command_id
    )

    assert first.value["id"] == _stable_id("work_item", "identity-one")
    assert second.value["id"] == _stable_id("work_item", second_command_id)
    assert first.value["id"] != second.value["id"]
    assert len(first.value["id"]) == len(second.value["id"]) == 32
    assert (first.value["display_key"], second.value["display_key"]) == (
        "IDENT-1",
        "IDENT-2",
    )
    events = await task_space_fixture.visible_events(operation_id=second_command_id)
    work_item_events = [event for event in events if event.entity_type == "workItem"]
    assert len(work_item_events) == 1
    assert work_item_events[0].payload == second.value
    assert set(work_item_events[0].payload) == WORK_ITEM_POST_IMAGE_FIELDS


@pytest.mark.asyncio
async def test_create_and_move_enforce_three_levels_same_project_and_no_cycle(task_space_fixture) -> None:
    project = await task_space_fixture.create_project(command_id="tree-a", key="TA")
    other = await task_space_fixture.create_project(command_id="tree-b", key="TB")
    level1 = await task_space_fixture.create_work_item(project.value["id"], "L1", None, "l1")
    level2 = await task_space_fixture.create_work_item(project.value["id"], "L2", level1.value["id"], "l2")
    level3 = await task_space_fixture.create_work_item(project.value["id"], "L3", level2.value["id"], "l3")

    fourth = await task_space_fixture.create_work_item(
        project.value["id"], "L4", level3.value["id"], "l4"
    )
    cross_project = await task_space_fixture.move(
        level2.value["id"], other.value["id"], None, "move-cross"
    )
    cycle = await task_space_fixture.move(
        level1.value["id"], project.value["id"], level3.value["id"], "move-cycle"
    )

    assert isinstance(fourth, TaskSpaceRejected)
    assert isinstance(cross_project, TaskSpaceRejected)
    assert isinstance(cycle, TaskSpaceRejected)
    assert fourth.code == cross_project.code == cycle.code == "invalid_work_item_tree"
    assert await task_space_fixture.visible_events(operation_id="move-cross") == ()
    assert (await task_space_fixture.read_work_item(level2.value["id"]))["project_id"] == project.value["id"]


@pytest.mark.asyncio
async def test_completed_and_cancelled_projection_timestamps_follow_status_category(task_space_fixture) -> None:
    item = await task_space_fixture.seed_level2("status-item")
    completed = task_space_fixture.status_id("completed")
    active = task_space_fixture.status_id("in_progress")

    done = await task_space_fixture.transition_work_item(
        "status-done", item["id"], item["version"], completed
    )
    reopened = await task_space_fixture.transition_work_item(
        "status-reopen", item["id"], done.value["version"], active
    )

    assert done.value["completed_at"] is not None
    assert done.value["cancelled_at"] is None
    assert reopened.value["completed_at"] is None
    assert reopened.value["cancelled_at"] is None


@pytest.mark.asyncio
async def test_completing_level2_with_active_level3_is_rejected(task_space_fixture) -> None:
    level2 = await task_space_fixture.seed_level2("active-child-parent")
    await task_space_fixture.create_work_item(
        level2["project_id"], "Still active", level2["id"], "active-child"
    )

    outcome = await task_space_fixture.transition_work_item(
        "complete-with-active-child",
        level2["id"],
        level2["version"],
        task_space_fixture.status_id("completed"),
    )

    assert isinstance(outcome, TaskSpaceRejected)
    assert outcome.code == "active_child_conflict"


@pytest.mark.asyncio
async def test_list_work_items_is_a_stable_flat_project_page(task_space_fixture) -> None:
    tree = await task_space_fixture.seed_out_of_order_tree()
    page = await task_space_fixture.queries.list_work_items(
        task_space_fixture.scope,
        TaskSpacePageQuery(None, 100, {"project_id": tree.project_id}),
    )

    assert [row["id"] for row in page.items] == tree.ids_in_parent_child_rank_id_order
    assert page.next_cursor is None

    first = await task_space_fixture.queries.list_work_items(
        task_space_fixture.scope,
        TaskSpacePageQuery(None, 2, {"project_id": tree.project_id}),
    )
    second = await task_space_fixture.queries.list_work_items(
        task_space_fixture.scope,
        TaskSpacePageQuery(first.next_cursor, 100, {"project_id": tree.project_id}),
    )
    assert first.next_cursor is not None
    assert [row["id"] for row in (*first.items, *second.items)] == list(
        tree.ids_in_parent_child_rank_id_order
    )


@pytest.mark.asyncio
async def test_update_and_detail_query_share_the_same_post_image(task_space_fixture) -> None:
    item = await task_space_fixture.seed_level2("update-detail")
    updated = await task_space_fixture.update_work_item(
        "update-detail-command",
        item["id"],
        item["version"],
        {"title": "Renamed"},
    )
    fetched = await task_space_fixture.queries.get_work_item(
        task_space_fixture.scope, item["id"]
    )
    events = await task_space_fixture.visible_events(
        operation_id="update-detail-command"
    )

    assert fetched.value == updated.value
    assert len(events) == 1
    assert events[0].entity_type == "workItem"
    assert events[0].payload == updated.value
    assert set(events[0].payload) == WORK_ITEM_POST_IMAGE_FIELDS
```

In the same file, use S3 `EntityCommand.from_sync_event()` to create three
failing RED vectors before adding the WorkItem Sync branch: client Sync create
and delete return `offline_formal_creation_forbidden`; a Sync update that moves
the item across Project or produces depth four returns
`invalid_work_item_tree`; and a Sync update that combines move plus formal
status transition returns `work_item_structure_changed`. Each runs through the
real `MutationUnitOfWork` and leaves the authoritative row/version and visible
ledger unchanged. Add one accepted scalar update, one accepted move, and one
accepted transition vector; compare their post-images byte-for-byte with the
corresponding typed TS1 command results.

Use this exact action matrix for the create/update/delete branch:

```python
@pytest.mark.parametrize("action", ("create", "update", "delete"))
@pytest.mark.asyncio
async def test_sync_work_item_action_matrix_is_policy_owned(
    task_space_fixture,
    monkeypatch,
    action: str,
) -> None:
    item = await task_space_fixture.seed_level2(f"sync-work-item-{action}")
    client_updated_at = task_space_fixture.clock.tick()
    payload = (
        {
            **item,
            "title": "Accepted Sync scalar update",
            "updated_at": client_updated_at,
            "version": int(item["version"]) + 1,
        }
        if action == "update"
        else {}
    )
    entity_id = str(item["id"]) if action != "create" else "offline-work-item"
    event = task_space_fixture.sync_event(
        entity_type="workItem",
        entity_id=entity_id,
        action=action,
        payload=payload,
        expected_version=None if action == "create" else int(item["version"]),
        client_updated_at=client_updated_at,
    )
    request = task_space_fixture.entity_commands.from_sync_event(
        task_space_fixture.scope, event
    )
    operation_id = f"sync-work-item-{action}-matrix"
    before = task_space_fixture.overlay_snapshot()

    async def poison_generic_fallback(*args, **kwargs):
        raise AssertionError("workItem reached generic fallback")

    monkeypatch.setattr(
        mutation_uow, "compile_catalog_entity_command", poison_generic_fallback
    )
    if action == "update":
        result = await task_space_fixture.uow.execute(
            task_space_fixture.scope, request, operation_id
        )
        assert result.value["title"] == "Accepted Sync scalar update"
        events = await task_space_fixture.visible_events(operation_id=operation_id)
        assert len(events) == 1
        assert events[0].entity_type == "workItem"
        assert events[0].payload == result.value
    else:
        with pytest.raises(MutationRejectedError) as caught:
            await task_space_fixture.uow.execute(
                task_space_fixture.scope, request, operation_id
            )
        assert caught.value.rejection.code == "offline_formal_creation_forbidden"
        assert task_space_fixture.overlay_snapshot() == before
        assert await task_space_fixture.visible_events(operation_id=operation_id) == ()
```

Also add the exact server-managed tamper matrix; it poisons generic fallback so
the test cannot pass through the catalog compiler accidentally:

```python
@pytest.mark.parametrize(
    ("field", "replacement"),
    (
        ("display_key", "FORGED-99"),
        ("created_at", "2025-01-01T00:00:00.000Z"),
        ("updated_at", "2025-01-01T00:00:00.000Z"),
        ("effort_actual_seconds", 999),
        ("completed_at", "2025-01-01T00:00:00.000Z"),
        ("version", 999),
    ),
)
@pytest.mark.asyncio
async def test_sync_work_item_server_managed_tamper_is_zero_effect(
    task_space_fixture,
    monkeypatch,
    field: str,
    replacement,
) -> None:
    item = await task_space_fixture.seed_level2(f"sync-tamper-{field}")
    client_updated_at = task_space_fixture.clock.tick()
    candidate = {
        **item,
        "title": f"Accepted scalar shape for {field}",
        "updated_at": client_updated_at,
        "version": int(item["version"]) + 1,
        field: replacement,
    }
    operation_id = f"sync-tamper-{field}"
    event = task_space_fixture.sync_event(
        entity_type="workItem",
        entity_id=str(item["id"]),
        action="update",
        payload=candidate,
        expected_version=int(item["version"]),
        client_updated_at=client_updated_at,
    )
    request = task_space_fixture.entity_commands.from_sync_event(
        task_space_fixture.scope, event
    )
    before = task_space_fixture.overlay_snapshot()

    async def poison_generic_fallback(*args, **kwargs):
        raise AssertionError("workItem reached generic fallback")

    monkeypatch.setattr(
        mutation_uow, "compile_catalog_entity_command", poison_generic_fallback
    )
    with pytest.raises(MutationRejectedError) as caught:
        await task_space_fixture.uow.execute(
            task_space_fixture.scope, request, operation_id
        )

    assert caught.value.rejection.code == "work_item_structure_changed"
    assert task_space_fixture.overlay_snapshot() == before
    assert await task_space_fixture.visible_events(operation_id=operation_id) == ()
```

- [ ] **Step 2: Run the tree tests and verify the compiler rejects missing handlers**

Run: `.\.venv\Scripts\python.exe -m pytest -q tests/test_task_space_project.py tests/test_task_space_tree.py -p no:cacheprovider`

Expected: FAIL loudly with `RuntimeError: unregistered closed Task Space command`
for typed create/move/transition and `AttributeError: compile_sync_work_item` for
the real-entity matrix; no test may pass through generic fallback.

- [ ] **Step 3: Implement tree helpers and whole-subtree validation**

```python
# append to backend/app/task_space/compiler.py
def _require_row(overlay, entity_type: str, entity_id: str) -> dict[str, object]:
    row = overlay.get(entity_type, entity_id)
    if row is None:
        from app.mutation.types import MutationRuleViolation

        raise MutationRuleViolation(
            "not_found",
            {"entity_type": entity_type, "id": entity_id},
            retryable=False,
        )
    return dict(row)


def _parent_depth(overlay, parent_id: str | None, project_id: str) -> int:
    depth = 0
    current = parent_id
    visited: set[str] = set()
    while current is not None:
        if current in visited:
            from app.mutation.types import MutationRuleViolation

            raise MutationRuleViolation(
                "invalid_work_item_tree", {"reason": "cycle"}, retryable=False
            )
        visited.add(current)
        parent = _require_row(overlay, "work_item", current)
        if parent["project_id"] != project_id:
            from app.mutation.types import MutationRuleViolation

            raise MutationRuleViolation(
                "invalid_work_item_tree",
                {"reason": "cross_project_parent"},
                retryable=False,
            )
        depth += 1
        current = parent["parent_id"]
    return depth


def _descendants(overlay, root_id: str) -> tuple[dict[str, object], ...]:
    rows = tuple(dict(row) for row in overlay.scan("work_item"))
    output: list[dict[str, object]] = []
    frontier = [root_id]
    while frontier:
        parent = frontier.pop()
        children = [row for row in rows if row["parent_id"] == parent]
        output.extend(children)
        frontier.extend(str(row["id"]) for row in children)
    return tuple(output)


def _subtree_relative_depth(overlay, root_id: str) -> int:
    rows = _descendants(overlay, root_id)
    if not rows:
        return 1
    parent_by_id = {str(row["id"]): row["parent_id"] for row in rows}
    maximum = 1
    for row in rows:
        depth = 2
        parent = row["parent_id"]
        while parent in parent_by_id:
            depth += 1
            parent = parent_by_id[str(parent)]
        maximum = max(maximum, depth)
    return maximum
```

- [ ] **Step 4: Implement WorkItem create with atomic Project counter allocation**

```python
# append to backend/app/task_space/compiler.py
async def _compile_CreateWorkItem(self, context, request):
    overlay = context.authority
    project = _require_row(overlay, "project", str(request.payload["project_id"]))
    parent_id = request.payload.get("parent_id")
    parent_depth = _parent_depth(overlay, parent_id, str(project["id"]))
    if parent_depth >= 3:
        from app.mutation.types import MutationRuleViolation

        raise MutationRuleViolation(
            "invalid_work_item_tree",
            {"reason": "depth_exceeds_three"},
            retryable=False,
        )
    number = int(project["next_work_item_number"])
    work_item_id = _stable_id("work_item", str(request.payload["command_id"]))
    now = self.now_iso_ms()
    type_definition_id = (
        request.payload.get("type_definition_id")
        or project["default_type_definition_id"]
    )
    status_definition_id = (
        request.payload.get("status_definition_id")
        or project["default_status_definition_id"]
    )
    _require_row(overlay, "type_definition", str(type_definition_id))
    status_definition = _require_row(
        overlay, "status_definition", str(status_definition_id)
    )
    status_definition_id = status_definition["id"]
    status_category = str(status_definition["category"])
    project_after = {
        **project,
        "next_work_item_number": number + 1,
        "updated_at": now,
        "version": int(project["version"]) + 1,
    }
    item_after = {
        "id": work_item_id,
        "project_id": project["id"],
        "display_key": format_work_item_display_key(str(project["key"]), number),
        "title": str(request.payload["title"]).strip(),
        "description": request.payload.get("description"),
        "type_definition_id": type_definition_id,
        "status_definition_id": status_definition_id,
        "priority": request.payload.get("priority"),
        "parent_id": parent_id,
        "child_rank": len([
            row
            for row in overlay.scan("work_item")
            if row["project_id"] == project["id"] and row["parent_id"] == parent_id
        ]),
        "completion_window_start": None,
        "completion_window_end": None,
        "review_point": None,
        "hard_deadline": None,
        "effort_estimate_lower_seconds": None,
        "effort_estimate_upper_seconds": None,
        "effort_actual_seconds": 0,
        "confidence": None,
        "completed_at": now if status_category == "completed" else None,
        "cancelled_at": now if status_category == "cancelled" else None,
        "archived_at": None,
        "marked_as_attention": False,
        "created_at": now,
        "updated_at": now,
        "version": 1,
    }
    plans = (
        DbMutationPlan("projects", {"id": project["id"]}, "update", int(project["version"]), project, project_after),
        DbMutationPlan("work_items", {"id": work_item_id}, "insert", None, None, item_after),
    )
    events = (
        SyncEventPlan("project", str(project["id"]), "update", project_after, int(project_after["version"]), now),
        SyncEventPlan("work_item", work_item_id, "create", item_after, 1, now),
    )
    return context.command(
        request=request,
        db_plans=plans,
        sync_events=events,
        value=item_after,
    )


TaskSpaceCompiler.compile_CreateWorkItem = _compile_CreateWorkItem
```

- [ ] **Step 5: Implement move and status-transition compilation**

```python
# append to backend/app/task_space/compiler.py
async def _compile_UpdateWorkItem(self, context, request):
    overlay = context.authority
    item = _require_row(overlay, "work_item", request.entity_id)
    if int(item["version"]) != request.expected_version:
        from app.mutation.types import MutationRuleViolation

        raise MutationRuleViolation(
            "version_conflict", {"current_version": item["version"]}, retryable=False
        )
    patch = dict(request.payload["patch"])
    allowed = {
        "title", "description", "type_definition_id", "priority",
        "completion_window_start", "completion_window_end", "review_point",
        "hard_deadline", "effort_estimate_lower_seconds",
        "effort_estimate_upper_seconds", "confidence", "archived_at",
        "marked_as_attention",
    }
    unexpected = set(patch) - allowed
    if unexpected:
        raise RuntimeError(f"unregistered WorkItem patch fields: {sorted(unexpected)}")
    if patch.get("type_definition_id") is not None:
        _require_row(overlay, "type_definition", str(patch["type_definition_id"]))
    now = self.now_iso_ms()
    after = {
        **item,
        **patch,
        "updated_at": now,
        "version": int(item["version"]) + 1,
    }
    plan = DbMutationPlan(
        "work_items", {"id": item["id"]}, "update",
        request.expected_version, item, after,
    )
    event = SyncEventPlan(
        "work_item", str(item["id"]), "update", after, int(after["version"]), now
    )
    return context.command(
        request=request, db_plans=(plan,), sync_events=(event,), value=after
    )


async def _compile_MoveWorkItem(self, context, request):
    overlay = context.authority
    item = _require_row(overlay, "work_item", request.entity_id)
    if int(item["version"]) != request.expected_version:
        from app.mutation.types import MutationRuleViolation

        raise MutationRuleViolation(
            "version_conflict", {"current_version": item["version"]}, retryable=False
        )
    requested_project_id = str(request.payload["project_id"])
    _require_row(overlay, "project", requested_project_id)
    if requested_project_id != str(item["project_id"]):
        from app.mutation.types import MutationRuleViolation

        raise MutationRuleViolation(
            "invalid_work_item_tree",
            {"reason": "cross_project_move"},
            retryable=False,
        )
    parent_id = request.payload.get("new_parent_id")
    if parent_id is not None:
        parent = _require_row(overlay, "work_item", str(parent_id))
        if str(parent["project_id"]) != requested_project_id:
            from app.mutation.types import MutationRuleViolation

            raise MutationRuleViolation(
                "invalid_work_item_tree",
                {"reason": "cross_project_parent"},
                retryable=False,
            )
    if parent_id == item["id"] or parent_id in {row["id"] for row in _descendants(overlay, str(item["id"]))}:
        from app.mutation.types import MutationRuleViolation

        raise MutationRuleViolation(
            "invalid_work_item_tree", {"reason": "cycle"}, retryable=False
        )
    new_parent_depth = _parent_depth(overlay, parent_id, str(item["project_id"]))
    if new_parent_depth + _subtree_relative_depth(overlay, str(item["id"])) > 3:
        from app.mutation.types import MutationRuleViolation

        raise MutationRuleViolation(
            "invalid_work_item_tree", {"reason": "subtree_depth"}, retryable=False
        )
    now = self.now_iso_ms()
    after = {
        **item,
        "parent_id": parent_id,
        "child_rank": int(request.payload["child_rank"]),
        "updated_at": now,
        "version": int(item["version"]) + 1,
    }
    plan = DbMutationPlan("work_items", {"id": item["id"]}, "update", request.expected_version, item, after)
    event = SyncEventPlan("work_item", str(item["id"]), "update", after, int(after["version"]), now)
    return context.command(
        request=request,
        db_plans=(plan,),
        sync_events=(event,),
        value=after,
    )


def _require_session_envelope_dispatch_claim(overlay, request) -> None:
    command_id = str(request.payload["command_id"])
    envelope = overlay.get("session_command_envelope", command_id)
    if envelope is None:
        return
    target_status_id = {
        "complete": SYSTEM_STATUS_IDS["completed"],
        "cancel": SYSTEM_STATUS_IDS["cancelled"],
    }[str(envelope["target_transition"])]
    identity_matches = (
        str(envelope["space_id"]) == str(request.payload["space_id"])
        and str(envelope["work_item_id"]) == request.entity_id
        and int(envelope["expected_version"]) == request.expected_version
        and str(envelope["payload_hash"]) == str(request.payload["payload_hash"])
        and target_status_id == str(request.payload["status_definition_id"])
    )
    receipt = overlay.get("session_command_receipt", command_id)
    coordination = (
        None
        if receipt is None
        else decode_reconcile_coordination(
            state=CommandReceiptState(str(receipt["state"])),
            result_json=receipt.get("result_json"),
        )
    )
    if not identity_matches or coordination is None or (
        coordination["kind"] != "replay_claimed"
    ):
        from app.mutation.types import MutationRuleViolation

        raise MutationRuleViolation(
            "idempotency_conflict",
            {"reason": "session_command_not_replay_claimed"},
            retryable=False,
        )


async def _compile_TransitionWorkItem(self, context, request):
    overlay = context.authority
    _require_session_envelope_dispatch_claim(overlay, request)
    item = _require_row(overlay, "work_item", request.entity_id)
    status = _require_row(overlay, "status_definition", str(request.payload["status_definition_id"]))
    if int(item["version"]) != request.expected_version:
        from app.mutation.types import MutationRuleViolation

        raise MutationRuleViolation(
            "version_conflict", {"current_version": item["version"]}, retryable=False
        )
    item_depth = _parent_depth(
        overlay, item["parent_id"], str(item["project_id"])
    ) + 1
    if status["category"] == "completed" and item_depth == 2:
        active_categories = {"not_started", "in_progress", "paused", "waiting"}
        statuses = {row["id"]: row["category"] for row in overlay.scan("status_definition")}
        active_children = [
            row["id"] for row in overlay.scan("work_item")
            if row["parent_id"] == item["id"] and statuses[row["status_definition_id"]] in active_categories
        ]
        if active_children:
            from app.mutation.types import MutationRuleViolation

            raise MutationRuleViolation(
                "active_child_conflict",
                {"work_item_ids": active_children},
                retryable=False,
            )
    now = self.now_iso_ms()
    category = str(status["category"])
    after = {
        **item,
        "status_definition_id": status["id"],
        "completed_at": now if category == "completed" else None,
        "cancelled_at": now if category == "cancelled" else None,
        "updated_at": now,
        "version": int(item["version"]) + 1,
    }
    plan = DbMutationPlan("work_items", {"id": item["id"]}, "update", request.expected_version, item, after)
    event = SyncEventPlan("work_item", str(item["id"]), "update", after, int(after["version"]), now)
    return context.command(
        request=request,
        db_plans=(plan,),
        sync_events=(event,),
        value=after,
    )


TaskSpaceCompiler.compile_UpdateWorkItem = _compile_UpdateWorkItem
TaskSpaceCompiler.compile_MoveWorkItem = _compile_MoveWorkItem
TaskSpaceCompiler.compile_TransitionWorkItem = _compile_TransitionWorkItem
```

The envelope guard runs under the same S3 Space-exclusive UoW and before any
WorkItem/status authority read. A Session envelope reserves its `command_id`:
the exact transition may compile only while its current receipt carries
`replay_claimed(root)`. A missing claim, `replay_finished_unknown`, or terminal
`abandoned` receipt produces the stored `idempotency_conflict` above with zero
WorkItem/Sync effects; that rejected S3 operation becomes the durable fence for
the envelope ID. If the Task Space operation wins the lease first, later
reconciliation queries and adopts that terminal original result. Thus direct
REST/Sync use of an abandoned or unclaimed envelope cannot bypass replay
admission, while an already-authorized exact replay still uses the public Task
Space Module and its original operation ID.

The transition authority loader must include the optional
`session_command_envelope` and `session_command_receipt` rows keyed by
`request.payload["command_id"]` in the same immutable overlay snapshot; an
unloaded row is never treated as absent. Focused tests cover no envelope, exact
claimed envelope, unclaimed/pending, finished-unknown, abandoned, malformed
coordination, and envelope/request identity mismatch through the real UoW. Every
rejected branch asserts a durable rejection receipt plus zero WorkItem and Sync
effects.

Implement the real-entity WorkItem branch in this same step. The synthetic
typed request is used only to reuse the closed TS1 planner; `_retain_sync_request`
rebuilds the final command with the original S3 request, so intent hash,
operation identity, client timestamp, and durable receipt remain authoritative.

```python
# append to backend/app/task_space/compiler.py
WORK_ITEM_SYNC_FIELDS = frozenset({
    "id", "project_id", "display_key", "title", "description",
    "type_definition_id", "status_definition_id", "priority", "parent_id",
    "child_rank", "completion_window_start", "completion_window_end",
    "review_point", "hard_deadline", "effort_estimate_lower_seconds",
    "effort_estimate_upper_seconds", "effort_actual_seconds", "confidence",
    "completed_at", "cancelled_at", "archived_at", "marked_as_attention",
    "created_at", "updated_at", "version",
})
WORK_ITEM_SCALAR_FIELDS = frozenset({
    "title", "description", "type_definition_id", "priority",
    "completion_window_start", "completion_window_end", "review_point",
    "hard_deadline", "effort_estimate_lower_seconds",
    "effort_estimate_upper_seconds", "confidence", "archived_at",
    "marked_as_attention",
})
WORK_ITEM_MOVE_FIELDS = frozenset({"project_id", "parent_id", "child_rank"})
WORK_ITEM_STATUS_FIELDS = frozenset({
    "status_definition_id", "completed_at", "cancelled_at",
})
WORK_ITEM_IMMUTABLE_FIELDS = frozenset({
    "display_key", "effort_actual_seconds", "created_at",
})


def _reject_work_item_sync(reason: str, **details) -> None:
    from app.mutation.types import MutationRuleViolation

    raise MutationRuleViolation(
        "work_item_structure_changed",
        {"reason": reason, **details},
        retryable=False,
    )


def _typed_sync_request(
    original: MutationRequest,
    handler_name: str,
    payload: Mapping[str, object],
) -> MutationRequest:
    return MutationRequest.from_payload(
        name=f"task_space.{handler_name}",
        entity_type="task_space",
        entity_id=original.entity_id,
        payload=payload,
        expected_version=original.expected_version,
        client_updated_at=None,
    )


def _retain_sync_request(context, original: MutationRequest, planned: MutationCommand):
    return context.command(
        request=original,
        db_plans=planned.db_plans,
        projections=planned.projections,
        sync_events=planned.sync_events,
        value=planned.result_value,
    )


def _full_work_item_sync_candidate(
    request: MutationRequest,
    before: Mapping[str, object],
) -> dict[str, object]:
    from app.mutation.types import MutationRuleViolation

    expected_payload_fields = WORK_ITEM_SYNC_FIELDS - {"id"}
    actual_fields = set(request.payload)
    if actual_fields != expected_payload_fields:
        _reject_work_item_sync(
            "full_post_image_required",
            missing=sorted(expected_payload_fields - actual_fields),
            extra=sorted(actual_fields - expected_payload_fields),
        )
    if int(before["version"]) != request.expected_version:
        raise MutationRuleViolation(
            "version_conflict",
            {"current_version": before["version"]},
            retryable=False,
        )
    candidate = {"id": request.entity_id, **dict(request.payload)}
    if candidate["id"] != before["id"]:
        _reject_work_item_sync("entity_id_changed")
    version = candidate["version"]
    if type(version) is not int or version != int(before["version"]) + 1:
        _reject_work_item_sync("invalid_candidate_version")
    if candidate["updated_at"] != request.client_updated_at:
        _reject_work_item_sync("updated_at_not_client_timestamp")
    return candidate


async def _compile_sync_work_item(self, context, request):
    if request.name != "entity.update":
        _reject_formal_sync(request, "typed_create_or_delete_required")

    before = _require_row(context.authority, "work_item", request.entity_id)
    candidate = _full_work_item_sync_candidate(request, before)
    semantic_changes = {
        field
        for field in WORK_ITEM_SYNC_FIELDS - {"id", "version", "updated_at"}
        if candidate[field] != before[field]
    }
    immutable_changes = semantic_changes & WORK_ITEM_IMMUTABLE_FIELDS
    if immutable_changes:
        _reject_work_item_sync(
            "server_managed_field_changed", fields=sorted(immutable_changes)
        )

    scalar_changes = semantic_changes & WORK_ITEM_SCALAR_FIELDS
    move_changes = semantic_changes & WORK_ITEM_MOVE_FIELDS
    status_changes = semantic_changes & WORK_ITEM_STATUS_FIELDS
    known = scalar_changes | move_changes | status_changes | WORK_ITEM_IMMUTABLE_FIELDS
    unknown = semantic_changes - known
    if unknown:
        _reject_work_item_sync("unowned_field_changed", fields=sorted(unknown))
    if status_changes and "status_definition_id" not in status_changes:
        _reject_work_item_sync("status_projection_changed_without_transition")
    families = tuple(
        name
        for name, fields in (
            ("scalar", scalar_changes),
            ("move", move_changes),
            ("status", status_changes),
        )
        if fields
    )
    if len(families) != 1:
        _reject_work_item_sync("exactly_one_operation_family_required", families=families)

    family = families[0]
    if family == "scalar":
        typed = _typed_sync_request(
            request,
            "UpdateWorkItem",
            {"patch": {field: candidate[field] for field in scalar_changes}},
        )
        planned = await _compile_UpdateWorkItem(self, context, typed)
    elif family == "move":
        if type(candidate["child_rank"]) is not int or candidate["child_rank"] < 0:
            _reject_work_item_sync("invalid_child_rank")
        typed = _typed_sync_request(
            request,
            "MoveWorkItem",
            {
                "project_id": candidate["project_id"],
                "new_parent_id": candidate["parent_id"],
                "child_rank": candidate["child_rank"],
            },
        )
        planned = await _compile_MoveWorkItem(self, context, typed)
    else:
        typed = _typed_sync_request(
            request,
            "TransitionWorkItem",
            {"status_definition_id": candidate["status_definition_id"]},
        )
        planned = await _compile_TransitionWorkItem(self, context, typed)
    return _retain_sync_request(context, request, planned)


TaskSpaceCompiler.compile_sync_work_item = _compile_sync_work_item
```

Append the exact shape equality test only after the production constant exists:

```python
# in backend/tests/test_task_space_tree.py, extend the existing compiler import
from app.task_space.compiler import WORK_ITEM_SYNC_FIELDS, _stable_id


def test_work_item_sync_candidate_shape_matches_every_ts0_post_image_field() -> None:
    assert WORK_ITEM_SYNC_FIELDS == WORK_ITEM_POST_IMAGE_FIELDS
```

The candidate's `version` must be exactly authority `version + 1`, its
`updated_at` must equal S4's canonical `client_updated_at`, and its `created_at`,
display/allocation identity and actual effort are immutable.
The typed planner recomputes the stored `version`, server `updated_at`, status
projection timestamps, and complete event post-image.

`effort_actual_seconds` is immutable at every Task Space/REST/Sync command
boundary, but it is a materialized derived projection rather than frozen data.
TS2's registered `FocusSessionMutationPolicy` is its sole writer: that policy
recomputes valid terminal Session effort inside S3 and publishes the resulting
complete WorkItem post-image. TS1 always preserves the authority value and
never adds a user-facing "set actual effort" command.

- [ ] **Step 6: Add TS0 WorkItem page and detail query methods**

```python
# append to backend/app/task_space/queries.py
from app.models.work_item import WorkItem


async def list_work_items(
    self: DefaultTaskSpaceQueryModule,
    scope: SpaceRuntimeHandle,
    query: TaskSpacePageQuery,
) -> TaskSpacePage:
    project_id = str(query.filters["project_id"])
    async with scope.session_factory() as session:
        rows = tuple(_row(row) for row in (
            await session.execute(
                select(WorkItem)
                .where(WorkItem.project_id == project_id)
                .order_by(WorkItem.parent_id, WorkItem.child_rank, WorkItem.id)
            )
        ).scalars())
    return _page(rows, query)


async def get_work_item(
    self: DefaultTaskSpaceQueryModule,
    scope: SpaceRuntimeHandle,
    work_item_id: str,
) -> TaskSpaceView:
    async with scope.session_factory() as session:
        row = await session.get(WorkItem, work_item_id)
    if row is None:
        raise NotFoundError("WorkItem not found")
    return TaskSpaceView(_row(row))


DefaultTaskSpaceQueryModule.list_work_items = list_work_items
DefaultTaskSpaceQueryModule.get_work_item = get_work_item
```

- [ ] **Step 7: Run tree, Project, S3 CAS, and UoW regression tests**

Run: `.\.venv\Scripts\python.exe -m pytest -q tests/test_task_space_project.py tests/test_task_space_tree.py tests/test_entity_invariants.py tests/test_entity_concurrency.py tests/test_mutation_journal.py -p no:cacheprovider`

Expected: PASS; Project keys allocate monotonically, invalid trees reject before
writes, initial and transitioned status categories drive projection timestamps,
all three real WorkItem Sync actions remain policy-owned, server-managed tamper
is zero-effect, and S3 generic CAS/journal tests remain green.

- [ ] **Step 8: Run Ruff and commit WorkItem tree support**

Run: `.\.venv\Scripts\ruff.exe check --no-cache app/task_space/compiler.py app/task_space/queries.py tests/test_task_space_project.py tests/test_task_space_tree.py`

Expected: `All checks passed!`

```powershell
git add -- app/task_space/compiler.py app/task_space/queries.py tests/test_task_space_project.py tests/test_task_space_tree.py
git commit -m "feat(task-space): enforce work item tree and status"
```

### Task 4: Implement WorkItemNote Replace, Append, Toggle, CAS, And Idempotency

**Files:**
- Modify: `backend/app/task_space/compiler.py`
- Modify: `backend/app/task_space/queries.py`
- Create: `backend/tests/test_work_item_note_cas.py`

**Interfaces:**
- Consumes: Task 1 document helpers, Task 2 command module, S3 expected-version CAS and durable operation receipts, TS0 WorkItemNote one-to-one schema.
- Produces: `compile_ReplaceDocument`, `compile_AppendBlocks`, `compile_ToggleChecklistItem`, `DefaultTaskSpaceQueryModule.read_note(scope, work_item_id)`, and full-post-image internal `work_item_note` events that S3 resolves to the `workItemNote` wire key.

- [ ] **Step 1: Write failing replace/append/toggle, CAS, and retry tests**

```python
from __future__ import annotations

import json

import pytest

import app.mutation.unit_of_work as mutation_uow
from app.errors import MutationRejectedError
from app.task_space.compiler import _stable_id
from app.task_space.contracts import TaskSpaceRejected
from app.task_space.document import canonical_document_json, parse_document_v1


@pytest.mark.asyncio
async def test_replace_append_and_toggle_emit_full_canonical_post_images(task_space_fixture) -> None:
    item = await task_space_fixture.seed_level3("note-owner")
    initial = parse_document_v1({
        "contentVersion": 1,
        "blocks": [{"blockId": "p1", "type": "paragraph", "text": "Start"}],
    })
    created = await task_space_fixture.replace_document(
        "note-create", item["id"], None, initial
    )
    appended = await task_space_fixture.append_blocks(
        "note-append",
        item["id"],
        created.value["version"],
        ({
                "blockId": "c1", "type": "checklist",
                "items": [{
                    "itemId": "check-1", "text": "Verify",
                    "checked": False, "children": [],
                }],
        },),
    )
    toggled = await task_space_fixture.toggle_checklist_item(
        "note-toggle", item["id"], appended.value["version"], "check-1", True
    )

    assert json.loads(toggled.value["document_json"])["blocks"][1]["items"][0]["checked"] is True
    events = await task_space_fixture.visible_events(entity_type="workItemNote")
    assert [event.payload for event in events][-1] == toggled.value
    stored_item = await task_space_fixture.queries.get_work_item(
        task_space_fixture.scope, item["id"]
    )
    assert stored_item.value["status_definition_id"] == item["status_definition_id"]
    assert stored_item.value["version"] == item["version"]


@pytest.mark.asyncio
@pytest.mark.parametrize("block", (
    {"blockId": "sixth", "type": "code", "text": "no"},
    {"blockId": "extra", "type": "paragraph", "text": "x", "rank": 1},
    {"blockId": "missing", "type": "checklist"},
))
async def test_invalid_append_block_is_a_stable_zero_effect_rejection(
    task_space_fixture, block,
) -> None:
    note = await task_space_fixture.seed_note("invalid-append")
    operation_id = f"invalid-append-{block['blockId']}"
    result = await task_space_fixture.append_blocks(
        operation_id, note["work_item_id"], note["version"], (block,),
    )

    assert isinstance(result, TaskSpaceRejected)
    assert result.code == "invalid_note_document"
    assert await task_space_fixture.visible_events(operation_id=operation_id) == ()
    stored = await task_space_fixture.queries.read_note(
        task_space_fixture.scope, note["work_item_id"]
    )
    assert stored is not None
    assert stored.value["document_json"] == note["document_json"]


@pytest.mark.asyncio
async def test_note_cas_preserves_authoritative_document_and_returns_current_version(
    task_space_fixture,
) -> None:
    note = await task_space_fixture.seed_note("cas-note")
    left = task_space_fixture.replace_command(note, "left-write", "Left")
    right = task_space_fixture.replace_command(note, "right-write", "Right")

    winner = await task_space_fixture.module.execute(task_space_fixture.scope, left)
    conflict = await task_space_fixture.module.execute(task_space_fixture.scope, right)

    stored = await task_space_fixture.queries.read_note(task_space_fixture.scope, note["work_item_id"])
    assert stored is not None
    assert stored.value["document_json"] == winner.value["document_json"]
    assert isinstance(conflict, TaskSpaceRejected)
    assert conflict.code == "version_conflict"
    assert conflict.details["current_version"] == winner.value["version"]


@pytest.mark.asyncio
async def test_same_note_command_id_reuses_receipt_and_changed_payload_conflicts(task_space_fixture) -> None:
    note = await task_space_fixture.seed_note("idempotent-note")
    command = task_space_fixture.replace_command(note, "same-note-command", "Same")

    first = await task_space_fixture.module.execute(task_space_fixture.scope, command)
    second = await task_space_fixture.module.execute(task_space_fixture.scope, command)
    changed = task_space_fixture.replace_command(note, "same-note-command", "Changed")
    conflict = await task_space_fixture.module.execute(task_space_fixture.scope, changed)

    assert first.value == second.value
    assert isinstance(conflict, TaskSpaceRejected)
    assert conflict.code == "idempotency_conflict"
```

Add S3 `EntityCommand.from_sync_event()` RED vectors for `workItemNote` in this
same test module. Full create/update post-images with a valid paragraph/checklist
document and exact expected version must compile through `_note_command`; a
partial patch, invalid/oversized/depth-three document, richer Block or
WorkItem-reference item, or delete must be a domain rejection with no entity or visible
ledger effect. Prove a CAS mismatch is `version_conflict`, and compare the
accepted Sync post-image with the typed ReplaceDocument result. These tests
must fail if `TaskSpaceCompiler` is removed from the policy tuple or if
`work_item_note` falls through to S3's generic catalog compiler.

Use this exact action matrix as the base vectors before adding the malformed
document cases above:

```python
@pytest.mark.parametrize("action", ("create", "update", "delete"))
@pytest.mark.asyncio
async def test_sync_work_item_note_action_matrix_is_policy_owned(
    task_space_fixture,
    monkeypatch,
    action: str,
) -> None:
    document_json = canonical_document_json(parse_document_v1({
        "contentVersion": 1,
        "blocks": [
            {"blockId": "sync", "type": "paragraph", "text": action}
        ],
    }))
    if action == "create":
        owner = await task_space_fixture.seed_level3("sync-note-create")
        note_id = _stable_id("work_item_note", str(owner["id"]))
        client_updated_at = task_space_fixture.clock.tick()
        payload = {
            "id": note_id,
            "work_item_id": owner["id"],
            "document_json": document_json,
            "created_at": client_updated_at,
            "updated_at": client_updated_at,
            "version": 1,
        }
        expected_version = None
    else:
        note = await task_space_fixture.seed_note(f"sync-note-{action}")
        note_id = str(note["id"])
        client_updated_at = task_space_fixture.clock.tick()
        payload = (
            {}
            if action == "delete"
            else {
                **note,
                "document_json": document_json,
                "updated_at": client_updated_at,
                "version": int(note["version"]) + 1,
            }
        )
        expected_version = int(note["version"])

    event = task_space_fixture.sync_event(
        entity_type="workItemNote",
        entity_id=note_id,
        action=action,
        payload=payload,
        expected_version=expected_version,
        client_updated_at=client_updated_at,
    )
    request = task_space_fixture.entity_commands.from_sync_event(
        task_space_fixture.scope, event
    )
    operation_id = f"sync-note-{action}-matrix"
    before = task_space_fixture.overlay_snapshot()

    async def poison_generic_fallback(*args, **kwargs):
        raise AssertionError("workItemNote reached generic fallback")

    monkeypatch.setattr(
        mutation_uow, "compile_catalog_entity_command", poison_generic_fallback
    )
    if action == "delete":
        with pytest.raises(MutationRejectedError) as caught:
            await task_space_fixture.uow.execute(
                task_space_fixture.scope, request, operation_id
            )
        assert caught.value.rejection.code == "offline_formal_creation_forbidden"
        assert task_space_fixture.overlay_snapshot() == before
        assert await task_space_fixture.visible_events(operation_id=operation_id) == ()
    else:
        result = await task_space_fixture.uow.execute(
            task_space_fixture.scope, request, operation_id
        )
        assert result.value["document_json"] == document_json
        assert result.value["version"] == payload["version"]
        events = await task_space_fixture.visible_events(operation_id=operation_id)
        assert len(events) == 1
        assert events[0].entity_type == "workItemNote"
        assert events[0].payload == result.value
```

- [ ] **Step 2: Run the Note CAS tests and verify handlers are missing**

Run: `.\.venv\Scripts\python.exe -m pytest -q tests/test_work_item_note_cas.py -p no:cacheprovider`

Expected: FAIL loudly with `RuntimeError: unregistered closed Task Space command`
for ReplaceDocument/AppendBlocks/ToggleChecklistItem and `AttributeError:
compile_sync_work_item_note` for the real-entity matrix; no test may pass through
generic fallback.

- [ ] **Step 3: Implement canonical Note row loading and post-image compilation**

```python
# append to backend/app/task_space/compiler.py
import json

from app.task_space.document import (
    append_blocks,
    canonical_document_json,
    parse_document_v1,
    set_checklist_item_checked,
)


def _note_for_work_item(overlay, work_item_id: str) -> dict[str, object] | None:
    matches = [row for row in overlay.scan("work_item_note") if row["work_item_id"] == work_item_id]
    if len(matches) > 1:
        from app.mutation.types import MutationRuleViolation

        raise MutationRuleViolation(
            "invalid_note_document",
            {"reason": "duplicate_note_rows"},
            retryable=False,
        )
    return dict(matches[0]) if matches else None


def _note_command(self, context, request, transform):
    overlay = context.authority
    _require_row(overlay, "work_item", str(request.payload["work_item_id"]))
    before = _note_for_work_item(overlay, str(request.payload["work_item_id"]))
    if before is None:
        if request.expected_version is not None:
            from app.mutation.types import MutationRuleViolation

            raise MutationRuleViolation(
                "version_conflict", {"current_version": None}, retryable=False
            )
        note_id = _stable_id("work_item_note", str(request.payload["work_item_id"]))
        current = None
        next_version = 1
        operation = "insert"
    else:
        if int(before["version"]) != request.expected_version:
            from app.mutation.types import MutationRuleViolation

            raise MutationRuleViolation(
                "version_conflict",
                {"current_version": before["version"]},
                retryable=False,
            )
        note_id = str(before["id"])
        current = parse_document_v1(json.loads(str(before["document_json"])))
        next_version = int(before["version"]) + 1
        operation = "update"
    document = transform(current)
    now = self.now_iso_ms()
    after = {
        "id": note_id,
        "work_item_id": request.payload["work_item_id"],
        "document_json": canonical_document_json(document),
        "created_at": before["created_at"] if before else now,
        "updated_at": now,
        "version": next_version,
    }
    plan = DbMutationPlan(
        "work_item_notes", {"id": note_id}, operation,
        request.expected_version, before, after,
    )
    event = SyncEventPlan(
        "work_item_note", note_id, "create" if before is None else "update",
        after, next_version, now,
    )
    return context.command(
        request=request,
        db_plans=(plan,),
        sync_events=(event,),
        value=after,
    )
```

- [ ] **Step 4: Implement the three closed Note command handlers**

```python
# append to backend/app/task_space/compiler.py
async def _compile_ReplaceDocument(self, context, request):
    raw = request.payload["document"]
    document = parse_document_v1(raw)
    return _note_command(self, context, request, lambda current: document)


async def _compile_AppendBlocks(self, context, request):
    def transform(current):
        if current is None:
            from app.mutation.types import MutationRuleViolation

            raise MutationRuleViolation(
                "not_found", {"entity_type": "work_item_note"}, retryable=False
            )
        return append_blocks(current, tuple(request.payload["blocks"]))

    return _note_command(self, context, request, transform)


async def _compile_ToggleChecklistItem(self, context, request):
    def transform(current):
        if current is None:
            from app.mutation.types import MutationRuleViolation

            raise MutationRuleViolation(
                "not_found", {"entity_type": "work_item_note"}, retryable=False
            )
        return set_checklist_item_checked(
            current,
            str(request.payload["item_id"]),
            bool(request.payload["checked"]),
        )

    return _note_command(self, context, request, transform)


TaskSpaceCompiler.compile_ReplaceDocument = _compile_ReplaceDocument
TaskSpaceCompiler.compile_AppendBlocks = _compile_AppendBlocks
TaskSpaceCompiler.compile_ToggleChecklistItem = _compile_ToggleChecklistItem
```

Implement the Note real-entity branch with the complete post-image shape. It
calls `_note_command` directly with the original Sync request; no synthetic
request or recursive Module call is created.

```python
# append to backend/app/task_space/compiler.py
NOTE_SYNC_FIELDS = frozenset({
    "id", "work_item_id", "document_json", "created_at", "updated_at", "version",
})


def _invalid_sync_note(reason: str, **details) -> None:
    raise InvalidNoteDocument(json.dumps(
        {"reason": reason, **details}, sort_keys=True, separators=(",", ":")
    ))


def _sync_note_document(request, before):
    expected_fields = (
        NOTE_SYNC_FIELDS
        if request.name == "entity.create"
        else NOTE_SYNC_FIELDS - {"id"}
    )
    actual_fields = set(request.payload)
    if actual_fields != expected_fields:
        _invalid_sync_note(
            "full_post_image_required",
            missing=sorted(expected_fields - actual_fields),
            extra=sorted(actual_fields - expected_fields),
        )
    candidate = {"id": request.entity_id, **dict(request.payload)}
    version = candidate["version"]
    if type(version) is not int:
        _invalid_sync_note("version_must_be_integer")
    if candidate["updated_at"] != request.client_updated_at:
        _invalid_sync_note("updated_at_not_client_timestamp")
    if not isinstance(candidate["document_json"], str):
        _invalid_sync_note("document_json_must_be_string")
    try:
        document = parse_document_v1(json.loads(candidate["document_json"]))
    except (TypeError, json.JSONDecodeError) as exc:
        raise InvalidNoteDocument("document_json must be canonical JSON") from exc
    if canonical_document_json(document) != candidate["document_json"]:
        _invalid_sync_note("document_json_not_canonical")

    if request.name == "entity.create":
        expected_id = _stable_id("work_item_note", str(candidate["work_item_id"]))
        if request.expected_version is not None or version != 1:
            _invalid_sync_note("invalid_create_version")
        if candidate["id"] != expected_id:
            _invalid_sync_note("noncanonical_note_identity")
        if candidate["created_at"] != request.client_updated_at:
            _invalid_sync_note("created_at_not_client_timestamp")
    else:
        if before is None:
            from app.mutation.types import MutationRuleViolation

            raise MutationRuleViolation(
                "not_found", {"entity_type": "work_item_note"}, retryable=False
            )
        if str(before["id"]) != request.entity_id:
            _invalid_sync_note("note_identity_changed")
        if str(before["work_item_id"]) != str(candidate["work_item_id"]):
            _invalid_sync_note("note_owner_changed")
        if candidate["created_at"] != before["created_at"]:
            _invalid_sync_note("created_at_changed")
        if int(before["version"]) != request.expected_version:
            from app.mutation.types import MutationRuleViolation

            raise MutationRuleViolation(
                "version_conflict",
                {"current_version": before["version"]},
                retryable=False,
            )
        if version != int(before["version"]) + 1:
            _invalid_sync_note("invalid_candidate_version")
    return candidate, document


async def _compile_sync_work_item_note(self, context, request):
    if request.name == "entity.delete":
        _reject_formal_sync(request, "note_delete_requires_future_typed_command")
    if request.name not in {"entity.create", "entity.update"}:
        raise RuntimeError(f"unregistered WorkItemNote action: {request.name}")

    owner_id = str(request.payload.get("work_item_id", ""))
    before = _note_for_work_item(context.authority, owner_id) if owner_id else None
    candidate, document = _sync_note_document(request, before)
    return _note_command(self, context, request, lambda current: document)


TaskSpaceCompiler.compile_sync_work_item_note = _compile_sync_work_item_note
```

The create/update tests pass the exact catalog post-image through
`EntityCommand.from_sync_event()`, poison `compile_catalog_entity_command`, and
assert both the authority snapshot and visible ledger remain byte-identical for
partial, invalid, unresolved-reference, delete, and CAS-conflict rejections.

- [ ] **Step 5: Add the Note read Interface with unsupported-version preservation**

```python
# append to backend/app/task_space/queries.py
import json

from app.models.work_item_note import WorkItemNote


async def read_note(
    self: DefaultTaskSpaceQueryModule,
    scope: SpaceRuntimeHandle,
    work_item_id: str,
) -> TaskSpaceView | None:
    async with scope.session_factory() as session:
        row = (
            await session.execute(
                select(WorkItemNote).where(WorkItemNote.work_item_id == work_item_id)
            )
        ).scalar_one_or_none()
        if row is None:
            return None
        value = _row(row)
        raw = json.loads(str(value["document_json"]))
        value["content_version"] = raw.get("contentVersion")
        value["write_supported"] = raw.get("contentVersion") == 1
        return TaskSpaceView(value)


DefaultTaskSpaceQueryModule.read_note = read_note
```

- [ ] **Step 6: Run Note, document, UoW, and Sync ledger tests**

Run: `.\.venv\Scripts\python.exe -m pytest -q tests/test_work_item_note_document.py tests/test_work_item_note_cas.py tests/test_mutation_journal.py tests/test_entity_concurrency.py tests/test_sync_outbox_service.py -p no:cacheprovider`

Expected: PASS; all three real WorkItemNote Sync actions remain policy-owned, a
rejected CAS/partial/delete emits no visible event, retries return the durable
original result, and every accepted Note event contains the full canonical
post-image.

- [ ] **Step 7: Run Ruff and commit Note CAS support**

Run: `.\.venv\Scripts\ruff.exe check --no-cache app/task_space tests/test_work_item_note_document.py tests/test_work_item_note_cas.py`

Expected: `All checks passed!`

```powershell
git add -- app/task_space/compiler.py app/task_space/queries.py tests/test_work_item_note_cas.py
git commit -m "feat(task-space): add work item note CAS commands"
```

### Task 5: Lock The First-Version Note Boundary And Dual-Version Conflict Contract

**Files:**
- Modify: `backend/app/task_space/compiler.py`
- Create: `backend/tests/test_work_item_note_boundary.py`
- Modify: `backend/tests/test_openapi_contract.py`

**Interfaces:**
- Consumes: Task 1 paragraph/checklist document parser, Task 4 Note CAS/read path, TS0 closed schemas/routes, and S3 durable rejection receipts.
- Produces: a version-conflict detail containing the authoritative version and canonical document, plus executable absence gates for richer Block kinds, WorkItem-reference items, promotion routes/commands, and promotion trace columns.

- [ ] **Step 1: Write failing dual-version conflict and no-promotion boundary tests**

```python
from __future__ import annotations

import json

import pytest

@pytest.mark.asyncio
async def test_conflict_returns_the_remote_document_without_merging_local(
    task_space_fixture,
) -> None:
    note = await task_space_fixture.seed_note("dual-version")
    local_document = {"contentVersion": 1, "blocks": [
        {"blockId": "p", "type": "paragraph", "text": "Local"},
    ]}
    winner = await task_space_fixture.replace_document(
        "remote-winner", note["work_item_id"], note["version"],
        {"contentVersion": 1, "blocks": [
            {"blockId": "p", "type": "paragraph", "text": "Remote"},
        ]},
    )
    conflict = await task_space_fixture.replace_document(
        "local-loser", note["work_item_id"], note["version"], local_document,
    )

    assert conflict.code == "version_conflict"
    assert conflict.details == {
        "current_version": winner.value["version"],
        "current_document": json.loads(winner.value["document_json"]),
    }
    assert local_document["blocks"][0]["text"] == "Local"
    assert await task_space_fixture.visible_events(operation_id="local-loser") == ()
```

- [ ] **Step 2: Write failing contract-surface absence tests**

```python
from app.main import app
from app.models.work_item import WorkItem


def test_v1_openapi_and_orm_have_no_richer_note_or_promotion_surface() -> None:
    schema = app.openapi()
    serialized = json.dumps(schema, sort_keys=True)
    assert not any(
        path.endswith("/note/promote-list-item") for path in schema["paths"]
    )
    for forbidden in (
        '"heading"', '"ordered_list"', '"unordered_list"',
        '"work_item_ref"', '"PromoteListItem"',
    ):
        assert forbidden not in serialized
    assert {
        "source_note_id", "source_block_id", "source_item_id",
    }.isdisjoint(WorkItem.__table__.columns.keys())
```

- [ ] **Step 3: Run the boundary tests and verify conflict details are incomplete**

Run: `.\.venv\Scripts\python.exe -m pytest -q tests/test_work_item_note_boundary.py -p no:cacheprovider`

Expected: FAIL because `version_conflict.details` does not yet contain the
canonical `current_document`; no promotion-surface assertion may fail.

- [ ] **Step 4: Return the canonical authoritative document on Note CAS conflict**

```python
# in backend/app/task_space/compiler.py, inside _note_command CAS rejection
raise MutationRuleViolation(
    "version_conflict",
    {
        "current_version": before["version"],
        "current_document": json.loads(str(before["document_json"])),
    },
    retryable=False,
)
```

- [ ] **Step 5: Add a fail-closed first-version surface scan**

```powershell
$forbidden = @(
  'PromoteListItem', 'promote-list-item', 'work_item_ref',
  'source_note_id', 'source_block_id', 'source_item_id',
  'ordered_list', 'unordered_list', 'HeadingBlock'
)
$paths = @('app/task_space', 'app/schemas/work_item_note.py', 'app/models/work_item.py', 'app/routes/v1/work_item_notes.py')
foreach ($marker in $forbidden) {
  $hits = @(& rg -n --fixed-strings $marker $paths 2>$null)
  if ($LASTEXITCODE -gt 1) { throw "rg failed while checking $marker" }
  if ($hits) { throw "forbidden WorkItemNote v1 surface: $marker`n$($hits -join "`n")" }
}
```

- [ ] **Step 6: Run Note boundary, CAS, recovery, and OpenAPI tests**

Run: `.\.venv\Scripts\python.exe -m pytest -q tests/test_work_item_note_boundary.py tests/test_work_item_note_document.py tests/test_work_item_note_cas.py tests/test_mutation_recovery.py tests/test_mutation_journal.py tests/test_sync_outbox_service.py tests/test_openapi_contract.py -p no:cacheprovider`

Expected: PASS; the caller retains its local document, the conflict response
contains the canonical remote document/version, no automatic merge or rejected
event occurs, and no richer/promotion surface exists.

- [ ] **Step 7: Run Ruff and commit the closed v1 boundary**

Run: `.\.venv\Scripts\ruff.exe check --no-cache app/task_space/document.py app/task_space/compiler.py tests/test_work_item_note_boundary.py tests/test_openapi_contract.py`

Expected: `All checks passed!`

```powershell
git add -- app/task_space/compiler.py tests/test_work_item_note_boundary.py tests/test_openapi_contract.py
git commit -m "test(task-space): lock work item note v1 boundary"
```

### Task 6: Install Task Space Providers And Mount The TS0 Contract Routers

**Files:**
- Create: `backend/tests/test_task_space_routes.py`
- Modify: `backend/app/deps.py`
- Modify: `backend/app/routes/v1/contract_dependencies.py`
- Modify: `backend/app/routes/v1/__init__.py`
- Modify: `backend/tests/test_task_space_contract_routes.py`
- Modify: `backend/tests/test_openapi_contract.py`
- Modify: `backend/tests/test_response_contract.py`

**Interfaces:**
- Consumes: Task 2-5 concrete implementations of TS0 `TaskSpaceCommandModule`/`TaskSpaceQueryModule`, S3 `get_mutation_unit_of_work`, and TS0's already-tested unmounted `projects.py`, `work_items.py`, and `work_item_notes.py` routers.
- Produces: real implementations for TS0 `get_task_space_command_module`/`get_task_space_query_module`; mounts the unchanged canonical `POST /api/v1/work-items -> commands.execute(CreateWorkItem)` mapping and `GET /api/v1/work-items?projectId=...` with flat `(parent_id, child_rank, id)` order; introduces no new route shape.

- [ ] **Step 1: Write failing REST identity, typed Note-route, CAS, and legacy-absence tests**

```python
from __future__ import annotations

import pytest

from app.mutation.types import canonical_payload_hash


@pytest.mark.asyncio
async def test_project_create_is_idempotent_and_returns_operation_id(
    space_client, space_id: str
) -> None:
    headers = {"Idempotency-Key": "rest-project-one"}
    wire_payload = {"name": "Roadmap", "key": " rm ", "description": None}
    business_payload = {**wire_payload, "key": "RM"}
    body = {
        "commandId": "rest-project-one",
        "spaceId": space_id,
        "payloadHash": canonical_payload_hash(business_payload),
        **wire_payload,
    }

    first = await space_client.post("/api/v1/projects", json=body, headers=headers)
    second = await space_client.post("/api/v1/projects", json=body, headers=headers)

    assert first.status_code == second.status_code == 201
    assert first.json() == second.json()
    assert first.json()["key"] == "RM"
    assert first.json()["key"] == "RM"
    assert first.headers["X-Operation-ID"] == "rest-project-one"


@pytest.mark.asyncio
async def test_typed_note_routes_require_their_body_and_expected_version(
    space_client, seeded_note
) -> None:
    missing = await space_client.put(
        f"/api/v1/work-items/{seeded_note['work_item_id']}/note",
        json={
            "commandId": "bad-note-command",
            "spaceId": seeded_note["space_id"],
            "expectedVersion": seeded_note["version"],
            "payloadHash": canonical_payload_hash({}),
        },
        headers={"Idempotency-Key": "bad-note-command"},
    )
    toggle_payload = {"block_id": "check-block", "item_id": "check-1", "checked": True}
    conflict = await space_client.post(
        f"/api/v1/work-items/{seeded_note['work_item_id']}/note/toggle-checklist-item",
        json={
            "commandId": "stale-note-command",
            "spaceId": seeded_note["space_id"],
            "expectedVersion": seeded_note["version"] - 1,
            "payloadHash": canonical_payload_hash(toggle_payload),
            "blockId": "check-block",
            "itemId": "check-1",
            "checked": True,
        },
        headers={"Idempotency-Key": "stale-note-command"},
    )

    assert missing.status_code == 422
    assert conflict.status_code == 409
    assert conflict.json()["code"] == "version_conflict"


@pytest.mark.asyncio
async def test_openapi_contains_task_space_and_excludes_legacy_tasks(space_client) -> None:
    schema = (await space_client.get("/openapi.json")).json()
    http_methods = {"get", "put", "post", "patch", "delete"}
    expected_note_methods = {
        "/api/v1/work-items/{work_item_id}/note": {"get", "put"},
        "/api/v1/work-items/{work_item_id}/note/append-blocks": {"post"},
        "/api/v1/work-items/{work_item_id}/note/toggle-checklist-item": {"post"},
    }
    actual_note_methods = {
        path: set(path_item) & http_methods
        for path, path_item in schema["paths"].items()
        if path.startswith("/api/v1/work-items/{work_item_id}/note")
    }
    generic_note_command_path = "/note/" + "commands"

    assert "/api/v1/projects" in schema["paths"]
    assert "post" in schema["paths"]["/api/v1/work-items"]
    assert actual_note_methods == expected_note_methods
    assert all(generic_note_command_path not in path for path in schema["paths"])
    assert "/api/v1/work-items/tree" not in schema["paths"]
    assert "/api/v1/tasks" not in schema["paths"]
    toggle_operation = schema["paths"][
        "/api/v1/work-items/{work_item_id}/note/toggle-checklist-item"
    ]["post"]
    request_ref = toggle_operation["requestBody"]["content"]["application/json"]["schema"]["$ref"]
    request_schema = schema["components"]["schemas"][request_ref.rsplit("/", 1)[-1]]
    assert {
        "commandId", "spaceId", "expectedVersion", "payloadHash",
        "blockId", "itemId", "checked",
    } <= set(request_schema["properties"])
    assert "command_id" not in request_schema["properties"]


@pytest.mark.asyncio
async def test_work_item_list_uses_the_canonical_project_filter_and_stable_flat_order(
    space_client, seeded_work_item_tree
) -> None:
    response = await space_client.get(
        "/api/v1/work-items",
        params={"projectId": seeded_work_item_tree.project_id},
    )

    assert response.status_code == 200
    assert [item["id"] for item in response.json()["items"]] == (
        seeded_work_item_tree.ids_in_parent_child_rank_id_order
    )
    assert not any(
        path.endswith("/work-items/tree")
        for path in (await space_client.get("/openapi.json")).json()["paths"]
    )
```

- [ ] **Step 2: Run route/OpenAPI tests and verify route groups are missing**

Run: `.\.venv\Scripts\python.exe -m pytest -q tests/test_task_space_routes.py tests/test_openapi_contract.py tests/test_response_contract.py -p no:cacheprovider`

Expected: FAIL with 404 responses for Task Space routes and missing OpenAPI paths.

- [ ] **Step 3: Register the policy in the existing S3 UoW composition root and install TS0 providers**

```python
# in backend/app/deps.py, replace the S3-default body of this provider; generic
# catalog fallback remains built into MutationCompiler and is not a policy.
from fastapi import Depends

from app.mutation.unit_of_work import MutationCompiler
from app.registry.catalog import CompiledEntityCatalog
from app.services.time import utc_now_iso_ms
from app.task_space.compiler import TaskSpaceCompiler


def get_mutation_compiler(
    catalog: CompiledEntityCatalog = Depends(get_compiled_entity_catalog),
) -> MutationCompiler:
    return MutationCompiler(
        catalog,
        policies=(TaskSpaceCompiler(utc_now_iso_ms),),
    )
```

S3's existing `get_mutation_unit_of_work` and restart-recovery providers both
depend on this one `get_mutation_compiler`; do not instantiate a second compiler
inside the Task Space provider. The empty S3 policy tuple is replaced by exactly
the Task Space policy, while generic catalog entities continue through the
compiler's built-in fallback.

```python
# replace only the two Task Space sentinels in
# backend/app/routes/v1/contract_dependencies.py
from fastapi import Depends

from app.deps import get_mutation_unit_of_work
from app.mutation.unit_of_work import MutationUnitOfWork
from app.task_space.contracts import TaskSpaceCommandModule, TaskSpaceQueryModule
from app.task_space.module import DefaultTaskSpaceCommandModule
from app.task_space.queries import DefaultTaskSpaceQueryModule


def get_task_space_command_module(
    uow: MutationUnitOfWork = Depends(get_mutation_unit_of_work),
) -> TaskSpaceCommandModule:
    return DefaultTaskSpaceCommandModule(uow)


def get_task_space_query_module() -> TaskSpaceQueryModule:
    return DefaultTaskSpaceQueryModule()
```

Keep the TS0 `get_focus_session_module` and `get_active_session_coordinator`
sentinels unchanged for TS2. Do not introduce a generic contract provider.

- [ ] **Step 4: Verify the existing TS0 routers remain byte-stable and delegate once**

Do not rewrite `projects.py`, `work_items.py`, or `work_item_notes.py`. Extend
`tests/test_task_space_contract_routes.py` so the real providers from Step 3 are
overridden with spies and every canonical path still performs exactly one
Protocol call. Assert `/projects/definitions` is declared before
`/projects/{project_id}`, every WorkItem action is declared before
`/work-items/{work_item_id}`, and no route imports SQLAlchemy, constructs a UoW,
or calls `record_sync_event`.

Keep the TS0 fakes' existing semantic call records and also retain the raw
command/query objects as `raw_commands`/`raw_queries`. Add these exact Adapter
assertions to the existing fake-provider route test:

```python
from app.mutation.types import canonical_payload_hash
from app.task_space.contracts import CreateWorkItem


business_payload = {
    "title": "Adapter work item",
    "description": None,
    "parent_id": None,
    "type_definition_id": None,
    "status_definition_id": None,
    "priority": None,
}
created = client.post(
    "/api/v1/work-items",
    json={
        "commandId": "adapter-create-work-item",
        "spaceId": "space-a",
        "projectId": "project-a",
        "payloadHash": canonical_payload_hash(business_payload),
        "title": business_payload["title"],
        "description": None,
        "parentId": None,
        "typeDefinitionId": None,
        "statusDefinitionId": None,
        "priority": None,
    },
    headers={"Idempotency-Key": "adapter-create-work-item"},
)
listed = client.get(
    "/api/v1/work-items", params={"projectId": "project-a"}
)

assert created.status_code == 201
assert listed.status_code == 200
assert isinstance(fake_task_commands.raw_commands[-1], CreateWorkItem)
assert fake_task_commands.raw_commands[-1].project_id == "project-a"
assert fake_task_query.raw_queries[-1].filters == {"project_id": "project-a"}
assert "projectId" not in fake_task_query.raw_queries[-1].filters
```

- [ ] **Step 5: Run provider-backed integration tests against the TS0 routers**

Run the Step 1 tests without dependency overrides. Assert accepted and rejected
`TaskSpaceOutcome` values are mapped by the existing TS0 Adapter helper, the
body/header command identities agree, `projectId` is passed through
the REST Adapter as internal `TaskSpacePageQuery.filters["project_id"]`, and the
WorkItem list remains a flat page rather
than a second tree endpoint.

- [ ] **Step 6: Mount only the final Task Space routes**

```python
# modify backend/app/routes/v1/__init__.py inside build_v1_router()
from app.routes.v1.projects import router as projects_router
from app.routes.v1.work_item_notes import router as work_item_notes_router
from app.routes.v1.work_items import router as work_items_router

router.include_router(projects_router, prefix="/projects", tags=["projects"])
router.include_router(work_items_router, prefix="/work-items", tags=["work-items"])
router.include_router(work_item_notes_router, prefix="/work-items", tags=["work-item-notes"])
```

- [ ] **Step 7: Run route, OpenAPI, response, and direct-commit gates**

Run: `.\.venv\Scripts\python.exe -m pytest -q tests/test_task_space_routes.py tests/test_openapi_contract.py tests/test_response_contract.py tests/test_error_contract_v2.py -p no:cacheprovider`

Expected: PASS with stable operation IDs, pre-UoW payload-hash validation, 409 CAS errors, four typed Note command routes, exact camelCase wire schemas, and no legacy `/api/v1/tasks` path.

Run: `rg -n "\.commit\(|record_sync_event\(" app/routes/v1/projects.py app/routes/v1/work_items.py app/routes/v1/work_item_notes.py`

Expected: exit code `1` and no matches.

Run this composition-structure gate from `backend/`:

```powershell
$constructors = @(& rg -n "MutationCompiler\(" app/deps.py app/task_space app/routes/v1/contract_dependencies.py 2>$null)
if ($LASTEXITCODE -gt 1) { throw "rg failed with exit $LASTEXITCODE" }
if ($constructors.Count -ne 1 -or $constructors[0] -notmatch '^app/deps\.py:') {
    $constructors
    throw "Task Space introduced a shadow MutationCompiler"
}
$deps = Get-Content -Raw app/deps.py
if ($deps -notmatch 'policies=\(TaskSpaceCompiler\(utc_now_iso_ms\),\)') {
    throw "get_mutation_compiler does not install exactly the TS1 policy tuple"
}
```

Expected: exit code `0`; the only constructor is S3's existing
`get_mutation_compiler`, whose policy tuple is exactly
`(TaskSpaceCompiler(utc_now_iso_ms),)`. Generic entity handling remains the
built-in catalog fallback, not a second or shadow compiler.

- [ ] **Step 8: Run Ruff and commit the REST Adapter surface**

Run: `.\.venv\Scripts\ruff.exe check --no-cache app/deps.py app/routes/v1/contract_dependencies.py app/routes/v1/projects.py app/routes/v1/work_items.py app/routes/v1/work_item_notes.py app/routes/v1/__init__.py tests/test_task_space_contract_routes.py tests/test_task_space_routes.py tests/test_openapi_contract.py tests/test_response_contract.py`

Expected: `All checks passed!`

```powershell
git add -- app/deps.py app/routes/v1/contract_dependencies.py app/routes/v1/__init__.py tests/test_task_space_contract_routes.py tests/test_task_space_routes.py tests/test_openapi_contract.py tests/test_response_contract.py
git commit -m "feat(api): expose task space command adapters"
```

### Task 7: Close Registry, OpenAPI Generation, Parity, And TS1 Gate

**Files:**
- Modify: `backend/tests/test_registry.py`
- Modify: `backend/tests/test_services_meta.py`
- Modify: `backend/tests/test_parity_registry_orm.py`
- Modify: `backend/tests/test_parity_registry_schemas.py`
- Modify: `backend/tests/test_parity_alembic_metadata.py`
- Modify: `backend/tests/test_error_contract_v2.py`
- Modify: `frontend/src/types/api-generated.ts`

**Interfaces:**
- Consumes: TS0 final catalog/Space head, Tasks 1-6 backend module and routes, existing OpenAPI generator.
- Produces: exact final Task Space catalog assertions, generated TypeScript contracts, and a single TS1 admission gate for TS2/TS3.

- [ ] **Step 1: Reassert the TS0 final catalog without redefining it**

```python
# backend/tests/test_registry.py
EXPECTED_TASK_SPACE_ENTITIES = {
    "project",
    "status_definition",
    "type_definition",
    "label",
    "work_item_label",
    "work_item",
    "work_item_note",
}


def test_registry_contains_final_task_space_and_no_legacy_task() -> None:
    names = {spec.name for spec in REGISTRY.list()}
    sync_keys = {spec.effective_sync_entity_type for spec in REGISTRY.list_sync_enabled()}

    assert EXPECTED_TASK_SPACE_ENTITIES <= names
    assert len(REGISTRY.list()) == 31
    assert "task" not in names
    assert "task" not in sync_keys
    assert {
        "project", "statusDefinition", "typeDefinition", "label",
        "workItemLabel", "workItem", "workItemNote",
    } <= sync_keys
```

- [ ] **Step 2: Run the unchanged TS0 catalog and parity gates**

Run: `.\.venv\Scripts\python.exe -m pytest -q tests/test_registry.py tests/test_services_meta.py tests/test_parity_registry_orm.py tests/test_parity_registry_schemas.py tests/test_parity_alembic_metadata.py -p no:cacheprovider`

Expected: PASS; TS0 already removed legacy fixed counts and froze the 31-entry catalog.

- [ ] **Step 3: Add an exact TS1 rejection-producer gate**

```python
# backend/tests/test_error_contract_v2.py
from pathlib import Path

from tests.ast_helpers import literal_exception_codes


TS1_COMPILER_REJECTION_CODES = {
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
}


def test_ts1_mutation_rejection_producers_are_exact_and_registered() -> None:
    produced = literal_exception_codes(
        Path("app/task_space/compiler.py"), "MutationRuleViolation"
    )
    assert produced == TS1_COMPILER_REJECTION_CODES
    assert produced <= set(MUTATION_REJECTION_SPECS)
    assert "unknown_task_space_command" not in produced


def test_ts1_module_rejections_are_registered() -> None:
    # Behavior is exercised by the pre-UoW mismatch and changed-payload replay
    # tests; this assertion closes their shared rendered error contracts.
    assert {"invalid_payload_hash", "idempotency_conflict"} <= set(
        MUTATION_REJECTION_SPECS
    )
```

Reuse S3's `tests/ast_helpers.py::literal_exception_codes`; do not create a
second parser. `invalid_payload_hash`, `invalid_project_key`,
`project_key_conflict`, and `active_child_conflict` must be present in the
shared approved map. `not_found` and `idempotency_conflict` reuse existing
generic entries. `invalid_payload_hash` is raised by S3's canonical hash helper
and mapped by `DefaultTaskSpaceCommandModule` before UoW entry, so its producer
is covered by the behavioral no-call test rather than misclassified as a
`MutationRuleViolation` in the Task Space compiler.

- [ ] **Step 4: Run parity tests and verify the final catalog is exact**

Run the immutable TS0 Space-head check first:

```powershell
$headLines = @(.\.venv\Scripts\python.exe -m alembic -n alembic:space heads)
if ($LASTEXITCODE -ne 0) { throw "Space head query failed" }
$headIds = @(
    $headLines |
        Where-Object { $_ -match '^space_' } |
        ForEach-Object { ($_ -split '\s+')[0] }
)
if ($headIds.Count -ne 1 -or $headIds[0] -ne 'space_010_task_space_focus_session') {
    throw "TS1 requires sole Space head space_010_task_space_focus_session; got $($headIds -join ',')"
}
```

Expected: exit code `0` and exactly one Space head,
`space_010_task_space_focus_session`.

Run: `.\.venv\Scripts\python.exe -m pytest -q tests/test_registry.py tests/test_services_meta.py tests/test_parity_registry_orm.py tests/test_parity_registry_schemas.py tests/test_parity_alembic_metadata.py tests/test_error_contract_v2.py -p no:cacheprovider`

Expected: PASS; every final entity resolves to its TS0 ORM/schema, the Space Alembic head matches metadata, no legacy Task remains, and the TS1 producer set equals the registered stable codes.

- [ ] **Step 5: Regenerate TypeScript OpenAPI types from the running TS1 backend**

```powershell
$server = Start-Process -FilePath ".\.venv\Scripts\python.exe" -ArgumentList "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", "8000" -PassThru -WindowStyle Hidden
try {
    $ready = $false
    for ($attempt = 0; $attempt -lt 40; $attempt++) {
        try {
            $response = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:8000/openapi.json" -TimeoutSec 1
            if ($response.StatusCode -eq 200) { $ready = $true; break }
        } catch {}
        Start-Sleep -Milliseconds 250
    }
    if (-not $ready) { throw "TS1 OpenAPI server did not become ready" }
    Push-Location ..\frontend
    try { npm run generate:api } finally { Pop-Location }
} finally {
    if ($server -and -not $server.HasExited) { Stop-Process -Id $server.Id -Force }
}
```

Expected: `frontend/src/types/api-generated.ts` contains `ProjectResponse`,
`WorkItemResponse`, `WorkItemNoteResponse`, exactly the paragraph/checklist Block
variants, camelCase `contentVersion`/`workItemId` fields, and all three typed
WorkItemNote command paths; it contains neither a promotion/generic Note command
endpoint nor an `/api/v1/tasks` operation.

- [ ] **Step 6: Run the complete TS1 focused backend gate**

Run: `.\.venv\Scripts\python.exe -m pytest -q tests/test_work_item_note_document.py tests/test_work_item_note_boundary.py tests/test_task_space_project.py tests/test_task_space_tree.py tests/test_work_item_note_cas.py tests/test_task_space_routes.py tests/test_mutation_journal.py tests/test_mutation_recovery.py tests/test_entity_invariants.py tests/test_entity_concurrency.py tests/test_sync_outbox_service.py tests/test_registry.py tests/test_services_meta.py tests/test_parity_registry_orm.py tests/test_parity_registry_schemas.py tests/test_parity_alembic_metadata.py tests/test_openapi_contract.py tests/test_response_contract.py tests/test_error_contract_v2.py -p no:cacheprovider`

Expected: PASS with no unexpected xfail/xpass; Note conflicts publish no event,
return the canonical remote version/document, and final catalog/OpenAPI parity
is exact with no promotion surface.

- [ ] **Step 7: Run static checks and the full backend regression suite**

Run: `.\.venv\Scripts\ruff.exe check --no-cache app tests`

Expected: `All checks passed!`

Run: `.\.venv\Scripts\python.exe -m pytest -q -p no:cacheprovider`

Expected: PASS with no unexpected xfail/xpass and no legacy Task route/registry assertions.

Run the definition-model ownership scan:

```powershell
$shadowDefinitionImports = @(& rg -n "app\.models\.(status_definition|type_definition|label|work_item_label)" app/task_space tests/test_task_space_project.py tests/test_task_space_tree.py 2>$null)
if ($LASTEXITCODE -gt 1) { throw "rg failed with exit $LASTEXITCODE" }
if ($shadowDefinitionImports) {
    $shadowDefinitionImports
    throw "TS1 imported a shadow definition-model module"
}
$canonicalDefinitionImports = @(& rg -n "app\.models\.work_item_definition" app/task_space tests/test_task_space_project.py 2>$null)
if ($LASTEXITCODE -ne 0 -or -not $canonicalDefinitionImports) {
    throw "TS1 does not consume TS0 work_item_definition.py"
}
```

Expected: exit code `0`; definitions are imported only from
`app.models.work_item_definition`.

- [ ] **Step 8: Verify TS1 did not touch forbidden frontend or S3/S4 implementation files**

```powershell
$forbidden = @(
    "frontend/src/services/database.ts",
    "frontend/src/stores/task-store.ts",
    "frontend/src/lib/sync",
    "backend/app/mutation",
    "backend/app/commands/entity.py",
    "backend/app/services/sync.py",
    "backend/app/mcp"
)
$changed = @(git diff --name-only HEAD~7..HEAD)
$violations = foreach ($path in $changed) {
    foreach ($prefix in $forbidden) {
        if ($path -eq $prefix -or $path.StartsWith("$prefix/")) { $path }
    }
}
if ($violations) { throw "TS1 scope violation: $($violations -join ', ')" }
```

Expected: no output and exit code `0`; `frontend/src/types/api-generated.ts` is the only frontend file changed by TS1.

- [ ] **Step 9: Commit the final parity and generated-contract gate**

```powershell
git add -- tests/test_registry.py tests/test_services_meta.py tests/test_parity_registry_orm.py tests/test_parity_registry_schemas.py tests/test_parity_alembic_metadata.py tests/test_error_contract_v2.py ..\frontend\src\types\api-generated.ts
git commit -m "test(task-space): close ts1 parity gate"
```

Immediately verify the committed gate rather than trusting the pre-commit
working-tree run:

```powershell
$committed = @(git diff-tree --no-commit-id --name-only -r HEAD)
if ($committed -notcontains 'backend/tests/test_error_contract_v2.py') {
    throw "TS1 final commit omitted test_error_contract_v2.py"
}
git diff --exit-code HEAD -- tests/test_error_contract_v2.py
if ($LASTEXITCODE -ne 0) {
    throw "test_error_contract_v2.py is dirty after the TS1 final commit"
}
.\.venv\Scripts\python.exe -m pytest -q tests/test_error_contract_v2.py tests/test_registry.py -p no:cacheprovider
if ($LASTEXITCODE -ne 0) { throw "post-commit TS1 rejection gate failed" }
```

Expected: exit code `0`; the final commit contains the exact producer test, the
file has no staged/unstaged delta, and the focused post-commit gate passes.

## TS1 Exit Gate

TS1 is complete only when one commit satisfies all of the following:

- Project keys normalize and validate exactly as `[A-Z][A-Z0-9]{1,9}`.
- Every caller `payloadHash` is verified with S3's canonical business-payload helper before UoW entry; mismatch is `invalid_payload_hash` with zero journal, row, or ledger effects.
- Business-payload hashing uses S3's RFC 8785 helpers, excludes every locked envelope/target/CAS field, and the separate S3 request hash still covers those excluded identity fields.
- Every Project begins with `next_work_item_number = 1`; concurrent or retried WorkItem creation never duplicates or skips a committed display key because allocation and creation are one UoW.
- Project and WorkItem IDs are <=36-character stable IDs derived from command identity. Distinct command IDs with the same CreateWorkItem business payload produce distinct WorkItem IDs and monotonically distinct display keys; a reused command ID with changed full intent remains `idempotency_conflict`.
- WorkItem create/move enforces same Project, no cycle, and at most three levels against the under-lease authority overlay.
- Status categories drive `completed_at`/`cancelled_at`; completing a level-2 parent with active level-3 children is rejected without writes.
- WorkItemNote v1 validates exactly paragraph/checklist Blocks, stable unique IDs, array ordering, nested Checklist `children[]` only, no `parentItemId`, at most two levels, canonical JSON, and exact `128 KiB`/`256 Blocks`/`2048 items` limits; richer Blocks and WorkItem-reference items are rejected.
- Replace, append, and toggle use whole-document expected-version CAS and publish one full canonical `workItemNote` post-image only after finalization.
- A Note CAS conflict preserves the authoritative document, returns its current version, leaves the rejected local document with the caller for explicit reconciliation, and emits no visible event.
- No promotion command, route, schema variant, WorkItem-reference Note item, or source-trace WorkItem column exists in v1.
- Every Sync create/update event is the complete post-image; the WorkItem tests assert exact equality with every TS0 field.
- REST routes contain no commit, direct ledger call, tree rule, document parser, or CAS implementation.
- `POST /api/v1/work-items` reaches TS0 `CreateWorkItem`, and wire `projectId` reaches only internal `filters["project_id"]`.
- OpenAPI and generated TypeScript expose camelCase wire fields and only the TS0 Note read plus three typed Note write methods; promotion, the generic `/note/` + `commands` endpoint, `/work-items/tree`, `/api/v1/tasks`, and the `task` Sync key are absent.
- The sole Space head remains `space_010_task_space_focus_session`; definitions come only from `work_item_definition.py`; `get_mutation_compiler` installs exactly `policies=(TaskSpaceCompiler(utc_now_iso_ms),)` with no shadow compiler.
- TS1 rejection producers are enumerated only through S3's `tests/ast_helpers.py::literal_exception_codes`; an unknown Task Space command is an unreachable programming error, not a new domain rejection code.
- The complete TS1 focused gate, Ruff, and full backend suite pass at the same commit.
- No S3/S4 implementation file, frontend Dexie file, repository, store, or UI file changed in TS1.
