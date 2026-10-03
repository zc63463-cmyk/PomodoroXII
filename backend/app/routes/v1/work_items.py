"""Thin contract router for WorkItem CRUD and lifecycle actions.

Static action routes (move, transition) are declared before the
plain ``/{work_item_id}`` mutation route so they are never captured
as a path parameter.
"""
from __future__ import annotations

import logging
from collections.abc import Mapping
from dataclasses import replace
from typing import Any

from fastapi import APIRouter, Depends, Header, Query
from sqlalchemy import select

from app.deps import get_space_runtime_handle
from app.errors import AppError
from app.models.work_item import WorkItem
from app.mutation.types import BatchMutationResult
from app.routes.v1.contract_dependencies import (
    get_task_space_command_module,
    get_task_space_query_module,
    map_task_space_outcome,
    require_idempotency_key,
    require_space_identity,
)
from app.schemas.task_space import (
    AddWorkItemLabelsRequest,
    CreateWorkItemRequest,
    MoveWorkItemRequest,
    RemoveWorkItemLabelsRequest,
    ReorderWorkItemRequest,
    RestoreWorkItemRequest,
    TaskSpaceAcceptedResponse,
    TransitionWorkItemRequest,
    TrashWorkItemRequest,
    UpdateWorkItemRequest,
    WorkItemPageResponse,
    WorkItemResponse,
)
from app.task_space.contracts import (
    CreateWorkItem,
    MutateWorkItem,
    TaskSpaceAccepted,
    TaskSpaceOutcome,
    TaskSpacePageQuery,
    TaskSpaceRejected,
)
from app.task_space.legacy_receipts import (
    LegacyLabelReceiptResolver,
    LegacyReceiptOutcome,
    legacy_payload_rejection_reason,
)

router = APIRouter()
logger = logging.getLogger(__name__)


def _space_id(scope) -> str:
    value = getattr(getattr(scope, "scope", None), "space_id", None)
    if not isinstance(value, str) or not value:
        raise RuntimeError("authorized Space runtime handle is required")
    return value


async def _work_item_depths(scope, items: tuple[Mapping[str, object], ...]) -> dict[str, int]:
    """Resolve read-only tree depth from authoritative ORM parent rows."""
    depths = {
        str(value["id"]): int(value["depth"])
        for value in items
        if "depth" in value
    }
    missing = [value for value in items if str(value["id"]) not in depths]
    if not missing:
        return depths
    session_factory = getattr(scope, "session_factory", None)
    if not callable(session_factory):
        raise RuntimeError("authoritative WorkItem rows are required for depth")
    async with session_factory() as session:
        rows = tuple((await session.execute(select(WorkItem))).scalars())
    by_id = {str(row.id): row for row in rows}
    for value in missing:
        current = value
        depth = 1
        visited = {str(value["id"])}
        while (
            current["parent_id"]
            if isinstance(current, Mapping)
            else getattr(current, "parent_id", None)
        ) is not None:
            parent_value = (
                current["parent_id"]
                if isinstance(current, Mapping)
                else current.parent_id
            )
            parent_id = str(parent_value)
            if parent_id in visited or parent_id not in by_id:
                raise RuntimeError("invalid_work_item_tree")
            parent = by_id[parent_id]
            current_project = (
                current["project_id"]
                if isinstance(current, Mapping)
                else getattr(current, "project_id", None)
            )
            if str(parent.project_id) != str(current_project):
                raise RuntimeError("invalid_work_item_tree")
            visited.add(parent_id)
            depth += 1
            current = parent
        if depth not in (1, 2, 3):
            raise RuntimeError("invalid_work_item_tree")
        depths[str(value["id"])] = depth
    return depths


def _work_item_response(value, space_id: str, depth: int) -> WorkItemResponse:
    """Map a complete snake_case query row to the wire response."""
    return WorkItemResponse(
        id=str(value["id"]),
        space_id=space_id,
        display_key=str(value["display_key"]),
        project_id=str(value["project_id"]),
        title=str(value["title"]),
        description=value["description"],
        type_definition_id=str(value["type_definition_id"]),
        status_definition_id=str(value["status_definition_id"]),
        # ★ 2026-09-12（ADR-0003）：等待前态走读投影（原始值直出，不做二次加工）。
        #   .get 容忍手工构造的查询行；本函数是读路径与 accepted 响应共用的唯一
        #   映射器（_map_work_item_outcome 也调它），一处改动两端覆盖。
        pre_waiting_status_definition_id=value.get("pre_waiting_status_definition_id"),
        priority=value["priority"],
        parent_id=value["parent_id"],
        child_rank=int(value["child_rank"]),
        depth=depth,
        completion_window_start=value["completion_window_start"],
        completion_window_end=value["completion_window_end"],
        review_point=value["review_point"],
        hard_deadline=value["hard_deadline"],
        # ★ 2026-10-03（space_018）：截止日期走读投影（原始值直出）。
        #   .get 容忍手工构造的查询行（迁移前的缓存行返回 null，不阻断响应）。
        due_at=value.get("due_at"),
        effort_estimate_lower_seconds=value["effort_estimate_lower_seconds"],
        effort_estimate_upper_seconds=value["effort_estimate_upper_seconds"],
        effort_actual_seconds=int(value["effort_actual_seconds"]),
        confidence=value["confidence"],
        completed_at=value["completed_at"],
        cancelled_at=value["cancelled_at"],
        archived_at=value["archived_at"],
        marked_as_attention=bool(value["marked_as_attention"]),
        label_ids=sorted(str(item) for item in value.get("label_ids", [])),
        version=int(value["version"]),
        created_at=str(value["created_at"]),
        updated_at=str(value["updated_at"]),
    )


async def _map_work_item_outcome(
    outcome: TaskSpaceOutcome,
    scope,
    query_module,
) -> TaskSpaceAcceptedResponse:
    """Return a complete authoritative WorkItem accepted post-image.

    The compiler's value is the domain post-image and intentionally contains
    no derived ``depth`` column.  REST accepted responses must nevertheless
    satisfy the same complete WorkItem contract as reads, so enrich only the
    response value from the committed query projection.
    """
    if not isinstance(outcome, TaskSpaceAccepted) or outcome.entity_type != "work_item":
        return map_task_space_outcome(outcome)
    view = await query_module.get_work_item(scope, outcome.entity_id)
    depths = await _work_item_depths(scope, (view.value,))
    value = _work_item_response(
        view.value,
        _space_id(scope),
        depths[str(outcome.entity_id)],
    ).model_dump(by_alias=True)
    return map_task_space_outcome(replace(outcome, value=value))


# --------------------------------------------------------------------------- #
# Collection routes
# --------------------------------------------------------------------------- #


@router.get("", response_model=WorkItemPageResponse)
async def list_work_items(
    project_id: str | None = Query(default=None, alias="projectId"),
    cursor: str | None = Query(default=None),
    limit: int = Query(default=50, ge=1, le=100),
    query_module=Depends(get_task_space_query_module),
    scope=Depends(get_space_runtime_handle),
) -> WorkItemPageResponse:
    """List work items with optional project filter and pagination."""
    filters: dict[str, Any] = {}
    if project_id is not None:
        filters["project_id"] = project_id
    page = await query_module.list_work_items(
        scope,
        TaskSpacePageQuery(cursor=cursor, limit=limit, filters=filters),
    )
    space_id = _space_id(scope)
    depths = await _work_item_depths(scope, page.items)
    return WorkItemPageResponse(
        items=[
            _work_item_response(item, space_id, depths[str(item["id"])])
            for item in page.items
        ],
        next_cursor=page.next_cursor,
    )


@router.post("", response_model=TaskSpaceAcceptedResponse, status_code=201)
async def create_work_item(
    body: CreateWorkItemRequest,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    command_module=Depends(get_task_space_command_module),
    query_module=Depends(get_task_space_query_module),
    scope=Depends(get_space_runtime_handle),
) -> TaskSpaceAcceptedResponse:
    """Create a work item via the TaskSpace command module."""
    require_idempotency_key(body.command_id, idempotency_key)
    require_space_identity(scope, body.space_id)
    command = CreateWorkItem(
        command_id=body.command_id,
        space_id=body.space_id,
        project_id=body.project_id,
        title=body.title,
        description=body.description,
        parent_id=body.parent_id,
        type_definition_id=body.type_definition_id,
        status_definition_id=body.status_definition_id,
        priority=body.priority,
        payload_hash=body.payload_hash,
    )
    outcome = await command_module.execute(scope, command)
    return await _map_work_item_outcome(outcome, scope, query_module)


# --------------------------------------------------------------------------- #
# Static action routes — MUST be declared before /{work_item_id}
# --------------------------------------------------------------------------- #


@router.post("/{work_item_id}/move", response_model=TaskSpaceAcceptedResponse)
async def move_work_item(
    work_item_id: str,
    body: MoveWorkItemRequest,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    command_module=Depends(get_task_space_command_module),
    query_module=Depends(get_task_space_query_module),
    scope=Depends(get_space_runtime_handle),
) -> TaskSpaceAcceptedResponse:
    """Move a work item to a new parent."""
    require_idempotency_key(body.command_id, idempotency_key)
    require_space_identity(scope, body.space_id)
    command = MutateWorkItem(
        command_id=body.command_id,
        space_id=body.space_id,
        work_item_id=work_item_id,
        expected_version=body.expected_version,
        payload_hash=body.payload_hash,
        # child_rank is deliberately absent: the online Move API never accepts
        # a client-supplied rank.  The server assigns the authoritative
        # max(existing ranks, -1) + 1 within the same transaction.
        payload={
            "operation": "move",
            "project_id": body.project_id,
            "new_parent_id": body.parent_id,
        },
    )
    outcome = await command_module.execute(scope, command)
    return await _map_work_item_outcome(outcome, scope, query_module)


@router.post(
    "/{work_item_id}/reorder", response_model=TaskSpaceAcceptedResponse
)
async def reorder_work_item(
    work_item_id: str,
    body: ReorderWorkItemRequest,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    command_module=Depends(get_task_space_command_module),
    query_module=Depends(get_task_space_query_module),
    scope=Depends(get_space_runtime_handle),
) -> TaskSpaceAcceptedResponse:
    """Reposition a work item within its own parent (sibling reorder).

    ★ 集合级操作：rank 是「去掉自己之后」的兄弟序列插入位次，兄弟行的
      child_rank 由服务端一并重写为 0..n-1。parent_id 是 authority guard
      （必须等于当前父项）；换父仍走 POST /{work_item_id}/move。
    """
    require_idempotency_key(body.command_id, idempotency_key)
    require_space_identity(scope, body.space_id)
    command = MutateWorkItem(
        command_id=body.command_id,
        space_id=body.space_id,
        work_item_id=work_item_id,
        expected_version=body.expected_version,
        payload_hash=body.payload_hash,
        payload={
            "operation": "reorder",
            "parent_id": body.parent_id,
            "rank": body.rank,
        },
    )
    outcome = await command_module.execute(scope, command)
    return await _map_work_item_outcome(outcome, scope, query_module)


@router.post(
    "/{work_item_id}/transition", response_model=TaskSpaceAcceptedResponse
)
async def transition_work_item(
    work_item_id: str,
    body: TransitionWorkItemRequest,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    command_module=Depends(get_task_space_command_module),
    query_module=Depends(get_task_space_query_module),
    scope=Depends(get_space_runtime_handle),
) -> TaskSpaceAcceptedResponse:
    """Transition a work item to a new status."""
    require_idempotency_key(body.command_id, idempotency_key)
    require_space_identity(scope, body.space_id)
    command = MutateWorkItem(
        command_id=body.command_id,
        space_id=body.space_id,
        work_item_id=work_item_id,
        expected_version=body.expected_version,
        payload_hash=body.payload_hash,
        payload={
            "operation": "transition",
            "status_definition_id": body.status_definition_id,
        },
    )
    outcome = await command_module.execute(scope, command)
    return await _map_work_item_outcome(outcome, scope, query_module)


# --------------------------------------------------------------------------- #
# archived_at lifecycle routes — MUST be declared before /{work_item_id}
# --------------------------------------------------------------------------- #


def _archived_at_command(
    *,
    operation: str,
    command_id: str,
    space_id: str,
    work_item_id: str,
    expected_version: int,
    payload_hash: str,
) -> MutateWorkItem:
    """Trash / Restore share an empty business payload.

    ``archived_at`` is server-owned: the compiler stamps it from its own
    monotonic clock, so neither the wire schema nor the command payload
    accepts a caller-supplied timestamp (``extra="forbid"`` rejects it).
    """
    return MutateWorkItem(
        command_id=command_id,
        space_id=space_id,
        work_item_id=work_item_id,
        expected_version=expected_version,
        payload_hash=payload_hash,
        payload={"operation": operation},
    )


@router.post("/{work_item_id}/trash", response_model=TaskSpaceAcceptedResponse)
async def trash_work_item(
    work_item_id: str,
    body: TrashWorkItemRequest,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    command_module=Depends(get_task_space_command_module),
    query_module=Depends(get_task_space_query_module),
    scope=Depends(get_space_runtime_handle),
) -> TaskSpaceAcceptedResponse:
    """Soft-delete a work item (server-stamped ``archived_at``)."""
    require_idempotency_key(body.command_id, idempotency_key)
    require_space_identity(scope, body.space_id)
    command = _archived_at_command(
        operation="trash",
        command_id=body.command_id,
        space_id=body.space_id,
        work_item_id=work_item_id,
        expected_version=body.expected_version,
        payload_hash=body.payload_hash,
    )
    outcome = await command_module.execute(scope, command)
    return await _map_work_item_outcome(outcome, scope, query_module)


@router.post("/{work_item_id}/restore", response_model=TaskSpaceAcceptedResponse)
async def restore_work_item(
    work_item_id: str,
    body: RestoreWorkItemRequest,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    command_module=Depends(get_task_space_command_module),
    query_module=Depends(get_task_space_query_module),
    scope=Depends(get_space_runtime_handle),
) -> TaskSpaceAcceptedResponse:
    """Undo a soft delete (clear ``archived_at``)."""
    require_idempotency_key(body.command_id, idempotency_key)
    require_space_identity(scope, body.space_id)
    command = _archived_at_command(
        operation="restore",
        command_id=body.command_id,
        space_id=body.space_id,
        work_item_id=work_item_id,
        expected_version=body.expected_version,
        payload_hash=body.payload_hash,
    )
    outcome = await command_module.execute(scope, command)
    return await _map_work_item_outcome(outcome, scope, query_module)


# --------------------------------------------------------------------------- #
# D5 Y label junction routes — MUST be declared before /{work_item_id}
# --------------------------------------------------------------------------- #


def _labels_command(
    *,
    operation: str,
    command_id: str,
    space_id: str,
    work_item_id: str,
    expected_version: int,
    payload_hash: str,
    label_ids: list[str],
    require_removed_label_ids: list[str] | None = None,
) -> MutateWorkItem:
    """Build one label-set mutation declaring the FULL post-mutation set.

    ``require_removed_label_ids`` carries the address-level constraint of a
    single-label ``DELETE`` ("this exact label must be gone afterwards").  It
    is *not* re-derived here: the value travels into the command payload so the
    compiler — inside the locked authority transaction — is the one that
    compares it against the declared target set.  Deciding it at the route on
    an unlocked pre-read would be a TOCTOU race against a concurrent command.
    """
    business: dict[str, object] = {"label_ids": sorted(label_ids)}
    if require_removed_label_ids is not None:
        business["require_removed_label_ids"] = sorted(require_removed_label_ids)
    return MutateWorkItem(
        command_id=command_id,
        space_id=space_id,
        work_item_id=work_item_id,
        expected_version=expected_version,
        payload_hash=payload_hash,
        payload={"operation": operation, **business},
    )


@router.post("/{work_item_id}/labels", response_model=TaskSpaceAcceptedResponse)
async def add_work_item_labels(
    work_item_id: str,
    body: AddWorkItemLabelsRequest,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    command_module=Depends(get_task_space_command_module),
    query_module=Depends(get_task_space_query_module),
    scope=Depends(get_space_runtime_handle),
) -> TaskSpaceAcceptedResponse:
    """Converge the work item's label set to the declared full target set."""
    require_idempotency_key(body.command_id, idempotency_key)
    require_space_identity(scope, body.space_id)
    command = _labels_command(
        operation="add_labels",
        command_id=body.command_id,
        space_id=body.space_id,
        work_item_id=work_item_id,
        expected_version=body.expected_version,
        payload_hash=body.payload_hash,
        label_ids=body.label_ids,
    )
    outcome = await command_module.execute(scope, command)
    return await _map_work_item_outcome(outcome, scope, query_module)


@router.delete(
    "/{work_item_id}/labels/{label_id}", response_model=TaskSpaceAcceptedResponse
)
async def remove_work_item_label(
    work_item_id: str,
    label_id: str,
    body: RemoveWorkItemLabelsRequest,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    command_module=Depends(get_task_space_command_module),
    query_module=Depends(get_task_space_query_module),
    scope=Depends(get_space_runtime_handle),
) -> TaskSpaceAcceptedResponse:
    """Remove one label by declaring the post-removal full target set.

    The URL's ``label_id`` is part of the request contract, not decoration: the
    declared target set must actually have dropped THAT label.  The check is
    handed to the compiler as ``require_removed_label_ids`` so it runs inside
    the locked authority transaction; a route-layer pre-read would be unlocked
    and could not be trusted as the authority.

    ★ TS-02a upgrade compatibility (defect one): the address constraint was
    added to the *hashed* command contract by bbf528a, so a pre-upgrade client
    replaying its original body gets ``invalid_payload_hash`` before
    ``_resume_or_return`` is reachable.  A legacy request that is already
    FINALIZED is answered from its **own persisted receipt** instead — see
    ``_legacy_receipt_outcome``.  Nothing here loosens validation for a new
    request: the compatibility branch only runs once the new-rule hash check has
    already failed, and then re-verifies the persisted identity byte for byte.
    """
    require_idempotency_key(body.command_id, idempotency_key)
    require_space_identity(scope, body.space_id)
    command = _labels_command(
        operation="remove_labels",
        command_id=body.command_id,
        space_id=body.space_id,
        work_item_id=work_item_id,
        expected_version=body.expected_version,
        payload_hash=body.payload_hash,
        label_ids=body.label_ids,
        require_removed_label_ids=[label_id],
    )
    outcome = await command_module.execute(scope, command)
    if (
        isinstance(outcome, TaskSpaceRejected)
        and outcome.code == "invalid_payload_hash"
    ):
        legacy = await _legacy_receipt_outcome(
            command_id=body.command_id,
            work_item_id=work_item_id,
            scope=scope,
            payload_hash=body.payload_hash,
            expected_version=body.expected_version,
            label_ids=body.label_ids,
        )
        if isinstance(legacy, BatchMutationResult):
            return await _legacy_receipt_response(
                legacy, command_id=body.command_id, scope=scope, query_module=query_module
            )
        # Fail-closed, but diagnosed: the rejection carries which kind of miss
        # this was, so a crash-window replay is not indistinguishable from a
        # tampered payload.
        return await _map_work_item_outcome(
            _with_legacy_diagnosis(outcome, legacy), scope, query_module
        )
    return await _map_work_item_outcome(outcome, scope, query_module)


def _with_legacy_diagnosis(
    outcome: TaskSpaceRejected, legacy: LegacyReceiptOutcome | None
) -> TaskSpaceRejected:
    """Attach the legacy-lookup diagnosis to an ordinary hash rejection.

    The error **code** stays the closed-set ``invalid_payload_hash`` (no new
    code, closed set untouched); only the ``details`` gain the reason/recovery
    fields. A same-code-different-details rejection is what lets an operator —
    or the on-call runbook — tell "legacy request stuck in recovery" from
    "content genuinely does not match".

    ``legacy is None`` means the lookup proved *nothing* (unknown commandId,
    changed content, foreign request name, or no journal authority). That is
    still worth saying: it is the ``hash_mismatch`` case, and reporting it
    explicitly stops the two conditions from being byte-identical rejections.
    """
    diagnosis = dict(legacy_payload_rejection_reason(legacy))
    merged = {**dict(outcome.details), **diagnosis}
    return replace(outcome, details=merged)


async def _legacy_receipt_outcome(
    *,
    command_id: str,
    work_item_id: str,
    scope,
    payload_hash: str,
    expected_version: int,
    label_ids: list[str],
) -> BatchMutationResult | LegacyReceiptOutcome | None:
    """Look for one pre-TS-02a receipt that this replay is provably identical to.

    Returns the hydrated durable result on a hit, a
    :class:`LegacyReceiptOutcome` explaining a *diagnosable* miss (a persisted
    but non-terminal record, or an unusable receipt), or ``None`` when there is
    simply nothing to say (unknown ID, changed content, foreign request name,
    or no authority to read the journal). It never writes: the compatibility
    path only re-reads.
    """
    session_factory = getattr(scope, "session_factory", None)
    if not callable(session_factory):
        # No authority to read the journal from: stay fail-closed.
        return None
    resolver = LegacyLabelReceiptResolver(session_factory)
    try:
        context = await resolver.load_identity(
            command_id=command_id,
            work_item_id=work_item_id,
            declared_payload_hash=payload_hash,
            expected_version=expected_version,
            declared_label_ids=label_ids,
        )
        if context is None:
            return None
        if not resolver.space_matches(context, scope):
            # Foreign Space: same closed 403 the new-request path raises.
            raise AppError(
                code="space_scope_mismatch",
                details={
                    "scopeSpaceId": _space_id(scope),
                    "payloadSpaceId": context.space_id,
                },
            )
        return await resolver.receipt_for(context)
    except AppError:
        raise
    except Exception:  # noqa: BLE001 - an unreadable journal is a non-match
        logger.exception("legacy label receipt lookup failed for %s", command_id)
        return None


async def _legacy_receipt_response(
    result: BatchMutationResult,
    *,
    command_id: str,
    scope,
    query_module,
) -> TaskSpaceAcceptedResponse:
    """Re-read one hydrated legacy receipt through the ordinary response mapper.

    The persisted ``applied.entity_type`` is the *request* entity type
    (``"task_space"`` — see ``task_space/module.py`` which stamps
    ``entity_type="task_space"`` on every ``build_task_space_request``), not the
    *domain* entity the route serves. Passing that through verbatim would make
    ``_map_work_item_outcome`` skip its ``entity_type == "work_item"`` branch and
    return the raw durable post-image — a different wire shape from a live
    accepted response (no derived ``depth``). This route only ever serves work
    items, so the domain entity type is stated explicitly here and the ordinary
    enrichment applies, keeping one shape for both a live accept and a replay.

    Zero new ledger events and zero version movement: nothing was executed.
    """
    applied = result.applied[0]
    entity_id = str(applied.entity_id)
    # Fail closed rather than answering with a foreign shape: this route serves
    # exactly one work item under one commandId, so a receipt that does not
    # belong to that command is not ours to return. ``idempotency_conflict``
    # (409, closed set) is the same code ``_resume_or_return`` uses when a
    # batch identity does not match the request being replayed.
    if str(applied.batch_id) != command_id:
        raise AppError(
            code="idempotency_conflict",
            details={
                "reason": "the legacy receipt does not belong to this command",
                "operation_id": command_id,
                "existing_batch_id": str(applied.batch_id),
            },
        )
    outcome = TaskSpaceAccepted(
        command_id=command_id,
        entity_type="work_item",
        entity_id=entity_id,
        version=int(applied.version) if applied.version is not None else 0,
        value=dict(applied.value),
    )
    return await _map_work_item_outcome(outcome, scope, query_module)


# --------------------------------------------------------------------------- #
# Plain mutation routes — declared after all static action routes
# --------------------------------------------------------------------------- #


@router.patch("/{work_item_id}", response_model=TaskSpaceAcceptedResponse)
async def update_work_item(
    work_item_id: str,
    body: UpdateWorkItemRequest,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    command_module=Depends(get_task_space_command_module),
    query_module=Depends(get_task_space_query_module),
    scope=Depends(get_space_runtime_handle),
) -> TaskSpaceAcceptedResponse:
    """Update mutable fields of a work item."""
    require_idempotency_key(body.command_id, idempotency_key)
    require_space_identity(scope, body.space_id)
    # The business payload is a nested ``patch`` object that mirrors the
    # compiler contract (``_compile_UpdateWorkItem`` reads payload["patch"]).
    # Only fields the caller explicitly provided appear in the patch, so an
    # explicit ``description: null`` clears the field while an omitted field
    # is left untouched -- matching the frontend canonical hash input.
    patch: dict[str, Any] = {}
    for field_name in ("title", "description", "priority", "type_definition_id", "due_at"):
        if field_name in body.model_fields_set:
            patch[field_name] = getattr(body, field_name)
    command = MutateWorkItem(
        command_id=body.command_id,
        space_id=body.space_id,
        work_item_id=work_item_id,
        expected_version=body.expected_version,
        payload_hash=body.payload_hash,
        payload={"operation": "update", "patch": patch},
    )
    outcome = await command_module.execute(scope, command)
    return await _map_work_item_outcome(outcome, scope, query_module)


@router.get("/{work_item_id}", response_model=WorkItemResponse)
async def get_work_item(
    work_item_id: str,
    query_module=Depends(get_task_space_query_module),
    scope=Depends(get_space_runtime_handle),
) -> WorkItemResponse:
    """Get a single work item by ID."""
    view = await query_module.get_work_item(scope, work_item_id)
    value = view.value
    depths = await _work_item_depths(scope, (value,))
    return _work_item_response(value, _space_id(scope), depths[str(value["id"])])
