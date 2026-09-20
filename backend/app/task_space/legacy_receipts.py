"""TS-02a upgrade compatibility: address the receipt of a *legacy* single-label DELETE.

缺陷一（收口复核补充第 2 节）的成因
----------------------------------
TS-02a（bbf528a）把单标签 ``DELETE /work-items/{id}/labels/{label_id}`` 的 URL
寻址约束 ``require_removed_label_ids`` 提升为**命令契约的一部分**：

- ``app/task_space/module.py::_business_payload``（98-106）把它并入 canonical
  业务载荷，于是它进入客户端声明的 ``payloadHash`` 校验对象；
- ``build_task_space_request``（199-213）把整个命令 ``payload`` 写进
  ``MutationRequest.payload``，于是它也进入 ``request_hash``。

升级前（ae1685d）落盘的旧请求，业务载荷只有 ``{"label_ids": [...]}``。同一份
body/URL/header 在新路由下重放时，``require_payload_hash`` 立刻抛
``InvalidPayloadHashError`` —— 失败点**早于** ``_resume_or_return``，因此旧设备
在升级后永远拿不回自己已经持久化的终态回执。

本模块给出的是「仅回执兼容路径」，它**不**放宽任何新请求的校验：

1. **不跳过 hash 校验**：兼容路径自身做的校验比新规则只多不少 —— 从持久 journal
   还原原请求逐字（``decode_persisted_command`` 自校验 canonical 字节），按旧规则
   重算 canonical ``request_hash``，再用 ``hmac.compare_digest`` 与
   ``MutationBatch.command_hash`` 比对；同时逐字比对 commandId / spaceId /
   entityId / expectedVersion / 声明 payloadHash。
2. **不重编译**：命中的记录已经是终态，回执从 ``MutationBatch.result_json``
   （经 ``journal.hydrate_result`` 取 operation 的持久镜像）读回，不调用编译器，
   不落库，不写账本。
3. **不伪造回执**：只返回已持久结果的原样 hydrate；没有任何「补写一条」的路径。
4. **未知 / 非终态一律 fail-closed**：沿用既有闭集码
   ``invalid_payload_hash``(422) 与 ``command_result_unknown``(503, retryable)，
   不新增错误码（``app/errors.py`` 的闭集与
   ``tests/test_focus_session_contracts.py`` 的逐字列举因此保持不变）。

版本边界（可观察、可删除）
--------------------------
兼容路径**只在**「新规则校验失败 + 持久 journal 中存在同一 commandId 的旧规则
终态记录」时触发。触发次数可观测：模块级 ``_legacy_hits`` 计数器（每次成功返回
旧回执 +1），用于确认「旧请求已全部收敛」后整体删除本模块；命中为 0 即无引用。
``MutationBatch`` 的记录本身没有版本标记列（``app/models/mutation.py``），因此
版本边界以**持久载荷中不存在 ``require_removed_label_ids``** 作为「旧规则落盘」
的离线证据，而不是靠新增列或猜测。
"""
from __future__ import annotations

import hashlib
import hmac
from collections.abc import Mapping
from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.models.mutation import MutationBatch, MutationOperation
from app.mutation.journal import MutationJournal
from app.mutation.types import (
    BatchMutationResult,
    MutationRequest,
    MutationState,
    canonical_request_bytes,
    decode_persisted_command,
    require_frozen_object,
)
from app.runtime.space import SpaceRuntimeHandle

#: The address-constraint key TS-02a introduced. Its **absence** from a persisted
#: payload is the offline evidence that the record was written under the old rule.
ADDRESS_CONSTRAINT_KEY = "require_removed_label_ids"

#: The single request name this compatibility path serves.
LEGACY_REQUEST_NAME = "task_space.RemoveWorkItemLabels"

#: Terminal states whose receipt may be handed back (same set as
#: ``MutationUnitOfWork._resume_or_return`` refuses to go below).
_TERMINAL_STATES = (MutationState.FINALIZED, MutationState.ABORTED)

#: Successful legacy-receipt returns since process start. Zero hits over a
#: release window is the documented signal that this module can be deleted.
_legacy_hits = 0

#: Replays that proved a legacy identity but could not be answered from a
#: terminal receipt (crash window / unusable receipt). Counted separately from
#: ``_legacy_hits`` because these are the operations an operator must chase.
_legacy_pending = 0


def legacy_hit_count() -> int:
    """Return how many legacy receipts this process has handed back."""
    return _legacy_hits


def legacy_pending_recovery_count() -> int:
    """Replays whose legacy identity matched but whose receipt was not terminal.

    A non-zero value means a pre-upgrade request is stuck in a crash window and
    needs the ordinary Space recovery to run before it can be answered; the
    client's rejection carries ``REASON_PENDING_RECOVERY`` so it can be told
    apart from a genuinely corrupt payload.
    """
    return _legacy_pending


#: ``details.reason`` values for the fail-closed rejection. The HTTP code stays
#: the closed-set ``invalid_payload_hash`` (no new code), but the reason string
#: is what makes one fail-closed path distinguishable from another in logs.
REASON_HASH_MISMATCH = "payload hash does not match canonical payload"
REASON_PENDING_RECOVERY = (
    "a legacy receipt exists for this command but is not terminal; "
    "space recovery must complete before it can be replayed"
)


@dataclass(frozen=True, slots=True)
class LegacyReceiptOutcome:
    """Why a legacy lookup did not produce a usable receipt.

    Returned instead of a bare ``None`` so a non-terminal record (crash window)
    is *observable* to the caller — mirroring the ``SpaceRecoveryRequiredError``
    that ``MutationUnitOfWork._resume_or_return`` raises for the same condition.
    A silent ``None`` would make "operation crashed mid-flight" and "payload was
    tampered with" return byte-identical rejections, which is exactly the
    diagnosis gap the review flagged.
    """

    #: ``pending_recovery`` when the identity matched but the record is not
    #: terminal; ``no_match`` for every other miss.
    kind: str
    #: Operator-facing reason string, safe to surface in ``details``.
    reason: str
    #: The persisted state when it was the blocker (``None`` otherwise).
    batch_state: MutationState | None = None

    @property
    def pending_recovery(self) -> bool:
        return self.kind == "pending_recovery"


@dataclass(frozen=True, slots=True)
class LegacyReceiptContext:
    """Everything the predicate needs, all of it server-persisted.

    ``request`` is declared as :class:`MutationRequest` so its own
    ``__post_init__`` re-verifies ``request_hash`` against the canonical bytes
    (``app/mutation/types.py`` 344-352) before any comparison happens.
    """

    command_id: str
    space_id: str
    work_item_id: str
    expected_version: int
    declared_payload_hash: str
    batch_id: str
    request: MutationRequest
    #: The request hash the journal stored for this operation (decoded from
    #: ``command_json``), i.e. the identity a replay must match byte for byte.
    request_hash: str
    #: ``MutationBatch.command_hash`` — the batch identity hash
    #: (``hash_prepared_batch_identity``), NOT the request hash. Kept only so the
    #: hydration step can re-assert the same batch identity the UoW would.
    batch_identity_hash: str
    batch_state: MutationState
    batch_result_json: str | None


class LegacyLabelReceiptResolver:
    """Read-only resolver for pre-TS-02a single-label DELETE receipts.

    Deliberately *not* part of ``MutationUnitOfWork._resume_or_return``: that
    function is the cross-domain idempotency invariant ("hash differs => 409"),
    and a Task-Space-only special case there would leak this口径 into every
    other domain and into the recovery path. This resolver sits between the
    route and the command module instead.
    """

    def __init__(self, session_factory: async_sessionmaker[AsyncSession]) -> None:
        self._sessions = session_factory
        self._journal = MutationJournal(session_factory)

    async def load_identity(
        self,
        *,
        command_id: str,
        work_item_id: str,
        declared_payload_hash: str,
        expected_version: int,
        declared_label_ids: list[str],
    ) -> LegacyReceiptContext | None:
        """Return the verified persisted identity, or ``None`` for a non-match.

        ``None`` means "not a legacy request we can prove" — the caller must then
        surface the ordinary fail-closed rejection. Every mismatch (unknown
        commandId, changed content, foreign request name, missing old-rule
        evidence) collapses to ``None``; none of them may 200.
        """
        return await self._load_verified_identity(
            command_id=command_id,
            work_item_id=work_item_id,
            declared_payload_hash=declared_payload_hash,
            expected_version=expected_version,
            declared_label_ids=declared_label_ids,
        )

    def space_matches(self, context: LegacyReceiptContext, scope: SpaceRuntimeHandle) -> bool:
        """Require the authorized Space to be the persisted one.

        A cross-Space hit is never a receipt match; the caller raises the closed
        ``space_scope_mismatch`` (403) exactly as the new-request path does.
        """
        authorized = getattr(getattr(scope, "scope", None), "space_id", None)
        return isinstance(authorized, str) and hmac.compare_digest(
            authorized, context.space_id
        )

    async def receipt_for(
        self, context: LegacyReceiptContext
    ) -> BatchMutationResult | LegacyReceiptOutcome:
        """Hydrate the durable receipt, or explain why it cannot be handed back.

        A non-terminal record is refused exactly as
        ``MutationUnitOfWork._resume_or_return`` refuses it (a half-written
        receipt is not the authoritative outcome), but the refusal is *reported*
        as a :class:`LegacyReceiptOutcome` rather than a silent ``None`` so a
        crash-window replay stays diagnosable.
        """
        if context.batch_state not in _TERMINAL_STATES:
            global _legacy_pending
            _legacy_pending += 1
            return LegacyReceiptOutcome(
                kind="pending_recovery",
                reason=REASON_PENDING_RECOVERY,
                batch_state=context.batch_state,
            )
        return await self._hydrated_receipt(context)

    # ----------------------------------------------------------------- #
    # identity
    # ----------------------------------------------------------------- #

    async def _load_verified_identity(
        self,
        *,
        command_id: str,
        work_item_id: str,
        declared_payload_hash: str,
        expected_version: int,
        declared_label_ids: list[str],
    ) -> LegacyReceiptContext | None:
        async with self._sessions() as session:
            row = await session.get(MutationBatch, command_id)
            if row is None:
                return None
            state = MutationState(row.state)
            batch_command_hash = row.command_hash
            result_json = row.result_json
            command_json = await session.scalar(
                select(MutationOperation.command_json).where(
                    MutationOperation.operation_id == command_id
                )
            )
        if command_json is None:
            return None
        try:
            persisted = decode_persisted_command(command_json)
        except ValueError:
            # A record we cannot decode byte-exactly is not provably this request.
            return None
        request = persisted.request

        # (1) request name: this path serves exactly one legacy wire shape.
        if request.name != LEGACY_REQUEST_NAME:
            return None
        # (2) entity binding: the URL's work item is the persisted one.
        if request.entity_id != work_item_id:
            return None
        # (3) expected version and declared business hash, verbatim.
        if request.expected_version != expected_version:
            return None
        payload = request.payload
        if not isinstance(payload, Mapping):
            return None
        if payload.get("command_id") != command_id:
            return None
        if payload.get("payload_hash") != declared_payload_hash:
            return None
        # (4) old-rule evidence, checked BEFORE trusting anything derived from it.
        if ADDRESS_CONSTRAINT_KEY in payload:
            return None
        if "label_ids" not in payload:
            return None
        persisted_label_ids = payload["label_ids"]
        if not isinstance(persisted_label_ids, (tuple, list)):
            return None
        if list(persisted_label_ids) != list(declared_label_ids):
            return None
        # (5) recompute the OLD canonical request hash from the persisted payload
        #     and compare it to the *request* hash the journal stored for this
        #     operation. Note which persisted field is which: ``MutationBatch.
        #     command_hash`` is the **batch identity** hash
        #     (``unit_of_work.hash_prepared_batch_identity`` over
        #     ``(request_index, operation_id, intent_hash)`` — journal.py writes
        #     that value into ``command_hash``), NOT the request hash. The request
        #     hash of a single command entry lives in its operation's decoded
        #     ``command_json``. Comparing against the wrong one would refuse every
        #     genuine legacy record.
        expected_request_hash = _old_rule_request_hash(request)
        if not hmac.compare_digest(request.request_hash, expected_request_hash):
            return None
        return LegacyReceiptContext(
            command_id=command_id,
            space_id=str(payload.get("space_id", "")),
            work_item_id=work_item_id,
            expected_version=expected_version,
            declared_payload_hash=declared_payload_hash,
            batch_id=command_id,
            request=request,
            batch_identity_hash=batch_command_hash,
            request_hash=request.request_hash,
            batch_state=state,
            batch_result_json=result_json,
        )

    async def _hydrated_receipt(
        self, context: LegacyReceiptContext
    ) -> BatchMutationResult | LegacyReceiptOutcome:
        if context.batch_result_json is None:
            # A terminal batch with no durable receipt cannot answer a replay.
            return LegacyReceiptOutcome(
                kind="unusable_receipt",
                reason="the legacy receipt is missing its persisted result",
            )
        try:
            found = await self._journal.find_batch(context.batch_id)
        except Exception:  # noqa: BLE001 - an unreadable receipt is a non-match
            return LegacyReceiptOutcome(
                kind="unusable_receipt",
                reason="the legacy receipt could not be read",
            )
        if found is None:
            return LegacyReceiptOutcome(
                kind="unusable_receipt",
                reason="the legacy receipt disappeared between reads",
            )
        if found.state not in _TERMINAL_STATES:
            # Raced with a concurrent writer: same diagnosis as the pre-check.
            global _legacy_pending
            _legacy_pending += 1
            return LegacyReceiptOutcome(
                kind="pending_recovery",
                reason=REASON_PENDING_RECOVERY,
                batch_state=found.state,
            )
        # Same batch identity assertion the UoW makes before returning a receipt.
        if not hmac.compare_digest(found.request_hash, context.batch_identity_hash):
            return LegacyReceiptOutcome(
                kind="no_match",
                reason="the legacy receipt identity changed between reads",
            )
        try:
            hydrated = await self._journal.hydrate_result(found.result)
        except Exception:  # noqa: BLE001 - a receipt we cannot hydrate is a non-match
            return LegacyReceiptOutcome(
                kind="unusable_receipt",
                reason="the legacy receipt could not be hydrated",
            )
        if len(hydrated.applied) != 1:
            return LegacyReceiptOutcome(
                kind="unusable_receipt",
                reason="the legacy receipt does not describe exactly one operation",
            )
        global _legacy_hits
        _legacy_hits += 1
        return hydrated


def _old_rule_request_hash(request: MutationRequest) -> str:
    """Recompute ``request_hash`` under the pre-TS-02a canonical rules.

    The address constraint is the *only* key TS-02a added to this wire shape
    (``app/schemas/task_space.py::RemoveWorkItemLabelsRequest`` has no other new
    field, and ``build_task_space_request`` copies the command payload verbatim
    except for the move-only ``child_rank``). Recomputing therefore means: take
    the persisted payload, drop that one key if it is present, and hash the
    canonical request bytes.

    Note what this is *not*: it never accepts content that differs from the
    persisted record, because the caller only reaches it after the persisted
    payload has been shown to be ``{label_ids}``-only and byte-identical to the
    replay. It also does not rewrite the stored hash — a mismatch is a non-match.
    """
    payload = dict(request.payload)
    payload.pop(ADDRESS_CONSTRAINT_KEY, None)
    frozen = require_frozen_object(payload)
    return hashlib.sha256(
        canonical_request_bytes(
            request.name,
            request.entity_type,
            request.entity_id,
            frozen,
            request.expected_version,
            request.client_updated_at,
        )
    ).hexdigest()


def legacy_payload_rejection_reason(
    outcome: LegacyReceiptOutcome | None = None,
) -> Mapping[str, object]:
    """``details`` for the fail-closed rejection — the diagnosable recovery path.

    This is **wired**: ``routes/v1/work_items.py::_legacy_receipt_outcome``
    returns it to the caller whenever a legacy lookup fails, so the rejection
    body distinguishes the two cases an operator must act on differently:

    * ``pending_recovery`` — a pre-upgrade request **was** persisted under an
      old hash rule but its record is not terminal (a crash window). The remedy
      is to let Space recovery complete and replay; the client should retry, and
      the condition is retryable in nature even though the HTTP code is the
      closed-set ``invalid_payload_hash``.
    * ``hash_mismatch`` — nothing proved this is a legacy request, so the caller
      must re-declare under the current rule.

    The remedy text tells a **stuck client to upgrade / re-declare**, never to
    hand-compute the address constraint: a pre-TS-02a client cannot derive
    ``require_removed_label_ids`` from its own state (the value is the URL
    segment the server binds, see ``routes/v1/work_items.py`` — the route injects
    it), so "just include it" would be advice the old client cannot follow.
    """
    if outcome is not None and outcome.pending_recovery:
        return {
            "reason": outcome.reason,
            "recovery": "pending_recovery",
            "retryableAfterRecovery": True,
            "batchState": (
                outcome.batch_state.value if outcome.batch_state is not None else None
            ),
            "remedy": (
                "a pre-upgrade request for this commandId is persisted but not "
                "terminal; let Space recovery finish, then replay the same "
                "commandId — do not change its payload"
            ),
        }
    if outcome is not None and outcome.kind == "unusable_receipt":
        return {
            "reason": outcome.reason,
            "recovery": "unusable_receipt",
            "retryableAfterRecovery": False,
            "remedy": (
                "the persisted receipt for this commandId could not be used; "
                "inspect the Space journal before retrying"
            ),
        }
    return {
        "reason": REASON_HASH_MISMATCH,
        "recovery": "hash_mismatch",
        "retryableAfterRecovery": False,
        "remedy": (
            "payloadHash does not cover the current command contract. Upgrade "
            "the client (or re-declare the command under the current rule) so "
            "the hash covers the full post-mutation target set including the "
            "addressed label constraint; the server binds that constraint from "
            "the request URL, so it cannot be recovered from a pre-upgrade "
            "client's local state"
        ),
    }


__all__ = [
    "ADDRESS_CONSTRAINT_KEY",
    "LEGACY_REQUEST_NAME",
    "REASON_HASH_MISMATCH",
    "REASON_PENDING_RECOVERY",
    "LegacyLabelReceiptResolver",
    "LegacyReceiptContext",
    "LegacyReceiptOutcome",
    "legacy_hit_count",
    "legacy_payload_rejection_reason",
    "legacy_pending_recovery_count",
]
