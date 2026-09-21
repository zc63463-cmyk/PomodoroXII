"""TS-03: the closed MCP task-space write gateway.

Exactly one bounded tool, ``execute_task_space_commands``, over the existing
TS-02 batch contract.  It is a *transport* for the same canonical mutation path
that REST already uses:

    wire batch → closed domain command union → prepare_batch_items
    → one execute_prepared_batch → per-position receipt

Design boundaries (all fail-closed):

- **Closed command set.**  The wire schema's ``kind`` discriminator plus the
  tool's own allow-list admit exactly nine operations.  There is no code path
  that dispatches a caller-supplied mutation name, and no ORM handle is
  exposed.
- **Authorization before admission, admission before work.**  The principal is
  authenticated by the transport, the Space is authorized by opening a runtime
  handle, admission reserves units equal to the command count, and only then
  does exactly one ``execute_prepared_batch`` run.  Any failure before
  execution releases the reservation.
- **No read-model leakage.**  Receipts carry the same durable fields REST
  returns (``entity_type``, ``entity_id``, ``version``, domain post-image
  value).  Derived read-model fields (computed ``depth``, ``displayKey``, …)
  are never produced or accepted here.
- **REST-equivalent errors.**  ``code`` / ``details`` / ``retryable`` come from
  the same error owner as REST, so a client can treat both transports alike.
"""
from __future__ import annotations

import json
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from typing import TYPE_CHECKING, Annotated, Any

from fastmcp import FastMCP
from fastmcp.tools import FunctionTool
from pydantic import Field
from pydantic import ValidationError as PydanticValidationError

from app.auth.authority import Principal
from app.errors import AppError, ValidationError, to_wire_json
from app.mcp.admission import AdmissionLease, McpWriteAdmission, mcp_write_admission
from app.mcp.auth import canonical_mcp_errors, current_mcp_principal
from app.mutation.types import canonical_json_bytes
from app.runtime.scope import AccessMode
from app.schemas.task_space_batch import (
    BatchAddWorkItemLabelsCommand,
    BatchCreateRelationCommand,
    BatchCreateWorkItemCommand,
    BatchMoveWorkItemCommand,
    BatchRemoveRelationCommand,
    BatchRemoveWorkItemLabelsCommand,
    BatchResolveRelationCommand,
    BatchTransitionWorkItemCommand,
    BatchUpdateWorkItemCommand,
    TaskSpaceBatchCommand,
    TaskSpaceBatchRequest,
    TaskSpaceBatchResponse,
)
from app.task_space.batch import (
    BATCH_DUPLICATE_IDS_MESSAGE,
    BATCH_EMPTY_MESSAGE,
    DefaultTaskSpaceBatchCommandModule,
)
from app.task_space.contracts import (
    TASK_SPACE_BATCH_MAX_CANONICAL_BYTES,
    CreateWorkItem,
    MutateWorkItem,
    RelationCommand,
    TaskSpaceBatchOutcome,
    TaskSpaceCommand,
)
from app.task_space.contracts import (
    relation_id as derive_relation_id,
)

if TYPE_CHECKING:
    from app.mcp.sync_tools import McpSyncProtocolFactory
    from app.runtime.space import SpaceRuntimeHandle

RuntimeServicesProvider = Callable[[], "Any"]

#: The closed set of command kinds this gateway accepts.  It mirrors the wire
#: schema discriminator exactly; a mismatch is a hard registration error rather
#: than a silently wider surface.
ALLOWED_COMMAND_KINDS: frozenset[str] = frozenset(
    {
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
)

#: Write access mode for the gateway's runtime handle.
_MCP_WRITE_ACCESS_MODE: AccessMode = "write"

BatchId = Annotated[str, Field(min_length=1, max_length=128)]

#: The nine wire command models backing :data:`ALLOWED_COMMAND_KINDS`.
_COMMAND_UNION = (
    BatchCreateWorkItemCommand,
    BatchUpdateWorkItemCommand,
    BatchMoveWorkItemCommand,
    BatchTransitionWorkItemCommand,
    BatchAddWorkItemLabelsCommand,
    BatchRemoveWorkItemLabelsCommand,
    BatchCreateRelationCommand,
    BatchRemoveRelationCommand,
    BatchResolveRelationCommand,
)


def _domain_command(command: TaskSpaceBatchCommand) -> TaskSpaceCommand:
    """Convert one wire batch command into the closed domain command union.

    Deliberately identical to the REST batch route's mapping: same payload
    shapes, same server-owned-field rules.  A batch command and the equivalent
    single request therefore compile to identical MutationRequests — and hence
    identical request hashes, versions, and idempotency behavior across
    transports.

    Kept in this module (rather than imported from the route) so the MCP
    surface depends on the domain contract, not on an HTTP router.
    """
    if isinstance(command, BatchCreateWorkItemCommand):
        return CreateWorkItem(
            command_id=command.command_id,
            space_id=command.space_id,
            project_id=command.project_id,
            title=command.title,
            description=command.description,
            parent_id=command.parent_id,
            type_definition_id=command.type_definition_id,
            status_definition_id=command.status_definition_id,
            priority=command.priority,
            payload_hash=command.payload_hash,
        )
    if isinstance(command, BatchUpdateWorkItemCommand):
        # Only explicitly provided fields enter the patch: an explicit null
        # clears, an omitted field is left untouched (single-PATCH semantics).
        patch: dict[str, Any] = {
            field: getattr(command, field)
            for field in ("title", "description", "priority", "type_definition_id")
            if field in command.model_fields_set
        }
        return MutateWorkItem(
            command_id=command.command_id,
            space_id=command.space_id,
            work_item_id=command.work_item_id,
            expected_version=command.expected_version,
            payload_hash=command.payload_hash,
            payload={"operation": "update", "patch": patch},
        )
    if isinstance(command, BatchMoveWorkItemCommand):
        # child_rank is server-assigned online; the wire whitelist rejects it.
        return MutateWorkItem(
            command_id=command.command_id,
            space_id=command.space_id,
            work_item_id=command.work_item_id,
            expected_version=command.expected_version,
            payload_hash=command.payload_hash,
            payload={
                "operation": "move",
                "project_id": command.project_id,
                "new_parent_id": command.parent_id,
            },
        )
    if isinstance(command, BatchTransitionWorkItemCommand):
        return MutateWorkItem(
            command_id=command.command_id,
            space_id=command.space_id,
            work_item_id=command.work_item_id,
            expected_version=command.expected_version,
            payload_hash=command.payload_hash,
            payload={
                "operation": "transition",
                "status_definition_id": command.status_definition_id,
            },
        )
    if isinstance(command, BatchAddWorkItemLabelsCommand):
        return MutateWorkItem(
            command_id=command.command_id,
            space_id=command.space_id,
            work_item_id=command.work_item_id,
            expected_version=command.expected_version,
            payload_hash=command.payload_hash,
            payload={
                "operation": "add_labels",
                "label_ids": sorted(command.label_ids),
            },
        )
    if isinstance(command, BatchRemoveWorkItemLabelsCommand):
        return MutateWorkItem(
            command_id=command.command_id,
            space_id=command.space_id,
            work_item_id=command.work_item_id,
            expected_version=command.expected_version,
            payload_hash=command.payload_hash,
            payload={
                "operation": "remove_labels",
                "label_ids": sorted(command.label_ids),
            },
        )
    if isinstance(
        command,
        (
            BatchCreateRelationCommand,
            BatchRemoveRelationCommand,
            BatchResolveRelationCommand,
        ),
    ):
        return RelationCommand(
            operation=command.kind.removeprefix("relation."),
            command_id=command.command_id,
            space_id=command.space_id,
            relation_id=derive_relation_id(
                command.space_id,
                command.from_work_item_id,
                command.to_work_item_id,
                command.relation_type,
            ),
            from_work_item_id=command.from_work_item_id,
            to_work_item_id=command.to_work_item_id,
            relation_type=command.relation_type,
            expected_version=(
                None if command.kind == "relation.create" else command.expected_version
            ),
            payload_hash=command.payload_hash,
        )
    raise TypeError(f"unsupported batch command: {type(command).__name__}")


def _batch_response(outcome: TaskSpaceBatchOutcome) -> TaskSpaceBatchResponse:
    """Map the domain batch outcome union to the wire receipt (input order).

    Same shape as the REST endpoint's receipt — one item per input position,
    durable per-step results, no derived read-model fields.
    """
    from app.task_space.contracts import TaskSpaceAccepted

    items: list[Any] = []
    accepted_count = 0
    for item in outcome.items:
        outcome_value = item.outcome
        if isinstance(outcome_value, TaskSpaceAccepted):
            accepted_count += 1
            items.append(
                {
                    "status": "accepted",
                    "input_index": item.input_index,
                    "command_id": outcome_value.command_id,
                    "entity_type": outcome_value.entity_type,
                    "entity_id": outcome_value.entity_id,
                    "version": outcome_value.version,
                    "value": to_wire_json(outcome_value.value),
                }
            )
        else:
            items.append(
                {
                    "status": "rejected",
                    "input_index": item.input_index,
                    "command_id": outcome_value.command_id,
                    "code": outcome_value.code,
                    "retryable": outcome_value.retryable,
                    "details": to_wire_json(outcome_value.details),
                }
            )
    return TaskSpaceBatchResponse(
        batch_id=outcome.batch_id,
        accepted_count=accepted_count,
        rejected_count=len(items) - accepted_count,
        items=items,
    )


class McpTaskSpaceWriteGateway:
    """Authenticate, authorize, admit, then execute exactly one batch."""

    def __init__(
        self,
        services_provider: RuntimeServicesProvider,
        *,
        admission: McpWriteAdmission = mcp_write_admission,
    ) -> None:
        self._services_provider = services_provider
        self._admission = admission

    async def authenticate(self) -> Principal:
        return current_mcp_principal()

    @asynccontextmanager
    async def open_authorized(
        self, *, principal: Principal, space_id: str
    ) -> AsyncIterator["SpaceRuntimeHandle"]:
        """Open the Space runtime handle in *write* mode (normal authorization)."""
        services = self._services_provider()
        handle = await services.scope.open(
            principal, space_id, _MCP_WRITE_ACCESS_MODE
        )
        async with handle:
            yield handle

    def _assert_space_identity(
        self, handle: "SpaceRuntimeHandle", commands: tuple[TaskSpaceCommand, ...]
    ) -> None:
        """Reject a batch whose commands address a different Space.

        Checked before admission is charged, so a cross-Space attempt is a
        pure authorization failure — no budget is consumed.
        """
        scope_space_id = getattr(getattr(handle, "scope", None), "space_id", None)
        if not isinstance(scope_space_id, str):
            raise RuntimeError("authorized Space runtime handle is required")
        for command in commands:
            if command.space_id != scope_space_id:
                raise AppError(
                    code="space_scope_mismatch",
                    details={
                        "scopeSpaceId": scope_space_id,
                        "payloadSpaceId": command.space_id,
                    },
                )

    def parse_request(
        self, batch_id: str, commands: list[Any]
    ) -> TaskSpaceBatchRequest:
        """Validate the closed wire batch shape (unknown/dormant fields fail).

        Built through the wire aliases on purpose: the MCP tool takes friendly
        snake_case parameters, while the receipt and the persisted batch
        identity are governed by the same wire schema REST uses.
        """
        try:
            return TaskSpaceBatchRequest.model_validate(
                {"batchId": batch_id, "commands": commands}
            )
        except PydanticValidationError as exc:
            raise ValidationError(
                "Task Space batch request is not a valid closed batch",
                details={"errors": json.loads(exc.json())},
            ) from exc

    async def execute(
        self,
        scope: "SpaceRuntimeHandle",
        commands: tuple[TaskSpaceCommand, ...],
        batch_id: str,
    ) -> Any:
        """Run exactly one ``execute_prepared_batch`` through the shared UoW."""
        services = self._services_provider()
        uow = services.mutation_uow
        if uow is None:
            raise RuntimeError("MCP task-space writes require the shared UoW")
        batch_module = DefaultTaskSpaceBatchCommandModule(uow)
        return await batch_module.execute_batch(scope, commands, batch_id)


def _canonical_batch_bytes(body: TaskSpaceBatchRequest) -> bytes:
    return canonical_json_bytes(
        [command.model_dump(by_alias=True, mode="json") for command in body.commands]
    )


@canonical_mcp_errors
async def execute_task_space_commands(
    batch_id: BatchId,
    commands: list[dict[str, Any]],
) -> dict[str, Any]:
    """Execute one closed batch of Task Space write commands.

    Accepts exactly these command kinds: ``work_item.create``,
    ``work_item.update``, ``work_item.move``, ``work_item.transition``,
    ``work_item.add_labels``, ``work_item.remove_labels``, ``relation.create``,
    ``relation.remove`` and ``relation.resolve``.

    Every command carries its own ``spaceId`` (which must match the authorized
    Space), ``commandId``, ``payloadHash`` and — for mutations — the
    ``expectedVersion`` it was computed against.  The returned receipt has one
    item per input position, in input order.
    """
    gateway = _gateway()
    principal = await gateway.authenticate()

    if not isinstance(commands, list):
        raise ValidationError("Task Space batch commands must be a list")
    if not commands:
        raise ValidationError(BATCH_EMPTY_MESSAGE)

    body = gateway.parse_request(batch_id, commands)
    command_ids = [command.command_id for command in body.commands]
    if len(set(command_ids)) != len(command_ids):
        raise ValidationError(BATCH_DUPLICATE_IDS_MESSAGE)
    if len(_canonical_batch_bytes(body)) > TASK_SPACE_BATCH_MAX_CANONICAL_BYTES:
        raise ValidationError(
            "Task Space batch canonical content exceeds the 1 MiB budget"
        )

    domain_commands = tuple(_domain_command(command) for command in body.commands)
    space_id = domain_commands[0].space_id

    lease: AdmissionLease | None = None
    try:
        async with gateway.open_authorized(
            principal=principal, space_id=space_id
        ) as scope:
            # Authorization completes first: a caller addressing another Space
            # must not consume budget.
            gateway._assert_space_identity(scope, domain_commands)
            lease = await gateway._admission.check(
                principal, space_id, len(domain_commands)
            )
            try:
                outcome = await gateway.execute(
                    scope, domain_commands, body.batch_id
                )
            except BaseException:
                await lease.release()
                raise
    except BaseException:
        if lease is not None and not lease.settled:
            await lease.release()
        raise

    await lease.commit()
    response = _batch_response(outcome)
    # Emit the same wire shape REST returns (camelCase aliases, JSON-native).
    return response.model_dump(by_alias=True, mode="json")


_gateway_factory: "McpTaskSpaceWriteGateway | None" = None


def _gateway() -> McpTaskSpaceWriteGateway:
    if _gateway_factory is None:
        raise RuntimeError("MCP task-space write gateway is not installed")
    return _gateway_factory


def _assert_closed_surface() -> None:
    """The wire schema's discriminators must equal the published allow-list.

    Registration-time gate: if someone adds a command to the batch union
    without adding it here (or vice versa) the MCP server refuses to start
    rather than silently exposing a wider or narrower surface than the design
    document promises.
    """
    from typing import get_args

    literals: set[str] = set()
    for member in _COMMAND_UNION:
        literals.update(get_args(member.model_fields["kind"].annotation))
    if literals != ALLOWED_COMMAND_KINDS:
        raise RuntimeError(
            "MCP task-space command surface does not match the closed allow-list"
        )


def register_task_space_write_tools(
    mcp: FastMCP,
    protocol_factory: "McpSyncProtocolFactory",
    *,
    admission: McpWriteAdmission = mcp_write_admission,
) -> None:
    """Install exactly one bounded task-space write tool."""
    global _gateway_factory
    _assert_closed_surface()
    _gateway_factory = McpTaskSpaceWriteGateway(
        protocol_factory.services_provider, admission=admission
    )
    tool = FunctionTool.from_function(
        execute_task_space_commands,
        name="execute_task_space_commands",
        output_schema=TaskSpaceBatchResponse.model_json_schema(),
    )
    mcp.add_tool(tool)


__all__ = [
    "ALLOWED_COMMAND_KINDS",
    "McpTaskSpaceWriteGateway",
    "execute_task_space_commands",
    "register_task_space_write_tools",
]
