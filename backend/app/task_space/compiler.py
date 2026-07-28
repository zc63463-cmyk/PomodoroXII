"""Task Space mutation compiler: virtual REST commands and real entity sync."""

from __future__ import annotations

import uuid
from collections.abc import Callable

from app.focus_session.contracts import CommandReceiptState  # noqa: F401
from app.focus_session.receipts import decode_reconcile_coordination  # noqa: F401
from app.mutation.types import (
    DbMutationPlan,
    MutationCommand,
    MutationRequest,
    SyncEventPlan,
)
from app.mutation.unit_of_work import MutationCompileContext
from app.services.time import utc_now_iso_ms
from app.task_space.contracts import (
    SYSTEM_STATUS_IDS,
    SYSTEM_TYPE_ID,
)
from app.task_space.document import InvalidNoteDocument, UnsupportedContentVersion

TASK_SPACE_POLICY_ENTITY_TYPES = frozenset({
    "task_space", "project", "status_definition", "type_definition", "label",
    "work_item_label", "work_item", "work_item_note",
})


class TaskSpaceCompiler:
    """Owns virtual Task Space REST commands and all seven real entity types.

    Registered as a single ``MutationDomainPolicy`` so that every Task Space
    entity_type is policy-owned; none fall through to the generic catalog
    compiler.
    """

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
            if not request.name.startswith(self.namespace):
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


# -- read-only sync entity rejection -----------------------------------------

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


async def _compile_sync_entity(self, context, request):
    if request.name not in ENTITY_ACTIONS:
        raise RuntimeError(f"unregistered EntityCommand action: {request.name}")
    if request.entity_type in READ_ONLY_SYNC_TYPES:
        _reject_formal_sync(request, "typed_command_required")
    if request.entity_type == "work_item":
        return await self.compile_sync_work_item(context, request)
    if request.entity_type == "work_item_note":
        return await self.compile_sync_work_item_note(context, request)
    raise RuntimeError(f"unowned Task Space entity: {request.entity_type}")


TaskSpaceCompiler.compile_sync_entity = _compile_sync_entity


# -- CreateProject compilation -----------------------------------------------

TASK_SPACE_NAMESPACE = uuid.UUID("2d20283e-826f-45d2-9993-cf6609987aaa")


def _stable_id(kind: str, command_id: str) -> str:
    return uuid.uuid5(TASK_SPACE_NAMESPACE, f"{kind}\0{command_id}").hex


async def _compile_CreateProject(self, context, request):
    from app.mutation.types import MutationRuleViolation
    from app.task_space.contracts import normalize_project_key

    overlay = context.authority
    try:
        key = normalize_project_key(str(request.payload["key"]))
    except ValueError as exc:
        raise MutationRuleViolation(
            "invalid_project_key",
            {"key": str(request.payload["key"])},
            retryable=False,
        ) from exc
    if any(str(row["key"]) == key for row in overlay.rows("project")):
        raise MutationRuleViolation("project_key_conflict", {"key": key}, retryable=False)
    project_id = _stable_id("project", str(request.payload["command_id"]))
    now = self.now_iso_ms()
    after = {
        "id": project_id,
        "key": key,
        "name": str(request.payload["name"]).strip(),
        "description": request.payload.get("description"),
        "rank": len(overlay.rows("project")),
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
