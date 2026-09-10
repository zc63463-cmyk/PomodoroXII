"""Sync scope registry + ledger type filtering (S1 of the scope-slicing plan).

★ 这些测试守护两件事：
  1. 作用域注册表与实际 registry 保持一致（双向护栏，防静默失联）
  2. 账本过滤只对**传入类型**生效，不传参与历史行为完全一致

  第 2 点里的「共用游标会被越过」那条测试是**有意记录已知限制** —— 它证明了
  为什么作用域必须配独立游标（见《同步作用域切片-实施方案-2026-09-03.md》第 1 节）。
  将来若实现了 per-scope cursor，应把那条测试改为断言「不再越过」。
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json

import pytest

from app.errors import SyncCursorExpiredError
from app.registry.builtin import REGISTRY
from app.sync import scopes
from app.sync.contracts import PullPageEnvelope
from app.sync.cursor import CursorPosition, SyncCursorCodec
from app.sync.protocol import read_visible_event_page_bounded
from tests.test_entity_invariants import entity_fixture  # noqa: F401

UTC = "2026-08-05T10:00:00.000Z"


def _registry_sync_types() -> tuple[str, ...]:
    return tuple(spec.effective_sync_entity_type for spec in REGISTRY.list_sync_enabled())


# ---------------------------------------------------------------- 注册表护栏


def test_scopes_cover_every_sync_enabled_entity() -> None:
    """★ 每个参与同步的实体都必须归属某个作用域。

    漏掉一个不会报错，只会表现为「那个域的数据永远不更新」—— 所以必须有护栏。
    """
    uncovered = scopes.uncovered_entity_types(_registry_sync_types())
    assert uncovered == (), f"未被任何作用域覆盖的实体类型：{uncovered}"


def test_scopes_contain_no_unknown_entity_types() -> None:
    """反向护栏：作用域里不能登记 registry 中不存在（或未启用同步）的类型。"""
    unknown = scopes.unknown_entity_types(_registry_sync_types())
    assert unknown == (), f"作用域登记了无效实体类型：{unknown}"


def test_every_scope_is_non_empty_and_disjoint() -> None:
    """作用域不应为空，也不应重叠 —— 重叠会让同一事件被重复投递。"""
    seen: dict[str, str] = {}
    for name in scopes.scope_names():
        types = scopes.entity_types_for_scope(name)
        assert types, f"作用域 {name} 为空"
        for entity_type in types:
            assert entity_type not in seen, (
                f"{entity_type} 同时属于 {seen[entity_type]} 与 {name}"
            )
            seen[entity_type] = name


def test_entity_types_for_scopes_merges_and_dedupes() -> None:
    merged = scopes.entity_types_for_scopes(("planning", "notes"))
    assert "schedule" in merged
    assert "note" in merged
    assert len(merged) == len(set(merged)), "展开结果不应有重复"

    single = scopes.entity_types_for_scopes(("planning",))
    assert single == scopes.entity_types_for_scope("planning")


def test_empty_or_missing_scopes_expand_to_no_filter() -> None:
    """不传 / 传空 → 空元组。调用方据此走「不过滤」的现有路径。"""
    assert scopes.entity_types_for_scopes(None) == ()
    assert scopes.entity_types_for_scopes(()) == ()
    assert scopes.entity_types_for_scopes("planning") == scopes.entity_types_for_scope(
        "planning"
    )


def test_unknown_scope_is_rejected() -> None:
    with pytest.raises(ValueError, match="unknown sync scope"):
        scopes.entity_types_for_scope("nope")
    with pytest.raises(ValueError, match="unknown sync scope"):
        scopes.entity_types_for_scopes(("planning", "nope"))


def test_scope_for_entity_type_reverse_lookup() -> None:
    assert scopes.scope_for_entity_type("schedule") == "planning"
    assert scopes.scope_for_entity_type("note") == "notes"
    assert scopes.scope_for_entity_type("noSuchType") is None


# ---------------------------------------------------------------- 账本过滤


async def test_page_reader_filters_by_entity_type(entity_fixture) -> None:  # noqa: F811
    """传入 entity_types 时只读取这些类型，游标推进到最后一条被选中的行。"""
    from app.services.sync_outbox import record_sync_event  # noqa: PLC0415

    codec = SyncCursorCodec(b"scope-filter-secret-0123456789abcdef")
    envelope = PullPageEnvelope(
        codec, entity_fixture.catalog.hash, "space-test", "scope-client", 0
    )

    async with entity_fixture._sessions.begin() as session:
        await record_sync_event(
            session,
            entity_type="schedule",
            entity_id="scope-s1",
            action="create",
            payload={"id": "scope-s1", "title": "a"},
            operation_id="scope-op-1",
            batch_id="scope-batch",
            version=1,
            created_at=UTC,
            visible=True,
        )
        await record_sync_event(
            session,
            entity_type="note",
            entity_id="scope-n1",
            action="create",
            payload={"id": "scope-n1", "title": "b"},
            operation_id="scope-op-2",
            batch_id="scope-batch",
            version=1,
            created_at=UTC,
            visible=True,
        )

    async with entity_fixture._sessions() as session:
        page = (
            await read_visible_event_page_bounded(
                session,
                after_sequence=0,
                max_events=100,
                page_envelope=envelope,
                entity_types=("schedule",),
            )
        ).page

    assert [event.entity_type for event in page.events] == ["schedule"]
    assert [event.operation_id for event in page.events] == ["scope-op-1"]


# ---------------------------------------------------------------- 游标与作用域


_SECRET = b"scope-cursor-secret-0123456789abcdef"


def _codec() -> SyncCursorCodec:
    return SyncCursorCodec(_SECRET)


def _legacy_token(
    *,
    sequence: int = 7,
    catalog_hash: str,
    space_id: str = "space-test",
    client_id: str = "cursor-client",
    generation: int = 0,
) -> str:
    """手工签出一个**加 scope 之前**格式的游标。

    用于证明：老游标（payload 里没有 scope 字段）仍然能被解出来，
    且按「全量订阅」语义处理 —— 升级不需要全量重同步。
    """
    payload = json.dumps(
        {
            "catalog_hash": catalog_hash,
            "client_id": client_id,
            "generation": generation,
            "sequence": sequence,
            "space_id": space_id,
            "version": 2,
        },
        sort_keys=True,
        separators=(",", ":"),
    ).encode("ascii")
    signature = hmac.digest(_SECRET, payload, "sha256")
    payload_segment = base64.urlsafe_b64encode(payload).rstrip(b"=").decode("ascii")
    signature_segment = base64.urlsafe_b64encode(signature).rstrip(b"=").decode("ascii")
    return f"{payload_segment}.{signature_segment}"


def test_legacy_cursor_decodes_as_full_scope() -> None:
    """★ 向后兼容：老游标照常可用，scope 视为全量。"""
    codec = _codec()
    token = _legacy_token(catalog_hash="a" * 64)
    position = codec.decode(token)

    assert position.sequence == 7
    assert position.scope == ""


def test_scope_roundtrips_through_the_cursor() -> None:
    codec = _codec()
    token = codec.encode(
        CursorPosition(11, "b" * 64, "space-test", "cursor-client", 0, "planning")
    )
    position = codec.decode(token)

    assert position.sequence == 11
    assert position.scope == "planning"


def test_tampering_with_scope_is_rejected() -> None:
    """★ scope 受 HMAC 保护：改了 payload 就必须被判为过期（不可伪造订阅）。"""
    codec = _codec()
    token = codec.encode(
        CursorPosition(3, "c" * 64, "space-test", "cursor-client", 0, "planning")
    )
    payload_segment, signature_segment = token.split(".")
    forged_payload = json.dumps(
        {
            "catalog_hash": "c" * 64,
            "client_id": "cursor-client",
            "generation": 0,
            "scope": "notes",
            "sequence": 3,
            "space_id": "space-test",
            "version": 2,
        },
        sort_keys=True,
        separators=(",", ":"),
    ).encode("ascii")
    forged = (
        base64.urlsafe_b64encode(forged_payload).rstrip(b"=").decode("ascii")
        + "."
        + signature_segment
    )

    with pytest.raises(SyncCursorExpiredError):
        codec.decode(forged)


def test_cursor_rejects_malformed_scope() -> None:
    with pytest.raises(ValueError, match="scope is invalid"):
        CursorPosition(0, "d" * 64, "space-test", "cursor-client", 0, "not a scope!")


def test_page_envelope_stamps_scope_into_the_cursor() -> None:
    """签发出去的游标必须带上作用域 —— 否则下游无法校验匹配。"""
    envelope = PullPageEnvelope(
        _codec(), "e" * 64, "space-test", "cursor-client", 0, "notes"
    )
    assert codec_decode_scope(envelope.cursor_for(5)) == "notes"


def codec_decode_scope(token: str) -> str:
    return _codec().decode(token).scope


async def test_page_reader_without_types_returns_everything(entity_fixture) -> None:  # noqa: F811
    """不传 entity_types → 行为与改动前一致（向后兼容的核心保证）。"""
    from app.services.sync_outbox import record_sync_event  # noqa: PLC0415

    codec = SyncCursorCodec(b"scope-nofilter-secret-0123456789")
    envelope = PullPageEnvelope(
        codec, entity_fixture.catalog.hash, "space-test", "scope-client", 0
    )

    async with entity_fixture._sessions.begin() as session:
        for index, entity_type in enumerate(("schedule", "note", "habit")):
            await record_sync_event(
                session,
                entity_type=entity_type,
                entity_id=f"scope-all-{index}",
                action="create",
                payload={"id": f"scope-all-{index}"},
                operation_id=f"scope-all-op-{index}",
                batch_id="scope-batch",
                version=1,
                created_at=UTC,
                visible=True,
            )

    async with entity_fixture._sessions() as session:
        page = (
            await read_visible_event_page_bounded(
                session,
                after_sequence=0,
                max_events=100,
                page_envelope=envelope,
            )
        ).page

    assert sorted(event.entity_type for event in page.events) == [
        "habit",
        "note",
        "schedule",
    ]


async def test_shared_cursor_skips_filtered_events_known_limitation(  # noqa: F811
    entity_fixture,
) -> None:
    """★ 已知限制：在同一个游标上做类型过滤，会**越过**未订阅的事件。

    场景（这正是 S2 要做 per-scope cursor 的原因）：
      账本顺序为 [schedule#1, note#2, schedule#3]，客户端先只订阅 schedule。

    过滤后取到 #1 与 #3，游标推进到 #3；此后即便改为全量订阅、从 #3 继续拉，
    **也拿不回 #2** —— 它被永久越过了。

    这条测试把限制钉死在测试里：将来实现了 per-scope cursor，
    应把断言反转为「改为全量订阅后仍能拿到 #2」。
    """
    from app.services.sync_outbox import record_sync_event  # noqa: PLC0415

    codec = SyncCursorCodec(b"scope-skip-secret-0123456789abcdefgh")
    envelope = PullPageEnvelope(
        codec, entity_fixture.catalog.hash, "space-test", "scope-client", 0
    )

    async with entity_fixture._sessions.begin() as session:
        # 刻意让未订阅的 note 夹在两条 schedule 之间
        for entity_type, entity_id, operation_id in (
            ("schedule", "skip-s1", "skip-op-1"),
            ("note", "skip-n1", "skip-op-2"),
            ("schedule", "skip-s3", "skip-op-3"),
        ):
            await record_sync_event(
                session,
                entity_type=entity_type,
                entity_id=entity_id,
                action="create",
                payload={"id": entity_id},
                operation_id=operation_id,
                batch_id="scope-batch",
                version=1,
                created_at=UTC,
                visible=True,
            )

    async with entity_fixture._sessions() as session:
        scoped = (
            await read_visible_event_page_bounded(
                session,
                after_sequence=0,
                max_events=100,
                page_envelope=envelope,
                entity_types=("schedule",),
            )
        ).page

        assert [e.operation_id for e in scoped.events] == ["skip-op-1", "skip-op-3"]

        # 游标已越过 note#2：改为全量订阅后，从该游标继续也拿不回它
        advanced = codec.decode(scoped.next_cursor).sequence
        assert advanced >= 3

        catch_up = (
            await read_visible_event_page_bounded(
                session,
                after_sequence=advanced,
                max_events=100,
                page_envelope=envelope,
            )
        ).page

    assert [e.operation_id for e in catch_up.events] == [], (
        "note#2 已被越过 —— 这正是共用游标的代价，实现 per-scope cursor 后应能取回"
    )


def test_page_reader_rejects_malformed_entity_types() -> None:
    """入参校验在查询之前 —— 与本项目其它边界校验的风格一致。"""

    async def run() -> None:
        await read_visible_event_page_bounded(
            None,  # type: ignore[arg-type]
            after_sequence=0,
            max_events=10,
            page_envelope=None,  # type: ignore[arg-type]
            entity_types=("ok", ""),  # type: ignore[arg-type]
        )

    with pytest.raises(ValueError, match="entity_types"):
        asyncio.run(run())
