import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openPomodoroXIDB } from '@/services/dexie-v18-cutover'
import { TaskSpaceRepository } from '@/lib/task-space/task-space-repository'
import { resolveWorkItemDepths } from '@/lib/task-space/work-item-read-model'
import { selectProjectTree } from '@/stores/task-space-store'
import { applySyncEventRecord } from './merge'
import { withSpaceAuthorityFence } from './space-authority-fence'
import type { ApiSyncV2EventRecord } from './types'

/**
 * ★ 2026-09-11 WorkItem depth 回归：depth 是读模型派生值（后端 post-image
 * 白名单不含它、sync push 逐字段相等、业务哈希不覆盖它）。以前 sync pull 落库
 * 的行没有 depth，`selectProjectTree` 的 depth 过滤会让它**静默消失**。
 * 现在：merge/读取边界统一派生；缺父行的行按待定根可见并进 unresolved（fail-loud）。
 */

const databases: Array<Awaited<ReturnType<typeof openPomodoroXIDB>>> = []
const originalLocks = Object.getOwnPropertyDescriptor(navigator, 'locks')

class FakeLockManager {
  request<T>(_name: string, _options: { mode: 'exclusive' }, callback: () => Promise<T>): Promise<T> {
    return callback()
  }
}

beforeEach(() => Object.defineProperty(navigator, 'locks', {
  configurable: true, value: new FakeLockManager(),
}))

afterEach(async () => {
  while (databases.length > 0) await databases.pop()!.delete()
  if (originalLocks) Object.defineProperty(navigator, 'locks', originalLocks)
  else Reflect.deleteProperty(navigator, 'locks')
})

/** wire 形状（snake_case、**没有 depth**）：与后端 workItem post-image 一致。 */
const snakeWorkItem = (
  id: string,
  projectId: string,
  overrides: Record<string, unknown> = {},
) => ({
  id,
  project_id: projectId,
  display_key: `RM-${id}`,
  title: `Item ${id}`,
  description: null,
  type_definition_id: 'type-task',
  status_definition_id: 'status-open',
  priority: null,
  parent_id: null,
  child_rank: 0,
  completion_window_start: null,
  completion_window_end: null,
  review_point: null,
  hard_deadline: null,
  effort_estimate_lower_seconds: null,
  effort_estimate_upper_seconds: null,
  effort_actual_seconds: 0,
  confidence: null,
  completed_at: null,
  cancelled_at: null,
  archived_at: null,
  marked_as_attention: false,
  label_ids: [],
  created_at: '2026-07-15T08:00:00.000Z',
  updated_at: '2026-07-15T08:00:00.000Z',
  version: 1,
  ...overrides,
})

const workItemRecord = (
  payload: Record<string, unknown>,
  entityId: string,
  version: number,
): ApiSyncV2EventRecord => ({
  action: 'update',
  batch_id: 'batch-work-item-depth',
  created_at: '2026-07-15T08:00:00.000Z',
  entity_id: entityId,
  entity_type: 'workItem',
  operation_id: `op-${entityId}-${version}`,
  payload,
  version,
})

async function mergeWorkItem(
  db: Awaited<ReturnType<typeof openPomodoroXIDB>>,
  payload: Record<string, unknown>,
  entityId: string,
  version: number,
): Promise<void> {
  await withSpaceAuthorityFence(db.spaceId, (token) => applySyncEventRecord(
    db, db.spaceId, token, workItemRecord(payload, entityId, version), [],
  ))
}

describe('resolveWorkItemDepths (single derivation implementation)', () => {
  it('derives 1/2/3 from the parent chain and prefers the server read projection', () => {
    const resolution = resolveWorkItemDepths([
      { id: 'a', parentId: null },
      { id: 'b', parentId: 'a' },
      { id: 'c', parentId: 'b' },
      { id: 'd', parentId: 'c' }, // 超过三层 → 钳制 3 并记账
      { id: 'e', parentId: 'ghost' }, // 缺父行 → 待定根 + 记账
      { id: 'f', parentId: 'e' }, // 挂在待定根下 → 2（链同样不完整）
      { id: 'g', parentId: null, depth: 2 }, // 服务端读投影优先
    ])

    expect(resolution.depths.get('a')).toBe(1)
    expect(resolution.depths.get('b')).toBe(2)
    expect(resolution.depths.get('c')).toBe(3)
    expect(resolution.depths.get('d')).toBe(3)
    expect(resolution.depths.get('e')).toBe(1)
    expect(resolution.depths.get('f')).toBe(2)
    expect(resolution.depths.get('g')).toBe(2)
    expect(resolution.unresolvedIds).toEqual(['d', 'e', 'f'])
  })

  it('flags cycles and never invents depths above the cap', () => {
    const resolution = resolveWorkItemDepths([
      { id: 'a', parentId: 'b' },
      { id: 'b', parentId: 'a' },
    ])

    expect(resolution.unresolvedIds).toEqual(['a', 'b'])
    expect([...resolution.depths.values()].every((depth) => depth >= 1 && depth <= 3)).toBe(true)
  })
})

describe('workItem depth at the sync merge boundary', () => {
  it('keeps a depth-less merged row visible with a locally derived depth', async () => {
    const db = await openPomodoroXIDB(crypto.randomUUID())
    databases.push(db)
    const projectId = 'project-1'
    // 父行也按 merge 的形状（wire 行）落库：没有 depth、字段是 snake_case。
    await db.workItems.put(snakeWorkItem('parent', projectId))
    await mergeWorkItem(
      db,
      snakeWorkItem('child', projectId, { parent_id: 'parent' }),
      'child',
      2,
    )

    const overview = await new TaskSpaceRepository(db, db.spaceId).readCachedOverview()
    const child = overview.workItems.find((item) => item.id === 'child')

    // 旧读取边界（raw cast）+ 未改动的 selectProjectTree depth 过滤：两行都会被
    // 丢掉 —— 这就是「静默丢失」的机制（作为回归证据保留）。
    const rawRows = await db.workItems.toArray()
    expect(rawRows).toHaveLength(2)
    expect(rawRows.every((row) => row.depth === undefined)).toBe(true)
    expect(rawRows.filter((row) => (
      row.projectId === projectId && Number(row.depth) >= 1 && Number(row.depth) <= 3
    ))).toHaveLength(0)

    // 新读取边界：投影成 camelCase 实体 + 派生 depth → UI 不再丢行。
    expect(child).toMatchObject({
      id: 'child', projectId, parentId: 'parent', depth: 2,
    })
    expect(overview.unresolvedDepthItemIds).toEqual([])
    expect(selectProjectTree(overview.workItems, projectId).map((item) => item.id))
      .toEqual(['parent', 'child'])
  })

  it('marks a row with a missing parent unresolved and still shows it as a provisional root', async () => {
    const db = await openPomodoroXIDB(crypto.randomUUID())
    databases.push(db)
    const projectId = 'project-1'
    await mergeWorkItem(
      db,
      snakeWorkItem('orphan', projectId, { parent_id: 'ghost-parent' }),
      'orphan',
      2,
    )

    const overview = await new TaskSpaceRepository(db, db.spaceId).readCachedOverview()

    expect(overview.workItems.find((item) => item.id === 'orphan')).toMatchObject({ depth: 1 })
    // fail-loud：无法自证层级必须可见（unresolved → 日志 + store 提示 + 重拉）。
    expect(overview.unresolvedDepthItemIds).toEqual(['orphan'])
    expect(selectProjectTree(overview.workItems, projectId).map((item) => item.id))
      .toEqual(['orphan'])
  })
})
