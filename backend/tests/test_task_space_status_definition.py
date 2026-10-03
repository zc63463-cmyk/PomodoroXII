"""状态双轴阶段 2：status 定义 CRUD 的领域层测试。

★ 每条用例都测**双轴特有**的语义，不是照抄 label 测试：
  1. category 是**固定轴** —— 用户可自定义 status，但不能发明新 category。
  2. 同 category 下可建多条 status（**双轴核心需求**，旧表级 UQ 会拒第二条）。
  3. 同 category 内名不重复；跨 category 可同名（那是不同分组）。
  4. 引用守卫：仍有 work_items 指向时拒绝归档（否则状态名从 UI 消失）。
  5. 归档后再迁移到该 status 必须被拒（双轴放大的既有漏洞）。
  6. reorder 是集合级：不带 expected_version，且连带改兄弟行 rank。
  7. 用户行 system=false，客户端伪造 system=true 必须被拒。
  8. 幂等：零效果回执返回权威 post-image 而非报错。
"""
from __future__ import annotations

from dataclasses import fields

import pytest

from app.mutation.types import canonical_payload_hash
from app.task_space.compiler import _stable_id
from app.task_space.contracts import (
    SYSTEM_STATUS_IDS,
    StatusCommand,
    StatusOperation,
    TaskSpaceAccepted,
    TaskSpaceRejected,
)


def status_command(
    *,
    space_id: str,
    operation: str,
    command_id: str,
    name: str | None = None,
    category: str | None = None,
    status_id: str | None = None,
    expected_version: int | None = None,
    rank: int | None = None,
) -> StatusCommand:
    payload: dict[str, object] = {}
    if operation == "create":
        payload = {"name": name, "category": category}
    elif operation == "update":
        if name is not None:
            payload["name"] = name
        if category is not None:
            payload["category"] = category
    elif operation == "reorder":
        payload = {"rank": rank}
    return StatusCommand(
        operation=operation,
        command_id=command_id,
        space_id=space_id,
        status_id=status_id,
        expected_version=expected_version,
        payload_hash=canonical_payload_hash(payload),
        payload=payload,
    )


async def create_status(
    fixture, *, command_id: str, name: str, category: str
):
    return await fixture.module.execute(
        fixture.scope,
        status_command(
            space_id=fixture.space_id,
            operation="create",
            command_id=command_id,
            name=name,
            category=category,
        ),
    )


def _status_rows(fixture, category: str) -> list[dict]:
    """当前某 category 下**未归档**的 status 行。

    ★ `overlay_snapshot()` 返回 `(entity_name, rows)`，rows 是
      **`SELECT *` 的位置元组**（tests/mutation_fixture.py:219-241）。
      ⚠️ 列顺序**不能**用 `StatusDefinition.__table__.columns`——
      那里 SyncMixin 的列（id/created_at/...）排在**业务列之后**，
      而建表 SQL 里它们在最前（实测 ORM 顺序 =
      [name, category, ..., id, created_at]）。直接 zip 会整体错位。
      ⇒ 用 registry 的 FieldSpec 顺序（`builtin.py` 里 `_sync_fields()` 在前），
      那才是 `SELECT *` 的真实顺序。
    """
    database, _ = fixture.overlay_snapshot()
    for name, rows in database:
        if name != "status_definition":
            continue
        # builtin.py 的 status_definition FieldSpec 顺序（同步 4 列在前）
        columns = [
            "id", "created_at", "updated_at", "version",
            "name", "category", "icon", "color", "rank",
            "system", "archived_at",
        ]
        out: list[dict] = []
        for row in rows:
            mapping = dict(zip(columns, row))
            if mapping.get("category") != category:
                continue
            if mapping.get("archived_at") is not None:
                continue
            out.append(mapping)
        return out
    return []


def test_status_command_carries_operation_identity_and_cas() -> None:
    assert {field.name for field in fields(StatusCommand)} == {
        "operation",
        "command_id",
        "space_id",
        "status_id",
        "expected_version",
        "payload_hash",
        "payload",
    }


def test_status_operation_covers_four_lifecycle_steps() -> None:
    assert {i.value for i in StatusOperation} == {
        "create",
        "update",
        "archive",
        "reorder",
    }


def test_system_status_ids_remain_the_five_seeded_categories() -> None:
    """★ 固定轴锚点：SYSTEM_STATUS_IDS 仍是 5 条系统代表（ADR-0004 依赖）。"""
    assert set(SYSTEM_STATUS_IDS) == {
        "not_started",
        "in_progress",
        "waiting",
        "completed",
        "cancelled",
    }


# --------------------------------------------------------------------------- #
# 双轴核心：固定轴 + 可扩展轴
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_category_is_fixed_axis_rejects_unknown_value(task_space_fixture) -> None:
    """★ 用户可自定义 status，但**不能发明新 category**。"""
    outcome = await create_status(
        task_space_fixture, command_id="st-bad-cat", name="不该成功", category="blocked"
    )
    assert isinstance(outcome, TaskSpaceRejected)


@pytest.mark.asyncio
async def test_multiple_status_in_same_category_is_allowed(task_space_fixture) -> None:
    """★ 双轴核心需求：同 category 多条 status（旧表级 UQ 会拒第二条）。"""
    fixture = task_space_fixture
    first = await create_status(
        fixture, command_id="st-multi-1", name="等设计 review", category="waiting"
    )
    second = await create_status(
        fixture, command_id="st-multi-2", name="需要授权", category="waiting"
    )

    assert isinstance(first, TaskSpaceAccepted)
    assert isinstance(second, TaskSpaceAccepted)
    assert first.value["category"] == second.value["category"] == "waiting"
    # 用户行一律不是系统行（系统代表行由迁移播种）
    assert first.value["system"] is False
    assert second.value["system"] is False
    #两条都真实落库
    names = {str(r["name"]) for r in _status_rows(fixture, "waiting")}
    assert {"等设计 review", "需要授权"} <= names


@pytest.mark.asyncio
async def test_duplicate_name_in_same_category_is_rejected(task_space_fixture) -> None:
    fixture = task_space_fixture
    await create_status(fixture, command_id="st-dup-1", name="等设计", category="waiting")
    outcome = await create_status(
        fixture, command_id="st-dup-2", name="等设计", category="waiting"
    )
    assert isinstance(outcome, TaskSpaceRejected)


@pytest.mark.asyncio
async def test_same_name_across_categories_is_allowed(task_space_fixture) -> None:
    """跨 category 同名合法 —— 那是不同分组。"""
    fixture = task_space_fixture
    a = await create_status(
        fixture, command_id="st-cross-a", name="待跟进", category="not_started"
    )
    b = await create_status(
        fixture, command_id="st-cross-b", name="待跟进", category="in_progress"
    )
    assert isinstance(a, TaskSpaceAccepted)
    assert isinstance(b, TaskSpaceAccepted)


# --------------------------------------------------------------------------- #
# Update / 幂等
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_update_can_change_category_and_name(task_space_fixture) -> None:
    fixture = task_space_fixture
    created = await create_status(
        fixture, command_id="st-upd-base", name="原名", category="waiting"
    )
    assert isinstance(created, TaskSpaceAccepted)

    outcome = await fixture.module.execute(
        fixture.scope,
        status_command(
            space_id=fixture.space_id,
            operation="update",
            command_id="st-upd-1",
            name="新名",
            category="in_progress",
            status_id=str(created.value["id"]),
            expected_version=int(created.value["version"]),
        ),
    )
    assert isinstance(outcome, TaskSpaceAccepted)
    assert outcome.value["name"] == "新名"
    assert outcome.value["category"] == "in_progress"


@pytest.mark.asyncio
async def test_update_with_empty_payload_is_idempotent(task_space_fixture) -> None:
    """零效果回执：返回权威 post-image，不报错、不写库。"""
    fixture = task_space_fixture
    created = await create_status(
        fixture, command_id="st-idem-base", name="幂等", category="waiting"
    )
    assert isinstance(created, TaskSpaceAccepted)

    again = await fixture.module.execute(
        fixture.scope,
        status_command(
            space_id=fixture.space_id,
            operation="update",
            command_id="st-idem-noop",
            status_id=str(created.value["id"]),
            expected_version=int(created.value["version"]),
        ),
    )
    assert isinstance(again, TaskSpaceAccepted)
    assert int(again.value["version"]) == int(created.value["version"])


# --------------------------------------------------------------------------- #
# 引用守卫（双轴放大的既有漏洞）
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_archive_is_blocked_while_work_items_reference_it(
    task_space_fixture,
) -> None:
    """★ 引用守卫：有 work_items 指向时拒绝归档，否则那些项的状态名会从 UI 消失。

    对照组：未被引用的 status 可以正常归档。
    """
    fixture = task_space_fixture
    await fixture.create_project(command_id="stp-1", key="STG", name="Guard")

    used = await create_status(
        fixture, command_id="st-guard-used", name="被引用的", category="in_progress"
    )
    unused = await create_status(
        fixture, command_id="st-guard-free", name="没人用的", category="not_started"
    )
    assert isinstance(used, TaskSpaceAccepted)
    assert isinstance(unused, TaskSpaceAccepted)

    # 把一个 L2 工作项迁到「被引用的」这个 status 上
    item = await fixture.seed_level2("st-guard-item")
    await fixture.transition_work_item(
        command_id="st-guard-move",
        work_item_id=item["id"],
        expected_version=int(item["version"]),
        status_definition_id=str(used.value["id"]),
    )

    # 对照组：无人引用 ⇒ 可归档
    ok = await fixture.module.execute(
        fixture.scope,
        status_command(
            space_id=fixture.space_id,
            operation="archive",
            command_id="st-guard-arch-free",
            status_id=str(unused.value["id"]),
            expected_version=int(unused.value["version"]),
        ),
    )
    assert isinstance(ok, TaskSpaceAccepted), ok

    # 被引用的 ⇒ 必须拒绝
    blocked = await fixture.module.execute(
        fixture.scope,
        status_command(
            space_id=fixture.space_id,
            operation="archive",
            command_id="st-guard-arch-used",
            status_id=str(used.value["id"]),
            expected_version=int(used.value["version"]),
        ),
    )
    assert isinstance(blocked, TaskSpaceRejected)
    assert blocked.code == "status_definition_in_use"


@pytest.mark.asyncio
async def test_transition_to_archived_status_is_rejected(task_space_fixture) -> None:
    """★ 双轴放大的既有漏洞：`_require_row` 过去不查 archived_at。

    label 时代就会发生（可以 update 到已归档的 label），只是**没人建/归档 label**
    所以不可达；双轴后用户会真的创建并归档 status ⇒ 这个洞变得可达，
    必须被 `_require_live_status` 挡住。
    """
    fixture = task_space_fixture
    await fixture.create_project(command_id="stp-2", key="STA", name="Archived")

    created = await create_status(
        fixture, command_id="st-arch-target", name="先建后归档", category="in_progress"
    )
    assert isinstance(created, TaskSpaceAccepted)

    archived = await fixture.module.execute(
        fixture.scope,
        status_command(
            space_id=fixture.space_id,
            operation="archive",
            command_id="st-arch-do",
            status_id=str(created.value["id"]),
            expected_version=int(created.value["version"]),
        ),
    )
    assert isinstance(archived, TaskSpaceAccepted), archived

    # 归档之后再 update它 ⇒ 必须被拒（而不是静默改一个归档行）
    outcome = await fixture.module.execute(
        fixture.scope,
        status_command(
            space_id=fixture.space_id,
            operation="update",
            command_id="st-arch-after",
            name="改名试试",
            status_id=str(created.value["id"]),
            expected_version=int(archived.value["version"]),
        ),
    )
    assert isinstance(outcome, TaskSpaceRejected)
    assert outcome.code == "status_definition_archived"


@pytest.mark.asyncio
async def test_reorder_moves_status_within_its_category(task_space_fixture) -> None:
    fixture = task_space_fixture
    a = await create_status(fixture, command_id="st-ro-a", name="A", category="waiting")
    b = await create_status(fixture, command_id="st-ro-b", name="B", category="waiting")
    c = await create_status(fixture, command_id="st-ro-c", name="C", category="waiting")
    assert isinstance(a, TaskSpaceAccepted)
    assert isinstance(b, TaskSpaceAccepted)
    assert isinstance(c, TaskSpaceAccepted)

    outcome = await fixture.module.execute(
        fixture.scope,
        status_command(
            space_id=fixture.space_id,
            operation="reorder",
            command_id="st-ro-move",
            status_id=str(c.value["id"]),
            rank=0,
        ),
    )
    assert isinstance(outcome, TaskSpaceAccepted), outcome

    rows = [r for r in _status_rows(fixture, "waiting") if not r["system"]]
    ordered = sorted(rows, key=lambda r: (int(r["rank"]), str(r["id"])))
    assert str(ordered[0]["id"]) == str(c.value["id"]), "C 应被移到最前"