"""Sync-to-S3 command mapping.

The mapper has no persistence side effects.  It resolves the final catalog
wire key and delegates all entity/domain invariants to ``EntityCommand``.
"""

from __future__ import annotations

import hashlib
from collections.abc import Sequence

from app.commands.entity import EntityCommand
from app.errors import IdempotencyConflictError
from app.mutation.types import (
    MutationRejection,
    MutationRequest,
    MutationRuleViolation,
    PreparedBatchItem,
)
from app.registry.catalog import CompiledEntityCatalog
from app.sync.contracts import (
    MappedSyncBatch,
    SyncEventInput,
    canonical_sync_event_bytes,
    validate_sync_operation_id,
)


class SyncCommandMapper:
    """Translate transport events into the existing S3 command boundary."""

    def __init__(self, catalog: CompiledEntityCatalog, commands: EntityCommand) -> None:
        self.catalog = catalog
        self.commands = commands

    def to_request(self, scope: object, event: SyncEventInput) -> MutationRequest:
        spec = self.catalog.try_get_by_sync_key(event.entity_type)
        if spec is None:
            raise MutationRuleViolation(
                "entity_not_sync_enabled",
                {"entity_type": event.entity_type, "entity_id": event.entity_id},
            )
        # EntityCommand.from_sync_event resolves aliases again and owns all
        # identity, delete-payload, CAS/LWW, tree, relation, and policy rules.
        return self.commands.from_sync_event(scope, event)

    def partition(self, scope: object, events: Sequence[SyncEventInput]) -> MappedSyncBatch:
        parsed = tuple(events)
        operation_ids = tuple(event.operation_id for event in parsed)
        for operation_id in operation_ids:
            validate_sync_operation_id(operation_id)
        if len(set(operation_ids)) != len(operation_ids):
            raise IdempotencyConflictError(
                operation_id=next(
                    operation_id
                    for index, operation_id in enumerate(operation_ids)
                    if operation_id in operation_ids[:index]
                )
            )

        items: list[PreparedBatchItem] = []
        for index, event in enumerate(parsed):
            intent_hash = hashlib.sha256(canonical_sync_event_bytes(event)).hexdigest()
            try:
                request = self.to_request(scope, event)
            except MutationRuleViolation as exc:
                rejection = MutationRejection(
                    request_index=index,
                    operation_id=event.operation_id,
                    entity_type=event.entity_type,
                    entity_id=event.entity_id,
                    code=exc.code,
                    retryable=exc.retryable,
                    details=exc.details,
                )
                items.append(
                    PreparedBatchItem(
                        index,
                        event.operation_id,
                        intent_hash,
                        request=None,
                        pre_rejection=rejection,
                    )
                )
            else:
                items.append(
                    PreparedBatchItem(
                        index,
                        event.operation_id,
                        intent_hash,
                        request=request,
                        pre_rejection=None,
                    )
                )
        return MappedSyncBatch(tuple(items))


__all__ = ["SyncCommandMapper"]
