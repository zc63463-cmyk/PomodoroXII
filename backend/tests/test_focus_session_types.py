"""双体系兼容（2026-09-16）：番茄钟模式 × 任务空间事实的合同测试。

覆盖四件事：
1. 休息型会话（short_break / long_break）能走完整离线 sync 链落库；
2. 休息型的时长口径：focused_seconds 恒 0、break_seconds 承载净时长、
   review_state 保持 not_required（免复盘）；
3. 休息型不承接三级计划（计划行 create 与在线命令都被拒）；
4. session_type 创建后不可变；非法枚举值 fail-closed。
外加：投入投影对休息型零贡献（第二道防线，防绕过时钟推导的写路径）。
"""

from __future__ import annotations

import pytest

from app.focus_session.effort_projection import EffortProjectionCompiler
from app.focus_session.policy import FocusSessionMutationPolicy
from app.sync.contracts import SyncEventInput
from app.sync.protocol import SyncProtocol

STARTED = "2026-09-16T08:00:00.000Z"
PAUSED = "2026-09-16T08:05:00.000Z"
RESUMED = "2026-09-16T08:06:00.000Z"
ENDED = "2026-09-16T08:10:00.000Z"
SESSION_ID = "fs-break-1"
OPERATION_ID = "op-break-import"


def _locator_reader(_scope, request):
    payload = request.payload
    return {
        "state": "claiming",
        "space_id": payload.get("space_id", "space-test"),
        "session_id": payload.get("session_id", request.entity_id),
        "operation_id": payload.get("command_id", request.entity_id),
        "owner_device_id": payload.get("owner_device_id"),
        "owner_tab_id": payload.get("owner_tab_id"),
        "ownership_epoch": payload.get("ownership_epoch"),
    }


def _session_row(
    *,
    session_type: str = "short_break",
    ended_at=None,
    pause_started_at=None,
    gross_seconds=0,
    paused_seconds=0,
    break_seconds=0,
    focused_seconds=0,
    updated_at=STARTED,
    validity="pending",
    review_state="not_required",
    timer_completion=None,
    version=0,
    session_revision=1,
):
    return {
        "id": SESSION_ID,
        "created_at": STARTED,
        "updated_at": updated_at,
        "version": version,
        "session_revision": session_revision,
        "session_type": session_type,
        "started_at": STARTED,
        "ended_at": ended_at,
        "pause_started_at": pause_started_at,
        "planned_seconds": 300,
        "gross_seconds": gross_seconds,
        "paused_seconds": paused_seconds,
        "break_seconds": break_seconds,
        "focused_seconds": focused_seconds,
        "timer_completion": timer_completion,
        "validity": validity,
        "validity_reason": None,
        "overall_progress": None,
        "mood": None,
        "session_note": "",
        "review_state": review_state,
        "ownership_state": "local_provisional",
    }


def _context_row():
    return {
        "id": f"ctx-{SESSION_ID}",
        "created_at": STARTED,
        "updated_at": STARTED,
        "version": 0,
        "session_id": SESSION_ID,
        "project_id": "proj-1",
        "level2_work_item_id": "l2-a",
        "title_snapshot": "Level 2",
        "parent_snapshot": None,
        "estimate_snapshot": None,
        "status_snapshot": None,
        "structure_snapshot": "{}",
        "linked_at": STARTED,
        "link_method": "manual",
    }


def _attribution_row():
    return {
        "id": f"attr-{SESSION_ID}-1",
        "created_at": STARTED,
        "updated_at": STARTED,
        "version": 0,
        "session_id": SESSION_ID,
        "revision": 1,
        "project_id": "proj-1",
        "level2_work_item_id": "l2-a",
        "reason": None,
        "corrected_from_revision": None,
        "effective": True,
    }


def _create_events(session_row=None):
    return [
        SyncEventInput(
            entity_type="focusSession",
            entity_id=SESSION_ID,
            action="create",
            payload=session_row or _session_row(),
            expected_version=None,
            client_updated_at=STARTED,
            operation_id=f"{OPERATION_ID}:fs",
        ),
        SyncEventInput(
            entity_type="sessionTaskContext",
            entity_id=f"ctx-{SESSION_ID}",
            action="create",
            payload=_context_row(),
            expected_version=None,
            client_updated_at=STARTED,
            operation_id=f"{OPERATION_ID}:ctx",
        ),
        SyncEventInput(
            entity_type="sessionAttributionRevision",
            entity_id=f"attr-{SESSION_ID}-1",
            action="create",
            payload=_attribution_row(),
            expected_version=None,
            client_updated_at=STARTED,
            operation_id=f"{OPERATION_ID}:attr",
        ),
    ]


def _clock_events():
    """休息型离线时钟链：暂停 → 继续 → 结束。

    break_seconds 逐帧等于 gross - paused（客户端与服务端同一口径）；
    focused_seconds 恒 0；review_state 全程 not_required（免复盘）。
    """
    pause = _session_row(
        pause_started_at=PAUSED,
        gross_seconds=300,
        paused_seconds=0,
        break_seconds=300,
        focused_seconds=0,
        updated_at=PAUSED,
        version=1,
        session_revision=2,
    )
    resume = _session_row(
        pause_started_at=None,
        gross_seconds=360,
        paused_seconds=60,
        break_seconds=300,
        focused_seconds=0,
        updated_at=RESUMED,
        version=2,
        session_revision=3,
    )
    end = _session_row(
        ended_at=ENDED,
        pause_started_at=None,
        gross_seconds=600,
        paused_seconds=60,
        break_seconds=540,
        focused_seconds=0,
        updated_at=ENDED,
        validity="valid",
        review_state="not_required",
        timer_completion="completed",
        version=3,
        session_revision=4,
    )
    return [
        SyncEventInput(
            entity_type="focusSession",
            entity_id=SESSION_ID,
            action="update",
            payload=pause,
            expected_version=1,
            client_updated_at=PAUSED,
            operation_id=f"{OPERATION_ID}:pause",
        ),
        SyncEventInput(
            entity_type="focusSession",
            entity_id=SESSION_ID,
            action="update",
            payload=resume,
            expected_version=2,
            client_updated_at=RESUMED,
            operation_id=f"{OPERATION_ID}:resume",
        ),
        SyncEventInput(
            entity_type="focusSession",
            entity_id=SESSION_ID,
            action="update",
            payload=end,
            expected_version=3,
            client_updated_at=ENDED,
            operation_id=f"{OPERATION_ID}:end",
        ),
    ]


async def _register_client(mutation, client_id: str) -> None:
    from app.models.sync_client import SyncClient

    async with mutation._sessions.begin() as session:
        session.add(
            SyncClient(
                client_id=client_id,
                ack_sequence=0,
                catalog_hash=mutation.catalog.hash,
                registered_at=STARTED,
                last_seen_at=STARTED,
                expires_at="2099-09-16T00:00:00.000Z",
                requires_recovery=False,
                recovery_generation=0,
            )
        )


def _break_policy_fixture(mutation_fixture_factory):
    policy = FocusSessionMutationPolicy(locator_reader=_locator_reader)
    return mutation_fixture_factory(policies=(policy,))


@pytest.mark.asyncio
async def test_offline_break_clock_chain_lands_with_zero_focus(
    mutation_fixture_factory,
) -> None:
    """休息型走完整离线链：净时长进 break_seconds，投入恒 0，免复盘。"""
    from sqlalchemy import select

    from app.models.focus_session import FocusSession

    mutation = _break_policy_fixture(mutation_fixture_factory)
    await _register_client(mutation, "client-break")
    protocol = SyncProtocol(mutation.scope, mutation.uow, catalog=mutation.catalog)

    created = await protocol.push(
        "client-break", _create_events(), f"batch-{OPERATION_ID}-create",
    )
    assert created.errors == ()

    updated = await protocol.push(
        "client-break", _clock_events(), f"batch-{OPERATION_ID}-clock",
    )
    assert updated.errors == ()
    assert [item.operation_id for item in updated.applied] == [
        f"{OPERATION_ID}:pause",
        f"{OPERATION_ID}:resume",
        f"{OPERATION_ID}:end",
    ]

    async with mutation._sessions() as session:
        row = (
            await session.execute(
                select(FocusSession).where(FocusSession.id == SESSION_ID)
            )
        ).scalar_one_or_none()
    assert row is not None
    assert row.session_type == "short_break"
    assert row.ended_at == ENDED
    assert row.focused_seconds == 0
    assert row.break_seconds == 540
    assert row.review_state == "not_required"


@pytest.mark.asyncio
async def test_work_session_without_type_keeps_legacy_semantics(
    mutation_fixture_factory,
) -> None:
    """不带 session_type 的旧载荷逐字保持 work 语义（默认补齐）。"""
    from sqlalchemy import select

    from app.models.focus_session import FocusSession

    mutation = _break_policy_fixture(mutation_fixture_factory)
    await _register_client(mutation, "client-legacy")
    protocol = SyncProtocol(mutation.scope, mutation.uow, catalog=mutation.catalog)

    legacy = _session_row(session_type="work")
    legacy.pop("session_type")
    created = await protocol.push(
        "client-legacy", _create_events(legacy), f"batch-{OPERATION_ID}-legacy",
    )
    assert created.errors == ()

    async with mutation._sessions() as session:
        row = (
            await session.execute(
                select(FocusSession).where(FocusSession.id == SESSION_ID)
            )
        ).scalar_one_or_none()
    assert row is not None
    assert row.session_type == "work"


@pytest.mark.asyncio
async def test_unknown_session_type_is_rejected(mutation_fixture_factory) -> None:
    """非法枚举 fail-closed：schema/policy 双重校验，绝不静默落 work。"""
    mutation = _break_policy_fixture(mutation_fixture_factory)
    await _register_client(mutation, "client-bad-type")
    protocol = SyncProtocol(mutation.scope, mutation.uow, catalog=mutation.catalog)

    bad = _session_row(session_type="nap")
    result = await protocol.push(
        "client-bad-type", _create_events(bad), f"batch-{OPERATION_ID}-bad",
    )
    assert result.applied == ()
    # 批次里会话本体被拒后，其子实体（context / attribution）会因会话不存在
    # 连锁 not_found —— 断言会话本体这一条是目标错误码即可。
    session_errors = [
        error for error in result.errors if error.operation_id == f"{OPERATION_ID}:fs"
    ]
    assert len(session_errors) == 1
    assert session_errors[0].code == "work_item_structure_changed"
    assert session_errors[0].details["reason"] == "invalid_session_type"


@pytest.mark.asyncio
async def test_session_type_is_immutable_through_sync(mutation_fixture_factory) -> None:
    """session_type 是创建后不可变事实：sync 更新改它一律被拒。"""
    mutation = _break_policy_fixture(mutation_fixture_factory)
    await _register_client(mutation, "client-immutable")
    protocol = SyncProtocol(mutation.scope, mutation.uow, catalog=mutation.catalog)
    assert (
        await protocol.push(
            "client-immutable", _create_events(), f"batch-{OPERATION_ID}-create2",
        )
    ).errors == ()

    flip = _session_row(
        session_type="work",
        updated_at=PAUSED,
        version=1,
        session_revision=2,
    )
    result = await protocol.push(
        "client-immutable",
        [
            SyncEventInput(
                entity_type="focusSession",
                entity_id=SESSION_ID,
                action="update",
                payload=flip,
                expected_version=1,
                client_updated_at=PAUSED,
                operation_id=f"{OPERATION_ID}:flip",
            )
        ],
        f"batch-{OPERATION_ID}-flip",
    )
    assert result.applied == ()
    assert len(result.errors) == 1
    assert result.errors[0].details["reason"] == "session_immutable_field"


@pytest.mark.asyncio
async def test_break_session_rejects_plan_rows(mutation_fixture_factory) -> None:
    """休息型不承接三级计划：计划行 create 被拒（事实边界）。"""
    mutation = _break_policy_fixture(mutation_fixture_factory)
    await _register_client(mutation, "client-plan")
    protocol = SyncProtocol(mutation.scope, mutation.uow, catalog=mutation.catalog)
    assert (
        await protocol.push(
            "client-plan", _create_events(), f"batch-{OPERATION_ID}-create3",
        )
    ).errors == ()

    plan_row = {
        "id": "plan-break-1",
        "created_at": STARTED,
        "updated_at": STARTED,
        "version": 0,
        "session_id": SESSION_ID,
        "work_item_id": "l3-a",
        "title_snapshot": "Level 3",
        "level2_snapshot": "l2-a",
        "work_item_version_snapshot": 0,
        "plan_rank": 0,
        "source": "before_start",
        "added_at": STARTED,
        "removed_at": None,
        "removal_reason": None,
        "current_during_session": True,
        "completion_draft": False,
    }
    result = await protocol.push(
        "client-plan",
        [
            SyncEventInput(
                entity_type="sessionWorkItemPlan",
                entity_id="plan-break-1",
                action="create",
                payload=plan_row,
                expected_version=None,
                client_updated_at=STARTED,
                operation_id=f"{OPERATION_ID}:plan",
            )
        ],
        f"batch-{OPERATION_ID}-plan",
    )
    assert result.applied == ()
    assert len(result.errors) == 1
    assert result.errors[0].details["reason"] == "break_session_has_no_plan"


# --------------------------------------------------------------------------- #
# 投入投影：休息型零贡献（第二道防线）
# --------------------------------------------------------------------------- #


class _Overlay:
    """最小只读 overlay：只实现 _compute_effort_map 需要的两种读取。"""

    def __init__(self, sessions, attributions, work_items):
        self._sessions = list(sessions)
        self._attributions = list(attributions)
        self._work_items = {str(item["id"]): dict(item) for item in work_items}

    def rows(self, entity_type):
        if entity_type == "focus_session":
            return list(self._sessions)
        if entity_type == "session_attribution_revision":
            return list(self._attributions)
        if entity_type == "work_item":
            return list(self._work_items.values())
        return []

    def row(self, entity_type, entity_id):
        if entity_type == "work_item":
            return self._work_items.get(str(entity_id))
        if entity_type == "focus_session":
            return next(
                (item for item in self._sessions if str(item.get("id")) == str(entity_id)),
                None,
            )
        return None


def _effort_overlay(*sessions) -> _Overlay:
    work_items = [
        {"id": "l1-a", "parent_id": None, "project_id": "proj-1"},
        {"id": "l2-a", "parent_id": "l1-a", "project_id": "proj-1"},
    ]
    attributions = [
        {
            "id": f"attr-{session['id']}-1",
            "session_id": session["id"],
            "revision": 1,
            "project_id": "proj-1",
            "level2_work_item_id": "l2-a",
            "effective": True,
        }
        for session in sessions
    ]
    return _Overlay(sessions, attributions, work_items)


def _ended_session(session_id: str, *, session_type: str, focused_seconds: int):
    return {
        "id": session_id,
        "session_type": session_type,
        "started_at": STARTED,
        "ended_at": ENDED,
        "validity": "valid",
        "ownership_state": "authoritative",
        "focused_seconds": focused_seconds,
    }


def test_break_sessions_never_contribute_effort() -> None:
    """即使有人绕过时钟推导给休息型塞了 focused_seconds，投入仍为 0。"""
    overlay = _effort_overlay(
        _ended_session("fs-work", session_type="work", focused_seconds=1200),
        _ended_session("fs-break", session_type="short_break", focused_seconds=999),
        _ended_session("fs-long-break", session_type="long_break", focused_seconds=999),
        _ended_session("fs-free", session_type="free", focused_seconds=300),
    )
    effort = EffortProjectionCompiler.compute_effort_for_all(overlay)
    assert effort == {"l2-a": 1500}


def test_legacy_sessions_without_type_still_contribute() -> None:
    """缺 session_type 的存量会话按 work 解释（默认口径不丢投入）。"""
    legacy = _ended_session("fs-legacy", session_type="work", focused_seconds=600)
    legacy.pop("session_type")
    overlay = _effort_overlay(legacy)
    assert EffortProjectionCompiler.compute_effort_for_all(overlay) == {"l2-a": 600}


# --------------------------------------------------------------------------- #
# 入站 wire 兼容：只在显式携带时进入业务载荷（旧载荷 payload hash 逐字不变）
# --------------------------------------------------------------------------- #

_START_BASE = {
    "level2WorkItemId": "wi-l2",
    "level3WorkItemIds": [],
    "plannedSeconds": 1500,
    "startedAt": "2026-09-16T08:00:00.000Z",
    "ownerDeviceId": "device-1",
    "ownerTabId": "tab-1",
    "expectedWorkItemVersions": {"wi-l2": 1},
}


def test_start_wire_payload_carries_session_type_only_when_sent() -> None:
    """启动路由的载荷映射：不带 → 业务载荷与旧口径逐字一致（hash 不变）；
    带 → 显式进入业务载荷（客户端与服务端两侧同口径）。"""
    from app.mutation.types import canonical_payload_hash
    from app.routes.v1.active_session import _map_start_payload
    from app.schemas.focus_session import StartActiveSessionPayload

    legacy = _map_start_payload(StartActiveSessionPayload.model_validate(_START_BASE))
    assert "session_type" not in legacy
    legacy_hash = canonical_payload_hash({
        key: value for key, value in legacy.items()
        if key != "expected_work_item_versions"  # hash guard（见 focus_business_payload）
    })

    with_mode = _map_start_payload(StartActiveSessionPayload.model_validate(
        {**_START_BASE, "sessionType": "short_break"}
    ))
    assert with_mode["session_type"] == "short_break"
    mode_hash = canonical_payload_hash({
        key: value for key, value in with_mode.items()
        if key != "expected_work_item_versions"
    })
    assert mode_hash != legacy_hash


def test_provisional_snapshot_carries_session_type_only_when_sent() -> None:
    """离线激活快照同理：缺省不写键（旧客户端 hash 兼容）；显式携带时进入载荷。"""
    from app.routes.v1.active_session import _map_session_snapshot
    from app.schemas.focus_session import ProvisionalSessionSnapshot

    base = {
        "sessionRevision": 1,
        "startedAt": "2026-09-16T08:00:00.000Z",
        "pauseStartedAt": None,
        "plannedSeconds": 300,
        "grossSeconds": 0,
        "pausedSeconds": 0,
        "breakSeconds": 0,
        "focusedSeconds": 0,
        "validity": "pending",
        "validityReason": None,
        "reviewState": "not_required",
        "ownershipState": "local_provisional",
        "sessionNote": "",
    }
    assert "session_type" not in _map_session_snapshot(
        ProvisionalSessionSnapshot.model_validate(base)
    )
    carried = _map_session_snapshot(ProvisionalSessionSnapshot.model_validate(
        {**base, "sessionType": "long_break"}
    ))
    assert carried["session_type"] == "long_break"
