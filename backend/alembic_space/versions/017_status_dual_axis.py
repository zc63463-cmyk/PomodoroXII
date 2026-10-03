"""状态双轴：category 收敛 6→5、删除表级 UQ 换部分唯一索引。

Revision ID: space_017_status_dual_axis
Revises: space_016_focus_session_type
Create Date: 2026-10-02

★ 为什么必须写迁移
  space 库由 ``alembic_space/`` 建（与 meta 的 ``alembic/`` 是两套）。本迁移做了
  三件 SQLite 层面无法用 DDL 直接完成的事：改 CHECK 闭集、删表级UNIQUE 约束、
  建部分唯一索引。SQLite **不支持 ALTER CONSTRAINT / DROP CONSTRAINT**，
  CHECK 与表级 UQ 都只能 ``batch_alter_table`` copy-and-move 重建整表。
  只改 ``app/models/work_item_definition.py`` 而不写迁移 → 既有 space 的
  CHECK 仍是 6 值、UQ 仍会阻断用户加 status 行，症状是"模型看着全对、行为不符预期"。
  配套的 ``task_space/migration_preflight.py`` 的 ``TASK_SPACE_TARGET_HEAD``
  也必须同步改成 ``space_017_status_dual_axis``，否则启动直接拒绝
  （fleet preflight policy targets a different revision）。**本仓已踩过一次**
  （016 的 docstring 记录了 assets 的同类事故）。

★ 设计决策：category 收敛为 5 个（Linear 范式的第一步）
  6 值闭集 = {not_started, in_progress, paused, waiting, completed, cancelled}
  5 值闭集 = {not_started, in_progress, waiting,completed, cancelled}

  1) ``paused`` **移除**，其唯一语义（"可恢复但未开始"）与 in_progress 重叠，
     保留只会让用户在"进行中/已暂停"之间反复纠结哪个才是对的。
     存量引用（本仓实测 12 条 work_items 中 3 条）统一并入 ``sys-status-in-progress``。
  2) ``waiting`` **保留**（刻意偏离 Linear 严格 4值）。它是 ADR-0003 等待前态
     （``work_items.pre_waiting_status_definition_id``）的锚点，而该机制有 4 处消费点
     （``compiler.py`` 的 waiting 前态写入分支、``work_item.py`` 的列注释、
     ``tasks/page.tsx`` 的可恢复判定、``relation-selectors.ts`` 的等待恢复入口）。
     收敛它会让整个等待前态机制**静默死亡**（条件永不成立、不报错）。
     ⇒ 把「category 收敛」与「waiting 机制」解耦，本期只做低风险的那一半。
     将来若要收敛 waiting，须先给它一个正交标记列承载"等待"语义。
  3) 拼写是 ``cancelled``（双 l），与项目既有一致；**不要**跟着 Linear 的
     ``canceled``（单 l）改 —— 那是一次纯 churn 的破坏性变更。

★ 设计决策：删表级 UQ，换部分唯一索引
  被删的约束：``UniqueConstraint("category", "system")``（迁移 010 建为
  ``uq_status_definitions_category_system``）。因 ``system`` 只有 0/1，
  它等价于「每 category 至多 1 行」，与双轴**直接冲突**：用户要在一个
  category 下建多条status，第二行就会被拒。

  替换为 ``uq_status_definitions_system_live``：
      CREATE UNIQUE INDEX ... ON status_definitions(category)
      WHERE system = 1 AND archived_at IS NULL
  一次满足三个约束（已实测SQLite 3.53.1）：
  (a) 同 category 可加任意多条用户行 —— **双轴核心需求**；
  (b) 每 category 至多一条**活跃**系统行 —— 防止出现两个系统代表造成语义歧义；
  (c) 归档旧系统行后可补新的 —— 旧 UQ 做不到这一点（它只认system 值不管归档）。

  不新增 ``status_categories`` 表：category 是恒定 5 个常量，加表只增join
  与同步负担，收益为零。

★ 为什么重建 status_definitions 时**需要**关外键（2026-10-02 实测修正）
  我最初判断"`status_definitions` 零入向FK ⇒ 不需要 `PRAGMA foreign_keys=OFF`"
  —— **错了**，方向搞反了。
  「零入向 FK」说的是**没有别的表把外键指向它以外的列**，
  但事实是 work_items.status_definition_id / work_items.pre_waiting_status_definition_id /
  projects.default_status_definition_id **都入向引用它**（3 处）。
  batch copy-and-move 的 `DROP TABLE status_definitions` 会被这些引用拦住：
      IntegrityError: (sqlite3.IntegrityError) FOREIGN KEY constraint failed
      [SQL: DROP TABLE status_definitions]
  ⇒ **upgrade 与 downgrade 都必须在 batch 前PRAGMA foreign_keys=OFF，batch 后开回来。**
  这是本迁移相对 014 的**唯一额外成本**（014 重建 work_items 时也是这么做的）。

★ 幂等
  先introspect ``status_definitions`` 的 CHECK/索引，已是目标形态则跳过 ——
  手工补建过的库与全新库都能安全通过（与 011~016 同款处理）。
  downgrade 同理 guard，并在有数据时 fail-closed（不静默丢数据）。
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "space_017_status_dual_axis"
down_revision: Union[str, None] = "space_016_focus_session_type"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

_TARGET_CATEGORIES = (
    "not_started",
    "in_progress",
    "waiting",
    "completed",
    "cancelled",
)
_PAUSED_STATUS_ID = "sys-status-paused"
_IN_PROGRESS_STATUS_ID = "sys-status-in-progress"
_LIVE_INDEX_NAME = "uq_status_definitions_system_live"
_RANK_INDEX_NAME = "ix_status_definitions_category_rank"


def _check_text() -> str | None:
    """读回 status_definitions 当前的 category CHECK 文本（没有则 None）。"""
    bind = op.get_bind()
    rows = bind.execute(
        sa.text("SELECT sql FROM sqlite_master WHERE type='table' AND name=:t"),
        {"t": "status_definitions"},
    ).fetchall()
    if not rows or not rows[0][0]:
        return None
    for line in rows[0][0].splitlines():
        if "category IN" in line:
            return line.strip()
    return None


def _index_names() -> set[str]:
    bind = op.get_bind()
    rows = bind.execute(
        sa.text("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name=:t"),
        {"t": "status_definitions"},
    ).fetchall()
    return {row[0] for row in rows if row[0]}


def _already_migrated() -> bool:
    check = _check_text()
    if check is None:
        return False
    if "paused" in check:
        return False
    return _LIVE_INDEX_NAME in _index_names()


def _migrate_paused_rows() -> tuple[int, int]:
    """把 paused 引用并入 in_progress，并删除 paused 系统行。

    返回 (work_items 受影响行数, pre_waiting 受影响行数)。
    pre_waiting 必须一起处理：它指向 paused 时，若只改 status_definition_id，
    恢复目标就变成"回到 in_progress" —— 等于无操作，语义悬空（ADR-0003 的本意是
    记住"进入等待前人在哪个态"，真实数据实测有 2 行指向 paused）。

    ★ 为什么还必须**删掉 paused 系统行**（实测踩到）：
      ``batch_alter_table(recreate="always")`` 是 copy-and-move ——
      它把旧表**所有行**INSERT 进新表。若paused 行还在，新表的 CHECK
      （不含paused）会在这一步直接报
      ``IntegrityError: CHECK constraint failed: category_values``。
      即：CHECK 收紧**不能**与「行仍在」共存，必须先让行消失。
    """
    bind = op.get_bind()
    moved_status = bind.execute(
        sa.text(
            "SELECT COUNT(*) FROM work_items WHERE status_definition_id = :pid"
        ),
        {"pid": _PAUSED_STATUS_ID},
    ).scalar_one()
    moved_pre = bind.execute(
        sa.text(
            "SELECT COUNT(*) FROM work_items"
            " WHERE pre_waiting_status_definition_id = :pid"
        ),
        {"pid": _PAUSED_STATUS_ID},
    ).scalar_one()

    bind.execute(
        sa.text(
            "UPDATE work_items SET status_definition_id = :target"
            " WHERE status_definition_id = :pid"
        ),
        {"target": _IN_PROGRESS_STATUS_ID, "pid": _PAUSED_STATUS_ID},
    )
    bind.execute(
        sa.text(
            "UPDATE work_items SET pre_waiting_status_definition_id = :target"
            " WHERE pre_waiting_status_definition_id = :pid"
        ),
        {"target": _IN_PROGRESS_STATUS_ID, "pid": _PAUSED_STATUS_ID},
    )
    # 先解引用、再删系统行（有外键约束的顺序不能反）。
    deleted = bind.execute(
        sa.text("DELETE FROM status_definitions WHERE id = :pid"),
        {"pid": _PAUSED_STATUS_ID},
    ).rowcount
    return int(moved_status), int(moved_pre) + int(deleted or 0)


def _fk_guard(enabled: bool) -> None:
    """临时切 SQLite 的 foreign_keys 开关（batch copy-and-move 必需）。

    ★★ 2026-10-03 修正（此前实现是错的，真实启动才暴露）
    旧实现只 `execute("PRAGMA foreign_keys=OFF")` 就完事，**在真实启动路径上无效**：
    - 症状：第一个空间（无 work_items 引用）迁成功；第二个空间
      `15e64740`（有 2 条paused work_items）报
      ``IntegrityError: FOREIGN KEY constraint failed / DROP TABLE status_definitions``，
      启动在 `prepare_registered_spaces` 中断，端口不监听。
    - 原因：``PRAGMA foreign_keys`` **在事务内是 no-op**，而迁移路径上
      前一个迁移写版本表的 DML 留下了未提交事务 ⇒ 切换静默失败。
    - 修法（照014 的成熟做法 `014_pre_waiting_status.py:86-102`）：
      先 `commit()` 结束当前事务（此时结构与版本表一致，提交安全），
      再切换，**立刻读回验证**；切不掉就fail-loud 抛错，绝不带着 ON 硬走。

    为什么必须关：``sqlite_vfs`` 的所有连接都强制 ``foreign_keys=ON``
    （``app/runtime/sqlite_vfs.py:578`` 与 ``:613``），而 SQLite 12 步
    copy-and-move 的第 8 步 ``DROP TABLE status_definitions`` 在有引用行时必然失败。
    """
    bind = op.get_bind()
    before = bind.exec_driver_sql("PRAGMA foreign_keys").scalar()
    if not enabled:
        if before:
            bind.exec_driver_sql("PRAGMA foreign_keys=OFF")
            if bind.exec_driver_sql("PRAGMA foreign_keys").scalar():
                # pragma 在事务内是 no-op —— 先结束事务再试（014 实测同款）
                if bind.in_transaction():
                    bind.commit()
                bind.exec_driver_sql("PRAGMA foreign_keys=OFF")
                if bind.exec_driver_sql("PRAGMA foreign_keys").scalar():
                    raise RuntimeError(
                        "space_017_status_dual_axis requires "
                        "PRAGMA foreign_keys=OFF for the status_definitions rebuild "
                        "but the pragma is a no-op (active transaction)"
                    )
    else:
        if not before:
            bind.exec_driver_sql("PRAGMA foreign_keys=ON")
            if not bind.exec_driver_sql("PRAGMA foreign_keys").scalar():
                if bind.in_transaction():
                    bind.commit()
                bind.exec_driver_sql("PRAGMA foreign_keys=ON")
                if not bind.exec_driver_sql("PRAGMA foreign_keys").scalar():
                    raise RuntimeError(
                        "space_017_status_dual_axis could not restore "
                        "PRAGMA foreign_keys=ON after the rebuild"
                    )


def _assert_integrity(before_rows: int) -> None:
    """补偿校验：行数恰好少1（paused 系统行被删）+ 外键完好。

    照014 的 _assert_rebuild_integrity 习惯：重建类迁移**必须**带这一段，
    否则 copy-and-move 出错时只能等后续查询报错才发现数据不对。
    """
    bind = op.get_bind()
    after_rows = bind.execute(
        sa.text("SELECT COUNT(*) FROM status_definitions")
    ).scalar_one()
    expected = before_rows - 1  # paused 系统行被有意删除
    if int(after_rows) != expected:
        raise RuntimeError(
            "space_017_status_dual_axis rebuild row count mismatch: "
            f"expected {expected} (={before_rows} - paused row), got {after_rows}"
        )
    violations = bind.execute(sa.text("PRAGMA foreign_key_check")).fetchall()
    if violations:
        raise RuntimeError(
            f"space_017_status_dual_axis left FK violations: {violations[:3]}"
        )


def upgrade() -> None:
    """收敛 category 6→5 + 删表级 UQ 换部分唯一索引。"""
    bind = op.get_bind()
    if _already_migrated():
        return

    before_rows = int(
        bind.execute(sa.text("SELECT COUNT(*) FROM status_definitions")).scalar_one()
    )

    # 顺序不可颠倒：**先迁数据，再删系统行，再重建表**。
    #   ① 若先收紧 CHECK，下面的 UPDATE 会被 CHECK 直接拦下；
    #   ② paused 系统行必须在重建**之前**消失—— batch 是 copy-and-move，
    #      它会把所有旧行搬进新表，新 CHECK 不含 paused ⇒ 行留着必炸。
    moved_status, moved_pre = _migrate_paused_rows()
    print(
        f"[017] paused→in_progress: work_items={moved_status}, pre_waiting+删除行={moved_pre}"
    )

    check_expr = "category IN ({})".format(
        ",".join("'{}'".format(value) for value in _TARGET_CATEGORIES)
    )
    _fk_guard(False)
    try:
        with op.batch_alter_table("status_definitions", recreate="always") as batch:
            # ⚠️ 约束名给**裸名**（不带 ck_/uq_ 前缀）。
            #   落库时项目的 MetaData(naming_convention=...) 会加前缀 ——
            #   实测真实库里是 ck_status_definitions_category_values /
            #   uq_status_definitions_category_system。
            #   但 batch_alter_table 的 drop_constraint 内部会**自己**套用同一约定，
            #   传全名会被拼成 `ck_status_definitions_ck_status_definitions_...`
            #   而 KeyError（实测：这是第一批 90 个 error 的唯一根因）。
            batch.drop_constraint(
                "uq_status_definitions_category_system", type_="unique"
            )
            batch.drop_constraint("category_values", type_="check")
            batch.create_check_constraint("category_values", check_expr)
            # ★ UQ 是**删除**不是重建 —— 它的职责（每 category 至多一条系统行）
            #   已由下面的部分唯一索引承担，两者并存会让「归档后补新系统行」失效
            #   （旧 UQ 只看system 值、不看 archived_at）。
    finally:
        _fk_guard(True)

    op.create_index(
        _LIVE_INDEX_NAME,
        "status_definitions",
        ["category"],
        unique=True,
        sqlite_where=sa.text("system = 1 AND archived_at IS NULL"),
    )
    op.create_index(
        _RANK_INDEX_NAME, "status_definitions", ["category", "rank"]
    )
    _assert_integrity(before_rows)


def downgrade() -> None:
    """回退为 6 值闭集 + 表级 UQ（幂等；有数据时 fail-closed）。"""
    bind = op.get_bind()
    check = _check_text()
    if check is None or "paused" in check:
        return

    # 降级要恢复 6 值闭集 + 表级 UQ，必须先确认「没有任何用户自定义 status 行」——
    # 那些行在新闭集下无处安放（且 UQ 重建后同 category 多行会直接冲突）。
    # fail-closed：不静默删用户数据。
    user_rows = bind.execute(
        sa.text("SELECT COUNT(*) FROM status_definitions WHERE system = 0")
    ).scalar_one()
    if user_rows:
        raise RuntimeError(
            "space_017_status_dual_axis downgrade requires no user-defined status "
            f"rows (双轴的产物无法无损退回6值闭集); found {user_rows} row(s)"
        )

    # 索引先删：它们是 batch copy-and-move 之外的独立对象，
    # 留着会让 batch 重建后的表继承不到预期结构。
    if _LIVE_INDEX_NAME in _index_names():
        op.drop_index(_LIVE_INDEX_NAME, table_name="status_definitions")
    if _RANK_INDEX_NAME in _index_names():
        op.drop_index(_RANK_INDEX_NAME, table_name="status_definitions")

    _fk_guard(False)
    try:
        with op.batch_alter_table("status_definitions", recreate="always") as batch:
            # 裸名（见 upgrade 里关于 naming_convention 的注释）
            batch.drop_constraint("category_values", type_="check")
            batch.create_check_constraint(
                "category_values",
                "category IN "
                "('not_started','in_progress','paused','waiting','completed','cancelled')",
            )
            batch.create_unique_constraint(
                "uq_status_definitions_category_system", ["category", "system"]
            )
    finally:
        _fk_guard(True)