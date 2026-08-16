import { afterEach, describe, expect, it } from 'vitest'

import type { PomodoroXIDB } from '@/services/database'
import { openPomodoroXIDB } from '@/services/dexie-v18-cutover'
import { applySyncEventRecord, buildPrePushConflict } from './merge'
import { withSpaceAuthorityFence } from './space-authority-fence'

describe('Sync v2 merge', () => {
  let db: PomodoroXIDB | undefined
  afterEach(async () => { if (db) await db.delete(); db = undefined })

  it('applies a clean authoritative create with version metadata', async () => {
    db = await openPomodoroXIDB(`merge-${crypto.randomUUID()}`)
    const record = {
      operation_id: 'op-merge-0001', batch_id: 'batch-merge-0001',
      entity_type: 'project', entity_id: 'project-1', action: 'create' as const,
      payload: { id: 'project-1', spaceId: db.spaceId, key: 'P1', name: 'Project' },
      version: 2, created_at: '2026-07-14T10:00:00.000Z',
    }
    await withSpaceAuthorityFence(db.spaceId, (token) =>
      applySyncEventRecord(db!, db!.spaceId, token, record, []))
    await expect(db.projects.get('project-1')).resolves.toMatchObject({
      id: 'project-1', version: 2, updated_at: record.created_at, _dirty: false,
    })
  })

  it('preserves a dirty local row and emits a pre-push conflict', async () => {
    db = await openPomodoroXIDB(`merge-${crypto.randomUUID()}`)
    await db.projects.put({ id: 'project-1', name: 'local', _dirty: true })
    const conflicts: Parameters<typeof applySyncEventRecord>[4] = []
    const record = {
      operation_id: 'op-merge-0002', batch_id: 'batch-merge-0002',
      entity_type: 'project', entity_id: 'project-1', action: 'update' as const,
      payload: { id: 'project-1', name: 'remote' }, version: 3,
      created_at: '2026-07-14T10:00:00.000Z',
    }
    await withSpaceAuthorityFence(db.spaceId, (token) =>
      applySyncEventRecord(db!, db!.spaceId, token, record, conflicts))
    expect(conflicts).toHaveLength(1)
    expect(await db.projects.get('project-1')).toMatchObject({ name: 'local', _dirty: true })
  })

  it('builds the canonical pre-push conflict shape', () => {
    expect(buildPrePushConflict({ id: 'local' }, { id: 'remote' }, 'project')).toMatchObject({
      outboxId: -1, entityType: 'project', entityId: 'remote', conflictType: 'version',
    })
  })
})
