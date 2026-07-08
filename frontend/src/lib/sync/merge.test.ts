import { describe, it, expect, afterEach } from 'vitest'
import { PomodoroXIDB } from '@/services/database'
import { applyMerge, buildPrePushConflict } from './merge'
import type { ApiSyncPullResponse, SyncConflict } from './types'

/**
 * merge.ts 单测（MG1–MG10）。
 *
 * 验证 F1 §4.1 applyMerge 合并矩阵 + §4.1b pre-push dirty 冲突 + §4.2 tombstone。
 * 测试范式：随机 dbName + db.open() + afterEach db.delete()（对齐 outbox.test.ts）。
 */

async function openTestDb(): Promise<PomodoroXIDB> {
  const db = new PomodoroXIDB('merge-test-' + crypto.randomUUID())
  await db.open()
  return db
}

/** 最小 task 行（含 SyncFields 必填字段） */
function makeTaskRow(
  id: string,
  updatedAt: string,
  dirty = false,
  deletion = 'active' as const,
) {
  return {
    id,
    title: 'T',
    status: 'todo',
    updated_at: updatedAt,
    _dirty: dirty,
    deletion_state: deletion,
    version: 1,
  } as unknown as Parameters<PomodoroXIDB['tasks']['put']>[0]
}

function makeQuickNoteRow(
  id: string,
  updatedAt: string,
  dirty = false,
  deletion = 'active' as const,
) {
  return {
    id,
    content: 'local quick note',
    mood: null,
    tags: [],
    pinned: false,
    archived_at: null,
    archive_file_path: null,
    session_id: null,
    folder_id: null,
    trashed_at: null,
    migrated_to_note_id: null,
    created_at: updatedAt,
    updated_at: updatedAt,
    _dirty: dirty,
    deletion_state: deletion,
    version: 1,
  } as unknown as Parameters<PomodoroXIDB['quickNotes']['put']>[0]
}

/** 构造单实体组 pull 响应 */
function makePullResponse(
  group: string,
  rows: Record<string, unknown>[],
  overrides: Record<string, unknown> = {},
): ApiSyncPullResponse {
  return {
    server_time: '2026-07-06T12:00:00.000Z',
    has_more: false,
    tombstones_has_more: false,
    next_since: '2026-07-06T12:00:00.000Z',
    next_since_id: '',
    next_tombstone_since_id: '',
    [group]: rows,
    ...overrides,
  } as ApiSyncPullResponse
}

describe('merge', () => {
  let db: PomodoroXIDB

  afterEach(async () => {
    if (db) await db.delete()
  })

  it('MG1: 本地无行 → 新增 + _dirty=false', async () => {
    db = await openTestDb()
    const dirtyConflicts: SyncConflict[] = []
    const remote = [{ id: 't1', title: 'remote', updated_at: '2026-07-06T00:00:00.000Z' }]
    await applyMerge(db, makePullResponse('tasks', remote), dirtyConflicts)

    const row = await db.tasks.get('t1')
    expect(row).toBeDefined()
    expect(row!._dirty).toBe(false)
    expect(dirtyConflicts).toHaveLength(0)
  })

  it('MG2: 远端更新 + 本地 _dirty=false → 覆盖', async () => {
    db = await openTestDb()
    await db.tasks.put(makeTaskRow('t1', '2026-01-01T00:00:00.000Z'))
    const dirtyConflicts: SyncConflict[] = []
    const remote = [{ id: 't1', title: 'remote-newer', updated_at: '2026-07-06T00:00:00.000Z' }]
    await applyMerge(db, makePullResponse('tasks', remote), dirtyConflicts)

    const row = await db.tasks.get('t1')
    expect(row!.title).toBe('remote-newer')
    expect(row!._dirty).toBe(false)
    expect(dirtyConflicts).toHaveLength(0)
  })

  it('MG3: 远端更旧 + 本地 _dirty=false → 跳过', async () => {
    db = await openTestDb()
    await db.tasks.put(makeTaskRow('t1', '2026-07-06T00:00:00.000Z'))
    const dirtyConflicts: SyncConflict[] = []
    const remote = [{ id: 't1', title: 'remote-older', updated_at: '2026-01-01T00:00:00.000Z' }]
    await applyMerge(db, makePullResponse('tasks', remote), dirtyConflicts)

    const row = await db.tasks.get('t1')
    expect(row!.title).toBe('T') // 保留本地
    expect(dirtyConflicts).toHaveLength(0)
  })

  it('MG4: 本地 dirty + 远端更新 → dirtyConflicts + 不覆盖', async () => {
    db = await openTestDb()
    await db.tasks.put(makeTaskRow('t1', '2026-01-01T00:00:00.000Z', true))
    const dirtyConflicts: SyncConflict[] = []
    const remote = [{ id: 't1', title: 'remote-newer', updated_at: '2026-07-06T00:00:00.000Z' }]
    await applyMerge(db, makePullResponse('tasks', remote), dirtyConflicts)

    expect(dirtyConflicts).toHaveLength(1)
    expect(dirtyConflicts[0]!.outboxId).toBe(-1)
    expect(dirtyConflicts[0]!.entityType).toBe('task')
    expect(dirtyConflicts[0]!.entityId).toBe('t1')
    const local = await db.tasks.get('t1')
    expect(local!.title).toBe('T') // 保留本地
    expect(local!._dirty).toBe(true)
  })

  it('MG5: 本地 dirty + 远端更旧 → 保留 + 无冲突', async () => {
    db = await openTestDb()
    await db.tasks.put(makeTaskRow('t1', '2026-07-06T00:00:00.000Z', true))
    const dirtyConflicts: SyncConflict[] = []
    const remote = [{ id: 't1', title: 'remote-older', updated_at: '2026-01-01T00:00:00.000Z' }]
    await applyMerge(db, makePullResponse('tasks', remote), dirtyConflicts)

    expect(dirtyConflicts).toHaveLength(0)
    const local = await db.tasks.get('t1')
    expect(local!.title).toBe('T')
    expect(local!._dirty).toBe(true)
  })

  it('MG6: tombstone → deletion_state=deleted（行仍在）', async () => {
    db = await openTestDb()
    await db.tasks.put(makeTaskRow('t1', '2026-01-01T00:00:00.000Z'))
    const dirtyConflicts: SyncConflict[] = []
    const response = makePullResponse('tasks', [], {
      tombstones: [{ entity_type: 'task', entity_id: 't1', deleted_at: '2026-07-06T00:00:00.000Z' }],
    })
    await applyMerge(db, response, dirtyConflicts)

    const row = await db.tasks.get('t1')
    expect(row).toBeDefined() // 行仍在
    expect(row!.deletion_state).toBe('deleted')
    expect(row!._dirty).toBe(false)
  })

  it('MG6-QN: quickNote tombstone marks local row deleted without physical deletion', async () => {
    db = await openTestDb()
    await db.quickNotes.put(makeQuickNoteRow('qn1', '2026-01-01T00:00:00.000Z', true))
    const dirtyConflicts: SyncConflict[] = []
    const response = makePullResponse('quickNotes', [], {
      tombstones: [{
        entity_type: 'quickNote',
        entity_id: 'qn1',
        deleted_at: '2026-07-06T00:00:00.000Z',
      }],
    })

    await applyMerge(db, response, dirtyConflicts)

    const row = await db.quickNotes.get('qn1')
    expect(row).toBeDefined()
    expect(row!.deletion_state).toBe('deleted')
    expect(row!._dirty).toBe(false)
    expect(row!.content).toBe('local quick note')
    expect(dirtyConflicts).toHaveLength(0)
  })

  it('MG7: buildPrePushConflict 纯函数形状', () => {
    const localRow = { id: 't1', title: 'local' }
    const remoteRow = { id: 't1', title: 'remote' }
    const conflict = buildPrePushConflict(localRow, remoteRow, 'task')

    expect(conflict.outboxId).toBe(-1)
    expect(conflict.entityType).toBe('task')
    expect(conflict.entityId).toBe('t1')
    expect(conflict.conflictType).toBe('version')
    expect(conflict.localVersion).toBe(localRow)
    expect(conflict.remoteVersion).toBe(remoteRow)
  })

  it('MG8: tombstone 指向不存在实体 → 不抛错', async () => {
    db = await openTestDb()
    const dirtyConflicts: SyncConflict[] = []
    const response = makePullResponse('tasks', [], {
      tombstones: [{ entity_type: 'task', entity_id: 'nonexistent', deleted_at: '2026-07-06T00:00:00.000Z' }],
    })
    // 不应抛错
    await applyMerge(db, response, dirtyConflicts)
    expect(dirtyConflicts).toHaveLength(0)
  })

  it('MG9: 多实体组同页 merge（tasks + notes）', async () => {
    db = await openTestDb()
    const dirtyConflicts: SyncConflict[] = []
    const response = makePullResponse('tasks', [{ id: 't1', title: 'T', updated_at: '2026-07-06T00:00:00.000Z' }], {
      notes: [{ id: 'n1', title: 'N', updated_at: '2026-07-06T00:00:00.000Z' }],
    })
    await applyMerge(db, response, dirtyConflicts)

    const task = await db.tasks.get('t1')
    const note = await db.notes.get('n1')
    expect(task).toBeDefined()
    expect(task!._dirty).toBe(false)
    expect(note).toBeDefined()
    expect(note!._dirty).toBe(false)
  })

  it('MG10: 远端行无 updated_at → normalizeTs 空串不抛错', async () => {
    db = await openTestDb()
    const dirtyConflicts: SyncConflict[] = []
    // 远端行无 updated_at 字段
    const remote = [{ id: 't1', title: 'no-ts' }]
    await applyMerge(db, makePullResponse('tasks', remote), dirtyConflicts)

    // 本地无行时新增（normalizeTs(undefined)='' ，本地也无行 → put）
    const row = await db.tasks.get('t1')
    expect(row).toBeDefined()
    expect(row!._dirty).toBe(false)
  })
})
