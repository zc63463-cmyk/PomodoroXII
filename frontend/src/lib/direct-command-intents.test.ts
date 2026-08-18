import { afterEach, describe, expect, it } from 'vitest'
import { openPomodoroXIDB } from '@/services/dexie-v18-cutover'
import type { DirectCommandIntentRow } from '@/types'
import {
  executeDurableDirectCommand,
  prepareDirectCommandIntent,
  resumePendingDirectCommandIntents,
} from './direct-command-intents'

const databases: Array<Awaited<ReturnType<typeof openPomodoroXIDB>>> = []

afterEach(async () => {
  while (databases.length > 0) await databases.pop()!.delete()
})

async function fixture() {
  const db = await openPomodoroXIDB(`direct-intent-${crypto.randomUUID()}`)
  databases.push(db)
  return db
}

const input = (spaceId: string) => ({
  kind: 'create_project' as const,
  spaceId,
  targetId: 'RM',
  request: { spaceId, name: 'Roadmap', key: 'RM', description: null },
  now: '2026-07-15T08:00:00.000Z',
})

describe('durable direct command intents', () => {
  it('reuses one exact request after a server commit and response loss', async () => {
    const db = await fixture()
    const intent = await prepareDirectCommandIntent(db, input(db.spaceId), 'op-fixed')
    const result = { id: 'project-1', version: 1 }
    const calls: Array<Record<string, unknown>> = []
    let first = true

    await expect(executeDurableDirectCommand({
      db,
      intent,
      businessTables: [db.projects],
      parseResult: (value) => value as { id: string; version: number },
      sendExactRequest: async (request) => {
        calls.push(request)
        if (first) {
          first = false
          throw new Error('transport_response_lost')
        }
        return result
      },
      applyResult: async (value) => { await db.projects.put(value) },
      now: () => '2026-07-15T08:00:01.000Z',
    })).rejects.toThrow('transport_response_lost')

    const held = await db.directCommandIntents.get('op-fixed')
    expect(held).toMatchObject({ state: 'in_flight', requestJson: intent.requestJson })
    await resumePendingDirectCommandIntents(db, {
      create_project: {
        executeExact: async (pending: DirectCommandIntentRow) => {
          await executeDurableDirectCommand({
            db,
            intent: pending,
            businessTables: [db.projects],
            parseResult: (value) => value as { id: string; version: number },
            sendExactRequest: async (request) => { calls.push(request); return result },
            applyResult: async (value) => { await db.projects.put(value) },
            now: () => '2026-07-15T08:00:02.000Z',
          })
        },
      },
      create_work_item: { executeExact: async () => undefined },
      update_work_item: { executeExact: async () => undefined },
      move_work_item: { executeExact: async () => undefined },
      transition_work_item: { executeExact: async () => undefined },
      submit_review: { executeExact: async () => undefined },
    })

    expect(calls).toHaveLength(2)
    expect(calls[1]).toEqual(calls[0])
    expect((await db.directCommandIntents.get('op-fixed'))?.state).toBe('terminal')
    expect(await db.projects.get('project-1')).toEqual(result)
  })

  it('rolls back the business cache and terminal transition together', async () => {
    const db = await fixture()
    const intent = await prepareDirectCommandIntent(db, input(db.spaceId), 'op-atomic')
    await expect(executeDurableDirectCommand({
      db,
      intent,
      businessTables: [db.projects],
      parseResult: (value) => value as { id: string },
      sendExactRequest: async () => ({ id: 'project-atomic' }),
      applyResult: async (value) => {
        await db.projects.put(value)
        throw new Error('injected_completion_failure')
      },
      now: () => '2026-07-15T08:00:01.000Z',
    })).rejects.toThrow('injected_completion_failure')
    expect(await db.projects.get('project-atomic')).toBeUndefined()
    expect(await db.directCommandIntents.get('op-atomic')).toMatchObject({
      state: 'in_flight', resultJson: null, resultHash: null,
    })
  })
})
