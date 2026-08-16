import { describe, expect, it } from 'vitest'

import { hashCommandPayload } from '@/lib/contracts/payload-hash'
import type { JsonValue } from '@/lib/contracts/payload-hash'
import {
  parsePersistedOutboxPayload,
  recomputeEntityBusinessPayloadHash,
} from './entity-payload-hash'

const timestamp = '2026-08-07T01:00:00.000Z'

describe('final entity business payload hashing', () => {
  it('hashes a WorkItemNote document rather than its complete post-image', async () => {
    const document = { contentVersion: 1 as const, blocks: [] }
    const postImage = {
      noteId: 'note-a', workItemId: 'work-a', document,
      version: 4, createdAt: timestamp, updatedAt: timestamp,
    }

    await expect(recomputeEntityBusinessPayloadHash('workItemNote', 'update', postImage))
      .resolves.toBe(await hashCommandPayload({ document }))
    await expect(recomputeEntityBusinessPayloadHash('workItemNote', 'update', postImage))
      .resolves.not.toBe(await hashCommandPayload(postImage))
  })

  it('strictly hashes the retained schedule post-image and rejects missing fields', async () => {
    const postImage = {
      id: 'schedule-a', title: 'Focus', due_at: timestamp, completed_at: null,
      priority: 'medium', color: '#123456', all_day: false,
      start_time: null, end_time: null, created_at: timestamp, updated_at: timestamp,
    }
    await expect(recomputeEntityBusinessPayloadHash('schedule', 'create', postImage))
      .resolves.toBe(await hashCommandPayload(postImage))
    await expect(recomputeEntityBusinessPayloadHash(
      'schedule', 'create',
      { ...postImage, due_at: undefined } as unknown as JsonValue,
    )).rejects.toThrow()
  })

  it('rejects derived FocusSession fields before hashing', async () => {
    const postImage = {
      id: 'session-a', version: 1, createdAt: timestamp, updatedAt: timestamp,
      sessionRevision: 1, startedAt: timestamp, endedAt: null, pauseStartedAt: null,
      plannedSeconds: 1500, grossSeconds: 0, pausedSeconds: 0, breakSeconds: 0,
      focusedSeconds: 0, timerCompletion: null, validity: 'pending', validityReason: null,
      overallProgress: null, mood: null, reviewState: 'pending',
      ownershipState: 'authoritative', sessionNote: '',
    }
    await expect(recomputeEntityBusinessPayloadHash(
      'focusSession', 'create', { ...postImage, clockState: 'running' },
    )).rejects.toThrow()
    await expect(recomputeEntityBusinessPayloadHash('focusSession', 'create', postImage))
      .resolves.toMatch(/^[0-9a-f]{64}$/)
  })

  it('rejects duplicate persisted JSON names before dispatch', () => {
    expect(() => parsePersistedOutboxPayload('{"id":"a","id":"b"}'))
      .toThrow('duplicate JSON object key')
  })
})
