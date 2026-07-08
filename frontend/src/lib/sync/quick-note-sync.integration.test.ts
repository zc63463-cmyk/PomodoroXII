import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AxiosResponse, InternalAxiosRequestConfig } from 'axios'
import {
  createQuickNote,
  moveQuickNoteToTrash,
  purgeQuickNote,
  resetQuickNoteOutboxHook,
  updateQuickNote,
} from '@/lib/quick-notes/quick-note-repository'
import { db, spaceDBManager } from '@/services/space-db'
import { spaceApi } from '@/services/api'
import { applyMerge } from './merge'
import { pushBatch } from './push-batch'
import type { ApiSyncPullResponse, SyncConflict } from './types'

function ok(data: unknown, config: InternalAxiosRequestConfig): AxiosResponse {
  return { data, status: 200, statusText: 'OK', headers: {}, config }
}

function makePullResponse(
  overrides: Partial<ApiSyncPullResponse>,
): ApiSyncPullResponse {
  return {
    server_time: '2026-07-06T12:00:00.000Z',
    has_more: false,
    tombstones_has_more: false,
    next_since: '2026-07-06T12:00:00.000Z',
    next_since_id: '',
    next_tombstone_since_id: '',
    ...overrides,
  } as ApiSyncPullResponse
}

describe('quick-note sync integration smoke', () => {
  const originalAdapter = spaceApi.defaults.adapter

  beforeEach(async () => {
    resetQuickNoteOutboxHook()
    await spaceDBManager.switchTo(`quick-note-sync-${crypto.randomUUID()}`)
  })

  afterEach(async () => {
    spaceApi.defaults.adapter = originalAdapter
    resetQuickNoteOutboxHook()
    await db.delete()
    spaceDBManager.close()
  })

  it('flows from repository writes to outbox push events and clears applied outbox', async () => {
    const note = await createQuickNote({ content: 'capture #Draft' })
    await updateQuickNote(note.id, { content: 'polished #Done' })

    const pending = await db.outbox.where('entityId').equals(note.id).toArray()
    expect(pending).toHaveLength(1)
    expect(pending[0]).toMatchObject({
      entityType: 'quickNote',
      entityId: note.id,
      action: 'create',
      synced: false,
    })
    expect(JSON.parse(pending[0]!.payload)).toMatchObject({
      id: note.id,
      content: 'polished #Done',
      tags: ['done'],
    })

    const pushedEvents: unknown[] = []
    spaceApi.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
      const body =
        typeof config.data === 'string' ? JSON.parse(config.data) : config.data
      const events = (body as { events: Array<{
        entity_type: string
        entity_id: string
        action: string
        payload: unknown
      }> }).events
      pushedEvents.push(...events)

      return ok({
        applied: events.map((event) => ({
          entity_type: event.entity_type,
          entity_id: event.entity_id,
          action: event.action,
        })),
        conflicts: [],
        errors: [],
        server_time: '2026-07-06T12:00:00.000Z',
      }, config)
    }

    const result = await pushBatch(db, spaceApi, pending)

    expect(result.clearedOutboxIds).toEqual([pending[0]!.id])
    expect(pushedEvents).toHaveLength(1)
    expect(pushedEvents[0]).toMatchObject({
      entity_type: 'quickNote',
      entity_id: note.id,
      action: 'create',
      payload: {
        id: note.id,
        content: 'polished #Done',
        tags: ['done'],
      },
    })
    expect(await db.outbox.where('entityId').equals(note.id).count()).toBe(0)
  })

  it('flows from repository purge to quickNote delete push and pull tombstone merge', async () => {
    const note = await createQuickNote({ content: 'remote synced #Trash' })
    await moveQuickNoteToTrash(note.id)
    await db.outbox.clear()

    await purgeQuickNote(note.id)

    const deleteRows = await db.outbox.where('entityId').equals(note.id).toArray()
    expect(deleteRows).toHaveLength(1)
    expect(deleteRows[0]).toMatchObject({
      entityType: 'quickNote',
      entityId: note.id,
      action: 'delete',
      synced: false,
    })
    expect(JSON.parse(deleteRows[0]!.payload)).toEqual({ id: note.id })
    expect(await db.quickNotes.get(note.id)).toBeUndefined()

    const pushedEvents: Array<{ action: string; payload: unknown }> = []
    spaceApi.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
      const body =
        typeof config.data === 'string' ? JSON.parse(config.data) : config.data
      const events = (body as { events: Array<{
        entity_type: string
        entity_id: string
        action: string
        payload: unknown
      }> }).events
      pushedEvents.push(...events.map((event) => ({
        action: event.action,
        payload: event.payload,
      })))

      return ok({
        applied: events.map((event) => ({
          entity_type: event.entity_type,
          entity_id: event.entity_id,
          action: event.action,
        })),
        conflicts: [],
        errors: [],
        server_time: '2026-07-06T12:00:00.000Z',
      }, config)
    }

    await pushBatch(db, spaceApi, deleteRows)

    expect(pushedEvents).toEqual([{ action: 'delete', payload: { id: note.id } }])
    expect(await db.outbox.where('entityId').equals(note.id).count()).toBe(0)

    await db.quickNotes.put({
      id: note.id,
      content: 'same note on another local snapshot',
      mood: null,
      tags: ['trash'],
      pinned: false,
      archived_at: null,
      archive_file_path: null,
      session_id: null,
      folder_id: null,
      trashed_at: null,
      migrated_to_note_id: null,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      deletion_state: 'active',
      version: 1,
      _dirty: true,
    })

    const dirtyConflicts: SyncConflict[] = []
    await applyMerge(db, makePullResponse({
      tombstones: [{
        entity_type: 'quickNote',
        entity_id: note.id,
        deleted_at: '2026-07-06T00:00:00.000Z',
      }],
    }), dirtyConflicts)

    const tombstoned = await db.quickNotes.get(note.id)
    expect(tombstoned).toBeDefined()
    expect(tombstoned!.deletion_state).toBe('deleted')
    expect(tombstoned!._dirty).toBe(false)
    expect(tombstoned!.content).toBe('same note on another local snapshot')
    expect(dirtyConflicts).toHaveLength(0)
  })
})
