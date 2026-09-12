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

function responseError(code: string, retryable: boolean): Error {
  return Object.assign(new Error(`Request failed with status code 409`), {
    response: { data: { detail: { code, retryable } } },
  })
}

function noopHandlers(executeProject: (intent: DirectCommandIntentRow) => Promise<void>) {
  return {
    create_project: { executeExact: executeProject },
    create_work_item: { executeExact: async () => undefined },
    update_work_item: { executeExact: async () => undefined },
    move_work_item: { executeExact: async () => undefined },
    transition_work_item: { executeExact: async () => undefined },
    trash_work_item: { executeExact: async () => undefined },
    restore_work_item: { executeExact: async () => undefined },
    create_relation: { executeExact: async () => undefined },
    remove_relation: { executeExact: async () => undefined },
    resolve_relation: { executeExact: async () => undefined },
    add_work_item_labels: { executeExact: async () => undefined },
    remove_work_item_labels: { executeExact: async () => undefined },
    create_label: { executeExact: async () => undefined },
    update_label: { executeExact: async () => undefined },
    archive_label: { executeExact: async () => undefined },
    submit_review: { executeExact: async () => undefined },
  }
}

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
    trash_work_item: { executeExact: async () => undefined },
    restore_work_item: { executeExact: async () => undefined },
    create_relation: { executeExact: async () => undefined },
    remove_relation: { executeExact: async () => undefined },
    resolve_relation: { executeExact: async () => undefined },
      add_work_item_labels: { executeExact: async () => undefined },
      remove_work_item_labels: { executeExact: async () => undefined },
      create_label: { executeExact: async () => undefined },
      update_label: { executeExact: async () => undefined },
      archive_label: { executeExact: async () => undefined },
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

  it('marks a non-retryable rejection failed and continues later intents', async () => {
    const db = await fixture()
    await prepareDirectCommandIntent(db, input(db.spaceId), 'op-rejected')
    await prepareDirectCommandIntent(db, {
      ...input(db.spaceId), targetId: 'NEXT', request: { spaceId: db.spaceId, name: 'Next', key: 'NEXT', description: null },
      now: '2026-07-15T08:00:01.000Z',
    }, 'op-next')
    const calls: string[] = []

    const result = await resumePendingDirectCommandIntents(db, noopHandlers(async (intent) => {
      calls.push(intent.operationId)
      if (intent.operationId === 'op-rejected') throw responseError('project_key_conflict', false)
    }))

    expect(calls).toEqual(['op-rejected', 'op-next'])
    expect(result.failed).toEqual([{ operationId: 'op-rejected', code: 'project_key_conflict' }])
    expect(await db.directCommandIntents.get('op-rejected')).toMatchObject({
      state: 'failed', failureCode: 'project_key_conflict', resultJson: null, resultHash: null,
    })

    const nextResume = await resumePendingDirectCommandIntents(db, noopHandlers(async (intent) => {
      calls.push(intent.operationId)
    }))
    expect(nextResume.failed).toEqual([])
    expect(calls.filter((operationId) => operationId === 'op-rejected')).toHaveLength(1)
  })

  it('keeps retryable failures pending and stops the ordered replay queue', async () => {
    const db = await fixture()
    await prepareDirectCommandIntent(db, input(db.spaceId), 'op-retry')
    await prepareDirectCommandIntent(db, {
      ...input(db.spaceId), targetId: 'NEXT', request: { spaceId: db.spaceId, name: 'Next', key: 'NEXT', description: null },
      now: '2026-07-15T08:00:01.000Z',
    }, 'op-next')
    const calls: string[] = []

    await expect(resumePendingDirectCommandIntents(db, noopHandlers(async (intent) => {
      calls.push(intent.operationId)
      if (intent.operationId === 'op-retry') throw responseError('space_recovery_required', true)
    }))).rejects.toThrow('Request failed')

    expect(calls).toEqual(['op-retry'])
    expect(await db.directCommandIntents.get('op-retry')).toMatchObject({ state: 'prepared' })
  })

  // ★ 2026-09-11 队列加固：程序性错误不再冻结整批（旧代码在第一条上抛出并终止）。
  it('marks an unbound handler failed and continues later intents', async () => {
    const db = await fixture()
    await prepareDirectCommandIntent(db, input(db.spaceId), 'op-unbound')
    await prepareDirectCommandIntent(db, {
      kind: 'update_work_item', spaceId: db.spaceId, targetId: 'work-1',
      request: { patch: { title: 'Next' }, spaceId: db.spaceId },
      now: '2026-07-15T08:00:01.000Z',
    }, 'op-next')
    const calls: string[] = []
    // 只绑定 update_work_item：create_project 的 handler 故意缺失（旧代码在此抛出）。
    const handlers = {
      update_work_item: {
        executeExact: async (intent: DirectCommandIntentRow) => { calls.push(intent.operationId) },
      },
    } as unknown as Parameters<typeof resumePendingDirectCommandIntents>[1]

    const result = await resumePendingDirectCommandIntents(db, handlers)

    // 缺 handler 的 intent 被记录失败，后续 intent 仍被真正处理。
    expect(calls).toEqual(['op-next'])
    expect(result.failed).toEqual([
      { operationId: 'op-unbound', code: 'handler_error:create_project' },
    ])
    expect(await db.directCommandIntents.get('op-unbound')).toMatchObject({
      state: 'failed', failureCode: 'handler_error:create_project',
    })
  })

  it('marks a programmatic handler error failed and continues later intents', async () => {
    const db = await fixture()
    await prepareDirectCommandIntent(db, input(db.spaceId), 'op-programmatic')
    await prepareDirectCommandIntent(db, {
      ...input(db.spaceId), targetId: 'NEXT', request: { spaceId: db.spaceId, name: 'Next', key: 'NEXT', description: null },
      now: '2026-07-15T08:00:01.000Z',
    }, 'op-next')
    const calls: string[] = []

    const result = await resumePendingDirectCommandIntents(db, noopHandlers(async (intent) => {
      calls.push(intent.operationId)
      if (intent.operationId === 'op-programmatic') throw new Error('handler_internal_boom')
    }))

    expect(calls).toEqual(['op-programmatic', 'op-next'])
    expect(result.failed).toEqual([
      { operationId: 'op-programmatic', code: 'handler_error:create_project' },
    ])
    expect(await db.directCommandIntents.get('op-programmatic')).toMatchObject({
      state: 'failed', failureCode: 'handler_error:create_project',
    })
  })

  it('keeps a no-response transport failure pending and stops the queue', async () => {
    const db = await fixture()
    await prepareDirectCommandIntent(db, input(db.spaceId), 'op-network')
    await prepareDirectCommandIntent(db, {
      ...input(db.spaceId), targetId: 'NEXT', request: { spaceId: db.spaceId, name: 'Next', key: 'NEXT', description: null },
      now: '2026-07-15T08:00:01.000Z',
    }, 'op-next')
    const calls: string[] = []
    const networkError = Object.assign(new Error('Network Error'), {
      isAxiosError: true, code: 'ERR_NETWORK', response: undefined,
    })

    await expect(resumePendingDirectCommandIntents(db, noopHandlers(async (intent) => {
      calls.push(intent.operationId)
      if (intent.operationId === 'op-network') throw networkError
    }))).rejects.toThrow('Network Error')

    expect(calls).toEqual(['op-network'])
    expect(await db.directCommandIntents.get('op-network')).toMatchObject({
      state: 'prepared', failureCode: null,
    })
  })

  it('keeps a non-normalized response failure pending and stops the queue', async () => {
    const db = await fixture()
    await prepareDirectCommandIntent(db, input(db.spaceId), 'op-unknown-response')
    await prepareDirectCommandIntent(db, {
      ...input(db.spaceId), targetId: 'NEXT', request: { spaceId: db.spaceId, name: 'Next', key: 'NEXT', description: null },
      now: '2026-07-15T08:00:01.000Z',
    }, 'op-next')
    const calls: string[] = []
    // 有应答但没有规范化 code（例如老式 500 文本体）：必须继续重试，绝不判死。
    const unnormalized = Object.assign(new Error('Request failed with status code 500'), {
      response: { status: 500, data: { detail: 'Internal server error' } },
    })

    await expect(resumePendingDirectCommandIntents(db, noopHandlers(async (intent) => {
      calls.push(intent.operationId)
      if (intent.operationId === 'op-unknown-response') throw unnormalized
    }))).rejects.toThrow('Request failed')

    expect(calls).toEqual(['op-unknown-response'])
    expect(await db.directCommandIntents.get('op-unknown-response')).toMatchObject({
      state: 'prepared', failureCode: null,
    })
  })
})
