import { describe, it, expect, afterEach } from 'vitest'
import type { PomodoroXIDB } from '@/services/database'
import { openPomodoroXIDB } from '@/services/dexie-v18-cutover'
import { applyMerge, buildPrePushConflict } from './merge'
import type { ApiSyncPullResponse, SyncConflict } from './types'

/**
 * merge.ts 单测（MG1–MG10）。
 *
 * 验证 F1 §4.1 applyMerge 合并矩阵 + §4.1b pre-push dirty 冲突 + §4.2 tombstone。
 * 测试范式：随机 dbName + db.open() + afterEach db.delete()（对齐 outbox.test.ts）。
 */

async function openTestDb(): Promise<PomodoroXIDB> {
  return openPomodoroXIDB('merge-test-' + crypto.randomUUID())
}

/** 最小 note 行（含 SyncFields 必填字段） */
function makeNoteRow(
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
  } as unknown as Parameters<PomodoroXIDB['notes']['put']>[0]
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
    await applyMerge(db, makePullResponse('notes', remote), dirtyConflicts)

    const row = await db.notes.get('t1')
    expect(row).toBeDefined()
    expect(row!._dirty).toBe(false)
    expect(dirtyConflicts).toHaveLength(0)
  })

  it('MG2: 远端更新 + 本地 _dirty=false → 覆盖', async () => {
    db = await openTestDb()
    await db.notes.put(makeNoteRow('t1', '2026-01-01T00:00:00.000Z'))
    const dirtyConflicts: SyncConflict[] = []
    const remote = [{ id: 't1', title: 'remote-newer', updated_at: '2026-07-06T00:00:00.000Z' }]
    await applyMerge(db, makePullResponse('notes', remote), dirtyConflicts)

    const row = await db.notes.get('t1')
    expect(row!.title).toBe('remote-newer')
    expect(row!._dirty).toBe(false)
    expect(dirtyConflicts).toHaveLength(0)
  })

  it('MG3: 远端更旧 + 本地 _dirty=false → 跳过', async () => {
    db = await openTestDb()
    await db.notes.put(makeNoteRow('t1', '2026-07-06T00:00:00.000Z'))
    const dirtyConflicts: SyncConflict[] = []
    const remote = [{ id: 't1', title: 'remote-older', updated_at: '2026-01-01T00:00:00.000Z' }]
    await applyMerge(db, makePullResponse('notes', remote), dirtyConflicts)

    const row = await db.notes.get('t1')
    expect(row!.title).toBe('T') // 保留本地
    expect(dirtyConflicts).toHaveLength(0)
  })

  it('MG4: 本地 dirty + 远端更新 → dirtyConflicts + 不覆盖', async () => {
    db = await openTestDb()
    await db.notes.put(makeNoteRow('t1', '2026-01-01T00:00:00.000Z', true))
    const dirtyConflicts: SyncConflict[] = []
    const remote = [{ id: 't1', title: 'remote-newer', updated_at: '2026-07-06T00:00:00.000Z' }]
    await applyMerge(db, makePullResponse('notes', remote), dirtyConflicts)

    expect(dirtyConflicts).toHaveLength(1)
    expect(dirtyConflicts[0]!.outboxId).toBe(-1)
    expect(dirtyConflicts[0]!.entityType).toBe('note')
    expect(dirtyConflicts[0]!.entityId).toBe('t1')
    const local = await db.notes.get('t1')
    expect(local!.title).toBe('T') // 保留本地
    expect(local!._dirty).toBe(true)
  })

  it('MG5: 本地 dirty + 远端更旧 → 保留 + 无冲突', async () => {
    db = await openTestDb()
    await db.notes.put(makeNoteRow('t1', '2026-07-06T00:00:00.000Z', true))
    const dirtyConflicts: SyncConflict[] = []
    const remote = [{ id: 't1', title: 'remote-older', updated_at: '2026-01-01T00:00:00.000Z' }]
    await applyMerge(db, makePullResponse('notes', remote), dirtyConflicts)

    expect(dirtyConflicts).toHaveLength(0)
    const local = await db.notes.get('t1')
    expect(local!.title).toBe('T')
    expect(local!._dirty).toBe(true)
  })

  it('MG6: tombstone → deletion_state=deleted（行仍在）', async () => {
    db = await openTestDb()
    await db.notes.put(makeNoteRow('t1', '2026-01-01T00:00:00.000Z'))
    const dirtyConflicts: SyncConflict[] = []
    const response = makePullResponse('notes', [], {
      tombstones: [{ entity_type: 'note', entity_id: 't1', deleted_at: '2026-07-06T00:00:00.000Z' }],
    })
    await applyMerge(db, response, dirtyConflicts)

    const row = await db.notes.get('t1')
    expect(row).toBeDefined() // 行仍在
    expect(row!.deletion_state).toBe('deleted')
    expect(row!._dirty).toBe(false)
  })

  it('MG6-QN: dirty quickNote tombstone 生成冲突且保留本地实体', async () => {
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
    expect(row!.deletion_state).toBe('active')
    expect(row!._dirty).toBe(true)
    expect(row!.content).toBe('local quick note')
    expect(dirtyConflicts).toHaveLength(1)
    expect(dirtyConflicts[0]!.entityType).toBe('quickNote')
    expect(dirtyConflicts[0]!.entityId).toBe('qn1')
    expect(dirtyConflicts[0]!.remoteVersion).toMatchObject({
      deletion_state: 'deleted',
      updated_at: '2026-07-06T00:00:00.000Z',
    })
  })

  it('MG6-OUTBOX: clean 实体有 unsynced outbox 时 tombstone 生成冲突并保留', async () => {
    db = await openTestDb()
    await db.notes.put(makeNoteRow('t-outbox', '2026-01-01T00:00:00.000Z'))
    await db.outbox.add({
      spaceId: db.spaceId,
      entityType: 'note',
      entityId: 't-outbox',
      action: 'update',
      payload: '{}',
      createdAt: '2026-07-06T00:00:00.000Z',
      synced: false,
      payloadHash: '0'.repeat(64),
      compoundOperationId: null,
      compoundOrder: null,
      operationId: 'op-merge-outbox',
      expectedVersion: 1,
      requiresVersionRebase: false,
      transportState: 'ready',
      lastError: null,
      lastErrorCode: null,
      failedAt: null,
      attemptCount: 0,
    })
    const dirtyConflicts: SyncConflict[] = []

    await applyMerge(db, makePullResponse('notes', [], {
      tombstones: [{
        entity_type: 'note',
        entity_id: 't-outbox',
        deleted_at: '2026-07-06T00:00:00.000Z',
      }],
    }), dirtyConflicts)

    expect((await db.notes.get('t-outbox'))!.deletion_state).toBe('active')
    expect(dirtyConflicts).toHaveLength(1)
  })

  it('MG7: buildPrePushConflict 纯函数形状', () => {
    const localRow = { id: 't1', title: 'local' }
    const remoteRow = { id: 't1', title: 'remote' }
    const conflict = buildPrePushConflict(localRow, remoteRow, 'note')

    expect(conflict.outboxId).toBe(-1)
    expect(conflict.entityType).toBe('note')
    expect(conflict.entityId).toBe('t1')
    expect(conflict.conflictType).toBe('version')
    expect(conflict.localVersion).toBe(localRow)
    expect(conflict.remoteVersion).toBe(remoteRow)
  })

  it('MG8: tombstone 指向不存在实体 → 不抛错', async () => {
    db = await openTestDb()
    const dirtyConflicts: SyncConflict[] = []
    const response = makePullResponse('notes', [], {
      tombstones: [{ entity_type: 'note', entity_id: 'nonexistent', deleted_at: '2026-07-06T00:00:00.000Z' }],
    })
    // 不应抛错
    await applyMerge(db, response, dirtyConflicts)
    expect(dirtyConflicts).toHaveLength(0)
  })

  it('MG9: 同实体组多行同页 merge', async () => {
    db = await openTestDb()
    const dirtyConflicts: SyncConflict[] = []
    const response = makePullResponse('notes', [
      { id: 't1', title: 'T', updated_at: '2026-07-06T00:00:00.000Z' },
      { id: 'n1', title: 'N', updated_at: '2026-07-06T00:00:00.000Z' },
    ])
    await applyMerge(db, response, dirtyConflicts)

    const firstNote = await db.notes.get('t1')
    const secondNote = await db.notes.get('n1')
    expect(firstNote).toBeDefined()
    expect(firstNote!._dirty).toBe(false)
    expect(secondNote).toBeDefined()
    expect(secondNote!._dirty).toBe(false)
  })

  it('MG10: 远端行无 updated_at → normalizeTs 空串不抛错', async () => {
    db = await openTestDb()
    const dirtyConflicts: SyncConflict[] = []
    // 远端行无 updated_at 字段
    const remote = [{ id: 't1', title: 'no-ts' }]
    await applyMerge(db, makePullResponse('notes', remote), dirtyConflicts)

    // 本地无行时新增（normalizeTs(undefined)='' ，本地也无行 → put）
    const row = await db.notes.get('t1')
    expect(row).toBeDefined()
    expect(row!._dirty).toBe(false)
  })
})
