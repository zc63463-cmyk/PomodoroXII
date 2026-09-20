/**
 * TS-02a / 裁决一：标签契约一致性（前端侧）。
 *
 * 契约：``addWorkItemLabels`` / ``removeWorkItemLabel`` 声明的 labelIds 是
 * **本次操作完成后的完整目标集合**，不是待增/待删的差量。服务端按权威集合
 * 判定操作方向（add 只能维持/增加、remove 只能维持/减少），越方向以
 * ``label_set_direction_violated`` 拒绝。前端只负责算出「按本地缓存看起来
 * 正确的目标集合」；权威判定永远在服务端加锁事务内。
 *
 * 这里钉住三件此前会出错的事：
 * 1. ``{A,B}`` 移除 A → 声明 ``[B]``（旧实现送 ``[A]`` 后服务端会算成 {A}）；
 * 2. ``{A}`` 移除 A → 声明 ``[]`` 且 **URL 仍寻址 A**（旧实现送空 URL 段）；
 * 3. remove 的 labelId 参与命令身份，因此改 URL 后的重试不是同一命令。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openPomodoroXIDB } from '@/services/dexie-v18-cutover'
import { taskSpaceApi } from '@/services/task-space-api'
import type { CachedWorkItem } from '@/types'
import { TaskSpaceRepository } from './task-space-repository'

const databases: Array<Awaited<ReturnType<typeof openPomodoroXIDB>>> = []
afterEach(async () => {
  while (databases.length > 0) await databases.pop()!.delete()
})

/** Minimal cached work-item row: only the fields the label paths touch. */
function cachedWorkItem(id: string, labelIds: string[], version: number): CachedWorkItem {
  return {
    id,
    projectId: 'project-1',
    displayKey: 'LBL-1',
    title: 'Item',
    description: null,
    typeDefinitionId: 'type-task',
    statusDefinitionId: 'status-not-started',
    priority: null,
    parentId: null,
    childRank: 0,
    completionWindowStart: null,
    completionWindowEnd: null,
    reviewPoint: null,
    hardDeadline: null,
    effortEstimateLowerSeconds: null,
    effortEstimateUpperSeconds: null,
    effortActualSeconds: 0,
    confidence: null,
    completedAt: null,
    cancelledAt: null,
    archivedAt: null,
    markedAsAttention: false,
    labelIds,
    version,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  } as unknown as CachedWorkItem
}

/** Accepted command response carrying the authoritative post-image. */
function accepted(labelIds: string[], version: number) {
  return {
    commandId: 'op',
    entityType: 'work_item',
    entityId: 'work-1',
    version,
    value: {
      id: 'work-1', space_id: 'spc', project_id: 'project-1', display_key: 'LBL-1',
      title: 'Item', description: null, type_definition_id: 'type-task',
      status_definition_id: 'status-not-started', priority: null, parent_id: null,
      child_rank: 0, completion_window_start: null, completion_window_end: null,
      review_point: null, hard_deadline: null,
      effort_estimate_lower_seconds: null, effort_estimate_upper_seconds: null,
      effort_actual_seconds: 0, confidence: null, completed_at: null,
      cancelled_at: null, archived_at: null, marked_as_attention: false,
      label_ids: labelIds, version,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:01.000Z',
    },
  }
}

async function fixture(labelIds: string[], version: number) {
  const db = await openPomodoroXIDB(crypto.randomUUID())
  databases.push(db)
  await db.workItems.put(cachedWorkItem('work-1', labelIds, version))
  const api = {
    ...taskSpaceApi,
    addWorkItemLabels: vi.fn(),
    removeWorkItemLabels: vi.fn(),
  }
  return { db, api, spaceId: db.spaceId }
}

describe('TaskSpaceRepository label-set contract (TS-02a)', () => {
  it('declares the post-removal target set, not the removed label', async () => {
    const { db, api, spaceId } = await fixture(['label-a', 'label-b'], 4)
    api.removeWorkItemLabels.mockResolvedValue(accepted(['label-b'], 5))
    const repository = new TaskSpaceRepository(db, spaceId, api)

    const updated = await repository.removeWorkItemLabel({
      workItemId: 'work-1', labelId: 'label-a',
    })

    expect(api.removeWorkItemLabels).toHaveBeenCalledWith(expect.objectContaining({
      workItemId: 'work-1',
      expectedVersion: 4,
      // FULL target set after the mutation ({A,B} minus A => {B}).
      labelIds: ['label-b'],
      // The URL segment addresses the ONE label that must disappear.
      labelId: 'label-a',
    }))
    expect(updated).toMatchObject({ id: 'work-1', labelIds: ['label-b'], version: 5 })
    expect(await db.workItems.get('work-1')).toMatchObject({
      labelIds: ['label-b'], version: 5,
    })
  })

  it('declares the empty target set when the last label is removed', async () => {
    const { db, api, spaceId } = await fixture(['label-a'], 2)
    api.removeWorkItemLabels.mockResolvedValue(accepted([], 3))
    const repository = new TaskSpaceRepository(db, spaceId, api)

    const updated = await repository.removeWorkItemLabel({
      workItemId: 'work-1', labelId: 'label-a',
    })

    // The empty declaration is the operation's meaning: drop everything. It is
    // only unambiguous because the addressed label travels separately.
    expect(api.removeWorkItemLabels).toHaveBeenCalledWith(expect.objectContaining({
      labelIds: [], labelId: 'label-a',
    }))
    expect(updated).toMatchObject({ id: 'work-1', labelIds: [], version: 3 })
    expect(await db.workItems.get('work-1')).toMatchObject({ labelIds: [], version: 3 })
  })

  it('binds the addressed label into the durable intent identity', async () => {
    const { db, api, spaceId } = await fixture(['label-a', 'label-b'], 4)
    api.removeWorkItemLabels.mockResolvedValue(accepted(['label-b'], 5))
    const repository = new TaskSpaceRepository(db, spaceId, api)

    await repository.removeWorkItemLabel({ workItemId: 'work-1', labelId: 'label-a' })

    const intent = await db.directCommandIntents.toArray()
    expect(intent).toHaveLength(1)
    // The intent stores the exact request that will be replayed on resume: a
    // later replay re-sends the SAME addressed label, never a recomputed one.
    const request = JSON.parse(String(intent[0].requestJson)) as Record<string, unknown>
    expect(request).toMatchObject({
      workItemId: 'work-1', labelId: 'label-a', labelIds: ['label-b'],
    })
    expect(intent[0]).toMatchObject({ kind: 'remove_work_item_labels', state: 'terminal' })
  })

  it('replays a pending remove intent with its original addressed label', async () => {
    const { db, api, spaceId } = await fixture(['label-a', 'label-b'], 4)
    // Simulate a crash after the intent was written but before it was sent.
    const { prepareDirectCommandIntent } = await import('@/lib/direct-command-intents')
    await prepareDirectCommandIntent(db, {
      kind: 'remove_work_item_labels', spaceId, targetId: 'work-1',
      request: {
        workItemId: 'work-1', labelId: 'label-a', expectedVersion: 4,
        labelIds: ['label-b'], spaceId,
      },
      now: '2026-01-01T00:00:00.000Z',
    })
    api.removeWorkItemLabels.mockResolvedValue(accepted(['label-b'], 5))
    const repository = new TaskSpaceRepository(db, spaceId, api)

    const resumed = await repository.resumePendingDirectCommandIntents()

    expect(resumed.failed).toEqual([])
    // Resume replays the stored request verbatim: no recomputation of the set.
    expect(api.removeWorkItemLabels).toHaveBeenCalledWith(expect.objectContaining({
      labelId: 'label-a', labelIds: ['label-b'], expectedVersion: 4,
    }))
    expect(await db.workItems.get('work-1')).toMatchObject({
      labelIds: ['label-b'], version: 5,
    })
  })

  it('refuses to replay a TS-02a-era intent that lacks the addressed label', async () => {
    // A `remove_work_item_labels` intent written BEFORE TS-02a has no `labelId`
    // in its requestJson (the URL segment used to be inferred from labelIds[0]).
    // The durable path replays requestJson verbatim, so without a guard the
    // adapter would build `/labels/undefined`, the backend would fail closed on
    // the authority check, and the user's removal would vanish silently.
    const { db, api, spaceId } = await fixture(['label-a', 'label-b'], 4)
    const { prepareDirectCommandIntent } = await import('@/lib/direct-command-intents')
    await prepareDirectCommandIntent(db, {
      kind: 'remove_work_item_labels', spaceId, targetId: 'work-1',
      request: {
        workItemId: 'work-1', expectedVersion: 4, labelIds: ['label-b'], spaceId,
      },
      now: '2026-01-01T00:00:00.000Z',
    })
    // The API must not be handed a request it cannot address.
    api.removeWorkItemLabels.mockRejectedValue(
      new Error('legacy_label_intent_missing_addressed_label'),
    )
    const repository = new TaskSpaceRepository(db, spaceId, api)

    const resumed = await repository.resumePendingDirectCommandIntents()

    // Recorded as a diagnosable handler failure (not a transport retry), so it
    // is surfaced to the user instead of being retried forever or swallowed.
    expect(resumed.failed).toHaveLength(1)
    expect(resumed.failed[0].code).toBe('handler_error:remove_work_item_labels')
    const intent = (await db.directCommandIntents.toArray())[0]
    expect(intent).toMatchObject({
      state: 'failed', failureCode: 'handler_error:remove_work_item_labels',
    })
    // No local label write happened as a side effect of the failed replay.
    expect(await db.workItems.get('work-1')).toMatchObject({
      labelIds: ['label-a', 'label-b'], version: 4,
    })
  })

  it('rejects a remove request that carries no addressed label at all', async () => {
    // The repository writes the durable intent and hands it to the api — the
    // api adapter is where the address guard lives, because that is the layer
    // that would build the URL. So this test drives the REAL adapter (the
    // fixtures above mock it, exactly as production code is injected).
    const { taskSpaceApi: realApi } = await import('@/services/task-space-api')
    for (const bad of [undefined, '', null]) {
      await expect(
        realApi.removeWorkItemLabels({
          spaceId: 'spc', operationId: 'op-missing-label',
          workItemId: 'work-1', expectedVersion: 1, labelIds: [], labelId: bad as never,
        }),
      ).rejects.toThrow('legacy_label_intent_missing_addressed_label')
    }
  })

  it('keeps a stale-CAS rejection free of local label writes', async () => {
    const { db, api, spaceId } = await fixture(['label-a', 'label-b'], 4)
    api.removeWorkItemLabels.mockRejectedValue({
      isAxiosError: true,
      response: {
        status: 409,
        data: {
          code: 'version_conflict',
          message: 'Entity version conflict',
          retryable: false,
          details: { current_version: 9 },
        },
      },
    })
    const repository = new TaskSpaceRepository(db, spaceId, api)

    await expect(repository.removeWorkItemLabel({
      workItemId: 'work-1', labelId: 'label-a',
    })).rejects.toBeDefined()

    // Zero side effects: the cached row and the durable intent bookkeeping are
    // untouched, and nothing was adopted from the rejected command. The intent
    // stays non-terminal (it is NOT silently recorded as a successful write),
    // so the caller must re-read the authoritative row and retry with a new
    // commandId rather than re-firing this one under its original id.
    expect(await db.workItems.get('work-1')).toMatchObject({
      labelIds: ['label-a', 'label-b'], version: 4,
    })
    const intent = await db.directCommandIntents.toArray()
    expect(intent).toHaveLength(1)
    expect(intent[0]).toMatchObject({ kind: 'remove_work_item_labels' })
    expect(intent[0].state).not.toBe('terminal')
    expect(intent[0].resultJson).toBeNull()
  })

  it('refuses formal label mutations while offline', async () => {
    const { db, api, spaceId } = await fixture(['label-a'], 1)
    const repository = new TaskSpaceRepository(db, spaceId, api)
    const original = navigator.onLine
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false })
    try {
      await expect(repository.removeWorkItemLabel({
        workItemId: 'work-1', labelId: 'label-a',
      })).rejects.toThrow('offline_formal_mutation_forbidden')
      expect(api.removeWorkItemLabels).not.toHaveBeenCalled()
    } finally {
      Object.defineProperty(navigator, 'onLine', { configurable: true, value: original })
    }
  })

  it('declares the union target set for add (maintain or add only)', async () => {
    const { db, api, spaceId } = await fixture(['label-a'], 3)
    api.addWorkItemLabels.mockResolvedValue(accepted(['label-a', 'label-b'], 4))
    const repository = new TaskSpaceRepository(db, spaceId, api)

    const updated = await repository.addWorkItemLabels({
      workItemId: 'work-1', labelIds: ['label-b'],
    })

    expect(api.addWorkItemLabels).toHaveBeenCalledWith(expect.objectContaining({
      labelIds: ['label-a', 'label-b'], expectedVersion: 3,
    }))
    expect(updated).toMatchObject({ id: 'work-1', labelIds: ['label-a', 'label-b'] })
  })
})
