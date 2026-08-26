"""The transport-neutral Sync v2 protocol module."""

from __future__ import annotations

import json
from contextlib import asynccontextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Any, AsyncIterator

from sqlalchemy import func, select

from app.errors import AppError, SpaceRecoveryRequiredError, SyncCursorExpiredError
from app.models.mutation import MutationBatch, MutationOperation
from app.models.sync_client import SyncClient
from app.models.sync_outbox import SyncOutbox
from app.mutation.journal import IllegalMutationTransition, MutationJournal
from app.mutation.types import BatchMutationResult, MutationState
from app.runtime.leases import LeaseMode, LeaseOrderError
from app.services.sync_outbox import get_current_cursor, get_retention_floor
from app.sync.clients import AckDecision, AckResult, SyncClientRegistry
from app.sync.commands import SyncCommandMapper
from app.sync.contracts import (
    MAX_DECODED_CANONICAL_PAGE_BYTES,
    MappedSyncBatch,
    OperationQueryItem,
    OperationQueryResult,
    PullPage,
    PullPageEnvelope,
    PushApplied,
    PushConflict,
    PushError,
    PushResult,
    RecoveryPage,
    SyncEventInput,
    SyncEventRecord,
    SyncLedgerIntegrityError,
    SyncStatusResult,
    canonical_contract_bytes,
    conflict_resolution_for_rejection,
    split_conflict_snapshot,
    validate_client_id,
    validate_cursor_token,
    validate_operation_query_inputs,
    validate_page_token,
    validate_pull_limit,
    validate_sync_push_inputs,
)
from app.sync.cursor import CursorPosition, SyncCursorCodec
from app.sync.operations import SYNC_OPERATION_BY_NAME, SyncOperationName
from app.sync.snapshot import (
    SyncPageTokenCodec,
    SyncSnapshotSerializer,
    SyncSnapshotStore,
)

if TYPE_CHECKING:
    from app.auth.authority import Principal
    from app.runtime.bootstrap import RuntimeServices


def _now_utc() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _space_id(scope: object) -> str:
    nested = getattr(scope, "scope", None)
    value = getattr(nested, "space_id", None) or getattr(scope, "space_id", None)
    if not isinstance(value, str) or not value:
        raise LeaseOrderError("SyncProtocol requires an authorized Space identity")
    return value


def _batch_push_result(receipt: BatchMutationResult) -> PushResult:
    if receipt.batch_id is None:
        raise IllegalMutationTransition("batch receipt has no batch identity")
    if any(item.batch_id != receipt.batch_id for item in receipt.applied):
        raise IllegalMutationTransition("batch receipt contains a foreign applied batch")
    result_ids = [
        *(item.operation_id for item in receipt.applied),
        *(item.operation_id for item in receipt.rejected),
    ]
    if len(result_ids) != len(set(result_ids)):
        raise IllegalMutationTransition("batch receipt contains duplicate operation IDs")
    applied = []
    conflicts = []
    errors = []
    for item in receipt.applied:
        if item.version is None:
            raise SpaceRecoveryRequiredError("persisted mutation result has no version")
        applied.append(
            PushApplied(item.operation_id, item.entity_type, item.entity_id, item.version, item.resolution)
        )
    for item in receipt.rejected:
        resolution = conflict_resolution_for_rejection(item.code, item.details)
        if resolution is not None:
            kept_details, snapshot, snapshot_version = split_conflict_snapshot(item.details)
            conflicts.append(
                PushConflict(
                    item.operation_id,
                    item.entity_type,
                    item.entity_id,
                    item.code,
                    resolution,  # type: ignore[arg-type]
                    kept_details,
                    snapshot,
                    snapshot_version,
                )
            )
        else:
            errors.append(
                PushError(
                    item.operation_id,
                    item.entity_type,
                    item.entity_id,
                    item.code,
                    item.retryable,
                    item.details,
                )
            )
    return PushResult(receipt.batch_id, tuple(applied), tuple(conflicts), tuple(errors))


def _assert_complete_batch_receipt(
    receipt: BatchMutationResult,
    *,
    child_sequences: dict[str, int],
    accepted_count: int,
) -> None:
    """Fail closed if a terminal receipt no longer matches its journal children."""
    child_ids = set(child_sequences)
    applied_ids = {item.operation_id for item in receipt.applied}
    if (
        type(accepted_count) is not int
        or accepted_count < 0
        or len(receipt.applied) != accepted_count
        or receipt.input_count != len(receipt.applied) + len(receipt.rejected)
        or applied_ids != child_ids
    ):
        raise IllegalMutationTransition(
            "terminal batch receipt does not cover the original batch"
        )
    rejection_indices = [item.request_index for item in receipt.rejected]
    if len(rejection_indices) != len(set(rejection_indices)):
        raise IllegalMutationTransition("terminal batch receipt has duplicate request indexes")
    if set(rejection_indices) - set(range(receipt.input_count)):
        raise IllegalMutationTransition("terminal batch receipt has an invalid request index")
    expected_applied_order = tuple(
        operation_id
        for operation_id, _sequence in sorted(
            child_sequences.items(), key=lambda item: item[1]
        )
    )
    if tuple(item.operation_id for item in receipt.applied) != expected_applied_order:
        raise IllegalMutationTransition("terminal batch receipt changed accepted order")


@dataclass(frozen=True, slots=True)
class BoundedPullPage:
    """The bounded reader's immutable result wrapper."""

    page: PullPage


async def read_visible_event_page_bounded(
    session: Any,
    *,
    after_sequence: int,
    max_events: int,
    page_envelope: PullPageEnvelope,
    max_canonical_page_bytes: int = MAX_DECODED_CANONICAL_PAGE_BYTES,
    fetch_chunk_size: int = 32,
) -> BoundedPullPage:
    """Read visible ledger rows without materializing a limit+1 page.

    The reader uses keyset chunks and budgets the complete wire envelope before
    accepting a row.  A row that does not fit remains untouched for the next
    cursor page.
    """
    if type(after_sequence) is not int or after_sequence < 0:
        raise ValueError("after_sequence must be a nonnegative integer")
    validate_pull_limit(max_events)
    if type(fetch_chunk_size) is not int or not 1 <= fetch_chunk_size <= 32:
        raise ValueError("fetch_chunk_size must be between 1 and 32")
    if type(max_canonical_page_bytes) is not int or max_canonical_page_bytes <= 0:
        raise ValueError("max_canonical_page_bytes must be positive")

    selected: list[SyncEventRecord] = []
    last_sequence = after_sequence
    deferred = False
    exhausted = False
    while len(selected) < max_events and not exhausted:
        chunk_size = min(fetch_chunk_size, max_events - len(selected))
        rows = list(
            (
                await session.execute(
                    select(SyncOutbox)
                    .where(
                        SyncOutbox.visible.is_(True),
                        SyncOutbox.id > last_sequence,
                    )
                    .order_by(SyncOutbox.id)
                    .limit(chunk_size)
                )
            ).scalars()
        )
        if not rows:
            exhausted = True
            break
        for row in rows:
            try:
                record = SyncEventRecord.from_row(row)
            except SyncLedgerIntegrityError as exc:
                raise SpaceRecoveryRequiredError(
                    "visible sync ledger integrity requires recovery"
                ) from exc
            candidate_wire = {
                "events": [*selected, record],
                "next_cursor": page_envelope.cursor_for(row.id),
                # False is the conservative, one-byte-longer representation;
                # the final page may use true.
                "has_more": False,
                "catalog_hash": page_envelope.catalog_hash,
            }
            if len(canonical_contract_bytes(candidate_wire)) > max_canonical_page_bytes:
                if not selected:
                    raise ValueError("one sync event exceeds page budget")
                deferred = True
                exhausted = True
                break
            selected.append(record)
            last_sequence = row.id
            if len(selected) == max_events:
                break
        if exhausted or len(selected) == max_events:
            break
        if len(rows) < chunk_size:
            exhausted = True

    if not selected:
        return BoundedPullPage(
            PullPage(
                (),
                page_envelope.cursor_for(after_sequence),
                False,
                page_envelope.catalog_hash,
            )
        )

    if deferred:
        has_more = True
    elif len(selected) == max_events:
        has_more = (
            await session.scalar(
                select(SyncOutbox.id)
                .where(
                    SyncOutbox.visible.is_(True),
                    SyncOutbox.id > last_sequence,
                )
                .order_by(SyncOutbox.id)
                .limit(1)
            )
        ) is not None
    else:
        has_more = False

    page = PullPage(
        tuple(selected),
        page_envelope.cursor_for(last_sequence),
        has_more,
        page_envelope.catalog_hash,
    )
    if len(canonical_contract_bytes(page)) > max_canonical_page_bytes:
        raise ValueError("pull page exceeds canonical byte budget")
    return BoundedPullPage(page)


class SyncProtocol:
    """Single operation catalog used by REST, MCP, and direct callers."""

    def __init__(
        self,
        scope: object,
        uow: object | None = None,
        *,
        catalog: Any | None = None,
        mapper: SyncCommandMapper | None = None,
        cursor: SyncCursorCodec | None = None,
        ttl_days: int | None = None,
        page_tokens: SyncPageTokenCodec | None = None,
        snapshot_serializer: SyncSnapshotSerializer | None = None,
    ) -> None:
        self.scope = scope
        self.uow = uow or getattr(scope, "uow", None)
        resolved_catalog = catalog or getattr(self.uow, "catalog", None)
        if resolved_catalog is None:
            raise ValueError("SyncProtocol requires the compiled runtime catalog")
        self.catalog = resolved_catalog
        if mapper is None:
            from app.commands.entity import EntityCommand

            mapper = SyncCommandMapper(self.catalog, EntityCommand(self.catalog))
        self.mapper = mapper
        from app.settings import settings

        if cursor is None:
            cursor = SyncCursorCodec(settings.sync_cursor_secret.encode("utf-8"))
        if ttl_days is None:
            ttl_days = settings.sync_client_ttl_days
        self.cursor = cursor
        self.ttl_days = ttl_days
        if page_tokens is None:
            page_tokens = SyncPageTokenCodec(
                settings.sync_cursor_secret.encode("utf-8") + b":snapshot"
            )
        self.page_tokens = page_tokens
        self.snapshot_serializer = snapshot_serializer or SyncSnapshotSerializer()

    @asynccontextmanager
    async def _exclusive(self, purpose: str) -> AsyncIterator[object]:
        factory = getattr(self.scope, "exclusive_space_resources", None)
        if factory is None:
            raise RuntimeError("SyncProtocol requires an exclusive Space resource guard")
        async with factory(purpose, 5) as lease:
            yield lease

    async def _recover(self, lease: object) -> None:
        if self.uow is None:
            raise RuntimeError("SyncProtocol requires a MutationUnitOfWork for recovery")
        recover = getattr(self.uow, "recover_under_lease", None)
        if recover is None or not callable(recover):
            raise RuntimeError("SyncProtocol requires UoW recover_under_lease")
        await recover(self.scope, lease)

    async def _register(self, client_id: str) -> Any:
        async with self._exclusive("sync-register") as lease:
            await self._recover(lease)
            async with self.scope.session_factory() as session:
                async with session.begin():
                    registry = SyncClientRegistry(
                        session,
                        catalog_hash=self.catalog.hash,
                        ttl_days=self.ttl_days,
                        space_id=_space_id(self.scope),
                    )
                    registration = await registry.register_or_touch(client_id)
            return registration

    async def query_operations(
        self, client_id: str, operation_ids: list[str] | tuple[str, ...]
    ) -> OperationQueryResult:
        client_id, operation_ids = validate_operation_query_inputs(client_id, operation_ids)
        async with self._exclusive("sync-operation-query") as lease:
            await self._recover(lease)
            async with self.scope.session_factory() as session:
                async with session.begin():
                    registry = SyncClientRegistry(
                        session,
                        catalog_hash=self.catalog.hash,
                        ttl_days=self.ttl_days,
                        space_id=_space_id(self.scope),
                    )
                    await registry.register_or_touch(client_id)
                    operation_rows = tuple(
                        await session.execute(
                            select(
                                MutationOperation.operation_id,
                                MutationOperation.batch_id,
                                MutationOperation.state,
                                MutationOperation.sequence,
                            ).where(MutationOperation.operation_id.in_(operation_ids))
                        )
                    )
                    rows = {
                        row.operation_id: (row.batch_id, MutationState(row.state))
                        for row in operation_rows
                    }
                    ambiguous_ids: set[str] = set()
                    unresolved_ids = set(operation_ids) - set(rows)
                    if unresolved_ids:
                        # Mapper pre-rejections intentionally have no
                        # MutationOperation child.  Their operation binding is
                        # still durable in the complete batch receipt.
                        batch_rows = tuple(
                            await session.execute(
                                select(
                                    MutationBatch.batch_id,
                                    MutationBatch.state,
                                    MutationBatch.result_json,
                                ).where(MutationBatch.result_json.is_not(None))
                            )
                        )
                        for batch_row in batch_rows:
                            try:
                                persisted = json.loads(batch_row.result_json or "")
                                persisted_items = (
                                    *persisted["applied"],
                                    *persisted["rejected"],
                                )
                                persisted_ids = {
                                    item["operation_id"]
                                    for item in persisted_items
                                    if isinstance(item, dict)
                                }
                            except (KeyError, TypeError, ValueError, json.JSONDecodeError):
                                continue
                            for operation_id in unresolved_ids & persisted_ids:
                                binding = (
                                    batch_row.batch_id,
                                    MutationState(batch_row.state),
                                )
                                previous = rows.get(operation_id)
                                if previous is not None and previous != binding:
                                    ambiguous_ids.add(operation_id)
                                else:
                                    rows[operation_id] = binding
                    batch_ids = {row.batch_id for row in operation_rows}
                    batch_ids.update(
                        rows[operation_id][0]
                        for operation_id in unresolved_ids
                        if operation_id in rows
                    )
                    child_rows = tuple(
                        await session.execute(
                            select(
                                MutationOperation.operation_id,
                                MutationOperation.batch_id,
                                MutationOperation.sequence,
                            ).where(MutationOperation.batch_id.in_(batch_ids))
                        )
                    ) if batch_ids else ()
                    batch_children: dict[str, dict[str, int]] = {}
                    for row in child_rows:
                        batch_children.setdefault(row.batch_id, {})[row.operation_id] = row.sequence
            results: list[OperationQueryItem] = []
            journal = MutationJournal(self.scope.session_factory)
            terminal_batch_ids = {
                batch_id
                for batch_id, state in rows.values()
                if state in {MutationState.FINALIZED, MutationState.ABORTED, MutationState.COMPENSATED}
            }
            terminal_results: dict[str, PushResult] = {}
            terminal_failures: set[str] = set()
            for batch_id in terminal_batch_ids:
                try:
                    batch = await journal.find_batch(batch_id)
                    if batch is None or batch.batch_id != batch_id:
                        raise IllegalMutationTransition("terminal batch receipt is missing")
                    hydrated = await journal.hydrate_result(batch.result)
                    _assert_complete_batch_receipt(
                        hydrated,
                        child_sequences=batch_children.get(batch_id, {}),
                        accepted_count=batch.accepted_count,
                    )
                    terminal_results[batch_id] = _batch_push_result(hydrated)
                except (
                    IllegalMutationTransition,
                    SpaceRecoveryRequiredError,
                    TypeError,
                    ValueError,
                    KeyError,
                ):
                    terminal_failures.add(batch_id)
            for operation_id in operation_ids:
                binding = rows.get(operation_id)
                if binding is None:
                    results.append(OperationQueryItem(operation_id, "unknown"))
                    continue
                batch_id, state = binding
                if operation_id in ambiguous_ids:
                    results.append(OperationQueryItem(operation_id, "recovery_required", batch_id))
                    continue
                if state in {MutationState.FINALIZED, MutationState.ABORTED, MutationState.COMPENSATED}:
                    if batch_id in terminal_failures:
                        results.append(OperationQueryItem(operation_id, "recovery_required", batch_id))
                        continue
                    try:
                        result = terminal_results[batch_id]
                        result_ids = {
                            *(item.operation_id for item in result.applied),
                            *(item.operation_id for item in result.conflicts),
                            *(item.operation_id for item in result.errors),
                        }
                        if operation_id not in result_ids:
                            raise IllegalMutationTransition(
                                "terminal batch receipt does not cover queried operation"
                            )
                    except (IllegalMutationTransition, TypeError, ValueError, KeyError):
                        results.append(
                            OperationQueryItem(operation_id, "recovery_required", batch_id)
                        )
                    else:
                        results.append(
                            OperationQueryItem(operation_id, "terminal", batch_id, result)
                        )
                elif state is MutationState.FAILED_MANUAL:
                    results.append(OperationQueryItem(operation_id, "recovery_required", batch_id))
                else:
                    results.append(OperationQueryItem(operation_id, "pending", batch_id))
            return OperationQueryResult(tuple(results))

    async def push(
        self, client_id: str, events: list[SyncEventInput] | tuple[SyncEventInput, ...], batch_id: str
    ) -> PushResult:
        from app.settings import settings

        client_id, batch_id, parsed_events = validate_sync_push_inputs(
            client_id,
            batch_id,
            events,
            max_event_bytes=settings.sync_event_payload_max_bytes,
            max_batch_bytes=settings.sync_canonical_batch_max_bytes,
        )
        mapped: MappedSyncBatch = self.mapper.partition(self.scope, parsed_events)
        registration = await self._register(client_id)
        if registration.requires_recovery:
            raise SyncCursorExpiredError(recovery_action="full_recovery")
        if self.uow is None:
            raise RuntimeError("SyncProtocol requires a MutationUnitOfWork")
        outcome = await self.uow.execute_prepared_batch(self.scope, mapped.items, batch_id)
        return PushResult.from_uow(batch_id, parsed_events, outcome.applied, outcome.rejected)

    async def pull(self, client_id: str, opaque_cursor: str | None, limit: int) -> PullPage:
        client_id = validate_client_id(client_id)
        if opaque_cursor is not None:
            validate_cursor_token(opaque_cursor)
        limit = validate_pull_limit(limit)
        async with self._exclusive("sync-pull") as lease:
            await self._recover(lease)
            pending: AppError | None = None
            page: PullPage | None = None
            async with self.scope.session_factory() as session:
                async with session.begin():
                    registry = SyncClientRegistry(
                        session,
                        catalog_hash=self.catalog.hash,
                        ttl_days=self.ttl_days,
                        space_id=_space_id(self.scope),
                    )
                    registration = await registry.register_or_touch(client_id)
                    if registration.requires_recovery:
                        pending = SyncCursorExpiredError(recovery_action="full_recovery")
                    else:
                        try:
                            position = (
                                self.cursor.decode(opaque_cursor)
                                if opaque_cursor is not None
                                else CursorPosition(
                                    0,
                                    self.catalog.hash,
                                    _space_id(self.scope),
                                    client_id,
                                    registration.recovery_generation,
                                )
                            )
                        except AppError as exc:
                            pending = exc
                        if pending is None and (
                            position.catalog_hash != self.catalog.hash
                            or position.space_id != _space_id(self.scope)
                            or position.client_id != client_id
                            or position.generation != registration.recovery_generation
                        ):
                            pending = SyncCursorExpiredError(recovery_action="full_recovery")
                        retention_floor = await get_retention_floor(session)
                        current_cursor = await get_current_cursor(session)
                        if pending is None and position.sequence < retention_floor:
                            pending = SyncCursorExpiredError(recovery_action="full_recovery")
                        if pending is None and position.sequence > current_cursor:
                            pending = SyncCursorExpiredError(recovery_action="full_recovery")
                        if pending is None:
                            envelope = PullPageEnvelope(
                                self.cursor,
                                self.catalog.hash,
                                _space_id(self.scope),
                                client_id,
                                registration.recovery_generation,
                            )
                            page = (
                                await read_visible_event_page_bounded(
                                    session,
                                    after_sequence=position.sequence,
                                    max_events=limit,
                                    page_envelope=envelope,
                                )
                            ).page
            if pending is not None:
                raise pending
            if page is None:
                raise RuntimeError("sync pull did not produce a page")
            return page

    async def ack(self, client_id: str, cursor: str) -> AckResult:
        client_id = validate_client_id(client_id)
        validate_cursor_token(cursor)
        async with self._exclusive("sync-ack") as lease:
            await self._recover(lease)
            decision: AckDecision | None = None
            async with self.scope.session_factory() as session:
                async with session.begin():
                    position = self.cursor.decode(cursor)
                    registry = SyncClientRegistry(
                        session,
                        catalog_hash=self.catalog.hash,
                        ttl_days=self.ttl_days,
                        space_id=_space_id(self.scope),
                    )
                    decision = await registry.acknowledge(client_id, position)
            if decision is None:
                raise RuntimeError("ACK did not produce a decision")
            if decision.error is not None:
                raise decision.error
            if decision.result is None:
                raise RuntimeError("ACK decision did not contain a result")
            return decision.result

    async def recover(
        self, client_id: str, page_token: str | None = None
    ) -> RecoveryPage:
        """Create or resume one manifest-bound bounded full-recovery page."""
        client_id = validate_client_id(client_id)
        if page_token is not None:
            validate_page_token(page_token)
        pending: AppError | None = None
        page = None
        async with self._exclusive("sync-recovery") as lease:
            await self._recover(lease)
            async with self.scope.session_factory() as session:
                async with session.begin():
                    registry = SyncClientRegistry(
                        session,
                        catalog_hash=self.catalog.hash,
                        ttl_days=self.ttl_days,
                        space_id=_space_id(self.scope),
                    )
                    await registry.expire_inactive()
                    await registry.register_or_touch(client_id)
                    await registry.collect_expired_recovery()
                    snapshots = SyncSnapshotStore(
                        session,
                        self.catalog,
                        self.page_tokens,
                        self.snapshot_serializer,
                        cursor=self.cursor,
                        ttl_days=self.ttl_days,
                    )
                    if page_token is None:
                        created = await snapshots.create(self.scope, lease, client_id)
                        if created.error is not None:
                            pending = created.error
                        else:
                            assert created.descriptor is not None
                            decision = await snapshots.page(
                                self.scope,
                                lease,
                                client_id,
                                created.descriptor.first_page_token,
                            )
                            page, pending = decision.page, decision.error
                    else:
                        decision = await snapshots.page(self.scope, lease, client_id, page_token)
                        page, pending = decision.page, decision.error
        if pending is not None:
            raise pending
        if page is None:
            raise RuntimeError("sync recovery did not produce a page")
        return page

    async def status(self, client_id: str | None = None) -> SyncStatusResult:
        if client_id is not None:
            client_id = validate_client_id(client_id)
        global_lease = getattr(self.scope, "global_lease", None)
        if global_lease is None:
            raise LeaseOrderError("sync status requires a Global-shared read handle")
        global_lease.assert_active_owner(mode=LeaseMode.SHARED, scope="global")
        space_lease = getattr(self.scope, "space_lease", None)
        if space_lease is None:
            raise LeaseOrderError("sync status requires a Space-shared read handle")
        space_lease.assert_active_owner(
            mode=LeaseMode.SHARED,
            scope=_space_id(self.scope),
        )
        async with self.scope.session_factory() as session:
            visible_count = await session.scalar(
                select(func.count()).select_from(SyncOutbox).where(SyncOutbox.visible.is_(True))
            )
            now = _now_utc()
            active_count = await session.scalar(
                select(func.count()).select_from(SyncClient).where(
                    SyncClient.expires_at > now,
                    SyncClient.requires_recovery.is_(False),
                )
            )
            recovery_count = await session.scalar(
                select(func.count()).select_from(SyncClient).where(
                    SyncClient.expires_at > now,
                    SyncClient.requires_recovery.is_(True),
                )
            )
            row = await session.get(SyncClient, client_id) if client_id is not None else None
            return SyncStatusResult(
                self.catalog.hash,
                client_id,
                row is not None,
                None if row is None else row.requires_recovery,
                "full_recovery" if row is not None and row.requires_recovery else None,
                int(visible_count or 0),
                int(active_count or 0),
                int(recovery_count or 0),
            )


@asynccontextmanager
async def protocol_for_call(
    services: RuntimeServices,
    principal: Principal,
    space_id: str,
    operation_name: SyncOperationName,
) -> AsyncIterator[SyncProtocol]:
    """Open exactly one catalog-authorized runtime handle for a Sync call."""
    spec = SYNC_OPERATION_BY_NAME[operation_name]
    handle = await services.scope.open(principal, space_id, spec.runtime_mode)
    async with handle:
        yield SyncProtocol(handle, services.mutation_uow, catalog=services.catalog)


__all__ = [
    "BoundedPullPage",
    "SyncProtocol",
    "protocol_for_call",
    "read_visible_event_page_bounded",
]
