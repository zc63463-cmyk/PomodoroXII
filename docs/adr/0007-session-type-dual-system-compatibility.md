# 番茄钟模式 × 任务空间：`focus_sessions.session_type` 的兼容口径

**状态**：已接受（2026-09-16）

轨 3 欠账「模式与休息」（`计时器P0验收对照-2026-09-12.md` 第 6 项）此前挂着一个
未决的产品裁决：**番茄节奏 vs 项目驱动**。本 ADR 裁定为**兼容口径** —— 两者不二选一，
而是在同一张 `focus_sessions` 上加一个事实维度 `session_type`，由它决定"这一轮是投入
还是休息"。裁定如下，含四处容易走偏的边界。

## 决策

1. **一个事实维度，不是两套计时器**：`session_type ∈ {work, short_break, long_break,
   free, countdown}`，创建后**不可变**（sync 后像改它 = `session_immutable_field`），
   默认 `work`。默认值不是猜测：本列出现之前的每一行都只有一个语义（工作会话）。
2. **归因不变量零放宽**：所有类型都必须挂一个二级 WorkItem —— 休息沿用上一轮工作会话
   的二级项。attribution NOT NULL / 有效修订恰一条 / 投入投影的 fail-closed 全部不动。
3. **休息型口径（服务端权威推导）**：
   - `focused_seconds` **恒为 0**（休息不产生投入）；
   - `break_seconds = gross_seconds - paused_seconds`（净时长全部归属休息）；
   - **免复盘**：`review_state` 保持 `not_required`，结束即终态（`validity = valid`），
     不进入 `pending` 复盘流；
   - **不承接三级计划**：在线 start 与离线 provisional 快照都 fail-closed
     （`break_session_has_no_plan`），sync 的 plan 行 create 同样被拒。
4. **两条派生链各自排除休息型**：
   - 投入投影（`effort_projection`）显式跳过休息型 —— 第二道防线（第一道是
     `focused_seconds = 0`）；
   - `focus-summary` 统计排除休息型 —— 它们既不是番茄（不计 total/valid/interrupted/
     by_hour），也不该把休息的计划时长混进 `estimate_accuracy` 的分母。
5. **节奏是前端纯函数，不落库**：`lib/focus-session/session-mode.ts` 的 `planRestCycle`
   只在"完整走完一轮"后接续：投入型 `completed` → 短休 / 长休（每 `longBreakInterval`
   个番茄一次长休）；休息结束 → 下一个工作轮；`autoStartBreaks` / `autoStartPomodoros`
   控制是否自动开始。**修正一处旧口径**：结束时的 `timerCompletion` 如实反映是否走到
   计划点（旧实现恒发 `ended_early`，"每 N 个番茄长休"因此永远接不上）。
6. **依赖域不对休息设卡**：`session-launch-guard` 的「被阻塞」约束的是"要不要开始投入
   这条工作项"，休息前不弹阻塞确认（否则每轮休息都要为一个与休息无关的上游确认一次）。
7. **迁移 016 用原生 `ALTER TABLE ADD COLUMN`（幂等）**，并同步
   `task_space/migration_preflight.py::TASK_SPACE_TARGET_HEAD`（忘了改会直接拒启动）。

## 为什么不做另外三种（rejected）

- **休息只存本地、不入库**：会造出第二套计时事实 —— 统计口径分叉（哪些休息算过？）、
  跨设备看不见、复盘/投入要判断"本地行 vs 服务端行"。单一事实源的价值高于迁移成本。
- **允许无归因会话（不挂任务也能开番茄）**：需要放宽 `session_attribution_revision`
  的有效性不变量，牵动投入投影、复盘、回收站与同步一致性。本单只做"投入 × 休息"这一
  维度；无归因会话是独立裁决项，未在此 ADR 内。
- **给 `session_type` 加 DB 级 CHECK**：`focus_sessions` 被 5 张表以 FK 引用，SQLite 上
  加 CHECK 必须 copy-and-move 重建整表 + 期间关闭外键。为一条枚举约束对 5 个真实库做
  整表重建，风险/收益不成比例；同表的 `timer_completion` / `overall_progress` 亦无 CHECK，
  本列靠 policy + Pydantic `Literal` + 前端 zod `enum` 三处 fail-closed 校验。

## 加列触点（漏一处即失败）

`alembic_space/versions/016_focus_session_type.py` ・
`task_space/migration_preflight.py::TASK_SPACE_TARGET_HEAD` ・ `models/focus_session.py` ・
`registry/builtin.py` FieldSpec（行键集校验）・ `focus_session/policy.py`
（`_focus_session_row` / `_compile_start` / `_compile_activation_snapshot` /
`_clock_transition_after` / `_focused_seconds` / `_compile_sync_*` / `_to_camel_session`）・
`schemas/focus_session.py`（响应必带；入站 start / 离线快照**可选**）・
`routes/v1/active_session.py`（`_map_start_payload` / `_map_session_snapshot` 只在显式
携带时进业务载荷，旧载荷 hash 逐字不变）・ `focus_session/effort_projection.py` ・
`services/stats.py` ・ 前端 `contracts/focus-session.ts`（zod 默认 `work`）・
`sync/push-batch.ts::toFocusSessionWirePostImage` ・
`focus-session-repository.ts`（`clockAt` / `endProvisional` / 本地快照）・
`services/active-session-api.ts`（payload hash 业务载荷）・
`frontend/openapi.json` + `frontend/src/types/api-generated.ts`（drift 门禁）。

## 验收条款

1. **落库**：休息型离线 create → pause → resume → end 全链 applied；`focused_seconds = 0`、
   `break_seconds` 逐帧等于 `gross - paused`、`review_state` 全程 `not_required`。
2. **不可变**：sync 后像改 `session_type` → `session_immutable_field`，零副作用。
3. **边界**：休息型带三级计划（在线/离线/计划行 create）→ `break_session_has_no_plan`。
4. **投入与统计**：休息型不进二级投入；`focus-summary` 的番茄计数与 estimate 分母不含休息。
5. **节奏**：`planRestCycle` 逐条单测（长休间隔、提前结束不接续、休息回工作、自动开始开关）。
6. **兼容**：缺 `session_type` 的旧载荷 / 旧缓存行 / 旧 outbox 行按 `work` 解释，
   payload hash 与旧口径逐字一致。

## 语义（进 CONTEXT.md 术语表）

- **投入型会话**：`work` / `free` / `countdown` —— 累计净专注秒数、承接三级计划、结束进复盘。
- **休息型会话**：`short_break` / `long_break` —— 净时长记 `break_seconds`，投入恒 0、免复盘、不进计划。
- **番茄节奏**：相对"项目驱动"而言的轮次接续（投入 → 休息 → 投入），只由前端纯函数判定，不落库。

## 遗留（明确不在本单）

声景、认知标记、习惯打卡/连续天数接线、休息时长统计呈现（本轮只存不展示）、
无归因会话（见 rejected）、Orbit L3 浮窗。
