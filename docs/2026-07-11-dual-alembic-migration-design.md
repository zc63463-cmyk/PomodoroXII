# PomodoroXII 双库 Alembic 迁移架构设计

> 日期：2026-07-11
> 状态：已批准，PR-C0 实施中
> 基线：`origin/main@dc8092e`（PR #36 已合并）

## 1. 背景与目标

PomodoroXII 运行时使用两类物理 SQLite 数据库：

- Meta DB：仅保存 `spaces`、`meta_settings`；
- Per-space DB：每个空间一个 `space.db`，保存 18 张业务表。

当前单一 Alembic revision 链同时包含 Meta 和业务 DDL。`alembic/env.py` 的 `include_object()` 仅影响 autogenerate，不能过滤已有 revision 中显式的 `op.create_table()`。动态验证显示 `target=meta` 与 `target=space` 均会创建全部 20 张表。

本设计目标：

1. 让 Meta 与 Space schema 在迁移层面真正物理隔离；
2. 生产容器在启动 Uvicorn 前完成迁移，失败即停止；
3. 启动时迁移所有已登记 Space；新建 Space 时立即迁移该库；
4. readiness 能校验两类数据库均位于目标 revision；
5. 当前处于开发期，允许备份后重建数据库，不承担旧“20 表混合库”的无损原地升级。

## 2. 已批准的关键决策

| 决策 | 选择 |
|---|---|
| 历史数据策略 | 开发期可重建；先备份，再初始化新双链数据库 |
| Alembic 架构 | 双环境、双 revision 链 |
| 生产迁移时机 | 容器启动前独立命令 |
| 已有 Space | 每次启动迁移全部已登记 Space |
| 新建 Space | 创建流程中立即迁移该 Space DB |
| 应用启动职责 | 只校验 schema 已到 head，不以 `create_all()` 代替 migration |

## 3. 方案比较

### 方案 A：双环境双链（采用）

```text
alembic_meta/
  env.py
  versions/
  script.py.mako

alembic_space/
  env.py
  versions/
  script.py.mako
```

优势：

- schema 边界由目录和 metadata 双重保证；
- revision 不需要运行期 target 分支；
- parity、upgrade、downgrade、readiness 都可独立验证；
- 后续新增字段时不容易误改另一类数据库。

成本：两个 Alembic 环境存在少量配置重复，可通过共享 migration helper 降低。

### 方案 B：单 env + 双 version_locations

文件较少，但 target/config 仍是运行期隐式状态；生成 revision 和执行 revision 都容易选错目录。未采用。

### 方案 C：单链 revision 内条件分支

短期改动小，但每个历史/未来 revision 都必须正确识别 target，downgrade、离线 SQL 和审查成本最高。未采用。

## 4. 目标组件

### 4.1 Metadata 边界

建立两个显式 metadata 提供器：

- `get_meta_metadata()`：只返回 `spaces`、`meta_settings`；
- `get_space_metadata()`：只返回 18 张业务表。

Alembic env、运行时 migration runner、schema parity tests 使用同一提供器，避免各自维护表名白名单。

### 4.2 Migration 配置

使用两个配置文件或等价 programmatic Config：

- Meta：`script_location=alembic_meta`，version table 使用默认 `alembic_version`；
- Space：`script_location=alembic_space`，每个 `space.db` 内使用默认 `alembic_version`。

每个 revision 文件只操作所属数据库的表，不读取 `target`。

### 4.3 启动前 migration runner

新增可执行模块，例如：

```text
python -m app.migrations upgrade-all
```

执行顺序：

1. 加载 Settings；
2. 校验数据目录和生产 secret；
3. 对 Meta DB 执行备份或开发期重建策略；
4. 升级 Meta DB 到 head；
5. 查询 `spaces` 表；
6. 逐个升级已登记 `space.db`；
7. 任一失败返回非零退出码；
8. 全部成功后才启动 Uvicorn。

Docker entrypoint：

```text
migration command -> uvicorn
```

单实例自托管场景暂不引入分布式迁移锁。若未来支持多副本，需在部署层保证 migration job 单实例执行。

### 4.4 新建 Space 流程

创建 Space 时采用补偿式事务：

1. 生成 `space_id` 与目录；
2. 创建/迁移临时 Space DB；
3. migration 成功后写入 Meta DB；
4. Meta commit 失败则关闭引擎并清理本次新建的空目录/DB；
5. 返回 201。

必须避免先登记 Meta、后迁移失败，造成“存在但不可用”的 Space。

### 4.5 应用启动与 readiness

- `init_meta_db()` 不再在生产环境调用 `create_all()`；
- `SpaceEngineManager._init_schema()` 不再在生产环境调用 `create_all()`；
- tests 可通过显式 test bootstrap helper 初始化，不复用生产路径；
- `/health/live`：只证明进程存活；
- `/health/ready`：校验 Meta revision=head、数据目录可写，必要时校验已缓存 Space revision；
- 启动 migration 已迁移所有 Space，因此 readiness 不做每次请求的全量扫描。

## 5. 数据重建策略

用户选择“开发期可重建”。实施时遵循：

1. 不自动删除任何现有数据库；
2. 提供显式备份/重建命令或文档步骤；
3. 检测到旧混合 schema 时 fail-fast，输出可执行提示；
4. 用户明确执行重建后，重新创建 Meta DB 和各 Space DB；
5. Markdown notes 如需保留，应在重建 Space DB 后通过受控重建索引/导入流程恢复，不把文件静默丢弃。

## 6. 错误处理与安全

- migration 前验证 DB 路径必须位于配置的数据根目录；
- 不接受客户端提供数据库路径；
- migration 日志不输出 secret、JWT 或笔记正文；
- 每个 Space 记录 `space_id`、revision、duration、result；
- 失败保留原 DB 和备份，不执行隐式 downgrade；
- 生产检测到 revision 非 head 时应用拒绝 ready；
- Docker 以非 root 用户执行迁移和服务。

## 7. 测试设计

### 7.1 Schema 拓扑

- Meta head 仅包含 2 张 Meta 表；
- Space head 仅包含 18 张业务表；
- Meta 无业务表；Space 无 Meta 表；
- 两类 DB 各自有且只有一个正确 version table。

### 7.2 Parity

分别比较：

- 表集合；
- 列名、类型、nullable、默认值；
- 索引与唯一约束；
- CHECK 约束。

### 7.3 Runner

- 空数据目录首次启动；
- 已到 head 的幂等重跑；
- 多个已登记 Space 全部升级；
- 单个 Space 失败导致整体非零退出；
- 旧混合 schema fail-fast；
- 非法/越界路径拒绝。

### 7.4 Space 创建

- migration 成功后才登记 Meta；
- migration 失败不产生 Meta 记录；
- Meta commit 失败执行补偿；
- 并发创建不同 Space 不互相污染。

### 7.5 容器

- production env 下 entrypoint 先迁移再启动；
- migration 失败时 Uvicorn 不启动；
- `/health/live` 与 `/health/ready` 行为分离；
- Compose 使用镜像内可用的 Python 探针。

## 8. 实施分解

### PR-C0：双库 migration foundation

- 创建 Meta/Space 双环境与首个 baseline revision；
- 建立 metadata provider；
- 替换现有单库 Alembic tests 为双库拓扑/parity tests；
- 不接 Docker，不改 readiness。

### PR-C1：runner 与运行时接入

- 实现 `upgrade-meta`、`upgrade-space`、`upgrade-all`；
- 创建 Space 时即时迁移；
- 生产禁止 `create_all()` 代替 migration；
- 增加旧混合 schema fail-fast。

### PR-C2：部署与 readiness

- Docker entrypoint 先迁移后启动；
- `/live`、`/ready`；
- Compose Python probe；
- PR 阶段 production image smoke。

### 独立 PR：FS consistency

现有 `PomodoroXII-p0-deep-fix` worktree 已有未提交 hash 修复。保持独立，不与 migration PR 混合；在 PR-C0 设计稳定后可并行验证和提交。

## 9. 验收标准

1. Meta/Space topology tests 全绿；
2. 双链 parity 覆盖表、列、索引和约束；
3. `upgrade-all` 幂等，任一失败返回非零；
4. 旧混合 schema 被明确拒绝，不静默污染；
5. 新建 Space 在返回 201 前已位于 Space head；
6. production 运行路径不使用 `create_all()` 代替 migration；
7. migration 失败时服务不接流量；
8. 主线全量测试、Ruff、Docker production smoke 全绿。

## 10. 非目标

本轮不同时实现：

- 多副本分布式 migration lock；
- PostgreSQL 迁移；
- 旧 20 表混合库的自动无损拆库；
- auth rate limit/JWT rotation；
- 完整灾备系统；
- FS hash 修复与 migration 混合提交。
