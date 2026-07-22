# Backend 95+ S3 Knowledge Consistency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 以 durable mutation journal、staged before/after images、共享 `MutationUnitOfWork` 和权威 `KnowledgeStore` 消除 `space.db`、Markdown、`index.db`、FTS、版本、trash 与 Sync ledger 之间的部分提交，并为 REST/官方前端提供稳定幂等重试。

**Architecture:** S3 在 Space 链新增唯一 revision `space_009_mutation_journal`，用 `MutationBatch`、`MutationOperation`、`MutationStep` 持久化关闭状态机；共享 UoW 独占 `app/mutation/{types,journal,staging,unit_of_work,recovery}.py`，knowledge 包只包含 commands/projections/store/consistency。所有知识写入先持久化 INTENT 和 stage，再在同一 business commit 写 ORM 与 invisible ledger，最后按 step hash 幂等投影并一次性开放 batch ledger；不可证明的 forward/inverse 状态进入 `FAILED_MANUAL` 并阻断 Space。

**Tech Stack:** Python 3.13, SQLAlchemy 2 async, Alembic Space chain, SQLite, filesystem fsync/atomic rename, FastAPI, Pydantic, pytest fault injection, TypeScript, Axios, Dexie, Vitest.

---

## Preconditions And Locked Decisions

- 从已批准且已合并的 S2 commit 建独立 S3 分支；S2 的 process-owner/global/Space lease、fence、`SpaceRuntimeHandle`、`CompiledEntityCatalog` 与 `IndexStoreSchema` 是硬依赖。
- 新 migration 文件和 revision 固定为：

```text
backend/alembic_space/versions/009_mutation_journal.py
revision = space_009_mutation_journal
down_revision = space_008_sync_retention_snapshot
```

- ORM 文件固定为 `backend/app/models/mutation.py`，且必须定义 `MutationBatch`、`MutationOperation`、`MutationStep`。`SyncOutbox` 必须增加 `operation_id`、`batch_id`、nullable checked `version`、`visible`。
- 共享 mutation Module 固定为：

```text
backend/app/mutation/types.py
backend/app/mutation/journal.py
backend/app/mutation/staging.py
backend/app/mutation/unit_of_work.py
backend/app/mutation/recovery.py
```

  除必要的 `__init__.py` 外，不在 `app/mutation` 增加知识业务、HTTP 或 Sync 专用文件。
- knowledge Module 固定为：

```text
backend/app/knowledge/commands.py
backend/app/knowledge/projections.py
backend/app/knowledge/store.py
backend/app/knowledge/consistency.py
```

  除必要的 `__init__.py` 外，不在 `app/knowledge` 创建 journal、transaction、recovery 或 route 文件。
- `MutationUnitOfWork` 的最终公开签名固定为：

```text
execute(scope, request, operation_id) -> MutationResult
execute_batch(scope, requests, batch_id, *, operation_ids=None) -> BatchMutationResult
execute_prepared_batch(scope, items, batch_id) -> BatchMutationResult
recover_under_lease(scope, lease) -> RecoveryResult
inspect_recovery(view) -> RecoveryInspection
```

  `execute` 接受可序列化 `MutationRequest`；`execute_batch` 是全 request 的兼容包装；`execute_prepared_batch` 只为 S4 接收按原始输入序号排列的 `PreparedBatchItem`，使 transport mapping rejection 与 accepted request 共用一个 durable receipt。UoW 在取得 Space-exclusive 后通过 compiler 读取 authority、执行 CAS/invariant validation，并生成可持久化 `MutationCommand`（`DbMutationPlan` + ordered `ProjectionPlan` + ordered `SyncEventPlan`）。一个 domain command 可以产生多个 Sync post-image；这些 events 与 command 的 DB/projection effects 同生共灭。journal 不保存 Python callable；happy path 与 restart recovery 必须使用同一个 `DbMutationInterpreter`。
- `recover_under_lease(scope, lease)` 也是所有已取得 matching Space-exclusive 的 S3/S4 consumer 的 mandatory cleanliness preflight。它必须在该 consumer 读取自己的 batch、authority、ledger、client state、snapshot 或 retention state之前运行；open-time recovery 不能替代 acquisition-time recovery，因为 mutation handle 不持有 Space lease。

- `EntityCommand` 的唯一最终位置是 `backend/app/commands/entity.py`，公开面固定为：

```text
create(scope, entity_type, payload, expected_version) -> MutationRequest
update(scope, entity_type, entity_id, patch, expected_version) -> MutationRequest
delete(scope, entity_type, entity_id, expected_version) -> MutationRequest
from_sync_event(scope, event) -> MutationRequest
```

  S4 只能调用 `from_sync_event()`，不得在 Sync service、route 或 MCP Adapter 重新实现 parent/cycle/relation/CAS/delete-strategy 规则。
- `MutationCompiler` 必须提供 catalog/domain-policy 注册 seam；generic CRUD 只能处理 catalog 明确允许的字段。Task Space 后续注册专属 policy 来封闭 `parent_id`、`project_id`、正式状态和 `document_json`，任何 Adapter 都不能通过 generic patch 绕过树、文档或 CAS 不变量。
- Sync 冲突策略由 `EntitySpec.sync_conflict_policy` 驱动，闭合集合为 `timestamp_lww | strict_cas`。S3 可以保留现有实体的 `timestamp_lww`，但不得在 compiler 内硬编码全局 LWW；TS0 将 `workItemNote` 注册为 `strict_cas`。
- authority 固定：`space.db` 管 identity、Folder graph、Note metadata/lifecycle/version/Sync state；Markdown 管 Note body；frontmatter、path、`index.db`、FTS 是可重建 projection；Folder 的 index representation 没有第二个 writer。
- 关闭状态机固定为：`INTENT -> STAGED -> DB_COMMITTED -> FINALIZING -> FORWARD_APPLIED -> FINALIZED`；安全终态仅 `ABORTED`、`COMPENSATED`；无法证明 forward/inverse 时仅 `FAILED_MANUAL`。单个 child 的 `FORWARD_APPLIED` 仍可在 batch 失败时反向补偿，不是终态。
- `FINALIZED`、`ABORTED`、`COMPENSATED` 才正常释放 mutation Space exclusive lease；`FAILED_MANUAL` 必须先持久化 degraded marker，再释放 lease，并由 runtime gate 持续阻断该 Space 的读写。
- accepted batch child ledger 只能整体变为 visible。rejected child 不创建 operation 或 ledger row。
- REST v1 body 保持现有兼容形状；幂等信息通过 `Idempotency-Key` 请求头和 `X-Operation-ID` 响应头增加。不要借 S3 改写通用 error envelope。已批准的 TS0 会 breaking-delete 旧 Task/Session，因此 S3 Task 9 不改造 `/tasks`、`/sessions`，也不把它们列为最终兼容门禁。
- S4 的 opaque cursor、ACK、retention 和完整 Sync/MCP convergence 不在本计划实现；S3 只让 ledger visibility 和 `EntityCommand.from_sync_event` 准备就绪。
- Shell blocks in Tasks 1-9 start independently from `backend/`; Task 10 blocks start from `frontend/`; Task 11 uses the working directory stated immediately above each block. No block inherits a prior `cd`, and Git pathspecs are relative to that block's declared root.

## File Responsibility Map

### Migration and models

- `backend/alembic_space/versions/009_mutation_journal.py`: 三张 journal 表、约束/index、`sync_outbox` 四列、legacy row visibility/version backfill，以及既有 `sync_state` 的 `0 <= retention_floor <= current_cursor` 数据验证/命名 CHECK。
- `backend/app/models/mutation.py`: journal ORM mapping，不含状态转移业务。
- `backend/app/models/sync_outbox.py`: operation/batch identity、nullable nonnegative version 与 visibility mapping。
- `backend/app/models/sync_state.py`: S3 起把 `current_cursor` 定义为 allocated high watermark，并以 ORM CHECK 固化 `0 <= retention_floor <= current_cursor`；S4 只消费，不重新拥有该约束。
- `backend/app/models/__init__.py`, `backend/app/db/metadata.py`: 确保 migration/parity 能加载新模型。

### Shared mutation Modules

- `backend/app/mutation/types.py`: Task 1 先建立 migration/ORM 共用的 canonical enums；Task 2 扩展 `MutationRequest`、`PreparedBatchItem`、serializable `DbMutationPlan`/command/projection/result records、canonical hash；所有 JSON-bearing constructors 导入 S1 `app.errors.deep_freeze_json`，不自建 freezer/serializer；不做 I/O，不含 callable。
- `backend/app/errors.py`: S1 `AppError` 继续是唯一异常 carrier；增加 closed mutation rejection/idempotency subclasses，默认 REST、canonical REST 与 MCP 都从同一 stored rejection 投影。
- `backend/app/mutation/journal.py`: legal transitions、journal queries/commits、batch ledger visibility；不写 Markdown/index。
- `backend/app/mutation/staging.py`: 相对路径 manifest、before/after blobs、hash、fsync、atomic publish、orphan collection；不访问 ORM model。
- `backend/app/mutation/unit_of_work.py`: `execute/execute_batch/execute_prepared_batch/recover_under_lease/inspect_recovery` orchestration、compiler/interpreter、lease lifetime、business commit、finalize barrier。
- `backend/app/mutation/recovery.py`: startup/open recovery decision table、forward/compensate/FAILED_MANUAL；不包含业务 route。

### Domain Modules and Adapters

- `backend/app/commands/entity.py`: catalog-driven create/update/delete/from-sync command builder；唯一 parent/cycle/relation/CAS/delete strategy authority。
- `backend/app/knowledge/commands.py`: Note/Folder/QuickNote conversion/trash/restore/purge command construction；组合 `EntityCommand`，不提交。
- `backend/app/knowledge/projections.py`: Markdown/frontmatter/path/index/FTS/version/trash 的 deterministic projection plans 与 rebuild。
- `backend/app/knowledge/store.py`: 公开 KnowledgeStore operations，只把 validated command 交给 UoW。
- `backend/app/knowledge/consistency.py`: read-only `SpaceDataView`、journal cleanliness 与 authority/projection consistency verification；live rebuild 仍要求 `SpaceRuntimeHandle`。
- `backend/app/services/note.py`, `backend/app/services/folder.py`, `backend/app/services/quick_note.py`, `backend/app/services/cascade.py`: reads 保持兼容；writes 委托新 command/store 或仅供 S4 临时 legacy path，不能再自行 commit/compensate。
- `backend/app/routes/v1/notes.py`, `folders.py`, `quick_notes.py`, `trash.py`: thin KnowledgeStore Adapters。
- `backend/app/routes/v1/schedules.py`, `habits.py`, `reflections.py`, `time_blocks.py`: thin EntityCommand/UoW Adapters，保留 response schema。旧 Task/Session routes 留给 TS0 直接 breaking-delete，S3 不为将被删除的契约增加兼容代码。
- `backend/app/deps.py`: request operation ID、UoW/KnowledgeStore providers、同一个 mutation runtime handle。
- `backend/app/services/sync_outbox.py`, `backend/app/services/sync.py`: 写入 operation/batch/visible，pull/ledger query 仅选择 visible；不在 S3 改 cursor wire shape。

### Official frontend protocol maintenance

- `frontend/src/services/idempotency.ts`: mutation-method header generation and stable batch hash。
- `frontend/src/services/api.ts`: Axios retry 保留同一 key；显式 caller key 优先。
- `frontend/src/types/index.ts`: persisted outbox `operationId`。
- `frontend/src/services/database.ts`: Dexie v17 backfill operation IDs。
- `frontend/src/lib/sync/outbox.ts`: 新 row 生成并在 merge 中保留 operation ID。
- `frontend/src/lib/sync/push-batch.ts`: 从 ordered persisted operation IDs 计算稳定 `Idempotency-Key`。

### New and expanded tests

- `backend/tests/test_mutation_migration.py`: revision/table/column/backfill/parity。
- `backend/tests/test_mutation_journal.py`: state transitions、batch barrier、illegal transitions。
- `backend/tests/test_mutation_staging.py`: manifest/fsync/hash/path/orphan safety。
- `backend/tests/test_mutation_recovery.py`: 完整 fault matrix、restart、compensation、manual failure。
- `backend/tests/test_note_workspace_atomicity.py`: Note/Folder/QuickNote all-old/all-new and projection rebuild。
- `backend/tests/test_entity_invariants.py`, `backend/tests/test_entity_concurrency.py`: shared invariants/CAS。
- `frontend/src/services/idempotency.test.ts`, existing API/outbox/push tests: key generation、persistence、retry reuse。

## Task 1: Add The space_009 Journal Schema And Visibility Columns

**Files:**
- Create: `backend/alembic_space/versions/009_mutation_journal.py`
- Create: `backend/app/mutation/__init__.py`
- Create: `backend/app/mutation/types.py` (canonical enums only in this task)
- Create: `backend/app/models/mutation.py`
- Modify: `backend/app/models/sync_outbox.py`
- Modify: `backend/app/models/sync_state.py`
- Modify: `backend/app/models/__init__.py`
- Modify: `backend/app/db/metadata.py`
- Modify: `backend/app/services/sync_outbox.py`
- Modify: `backend/tests/migrations/__init__.py`
- Create: `backend/tests/test_mutation_migration.py`
- Modify: `backend/tests/test_sync_outbox_service.py`
- Modify: `backend/tests/test_parity_alembic_metadata.py`
- Modify: `backend/tests/test_migration_runner.py`
- Modify: `backend/tests/test_migration_wal_durability.py`
- Modify: `backend/tests/test_space_lifecycle.py`
- Modify: `backend/tests/test_alembic_dual_environments.py`

**Interfaces:**
- Consumes: S2 Space head `space_008_sync_retention_snapshot`, existing singleton `sync_state`, legacy `sync_outbox` rows, and canonical `MutationState`/`StepState` literals introduced in this Task.
- Produces: Space revision `space_009_mutation_journal`; ORM `MutationBatch`/`MutationOperation`/`MutationStep`; checked `SyncOutbox.operation_id|batch_id|version|visible`; checked `SyncState` invariant `0 <= retention_floor <= current_cursor` where `current_cursor` is the allocated high watermark.

- [ ] **Step 1: Write the failing migration and legacy visibility tests**

```python
from __future__ import annotations

from pathlib import Path

from alembic import command

from tests.migrations import run_bound_command


def test_space_008_upgrades_to_mutation_journal_and_preserves_legacy_visibility(
    tmp_path: Path,
) -> None:
    path = tmp_path / "space.db"

    def seed_legacy(maintenance) -> None:
        maintenance.execute(
            "INSERT INTO sync_outbox "
            "(entity_type, entity_id, action, payload, created_at, synced_at) "
            "VALUES ('note', 'n1', 'update', '{}', "
            "'2026-07-14T00:00:00.000Z', NULL)"
        )

    run_bound_command(
        "space",
        path,
        command.upgrade,
        "space_008_sync_retention_snapshot",
        after=seed_legacy,
    )

    observed: dict[str, object] = {}

    def verify_009(maintenance) -> None:
        observed["tables"] = {
            row[0]
            for row in maintenance.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            ).fetchall()
        }
        observed["columns"] = {
            row[1] for row in maintenance.execute("PRAGMA table_info(sync_outbox)").fetchall()
        }
        observed["legacy"] = maintenance.execute(
            "SELECT operation_id, batch_id, version, visible "
            "FROM sync_outbox WHERE entity_id='n1'"
        ).fetchone()
        observed["head"] = maintenance.execute(
            "SELECT version_num FROM alembic_version_space"
        ).fetchone()[0]

    run_bound_command("space", path, command.upgrade, "head", after=verify_009)

    assert {"mutation_batches", "mutation_operations", "mutation_steps"} <= observed["tables"]
    assert {"operation_id", "batch_id", "version", "visible"} <= observed["columns"]
    assert observed["legacy"] == (None, None, None, 1)
    assert observed["head"] == "space_009_mutation_journal"
```

Task 1 在 `tests/migrations/__init__.py` 为现有 helper 增加 package-private、仅测试用的
`run_bound_command(..., *, after: Callable[[_MaintenanceConnection], None] | None = None)`；
callback 只能在 Alembic operation 完成后、同一 `open_maintenance()` context 关闭前执行，
helper 在 callback 正常返回后对其 DML 精确 `commit()`，callback 抛出时 `rollback()` 后
原样重抛，并在离开 maintenance context 前断言 `in_transaction is False`；helper 不返回、
不缓存、不泄漏 maintenance handle。`test_mutation_migration.py` 必须证明 callback failure
回滚全部 seed DML、后续新 bound open 可用且旧 callback handle 已关闭。所有 migration setup、seed 和 query
必须沿用 `tests.migrations.run_bound_command()` 的
`_bind_existing_target()` + `open_maintenance()` + `_alembic_maintenance_adapter()`
authority-bound 链路。测试不得设置 Alembic `connection` attribute、不得 pathname
reopen（包括 SQLAlchemy pathname engine constructor），也不得为制造预期 RED 而削弱 S2
fail-closed migration authority。

另测 fresh DB 的 FK/unique/check/index，以及 downgrade 到 008 后 legacy outbox rows 仍存在。用 raw SQL 分别尝试非法 batch/operation/step state、负 `accepted_count`、负 `sequence` 和负 `ordinal`，每个写入都必须由 SQLite CHECK 拒绝；Task 1 在 `app/mutation/types.py` 只建立 canonical `MutationState`/`StepState`，ORM 与 migration tests 都导入它们，ORM enum 与 migration literal 集合必须精确相等。不得在 model 或 migration test 中复制第二套 enum；Task 2 只扩展同一 types 文件。

同一测试文件还要证明 S3 在 009 拥有 Sync 水位不变量，而不是把它推迟给 S4：先在 008 fixture 中分别写入 `retention_floor=-1`、`current_cursor=-1`、`retention_floor > current_cursor`，009 upgrade 必须在 schema 重建前报告明确的 legacy validation error，且不得悄悄改写数值；对有效 legacy row，upgrade 后 raw SQL 的上述三种非法 `INSERT`/`UPDATE` 都由命名 CHECK `ck_sync_state_floor_cursor` 拒绝。ORM/migration parity 断言 `backend/app/models/sync_state.py` 使用同名同表达式约束。正常升级保留 `current_cursor == MAX(sync_outbox.id)` 的 008 backfill 值，009 downgrade 只移除新增 CHECK，不重算或降低该水位。

- [ ] **Step 2: Run migration tests and verify the expected missing revision**

```powershell
.\.venv\Scripts\python.exe -m pytest -q tests/test_mutation_migration.py tests/test_migration_runner.py tests/test_migration_wal_durability.py tests/test_space_lifecycle.py tests/test_alembic_dual_environments.py -p no:cacheprovider
```

Expected: FAIL because head remains `space_008_sync_retention_snapshot`, mutation tables/columns do not exist, and `sync_state` has no floor/cursor CHECK.

- [ ] **Step 3: Implement the exact revision and ORM mappings**

Migration identifiers must be literal:

```python
revision = "space_009_mutation_journal"
down_revision = "space_008_sync_retention_snapshot"
branch_labels = None
depends_on = None
```

`upgrade()` 创建；`backend/app/models/mutation.py` 从 Task 1 的 canonical enum 文件导入状态类型：

```python
op.create_table(
    "mutation_batches",
    sa.Column("batch_id", sa.String(length=128), primary_key=True),
    sa.Column("command_hash", sa.String(length=64), nullable=False),
    sa.Column("state", sa.String(length=24), nullable=False),
    sa.Column("accepted_count", sa.Integer(), nullable=False, server_default="0"),
    sa.Column("result_json", sa.Text(), nullable=True),
    sa.Column("created_at", sa.String(length=32), nullable=False),
    sa.Column("updated_at", sa.String(length=32), nullable=False),
    sa.CheckConstraint(
        "state IN ('INTENT','STAGED','DB_COMMITTED','FINALIZING','FORWARD_APPLIED','FINALIZED',"
        "'ABORTED','COMPENSATING','COMPENSATED','FAILED_MANUAL')",
        name=op.f("ck_mutation_batches_state"),
    ),
    sa.CheckConstraint(
        "accepted_count >= 0",
        name=op.f("ck_mutation_batches_accepted_count_nonnegative"),
    ),
)
op.create_table(
    "mutation_operations",
    sa.Column("operation_id", sa.String(length=128), primary_key=True),
    sa.Column("batch_id", sa.String(length=128), nullable=False),
    sa.Column("sequence", sa.Integer(), nullable=False),
    sa.Column("command_hash", sa.String(length=64), nullable=False),
    sa.Column("command_json", sa.Text(), nullable=False),
    sa.Column("expected_versions_json", sa.Text(), nullable=False),
    sa.Column("projection_set_json", sa.Text(), nullable=False),
    sa.Column("db_before_json", sa.Text(), nullable=True),
    sa.Column("db_after_json", sa.Text(), nullable=True),
    sa.Column("manifest_sha256", sa.String(length=64), nullable=True),
    sa.Column("state", sa.String(length=24), nullable=False),
    sa.Column("result_json", sa.Text(), nullable=True),
    sa.Column("error_code", sa.String(length=64), nullable=True),
    sa.Column("created_at", sa.String(length=32), nullable=False),
    sa.Column("updated_at", sa.String(length=32), nullable=False),
    sa.ForeignKeyConstraint(["batch_id"], ["mutation_batches.batch_id"]),
    sa.UniqueConstraint(
        "batch_id", "sequence", name=op.f("uq_mutation_operation_sequence")
    ),
    sa.CheckConstraint(
        "state IN ('INTENT','STAGED','DB_COMMITTED','FINALIZING','FORWARD_APPLIED','FINALIZED',"
        "'ABORTED','COMPENSATING','COMPENSATED','FAILED_MANUAL')",
        name=op.f("ck_mutation_operations_state"),
    ),
    sa.CheckConstraint(
        "sequence >= 0",
        name=op.f("ck_mutation_operations_sequence_nonnegative"),
    ),
)
op.create_table(
    "mutation_steps",
    sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
    sa.Column("operation_id", sa.String(length=128), nullable=False),
    sa.Column("ordinal", sa.Integer(), nullable=False),
    sa.Column("name", sa.String(length=64), nullable=False),
    sa.Column("store", sa.String(length=32), nullable=False),
    sa.Column("target", sa.String(length=1000), nullable=False),
    sa.Column("before_hash", sa.String(length=64), nullable=True),
    sa.Column("after_hash", sa.String(length=64), nullable=True),
    sa.Column("applied_hash", sa.String(length=64), nullable=True),
    sa.Column("state", sa.String(length=16), nullable=False),
    sa.ForeignKeyConstraint(["operation_id"], ["mutation_operations.operation_id"]),
    sa.UniqueConstraint(
        "operation_id", "ordinal", name=op.f("uq_mutation_step_ordinal")
    ),
    sa.CheckConstraint(
        "state IN ('PENDING','APPLIED','COMPENSATED')",
        name=op.f("ck_mutation_steps_state"),
    ),
    sa.CheckConstraint(
        "ordinal >= 0", name=op.f("ck_mutation_steps_ordinal_nonnegative")
    ),
)
```

在任何 `batch_alter_table("sync_state")` 之前，009 用同一 connection 查询 legacy singleton；若 `retention_floor < 0`、`current_cursor < 0` 或 `retention_floor > current_cursor`，立即中止 upgrade，不修补、不截断、不从 ledger 重新推导。有效数据才获得 migration/ORM 同名约束：

```python
SYNC_STATE_FLOOR_CURSOR_CHECK = (
    "retention_floor >= 0 AND current_cursor >= retention_floor"
)

invalid = connection.execute(sa.text(
    "SELECT id, retention_floor, current_cursor FROM sync_state "
    "WHERE retention_floor < 0 OR current_cursor < 0 "
    "OR retention_floor > current_cursor LIMIT 1"
)).first()
if invalid is not None:
    raise RuntimeError("legacy sync_state violates floor/cursor invariant")

with op.batch_alter_table("sync_state") as batch:
    batch.create_check_constraint(
        batch.f("ck_sync_state_floor_cursor"), SYNC_STATE_FLOOR_CURSOR_CHECK
    )
```

`SyncState.__table_args__` 使用相同命名 CHECK。由于 `Base.metadata` 已安装
`ck_%(table_name)s_%(constraint_name)s` naming convention，ORM 必须使用 constraint
token `name="floor_cursor"`，使最终数据库名精确为 `ck_sync_state_floor_cursor`；不得把
完整最终名再次作为 token 导致二次前缀。009 的 downgrade 显式 drop 该约束再回到
008；010 继续保持 `down_revision="space_009_mutation_journal"`，不得复制、改名或接管此不变量。
009 migration 中所有已写成最终形式的 PK/FK/UQ/CK/index 名都必须使用 `op.f(...)`
或 `batch.f(...)` 标记已经应用 naming convention；禁止把 `ck_mutation_*`、
`uq_mutation_*`、`ix_mutation_*` 等最终名当成 convention token 再次扩展。parity test
必须逐名证明 migration 与 ORM 的最终约束和索引名称相同。

再为 batch/operation state、operation batch、step operation 创建普通 indexes；通过 `batch_alter_table("sync_outbox")` 添加 nullable `operation_id`, nullable `batch_id`, nullable integer `version` with `version IS NULL OR version >= 0`, non-null boolean `visible`，最终 DB/ORM visible server default 必须是 false。migration transaction 先以 false 建列，再把迁移前 existing rows 显式 backfill 为 `visible=true,version=null`；新 raw INSERT 省略 visible 时保持 false，任何 caller 都不能因漏参提前公开。S3 UoW 的 Sync-enabled event 必须显式写 `SyncEventPlan.version`；Task 1 同时修改唯一 legacy writer `app/services/sync_outbox.py`，让 `record_sync_event()` 显式构造 `version=None,visible=True`，并在 `test_sync_outbox_service.py` 证明 Task 1 后旧写入仍可见；不得保留 Python/DB true default，S4 删除最后 bypass。为 identity/visibility 列建立 indexes，version CHECK 做 migration/ORM parity。把 S2 新增的 `test_migration_wal_durability.py`、`test_space_lifecycle.py` 以及所有 Space table/head assertions 从 `space_008_sync_retention_snapshot` 更新为 `space_009_mutation_journal`，不得留下跨波硬编码。测试包含 migration legacy null version/visible row、legacy helper explicit visibility、UoW delete version persistence、negative raw version rejection和 post-migration raw INSERT omitted-visible=false。

- [ ] **Step 4: Run migration/parity tests**

```powershell
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $true
.\.venv\Scripts\python.exe -m pytest -q tests/test_mutation_migration.py tests/test_migration_runner.py tests/test_migration_wal_durability.py tests/test_space_lifecycle.py tests/test_alembic_dual_environments.py tests/test_parity_alembic_metadata.py -p no:cacheprovider
.\.venv\Scripts\python.exe -m pytest -q tests/test_sync_outbox_service.py -p no:cacheprovider
.\.venv\Scripts\ruff.exe check --no-cache app/models/mutation.py app/models/sync_outbox.py app/models/sync_state.py app/services/sync_outbox.py alembic_space/versions/009_mutation_journal.py tests/test_mutation_migration.py tests/test_parity_alembic_metadata.py tests/test_sync_outbox_service.py
```

Expected: PASS; Space has exactly one head `space_009_mutation_journal`; legacy events are visible with null operation/batch IDs; valid legacy Sync state is preserved and every raw SQL violation of `0 <= retention_floor <= current_cursor` is rejected.

- [ ] **Step 5: Commit the journal schema**

```powershell
git add alembic_space/versions/009_mutation_journal.py app/mutation/__init__.py app/mutation/types.py app/models/mutation.py app/models/sync_outbox.py app/models/sync_state.py app/models/__init__.py app/db/metadata.py app/services/sync_outbox.py tests/migrations/__init__.py tests/test_mutation_migration.py tests/test_sync_outbox_service.py tests/test_parity_alembic_metadata.py tests/test_migration_runner.py tests/test_migration_wal_durability.py tests/test_space_lifecycle.py tests/test_alembic_dual_environments.py
git commit -m "feat(mutation): add durable operation journal schema"
```

## Task 2: Define Mutation Types And Enforce The Closed Journal State Machine

**Files:**
- Modify: `backend/pyproject.toml`
- Modify: `backend/uv.lock`
- Modify: `backend/app/mutation/__init__.py`
- Modify: `backend/app/mutation/types.py`
- Modify: `backend/app/errors.py`
- Modify: `backend/app/registry/entities.py`
- Modify: `backend/app/registry/catalog.py`
- Create: `backend/app/mutation/journal.py`
- Create: `backend/tests/fixtures/task_space_session_payload_hash_vectors.json`
- Create: `backend/tests/ast_helpers.py`
- Create: `backend/tests/test_mutation_journal.py`
- Modify: `backend/tests/test_compiled_entity_catalog.py`
- Modify: `backend/tests/test_mcp_authorization.py`

**Interfaces:**
- Consumes: Task 1 canonical enums/schema and S1 `app.errors.deep_freeze_json(value)` plus sole recursive `app.errors.to_wire_json(value)` serializer.
- Produces: deeply immutable `MutationRequest`, `PreparedBatchItem`, multi-effect `MutationCommand`, `PersistedMutationCommand`, `MutationRejection`, `BatchMutationResult`; exact RFC 8785 `canonical_payload_hash(...)`/`require_payload_hash(...)`; reusable `literal_exception_codes(...)`; catalog `sync_conflict_policy`; `MutationJournal.transition_in_transaction(...)`/`finalize_batch_in_transaction(...)`; `MutationRejectedError` and `IdempotencyConflictError` as S1 `AppError` carriers.

- [ ] **Step 1: Write failing canonical-hash and transition tests**

```python
import pytest

from app.mutation.journal import IllegalMutationTransition, MutationJournal
from app.mutation.types import (
    InvalidPayloadHashError,
    MutationRejection,
    MutationRequest,
    MutationRuleViolation,
    MutationState,
    PreparedBatchItem,
    canonical_payload_hash,
    require_payload_hash,
)


def test_request_hash_is_canonical_before_authority_reads() -> None:
    first = MutationRequest.from_payload(
        name="note.update",
        entity_type="note",
        entity_id="n1",
        payload={"title": "A", "tags": ["x"]},
        expected_version=2,
    )
    second = MutationRequest.from_payload(
        name="note.update",
        entity_type="note",
        entity_id="n1",
        payload={"tags": ["x"], "title": "A"},
        expected_version=2,
    )
    assert first.request_hash == second.request_hash


def test_payload_hash_is_rfc8785_and_rejects_a_false_declaration() -> None:
    payload = {"z": 1, "a": [True, None, "雪"]}
    expected = "d625d1d0dc331b7f55c53959732d6fbe3678413b7e013655326ab86130da6559"
    assert canonical_payload_hash(payload) == expected
    require_payload_hash(expected, payload)
    with pytest.raises(InvalidPayloadHashError):
        require_payload_hash("0" * 64, payload)


@pytest.mark.asyncio
async def test_journal_accepts_every_legal_transition_and_rejects_shortcuts(journal_fixture) -> None:
    journal: MutationJournal = journal_fixture
    await journal.create_intent(journal_fixture.intent("op-1", "batch-1"))
    for target in (
        MutationState.STAGED,
        MutationState.DB_COMMITTED,
        MutationState.FINALIZING,
        MutationState.FORWARD_APPLIED,
    ):
        await journal.transition("op-1", target)
    await journal.finalize_batch("batch-1")
    assert await journal.state("op-1") is MutationState.FINALIZED
    with pytest.raises(IllegalMutationTransition):
        await journal.transition("op-1", MutationState.ABORTED)


@pytest.mark.asyncio
async def test_batch_visibility_opens_only_after_all_children_finalize(journal_fixture) -> None:
    journal = journal_fixture
    await journal_fixture.create_two_child_committed_batch("batch-1")
    await journal.transition("op-1", MutationState.FORWARD_APPLIED)
    assert await journal.visible_event_count("batch-1") == 0
    await journal.transition("op-2", MutationState.FORWARD_APPLIED)
    await journal.finalize_batch("batch-1")
    assert await journal.child_states("batch-1") == {
        MutationState.FINALIZED,
    }
    assert await journal.visible_event_count("batch-1") == 2


def test_request_deep_freezes_nested_json_before_hashing() -> None:
    original = {"tags": ["a"], "meta": {"rank": 1}}
    request = MutationRequest.from_payload(
        name="note.update", entity_type="note", entity_id="n1",
        payload=original, expected_version=1,
    )
    before = request.request_hash
    original["tags"].append("mutated")
    original["meta"]["rank"] = 99
    assert request.payload == {"tags": ("a",), "meta": {"rank": 1}}
    assert request.request_hash == before


@pytest.mark.asyncio
async def test_rejection_source_mutation_and_restart_preserve_wire_bytes(
    journal_fixture,
) -> None:
    source = {"conflict": {"versions": [1, 2]}, "resolution": "manual"}
    violation = MutationRuleViolation("version_conflict", source, retryable=False)
    rejection = MutationRejection(
        request_index=0,
        operation_id="op-1",
        entity_type="task",
        entity_id="t1",
        code=violation.code,
        retryable=violation.retryable,
        details=violation.details,
    )
    item = PreparedBatchItem(
        request_index=0,
        operation_id="op-1",
        intent_hash="a" * 64,
        request=None,
        pre_rejection=rejection,
    )
    await journal_fixture.record_rejected_batch("batch-1", (item,))
    before = await journal_fixture.persisted_result_wire_bytes("batch-1")

    source["conflict"]["versions"].append(99)
    source["resolution"] = "remote"
    restarted = await journal_fixture.restart_from_disk_only()

    assert violation.details["conflict"]["versions"] == (1, 2)
    assert rejection.details["resolution"] == "manual"
    assert await restarted.persisted_result_wire_bytes("batch-1") == before


def test_catalog_rejects_unknown_sync_conflict_policy(catalog_fixture) -> None:
    invalid = replace(
        REGISTRY.get("note"), sync_conflict_policy="merge_magic"
    )
    with pytest.raises(ValueError, match="sync_conflict_policy"):
        CompiledEntityCatalog.compile((invalid,), version="test")


def test_catalog_preserves_strict_cas_policy(catalog_fixture) -> None:
    strict = replace(
        REGISTRY.get("note"), sync_conflict_policy="strict_cas"
    )
    catalog = CompiledEntityCatalog.compile((strict,), version="test")
    assert catalog.get("note").sync_conflict_policy == "strict_cas"
```

相邻参数化用例必须覆盖 `MutationRequest.payload`、`DbMutationPlan.primary_key/before_row/after_row`、`SyncEventPlan.payload`、`MutationCommand.result_value`、`PersistedMutationCommand.result_value`、`MutationResult.value`、`MutationRejection.details`、`MutationRuleViolation.details`，并分别在构造后变更原始 nested dict/list。每个 record 的 `to_wire_json()` 结果、canonical bytes/hash 与 fresh-process journal decoder 结果都必须逐字不变；直接 dataclass constructor 与 factory constructor 都走相同 `__post_init__`，不能只保护 `from_payload()`。

- [ ] **Step 2: Run journal tests and verify missing types**

```powershell
.\.venv\Scripts\python.exe -m pytest -q tests/test_mutation_journal.py tests/test_compiled_entity_catalog.py -p no:cacheprovider
```

Expected: FAIL on the not-yet-defined immutable request/command/result records and `MutationJournal`; the Task 1 package and canonical enums already import successfully.

- [ ] **Step 3: Implement immutable records, result types, and legal transitions**

`types.py` 从 S1 owner 导入 `deep_freeze_json`/`to_wire_json`，不得在 mutation 包定义第二套 recursive freezer/serializer：

```python
import hashlib
import hmac
import re
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime
from enum import StrEnum
from typing import Literal

import rfc8785

from app.errors import deep_freeze_json, to_wire_json


def require_frozen_object(value: object) -> Mapping[str, object]:
    frozen = deep_freeze_json(value)
    if not isinstance(frozen, Mapping):
        raise TypeError("value must be a JSON object")
    return frozen


def freeze_optional_object(
    value: Mapping[str, object] | None,
) -> Mapping[str, object] | None:
    return None if value is None else require_frozen_object(value)


PAYLOAD_SHA256 = re.compile(r"[0-9a-f]{64}")


class InvalidPayloadHashError(ValueError):
    code = "invalid_payload_hash"


def canonical_payload_hash(payload: Mapping[str, object]) -> str:
    frozen = require_frozen_object(payload)
    return hashlib.sha256(rfc8785.dumps(to_wire_json(frozen))).hexdigest()


def require_payload_hash(
    declared: str, payload: Mapping[str, object]
) -> None:
    if not isinstance(declared, str) or PAYLOAD_SHA256.fullmatch(declared) is None:
        raise InvalidPayloadHashError("payload hash must be 64 lowercase hex characters")
    actual = canonical_payload_hash(payload)
    if not hmac.compare_digest(declared, actual):
        raise InvalidPayloadHashError("payload hash does not match canonical payload")


def validate_expected_version(value: int | None) -> None:
    if value is not None and (type(value) is not int or value < 0):
        raise ValueError("expected_version must be null or a nonnegative integer")


def validate_resolution(value: object) -> None:
    if value not in (None, "remote"):
        raise ValueError("resolution must be null or remote")


SYNC_UTC_RFC3339 = re.compile(
    r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z"
)


def validate_canonical_client_timestamp_or_none(value: str | None) -> None:
    if value is None:
        return
    if not isinstance(value, str) or SYNC_UTC_RFC3339.fullmatch(value) is None:
        raise ValueError("client_updated_at must be strict UTC RFC 3339")
    datetime.fromisoformat(value[:-1] + "+00:00")


class MutationState(StrEnum):
    INTENT = "INTENT"
    STAGED = "STAGED"
    DB_COMMITTED = "DB_COMMITTED"
    FINALIZING = "FINALIZING"
    FORWARD_APPLIED = "FORWARD_APPLIED"
    FINALIZED = "FINALIZED"
    ABORTED = "ABORTED"
    COMPENSATING = "COMPENSATING"
    COMPENSATED = "COMPENSATED"
    FAILED_MANUAL = "FAILED_MANUAL"


class StepState(StrEnum):
    PENDING = "PENDING"
    APPLIED = "APPLIED"
    COMPENSATED = "COMPENSATED"


@dataclass(frozen=True)
class ProjectionPlan:
    store: str
    target: str
    ordinal: int
    before: bytes | None
    after: bytes | None


@dataclass(frozen=True)
class PersistedProjectionDescriptor:
    store: str
    target: str
    ordinal: int
    before_sha256: str | None
    before_size: int | None
    after_sha256: str | None
    after_size: int | None


@dataclass(frozen=True)
class DbMutationPlan:
    table: str
    primary_key: Mapping[str, object]
    operation: Literal["insert", "update", "delete"]
    expected_version: int | None
    before_row: Mapping[str, object] | None
    after_row: Mapping[str, object] | None

    def __post_init__(self) -> None:
        object.__setattr__(self, "primary_key", require_frozen_object(self.primary_key))
        object.__setattr__(self, "before_row", freeze_optional_object(self.before_row))
        object.__setattr__(self, "after_row", freeze_optional_object(self.after_row))


@dataclass(frozen=True)
class SyncEventPlan:
    entity_type: str
    entity_id: str
    action: Literal["create", "update", "delete"]
    payload: Mapping[str, object]
    version: int
    created_at: str

    def __post_init__(self) -> None:
        object.__setattr__(self, "payload", require_frozen_object(self.payload))
        if isinstance(self.version, bool) or not isinstance(self.version, int):
            raise TypeError("SyncEventPlan.version must be an integer")
        if self.version < 0:
            raise ValueError("SyncEventPlan.version must be nonnegative")
        if self.created_at is None:
            raise ValueError("SyncEventPlan.created_at is required")
        validate_canonical_client_timestamp_or_none(self.created_at)


@dataclass(frozen=True)
class MutationRequest:
    name: str
    entity_type: str
    entity_id: str
    payload: Mapping[str, object]
    expected_version: int | None
    client_updated_at: str | None
    request_hash: str

    def __post_init__(self) -> None:
        frozen_payload = require_frozen_object(self.payload)
        object.__setattr__(self, "payload", frozen_payload)
        validate_expected_version(self.expected_version)
        validate_canonical_client_timestamp_or_none(self.client_updated_at)
        expected_hash = hashlib.sha256(canonical_request_bytes(
            self.name, self.entity_type, self.entity_id, frozen_payload,
            self.expected_version, self.client_updated_at,
        )).hexdigest()
        if not hmac.compare_digest(self.request_hash, expected_hash):
            raise ValueError("request_hash does not match frozen request")

    @classmethod
    def from_payload(
        cls,
        *,
        name: str,
        entity_type: str,
        entity_id: str,
        payload: Mapping[str, object],
        expected_version: int | None,
        client_updated_at: str | None = None,
    ) -> "MutationRequest":
        frozen_payload = deep_freeze_json(payload)
        canonical = canonical_request_bytes(
            name, entity_type, entity_id, frozen_payload, expected_version,
            client_updated_at,
        )
        return cls(
            name,
            entity_type,
            entity_id,
            frozen_payload,
            expected_version,
            client_updated_at,
            hashlib.sha256(canonical).hexdigest(),
        )


@dataclass(frozen=True)
class MutationCommand:
    request: MutationRequest
    db_plans: tuple[DbMutationPlan, ...]
    projections: tuple[ProjectionPlan, ...]
    sync_events: tuple[SyncEventPlan, ...]
    result_value: Mapping[str, object]
    resolution: Literal["remote"] | None
    command_hash: str

    def __post_init__(self) -> None:
        object.__setattr__(self, "db_plans", tuple(self.db_plans))
        object.__setattr__(self, "projections", tuple(self.projections))
        object.__setattr__(self, "sync_events", tuple(self.sync_events))
        object.__setattr__(self, "result_value", require_frozen_object(self.result_value))
        validate_resolution(self.resolution)

    def persisted(self) -> "PersistedMutationCommand": ...


@dataclass(frozen=True)
class PersistedMutationCommand:
    request: MutationRequest
    db_plans: tuple[DbMutationPlan, ...]
    projections: tuple[PersistedProjectionDescriptor, ...]
    sync_events: tuple[SyncEventPlan, ...]
    result_value: Mapping[str, object]
    resolution: Literal["remote"] | None
    command_hash: str

    def __post_init__(self) -> None:
        object.__setattr__(self, "db_plans", tuple(self.db_plans))
        object.__setattr__(self, "projections", tuple(self.projections))
        object.__setattr__(self, "sync_events", tuple(self.sync_events))
        object.__setattr__(self, "result_value", require_frozen_object(self.result_value))
        validate_resolution(self.resolution)


@dataclass(frozen=True)
class MutationResult:
    operation_id: str
    batch_id: str
    entity_type: str
    entity_id: str
    version: int | None
    resolution: Literal["remote"] | None
    state: MutationState
    value: Mapping[str, object]

    def __post_init__(self) -> None:
        object.__setattr__(self, "value", require_frozen_object(self.value))
        validate_resolution(self.resolution)


@dataclass(frozen=True)
class MutationRejection:
    request_index: int
    operation_id: str
    entity_type: str
    entity_id: str
    code: str
    retryable: bool
    details: Mapping[str, object]

    def __post_init__(self) -> None:
        if type(self.request_index) is not int or self.request_index < 0:
            raise ValueError("request_index must be a nonnegative integer")
        if type(self.retryable) is not bool:
            raise TypeError("retryable must be bool")
        object.__setattr__(self, "details", require_frozen_object(self.details))


@dataclass(frozen=True)
class PreparedBatchItem:
    request_index: int
    operation_id: str
    intent_hash: str
    request: MutationRequest | None
    pre_rejection: MutationRejection | None

    def __post_init__(self) -> None:
        if type(self.request_index) is not int or self.request_index < 0:
            raise ValueError("request_index must be a nonnegative integer")
        if (self.request is None) == (self.pre_rejection is None):
            raise ValueError("prepared item requires exactly one outcome")
        validate_sha256(self.intent_hash, field="intent_hash")
        if self.pre_rejection is not None and (
            self.pre_rejection.request_index != self.request_index
            or self.pre_rejection.operation_id != self.operation_id
        ):
            raise ValueError("pre-rejection identity does not match prepared item")


@dataclass(frozen=True)
class BatchMutationResult:
    batch_id: str
    applied: tuple[MutationResult, ...]
    rejected: tuple[MutationRejection, ...]

    def __post_init__(self) -> None:
        object.__setattr__(self, "applied", tuple(self.applied))
        object.__setattr__(self, "rejected", tuple(self.rejected))


class MutationRuleViolation(RuntimeError):
    __slots__ = ("_code", "_retryable", "_details")

    def __init__(
        self, code: str, details: Mapping[str, object], *, retryable: bool = False
    ) -> None:
        super().__init__(code)
        object.__setattr__(self, "_code", code)
        object.__setattr__(self, "_retryable", retryable)
        object.__setattr__(self, "_details", details)
        self.__post_init__()

    def __post_init__(self) -> None:
        if type(self.retryable) is not bool:
            raise TypeError("retryable must be bool")
        object.__setattr__(self, "_details", require_frozen_object(self.details))

    @property
    def code(self) -> str:
        return self._code

    @property
    def retryable(self) -> bool:
        return self._retryable

    @property
    def details(self) -> Mapping[str, object]:
        return self._details


@dataclass(frozen=True)
class RecoveryResult:
    finalized: tuple[str, ...]
    aborted: tuple[str, ...]
    compensated: tuple[str, ...]
    failed_manual: tuple[str, ...]


@dataclass(frozen=True)
class RecoveryInspection:
    pending_batches: tuple[str, ...]
    failed_manual: tuple[str, ...]
    orphan_stages: tuple[str, ...]
    clean: bool
    reasons: tuple[str, ...]
```

Pin the one backend JCS implementation before running these tests:

```powershell
uv add "rfc8785==0.1.4"
```

`backend/pyproject.toml` must contain the exact direct requirement
`rfc8785==0.1.4`, and `backend/uv.lock` must resolve that exact version. Create
`backend/tests/fixtures/task_space_session_payload_hash_vectors.json` with the
closed backend authority used later by TS1, TS2, and TS3:

```json
[
  {
    "name": "empty-object",
    "payload": {},
    "canonicalUtf8": "{}",
    "sha256": "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a"
  },
  {
    "name": "nested-unicode-and-key-order",
    "payload": {"z": 1, "a": [true, null, "雪"]},
    "canonicalUtf8": "{\"a\":[true,null,\"雪\"],\"z\":1}",
    "sha256": "d625d1d0dc331b7f55c53959732d6fbe3678413b7e013655326ab86130da6559"
  }
]
```

`test_mutation_journal.py` loads every vector, compares exact RFC 8785 bytes
and SHA-256, and verifies that key insertion order cannot change the result.
`canonical_payload_hash` hashes only the command-specific transport-neutral
business payload supplied to it. Callers exclude command/operation ID,
declared hash, Space/target identity, CAS version, and ownership epoch; S3's
separate `MutationRequest.request_hash` continues to cover the complete request.

Create the single AST test helper in `backend/tests/ast_helpers.py`:

```python
from __future__ import annotations

import ast
from pathlib import Path


def literal_exception_codes(path: Path, exception_name: str) -> set[str]:
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    codes: set[str] = set()
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call) or not node.args:
            continue
        name = node.func.attr if isinstance(node.func, ast.Attribute) else (
            node.func.id if isinstance(node.func, ast.Name) else None
        )
        first = node.args[0]
        if (
            name == exception_name
            and isinstance(first, ast.Constant)
            and isinstance(first.value, str)
        ):
            codes.add(first.value)
    return codes
```

Later waves import this helper; they do not create another AST parser.

`registry/entities.py` 与 S2 `registry/catalog.py` 同时使用以下关闭字段；compiler 只能读取 compiled value，不按实体名称硬编码：

```python
SyncConflictPolicy = Literal["timestamp_lww", "strict_cas"]
SYNC_CONFLICT_POLICIES: frozenset[str] = frozenset(
    {"timestamp_lww", "strict_cas"}
)


def require_sync_conflict_policy(value: str) -> SyncConflictPolicy:
    if value not in SYNC_CONFLICT_POLICIES:
        raise ValueError(f"unsupported sync_conflict_policy: {value}")
    return cast(SyncConflictPolicy, value)
```

S2 没有、Task 2 也不得引入第二个 `CompiledEntitySpec` DTO。
`CompiledEntityCatalog` 继续持有并返回 frozen `EntitySpec`；compile loop 对每个 spec
调用 `require_sync_conflict_policy()`，`_canonical_spec()` 把验证后的字段纳入 catalog
hash。compiler 后续只从 `catalog.get(...).sync_conflict_policy` 读取该 compiled value，
不得按 entity name 硬编码。`EntitySpec` 加入以下精确字段：

```python
sync_conflict_policy: SyncConflictPolicy = "timestamp_lww"
```

`backend/app/errors.py` owns the only externally catchable mutation exceptions. `MutationRejectedError(AppError)` retains the frozen stored `MutationRejection`, and `IdempotencyConflictError(AppError)` owns `code="idempotency_conflict"`; neither is a plain `RuntimeError`. A closed `MUTATION_REJECTION_SPECS` maps every compiler/mapper code to exact status, safe message, legacy error type, and retryable value. S3 defines explicit `S3_MUTATION_REJECTION_CODES`, `RESERVED_TS_CODES`, and `RESERVED_S4_MAPPING_CODES`. Producer enumeration follows the phased subset/exact rule below; Task 2 must not pretend Task 4/6 producers already exist. TS1/TS2 and S4 extend the producer test only when their real producers land, so an unknown code cannot silently become a 500 and no reserved code may remain orphaned. `retryable` and `details` are copied from the persisted rejection, but every `MutationRejection` construction and fresh-process decoder validates that the persisted boolean equals the closed spec; mismatch is corrupt durable state and fails closed rather than being rendered. request ID is supplied only by S1's existing handler at render time and is never persisted. Default REST keeps the endpoint's existing legacy body; canonical REST and MCP serialize the same five-field `DomainErrorRecord`. No S3/S4 `DomainFailure` family is introduced.

```python
RESERVED_TS_CODES = frozenset({
    "space_scope_mismatch",
    "version_conflict",
    "idempotency_conflict",
    "invalid_payload_hash",
    "invalid_project_key",
    "project_key_conflict",
    "unsupported_content_version",
    "invalid_note_document",
    "invalid_work_item_tree",
    "not_found",
    "active_child_conflict",
    "active_session_exists",
    "stale_session_owner",
    "session_activation_conflict",
    "offline_formal_creation_forbidden",
    "command_result_unknown",
    "active_session_recovery_required",
    "work_item_structure_changed",
})

S3_MUTATION_REJECTION_CODES = frozenset({
    "space_scope_mismatch",
    "version_conflict",
    "cycle_detected",
    "relation_endpoint_missing",
    "entity_id_mismatch",
    "delete_payload_not_empty",
    "not_found",
})

RESERVED_S4_MAPPING_CODES = frozenset({"entity_not_sync_enabled"})
```

`MUTATION_REJECTION_SPECS` 的 key 精确等于上述三个集合的并集（集合可重叠，
map 中每个 code 只出现一次），并固定以下四元组：
`not_found` 同时属于 S3 与 TS reserved 集合：S3 Task 6 的 CAS reread 产出它，
TS1/TS2 domain compiler 也复用同一 durable rejection；两个 producer gate 都枚举该
literal，但 closed map 仍只有一个条目。

| code | HTTP | safe message | legacy error type | retryable |
|---|---:|---|---|---:|
| `space_scope_mismatch` | 403 | `Mutation does not belong to the authorized Space` | `authorization_error` | false |
| `version_conflict` | 409 | `Entity version conflict` | `conflict` | false |
| `cycle_detected` | 409 | `Mutation would create a cycle` | `conflict` | false |
| `relation_endpoint_missing` | 409 | `Relation endpoint does not exist` | `conflict` | false |
| `entity_id_mismatch` | 422 | `Entity identity does not match payload` | `validation_error` | false |
| `delete_payload_not_empty` | 422 | `Delete payload must be empty` | `validation_error` | false |
| `idempotency_conflict` | 409 | `Operation ID is already bound to a different request` | `conflict` | false |
| `invalid_payload_hash` | 422 | `Payload hash does not match canonical payload` | `validation_error` | false |
| `invalid_project_key` | 422 | `Project key is invalid` | `validation_error` | false |
| `project_key_conflict` | 409 | `Project key conflict` | `conflict` | false |
| `unsupported_content_version` | 422 | `Content version is unsupported` | `validation_error` | false |
| `invalid_note_document` | 422 | `Note document is invalid` | `validation_error` | false |
| `invalid_work_item_tree` | 422 | `Work item tree is invalid` | `validation_error` | false |
| `not_found` | 404 | `Entity not found` | `not_found` | false |
| `active_child_conflict` | 409 | `An active child prevents this mutation` | `conflict` | false |
| `active_session_exists` | 409 | `An active Session already exists` | `conflict` | false |
| `stale_session_owner` | 409 | `Session ownership is stale` | `conflict` | false |
| `session_activation_conflict` | 409 | `Session activation conflict` | `conflict` | false |
| `offline_formal_creation_forbidden` | 409 | `Formal offline creation is forbidden` | `conflict` | false |
| `command_result_unknown` | 503 | `Command result requires recovery` | `service_unavailable` | true |
| `active_session_recovery_required` | 503 | `Active Session coordination requires recovery` | `service_unavailable` | true |
| `work_item_structure_changed` | 409 | `Work item structure changed` | `conflict` | false |
| `entity_not_sync_enabled` | 422 | `Entity type is not sync-enabled` | `validation_error` | false |

Task 2 的 producer-enumeration test 只扫描此时真实存在的 S3 producer modules；在
Task 4/6 producer 落地前允许实际 producer set 是 `S3_MUTATION_REJECTION_CODES` 的子集，
但每个发现的 literal 必须属于该集合。Task 6 完成后同一测试升级为与
`S3_MUTATION_REJECTION_CODES` 精确相等。TS1/TS2 与 S4 分别在真实 producer 落地时把
对应 reserved 集合加入 exact equality；任何阶段 map key 始终精确等于三个声明集合
的并集，不允许未知或孤儿 code。

S1 `AppError` 已有 `code=` 参数。Task 2 对“直接实例化 base `AppError` 且 code 属于
上述 closed mutation map”的路径增加唯一 resolver：从 spec 绑定 status、safe message、
legacy error type 与 retryable；调用方提供任何冲突 override 时拒绝，unknown mutation
code 也不得降级为默认 500。这样 TS2 计划中的
`AppError(code="active_session_recovery_required")` 精确渲染为表中 503 四元组。
subclass（包括 `MutationRejectedError`/`IdempotencyConflictError`）继续使用各自构造器，
不得经第二套 mapping。测试必须覆盖 direct base error 的 503 映射、冲突 override 拒绝、
unknown code 拒绝，以及 persisted retryable 篡改在 decoder/render 前失败。
Task 2 同时更新 `test_mcp_authorization.py` 中既有的两处 direct
`version_conflict` fixture：只传 `code="version_conflict"` 与 frozen nested details，
不再传旧 message/status/error_type override；断言改为 closed spec 的
`Entity version conflict`/409/`conflict`/false，并继续证明 canonical REST 与 MCP
使用同一 `DomainErrorRecord`、nested source mutation 不改变 wire bytes。

The reserved `invalid_payload_hash` entry is fixed at HTTP `422`, safe message
`"Payload hash does not match canonical payload"`, and `retryable=False`.
`idempotency_conflict` remains a distinct `409` used only when one operation ID
is bound to a different complete S3 request hash.
`active_session_recovery_required` is HTTP `503`, safe message
`"Active Session coordination requires recovery"`, and `retryable=True`; it
never clears or rewrites ambiguous authority as part of error rendering.

`journal.py` 使用以下唯一 transition table：

```python
LEGAL_TRANSITIONS = {
    MutationState.INTENT: frozenset({MutationState.STAGED, MutationState.ABORTED}),
    MutationState.STAGED: frozenset({MutationState.DB_COMMITTED, MutationState.ABORTED}),
    MutationState.DB_COMMITTED: frozenset(
        {MutationState.FINALIZING, MutationState.COMPENSATING, MutationState.FAILED_MANUAL}
    ),
    MutationState.FINALIZING: frozenset(
        {MutationState.FORWARD_APPLIED, MutationState.COMPENSATING, MutationState.FAILED_MANUAL}
    ),
    MutationState.FORWARD_APPLIED: frozenset(
        {MutationState.FINALIZED, MutationState.COMPENSATING, MutationState.FAILED_MANUAL}
    ),
    MutationState.COMPENSATING: frozenset(
        {MutationState.COMPENSATED, MutationState.FAILED_MANUAL}
    ),
    MutationState.FINALIZED: frozenset(),
    MutationState.ABORTED: frozenset(),
    MutationState.COMPENSATED: frozenset(),
    MutationState.FAILED_MANUAL: frozenset(),
}
```

所有 JSON-bearing constructor 统一调用 S1 `app.errors.deep_freeze_json()`；S3 不复制该函数。它递归复制 object/array 为 frozen mapping/tuple，只接受 JSON null/bool/string/finite number/object/array，并拒绝 bytes、datetime、callable、NaN/Infinity 和非字符串 key。`MutationRequest`、`DbMutationPlan`、`SyncEventPlan`、`MutationResult`、`MutationRejection`、`PreparedBatchItem`、`BatchMutationResult`、`MutationRuleViolation` 以及 persisted-command decoder 都在 `__post_init__`（exception 的 `__init__` 显式调用其 `__post_init__`）重验证/冻结直接输入；禁止 shallow `MappingProxyType(dict(...))`。`client_updated_at` 为 Sync 专用 canonical RFC 3339 UTC intent metadata，regular REST request 固定为 `None`；它和 `expected_version` 一起进入 request hash，绝不从 payload 或服务器当前时间补写。`MutationCommand.resolution`/`PersistedMutationCommand.resolution`/`MutationResult.resolution` 只允许成功的 remote-wins 使用 `"remote"`，并进入 command hash 与 batch `result_json`，所以 restart 不重新推断 LWW 结果。`MutationRejection.retryable` 是 compiler/mapper 当时作出的 immutable boolean并和 code/details 一起持久化；S4/REST/MCP 只能投影该值，不得在 restart 后按当前 code table临时推导。`DbMutationPlan` 的 before/after/primary-key 也通过同一 S1 freezer 构造。

Journal CAS 有且仅有两层 API：`transition_in_transaction(session, operation_id, expected, target, ...)` 和 `finalize_batch_in_transaction(session, ...)` 执行 `UPDATE ... WHERE state=:expected`、检查 rowcount并 flush，但绝不 begin/commit；standalone `transition(...)`/`finalize_batch(...)` 包装器自己开 short session transaction并只 commit 一次。UoW 已有 outer transaction 时必须调用 `*_in_transaction`，不得调用 committing wrapper或复制 transition SQL。`_commit_business` 在同一 session/outer commit 内依次应用 business rows、写 before/after、以 transaction-bound CAS 到 DB_COMMITTED、append invisible ledger；任一 fault全部 rollback。最终 batch/child FINALIZED与 visibility也只用 transaction-bound API共享一个 commit。测试分别在 DB row后/transition前、transition后/ledger前注入故障并证明四者都未提交。

Journal 的 `command_json` 保存 `PersistedMutationCommand` canonical JSON：deep-frozen request、JSON-only DB plans，以及 projection 的 store/relative target/ordinal/before-after SHA-256/size/null flags；blob bytes 只存在 StageStore。`result_json` 中 applied/rejected records 也先经上述 typed constructors，再只通过 S1 `to_wire_json()` thaw；不得用 `asdict`、`dict(details)`、shallow copy 或 mutation-local recursive serializer。`MutationCommand.persisted()` 由实际 bytes 计算 descriptors，command hash 覆盖完整 persisted JSON；fresh-process decoder重建 typed command/rejection并再次触发 `__post_init__`，逐项与 stage manifest hash/size和原 persisted canonical bytes 核对后才执行/返回 receipt。不得把 bytes/base64 blob、Python callable 或仅 DB plans 写进 command JSON。`finalize_batch` 在一个 transaction 中确认所有 accepted children 为 `FORWARD_APPLIED`，把所有 child 与 batch 一次性转为 FINALIZED，并把同 batch `SyncOutbox.visible` 设 true。任何 child 未完成时不得更新一行 ledger；任一 child 失败时，其他 `FORWARD_APPLIED` child 仍可进入 COMPENSATING。

- [ ] **Step 4: Run journal state and batch barrier tests**

```powershell
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $true
.\.venv\Scripts\python.exe -m pytest -q tests/test_mutation_journal.py tests/test_compiled_entity_catalog.py tests/test_mcp_authorization.py -p no:cacheprovider
.\.venv\Scripts\ruff.exe check --no-cache app/mutation/types.py app/mutation/journal.py app/registry/entities.py app/registry/catalog.py tests/ast_helpers.py tests/test_mutation_journal.py tests/test_compiled_entity_catalog.py tests/test_mcp_authorization.py
```

Expected: PASS; every illegal shortcut and every terminal escape is rejected, and batch events become visible together.

- [ ] **Step 5: Commit shared mutation types and journal**

```powershell
git add pyproject.toml uv.lock app/mutation/__init__.py app/mutation/types.py app/mutation/journal.py app/errors.py app/registry/entities.py app/registry/catalog.py tests/ast_helpers.py tests/fixtures/task_space_session_payload_hash_vectors.json tests/test_mutation_journal.py tests/test_compiled_entity_catalog.py tests/test_mcp_authorization.py
git commit -m "feat(mutation): enforce closed journal state machine"
```

## Task 3: Build Durable Staging And Safe Orphan Collection

**Files:**
- Modify: `backend/app/runtime/contained_io.py`
- Modify: `backend/app/runtime/space.py`
- Create: `backend/app/mutation/staging.py`
- Create: `backend/tests/test_mutation_staging.py`
- Modify: `backend/tests/test_space_lifecycle.py`
- Modify: `backend/tests/test_space_path_containment.py`

**Interfaces:**
- Consumes: Task 2 `ProjectionPlan`/`PersistedProjectionDescriptor`, S1 opaque contained-handle authority, and S2 same-Task Space-exclusive `Lease`/`FenceReceipt` ownership.
- Produces: package-private `BoundStageDirectory` transferred by `ContainedSpaceOpens`; `SpaceRuntimeHandle.mutation_stages`; `StageStore.publish(operation_id, plans, *, lease, space_id) -> StageManifest`, `verify(operation_id) -> StageManifest`, bounded orphan collection, and content-addressed before/after blob descriptors used identically by happy path and recovery.

- [ ] **Step 1: Write failing stage publication, hash, containment, and orphan tests**

```python
@pytest.mark.asyncio
async def test_stage_is_published_only_after_all_blobs_and_manifest_are_fsynced(
    bound_stage_fixture,
) -> None:
    calls: list[str] = []
    store = StageStore(bound_stage_fixture.authority, observer=calls.append)
    plans = (
        ProjectionPlan("markdown", "notes/n1.md", 0, b"old", b"new"),
        ProjectionPlan("index", "rows/n1.json", 1, None, b'{"id":"n1"}'),
    )

    manifest = await store.publish(
        "op-1", plans,
        lease=bound_stage_fixture.space_exclusive,
        space_id=bound_stage_fixture.space_id,
    )

    assert calls[-3:] == [
        "fsync-temp-directory",
        "rename-published-directory",
        "fsync-parent-directory",
    ]
    assert bound_stage_fixture.published_names() == (manifest.directory_key,)
    assert manifest.manifest_sha256 == store.verify("op-1").manifest_sha256


@pytest.mark.parametrize("target", ["../escape", "/absolute", "C:/escape", "notes/../../escape"])
def test_projection_target_must_be_relative_and_contained(bound_stage_fixture, target: str) -> None:
    with pytest.raises(UnsafeProjectionPathError):
        StageStore(bound_stage_fixture.authority).validate_target(target)


@pytest.mark.asyncio
async def test_orphan_collection_requires_space_exclusive_and_no_live_owner(stage_fixture) -> None:
    stage_fixture.create_temp("orphan")
    with pytest.raises(LeaseOrderError):
        await stage_fixture.store.collect_orphans(
            live_operation_ids=set(), lease=None,
            space_id=stage_fixture.space_id,
        )
    removed = await stage_fixture.store.collect_orphans(
        live_operation_ids=set(), lease=stage_fixture.space_exclusive,
        space_id=stage_fixture.space_id,
    )
    assert removed == ("orphan",)
```

相邻 runtime tests 必须证明 `ContainedSpaceOpens.take_mutation_stage_authority()`
只转交 opaque capability，不返回 `Path`、fd 或 HANDLE；`SpaceRuntimeHandle` 激活时从同一
`open_verified()` 取得它，构造 `mutation_stages`，并在仍持 Space lease 时按
FileSystem -> StageStore -> engine 顺序 collect-all 关闭。read/startup activation 只绑定
authority，不创建 `.mutations` 或其他目录；任一 StageStore close fail-once/persistent
failure 都进入 S2 pending-cleanup owner，资源未关闭前不得释放 Space/global lease。

- [ ] **Step 2: Run staging tests and verify missing StageStore**

```powershell
.\.venv\Scripts\python.exe -m pytest -q tests/test_mutation_staging.py -p no:cacheprovider
```

Expected: FAIL on missing `app.mutation.staging`.

- [ ] **Step 3: Implement content-addressed manifest publication**

`BoundStageDirectory` 只能由 `ContainedSpaceOpens` 从已验证 notes authority 的独立
descriptor/HANDLE 创建，并把所有操作固定在 `.mutations` 命名空间。它只暴露 StageStore
所需的 exact-relative create/read/fsync/rename/direct-child-enumeration/remove-tree 方法；
不暴露 host `Path`、URI、fd/HANDLE 或通用 pathname reopen。Windows 使用相对
handle operations 并拒绝 reparse point，POSIX 使用 `dir_fd` + no-follow；两者都逐级
验证 exact child。StageStore 和 tests 禁止 `Path`, `resolve`, `os.open`、absolute path
或 pathname fallback；测试 fixture 只负责从 `tmp_path` 建立真实 opaque authority，绝不
冒充生产 runtime bootstrap。

`StageStore.publish(operation_id, plans, *, lease, space_id)` 先在 caller owner Task 调用
`lease.assert_active_owner(mode=LeaseMode.EXCLUSIVE, scope=space_id)` 并取得
`FenceReceipt`，再进入 blocking worker。固定：计算
`directory_key = sha256(operation_id.encode("utf-8")).hexdigest()`，创建
`.tmp-{directory_key}-{nonce}`；每 step 分别写 `before/{ordinal}.bin` 和
`after/{ordinal}.bin`（None 在 manifest 显式记 null）；每个 file fsync；写 canonical
ASCII JSON manifest，内容保留原始 operation ID、directory key、ordinal、store、relative
target、before/after SHA-256 和 size；manifest fsync；temp directory fsync；原子 rename
为 `{directory_key}`；`.mutations` parent fsync。每个 namespace/temp/subdirectory
mkdir/create、destructive write、rename、remove 紧邻前先调用同一
`FenceReceipt.assert_current()`。若 final 已存在则 verify 原始 ID 与
相同 hash 后幂等返回，不同则 fail closed。caller-controlled ID 从不进入任何文件名。

公开 records：

```python
@dataclass(frozen=True)
class StageManifest:
    operation_id: str
    directory_key: str
    steps: tuple[StagedStep, ...]
    manifest_sha256: str


class StageStore:
    async def publish(
        self, operation_id: str, plans: tuple[ProjectionPlan, ...],
        *, lease: Lease, space_id: str,
    ) -> StageManifest:
        lease.assert_active_owner(mode=LeaseMode.EXCLUSIVE, scope=space_id)
        receipt = lease.fence_receipt(space_id)
        return await run_joined_thread(
            lambda: self._publish_sync(operation_id, plans, receipt)
        )

    def verify(self, operation_id: str) -> StageManifest:
        return self._load_and_verify(self.operation_dir(operation_id))

    async def collect_orphans(
        self, *, live_operation_ids: set[str], lease: Lease | None,
        space_id: str,
    ) -> tuple[str, ...]:
        receipt = self._require_space_exclusive(lease, space_id)
        return await run_joined_thread(
            lambda: self._collect_sync(live_operation_ids, receipt)
        )
```

删除只允许 opaque authority 枚举出的 `.mutations` 直接 child，名称必须匹配
`.tmp-{64-lowercase-hex}-{nonce}` 或 `{64-lowercase-hex}`；任何 symlink/reparse、非直接
child 或未知名称 fail closed。collector 先把全部 `live_operation_ids` 计算为 SHA-256
directory-key 集合；任何 `.tmp-{directory_key}-{nonce}` 的 key 在 live 集合中必须保留，
即使 crash 发生在 manifest 完整写入前；只有 unknown temp 才可删除。published operation
dir 没有 matching durable record 时也只能
在 same-Task Space-exclusive 且 journal 确认 manifest 中原始 operation ID 无 live owner后
删除。测试必须包含由 `bounded_child_operation_id("batch", "0000")` 生成的 batch child ID
`childp:5:batch:0000`，证明 stage 目录只含 SHA-256 hex、manifest 仍可还原原始 ID；另测
stale fence 在 `.mutations` namespace、temp、before、after 的每次 mkdir/create 以及每个
blob/manifest write、rename/delete boundary 前阻止写入。分别测试 live INTENT temp 保留、
unknown temp 删除、published orphan 删除；cancellation 在每个 worker boundary 发生时由
S2 `run_joined_thread` 等待 physical terminal，worker 结束、StageStore 关闭后才允许 lease
release。

- [ ] **Step 4: Run staging and path-safety tests**

```powershell
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $true
.\.venv\Scripts\python.exe -m pytest -q tests/test_mutation_staging.py tests/test_space_lifecycle.py tests/test_space_path_containment.py -p no:cacheprovider
.\.venv\Scripts\ruff.exe check --no-cache app/runtime/contained_io.py app/runtime/space.py app/mutation/staging.py tests/test_mutation_staging.py tests/test_space_lifecycle.py tests/test_space_path_containment.py
```

Expected: PASS; temp publication ordering、manifest hash、path containment 和 orphan ownership 都有断言。

- [ ] **Step 5: Commit durable staging**

```powershell
git add app/runtime/contained_io.py app/runtime/space.py app/mutation/staging.py tests/test_mutation_staging.py tests/test_space_lifecycle.py tests/test_space_path_containment.py
git commit -m "feat(mutation): persist verified projection stages"
```

## Task 4: Implement MutationUnitOfWork Happy Path And Idempotency

**Files:**
- Create: `backend/app/mutation/unit_of_work.py`
- Modify: `backend/app/errors.py`
- Modify: `backend/app/file_system/interfaces.py`
- Modify: `backend/app/file_system/engine/base.py`
- Modify: `backend/app/mutation/staging.py`
- Modify: `backend/app/mutation/types.py`
- Modify: `backend/app/mutation/journal.py`
- Modify: `backend/app/services/sync_outbox.py`
- Modify: `backend/app/services/base.py`
- Modify: `backend/app/services/cascade.py`
- Modify: `backend/app/services/note.py`
- Modify: `backend/app/services/quick_note.py`
- Modify: `backend/app/services/relation.py`
- Modify: `backend/app/services/sync.py`
- Modify: `backend/app/services/task.py`
- Create: `backend/tests/fixtures/task_space_session_child_operation_id_vectors.json`
- Modify: `backend/tests/fixtures/certification/populate_n_minus_one.py`
- Modify: `backend/tests/test_mutation_journal.py`
- Modify: `backend/tests/test_mutation_staging.py`
- Create: `backend/tests/test_note_workspace_atomicity.py`
- Modify: `backend/tests/test_sync_ledger_retention.py`
- Modify: `backend/tests/test_sync_legacy_fail_closed.py`
- Modify: `backend/tests/test_sync_outbox_service.py`
- Modify: `backend/tests/test_sync_routes.py`
- Modify: `backend/tests/test_sync_cursor_pagination.py`

**Interfaces:**
- Consumes: Task 2 closed journal/types, Task 3 verified stages, S1 canonical `AppError`, S2 `SpaceRuntimeHandle`/combined Space-exclusive lease/fence, and `CompiledEntityCatalog.effective_sync_entity_type`.
- Produces: `MutationUnitOfWork.execute(scope, request, operation_id) -> MutationResult`, `execute_batch(scope, requests, batch_id, *, operation_ids=None) -> BatchMutationResult`, `execute_prepared_batch(scope, items, batch_id) -> BatchMutationResult`; mandatory read-only `RecoveryGate.require_clean_under_lease(scope, lease, journal)`; one operation-bound `FencedProjectionExecutor` interface; opaque `StageStore.materialize(operation_id, descriptors, *, image, receipt)`; `MutationJournal.find_operation_batch_bindings(operation_ids)` as one pre-authority query; ordered zero-to-many invisible ledger appends per accepted command that advance `SyncState.current_cursor` in the same transaction; the authoritative tracked `child-v1` vector fixture consumed byte-for-byte by TS3.

- [ ] **Step 1: Author the shared child-ID oracle and write failing single-command, retry, conflict, and visibility tests**

Create `backend/tests/fixtures/task_space_session_child_operation_id_vectors.json` once from the literal oracle below. The tracked JSON bytes, not this authoring snippet or either language implementation, become the cross-wave authority. Keep `ensure_ascii=True`, two-space indentation, a final LF, the exact top-level keys `algorithm`, `valid`, `invalid`, and the exact vector order. Do not regenerate expected hashes by importing `bounded_child_operation_id`.

```python
import json
from pathlib import Path

fixture = {
    "algorithm": "child-v1",
    "valid": [
        {
            "name": "colon_parent",
            "parent_id": "a:receipt",
            "suffix": "pending",
            "expected": "childp:9:a:receipt:pending",
        },
        {
            "name": "colon_suffix",
            "parent_id": "a",
            "suffix": "receipt:pending",
            "expected": "childp:1:a:receipt:pending",
        },
        {
            "name": "plain_result_127",
            "parent_id": "p",
            "suffix": "s" * 116,
            "expected": f"childp:1:p:{'s' * 116}",
        },
        {
            "name": "plain_result_128",
            "parent_id": "p",
            "suffix": "s" * 117,
            "expected": f"childp:1:p:{'s' * 117}",
        },
        {
            "name": "first_overflow_129",
            "parent_id": "p",
            "suffix": "s" * 118,
            "expected": "childh:693301fc7e44c9a0dd041ba5cfd40b79ed955227252d05216e80359feb28df15",
        },
        {
            "name": "parent_127",
            "parent_id": "r" * 127,
            "suffix": "focus_session",
            "expected": "childh:6ab289f80ba8a36bd167e9c88f4493612f1f3ed2902353b2a8d13bf559972891",
        },
        {
            "name": "parent_128",
            "parent_id": "r" * 128,
            "suffix": "focus_session",
            "expected": "childh:256b15192a126e33bdb061e96487c1412033e8eaea0e26bc522c52c414702d55",
        },
        {
            "name": "suffix_512",
            "parent_id": "p",
            "suffix": "s" * 512,
            "expected": "childh:9ed298adfe1ff5a387b2cb182ffc58dbe9dc10258e49179fea338ef13f396edf",
        },
    ],
    "invalid": [
        {
            "name": "suffix_513",
            "parent_id": "p",
            "suffix": "s" * 513,
            "error": "invalid child operation suffix",
        },
        {
            "name": "suffix_non_ascii",
            "parent_id": "p",
            "suffix": "\u8ba1\u5212",
            "error": "invalid child operation suffix",
        },
    ],
}
target = Path("tests/fixtures/task_space_session_child_operation_id_vectors.json")
target.parent.mkdir(parents=True, exist_ok=True)
target.write_text(
    json.dumps(fixture, ensure_ascii=True, indent=2) + "\n",
    encoding="utf-8",
    newline="\n",
)
```

```python
@pytest.mark.asyncio
async def test_execute_orders_durable_boundaries_and_returns_only_after_finalized(uow_fixture) -> None:
    request = uow_fixture.note_create_request("n1", "Body")

    result = await uow_fixture.uow.execute(uow_fixture.scope, request, "op-create-n1")

    assert result.state is MutationState.FINALIZED
    assert uow_fixture.observed == [
        "INTENT-committed",
        "stage-published",
        "STAGED-committed",
        "business-and-DB_COMMITTED-committed",
        "FINALIZING-committed",
        "markdown-finalized",
        "index-finalized",
        "fts-finalized",
        "FORWARD_APPLIED-committed",
        "FINALIZED-and-ledger-visible-committed",
    ]
    assert await uow_fixture.visible_events("op-create-n1") == 1


@pytest.mark.asyncio
async def test_same_operation_and_hash_returns_stored_result_without_reapplying(uow_fixture) -> None:
    request = uow_fixture.note_create_request("n1", "Body")
    first = await uow_fixture.uow.execute(uow_fixture.scope, request, "op-1")
    writes = uow_fixture.projection_write_count

    second = await uow_fixture.uow.execute(uow_fixture.scope, request, "op-1")

    assert second == first
    assert uow_fixture.projection_write_count == writes
    assert await uow_fixture.operation_count("op-1") == 1


@pytest.mark.asyncio
async def test_reused_operation_with_different_hash_fails_before_stage(uow_fixture) -> None:
    await uow_fixture.uow.execute(
        uow_fixture.scope, uow_fixture.note_create_request("n1", "A"), "op-1"
    )
    with pytest.raises(IdempotencyConflictError) as captured:
        await uow_fixture.uow.execute(
            uow_fixture.scope, uow_fixture.note_create_request("n1", "B"), "op-1"
        )
    assert captured.value.code == "idempotency_conflict"


@pytest.mark.asyncio
@pytest.mark.parametrize("second_body", ("A", "B"))
async def test_operation_id_cannot_move_to_another_batch_before_compilation(
    uow_fixture, second_body: str,
) -> None:
    request = uow_fixture.note_create_request("n1", "A")
    await uow_fixture.uow.execute_batch(
        uow_fixture.scope, (request,), "batch-a", operation_ids=("shared-op",)
    )
    await uow_fixture.restart()
    compiler_calls = uow_fixture.compiler_compile_count
    authority_reads = uow_fixture.authority_read_count
    with pytest.raises(IdempotencyConflictError):
        await uow_fixture.uow.execute_batch(
            uow_fixture.scope,
            (uow_fixture.note_create_request("n1", second_body),),
            "batch-b",
            operation_ids=("shared-op",),
        )
    assert uow_fixture.compiler_compile_count == compiler_calls
    assert uow_fixture.authority_read_count == authority_reads
    assert await uow_fixture.batch_count("batch-b") == 0
    assert await uow_fixture.stage_count("batch-b") == 0


@pytest.mark.asyncio
async def test_batch_preserves_caller_ids_and_collects_locked_rule_rejections(uow_fixture) -> None:
    requests = (
        uow_fixture.task_update_request("t1", expected_version=1),
        uow_fixture.folder_cycle_request("f1", parent_id="f1", expected_version=2),
    )
    outcome = await uow_fixture.uow.execute_batch(
        uow_fixture.scope,
        requests,
        "sync-batch-1",
        operation_ids=("client-op-1", "client-op-2"),
    )

    assert tuple(item.operation_id for item in outcome.applied) == ("client-op-1",)
    assert tuple(item.operation_id for item in outcome.rejected) == ("client-op-2",)
    assert outcome.rejected[0].code == "cycle_detected"
    assert await uow_fixture.operation_count("client-op-2") == 0
    assert await uow_fixture.visible_events("client-op-2") == 0


@pytest.mark.asyncio
async def test_prepared_mapping_rejection_is_in_the_restart_stable_batch_receipt(
    uow_fixture,
) -> None:
    raw_intents = uow_fixture.prepared_sync_items(
        accepted_operation_id="client-op-1",
        rejected_operation_id="client-op-2",
    )
    first = await uow_fixture.uow.execute_prepared_batch(
        uow_fixture.scope, raw_intents, "sync-batch-prepared"
    )
    await uow_fixture.restart_with_catalog_that_now_maps_the_rejected_entity()
    retry_items = uow_fixture.reclassify_same_raw_intents(raw_intents)

    second = await uow_fixture.uow.execute_prepared_batch(
        uow_fixture.scope, retry_items, "sync-batch-prepared"
    )

    assert second == first
    assert tuple(item.operation_id for item in second.rejected) == ("client-op-2",)
    assert await uow_fixture.operation_count("client-op-2") == 0
    assert await uow_fixture.stage_count("client-op-2") == 0
    assert await uow_fixture.visible_events("client-op-2") == 0


@pytest.mark.asyncio
async def test_batch_compiler_overlays_parent_create_for_dependent_child(uow_fixture) -> None:
    outcome = await uow_fixture.uow.execute_batch(
        uow_fixture.scope,
        (
            uow_fixture.folder_create_request("f-new"),
            uow_fixture.note_create_request("n-new", folder_id="f-new"),
        ),
        "dependent-batch",
    )
    assert [item.entity_id for item in outcome.applied] == ["f-new", "n-new"]
    assert outcome.rejected == ()


@pytest.mark.asyncio
async def test_batch_overlay_carries_authoritative_markdown_between_children(uow_fixture) -> None:
    outcome = await uow_fixture.uow.execute_batch(
        uow_fixture.scope,
        (
            uow_fixture.note_update_request("n1", body="first", expected_version=1),
            uow_fixture.note_update_request("n1", body="second", expected_version=2),
        ),
        "dependent-note-body",
    )
    assert outcome.rejected == ()
    assert await uow_fixture.note_body("n1") == "second"


@pytest.mark.asyncio
async def test_batch_overlay_carries_move_target_into_metadata_update(uow_fixture) -> None:
    outcome = await uow_fixture.uow.execute_batch(
        uow_fixture.scope,
        (
            uow_fixture.note_move_request("n1", folder_id="f2", expected_version=1),
            uow_fixture.note_update_request("n1", title="renamed", expected_version=2),
        ),
        "dependent-note-move",
    )
    assert outcome.rejected == ()
    assert await uow_fixture.note_relative_path("n1") == "f2/renamed.md"


@pytest.mark.asyncio
async def test_one_command_publishes_multiple_sync_effects_atomically(uow_fixture) -> None:
    request = uow_fixture.compound_request(
        operation_id="promote-1",
        effects=(
            uow_fixture.sync_effect("workItem", "wi-new", "create", version=1),
            uow_fixture.sync_effect("workItemNote", "note-1", "update", version=4),
        ),
    )

    result = await uow_fixture.uow.execute(uow_fixture.scope, request, "promote-1")

    assert result.state is MutationState.FINALIZED
    events = await uow_fixture.events_for_operation("promote-1")
    assert [(event.entity_type, event.visible) for event in events] == [
        ("workItem", True),
        ("workItemNote", True),
    ]


@pytest.mark.asyncio
async def test_multiple_sync_effects_roll_back_and_stay_invisible_together(
    uow_fixture,
) -> None:
    request = uow_fixture.compound_request(
        operation_id="promote-fail",
        effects=(
            uow_fixture.sync_effect("workItem", "wi-new", "create", version=1),
            uow_fixture.sync_effect("workItemNote", "note-1", "update", version=4),
        ),
    )
    uow_fixture.inject_after_ledger_append(index=1)

    with pytest.raises(InjectedCrash):
        await uow_fixture.uow.execute(uow_fixture.scope, request, "promote-fail")

    assert await uow_fixture.events_for_operation("promote-fail") == ()
    assert await uow_fixture.entity_exists("workItem", "wi-new") is False


def test_every_record_sync_event_call_chooses_visibility_explicitly() -> None:
    callers = python_call_sites(BACKEND_APP, "record_sync_event")
    assert callers
    for call in callers:
        relative = call.path.relative_to(BACKEND_APP)
        assert call.has_keyword("visible"), call.location
        if relative == Path("mutation/unit_of_work.py"):
            assert call.keyword_literal("visible") is False, call.location
        elif relative.parts[0] == "services":
            assert call.keyword_literal("visible") is True, call.location
        else:
            pytest.fail(f"unowned sync ledger writer: {call.location}")


@pytest.mark.asyncio
async def test_invisible_append_and_allocated_watermark_share_business_commit(
    uow_fixture,
) -> None:
    before = await uow_fixture.sync_state()
    uow_fixture.inject_before_business_commit()
    with pytest.raises(InjectedCrash):
        await uow_fixture.execute_until_injected(
            uow_fixture.note_create_request("n-watermark", "Body"),
            "op-watermark",
        )
    assert await uow_fixture.sync_state() == before
    assert await uow_fixture.ledger_event("op-watermark") is None

    await uow_fixture.restart()
    event = await uow_fixture.execute_until_db_committed(
        uow_fixture.note_create_request("n-watermark", "Body"),
        "op-watermark",
    )
    state = await uow_fixture.sync_state()
    assert event.visible is False
    assert state.current_cursor == event.id
    assert state.retention_floor <= state.current_cursor


def test_authoritative_child_operation_id_vectors_match_in_process_and_fresh_process() -> None:
    import json
    import subprocess
    import sys
    from pathlib import Path

    backend_root = Path(__file__).parents[1]
    fixture_path = (
        Path(__file__).parent
        / "fixtures"
        / "task_space_session_child_operation_id_vectors.json"
    )
    raw = fixture_path.read_bytes()
    vectors = json.loads(raw)
    assert tuple(vectors) == ("algorithm", "valid", "invalid")
    assert vectors["algorithm"] == "child-v1"
    assert [item["name"] for item in vectors["valid"]] == [
        "colon_parent", "colon_suffix", "plain_result_127", "plain_result_128",
        "first_overflow_129", "parent_127", "parent_128", "suffix_512",
    ]
    assert [item["name"] for item in vectors["invalid"]] == [
        "suffix_513", "suffix_non_ascii",
    ]
    assert raw.endswith(b"\n") and b"\r\n" not in raw

    for vector in vectors["valid"]:
        actual = bounded_child_operation_id(vector["parent_id"], vector["suffix"])
        assert actual == vector["expected"], vector["name"]
        validate_operation_id(actual)
    assert len(vectors["valid"][2]["expected"].encode("ascii")) == 127
    assert len(vectors["valid"][3]["expected"].encode("ascii")) == 128
    assert vectors["valid"][4]["expected"].startswith("childh:")

    for vector in vectors["invalid"]:
        with pytest.raises(ValueError, match=vector["error"]):
            bounded_child_operation_id(vector["parent_id"], vector["suffix"])

    probe = vectors["valid"][6]
    completed = subprocess.run(
        [
            sys.executable,
            "-I",
            "-c",
            (
                "import sys; sys.path.insert(0, sys.argv[1]); "
                "from app.mutation.types import bounded_child_operation_id; "
                "print(bounded_child_operation_id(sys.argv[2], sys.argv[3]))"
            ),
            str(backend_root),
            probe["parent_id"],
            probe["suffix"],
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    assert completed.stdout.strip() == probe["expected"]
```

The same files add `test_dirty_recovery_gate_raises_canonical_error_before_batch_read`, which injects a read-only dirty gate and asserts `SpaceRecoveryRequiredError.code == "space_recovery_required"` plus zero batch/authority/compiler/stage writes, and `test_projection_executor_asserts_fence_immediately_before_each_destructive_action`, parameterized over Markdown write, relative-path rename/remove, index update, and FTS update. A stale receipt must fail before the observed action count changes. Test fixtures must inject an explicit gate and journal factory; an omitted dependency or unconditional clean/no-op gate is not a valid fixture.

`test_mutation_staging.py` adds `test_stage_materialize_after_returns_closed_actions`, `test_stage_materialize_before_derives_exact_inverse_actions`, plus parameterized rejection cases for wrong operation ID, non-exact descriptors, blob hash/size drift, invalid image side, and any stage-path/caller-filename leak. `test_note_workspace_atomicity.py` adds `test_uow_nonempty_projection_stages_materialize_all_closed_tags`, covering `markdown_write`, `path_rename`, `path_remove`, `index_replace`, and `fts_replace`, and `test_stale_projection_fence_performs_zero_actions`. The stale-fence assertion observes zero contained primitive calls, not merely zero finalized journal rows.

- [ ] **Step 2: Run focused UoW tests and verify missing orchestrator failures**

```powershell
.\.venv\Scripts\python.exe -m pytest -q tests/test_mutation_journal.py tests/test_mutation_staging.py tests/test_note_workspace_atomicity.py -p no:cacheprovider
```

Expected: FAIL on missing `MutationUnitOfWork`.

- [ ] **Step 3: Implement the exact public interface and commit barriers**

Task 4 replaces Task 2's provisional `ProjectionPlan.store: str` / `PersistedProjectionDescriptor.store: str` fields while it modifies `mutation/types.py`. The persisted command remains operation-ID-free: do not add `operation_id` to `PersistedMutationCommand`; operation ownership stays in `MutationOperation`. The replacement is one closed tag enum and tag-specific contained logical fields:

```python
class ProjectionActionTag(StrEnum):
    MARKDOWN_WRITE = "markdown_write"
    PATH_RENAME = "path_rename"
    PATH_REMOVE = "path_remove"
    INDEX_REPLACE = "index_replace"
    FTS_REPLACE = "fts_replace"


@dataclass(frozen=True, slots=True)
class ProjectionPlan:
    tag: ProjectionActionTag
    source: ContainedProjectionActionField | None
    target: ContainedProjectionActionField
    ordinal: int
    before: bytes | None
    after: bytes | None


@dataclass(frozen=True, slots=True)
class PersistedProjectionDescriptor:
    tag: ProjectionActionTag
    source: ContainedProjectionActionField | None
    target: ContainedProjectionActionField
    ordinal: int
    before_sha256: str | None
    before_size: int | None
    after_sha256: str | None
    after_size: int | None
```

`ContainedProjectionActionField` validates one normalized relative logical action field: no absolute path, `..`, backslash, URI scheme, drive/device prefix, NUL, stage namespace, or stage blob name. `source` is required exactly for `ProjectionActionTag.PATH_RENAME` and must be `None` for every other tag; `target` is required for every tag. `PATH_RENAME` requires both byte images null, `PATH_REMOVE` requires a non-null before image and null after image, `MARKDOWN_WRITE` requires a non-null after image and permits a null before image, and `INDEX_REPLACE`/`FTS_REPLACE` require at least one non-null side. Constructors reject unknown string tags rather than preserving them. The descriptor contains only final contained logical source/target fields and expected image identity; it never contains an internal stage key or location.

Task 4 extends Task 3's `StageStore` with an opaque materialization boundary. The record is transient, immutable, closed by `ProjectionActionTag`, and contains selected verified bytes plus final contained logical fields only:

```python
@dataclass(frozen=True, slots=True)
class MaterializedProjectionAction:
    tag: ProjectionActionTag
    source: ContainedProjectionActionField | None
    target: ContainedProjectionActionField
    ordinal: int
    blob: bytes | None


class StageStore:
    async def materialize(
        self,
        operation_id: str,
        descriptors: tuple[PersistedProjectionDescriptor, ...],
        *,
        image: Literal["before", "after"],
        receipt: FenceReceipt,
    ) -> tuple[MaterializedProjectionAction, ...]:
        return await run_joined_thread(
            self._materialize_sync, operation_id, descriptors, image, receipt
        )
```

`_materialize_sync` validates `operation_id`, derives the SHA-256 directory key internally, loads the canonical manifest through the existing opaque `BoundStageDirectory`, and verifies canonical manifest operation identity, the exact ordered descriptor tuple, tag/source/target/ordinal equality, selected nullability, and selected blob SHA-256/size before constructing any record. Only after those exact checks does it derive the selected-side executable action: `after` preserves the descriptor tag/fields; `before` swaps `PATH_RENAME` source/target, maps `PATH_REMOVE` with its required non-null before bytes to `MARKDOWN_WRITE`, and maps `MARKDOWN_WRITE` with a null before image to `PATH_REMOVE` (otherwise it remains `MARKDOWN_WRITE`). `INDEX_REPLACE` and `FTS_REPLACE` retain their tag with the selected before blob; a null selected blob means delete through that one contained replace primitive. Thus a returned action tag may differ from the verified persisted descriptor tag, but only by this closed inverse table. `image` accepts only literal runtime values `before` or `after`. The caller cannot supply or receive a stage-relative path, `Path`, URI, fd/HANDLE, directory key, blob key, caller filename, or staged filename; materialization derives the selected blob key and reads bytes internally without reopening any namespace or host path. Any mismatch closes materialization with no returned prefix and no contained projection action.

`errors.py` owns the canonical fail-closed carrier used by the Task 4 gate and the Task 5 recovery/runtime paths; no mutation-local exception or plain `RuntimeError` may replace it:

```python
class SpaceRecoveryRequiredError(AppError):
    detail = "Space mutation recovery is required"
    status_code = 503
    legacy_error_type = "service_unavailable"
    code = "space_recovery_required"
    retryable = True
```

`file_system/interfaces.py` owns the only projection execution protocol, while `file_system/engine/base.py` owns its contained-authority implementation. Both forward and compensation receive the current `FenceReceipt`; the base interpreter decodes persisted descriptors into exactly one Markdown/path/index/FTS destructive action per iteration and asserts the receipt on the immediately preceding line. The executor never accepts an absolute/host path, never reopens a path or URI, and never falls back to a path-backed constructor.

```python
class FencedProjectionExecutor(Protocol):
    async def apply_forward(
        self,
        scope: SpaceRuntimeHandle,
        operation_id: str,
        command: PersistedMutationCommand,
        receipt: FenceReceipt,
    ) -> None: ...

    async def restore_before(
        self,
        scope: SpaceRuntimeHandle,
        operation_id: str,
        command: PersistedMutationCommand,
        receipt: FenceReceipt,
    ) -> None: ...
```

```python
class FileSystemProjectionExecutor(FencedProjectionExecutor):
    async def apply_forward(
        self,
        scope: SpaceRuntimeHandle,
        operation_id: str,
        command: PersistedMutationCommand,
        receipt: FenceReceipt,
    ) -> None:
        actions = await scope.mutation_stages.materialize(
            operation_id, command.projections, image="after", receipt=receipt
        )
        await self._execute_actions(scope, actions, receipt)

    async def restore_before(
        self,
        scope: SpaceRuntimeHandle,
        operation_id: str,
        command: PersistedMutationCommand,
        receipt: FenceReceipt,
    ) -> None:
        actions = await scope.mutation_stages.materialize(
            operation_id, command.projections, image="before", receipt=receipt
        )
        await self._execute_actions(scope, actions, receipt)

    async def _execute_actions(
        self,
        scope: SpaceRuntimeHandle,
        actions: Sequence[MaterializedProjectionAction],
        receipt: FenceReceipt,
    ) -> None:
        for action in actions:
            await run_joined_thread(
                self._apply_one_contained_action, scope, action, receipt
            )

    def _apply_one_contained_action(
        self,
        scope: SpaceRuntimeHandle,
        action: MaterializedProjectionAction,
        receipt: FenceReceipt,
    ) -> None:
        match action.tag:
            case ProjectionActionTag.MARKDOWN_WRITE:
                receipt.assert_current()
                self._apply_markdown_write(scope, action)
            case ProjectionActionTag.PATH_RENAME:
                receipt.assert_current()
                self._apply_path_rename(scope, action)
            case ProjectionActionTag.PATH_REMOVE:
                receipt.assert_current()
                self._apply_path_remove(scope, action)
            case ProjectionActionTag.INDEX_REPLACE:
                receipt.assert_current()
                self._apply_index_replace(scope, action)
            case ProjectionActionTag.FTS_REPLACE:
                receipt.assert_current()
                self._apply_fts_replace(scope, action)
            case unreachable:
                assert_never(unreachable)
```

`_apply_one_contained_action` is a closed exhaustive dispatch over the five `ProjectionActionTag` values and maps one `MaterializedProjectionAction` to exactly one contained Markdown write, relative rename, relative remove, index replace, or FTS replace. It never groups actions, interprets a caller string as a store, opens a stage name, or performs more than one primitive. The worker-local `receipt.assert_current()` remains on the immediately preceding executable line for every primitive.

Task 4's injected `RecoveryGate` is intentionally read-only and has only two legal outcomes: return after a durable clean proof, or raise canonical `SpaceRecoveryRequiredError`. It never repairs, replays, aborts, compensates, mutates journal state, or supplies an unconditional/no-op success path. The constructor requires the gate with no default. Concrete `MutationRecovery`, `SpaceDataView`, `MutationUnitOfWork.recover_under_lease`, and `MutationUnitOfWork.inspect_recovery` belong to Task 5.

`types.py` owns and exports the cross-wave helper so TS1/TS2 do not import the UoW orchestrator or create a second implementation:

```python
def bounded_child_operation_id(parent_id: str, suffix: str) -> str:
    """Derive one deterministic ASCII child ID without exceeding 128 bytes."""
    validate_operation_id(parent_id)
    if not suffix or not suffix.isascii() or len(suffix.encode("ascii")) > 512 or any(
        character not in "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._:-"
        for character in suffix
    ):
        raise ValueError("invalid child operation suffix")
    parent_bytes = parent_id.encode("ascii")
    suffix_bytes = suffix.encode("ascii")
    candidate = f"childp:{len(parent_bytes)}:{parent_id}:{suffix}"
    if len(candidate.encode("ascii")) <= 128:
        validate_operation_id(candidate)
        return candidate
    digest = hashlib.sha256(
        b"child-v1\0"
        + len(parent_bytes).to_bytes(2, "big")
        + parent_bytes
        + suffix_bytes
    ).hexdigest()
    bounded = f"childh:{digest}"
    validate_operation_id(bounded)
    return bounded
```

`unit_of_work.py` imports that owner and must expose the following continuous compiler/interpreter/UoW contract in one implementation block:

```python
from app.mutation.types import bounded_child_operation_id


@dataclass(frozen=True, slots=True)
class BatchCompilation:
    operation_ids: tuple[str, ...]
    commands: tuple[MutationCommand, ...]
    rejected: tuple[MutationRejection, ...]


class DbMutationPlanFactory(Protocol):
    def insert(self, row: object) -> DbMutationPlan: ...
    def update(self, before: object, after: object) -> DbMutationPlan: ...
    def delete(self, row: object) -> DbMutationPlan: ...


class SyncEventPlanFactory(Protocol):
    def create(self, row: object) -> SyncEventPlan: ...
    def update(self, row: object) -> SyncEventPlan: ...
    def delete(self, row: object, *, deleted_at: str) -> SyncEventPlan: ...


@dataclass(frozen=True, slots=True)
class MutationCompileContext:
    scope: SpaceRuntimeHandle
    authority: AuthorityOverlay
    catalog: CompiledEntityCatalog
    db: DbMutationPlanFactory
    sync: SyncEventPlanFactory

    def require_space(self, payload_space_id: str) -> None:
        if payload_space_id != self.scope.scope.space_id:
            raise MutationRuleViolation(
                "space_scope_mismatch",
                {
                    "scopeSpaceId": self.scope.scope.space_id,
                    "payloadSpaceId": payload_space_id,
                },
            )

    def command(
        self,
        *,
        request: MutationRequest,
        db_plans: Sequence[DbMutationPlan],
        sync_events: Sequence[SyncEventPlan],
        value: Mapping[str, object],
        projections: Sequence[ProjectionPlan] = (),
        resolution: Literal["remote"] | None = None,
    ) -> MutationCommand:
        frozen_value = require_frozen_object(value)
        canonical = canonical_command_bytes(
            request=request,
            db_plans=tuple(db_plans),
            projections=tuple(projections),
            sync_events=tuple(sync_events),
            result_value=frozen_value,
            resolution=resolution,
        )
        return MutationCommand(
            request=request,
            db_plans=tuple(db_plans),
            projections=tuple(projections),
            sync_events=tuple(sync_events),
            result_value=frozen_value,
            resolution=resolution,
            command_hash=hashlib.sha256(canonical).hexdigest(),
        )


class MutationDomainPolicy(Protocol):
    @property
    def entity_types(self) -> frozenset[str]: ...

    async def compile(
        self,
        context: MutationCompileContext,
        request: MutationRequest,
    ) -> MutationCommand: ...


class MutationCompiler:
    def __init__(
        self,
        catalog: CompiledEntityCatalog,
        policies: Sequence[MutationDomainPolicy] = (),
    ) -> None:
        self.catalog = catalog
        self._policies: dict[str, MutationDomainPolicy] = {}
        for policy in policies:
            for entity_type in policy.entity_types:
                if entity_type in self._policies:
                    raise ValueError(f"duplicate mutation policy: {entity_type}")
                self._policies[entity_type] = policy

    async def compile_against_overlay(
        self,
        scope: SpaceRuntimeHandle,
        request: MutationRequest,
        overlay: AuthorityOverlay,
    ) -> MutationCommand:
        context = MutationCompileContext(
            scope=scope,
            authority=overlay,
            catalog=self.catalog,
            db=DbMutationPlanFactoryImpl(self.catalog),
            sync=SyncEventPlanFactoryImpl(self.catalog),
        )
        policy = self._policies.get(request.entity_type)
        if policy is not None:
            return await policy.compile(context, request)
        return await compile_catalog_entity_command(context, request)

    async def compile_batch(
        self,
        scope: SpaceRuntimeHandle,
        items: Sequence[PreparedBatchItem],
        session: AsyncSession,
    ) -> BatchCompilation:
        overlay = await AuthorityOverlay.from_locked_authorities(
            scope, session, self.catalog
        )
        accepted_ids: list[str] = []
        commands: list[MutationCommand] = []
        rejected: list[MutationRejection] = []
        for item in items:
            if item.request is None:
                continue
            request = item.request
            try:
                command = await self.compile_against_overlay(scope, request, overlay)
            except MutationRuleViolation as exc:
                rejected.append(MutationRejection(
                    item.request_index, item.operation_id,
                    request.entity_type, request.entity_id,
                    exc.code, exc.retryable, exc.details,
                ))
            else:
                overlay.apply(command)
                accepted_ids.append(item.operation_id)
                commands.append(command)
        return BatchCompilation(tuple(accepted_ids), tuple(commands), tuple(rejected))


class DbMutationInterpreter:
    def __init__(self, catalog: CompiledEntityCatalog) -> None:
        self.catalog = catalog

    def decode_command(self, command_json: str) -> PersistedMutationCommand:
        return decode_and_validate_persisted_command(command_json, catalog=self.catalog)

    async def apply(
        self, session: AsyncSession, plans: Sequence[DbMutationPlan]
    ) -> tuple[Mapping[str, object], ...]:
        return await apply_catalog_plans(session, self.catalog, plans)

    async def restore_before(
        self, session: AsyncSession, plans: Sequence[DbMutationPlan]
    ) -> None:
        await restore_catalog_before_rows(session, self.catalog, plans)


def child_operation_ids(batch_id: str, count: int) -> tuple[str, ...]:
    return tuple(
        bounded_child_operation_id(batch_id, f"{index:04d}")
        for index in range(count)
    )


class RecoveryGate(Protocol):
    async def require_clean_under_lease(
        self,
        scope: SpaceRuntimeHandle,
        lease: Lease,
        journal: MutationJournal,
    ) -> None: ...


class MutationJournalFactory(Protocol):
    def __call__(self, session_factory: async_sessionmaker[AsyncSession]) -> MutationJournal: ...


class MutationUnitOfWork:
    def __init__(
        self,
        *,
        catalog: CompiledEntityCatalog,
        compiler: MutationCompiler,
        interpreter: DbMutationInterpreter,
        projection_executor: FencedProjectionExecutor,
        recovery_gate: RecoveryGate,
        journal_factory: MutationJournalFactory,
    ) -> None:
        self.catalog = catalog
        self.compiler = compiler
        self.interpreter = interpreter
        self.projection_executor = projection_executor
        self.recovery_gate = recovery_gate
        self.journal_factory = journal_factory

    async def execute(
        self,
        scope: SpaceRuntimeHandle,
        request: MutationRequest,
        operation_id: str,
    ) -> MutationResult:
        outcome = await self.execute_batch(
            scope, (request,), operation_id, operation_ids=(operation_id,)
        )
        if outcome.rejected:
            raise MutationRejectedError(outcome.rejected[0])
        return outcome.applied[0]

    async def execute_batch(
        self,
        scope: SpaceRuntimeHandle,
        requests: Sequence[MutationRequest],
        batch_id: str,
        *,
        operation_ids: Sequence[str] | None = None,
    ) -> BatchMutationResult:
        requested = tuple(requests)
        resolved_ids = (
            tuple(operation_ids)
            if operation_ids is not None
            else child_operation_ids(batch_id, len(requested))
        )
        if len(resolved_ids) != len(requested) or len(set(resolved_ids)) != len(resolved_ids):
            raise ValueError("operation_ids must be unique and align with requests")
        return await self.execute_prepared_batch(
            scope,
            tuple(
                PreparedBatchItem(
                    request_index=index,
                    operation_id=operation_id,
                    intent_hash=request.request_hash,
                    request=request,
                    pre_rejection=None,
                )
                for index, (operation_id, request) in enumerate(
                    zip(resolved_ids, requested, strict=True)
                )
            ),
            batch_id,
        )

    async def execute_prepared_batch(
        self,
        scope: SpaceRuntimeHandle,
        items: Sequence[PreparedBatchItem],
        batch_id: str,
    ) -> BatchMutationResult:
        validate_operation_id(batch_id)
        prepared = tuple(items)
        if not prepared:
            return BatchMutationResult(batch_id, (), ())
        expected_indices = tuple(range(len(prepared)))
        if tuple(item.request_index for item in prepared) != expected_indices:
            raise ValueError("prepared items must have contiguous input-order indices")
        operation_ids = tuple(item.operation_id for item in prepared)
        if len(set(operation_ids)) != len(operation_ids):
            raise ValueError("prepared operation IDs must be unique")
        for operation_id in operation_ids:
            validate_operation_id(operation_id)
        request_hash = hash_prepared_batch_identity(
            tuple(
                (item.request_index, item.operation_id, item.intent_hash)
                for item in prepared
            )
        )
        async with scope.exclusive_space_resources("mutation", 5) as lease:
            journal = self.journal_factory(scope.session_factory)
            await self.recovery_gate.require_clean_under_lease(scope, lease, journal)
            existing = await journal.find_batch(batch_id)
            if existing is not None:
                return await self._resume_or_return(
                    scope, journal, existing, request_hash, lease
                )
            bindings = await journal.find_operation_batch_bindings(operation_ids)
            foreign_bindings = tuple(sorted(
                (operation_id, owner_batch_id)
                for operation_id, owner_batch_id in bindings.items()
                if owner_batch_id != batch_id
            ))
            if foreign_bindings:
                operation_id, owner_batch_id = foreign_bindings[0]
                raise IdempotencyConflictError(
                    operation_id=operation_id,
                    existing_batch_id=owner_batch_id,
                    requested_batch_id=batch_id,
                )
            if bindings:
                raise SpaceRecoveryRequiredError(
                    "operation binding exists without its owning batch receipt"
                )
            async with scope.session_factory() as session:
                compilation = await self.compiler.compile_batch(
                    scope, prepared, session,
                )
            rejections = tuple(sorted(
                (
                    *(item.pre_rejection for item in prepared if item.pre_rejection is not None),
                    *compilation.rejected,
                ),
                key=lambda rejection: rejection.request_index,
            ))
            if not compilation.commands:
                return await journal.record_rejected_batch(
                    batch_id, request_hash, rejections
                )
            await journal.create_batch_intent(
                batch_id,
                request_hash,
                compilation.operation_ids,
                compilation.commands,
                rejections,
            )
            manifests = await self._publish_stages(
                scope, lease, compilation.operation_ids, compilation.commands
            )
            await journal.mark_staged(batch_id, manifests)
            await self._commit_business(
                scope, journal, batch_id, compilation.operation_ids, compilation.commands
            )
            await journal.mark_finalizing(batch_id)
            await self._finalize_forward(
                scope,
                journal,
                compilation.operation_ids,
                compilation.commands,
                lease.fence_receipt(scope.scope.space_id),
            )
            return await journal.finalize_batch(batch_id)

    async def _finalize_forward(
        self,
        scope: SpaceRuntimeHandle,
        journal: MutationJournal,
        operation_ids: Sequence[str],
        commands: Sequence[MutationCommand],
        receipt: FenceReceipt,
    ) -> None:
        for operation_id, command in zip(operation_ids, commands, strict=True):
            await self.projection_executor.apply_forward(
                scope, operation_id, command.persisted(), receipt
            )
            await journal.transition(
                operation_id,
                MutationState.FINALIZING,
                MutationState.FORWARD_APPLIED,
            )
```

Direct `execute` 的 operation ID 同时作为 one-command batch ID，child ID 仍等于 caller ID，不追加 suffix。`execute_batch` 有 caller IDs 时逐项原样持久化；没有 caller IDs 的内部 knowledge batch 才使用 `bounded_child_operation_id(batch_id, f"{index:04d}")`，然后包装为全-request `PreparedBatchItem`。所有内部派生 ID（包括后续 TS1/TS2 envelope、receipt、recovery child）必须调用公开 `bounded_child_operation_id(parent_id, suffix)`；禁止手工字符串拼接。短 preimage 使用可解析且单射的 `childp:<parent-byte-length>:<parent>:<suffix>`；超过 128 ASCII bytes 时，版本标签、parent byte length、完整 parent 与 suffix 进入 SHA-256 并使用独立 `childh:` namespace，journal/result 同时保留原 parent/suffix 映射。测试覆盖 127/128-byte parent、首次超界、`("a:receipt", "pending") != ("a", "receipt:pending")` 的显式冒号歧义向量、不同 suffix/parent 不碰撞、fresh-process/restart 稳定、suffix 大小上限，以及返回值重新通过 `validate_operation_id`。`execute_prepared_batch` 要求原始 index 严格为 `0..n-1`、operation ID 唯一、每项恰有 request/pre-rejection 之一；batch request hash 只覆盖 ordered `(request_index, operation_id, intent_hash)` identity，`intent_hash` 是 authority/rule 读取前对完整 caller intent 的 canonical SHA-256。取得 combined Space-exclusive、获得 read-only recovery gate clean proof 后且在 compiler/stage 前，UoW 一次查询所有 caller operation IDs；任何 ID 已绑定其他 batch 时，无论 intent 相同与否都抛 canonical `idempotency_conflict`，并产生零新 batch/operation/stage/ledger/entity。相同原始事件在 mapper 分类或 catalog 改变后仍命中同 batch 的持久 receipt，同 batch ID 换 payload、顺序或 caller ID 也触发 conflict。

`MutationCompiler.compile_batch(...)` 只能在 UoW 已持 Space-exclusive 后通过 `AuthorityOverlay.from_locked_authorities(scope, session, catalog)` 读取一次同一 runtime scope 的 `space.db`/Markdown/index authority；只传 session 的 overlay 构造被禁止。它跳过已经封闭的 pre-rejection，但保留每个 request 的 original `request_index`。`AuthorityOverlay` 是 deterministic in-memory authority view；`apply(command: MutationCommand)` 原子更新 DB after-row/delete、权威 Markdown body after-bytes、planned relative path reservations，以及下一 child 编译所需的 derived index/FTS descriptors。它不是只接收 `db_plans` 的 row overlay。所以下一 child 的 parent/relation/CAS/body/path/projection compiler 看见前一 accepted child 的完整 planned state；rejected child 不更新 overlay。它不 flush/write真实 session。测试至少覆盖 Folder-create→Note-create、Note-create→junction-create、同一 Note 连续内容更新、move→metadata update 和 QuickNote conversion dependent children。若任何 command 无法完整投影进 overlay，则整批在创建 INTENT 前 fail closed，而不是用 stale authority 编译。注册的 domain policy 与 generic compiler 必须返回同一个 `MutationCommand` 类型；generic path 根据 compiled `sync_conflict_policy` 选择 LWW 或 strict CAS，strict CAS mismatch 只能返回 `version_conflict`，不能产生 remote resolution。compiler只用 `MutationRuleViolation` 表示可返回的逐事件拒绝；I/O、decode、programming 和 cancellation 异常绝不能被降级为 reject。UoW 把 pre-rejections 与 compiler rejections 按 original index 合并；每条 reject 在 `create_batch_intent` 前确定，不创建 operation/stage/ledger，其 caller ID、input index、code/details/retryable 存在 batch `result_json`。全 reject（包括全 mapper reject）batch 由 `record_rejected_batch()` 在一个 transaction 内执行合法 INTENT -> ABORTED 并保存结果；mixed batch 将所有 rejection receipt 与 accepted intent 一起持久化。`_commit_business` 开一个 outer transaction，逐 accepted child 使用 nested SAVEPOINT 调用共享 `DbMutationInterpreter.apply(session, command.db_plans)`；accepted commands 全部成功后，在同一 outer commit 写 DB before/after JSON、调用 `transition_in_transaction(..., DB_COMMITTED)`，并按每个 `command.sync_events` 的稳定 tuple 顺序调用 `record_sync_event(... operation_id=..., batch_id=..., visible=False)`。任一 event append 失败会回滚该 command 的所有 business rows、journal transition、cursor advance 与全部 ledger events。写 ledger 前必须通过注入的 compiled catalog 验证每个 event 的 internal entity type并解析成唯一 `spec.effective_sync_entity_type`；outbox、未来 S4 pull/snapshot/REST/MCP/frontend 永远看到同一个 wire key，不能把 internal snake_case name 写入 ledger。S3 alias tests 至少覆盖 `quick_note`、`time_block` 和仍存在的 `schedule_quick_note` junction，并只证明 compiler internal name -> persisted `SyncEventPlan.entity_type` -> invisible/visible ledger effective key 逐字等于 catalog camelCase key；跨 SyncProtocol、REST/MCP、snapshot 和 frontend 的端到端相等证明留给 S4。journal 中 persisted command 足以让 Task 5 的 fresh-process recovery 通过同一个 `DbMutationInterpreter.decode_command()` 重建并从 STAGED 重放，且先与 StageStore descriptors核对；compensation只调用同一实例的 `restore_before()`。Task 4 happy path 从 UoW constructor 注入 catalog/compiler/interpreter/projection executor/recovery gate/journal factory；Task 5 构造具体 `MutationRecovery` 时必须复用相同 compiler/interpreter/projection executor，不得另写 SQL 分支或 callable。outer failure 回滚全部 business rows、journal transition 和 ledger，并让 accepted batch 保持 STAGED，Task 4 gate 随后只会 fail closed，直到 Task 5 recovery 消化它。UoW 向唯一 `FencedProjectionExecutor` 传 `FenceReceipt` 而不是裸整数；每次 Markdown/path/index/FTS/version/trash destructive write/rename 的紧邻前一行都调用 `receipt.assert_current()`，Task 5 recovery重放使用同一个 executor。stale receipt fault test在每一种 store 写入前推进持久 fence并断言零写入、零 visibility。

`MutationJournal` 绝不作为 UoW 的固定 cross-Space field。只有 `exclusive_space_resources(...)` 已激活当前 Space 的资源后，UoW 才调用 `journal_factory(scope.session_factory)` 创建本次 guard-local journal，并把它显式传给所有 helper；不得缓存 journal、session factory 或 session 到下一 Space/下一次 lease。

Task 4 happy path always zips the accepted `operation_id` with its command and passes both to `FencedProjectionExecutor`; `PersistedMutationCommand` never absorbs that identity. Task 5 restart recovery reads `MutationOperation.operation_id` beside `command_json`, decodes the same command, and passes both values to `apply_forward` or `restore_before`.

Task 4 只提供可注入 seams 和测试 composition。生产 runtime/bootstrap registration 明确推迟到 Task 5（或第一个明确的 post-Task-5 consumer）；Task 4 不修改或注册 `app/runtime/bootstrap.py`、`app/main.py`、FastAPI 或 FastMCP composition。

Every Sync-enabled effect in `MutationCommand.sync_events` is a complete persisted `SyncEventPlan`; a command with no Sync effect uses `sync_events=()`. Each event `version` is a required non-boolean, nonnegative `int`; `None`, negative values, numeric strings, floats, and booleans fail before INTENT. Before INTENT, the compiler freezes create/update as the complete authoritative after-entity: declared primary key, explicitly generated and stored version/UTC `updated_at`, every schema field, and for Note the staged authoritative Markdown after-body. It never stores only the caller patch, a derived frontmatter/index view, or a value left to an ORM/database default. Delete freezes payload exactly as `{"deleted_at": <canonical UTC>}`, its top-level entity ID, last incremented version, and the same outbox `created_at`. Retry and restart recovery write ledger payload/version/timestamp only from the persisted tuple. S4's snapshot serializer must produce the same payload/version/updated_at for each surviving entity, and cross-wave vectors compare them field-for-field.

Phase boundary: S3 tests only compiler/internal-name -> persisted effective wire key and complete `SyncEventPlan` at the UoW/ledger boundary. End-to-end alias equality through SyncProtocol, REST/MCP pull, snapshot, and frontend merge is an S4 gate and does not block S3 on code that cannot exist before the S4 branch.

Stage publication may be sequential on disk, but journal visibility is batch-atomic:
`_publish_stages(scope, lease, ...)` requires `scope.mutation_stages` from the active
S2 runtime handle and passes the same Space-exclusive `lease`/Space ID to every
`StageStore.publish`; it never constructs a StageStore from `Path` or reopens the
namespace. `_publish_stages` never advances an individual operation; only
`mark_staged(batch_id, manifests)` verifies the complete accepted manifest set and
changes batch plus every accepted child from INTENT to STAGED in one transaction.
Failure/crash after any child publish leaves the whole journal batch INTENT for Task
5's batch-level recovery; normal exception cleanup cannot call a child-only abort.

`record_sync_event` 的 `visible` 参数 required、没有 Python/ORM/DB true default。Task 4 在改变签名前枚举当前全部 legacy caller：`base.py`、`cascade.py`、`note.py`、`quick_note.py`、`relation.py`、`sync.py`、`task.py` 均暂时显式传 `visible=True`；UoW 内部唯一 ledger append 显式传 `visible=False`。后续 S3 tasks 删除或迁移这些 legacy writes，S4 删除 `SyncService` 最后 bypass。AST regression 扫描整个 `BACKEND_APP`：`mutation/unit_of_work.py` 只允许 literal false，`services/**` legacy caller只允许 literal true，其他目录出现 writer 直接失败，所以新增 caller 或省略/nonliteral keyword 会立即失败。`SyncState.current_cursor` 是权威 allocated high watermark，不是 visible-row max：每次 ledger append 分配 row ID，并在同一个 business transaction 把 singleton `current_cursor` 单调推进到该 ID；invisible UoW ledger row 与水位线同提交、同回滚，最终 visibility commit 不再推进 cursor。任何状态都必须满足 `0 <= retention_floor <= current_cursor`，prune 删除 ledger rows也不降低 `current_cursor`。所有读取该水位线的 consumer 必须先通过当前 Space 的 clean recovery gate；因此 S3 legacy current stats 可以读取 allocated watermark，但 pull 仍只返回 visible rows，S4 才将该 authoritative value用于未来游标、snapshot与ACK边界。

同一 exhaustive AST inventory 还固定四个 Task 4 test/certification setup caller：`tests/test_sync_ledger_retention.py`、`tests/test_sync_legacy_fail_closed.py`、`tests/test_sync_routes.py` 和 `tests/fixtures/certification/populate_n_minus_one.py`。每个现有 `record_sync_event(...)` call site 都在原调用处传 literal `visible=True`；不得通过恢复参数 default、fixture wrapper、monkeypatch 或 shared shim 隐藏选择。whole-repository regression 合并 `python_call_sites(BACKEND_APP, "record_sync_event")`、`python_call_sites(BACKEND_TESTS, "record_sync_event")` 与 `python_call_sites(CERTIFICATION_FIXTURES, "record_sync_event")`，因此任何漏参、nonliteral 值或未登记 caller 都 fail closed。

`MutationJournal.find_operation_batch_bindings(operation_ids)` executes one set-based query under the same Space-exclusive lease and returns every existing `(operation_id, batch_id)` binding without filtering by requested batch or intent hash. After exact `find_batch(batch_id)` retry handling and before opening the authority session, any foreign owner deterministically raises canonical `IdempotencyConflictError`; a same-batch child binding with no owning batch receipt is an impossible durable shape and raises `SpaceRecoveryRequiredError`. Neither path invokes the compiler, opens an authority view, creates a batch/operation/stage, nor appends a ledger event.

- [ ] **Step 4: Run UoW happy-path and ledger regressions**

```powershell
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $true
.\.venv\Scripts\python.exe -m pytest -q tests/test_mutation_journal.py tests/test_mutation_staging.py tests/test_note_workspace_atomicity.py tests/test_sync_ledger_retention.py tests/test_sync_legacy_fail_closed.py tests/test_sync_outbox_service.py tests/test_sync_routes.py tests/test_sync_cursor_pagination.py -p no:cacheprovider
.\.venv\Scripts\ruff.exe check --no-cache app/errors.py app/file_system/interfaces.py app/file_system/engine/base.py app/mutation app/services/base.py app/services/cascade.py app/services/note.py app/services/quick_note.py app/services/relation.py app/services/sync.py app/services/sync_outbox.py app/services/task.py tests/fixtures/certification/populate_n_minus_one.py tests/test_mutation_staging.py tests/test_note_workspace_atomicity.py tests/test_sync_ledger_retention.py tests/test_sync_legacy_fail_closed.py tests/test_sync_outbox_service.py tests/test_sync_routes.py
```

Expected: PASS; retry is one logical result, mismatched key fails before staging, and no invisible event appears in pull.

- [ ] **Step 5: Commit UoW happy path**

```powershell
git add app/errors.py app/file_system/interfaces.py app/file_system/engine/base.py app/mutation/staging.py app/mutation/unit_of_work.py app/mutation/types.py app/mutation/journal.py app/services/base.py app/services/cascade.py app/services/note.py app/services/quick_note.py app/services/relation.py app/services/sync.py app/services/sync_outbox.py app/services/task.py tests/fixtures/task_space_session_child_operation_id_vectors.json tests/fixtures/certification/populate_n_minus_one.py tests/test_mutation_journal.py tests/test_mutation_staging.py tests/test_note_workspace_atomicity.py tests/test_sync_ledger_retention.py tests/test_sync_legacy_fail_closed.py tests/test_sync_outbox_service.py tests/test_sync_routes.py tests/test_sync_cursor_pagination.py
git commit -m "feat(mutation): execute durable idempotent units of work"
```

## Task 5: Implement Restart Recovery And The Complete Fault Matrix

**Files:**
- Create: `backend/app/mutation/recovery.py`
- Modify: `backend/app/mutation/journal.py`
- Modify: `backend/app/mutation/types.py`
- Modify: `backend/app/mutation/staging.py`
- Modify: `backend/app/file_system/interfaces.py`
- Modify: `backend/app/file_system/engine/base.py`
- Modify: `backend/app/mutation/unit_of_work.py`
- Modify: `backend/app/runtime/scope.py`
- Modify: `backend/app/runtime/space.py`
- Modify: `backend/app/runtime/bootstrap.py`
- Modify: `backend/app/main.py`
- Modify: `backend/app/mcp/server.py`
- Create: `backend/tests/test_mutation_recovery.py`
- Modify: `backend/tests/test_mutation_journal.py`
- Modify: `backend/tests/test_mutation_staging.py`
- Modify: `backend/tests/test_note_workspace_atomicity.py`
- Modify: `backend/tests/test_space_lifecycle.py`
- Modify: `backend/tests/test_runtime_bootstrap.py`
- Modify: `backend/tests/test_mcp_http_lifespan.py`
- Modify: `backend/tests/test_main.py`

**Interfaces:**
- Consumes: Task 3 `StageStore`, Task 4 journal/UoW/compiler/interpreter, and an already-held matching Space-exclusive lease. Task 5 may extend `StageStore` only with an opaque side-selective verifier/materializer that accepts operation ID, the exact ordered descriptor tuple, `Literal["before", "after"]`, and the active fence receipt; it must never expose a stage path, directory key, filename, URI, fd, or HANDLE.
- Produces: `MutationUnitOfWork.recover_under_lease(scope, lease) -> RecoveryResult`, `inspect_recovery(view) -> RecoveryInspection`, durable `FAILED_MANUAL` health projection, and startup/open/readiness recovery gates.

- [ ] **Step 1: Encode the full fault matrix as failing parameterized tests**

`backend/tests/test_mutation_recovery.py` 必须定义下列完整 table，不得只抽样 happy path：

| Fault point | Durable state immediately after fault | Required recovery | Observable result |
|---|---|---|---|
| before/at INTENT commit | no row or `INTENT` | no row: no-op; INTENT without published stage: `ABORTED` | all old, no ledger |
| temporary stage blob write | `INTENT` + temp dir | remove temp under exclusive lease, `ABORTED` | all old |
| manifest write/fsync | `INTENT` + temp dir | verify incomplete temp cannot publish, remove, `ABORTED` | all old |
| atomic stage rename | `INTENT` + published valid stage | verify manifest, advance `STAGED`, resume | all new once |
| after each accepted child stage publish | batch `INTENT` + partial published manifests | if any accepted manifest is missing/invalid, abort the entire batch and collect every child stage | all old, no mixed child state |
| before/at batch `mark_staged` commit | batch `INTENT` + every valid manifest | one transaction advances batch and every accepted child to `STAGED`, otherwise restart repeats the same batch-level decision | all old or all new, never a replay subset |
| STAGED commit | `INTENT` or `STAGED` | valid published stage resumes; missing stage aborts | all old or all new |
| ORM flush/savepoint | `STAGED` | outer rollback, replay accepted set | all new once |
| invisible index/ledger insert in outer transaction | `STAGED` | rollback and replay | no visible ledger before replay |
| outer business commit | `DB_COMMITTED` | forward finalize first | all new once |
| FINALIZING commit | `DB_COMMITTED` or `FINALIZING` | enter/resume forward finalize | all new once |
| Markdown finalize | `FINALIZING`, step hash absent/present | hash-prove and idempotently apply next step | no partial read |
| path/frontmatter finalize | `FINALIZING` | hash-prove rename and metadata | no old path with new DB metadata |
| index row commit | `FINALIZING` | idempotent upsert or inverse | no visible ledger |
| FTS commit | `FINALIZING` | idempotent replace or inverse | search matches final authority |
| version/trash finalize | `FINALIZING` | resume or reverse by step order | versions/trash all old or all new |
| terminal status/visibility commit | `FINALIZING` or `FORWARD_APPLIED` | prove every child after hash, then commit all child FINALIZED + batch FINALIZED + visibility together | one visible event per accepted child |
| missing/corrupt after-image after DB commit | `DB_COMMITTED`/`FINALIZING` | use durable before-images, reverse steps, `COMPENSATED` | all old, no visible ledger |
| corrupt forward and inverse images | `DB_COMMITTED`/`FINALIZING` | `FAILED_MANUAL`, mark Space degraded | reads/writes blocked |
| orphan temp/published stage | no matching live operation | collect only under Space exclusive and no live owner | no business change |
| restart from every nonterminal state | persisted state | same deterministic decision as above | no duplicate result/event |
| accepted batch child finalize failure | batch `FINALIZING` | finish every child forward or compensate all in reverse | batch ledger all hidden or all visible |

测试结构使用同一个 injection enum：

```python
@pytest.mark.parametrize("fault_point", ALL_FAULT_POINTS)
@pytest.mark.asyncio
async def test_restart_converges_to_declared_all_old_or_all_new(
    mutation_fixture, fault_point: FaultPoint
) -> None:
    mutation_fixture.injector.arm(fault_point)
    await mutation_fixture.execute_until_injected()
    mutation_fixture.discard_all_python_commands_compilers_and_sessions()
    restarted = await mutation_fixture.restart_process_objects_from_disk_only()

    async with await restarted.acquire_space_exclusive() as lease:
        recovery = await restarted.uow.recover_under_lease(restarted.scope, lease)

    restarted.assert_declared_outcome(fault_point, recovery)
    restarted.assert_no_partial_projection()
    restarted.assert_ledger_visibility_barrier()


@pytest.mark.parametrize("left_state", NONTERMINAL_MUTATION_STATES)
@pytest.mark.asyncio
async def test_preopened_waiting_writer_recovers_after_exclusive_acquisition(
    mutation_fixture, left_state: MutationState
) -> None:
    writer_a = await mutation_fixture.open_mutation_handle()
    writer_b = await mutation_fixture.open_mutation_handle()  # both observed clean
    await mutation_fixture.leave_durable_state(writer_a, left_state)

    outcome = await mutation_fixture.execute_with_handle(writer_b, "op-after-a")

    assert mutation_fixture.events_before("compile:op-after-a") == [
        f"recover:{left_state.value}", "recovery-clean"
    ]
    assert outcome.state is MutationState.FINALIZED
    mutation_fixture.assert_no_overlapping_pending_authority()


@pytest.mark.asyncio
async def test_preopened_waiting_writer_unwinds_when_recovery_fails_manual(
    mutation_fixture,
) -> None:
    writer_a = await mutation_fixture.open_mutation_handle()
    writer_b = await mutation_fixture.open_mutation_handle()
    writer_c = await mutation_fixture.open_mutation_handle()
    assert mutation_fixture.space_resource_refcount() == 0
    await mutation_fixture.leave_unprovable_forward_and_inverse(writer_a)

    with pytest.raises(SpaceRecoveryRequiredError):
        await mutation_fixture.execute_with_handle(writer_b, "must-not-compile")
    with pytest.raises(SpaceRecoveryRequiredError):
        await mutation_fixture.execute_with_handle(writer_c, "also-must-not-compile")

    assert mutation_fixture.compile_count("must-not-compile") == 0
    assert mutation_fixture.new_intent_count("must-not-compile") == 0
    mutation_fixture.assert_space_blocked_and_handles_closed_once()
    assert mutation_fixture.space_resource_refcount() == 0


@pytest.mark.asyncio
async def test_reader_rechecks_cleanliness_while_shared_blocks_writer_handoff(
    mutation_fixture,
) -> None:
    reader = mutation_fixture.pause_reader_after_recovery_before_shared()
    writer = await mutation_fixture.run_writer_between_reader_attempts(
        leave_state=MutationState.DB_COMMITTED
    )
    await writer.release_exclusive_after_fault()
    handle = await reader.resume()

    assert reader.observed == [
        "shared-inspect:dirty", "exclusive-recover:DB_COMMITTED",
        "shared-inspect:clean", "return-read-handle",
    ]
    reader.assert_strict_order(
        "shared-inspect:dirty",
        "shared-read-resources:closed",
        "shared:released",
        "exclusive:acquired",
        "exclusive-recovery-resources:opened",
        "exclusive-recover:DB_COMMITTED",
        "exclusive-recovery-resources:closed",
        "exclusive:released",
        "shared-inspect:clean",
        "return-read-handle",
    )
    async with handle:
        mutation_fixture.assert_read_view_is_all_new()


@pytest.mark.parametrize("cleanup_phase", ["dirty-read", "exclusive-recovery"])
@pytest.mark.asyncio
async def test_dirty_read_cleanup_fail_once_retains_lease_until_owner_task_retry(
    mutation_fixture,
    cleanup_phase: str,
) -> None:
    fault = mutation_fixture.fail_resource_cleanup_once(cleanup_phase)

    with pytest.raises(BaseExceptionGroup):
        await mutation_fixture.open_dirty_read_handle()

    owner = mutation_fixture.runtime.only_pending_cleanup()
    assert owner.owner_task is asyncio.current_task()
    assert owner.lease.is_owned
    assert not mutation_fixture.events.contains(f"{cleanup_phase}-lease:released")
    await mutation_fixture.runtime.retry_pending_cleanups_for_current_task()
    assert fault.successful_close_count == 1
    assert mutation_fixture.runtime.pending_cleanup_count == 0


@pytest.mark.parametrize("cleanup_phase", ["dirty-read", "exclusive-recovery"])
@pytest.mark.asyncio
async def test_dirty_read_persistent_cleanup_blocks_recovery_readiness_and_shutdown(
    mutation_fixture,
    cleanup_phase: str,
) -> None:
    fault = mutation_fixture.fail_resource_cleanup_persistently(cleanup_phase)

    with pytest.raises(BaseExceptionGroup):
        await mutation_fixture.open_dirty_read_handle()
    with pytest.raises(RuntimeCleanupPendingError):
        mutation_fixture.runtime.assert_ready()
    with pytest.raises(RuntimeCleanupPendingError):
        await mutation_fixture.runtime.close()

    owner = mutation_fixture.runtime.only_pending_cleanup()
    assert owner.owner_task is asyncio.current_task()
    assert owner.lease.is_owned
    assert mutation_fixture.exclusive_recovery_count_after_failure(cleanup_phase) == 0
    fault.clear()
    await mutation_fixture.runtime.retry_pending_cleanups_for_current_task()
    assert mutation_fixture.runtime.pending_cleanup_count == 0
```

- [ ] **Step 2: Run recovery tests and verify nonterminal states remain unresolved**

```powershell
.\.venv\Scripts\python.exe -m pytest -q tests/test_mutation_recovery.py -p no:cacheprovider
```

Expected: FAIL because recovery engine and runtime open hook do not exist.

- [ ] **Step 3: Implement deterministic recovery decisions**

`MutationRecovery` 要求调用方当前 Task 已经持有同一 `SpaceRuntimeHandle` 的 active global SHARED（request）或 EXCLUSIVE（startup）lease，加 matching Space EXCLUSIVE lease；禁止内部重取、升级或接受其他 Task/已释放 lease。它按 batch ID/child sequence 排序，先 collect safe orphans，再只从 journal canonical command JSON 与 stage manifest 重建 interpreter 输入。固定决策：

```python
RECOVERY_ACTION = {
    MutationState.INTENT: "validate_stage_or_abort",
    MutationState.STAGED: "apply_business_or_abort",
    MutationState.DB_COMMITTED: "finalize_forward_then_compensate",
    MutationState.FINALIZING: "finalize_forward_then_compensate",
    MutationState.FORWARD_APPLIED: "finish_batch_or_compensate",
    MutationState.COMPENSATING: "resume_compensation",
}
```

INTENT/STAGED recovery 只允许 batch 级决策，绝不逐 child transition：对 batch INTENT，按 accepted child sequence 验证所有 published manifests/hash/intended projection set；全部完整时在一个 transaction 把 batch和所有 accepted operations推进 `STAGED`，任一缺失/损坏时在一个 transaction 把整批及所有 accepted children置 `ABORTED`，随后在同一 Space-exclusive 下清理该批所有 temp/published stages。不得产生 `STAGED + ABORTED` mixed children，也不得 replay manifest 子集。对 batch STAGED，所有 manifests 再次完整才通过共享 `DbMutationInterpreter` 重放完整 accepted set；任一缺失进入整批安全失败路径，不能只跳过 child。fault matrix 在每个 child publish 后及 batch `mark_staged` commit 前后 crash/restart，断言 DB/projections/ledger all-old或all-new。

对 DB_COMMITTED/FINALIZING/FORWARD_APPLIED：逐 step 比较 actual hash；已是 after hash 则记 applied，其他使用 after image；after 不可用或任一 batch child forward 失败时 transition COMPENSATING，先 reverse child sequence、再 reverse step ordinal 应用 before image，并通过同一 interpreter 恢复 DB before rows；全部 before hashes 证明后 COMPENSATED。任一 store 无法匹配 before/after hash，transition FAILED_MANUAL、写 stable reason（不含绝对路径）、执行下述两阶段 runtime degrade；任何 degrade helper 都不直接释放 global lease。

为避免完整 manifest 校验把“after blob 损坏但 before blob 仍可证明”的合法补偿错误升级为 `FAILED_MANUAL`，Task 5 明确授权修改 `backend/app/mutation/staging.py` 与 `backend/tests/test_mutation_staging.py`。新增 adapter 必须先验证 canonical manifest identity 与 exact ordered descriptor tuple，再只读取调用方指定 side 的 blob并验证其 SHA-256/size；另一 side 缺失/损坏不得阻止已选 side 的证明。它仍由 `StageStore` 的 opaque `BoundStageDirectory` authority 实现，不返回或接受任何 namespace/path/key。Recovery 对每个 operation 的每个 descriptor ordinal 独立分类 actual 为 before/after/neither：forward 按 ascending ordinal 只重放未达 after 的 step；compensation 按 reverse child sequence、descending ordinal 只逆转未达 before 的 step。`PATH_RENAME` 的 before/after proof 必须绑定源/目标字节 SHA-256/size，不能只证明名称存在。测试必须包含一个 operation 至少三个 projection steps 的 partial-forward restart、两个 accepted children 的 mixed finalize failure、reverse child/ordinal observer，以及 after blob corrupt + before blob valid 的 `COMPENSATED` 路径。

Normative recovery terms are: selected side blob validation; Per-descriptor before/after/neither classification; ascending forward and descending compensation ordering; and `PATH_RENAME` byte hash proof. Task 5 可修改 `mutation/types.py`，把 rename 从无 image 的旧临时合同收紧为 before/after bytes 必须同时存在且字节相同，manifest 因而持久化两侧 SHA-256/size。它可扩展 `FencedProjectionExecutor`/`FileSystemProjectionExecutor` 为只接受 canonical command 的 exact ordinal subset executor；caller 不能提交、重排或替换 descriptor。FAILED_MANUAL degrade cleanup 必须由 lease-pinned pending cleanup owner 持有 matching global/Space leases；close 或 engine identity drain 任一步 fail-once 时，owner retries close and drain before releasing either lease。borrowed/exclusive context cleanup 不得绕过该 pending owner 直接 release。

Task 5 明确授权 `mutation/journal.py` 在 INTENT transaction 中为 canonical descriptor tuple 创建一一对应的 `MutationStep(PENDING)`，并在每个 after proof 后持久化 `APPLIED/applied_hash`、每个 before compensation proof 后持久化 `COMPENSATED/applied_hash`。Recovery 必须验证 step count、ordinal、tag/store/target 和 before/after hash 与 persisted command 完全一致。已有或新产生首个 `FAILED_MANUAL` 后必须立即停止同 Space 后续 batch，先进入 degraded admission/cleanup；不得继续业务或投影写。degraded cleanup 只能由单一 handle pending owner 完成 resource close、identity drain 和 lease release，禁止叠加第二个 dependency owner。测试必须使用真实 `RuntimeLeaseCoordinator` 和外层 handle context 证明 fail-once close/drain 无 LIFO dependency deadlock，并用 durable journal restart 路径覆盖 multi-step、multi-child 与命名 fault boundaries；直接调用私有 helper 不算 Exit Gate 证据。

S3 给 S2 runtime 安装 recovery hook。唯一 composition owner 是 FastAPI/FastMCP 共用的 `app/runtime/bootstrap.py::bootstrap_runtime()`：它在 `prepare_registered_spaces()` 前构造同一个 UoW/recovery provider并注入 runtime，`app/main.py` 与 `app/mcp/server.py` 只消费 `RuntimeServices`，不得各安装一套 hook。`tests/test_runtime_bootstrap.py` 与 `test_mcp_http_lifespan.py` 对同一 pending/FAILED_MANUAL fixture 断言两入口执行同一 recovery path、相同 readiness failure 和相同 cleanup。

`recover_under_lease(handle, space_lease)` 同时验证 handle 中 matching global lease 在当前 Task active；global mode 可为 SHARED（request open）或 EXCLUSIVE（startup），Space lease必须 EXCLUSIVE。startup 的 `prepare_registered_spaces(catalog, global_lease)` 沿用已持有的 global-exclusive，为每个 Space取得临时 Space-exclusive，并使用 S2 package-internal `async with runtime.borrow_prepared_space(scope, global_lease, space_lease) as handle`；该 handle 明确 `owns_global_lease=False`、`owns_space_lease=False`，因此 context/`aclose()` 只关闭 FileSystem并 release engine reference，绝不重取或释放 borrowed leases。固定正常顺序是 recovery -> 在仍持 matching Space-exclusive 时关闭 borrowed handle resources -> 释放 Space-exclusive -> 处理下一 Space；bootstrap 最后才把 global-exclusive/process-owner 各释放一次。borrowed cleanup 逐项尝试，失败与 recovery primary 按 `[primary, *cleanup_errors]` 聚合，但仍完成其余 per-Space cleanup。禁止构造 ownership flags 不明确的 unexposed handle，也禁止泄漏 engine/filesystem references。

请求期 `AuthorizedSpaceScope.open()` 已持 global-shared 后，read mode 使用严格的无升级循环。每次 attempt 先取得 Space-shared，在该 shared 下打开 read filesystem/engine并只调用 `inspect_recovery()`/durable degraded marker；确认 clean 后继续持有同一 shared lease和资源并返回 handle。若 dirty，必须在 shared 仍持有时先关闭 read filesystem、再 release engine，只有两者都成功后才释放 shared；随后取得临时 Space-exclusive，在该 exclusive 下打开 recovery resources、调用同一个 `recover_under_lease()`，并在 exclusive 仍持有时关闭全部 recovery filesystem/engine，资源全部关闭后才释放 exclusive，最后从新的 Space-shared acquisition 重试 inspection。任何 read/recovery resource cleanup 失败都由 S2 pending cleanup owner保留仍持有的 lease并按 primary-first聚合；fail-once只允许 acquiring Task重试后释放，persistent failure阻止进入后续 exclusive/recovery、阻断 readiness/graceful shutdown，绝不能先放 lease 再留下 live engine/filesystem。检查 clean 到返回 read handle 之间 shared 始终不释放，因此等待 writer 无法插入 pending state。mutation handle不预持 Space lease，由 UoW获取 exclusive。禁止 read-shared→exclusive原地升级，并测试合法 global SHARED/EXCLUSIVE、dirty retry、两个 cleanup phase 的 fail-once/persistent failure、FAILED_MANUAL unwind，以及“writer 恰在首次恢复后/reader 第二次 shared前留下 DB_COMMITTED”的确定性 handoff；该 writer 使下一 attempt重新发现 dirty并重复完整 close-release-exclusive-recover-close-release循环，不能返回 stale read handle。因为两个 mutation handle 可以先后 open 并都观察到 clean，`execute_prepared_batch()` 每次取得 Space-exclusive 后必须立即调用同一个 `recover_under_lease(scope, lease)`，随后才允许 `find_batch()`、compiler authority read 或新 INTENT。该 preflight 收敛所有较早 pending batch；若它收敛了当前 `batch_id`，UoW 再读取并返回其 durable receipt。任何普通异常、取消或 crash simulation 只有在 resources已关闭后才释放 exclusive；下一个排队 writer 必须先恢复，不能在 stale authority 上编译。

FAILED_MANUAL 使用不可重排的两阶段降级。S2 的 mutation handle 在 combined exclusive guard 外没有 engine/filesystem ref；Space-exclusive 又排除了 active read handles，因此三个或更多预打开 writers 仍只有当前 guard/bootstrap borrowed handle 的一个资源引用。阶段一先持久化 journal state，再调用 `runtime.begin_degraded_under_lease(handle, "mutation_recovery_required", space_lease)`，在 matching Space-exclusive 下阻止新 opens/guard activation并刷新 durable/cache marker，绝不 await drain。阶段二 `await handle.close_space_resources()` 关闭当前 filesystem/engine ref但保留 global 和 Space leases；确认 refcount 为零后调用 `finish_degraded_evict_under_lease(...)` drain/evict并保持 blocked。combined guard 随后释放 Space-exclusive；排队的预打开 mutation handle 取得 turn 后必须在激活资源前读取 durable degraded marker、关闭自身 global-only handle并抛 `space_recovery_required`。最后 request `aclose()` 释放 global-shared，或 bootstrap 释放 global-exclusive/process-owner。任一步失败按 primary-first 聚合，并由 S2 pending cleanup owner 重试资源后再释放 lease；不得在仍有 ref 时 finish，也不得在 finish 前开放新 activation。

durable source 始终是 FAILED_MANUAL journal，restart从 `RecoveryInspection.failed_manual` 重建 degraded health。multi-Space normal/FAILED_MANUAL fault tests记录 `FAILED_MANUAL durable -> opens blocked -> per-Space resources closed -> engine drained/evicted -> Space lease released -> owning context releases global once`，断言无自等待、`LeaseOrderError`、双释放、lease/engine/file-system ref泄漏，后续 Space不能在 global 被提前释放后运行。startup因此阻断 readiness，请求在正确 unwind 后抛 `space_recovery_required`。对 terminal states recovery是 no-op；ledger在整批 FINALIZED前保持 false。

- [ ] **Step 4: Run the entire recovery matrix twice**

```powershell
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $true
.\.venv\Scripts\python.exe -m pytest -q tests/test_mutation_recovery.py -p no:cacheprovider
.\.venv\Scripts\python.exe -m pytest -q tests/test_mutation_recovery.py -p no:cacheprovider
.\.venv\Scripts\ruff.exe check --no-cache app/file_system/interfaces.py app/file_system/engine/base.py app/mutation/journal.py app/mutation/recovery.py app/mutation/staging.py app/mutation/types.py app/mutation/unit_of_work.py app/runtime/scope.py app/runtime/space.py app/runtime/bootstrap.py app/main.py app/mcp/server.py tests/test_mutation_journal.py tests/test_mutation_recovery.py tests/test_mutation_staging.py tests/test_note_workspace_atomicity.py tests/test_space_lifecycle.py tests/test_runtime_bootstrap.py tests/test_mcp_http_lifespan.py tests/test_main.py
```

Expected: both runs PASS with identical parameter count; no intermittent orphan/fence failure. The test summary must list every matrix row, including each finalize store and every nonterminal restart state.

- [ ] **Step 5: Commit recovery and fault injection**

```powershell
git add app/file_system/interfaces.py app/file_system/engine/base.py app/mutation/journal.py app/mutation/recovery.py app/mutation/staging.py app/mutation/types.py app/mutation/unit_of_work.py app/runtime/scope.py app/runtime/space.py app/runtime/bootstrap.py app/main.py app/mcp/server.py tests/test_mutation_journal.py tests/test_mutation_recovery.py tests/test_mutation_staging.py tests/test_note_workspace_atomicity.py tests/test_space_lifecycle.py tests/test_runtime_bootstrap.py tests/test_mcp_http_lifespan.py tests/test_main.py
git commit -m "feat(mutation): recover or compensate interrupted writes"
```

## Task 6: Centralize Entity Invariants And CAS In EntityCommand

**Files:**
- Create: `backend/app/commands/__init__.py`
- Create: `backend/app/commands/entity.py`
- Modify: `backend/app/registry/entities.py`
- Modify: `backend/app/registry/catalog.py`
- Modify: `backend/app/registry/builtin.py`
- Modify: `backend/app/services/base.py`
- Modify: `backend/app/services/schedule.py`
- Modify: `backend/app/services/folder.py`
- Modify: `backend/app/services/task.py`
- Modify: `backend/app/services/session.py`
- Modify: `backend/app/services/habit.py`
- Modify: `backend/app/services/quick_note.py`
- Modify: `backend/app/services/reflection.py`
- Modify: `backend/app/services/time_block.py`
- Create: `backend/tests/test_entity_invariants.py`
- Create: `backend/tests/test_entity_concurrency.py`
- Modify: `backend/tests/test_routes_pagination.py`
- Modify: `backend/tests/test_sync_integration.py`

**Production Contracts (amendment):**

1. **Junction endpoint metadata:** `EntitySpec` gains `junction_endpoints: tuple[tuple[str, str], ...] | None = None` field. Each tuple is `(field_name, endpoint_entity_type)`. `CompiledEntityCatalog` exposes `junction_endpoints_for(entity_type) -> tuple[tuple[str, str], ...] | None`. Catalog compile validates that endpoint entity types exist in the catalog. Only `schedule_quick_note` defines junction endpoints: `(("schedule_id", "schedule"), ("quick_note_id", "quick_note"))`. `task_quick_note`, `session_quick_note`, and `task_relation` must NOT be S3 gate dependencies.

2. **Endpoint active判定:** `RelationDomainPolicy` checks `context.authority.row(entity_type, endpoint_id)` is not None AND, for entities with `soft_delete=True`, the row's `trashed_at` is None. For entities with `soft_delete=False`, existence alone is sufficient. Metadata missing, duplicate, or unparseable causes catalog compile fail-closed.

3. **Production stable-order owner:** Every service `list()` method MUST append `model.id.asc()` (or `.desc()` for descending sorts) as the final `ORDER BY` tiebreaker. This must be implemented in the production query, not faked by test helpers or SQLite row order.

4. **SyncEventLike contract:** Must declare `expected_version: int | None`, `client_updated_at: str`, `action: Literal["create", "update", "delete"]`. `from_sync_event` uses direct attribute access (`event.expected_version`, `event.client_updated_at`), not `getattr`. Canonical timestamp missing or invalid must fail-closed. Regular REST create/update/delete pass `client_updated_at=None`. `client_updated_at` only flows from `from_sync_event` to private `_build_*` methods — not added to public `update()` parameters. Public signatures use `SpaceRuntimeHandle`, not `object`.

5. **Unknown payload rejection:** `EntityCommand` MUST NOT filter payload. Unknown fields flow into `MutationRequest` where `_require_payload_fields` rejects them. Different unknown caller intent must NOT collapse to the same request hash/receipt. Rejection produces zero operation/stage/ledger/entity writes. ID authority comparison must be precise — no `str()` coercion.

6. **No Task 7 changes:** This amendment does not alter Task 7 or subsequent phases. No S4 transport integration.

**Interfaces:**
- Consumes: `CompiledEntityCatalog`, Task 2 `MutationRequest`/`MutationRuleViolation`, Task 4 compiler/UoW, and authoritative rows read only under its Space-exclusive compiler phase.
- Produces: `EntityCommand.create(scope, entity_type, payload, expected_version) -> MutationRequest`, `update(scope, entity_type, entity_id, patch, expected_version) -> MutationRequest`, `delete(scope, entity_type, entity_id, expected_version) -> MutationRequest`, and `from_sync_event(scope, event) -> MutationRequest`.

- [ ] **Step 1: Write failing parent, cycle, relation, CAS, ordering, and delete-strategy tests**

```python
@pytest.mark.asyncio
async def test_folder_cycle_is_rejected_by_the_shared_command(entity_fixture) -> None:
    await entity_fixture.folder_tree("a", "b", "c")
    command = entity_fixture.commands.update(
        entity_fixture.scope,
        "folder",
        "a",
        {"parent_id": "c"},
        expected_version=1,
    )
    with pytest.raises(MutationRejectedError) as captured:
        await entity_fixture.uow.execute(entity_fixture.scope, command, "move-a-under-c")
    assert captured.value.rejection.code == "cycle_detected"


@pytest.mark.asyncio
async def test_relation_requires_both_endpoints(entity_fixture) -> None:
    await entity_fixture.create_schedule("s2")
    request = entity_fixture.commands.create(
        entity_fixture.scope,
        "schedule_quick_note",
        {"id": "link-1", "schedule_id": "s2", "quick_note_id": "missing"},
        expected_version=None,
    )
    with pytest.raises(MutationRejectedError) as captured:
        await entity_fixture.uow.execute(entity_fixture.scope, request, "link-1")
    assert captured.value.rejection.code == "relation_endpoint_missing"


@pytest.mark.asyncio
async def test_two_writers_with_same_expected_version_have_one_winner(entity_fixture) -> None:
    async def write(title: str, operation_id: str) -> MutationResult:
        scope = await entity_fixture.open_mutation_scope_for_current_task()
        try:
            request = entity_fixture.commands.update(
                scope, "schedule", "s1", {"title": title}, expected_version=3
            )
            return await entity_fixture.uow.execute(scope, request, operation_id)
        finally:
            await scope.aclose()

    outcomes = await asyncio.gather(
        write("A", "op-a"),
        write("B", "op-b"),
        return_exceptions=True,
    )
    assert sum(isinstance(item, MutationResult) for item in outcomes) == 1
    assert sum(
        isinstance(item, MutationRejectedError)
        and item.rejection.code == "version_conflict"
        for item in outcomes
    ) == 1


@pytest.mark.asyncio
async def test_stable_page_order_uses_sort_key_then_id(entity_fixture) -> None:
    ids = await entity_fixture.list_ids(sort_key="updated_at", page_size=2)
    assert ids == ["a", "b", "c", "d"]


@pytest.mark.parametrize(
    ("client_updated_at", "expected_resolution"),
    [("2026-07-14T00:00:01.000Z", "local"), ("2026-07-14T00:00:03.000Z", "remote")],
)
async def test_timestamp_lww_entity_preserves_compiled_decision_and_receipt(
    entity_fixture, client_updated_at: str, expected_resolution: str
) -> None:
    await entity_fixture.seed_schedule(
        "s1", version=3, updated_at="2026-07-14T00:00:02.000Z"
    )
    outcome = await entity_fixture.execute_sync_update(
        "s1",
        entity_type="schedule",
        expected_version=2,
        client_updated_at=client_updated_at,
    )
    if expected_resolution == "remote":
        assert outcome.applied[0].resolution == "remote"
        operation_id = outcome.applied[0].operation_id
    else:
        assert outcome.rejected[0].details["resolution"] == "local"
        operation_id = outcome.rejected[0].operation_id
    assert await entity_fixture.restart_and_read_stored_resolution(operation_id) == expected_resolution


@pytest.mark.asyncio
async def test_strict_cas_entity_never_falls_back_to_timestamp_lww(entity_fixture) -> None:
    await entity_fixture.seed_strict_cas_entity(
        "strict-1", version=3, updated_at="2026-07-14T00:00:02.000Z"
    )

    outcome = await entity_fixture.execute_sync_update(
        "strict-1",
        entity_type="strict_fixture",
        expected_version=2,
        client_updated_at="2026-07-14T00:00:03.000Z",
    )

    assert outcome.applied == ()
    assert outcome.rejected[0].code == "version_conflict"
    assert "resolution" not in outcome.rejected[0].details


@pytest.mark.parametrize("action", ["create", "update"])
def test_sync_wire_entity_id_is_the_only_primary_key_authority(
    entity_fixture, action: str
) -> None:
    accepted = entity_fixture.sync_event(
        action=action, entity_id="wire-id", payload={"id": "wire-id", "title": "A"}
    )
    request = entity_fixture.commands.from_sync_event(entity_fixture.scope, accepted)
    assert request.entity_id == "wire-id"
    assert request.payload.get("id", "wire-id") == "wire-id"

    mismatched = entity_fixture.sync_event(
        action=action, entity_id="wire-id", payload={"id": "payload-id", "title": "A"}
    )
    with pytest.raises(MutationRuleViolation, match="entity_id_mismatch"):
        entity_fixture.commands.from_sync_event(entity_fixture.scope, mismatched)
```

- [ ] **Step 2: Run invariant and concurrency tests**

```powershell
.\.venv\Scripts\python.exe -m pytest -q tests/test_entity_invariants.py tests/test_entity_concurrency.py tests/test_routes_pagination.py tests/test_sync_integration.py -p no:cacheprovider
```

Expected: FAIL because rules are split across route/service paths and generic CAS is absent.

- [ ] **Step 3: Implement the locked EntityCommand surface**

`backend/app/commands/entity.py` 定义：

```python
class SyncEventLike(Protocol):
    entity_type: str
    entity_id: str
    action: Literal["create", "update", "delete"]
    payload: Mapping[str, object]
    expected_version: int | None
    client_updated_at: str


class EntityCommand:
    def __init__(self, catalog: CompiledEntityCatalog) -> None:
        self._catalog = catalog

    def create(
        self,
        scope: SpaceRuntimeHandle,
        entity_type: str,
        payload: Mapping[str, object],
        expected_version: int | None,
    ) -> MutationRequest:
        spec = self._catalog.get(entity_type)
        return self._build_create(scope, spec, payload, expected_version)

    def update(
        self,
        scope: SpaceRuntimeHandle,
        entity_type: str,
        entity_id: str,
        patch: Mapping[str, object],
        expected_version: int | None,
    ) -> MutationRequest:
        spec = self._catalog.get(entity_type)
        return self._build_update(scope, spec, entity_id, patch, expected_version)

    def delete(
        self,
        scope: SpaceRuntimeHandle,
        entity_type: str,
        entity_id: str,
        expected_version: int | None,
    ) -> MutationRequest:
        spec = self._catalog.get(entity_type)
        return self._build_delete(scope, spec, entity_id, expected_version)

    def from_sync_event(
        self, scope: SpaceRuntimeHandle, event: SyncEventLike
    ) -> MutationRequest:
        spec = self._catalog.get_by_sync_key(event.entity_type)
        payload = dict(event.payload)
        supplied_id = payload.get(spec.primary_key)
        if supplied_id is not None and supplied_id != event.entity_id:
            raise MutationRuleViolation(
                "entity_id_mismatch",
                {"entity_type": event.entity_type, "entity_id": event.entity_id},
            )
        if event.action == "create":
            payload[spec.primary_key] = event.entity_id
            return self._build_create(
                scope, spec, payload, event.expected_version,
                client_updated_at=event.client_updated_at,
            )
        if event.action == "update":
            payload.pop(spec.primary_key, None)
            return self._build_update(
                scope, spec, event.entity_id, payload, event.expected_version,
                client_updated_at=event.client_updated_at,
            )
        if payload not in ({}, {spec.primary_key: event.entity_id}):
            raise MutationRuleViolation(
                "delete_payload_not_empty",
                {"entity_type": event.entity_type, "entity_id": event.entity_id},
            )
        return self._build_delete(
            scope, spec, event.entity_id, event.expected_version,
            client_updated_at=event.client_updated_at,
        )
```

每个 returned `MutationRequest` 只含 canonical caller intent。`_build_create`、`_build_update`、`_build_delete` 将 `request.name` 分别固定为 `entity.create`、`entity.update`、`entity.delete`，并将 `request.entity_type` 固定为 catalog internal `spec.name`；注册的 domain policy 依靠这两个关闭字段接管真实实体，不能只注册 REST 使用的虚拟类型。Sync 的 top-level `entity_id` 是 wire identity authority：create 总是把它写入 catalog 声明的 primary-key field；update 只允许 payload 中同值 ID 并在构造 patch 前移除该 primary key；delete 只允许空 payload或同值 ID。任一 mismatch 产生 `entity_id_mismatch` pre-rejection，在 S4 的 prepared durable receipt 内保留，且零 operation/stage/ledger/entity 写入。regular REST create/update/delete 的 `client_updated_at=None`；`from_sync_event` 要求 S4 已严格解析的 canonical UTC timestamp，并把它作为 request metadata 端到端保留，不能用服务器 now、payload.updated_at 或 route clock 补值。UoW 取得 Space-exclusive 后，Entity compiler 执行 parent active existence、Folder ancestor walk with visited set、relation endpoints active existence、catalog delete strategy、payload field allowlist 和 `id + version` CAS validation，并生成 serializable `DbMutationPlan`；`DbMutationInterpreter` 在同一 transaction 应用 plan，CAS 失败重读区分 not_found/version_conflict。

Sync update/delete 的决策只能由这个 under-lease compiler 作出：expected version 相等则 clean apply、`resolution=None`；不相等时比较 canonical `client_updated_at` 与 authoritative row `updated_at`，client 较新才生成 remote-wins command 并持久化 `resolution="remote"`，client 较旧或相等产生 `version_conflict` rejection 且 details 固定 `resolution="local"`，缺失/不可比较 authority timestamp 产生 `version_conflict` + `resolution="manual"`。tombstone/cycle 仍优先成为对应 rejection；create 不运行 LWW。compiler 决策、command 和 terminal result 共同持久化，retry/recovery 只读 receipt，绝不重算 wall clock。`tests/test_sync_integration.py` 对现有 legacy `conflict_local`/`conflict_remote` fixtures 逐项比较新 compiler 结果，S4 删除 legacy writer 前必须保持等价。

Task 4 的 catalog compiler 给 TS0 后仍保留的真实 junction（至少 `schedule_quick_note`）编译明确的 endpoint entity/field metadata；不得让 `task_quick_note`、`session_quick_note` 或不存在的 `task_relation` 成为 S3 最终 gate。list helper 始终 `ORDER BY requested_sort, primary_key`，cursor/page tests 包含相同 sort value。`from_sync_event` 只做 wire-to-request mapping 并调用同一 `_build_*`；标注 S4 integration point，禁止复制 invariant code。

- [ ] **Step 4: Run invariant, concurrency, and pagination gates**

```powershell
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $true
.\.venv\Scripts\python.exe -m pytest -q tests/test_entity_invariants.py tests/test_entity_concurrency.py tests/test_routes_pagination.py tests/test_sync_integration.py -p no:cacheprovider
.\.venv\Scripts\ruff.exe check --no-cache app/commands/entity.py tests/test_entity_invariants.py tests/test_entity_concurrency.py tests/test_sync_integration.py
```

Expected: PASS; one CAS winner, stable tie order, and the single `MutationRejectedError` carries restart-stable canonical cycle/relation/version codes/details rather than task-order-dependent subclasses.

- [ ] **Step 5: Commit EntityCommand**

```powershell
git add app/commands/__init__.py app/commands/entity.py app/registry/entities.py app/registry/catalog.py app/registry/builtin.py app/services/base.py app/services/schedule.py app/services/folder.py app/services/task.py app/services/session.py app/services/habit.py app/services/quick_note.py app/services/reflection.py app/services/time_block.py tests/test_entity_invariants.py tests/test_entity_concurrency.py tests/test_routes_pagination.py tests/test_sync_integration.py
git commit -m "feat(commands): centralize entity invariants and cas"
```

## Task 7: Make Folder And Note Projections Deterministic

**Files:**
- Create: `backend/app/knowledge/__init__.py`
- Create: `backend/app/knowledge/commands.py`
- Create: `backend/app/knowledge/projections.py`
- Create: `backend/app/knowledge/store.py`
- Create: `backend/app/knowledge/consistency.py`
- Modify: `backend/app/file_system/frontmatter.py`
- Modify: `backend/tests/test_note_workspace_atomicity.py`
- Modify: `backend/tests/test_file_system/test_folder_ops.py`
- Modify: `backend/tests/test_file_system/test_note_ops.py`
- Modify: `backend/tests/test_file_system/test_search_ops.py`

**Interfaces:**
- Consumes: Task 6 `EntityCommand`, Task 4 `MutationUnitOfWork`, Task 3 projection staging, and authoritative Markdown/Space DB handles from the current runtime scope.
- Produces: `KnowledgeStore` Note/Folder operations, deterministic ordered `ProjectionPlan` sets, `SpaceDataView`, and read-only authority/projection consistency verification with no independent commit path.

- [ ] **Step 1: Write failing Folder projection and Note metadata/path/body authority tests**

```python
@pytest.mark.asyncio
async def test_folder_create_is_visible_to_note_create_without_second_writer(knowledge_fixture) -> None:
    folder = await knowledge_fixture.store.create_folder(
        knowledge_fixture.scope,
        {"id": "f1", "name": "Research", "parent_id": None},
        expected_version=None,
        operation_id="folder-f1",
    )
    note = await knowledge_fixture.store.create_note(
        knowledge_fixture.scope,
        {"id": "n1", "title": "Paper", "folder_id": "f1", "content": "Body"},
        expected_version=None,
        operation_id="note-n1",
    )
    assert folder.value["id"] == "f1"
    assert note.value["folder_id"] == "f1"
    knowledge_fixture.assert_folder_projection_matches_space_db("f1")


@pytest.mark.asyncio
async def test_note_metadata_update_moves_file_and_rewrites_frontmatter_and_fts(
    knowledge_fixture,
) -> None:
    await knowledge_fixture.create_note("n1", title="Old", folder_id="f1", content="Body term")

    result = await knowledge_fixture.store.update_note_metadata(
        knowledge_fixture.scope,
        "n1",
        {"title": "New", "folder_id": "f2", "tags": ["tag"]},
        expected_version=1,
        operation_id="note-n1-meta",
    )

    assert result.value["version"] == 2
    knowledge_fixture.assert_markdown_body("n1", "Body term")
    knowledge_fixture.assert_frontmatter("n1", title="New", folder_id="f2", tags=["tag"])
    knowledge_fixture.assert_only_path("n1", folder_id="f2", title="New")
    knowledge_fixture.assert_index_and_fts_match("n1")
```

另测 content-only、combined content+metadata、Folder move/rename/trash/restore 对 descendant Note paths 的 deterministic plans。

- [ ] **Step 2: Run knowledge atomicity tests**

```powershell
.\.venv\Scripts\python.exe -m pytest -q tests/test_note_workspace_atomicity.py tests/test_file_system/test_folder_ops.py tests/test_file_system/test_note_ops.py -p no:cacheprovider
```

Expected: FAIL because Folder REST writes only `space.db` and Note metadata currently leaves Markdown/path/FTS stale.

- [ ] **Step 3: Implement commands, projections, and a non-committing store**

`KnowledgeStore` 公开 methods 必须列全：create/update/move/trash/restore/purge Folder；create/update_content/update_metadata/move/trash/restore/purge/cleanup_versions Note；convert QuickNote。每个 method 只构造 command 并调用 UoW：

```python
class KnowledgeStore:
    async def create_note(
        self,
        scope: SpaceRuntimeHandle,
        payload: Mapping[str, object],
        expected_version: int | None,
        operation_id: str,
    ) -> MutationResult:
        request = self.commands.create_note_request(payload, expected_version)
        return await self.uow.execute(scope, request, operation_id)

    async def update_note_metadata(
        self,
        scope: SpaceRuntimeHandle,
        note_id: str,
        patch: Mapping[str, object],
        expected_version: int,
        operation_id: str,
    ) -> MutationResult:
        request = self.commands.update_note_metadata_request(
            note_id, patch, expected_version
        )
        return await self.uow.execute(scope, request, operation_id)
```

其余 public methods 使用同一形状，不接收裸 `AsyncSession`/absolute path。`KnowledgeCommands` 的公开 builder 只生成可序列化 `MutationRequest`，不读取 DB/Markdown。UoW 取得 Space-exclusive 后调用同文件的 compiler：读取 authority snapshot、调用 Entity compiler 生成 `DbMutationPlan`，并让 `KnowledgeProjectionBuilder` 生成 ordered plans：Markdown body/frontmatter/path、Folder index row、Note index row、FTS、version/trash。target 全为 Space-relative；same locked authority + same request 产生相同 bytes、path、hash。Folder index 只能由 Folder projection 写。

`consistency.py` 定义 read-only staging/live verification view，供 S5 不绕过内部 journal 或伪造 runtime handle：

```python
@dataclass(frozen=True)
class SpaceDataView:
    space_id: str
    db_path: Path
    notes_dir: Path
    index_db: Path
    catalog_hash: str


class KnowledgeConsistencyChecker:
    async def verify(self, view: SpaceDataView) -> ConsistencyReport:
        return await asyncio.to_thread(self._verify_read_only, view)

    async def rebuild(self, handle: SpaceRuntimeHandle) -> RebuildResult:
        return await self._rebuild_under_handle_lease(handle)
```

`verify()` 要求三个路径已存在，以 SQLite `mode=ro` 读取，校验 Folder/Note metadata、Markdown body hash/path/frontmatter、index/FTS/version/trash 和 catalog hash，不创建、恢复、迁移或 rebuild。`rebuild()` 只接受 live leased handle。

`frontmatter.py` 提供 canonical key order 和 LF encoding；derived frontmatter 不再被当 authority。rebuild API 从 `space.db` Folder/Note metadata 加 Markdown body 全量重建 index/FTS/frontmatter/path，遇 body hash 不符 fail closed 并报告 note ID，不覆盖 body。

- [ ] **Step 4: Run projection and rebuild tests**

```powershell
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $true
.\.venv\Scripts\python.exe -m pytest -q tests/test_note_workspace_atomicity.py tests/test_file_system/test_folder_ops.py tests/test_file_system/test_note_ops.py tests/test_file_system/test_search_ops.py -p no:cacheprovider
.\.venv\Scripts\ruff.exe check --no-cache app/knowledge app/file_system/frontmatter.py tests/test_note_workspace_atomicity.py
```

Expected: PASS; Folder and Note authority/projections converge and controlled rebuild reproduces identical hashes.

- [ ] **Step 5: Commit KnowledgeStore projections**

```powershell
git add app/knowledge/__init__.py app/knowledge/commands.py app/knowledge/projections.py app/knowledge/store.py app/knowledge/consistency.py app/file_system/frontmatter.py tests/test_note_workspace_atomicity.py tests/test_file_system/test_folder_ops.py tests/test_file_system/test_note_ops.py tests/test_file_system/test_search_ops.py
git commit -m "feat(knowledge): project folders and notes atomically"
```

## Task 8: Close Trash, Purge, Version, And QuickNote Conversion Lifecycles

**Files:**
- Modify: `backend/app/knowledge/commands.py`
- Modify: `backend/app/knowledge/projections.py`
- Modify: `backend/app/knowledge/store.py`
- Modify: `backend/app/services/note.py`
- Modify: `backend/app/services/quick_note.py`
- Modify: `backend/app/services/cascade.py`
- Modify: `backend/tests/test_note_workspace_atomicity.py`
- Modify: `backend/tests/test_note_service.py`
- Modify: `backend/tests/test_trash_routes.py`
- Modify: `backend/tests/test_quick_note_convert.py`

**Interfaces:**
- Consumes: Task 7 `KnowledgeStore`/projection builders and Task 4 batch execution/visibility barrier.
- Produces: complete trash/restore/purge/version lifecycle commands and atomic QuickNote-to-Note batch conversion, each returning the persisted `MutationResult`/`BatchMutationResult` receipt.

- [ ] **Step 1: Write failing complete lifecycle and conversion retry tests**

```python
@pytest.mark.asyncio
async def test_note_purge_removes_every_old_artifact_and_emits_one_delete(knowledge_fixture) -> None:
    await knowledge_fixture.create_and_trash_note_with_versions("n1", version_count=3)

    result = await knowledge_fixture.store.purge_note(
        knowledge_fixture.scope,
        "n1",
        expected_version=2,
        operation_id="purge-n1",
    )

    assert result.state is MutationState.FINALIZED
    knowledge_fixture.assert_absent_from_orm_markdown_index_fts_versions_trash("n1")
    knowledge_fixture.assert_old_entity_ledger_removed("note", "n1")
    knowledge_fixture.assert_single_current_tombstone_and_delete_event("note", "n1")


@pytest.mark.asyncio
async def test_non_note_restore_and_folder_purge_emit_visible_ledger(knowledge_fixture) -> None:
    await knowledge_fixture.create_trashed_folder_tree("root", children=["child"])
    await knowledge_fixture.store.restore_folder(
        knowledge_fixture.scope, "child", 1, "restore-child"
    )
    await knowledge_fixture.store.purge_folder(
        knowledge_fixture.scope, "root", 1, "purge-root"
    )
    knowledge_fixture.assert_visible_actions(
        [("folder", "child", "update"), ("folder", "root", "delete")]
    )


@pytest.mark.asyncio
async def test_quick_note_conversion_retry_returns_one_note_and_one_result(knowledge_fixture) -> None:
    await knowledge_fixture.create_quick_note(
        "q1", content="Title\nBody", memo_comments=("source-c1", "source-c2")
    )
    first = await knowledge_fixture.store.convert_quick_note(
        knowledge_fixture.scope, "q1", expected_version=1, operation_id="convert-q1"
    )
    second = await knowledge_fixture.store.convert_quick_note(
        knowledge_fixture.scope, "q1", expected_version=1, operation_id="convert-q1"
    )
    assert second == first
    assert knowledge_fixture.note_count_for_conversion("q1") == 1
    converted_comment_ids = knowledge_fixture.converted_comment_ids("q1")
    assert len(converted_comment_ids) == 2
    assert len(set(converted_comment_ids)) == 2
    assert knowledge_fixture.visible_batch_events("convert-q1") == {
        "note:create",
        "quickNote:update",
        *(f"memoComment:{comment_id}:create" for comment_id in converted_comment_ids),
    }
```

- [ ] **Step 2: Run lifecycle tests and observe bypassed-ledger/partial-FS failures**

```powershell
.\.venv\Scripts\python.exe -m pytest -q tests/test_note_workspace_atomicity.py tests/test_note_service.py tests/test_trash_routes.py tests/test_quick_note_convert.py -p no:cacheprovider
```

Expected: FAIL on non-Note restore/purge ledger assertions, complete purge artifacts, and conversion retry idempotency.

- [ ] **Step 3: Implement complete projection sets and conversion batch**

Purge command before-image manifest 必须包含 ORM rows、Markdown active/trash path、index rows、FTS row、version files/rows、existing tombstones 和 prior entity ledger rows。business mutation 删除 old ORM/tombstone/prior ledger，建立当前 tombstone 和 invisible delete event；projection finalize 删除 files/index/FTS/version/trash。compensation 可从 before images 恢复全部 old state并删除 current delete event。

Folder purge 对 descendants 采用一个 batch，child order deepest-first；每个 descendant 有独立 operation，whole batch visibility barrier。restore 对 Note/Folder/QuickNote 都通过 UoW 并 emit update event；Settings 不进入此 finding，禁止添加 Settings ledger。

QuickNote conversion 构造一个 batch：Note create、QuickNote CAS update、每个 MemoComment copy 各一个 accepted child。Note ID 从 caller operation ID deterministic 派生；每个 copied MemoComment 的新 entity ID 与 child operation ID 从 `sha256(caller_operation_id + "\0memo_comment\0" + source_comment_id)` deterministic 派生。全部派生映射与 ordered child IDs 持久化在 INTENT command JSON，重试不生成新 ID。`memo_comment` 是 catalog 中 `sync_enabled=True` 的实体，因此每个 copy 产生一个 invisible `memoComment:create`，并与 Note/QuickNote events 通过同一 batch barrier 一次开放。任一 child finalize 失败，batch forward-completes all or compensates all reverse；原 QuickNote 保持 active 或完整 converted，不允许中间态。测试覆盖零/一/多个 comment、retry/restart 无重复，以及 comment finalize fault 的全旧/全新结果。

将旧 NoteService 的 Try-Compensate write bodies 替换为 KnowledgeStore delegation；读取 methods 可保留。删除 `except Exception` 中的即时 FS compensation，防止与 durable recovery 两套补偿并存。

- [ ] **Step 4: Run lifecycle, ledger, and fault regressions**

```powershell
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $true
.\.venv\Scripts\python.exe -m pytest -q tests/test_note_workspace_atomicity.py tests/test_mutation_recovery.py tests/test_note_service.py tests/test_trash_routes.py tests/test_quick_note_convert.py tests/test_sync_outbox_service.py -p no:cacheprovider
.\.venv\Scripts\ruff.exe check --no-cache app/knowledge app/services/note.py app/services/quick_note.py app/services/cascade.py tests/test_trash_routes.py
```

Expected: PASS; purge leaves only the current deletion proof, restore emits exactly one event, and conversion retries create one logical result.

- [ ] **Step 5: Commit complete knowledge lifecycles**

```powershell
git add app/knowledge/commands.py app/knowledge/projections.py app/knowledge/store.py app/services/note.py app/services/quick_note.py app/services/cascade.py tests/test_note_workspace_atomicity.py tests/test_note_service.py tests/test_trash_routes.py tests/test_quick_note_convert.py
git commit -m "feat(knowledge): make trash purge and conversion durable"
```

## Task 9: Convert REST Mutation Routes To Thin UoW Adapters

**Files:**
- Modify: `backend/app/deps.py`
- Modify: `backend/app/routes/v1/notes.py`
- Modify: `backend/app/routes/v1/folders.py`
- Modify: `backend/app/routes/v1/quick_notes.py`
- Modify: `backend/app/routes/v1/trash.py`
- Modify: `backend/app/routes/v1/schedules.py`
- Modify: `backend/app/routes/v1/habits.py`
- Modify: `backend/app/routes/v1/reflections.py`
- Modify: `backend/app/routes/v1/time_blocks.py`
- Modify: `backend/tests/test_routes_v1.py`
- Modify: `backend/tests/test_error_contract_v2.py`
- Modify: `backend/tests/test_trash_routes.py`
- Modify: `backend/tests/test_routes_pagination.py`

**Interfaces:**
- Consumes: Task 7/8 `KnowledgeStore`, Task 6 `EntityCommand`, Task 4 `MutationUnitOfWork`/`MutationCompiler`, S2 sealed catalog, and S1 legacy/canonical `AppError` rendering.
- Produces: process-stable `get_compiled_entity_catalog()`; extensible `get_mutation_compiler(catalog) -> MutationCompiler`; request-scoped operation-ID provider; REST mutation adapters that preserve existing bodies, accept `Idempotency-Key`, return `X-Operation-ID`, and call exactly one store/UoW method without committing.

- [ ] **Step 1: Write failing header/retry/thin-adapter tests**

```python
@pytest.mark.asyncio
async def test_rest_reuses_idempotency_key_and_returns_effective_operation_id(
    authenticated_client,
) -> None:
    headers = {"Idempotency-Key": "client-note-create-1"}
    body = {"id": "n1", "title": "Title", "content": "Body"}

    first = await authenticated_client.post("/api/v1/notes", json=body, headers=headers)
    second = await authenticated_client.post("/api/v1/notes", json=body, headers=headers)

    assert first.status_code == second.status_code == 201
    assert first.json() == second.json()
    assert first.headers["X-Operation-ID"] == "client-note-create-1"
    assert second.headers["X-Operation-ID"] == "client-note-create-1"


@pytest.mark.asyncio
async def test_rest_generates_operation_id_when_header_absent(authenticated_client) -> None:
    response = await authenticated_client.post(
        "/api/v1/folders", json={"id": "f1", "name": "Folder"}
    )
    assert response.status_code == 201
    assert response.headers["X-Operation-ID"]


@pytest.mark.asyncio
async def test_route_never_calls_session_commit(route_fixture, monkeypatch) -> None:
    monkeypatch.setattr(route_fixture.session, "commit", AsyncMock(side_effect=AssertionError("route commit")))
    response = await route_fixture.create_schedule(idempotency_key="schedule-create-1")
    assert response.status_code == 201


@pytest.mark.parametrize(
    "case", ["cycle_detected", "version_conflict", "idempotency_conflict"]
)
async def test_stored_mutation_failure_uses_the_shared_error_carrier(
    authenticated_client, mutation_error_case, case: str
) -> None:
    request = await mutation_error_case(authenticated_client, case)
    legacy = await request(headers={})
    canonical = await request(headers={"Accept": CANONICAL_ACCEPT})

    assert legacy.status_code == canonical.status_code
    assert legacy.json() == expected_legacy_mutation_body(case)
    assert canonical.json() == expected_canonical_mutation_body(
        case, request_id=canonical.headers["X-Request-ID"]
    )
    assert set(canonical.json()) == {
        "code", "message", "retryable", "request_id", "details"
    }
```

- [ ] **Step 2: Run route tests and verify duplicate/route-commit failures**

```powershell
.\.venv\Scripts\python.exe -m pytest -q tests/test_routes_v1.py tests/test_trash_routes.py tests/test_routes_pagination.py -p no:cacheprovider
```

Expected: FAIL because routes commit directly and do not return operation IDs.

- [ ] **Step 3: Add request operation identity and delegate every mutation**

`deps.py` 提供：

```python
@lru_cache(maxsize=1)
def get_compiled_entity_catalog() -> CompiledEntityCatalog:
    return CompiledEntityCatalog.compile(REGISTRY.list(), version=CATALOG_VERSION)


def get_mutation_compiler(
    catalog: CompiledEntityCatalog = Depends(get_compiled_entity_catalog),
) -> MutationCompiler:
    return MutationCompiler(catalog, policies=())


def get_operation_id(request: Request, response: Response) -> str:
    supplied = request.headers.get("Idempotency-Key")
    operation_id = supplied.strip() if supplied else f"req-{uuid.uuid4().hex}"
    validate_operation_id(operation_id)
    response.headers["X-Operation-ID"] = operation_id
    return operation_id
```

The existing UoW dependency must consume `get_mutation_compiler`; no route or
domain Module constructs a second generic compiler. `MutationCompiler` always
retains its built-in catalog fallback when `policies=()`. TS1 and TS2 later
replace only this composition function's policies tuple with their concrete
domain policies and keep the same catalog, journal, stage, interpreter, and
recovery instances.

所有 POST/PUT/PATCH/DELETE route 使用同一个 request-scoped `SpaceRuntimeHandle`，接收 `operation_id=Depends(get_operation_id)`，构造 `KnowledgeStore` 或 `EntityCommand`，调用 UoW，直接映射 stored result 到原 response schema；删除 `await db.commit()`。GET/list/search/version routes 仍用 read handle。expected version 从 schema/body 或 `If-Match` 映射；缺少 version 的 legacy route 按已读取当前 version 构造 CAS，但 OpenAPI 标记 additive deprecation，不能静默 last-write-wins。

示例：

```python
@router.post("", response_model=NoteResponse, status_code=201)
async def create_note(
    data: NoteCreate,
    operation_id: str = Depends(get_operation_id),
    store: KnowledgeStore = Depends(get_knowledge_store),
    runtime: SpaceRuntimeHandle = Depends(get_mutation_runtime),
) -> dict[str, object]:
    result = await store.create_note(
        runtime,
        data.model_dump(),
        expected_version=None,
        operation_id=operation_id,
    )
    return dict(result.value)
```

DB-only routes 使用 `EntityCommand.create/update/delete` + UoW，保留 byte-for-byte default error body 和 response schema。`MutationRejectedError` 与 `IdempotencyConflictError` 直接经过 S1 的 shared `AppError` handler；route 不 catch/relabel，不把 stored `retryable` 重算成 mutable code table，也不在 retry 时生成新 request ID 以外的业务字段。Trash route 不再 resolve model/commit/FS purge；只调用 KnowledgeStore。源码检查不允许这些 mutation routes 出现 `.commit(` 或直接 `record_sync_event(`。

- [ ] **Step 4: Run REST contracts and direct-commit scan**

```powershell
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $true
.\.venv\Scripts\python.exe -m pytest -q tests/test_routes_v1.py tests/test_trash_routes.py tests/test_routes_pagination.py tests/test_note_service.py tests/test_entity_concurrency.py tests/test_error_contract_v2.py -p no:cacheprovider
$PSNativeCommandUseErrorActionPreference = $false
$violations = @(& rg -n "\.commit\(|record_sync_event\(" app/routes/v1/notes.py app/routes/v1/folders.py app/routes/v1/quick_notes.py app/routes/v1/trash.py app/routes/v1/schedules.py app/routes/v1/habits.py app/routes/v1/reflections.py app/routes/v1/time_blocks.py 2>$null)
$routeStatus = $LASTEXITCODE
$PSNativeCommandUseErrorActionPreference = $true
if ($routeStatus -eq 0) { $violations; throw "route mutation bypass remains" }
if ($routeStatus -ne 1) { throw "rg failed with exit $routeStatus" }
```

Expected: tests PASS; `rg` returns zero matches.

- [ ] **Step 5: Commit thin REST adapters**

```powershell
git add app/deps.py app/routes/v1/notes.py app/routes/v1/folders.py app/routes/v1/quick_notes.py app/routes/v1/trash.py app/routes/v1/schedules.py app/routes/v1/habits.py app/routes/v1/reflections.py app/routes/v1/time_blocks.py tests/test_routes_v1.py tests/test_trash_routes.py tests/test_routes_pagination.py tests/test_error_contract_v2.py
git commit -m "refactor(api): delegate mutations to shared unit of work"
```

## Task 10: Persist And Reuse Official Frontend Idempotency Keys

**Files:**
- Create: `frontend/src/services/idempotency.ts`
- Create: `frontend/src/services/idempotency.test.ts`
- Modify: `frontend/src/services/api.ts`
- Modify: `frontend/src/services/api.test.ts`
- Modify: `frontend/src/types/index.ts`
- Modify: `frontend/src/services/database.ts`
- Modify: `frontend/src/services/database.test.ts`
- Modify: `frontend/src/lib/sync/outbox.ts`
- Modify: `frontend/src/lib/sync/outbox.test.ts`
- Modify: `frontend/src/lib/sync/push-batch.ts`
- Modify: `frontend/src/lib/sync/push-batch.test.ts`
- Modify: `frontend/src/lib/quick-notes/quick-note-repository.ts`
- Modify: `frontend/src/lib/quick-notes/quick-note-repository.test.ts`
- Modify: `frontend/src/stores/trash-store.ts`
- Modify: `frontend/src/stores/trash-store.test.ts`

**Interfaces:**
- Consumes: Task 9 `Idempotency-Key`/`X-Operation-ID` contract and S3 backend stable operation/batch identity.
- Produces: `ensureMutationIdempotencyKey(config)`, `buildBatchIdempotencyKey(operationIds)`, Dexie v17 persisted `OutboxEvent.operationId`, and retry/merge paths that retain the original identity.

- [ ] **Step 1: Write failing Axios retry and persisted-outbox key tests**

```typescript
import { describe, expect, it } from 'vitest'
import { buildBatchIdempotencyKey, ensureMutationIdempotencyKey } from './idempotency'

describe('mutation idempotency', () => {
  it('adds a key to writes, keeps an explicit key, and skips reads', () => {
    const write = ensureMutationIdempotencyKey({ method: 'post', headers: {} })
    const explicit = ensureMutationIdempotencyKey({
      method: 'patch',
      headers: { 'Idempotency-Key': 'caller-key' },
    })
    const read = ensureMutationIdempotencyKey({ method: 'get', headers: {} })
    expect(write.headers['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/)
    expect(explicit.headers['Idempotency-Key']).toBe('caller-key')
    expect(read.headers['Idempotency-Key']).toBeUndefined()
  })

  it('derives the same bounded batch key from persisted operation IDs', async () => {
    const rows = [{ operationId: 'op-a' }, { operationId: 'op-b' }]
    expect(await buildBatchIdempotencyKey(rows)).toBe(
      await buildBatchIdempotencyKey(rows)
    )
    expect((await buildBatchIdempotencyKey(rows)).length).toBe(69)
  })
})
```

在 existing API test 捕获首次/401 reissue/Cloudflare retry configs，断言同一 header；Dexie test 从 v16 row 升 v17 后 `operationId` non-empty，并覆盖 create/update/unknown-delete 的 expected-version migration；outbox merge 保留 original ID 与最早 base version；repository/trash tests证明 update/delete 在本地 version 增加前捕获 base version；push retry 重用 hash header。

- [ ] **Step 2: Run focused frontend tests and verify missing idempotency support**

Run from `frontend/`:

```powershell
npm test -- src/services/idempotency.test.ts src/services/api.test.ts src/services/database.test.ts src/lib/sync/outbox.test.ts src/lib/sync/push-batch.test.ts src/lib/quick-notes/quick-note-repository.test.ts src/stores/trash-store.test.ts
```

Expected: FAIL because helper/field/v17 do not exist and push has no header.

- [ ] **Step 3: Implement stable request and outbox operation IDs**

`idempotency.ts` 使用 mutation method allowlist `POST/PUT/PATCH/DELETE`；caller header 优先；生成 `crypto.randomUUID()`；Axios retry 重用 original config，所以不得在 response interceptor 重建 key。stable batch hash：

```typescript
export async function buildBatchIdempotencyKey(
  rows: ReadonlyArray<{ operationId: string }>,
): Promise<string> {
  if (rows.length === 0 || rows.some((row) => !row.operationId)) {
    throw new Error('Persisted operation IDs are required')
  }
  const bytes = new TextEncoder().encode(rows.map((row) => row.operationId).join('\n'))
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  const hex = Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('')
  return `sync-${hex}`
}
```

`OutboxEvent.operationId: string`, `expectedVersion: number | null`, `requiresVersionRebase: boolean` 都 required。create 的 expectedVersion 固定 null；每个新 update/delete caller 必须把本地写前的实体 version 传给 `enqueueOutbox`。Dexie v17 不给这些字段建 index，但必须声明真实 version 并在一个 IndexedDB version transaction 中回填；事务中断会整体回滚，重开后重新执行，不会留下部分行：

```typescript
this.version(17)
  .stores({
    outbox: '++id, entityType, entityId, synced, createdAt',
  })
  .upgrade(async (tx) => {
    await tx.table<OutboxEvent, number>('outbox').toCollection().modify((row) => {
      if (!row.operationId) row.operationId = crypto.randomUUID()
      if (row.action === 'create') {
        row.expectedVersion = null
        row.requiresVersionRebase = false
        return
      }
      const payload = JSON.parse(row.payload) as Record<string, unknown>
      const version = payload.version
      if (Number.isInteger(version) && Number(version) >= 2) {
        row.expectedVersion = Number(version) - 1
        row.requiresVersionRebase = false
      } else {
        row.expectedVersion = null
        row.requiresVersionRebase = true
      }
    })
  })
```

`enqueueOutbox` new row 生成一次 operationId并验证 version contract；keep/replace merge绝不修改 existing operationId，且 update→update/update→delete/delete→create 保留最早 known expectedVersion；create链始终为 null；create+delete drop row同时删除 key。`requiresVersionRebase` row不得进入 v2 push；S4 recovery/rebase flow处理后才能生成新 operation。`pushBatch`：

```typescript
const idempotencyKey = await buildBatchIdempotencyKey(rows)
const res = await api.post<ApiSyncPushResponse>(
  '/sync/push',
  { events },
  { headers: { 'Idempotency-Key': idempotencyKey } },
)
```

`api.ts` request interceptor 在添加 Authorization 后调用 helper，只有不存在 key 时生成。401/Cloudflare retry config 保留 header。

- [ ] **Step 4: Run frontend protocol tests, typecheck, and lint**

```powershell
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $true
npm test -- src/services/idempotency.test.ts src/services/api.test.ts src/services/database.test.ts src/lib/sync/outbox.test.ts src/lib/sync/push-batch.test.ts src/lib/quick-notes/quick-note-repository.test.ts src/stores/trash-store.test.ts
npm run typecheck
npm run lint
```

Expected: PASS; v16 upgrade得到持久 key；known base version保留，unknown legacy row fail closed为 requires-rebase；merge/retry不改变 key/base version，explicit key不被覆盖。No UI component behavior changes.

- [ ] **Step 5: Commit official-client idempotency maintenance**

```powershell
git add src/services/idempotency.ts src/services/idempotency.test.ts src/services/api.ts src/services/api.test.ts src/types/index.ts src/services/database.ts src/services/database.test.ts src/lib/sync/outbox.ts src/lib/sync/outbox.test.ts src/lib/sync/push-batch.ts src/lib/sync/push-batch.test.ts src/lib/quick-notes/quick-note-repository.ts src/lib/quick-notes/quick-note-repository.test.ts src/stores/trash-store.ts src/stores/trash-store.test.ts
git commit -m "feat(client): persist mutation idempotency keys"
```

## Task 11: Run The S3 Exit Gate And Review The Wave

**Files:**
- Create: `backend/scripts/check_backend_authority.py`
- Modify: `backend/tests/test_sync_outbox_service.py`
- Modify: `backend/tests/test_routes_v1.py`
- Modify other files only if a failing assertion proves an S3 regression in files already listed in this plan.

**Interfaces:**
- Consumes: every S3 Task 1-10 public interface and the exact approved backend/frontend commands below.
- Produces: reusable test-only `backend/scripts/check_backend_authority.py --app-root PATH [--include-route RELATIVE_PATH]`; one reviewed S3 head/evidence set proving schema parity, durable recovery, authority consistency, idempotency, and no direct-commit bypass; no new production interface.

- [ ] **Step 1: Run the exact approved S3 backend gate**

Run from `backend/`:

```powershell
.\.venv\Scripts\python.exe -m pytest -q tests/test_note_workspace_atomicity.py tests/test_mutation_recovery.py tests/test_note_service.py tests/test_trash_routes.py tests/test_entity_invariants.py tests/test_entity_concurrency.py tests/test_routes_pagination.py tests/test_sync_integration.py -p no:cacheprovider
```

Expected: PASS with zero unexpected xfail/xpass. Fault count must equal the declared matrix; all-old/all-new, retry uniqueness, batch barrier and FAILED_MANUAL blocking are explicit assertions.

- [ ] **Step 2: Run schema, ledger, filesystem, route, and frontend adjacent regressions**

Run the backend block from `backend/`:

```powershell
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $true
.\.venv\Scripts\python.exe -m pytest -q tests/test_mutation_migration.py tests/test_mutation_journal.py tests/test_mutation_staging.py tests/test_migration_runner.py tests/test_sync_outbox_service.py tests/test_sync_cursor_pagination.py tests/test_quick_note_convert.py tests/test_file_system tests/test_routes_v1.py -p no:cacheprovider
.\.venv\Scripts\ruff.exe check --no-cache app tests
```

Run the frontend block from `frontend/`:

```powershell
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $true
npm test -- src/services/idempotency.test.ts src/services/api.test.ts src/services/database.test.ts src/lib/sync/outbox.test.ts src/lib/sync/push-batch.test.ts
npm run typecheck
npm run lint
```

Expected: all commands PASS. S3 does not claim opaque cursor/ACK/recovery snapshot completion.

- [ ] **Step 3: Scan for bypasses and duplicate authorities**

Run from repository root:

Create this reusable test-only gate exactly as backend/scripts/check_backend_authority.py. S4 invokes this same file after adding its Sync Adapter; it must not copy these rules into another test or shell here-string.

```python
from __future__ import annotations

import argparse
import ast
import re
from dataclasses import dataclass, field
from pathlib import Path

S3_ROUTE_FILES = (
    Path("routes/v1/notes.py"),
    Path("routes/v1/folders.py"),
    Path("routes/v1/quick_notes.py"),
    Path("routes/v1/trash.py"),
    Path("routes/v1/schedules.py"),
    Path("routes/v1/habits.py"),
    Path("routes/v1/reflections.py"),
    Path("routes/v1/time_blocks.py"),
)
WRITE_CONSTRUCTORS = {"insert", "update", "delete"}
ORM_WRITE_METHODS = {
    "add", "add_all", "merge", "delete",
    "bulk_save_objects", "bulk_insert_mappings", "bulk_update_mappings",
}
PATH_MUTATORS = {
    "write_text", "write_bytes", "unlink", "rename", "replace",
    "mkdir", "rmdir", "touch", "write", "writelines", "truncate",
}
FILE_MODULE_OWNERS = {"os", "shutil"}
FILE_MODULE_MUTATORS = {
    "remove", "unlink", "rename", "replace", "mkdir", "makedirs",
    "rmdir", "removedirs", "copy", "copy2", "copyfile", "move",
}
INDEX_OWNERS = {"index", "index_store", "search_index", "fts"}
INDEX_MUTATORS = {"add", "delete", "remove", "upsert", "rebuild", "update"}
RAW_SQL_WRITE = re.compile(
    r"\b(?:INSERT|UPDATE|DELETE|MERGE|REPLACE|CREATE|ALTER|DROP|TRUNCATE|"
    r"VACUUM|REINDEX|ATTACH|DETACH)\b|\bPRAGMA\b[^\r\n;]*=",
    re.IGNORECASE,
)
RAW_SQL_READ = re.compile(r"\b(?:SELECT|WITH)\b", re.IGNORECASE)
SYNC_OUTBOX_SQL = re.compile(r"\bsync_outbox\b", re.IGNORECASE)


@dataclass
class AliasFacts:
    relation_names: dict[str, str] = field(
        default_factory=lambda: {"SyncOutbox": "canonical"}
    )
    sqlalchemy_modules: set[str] = field(default_factory=set)
    select_names: set[str] = field(default_factory=lambda: {"select"})
    and_names: set[str] = field(default_factory=lambda: {"and_"})
    aliased_names: set[str] = field(default_factory=lambda: {"aliased"})
    text_names: set[str] = field(default_factory=lambda: {"text"})
    table_names: set[str] = field(default_factory=lambda: {"Table"})
    write_constructor_names: set[str] = field(
        default_factory=lambda: set(WRITE_CONSTRUCTORS)
    )
    table_aliases: set[str] = field(default_factory=set)
    write_statement_aliases: set[str] = field(default_factory=set)
    orm_write_aliases: set[str] = field(default_factory=set)
    session_aliases: set[str] = field(default_factory=lambda: {"db", "session"})
    session_type_names: set[str] = field(
        default_factory=lambda: {"Session", "AsyncSession"}
    )
    sql_executor_aliases: set[str] = field(default_factory=set)
    raw_sql_executor_aliases: set[str] = field(default_factory=set)
    static_strings: dict[str, str] = field(default_factory=dict)


@dataclass(frozen=True)
class SyncOutboxRead:
    node: ast.Call
    relation_ids: frozenset[str]
    kind: str


def dotted_name(node: ast.AST) -> str:
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        prefix = dotted_name(node.value)
        return f"{prefix}.{node.attr}" if prefix else node.attr
    return ""


def assigned_names(node: ast.AST) -> tuple[str, ...]:
    if isinstance(node, ast.Name):
        return (node.id,)
    if isinstance(node, (ast.Tuple, ast.List)):
        return tuple(
            name
            for item in node.elts
            for name in assigned_names(item)
        )
    return ()


def call_matches(
    func: ast.AST,
    names: set[str],
    modules: set[str],
    canonical: str,
) -> bool:
    name = dotted_name(func)
    return name in names or any(name == f"{module}.{canonical}" for module in modules)


def static_string(
    node: ast.AST,
    bindings: dict[str, str],
    seen: frozenset[str] = frozenset(),
) -> str | None:
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    if isinstance(node, ast.Name):
        if node.id in seen:
            return None
        return bindings.get(node.id)
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
        left = static_string(node.left, bindings, seen)
        right = static_string(node.right, bindings, seen)
        return None if left is None or right is None else left + right
    if isinstance(node, ast.JoinedStr):
        parts: list[str] = []
        for value in node.values:
            if isinstance(value, ast.Constant) and isinstance(value.value, str):
                parts.append(value.value)
            elif isinstance(value, ast.FormattedValue):
                rendered = static_string(value.value, bindings, seen)
                if rendered is None:
                    return None
                parts.append(rendered)
            else:
                return None
        return "".join(parts)
    if (
        isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and node.func.attr == "join"
        and len(node.args) == 1
        and isinstance(node.args[0], (ast.Tuple, ast.List))
    ):
        separator = static_string(node.func.value, bindings, seen)
        values = [static_string(item, bindings, seen) for item in node.args[0].elts]
        if separator is not None and all(value is not None for value in values):
            return separator.join(value for value in values if value is not None)
    return None


def static_sql_candidate(node: ast.AST, facts: AliasFacts) -> str:
    exact = static_string(node, facts.static_strings)
    if exact is not None:
        return exact
    if isinstance(node, ast.Call):
        resolved = [
            static_string(argument, facts.static_strings)
            for argument in (*node.args, *(item.value for item in node.keywords))
        ]
        if any(value is not None for value in resolved):
            return "".join(value for value in resolved if value is not None)
    return "".join(
        item.value
        for item in ast.walk(node)
        if isinstance(item, ast.Constant) and isinstance(item.value, str)
    )


def is_table_call(node: ast.AST, facts: AliasFacts) -> bool:
    return (
        isinstance(node, ast.Call)
        and call_matches(
            node.func, facts.table_names, facts.sqlalchemy_modules, "Table"
        )
        and bool(node.args)
        and static_string(node.args[0], facts.static_strings) == "sync_outbox"
    )


def relation_ids(node: ast.AST, facts: AliasFacts) -> set[str]:
    if isinstance(node, ast.Name):
        relation = facts.relation_names.get(node.id)
        return {relation} if relation is not None else set()
    if isinstance(node, ast.Attribute):
        if node.attr == "SyncOutbox":
            return {"canonical"}
        return relation_ids(node.value, facts)
    if isinstance(node, ast.Subscript):
        key = static_string(node.slice, facts.static_strings)
        if key == "sync_outbox" and dotted_name(node.value).endswith(".tables"):
            return {"canonical"}
        return relation_ids(node.value, facts)
    if isinstance(node, ast.Starred):
        return relation_ids(node.value, facts)
    if isinstance(node, ast.Call):
        if is_table_call(node, facts):
            return {f"inline-table:{node.lineno}:{node.col_offset}"}
        if (
            isinstance(node.func, ast.Attribute)
            and node.func.attr in ("alias", "subquery")
            and relation_ids(node.func.value, facts)
        ):
            return {f"inline-table-alias:{node.lineno}:{node.col_offset}"}
        if call_matches(
            node.func, facts.aliased_names, facts.sqlalchemy_modules, "aliased"
        ) and node.args and relation_ids(node.args[0], facts):
            return {f"inline-alias:{node.lineno}:{node.col_offset}"}
        found: set[str] = set()
        for argument in (*node.args, *(item.value for item in node.keywords)):
            found.update(relation_ids(argument, facts))
        return found
    if isinstance(node, (ast.Tuple, ast.List, ast.Set)):
        found: set[str] = set()
        for item in node.elts:
            found.update(relation_ids(item, facts))
        return found
    if isinstance(node, ast.Dict):
        found: set[str] = set()
        for item in (*node.keys, *node.values):
            if item is not None:
                found.update(relation_ids(item, facts))
        return found
    return set()


def is_sync_outbox_ref(node: ast.AST, facts: AliasFacts) -> bool:
    return bool(relation_ids(node, facts))


def is_table_expression(node: ast.AST, facts: AliasFacts) -> bool:
    if isinstance(node, ast.Name) and node.id in facts.table_aliases:
        return True
    if is_table_call(node, facts):
        return True
    if isinstance(node, ast.Attribute) and node.attr == "__table__":
        return True
    if isinstance(node, ast.Subscript):
        return dotted_name(node.value).endswith(".tables")
    if (
        isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and node.func.attr in {"alias", "subquery"}
    ):
        return is_table_expression(node.func.value, facts)
    return False


def is_session_receiver(node: ast.AST, facts: AliasFacts) -> bool:
    parts = [part.lower() for part in dotted_name(node).split(".") if part]
    return any(
        part in {"db", "session"}
        or part.endswith("_db")
        or part.endswith("_session")
        or part in facts.session_aliases
        for part in parts
    )


def is_write_constructor_ref(node: ast.AST, facts: AliasFacts) -> bool:
    name = dotted_name(node)
    leaf = name.rsplit(".", 1)[-1]
    if name in facts.write_constructor_names:
        return True
    if leaf in WRITE_CONSTRUCTORS and any(
        name == f"{module}.{leaf}" for module in facts.sqlalchemy_modules
    ):
        return True
    return (
        isinstance(node, ast.Attribute)
        and node.attr in WRITE_CONSTRUCTORS
        and is_table_expression(node.value, facts)
    )


def is_raw_sql_write(node: ast.AST, facts: AliasFacts) -> bool:
    sql = static_sql_candidate(node, facts)
    if isinstance(node, ast.Call):
        leaf = dotted_name(node.func).rsplit(".", 1)[-1]
        is_raw_entry = (
            call_matches(node.func, facts.text_names, facts.sqlalchemy_modules, "text")
            or leaf == "exec_driver_sql"
        )
        if is_raw_entry and not sql:
            return True
    return RAW_SQL_WRITE.search(sql) is not None


def is_session_annotation(node: ast.AST | None, facts: AliasFacts) -> bool:
    if node is None:
        return False
    return any(
        (isinstance(item, ast.Name) and item.id in facts.session_type_names)
        or (
            isinstance(item, ast.Attribute)
            and item.attr in {"Session", "AsyncSession"}
        )
        for item in ast.walk(node)
    )


def is_write_statement_expr(
    node: ast.AST,
    facts: AliasFacts,
    seen: frozenset[int] = frozenset(),
) -> bool:
    if id(node) in seen:
        return False
    seen = seen | {id(node)}
    if isinstance(node, ast.Name):
        return node.id in facts.write_statement_aliases
    if isinstance(node, ast.Await):
        return is_write_statement_expr(node.value, facts, seen)
    if not isinstance(node, ast.Call):
        return False
    if is_write_constructor_ref(node.func, facts):
        return True
    if call_matches(node.func, facts.text_names, facts.sqlalchemy_modules, "text"):
        return is_raw_sql_write(node, facts)
    if isinstance(node.func, ast.Attribute):
        if is_write_statement_expr(node.func.value, facts, seen):
            return True
        if (
            node.func.attr in {"update", "delete"}
            and isinstance(node.func.value, ast.Call)
            and isinstance(node.func.value.func, ast.Attribute)
            and node.func.value.func.attr == "query"
            and is_session_receiver(node.func.value.func.value, facts)
        ):
            return True
    return False


def discover_aliases(tree: ast.AST) -> AliasFacts:
    facts = AliasFacts()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for item in node.names:
                local = item.asname or item.name.split(".", 1)[0]
                if item.name.startswith("sqlalchemy"):
                    facts.sqlalchemy_modules.add(local)
        elif isinstance(node, ast.ImportFrom):
            module = node.module or ""
            for item in node.names:
                local = item.asname or item.name
                if item.name == "SyncOutbox":
                    facts.relation_names[local] = "canonical"
                if module.startswith("sqlalchemy"):
                    if item.name in {"Session", "AsyncSession"}:
                        facts.session_type_names.add(local)
                    elif item.name == "select":
                        facts.select_names.add(local)
                    elif item.name == "and_":
                        facts.and_names.add(local)
                    elif item.name == "aliased":
                        facts.aliased_names.add(local)
                    elif item.name == "text":
                        facts.text_names.add(local)
                    elif item.name == "Table":
                        facts.table_names.add(local)
                    elif item.name in WRITE_CONSTRUCTORS:
                        facts.write_constructor_names.add(local)

    for node in ast.walk(tree):
        if isinstance(node, ast.arg) and is_session_annotation(node.annotation, facts):
            facts.session_aliases.add(node.arg)
        elif (
            isinstance(node, ast.AnnAssign)
            and isinstance(node.target, ast.Name)
            and is_session_annotation(node.annotation, facts)
        ):
            facts.session_aliases.add(node.target.id)

    assignments = [
        node for node in ast.walk(tree)
        if isinstance(node, (ast.Assign, ast.AnnAssign))
    ]
    for _ in range(len(assignments) + 1):
        changed = False
        for assignment in assignments:
            targets = (
                tuple(
                    name
                    for target in assignment.targets
                    for name in assigned_names(target)
                )
                if isinstance(assignment, ast.Assign)
                else assigned_names(assignment.target)
            )
            value = assignment.value
            if value is None or not targets:
                continue
            rendered = static_string(value, facts.static_strings)
            if rendered is not None:
                for target in targets:
                    if facts.static_strings.get(target) != rendered:
                        facts.static_strings[target] = rendered
                        changed = True

            if is_session_receiver(value, facts):
                for target in targets:
                    if target not in facts.session_aliases:
                        facts.session_aliases.add(target)
                        changed = True

            if call_matches(
                value, facts.table_names, facts.sqlalchemy_modules, "Table"
            ):
                for target in targets:
                    if target not in facts.table_names:
                        facts.table_names.add(target)
                        changed = True

            if (
                isinstance(value, ast.Call)
                and call_matches(
                    value.func,
                    facts.aliased_names,
                    facts.sqlalchemy_modules,
                    "aliased",
                )
                and value.args
                and relation_ids(value.args[0], facts)
            ):
                for target in targets:
                    relation = f"alias:{target}"
                    if facts.relation_names.get(target) != relation:
                        facts.relation_names[target] = relation
                        changed = True
            elif isinstance(value, (ast.Name, ast.Attribute, ast.Subscript)):
                relations = relation_ids(value, facts)
                if len(relations) == 1:
                    relation = next(iter(relations))
                    for target in targets:
                        if facts.relation_names.get(target) != relation:
                            facts.relation_names[target] = relation
                            changed = True

            table_value = is_table_expression(value, facts)
            if table_value and isinstance(value, ast.Call):
                table_relations = relation_ids(value, facts)
                if table_relations:
                    for target in targets:
                        relation = f"table-alias:{target}"
                        if facts.relation_names.get(target) != relation:
                            facts.relation_names[target] = relation
                            changed = True
            if table_value:
                for target in targets:
                    if target not in facts.table_aliases:
                        facts.table_aliases.add(target)
                        changed = True

            if is_write_constructor_ref(value, facts):
                for target in targets:
                    if target not in facts.write_constructor_names:
                        facts.write_constructor_names.add(target)
                        changed = True
            if is_write_statement_expr(value, facts):
                for target in targets:
                    if target not in facts.write_statement_aliases:
                        facts.write_statement_aliases.add(target)
                        changed = True
            if (
                isinstance(value, ast.Attribute)
                and value.attr in ORM_WRITE_METHODS
                and is_session_receiver(value.value, facts)
            ) or (isinstance(value, ast.Name) and value.id in facts.orm_write_aliases):
                for target in targets:
                    if target not in facts.orm_write_aliases:
                        facts.orm_write_aliases.add(target)
                        changed = True
            if (
                isinstance(value, ast.Attribute)
                and value.attr in {"execute", "scalar", "scalars", "exec_driver_sql"}
                and is_session_receiver(value.value, facts)
            ) or (
                isinstance(value, ast.Name)
                and value.id in facts.sql_executor_aliases
            ):
                for target in targets:
                    if target not in facts.sql_executor_aliases:
                        facts.sql_executor_aliases.add(target)
                        changed = True
            if (
                isinstance(value, ast.Attribute)
                and value.attr == "exec_driver_sql"
                and is_session_receiver(value.value, facts)
            ) or (
                isinstance(value, ast.Name)
                and value.id in facts.raw_sql_executor_aliases
            ):
                for target in targets:
                    if target not in facts.raw_sql_executor_aliases:
                        facts.raw_sql_executor_aliases.add(target)
                        changed = True
        if not changed:
            break
    return facts


def chain_root(node: ast.AST, parents: dict[ast.AST, ast.AST]) -> ast.AST:
    current = node
    while current in parents:
        parent = parents[current]
        if isinstance(parent, ast.Attribute) and parent.value is current:
            current = parent
            continue
        if isinstance(parent, ast.Call) and parent.func is current:
            current = parent
            continue
        break
    return current


def query_chain_calls(root: ast.AST) -> tuple[ast.Call, ...]:
    calls: list[ast.Call] = []
    current = root
    while isinstance(current, ast.Call):
        calls.append(current)
        if isinstance(current.func, ast.Attribute) and isinstance(
            current.func.value, ast.Call
        ):
            current = current.func.value
            continue
        break
    return tuple(calls)


def is_select_call(node: ast.Call, facts: AliasFacts) -> bool:
    return call_matches(
        node.func, facts.select_names, facts.sqlalchemy_modules, "select"
    )


def raw_sync_outbox_read(node: ast.Call, facts: AliasFacts) -> str | None:
    leaf = dotted_name(node.func).rsplit(".", 1)[-1]
    is_raw_entry = (
        call_matches(node.func, facts.text_names, facts.sqlalchemy_modules, "text")
        or leaf == "exec_driver_sql"
        or (
            isinstance(node.func, ast.Name)
            and node.func.id in facts.raw_sql_executor_aliases
        )
    )
    is_sql_executor = leaf == "execute" or (
        isinstance(node.func, ast.Name)
        and node.func.id in facts.sql_executor_aliases
    )
    if not (is_raw_entry or is_sql_executor):
        return None
    sql = static_sql_candidate(node, facts)
    arguments = (*node.args, *(item.value for item in node.keywords))
    references_relation = any(
        relation_ids(item, facts)
        for argument in arguments
        for item in ast.walk(argument)
    )
    sql_argument = node.args[0] if node.args else next(
        (
            item.value
            for item in node.keywords
            if item.arg in {"text", "statement", "sql"}
        ),
        None,
    )
    resolved_sql = (
        static_string(sql_argument, facts.static_strings)
        if sql_argument is not None
        else None
    )
    if is_raw_entry and (sql_argument is None or resolved_sql is None):
        return "raw-dynamic"
    if is_raw_entry:
        sql = resolved_sql or ""
    if (
        RAW_SQL_READ.search(sql) is not None
        and (SYNC_OUTBOX_SQL.search(sql) is not None or references_relation)
    ):
        return "raw"
    return None


def is_known_relation_consumer(node: ast.Call, facts: AliasFacts) -> bool:
    if (
        is_select_call(node, facts)
        or call_matches(
            node.func, facts.aliased_names, facts.sqlalchemy_modules, "aliased"
        )
        or is_table_call(node, facts)
        or is_write_constructor_ref(node.func, facts)
    ):
        return True
    if not isinstance(node.func, ast.Attribute):
        return False
    leaf = node.func.attr
    if leaf in {"query", "get", "get_one"}:
        return is_session_receiver(node.func.value, facts)
    return leaf in {
        "select_from", "join", "outerjoin", "where", "filter", "filter_by",
        "order_by", "group_by", "having",
    }


def argument_has_relation_escape(node: ast.AST, facts: AliasFacts) -> bool:
    if isinstance(node, (ast.Name, ast.Attribute, ast.Subscript)):
        return is_sync_outbox_ref(node, facts)
    if isinstance(node, ast.Starred):
        return argument_has_relation_escape(node.value, facts)
    if isinstance(node, (ast.Tuple, ast.List, ast.Set)):
        return any(argument_has_relation_escape(item, facts) for item in node.elts)
    if isinstance(node, ast.Dict):
        return any(
            item is not None and argument_has_relation_escape(item, facts)
            for item in (*node.keys, *node.values)
        )
    return False


def collect_unknown_relation_escapes(
    tree: ast.AST,
    facts: AliasFacts,
    parents: dict[ast.AST, ast.AST],
) -> tuple[ast.AST, ...]:
    escapes: list[ast.AST] = []
    containers = (ast.Tuple, ast.List, ast.Set, ast.Dict)
    for node in ast.walk(tree):
        if isinstance(node, ast.Call):
            if is_known_relation_consumer(node, facts):
                continue
            arguments = (*node.args, *(item.value for item in node.keywords))
            if any(argument_has_relation_escape(item, facts) for item in arguments):
                escapes.append(node)
            continue
        if not isinstance(node, containers) or not argument_has_relation_escape(
            node, facts
        ):
            continue
        parent = parents.get(node)
        if isinstance(parent, containers):
            continue
        current: ast.AST = node
        while isinstance(parents.get(current), (ast.Starred, ast.keyword)):
            current = parents[current]
        if isinstance(parents.get(current), ast.Call):
            continue
        escapes.append(node)
    return tuple(escapes)


def collect_sync_outbox_reads(
    tree: ast.AST,
    facts: AliasFacts,
    parents: dict[ast.AST, ast.AST],
) -> tuple[SyncOutboxRead, ...]:
    reads: list[SyncOutboxRead] = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        raw_kind = raw_sync_outbox_read(node, facts)
        if raw_kind is not None:
            reads.append(SyncOutboxRead(node, frozenset(), raw_kind))
            continue
        leaf = dotted_name(node.func).rsplit(".", 1)[-1]
        relations: set[str] = set()
        kind = ""
        if is_select_call(node, facts):
            kind = "select"
            for argument in (*node.args, *(item.value for item in node.keywords)):
                relations.update(relation_ids(argument, facts))
            root = chain_root(node, parents)
            for chained in query_chain_calls(root):
                chained_leaf = dotted_name(chained.func).rsplit(".", 1)[-1]
                if chained_leaf in {"select_from", "join", "outerjoin"}:
                    for argument in chained.args:
                        relations.update(relation_ids(argument, facts))
        elif (
            leaf == "query"
            and isinstance(node.func, ast.Attribute)
            and is_session_receiver(node.func.value, facts)
        ):
            kind = "query"
            for argument in node.args:
                relations.update(relation_ids(argument, facts))
        elif (
            leaf == "select"
            and isinstance(node.func, ast.Attribute)
            and is_table_expression(node.func.value, facts)
        ):
            kind = "table-select"
            relations.update(relation_ids(node.func.value, facts))
        elif (
            leaf in {"get", "get_one"}
            and isinstance(node.func, ast.Attribute)
            and is_session_receiver(node.func.value, facts)
            and node.args
        ):
            kind = "direct-get"
            relations.update(relation_ids(node.args[0], facts))
        if relations:
            reads.append(SyncOutboxRead(node, frozenset(relations), kind))
    return tuple(reads)


def top_level_and_conjuncts(
    node: ast.AST,
    facts: AliasFacts,
) -> tuple[ast.AST, ...]:
    if (
        isinstance(node, ast.Call)
        and call_matches(node.func, facts.and_names, facts.sqlalchemy_modules, "and_")
    ):
        return tuple(
            conjunct
            for argument in node.args
            for conjunct in top_level_and_conjuncts(argument, facts)
        )
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.BitAnd):
        return (
            *top_level_and_conjuncts(node.left, facts),
            *top_level_and_conjuncts(node.right, facts),
        )
    return (node,)


def visible_true_relation_ids(node: ast.AST, facts: AliasFacts) -> set[str]:
    if (
        not isinstance(node, ast.Call)
        or not isinstance(node.func, ast.Attribute)
        or node.func.attr != "is_"
        or len(node.args) != 1
        or not isinstance(node.args[0], ast.Constant)
        or node.args[0].value is not True
    ):
        return set()
    visible = node.func.value
    if not isinstance(visible, ast.Attribute) or visible.attr != "visible":
        return set()
    owner = visible.value
    if isinstance(owner, ast.Attribute) and owner.attr == "c":
        owner = owner.value
    return relation_ids(owner, facts)


def read_has_visible_conjunct(
    read: SyncOutboxRead,
    root: ast.AST,
    facts: AliasFacts,
) -> tuple[bool, bool]:
    visible_relations: set[str] = set()
    unsafe_nested_visibility = False
    for chained in query_chain_calls(root):
        if dotted_name(chained.func).rsplit(".", 1)[-1] not in {"where", "filter"}:
            continue
        for predicate in chained.args:
            for conjunct in top_level_and_conjuncts(predicate, facts):
                relation = visible_true_relation_ids(conjunct, facts)
                if relation:
                    visible_relations.update(relation)
                elif any(
                    visible_true_relation_ids(item, facts)
                    for item in ast.walk(conjunct)
                ):
                    unsafe_nested_visibility = True
    return (
        read.relation_ids <= visible_relations and not unsafe_nested_visibility,
        unsafe_nested_visibility,
    )


def is_statically_dead(
    node: ast.AST,
    parents: dict[ast.AST, ast.AST],
) -> bool:
    current = node
    while current in parents:
        parent = parents[current]
        if isinstance(parent, (ast.If, ast.While)):
            try:
                condition = ast.literal_eval(parent.test)
            except (ValueError, TypeError, SyntaxError):
                condition = None
            if condition is False and current in parent.body:
                return True
            if isinstance(parent, ast.If) and condition is True and current in parent.orelse:
                return True
        current = parent
    return False


def attribute_write_targets(node: ast.AST) -> tuple[ast.Attribute, ...]:
    targets: tuple[ast.AST, ...] = ()
    if isinstance(node, ast.Assign):
        targets = tuple(node.targets)
    elif isinstance(node, (ast.AnnAssign, ast.AugAssign, ast.NamedExpr)):
        targets = (node.target,)
    elif isinstance(node, ast.Delete):
        targets = tuple(node.targets)
    return tuple(
        item
        for target in targets
        for item in ast.walk(target)
        if isinstance(item, ast.Attribute) and isinstance(item.ctx, (ast.Store, ast.Del))
    )


def opens_for_write(node: ast.Call) -> bool:
    if dotted_name(node.func).rsplit(".", 1)[-1] != "open":
        return False
    mode: ast.AST | None = node.args[1] if len(node.args) > 1 else None
    for keyword in node.keywords:
        if keyword.arg == "mode":
            mode = keyword.value
    if mode is None:
        return False
    if not isinstance(mode, ast.Constant) or not isinstance(mode.value, str):
        return True
    return any(flag in mode.value for flag in "wax+")


def route_violations(tree: ast.AST, path: Path, facts: AliasFacts) -> list[str]:
    violations: list[str] = []
    for node in ast.walk(tree):
        for target in attribute_write_targets(node):
            violations.append(
                f"{path}:{target.lineno}: forbidden route ORM attribute assignment"
            )
        if not isinstance(node, ast.Call):
            continue
        name = dotted_name(node.func)
        leaf = name.rsplit(".", 1)[-1]
        parts = {part.lower() for part in name.split(".")}
        if leaf in {"commit", "flush", "record_sync_event"}:
            violations.append(f"{path}:{node.lineno}: forbidden route call {name}")
        elif (
            leaf in ORM_WRITE_METHODS
            and isinstance(node.func, ast.Attribute)
            and is_session_receiver(node.func.value, facts)
        ) or (isinstance(node.func, ast.Name) and node.func.id in facts.orm_write_aliases):
            violations.append(
                f"{path}:{node.lineno}: forbidden route ORM write {name}"
            )
        elif leaf == "setattr":
            violations.append(
                f"{path}:{node.lineno}: forbidden route ORM attribute assignment"
            )
        elif (
            leaf == "exec_driver_sql" and is_raw_sql_write(node, facts)
        ) or (
            isinstance(node.func, ast.Name)
            and node.func.id in facts.raw_sql_executor_aliases
            and (
                not node.args
                or not static_sql_candidate(node.args[0], facts)
                or is_raw_sql_write(node.args[0], facts)
            )
        ) or (
            (
                leaf in {"execute", "scalar", "scalars"}
                or (
                    isinstance(node.func, ast.Name)
                    and node.func.id in facts.sql_executor_aliases
                )
            )
            and any(
                is_write_statement_expr(argument, facts)
                or is_raw_sql_write(argument, facts)
                for argument in (*node.args, *(item.value for item in node.keywords))
            )
        ):
            violations.append(f"{path}:{node.lineno}: direct SQL write execute")
        elif call_matches(
            node.func, facts.text_names, facts.sqlalchemy_modules, "text"
        ) and is_raw_sql_write(node, facts):
            violations.append(f"{path}:{node.lineno}: raw SQL write")
        elif opens_for_write(node):
            violations.append(f"{path}:{node.lineno}: direct write-mode open")
        elif leaf in PATH_MUTATORS:
            violations.append(f"{path}:{node.lineno}: direct filesystem mutator {name}")
        elif leaf in FILE_MODULE_MUTATORS and parts & FILE_MODULE_OWNERS:
            violations.append(
                f"{path}:{node.lineno}: direct filesystem API mutator {name}"
            )
        elif leaf in INDEX_MUTATORS and parts & INDEX_OWNERS:
            violations.append(f"{path}:{node.lineno}: direct index mutator {name}")
    return violations


def parse_app(app_root: Path) -> dict[Path, ast.AST]:
    app_files = tuple(sorted(app_root.rglob("*.py")))
    if not app_files:
        raise SystemExit("no backend/app Python files found")
    trees: dict[Path, ast.AST] = {}
    for app_file in app_files:
        try:
            trees[app_file] = ast.parse(
                app_file.read_text(encoding="utf-8"), filename=str(app_file)
            )
        except (OSError, UnicodeError, SyntaxError) as exc:
            raise SystemExit(f"{app_file}: AST parse failed: {exc}") from exc
    return trees


def run_gate(app_root: Path, include_routes: tuple[Path, ...]) -> tuple[int, int, int]:
    trees = parse_app(app_root)
    routes = tuple(app_root / path for path in (*S3_ROUTE_FILES, *include_routes))
    missing_routes = [route for route in routes if route not in trees]
    if missing_routes:
        raise SystemExit(f"missing exact route files: {missing_routes}")

    violations: list[str] = []
    for route in routes:
        facts = discover_aliases(trees[route])
        violations.extend(route_violations(trees[route], route, facts))

    for class_name, expected_path in (
        ("SpaceRuntimeHandle", app_root / "runtime/space.py"),
        ("EntityCommand", app_root / "commands/entity.py"),
    ):
        definitions = [
            (app_file, node.lineno)
            for app_file, tree in trees.items()
            for node in ast.walk(tree)
            if isinstance(node, ast.ClassDef) and node.name == class_name
        ]
        if len(definitions) != 1 or definitions[0][0] != expected_path:
            violations.append(
                f"{class_name} authority mismatch: expected {expected_path}, "
                f"got {definitions}"
            )

    read_count = 0
    for app_file, tree in trees.items():
        facts = discover_aliases(tree)
        parents = {
            child: parent
            for parent in ast.walk(tree)
            for child in ast.iter_child_nodes(parent)
        }
        for escape in collect_unknown_relation_escapes(tree, facts, parents):
            violations.append(
                f"{app_file}:{escape.lineno}: unknown SyncOutbox relation escape"
            )
        for read in collect_sync_outbox_reads(tree, facts, parents):
            read_count += 1
            if read.kind == "raw-dynamic":
                violations.append(
                    f"{app_file}:{read.node.lineno}: dynamic raw SQL reader "
                    "cannot be proven not to read SyncOutbox"
                )
                continue
            if read.kind == "raw":
                violations.append(
                    f"{app_file}:{read.node.lineno}: "
                    "raw SQL SyncOutbox read is forbidden"
                )
                continue
            if is_statically_dead(read.node, parents):
                violations.append(
                    f"{app_file}:{read.node.lineno}: "
                    "statically dead SyncOutbox read is forbidden"
                )
                continue
            if read.kind == "direct-get":
                violations.append(
                    f"{app_file}:{read.node.lineno}: "
                    "direct SyncOutbox get cannot enforce visibility"
                )
                continue
            root = chain_root(read.node, parents)
            valid, unsafe_nested = read_has_visible_conjunct(read, root, facts)
            if unsafe_nested:
                violations.append(
                    f"{app_file}:{read.node.lineno}: SyncOutbox visibility "
                    "under OR/NOT/IfExp is forbidden"
                )
            elif not valid:
                violations.append(
                    f"{app_file}:{read.node.lineno}: "
                    "SyncOutbox visible predicate must be a top-level AND conjunct"
                )
    if read_count == 0:
        violations.append("no SyncOutbox read paths found under backend/app")
    if violations:
        raise SystemExit("\n".join(violations))
    return len(trees), len(routes), read_count


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--app-root", required=True, type=Path)
    parser.add_argument(
        "--include-route",
        action="append",
        default=[],
        type=Path,
        help="route path relative to --app-root",
    )
    args = parser.parse_args()
    if any(path.is_absolute() or ".." in path.parts for path in args.include_route):
        raise SystemExit("--include-route must stay relative to --app-root")
    app_files, routes, reads = run_gate(
        args.app_root, tuple(args.include_route)
    )
    print(
        f"AUTHORITY_GATE_OK app_files={app_files} routes={routes} "
        f"sync_outbox_reads={reads}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
```

```powershell
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $true
& .\backend\.venv\Scripts\python.exe backend/scripts/check_backend_authority.py --app-root backend/app
if ($LASTEXITCODE -ne 0) { throw 'AST authority and route gate failed' }
& .\backend\.venv\Scripts\python.exe -m pytest -q backend/tests/test_entity_invariants.py backend/tests/test_entity_concurrency.py backend/tests/test_routes_v1.py backend/tests/test_sync_outbox_service.py -p no:cacheprovider
if ($LASTEXITCODE -ne 0) { throw 'authority and ledger behavior gate failed' }
```

Expected:

- the reusable AST gate parses every `backend/app/**/*.py` file and the exact ten S3 route files;
- no route contains direct session/db `add/add_all/merge/delete`, ORM attribute assignment, commit/flush, aliased SQLAlchemy insert/update/delete execution, raw SQL writes, ledger writes, or direct filesystem/index mutation;
- `SpaceRuntimeHandle` exists only in `app/runtime/space.py`;
- `EntityCommand` exists only in `app/commands/entity.py`;
- the entity/concurrency/route behavior gate passes without an invariant bypass;
- every recognized `SyncOutbox` read in the complete application tree, including direct/import/module-qualified/assignment/`aliased()` forms and SQLAlchemy Core `Table("sync_outbox", ...)`/`.alias()`/`.subquery()` relations, has the same relation's exact `visible.is_(True)` as a top-level SQL AND conjunct;
- dynamic `text(...)`/`exec_driver_sql(...)` readers fail closed, static raw SQL `sync_outbox` reads fail, and visibility under OR, NOT, `IfExp`, or statically dead control flow fails even when another safe read exists;
- passing a `SyncOutbox` model/table relation through an unknown helper or container fails closed; only recognized select, alias, Core table, write-constructor, and query-chain consumers may receive it.

The invoked behavior files must include focused regressions named `test_s3_exit_ast_gate_rejects_orm_alias_and_raw_route_writes`, `test_s3_exit_ast_gate_requires_visible_as_top_level_and_conjunct`, `test_s3_exit_ast_gate_discovers_assignment_aliased_module_and_raw_sql_reads`, `test_s3_exit_ast_gate_rejects_dynamic_raw_core_table_and_relation_escapes`, and `test_s3_exit_ast_gate_counts_class_authorities_from_ast`. Each regression executes `backend/scripts/check_backend_authority.py` against a temporary `--app-root`, not a copied helper. RED variants include OR/NOT/`IfExp`/dead visibility, one safe plus one unsafe aliased/raw read, dynamic raw SQL, imported/module-qualified Core `Table` aliases, unknown helper/container relation escape, session/db ORM methods, attribute assignment, table/write-statement aliases, and `text("UPDATE ...")`; adjacent positive controls prove static non-outbox raw SQL, recognized select/write/query-chain consumers, separate `.where(visible, or_(...))` conjuncts, and same-alias visibility pass.

- [ ] **Step 4: Perform the mandatory state-machine and authority review**

Review the S3-only diff and attach answers to the PR:

1. Every `MutationState` transition is in `LEGAL_TRANSITIONS`; terminal states have no outgoing edge.
2. INTENT is committed before stage publish; STAGED and verified manifest hash are committed before business commit.
3. DB mutation, DB before/after images, DB_COMMITTED and invisible ledger share one outer commit.
4. every finalize step is hash-idempotent and fence-checked immediately before destructive rename/write.
5. batch ledger visibility changes in the same commit as batch FINALIZED and never child-by-child.
6. missing stage before DB_COMMITTED aborts; after DB_COMMITTED it compensates or fails manual, never silently aborts.
7. FAILED_MANUAL persists/degrades first, closes per-Space resources under its exclusive lease, releases that lease, and only then lets the owning request/bootstrap context release its global lease exactly once; reads/writes remain blocked until explicit repair.
8. purge covers ORM, Markdown, index, FTS, versions, trash, old tombstones and old ledger while retaining exactly one current deletion proof.
9. `EntityCommand.from_sync_event` delegates to the same builders; S4 has a single reuse point.
10. official client keys survive Axios retry, Dexie restart and outbox merge; no frontend UI/business files changed.
11. prepared batches hash every original index/operation ID/intent hash, persist mapper and compiler rejections together, and return the identical receipt after restart/rule drift.
12. Sync CAS mismatch uses the under-lease canonical client/server timestamp comparison, and remote/local/manual resolution is persisted rather than recomputed.

- [ ] **Step 5: Create a focused certification commit only when review fixes changed files**

Reuse the exact file-level `git add` command from the owning task for every review correction; never stage backend/frontend directories wholesale.

```powershell
git add backend/scripts/check_backend_authority.py backend/tests/test_sync_outbox_service.py backend/tests/test_routes_v1.py
git commit -m "test(mutation): certify s3 consistency gate"
```

If review required no edits, do not create an empty commit. Preserve exact test output and fault-matrix parameter count as PR evidence.

## S3 Review Gate

S3 may merge only when all conditions are true at one commit:

- S0-S2 remain green; Space migration head is exactly `space_009_mutation_journal` with one head.
- every mutation holds S2 global shared plus per-Space exclusive lease through FINALIZED/ABORTED/COMPENSATED; destructive projection steps verify fence.
- every fault point in the complete matrix converges after restart to proven all-old or all-new, except deliberately corrupted forward+inverse proof which reaches FAILED_MANUAL and blocks exposure.
- same operation ID/hash returns one stored result; different hash returns `idempotency_conflict`; prepared mapper/compiler rejections remain one ordered durable receipt across restart/catalog drift; QuickNote conversion creates one Note on retry.
- Folder graph and Note metadata/lifecycle authority is `space.db`, Note body authority is Markdown, and all derived projections rebuild deterministically.
- Note content/metadata/move/trash/restore/purge/version cleanup, Folder lifecycle, non-Note restore/purge and QuickNote conversion use the shared UoW.
- accepted batch events become visible together only after all children FINALIZED; rollback/compensation emits no visible event.
- shared EntityCommand/compiler owns parent, cycle, relation, catalog-driven strict-CAS/LWW, persistent resolution, stable ordering and delete strategy; registered domain policies cannot be bypassed by generic patch, and S4 is contractually limited to `from_sync_event()`.
- REST v1 response bodies remain compatible, `X-Operation-ID` is present, and official frontend retries/persists `Idempotency-Key` without UI work.
- the PR contains only S3 backend consistency and minimal official-client protocol maintenance; opaque cursor/ACK, MCP parity, recovery snapshots, deployment and historical report cleanup remain for later waves.

After approval, create the separate S4 branch from the approved S3 commit and execute `2026-07-14-backend-95plus-s4-sync-mcp.md`; do not begin S4 in the S3 PR.
