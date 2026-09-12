import {
  WORK_ITEM_MAX_DEPTH,
  type WorkItemDepth,
} from '@/lib/contracts/task-space'
import type { CachedWorkItem } from '@/types'

/**
 * ★ 2026-09-11 WorkItem depth：读模型派生值，唯一实现。
 *
 * 契约判定（详见报告）：depth **不是实体字段** ——
 *   - DB 无列（app/models/work_item.py 与 space 迁移都没有 depth）；
 *   - sync post-image 白名单没有它，且旧 push 通道逐字段相等、多余字段直接拒
 *     （backend/app/task_space/compiler.py:202-210, `_full_work_item_sync_candidate`）；
 *   - 业务载荷哈希不覆盖它（backend/app/task_space/module.py::_business_payload）；
 *   - 后端在**读取时**从 parent 链派生（backend/app/task_space/queries.py::_depth_of）。
 *
 * 因此前端也只把它当读投影：
 *   1. 实体契约（`workItemSchema`）与业务哈希都不含 depth；
 *   2. UI 需要的 depth 一律由本模块在读取边界派生（parent 链）；
 *   3. 无法派生的行**必须可见**（unresolvedIds → 日志 + 提示 + 重拉），绝不静默丢弃。
 */

/** 读取边界之前的实体行：depth 不属于实体契约。 */
export type WorkItemEntityRow = Omit<CachedWorkItem, 'depth'>

const asValidDepth = (value: unknown): WorkItemDepth | null => (
  value === 1 || value === 2 || value === 3 ? value : null
)

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
)

/**
 * wire / 本地行的**宽松投影**：camelCase 与 snake_case 都接受，产出实体行
 * （不含 depth）。与 repository 的严格映射共用同一份字段表：
 * `mapWorkItem` 先投影再用 `workItemSchema` 校验，读取边界只投影（不做 zod，
 * 避免一条坏行使整个任务空间页面炸掉 —— 坏行由 unresolved/日志可见）。
 */
export function projectWorkItemEntityRow(raw: unknown): WorkItemEntityRow {
  const source = isRecord(raw) ? raw : {}
  const pick = (camel: string, snake = camel): unknown => (
    source[camel] !== undefined ? source[camel] : source[snake]
  )
  return {
    id: String(pick('id') ?? ''),
    projectId: pick('projectId', 'project_id') as string,
    displayKey: pick('displayKey', 'display_key') as string,
    title: pick('title') as string,
    description: (pick('description') ?? null) as string | null,
    typeDefinitionId: pick('typeDefinitionId', 'type_definition_id') as string,
    statusDefinitionId: pick('statusDefinitionId', 'status_definition_id') as string,
    priority: (pick('priority') ?? null) as CachedWorkItem['priority'],
    parentId: (pick('parentId', 'parent_id') ?? null) as string | null,
    childRank: (pick('childRank', 'child_rank') ?? 0) as number,
    completionWindowStart: (pick('completionWindowStart', 'completion_window_start') ?? null) as string | null,
    completionWindowEnd: (pick('completionWindowEnd', 'completion_window_end') ?? null) as string | null,
    reviewPoint: (pick('reviewPoint', 'review_point') ?? null) as string | null,
    hardDeadline: (pick('hardDeadline', 'hard_deadline') ?? null) as string | null,
    effortEstimateLowerSeconds: (pick('effortEstimateLowerSeconds', 'effort_estimate_lower_seconds') ?? null) as number | null,
    effortEstimateUpperSeconds: (pick('effortEstimateUpperSeconds', 'effort_estimate_upper_seconds') ?? null) as number | null,
    effortActualSeconds: (pick('effortActualSeconds', 'effort_actual_seconds') ?? 0) as number,
    confidence: (pick('confidence') ?? null) as CachedWorkItem['confidence'],
    completedAt: (pick('completedAt', 'completed_at') ?? null) as string | null,
    cancelledAt: (pick('cancelledAt', 'cancelled_at') ?? null) as string | null,
    archivedAt: (pick('archivedAt', 'archived_at') ?? null) as string | null,
    markedAsAttention: (pick('markedAsAttention', 'marked_as_attention') ?? false) as boolean,
    labelIds: Array.isArray(pick('labelIds', 'label_ids'))
      ? (pick('labelIds', 'label_ids') as string[])
      : [],
    version: (pick('version') ?? 0) as number,
    createdAt: pick('createdAt', 'created_at') as string,
    updatedAt: pick('updatedAt', 'updated_at') as string,
  }
}

export interface WorkItemDepthInput {
  id: string
  parentId?: string | null
  /** 服务端读投影携带的 depth（GET/list 响应）；实体 post-image 不会带。 */
  depth?: unknown
}

export interface WorkItemDepthResolution {
  /** id → 派生 depth（总是 1..3）。 */
  depths: Map<string, WorkItemDepth>
  /**
   * 无法自证完整链的行（缺父行 / 环 / 超出三层）。
   *
   * 处理语义（显式定义，与后端 `_depth_of` 的断链取值一致）：断链处按**待定根**
   * 处理 —— depth=1，从而该行在 tree 里以根级可见，而不是悄悄消失；同时把 id
   * 收进 unresolvedIds，调用方必须日志 + UI 明示 + 重拉（恢复路径）。
   */
  unresolvedIds: string[]
}

/**
 * parent 链派生：与 backend/app/task_space/queries.py::_depth_of 同语义。
 * - parentId 为 null → 根（depth 1）；
 * - 父行不在本地集合里 → 断链：该行按 1 处理并记账（保证可见）；
 * - 环 / 深度超过上限 → 记账（值钳制到 3）；
 * - 服务端投影（provided depth）优先，避免整页分页时误判断链。
 */
export function resolveWorkItemDepths(
  rows: readonly WorkItemDepthInput[],
): WorkItemDepthResolution {
  const parentOf = new Map<string, string | null>()
  const providedOf = new Map<string, WorkItemDepth>()
  for (const row of rows) {
    const id = String(row.id)
    const parentId = row.parentId
    parentOf.set(id, typeof parentId === 'string' && parentId.length > 0 ? parentId : null)
    const provided = asValidDepth(row.depth)
    if (provided !== null) providedOf.set(id, provided)
  }

  const depths = new Map<string, WorkItemDepth>()
  const broken = new Set<string>()
  const visiting = new Set<string>()

  const resolve = (id: string): { depth: WorkItemDepth; broken: boolean } => {
    const known = depths.get(id)
    if (known !== undefined) return { depth: known, broken: broken.has(id) }
    const provided = providedOf.get(id)
    if (provided !== undefined) {
      depths.set(id, provided)
      return { depth: provided, broken: false }
    }
    const parentId = parentOf.get(id)
    if (parentId === undefined) {
      // 该 id 不在本地集合里（被引用但缺失）→ 断链，按待定根处理。
      broken.add(id)
      return { depth: 1, broken: true }
    }
    if (parentId === null) {
      depths.set(id, 1)
      return { depth: 1, broken: false }
    }
    if (!parentOf.has(parentId)) {
      // ★ 父行缺失：该行按**待定根**（1）处理 —— tree 按 parentId 组织，父行不在
      // 本地集合里时，只有根级位置才能让这一行可见；同时记账（fail-loud）。
      broken.add(id)
      depths.set(id, 1)
      return { depth: 1, broken: true }
    }
    if (visiting.has(id)) {
      // 环：把断点当根，记账（值钳制到 1 以免出现 >3 的假深度）。
      broken.add(id)
      depths.set(id, 1)
      return { depth: 1, broken: true }
    }
    visiting.add(id)
    const parent = resolve(parentId)
    visiting.delete(id)
    const rawDepth = parent.depth + 1
    const depth = (rawDepth > WORK_ITEM_MAX_DEPTH ? WORK_ITEM_MAX_DEPTH : rawDepth) as WorkItemDepth
    const isBroken = parent.broken || rawDepth > WORK_ITEM_MAX_DEPTH
    if (isBroken) broken.add(id)
    depths.set(id, depth)
    return { depth, broken: isBroken }
  }

  for (const row of rows) resolve(String(row.id))

  return {
    depths,
    unresolvedIds: [...broken].sort(),
  }
}

export interface WorkItemReadModel {
  items: CachedWorkItem[]
  /** 无法从 parent 链自证层级的行；调用方必须让它可见（日志 + 提示 + 重拉）。 */
  unresolvedIds: string[]
}

/**
 * ★ 2026-09-12（ADR-0003）等待前态：读模型的可选项 —— **只对 wire 行**消费
 * `preWaitingStatusDefinitionId`。本地 Dexie 行一律忽略，理由：
 *   1. 本地值来源不一致（sync merge 原样落库 / 命令响应落库前剥离 / 覆盖时机不同）；
 *   2. 「恢复」本身是一次状态迁移，离线必被 `offline_formal_mutation_forbidden`
 *      拒绝 ⇒ 消费本地值只会让提示时有时无，零功能收益。
 * wire 调用点（refreshOverview / hydrate remote）显式传入；cached 调用点不传。
 */
export interface WorkItemReadModelOptions {
  consumePreWaitingFromRaw?: boolean
}

/** wire 行上的等待前态（camel/snake 双兼容）；无值 / 空串 ⇒ null（未命中）。 */
const preWaitingFromRaw = (raw: unknown): string | null => {
  if (!isRecord(raw)) return null
  const value = raw.preWaitingStatusDefinitionId ?? raw.pre_waiting_status_definition_id
  return typeof value === 'string' && value.length > 0 ? value : null
}

/**
 * 读取边界唯一入口：原始行（wire / Dexie，camel 或 snake、可能没有 depth）
 * → 可直接渲染的读模型行。store / tree / detail 都只消费这里的产物。
 */
export function buildWorkItemReadModel(
  rawRows: readonly unknown[],
  options: WorkItemReadModelOptions = {},
): WorkItemReadModel {
  const projected = rawRows.map((raw) => projectWorkItemEntityRow(raw))
  const resolution = resolveWorkItemDepths(projected.map((row, index) => ({
    id: row.id,
    parentId: row.parentId,
    // 服务端读投影的 depth 作为**建议值**参与（wire 行才有）。
    depth: isRecord(rawRows[index]) ? (rawRows[index] as Record<string, unknown>).depth : undefined,
  })))
  return {
    items: projected.map((row, index) => ({
      ...row,
      depth: resolution.depths.get(row.id) ?? 1,
      ...(options.consumePreWaitingFromRaw
        ? { preWaitingStatusDefinitionId: preWaitingFromRaw(rawRows[index]) }
        : {}),
    })),
    unresolvedIds: resolution.unresolvedIds.filter((id) => id.length > 0),
  }
}
