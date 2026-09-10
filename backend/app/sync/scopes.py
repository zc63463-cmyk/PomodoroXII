"""Sync v2 作用域（scope）注册表。

作用域 = 命名的实体类型集合，让客户端可以只订阅它关心的那部分账本事件
（对应 Electric 的 Shape / PowerSync 的 bucket）。

★ 为什么作用域必须和游标成对出现
  共用一个游标做类型过滤会**静默丢数据**：`protocol.read_visible_event_page_bounded`
  里 `last_sequence = row.id` 只在**选中**行时推进，所以被过滤掉的事件 id 会被
  越过；客户端将来扩展订阅时，从新游标继续拉，拿不回那些被越过的事件。
  完整分析与方案见《同步作用域切片-实施方案-2026-09-03.md》。

★ 本模块只定义「有哪些作用域、每个作用域含哪些实体类型」——
  不参与任何 I/O，也不改变现有行为。过滤能力的接入点在
  `protocol.read_visible_event_page_bounded` 的 `entity_types` 参数（可选，
  不传即现状）。

实体类型用的是 **wire 名**（ledger 的 `entity_type`，即 camelCase 别名），
不是 registry 的 snake_case 名 —— 因为过滤发生在 ledger 查询层。
"""

from __future__ import annotations

SYNC_SCOPES: dict[str, tuple[str, ...]] = {
    # 日程与习惯：首启就要看到的东西
    "planning": (
        "schedule",
        "timeBlock",
        "habit",
        "habitCheckIn",
        "scheduleQuickNote",
    ),
    # 笔记类：体积最大，最值得延后订阅
    "notes": (
        "note",
        "folder",
        "quickNote",
        "reflection",
        "memoComment",
    ),
    # 任务空间
    # 注：workItemLabel 是复合主键且 sync_enabled=False，不进账本，故不在此列
    "tasks": (
        "project",
        "statusDefinition",
        "typeDefinition",
        "label",
        "workItem",
        "workItemNote",
        # 依赖边（依赖域 D11/D15）：单列确定性主键，协议原生支持。
        # 归入 tasks 而非独立作用域 —— 依赖边脱离工作项没有意义，
        # 两者必须同进同出，否则会出现「有边没节点」的孤儿窗口。
        "relation",
    ),
    # 专注会话
    "focus": (
        "focusSession",
        "sessionTaskContext",
        "sessionAttributionRevision",
        "sessionWorkItemPlan",
        "sessionWorkItemOutcome",
    ),
}

SCOPE_NAMES: tuple[str, ...] = tuple(SYNC_SCOPES)

_ENTITY_TO_SCOPE: dict[str, str] = {
    entity_type: scope
    for scope, entity_types in SYNC_SCOPES.items()
    for entity_type in entity_types
}


def scope_names() -> tuple[str, ...]:
    """全部作用域名的稳定顺序。"""
    return SCOPE_NAMES


def is_known_scope(scope: str) -> bool:
    return scope in SYNC_SCOPES


def entity_types_for_scope(scope: str) -> tuple[str, ...]:
    """返回该作用域的实体类型集合。未知作用域抛 ValueError。"""
    types = SYNC_SCOPES.get(scope)
    if types is None:
        raise ValueError(f"unknown sync scope: {scope!r}")
    return types


def entity_types_for_scopes(scopes: tuple[str, ...] | list[str] | str | None) -> tuple[str, ...]:
    """把一组作用域展开成去重后的实体类型集合。

    None / 空 → 返回空元组，调用方据此走「不过滤」的现有路径，
    保证不传参时行为与今天完全一致。
    """
    if scopes is None:
        return ()
    if isinstance(scopes, str):
        scopes = (scopes,)

    merged: dict[str, None] = {}
    for scope in scopes:
        for entity_type in entity_types_for_scope(scope):
            merged[entity_type] = None
    return tuple(merged)


def scope_for_entity_type(entity_type: str) -> str | None:
    """反查某个实体类型属于哪个作用域；未归类返回 None。"""
    return _ENTITY_TO_SCOPE.get(entity_type)


def uncovered_entity_types(registry_entity_types: tuple[str, ...] | list[str]) -> tuple[str, ...]:
    """返回**没有**被任何作用域覆盖的实体类型。

    ★ 这是防静默失联的护栏：若将来新增了 sync_enabled 实体却忘了归类，
      它在任何作用域订阅下都拿不到事件，而且不会报错 —— 只会表现为
      「这个域的数据永远不更新」。
    """
    return tuple(
        entity_type
        for entity_type in registry_entity_types
        if entity_type not in _ENTITY_TO_SCOPE
    )


def unknown_entity_types(registry_entity_types: tuple[str, ...] | list[str]) -> tuple[str, ...]:
    """返回作用域里登记了、但 registry 中**不存在**（或未启用同步）的实体类型。

    与上一个函数一起构成双向护栏：前者防「漏归类」，后者防「写了无效类型」。
    """
    known = set(registry_entity_types)
    return tuple(
        entity_type for entity_type in _ENTITY_TO_SCOPE if entity_type not in known
    )
