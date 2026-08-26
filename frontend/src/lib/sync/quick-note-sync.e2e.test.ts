/**
 * QuickNote 同步链路端到端集成测试（QN-S6）。
 *
 * 覆盖三个真实场景：
 *   A. pull 合并 —— 远端小记经 pull 落地本地 Dexie，不与本地未同步小记冲突、无重复；
 *   B. 版本冲突 —— 远端版本更高时本地内容不被覆盖、冲突被引擎记录、可经 resolveConflict 收敛；
 *   C. 失败重试 —— push 首次失败（5xx）后 outbox/receipt 保留待重试，重试成功即收敛。
 *
 * 技术边界：只 mock transport 网络层（spaceApi.defaults.adapter 按 URL 分发），
 * quick-note-repository / Dexie 全程真实；每个用例独立 Space（spaceDBManager.switchTo）。
 * 复用 engine.test.ts 的 FakeLockManager（navigator.locks mock）与 v2 adapter 分发思路。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AxiosResponse, InternalAxiosRequestConfig } from 'axios'

import { db, spaceDBManager } from '@/services/space-db'
import { spaceApi } from '@/services/api'
import { withSpaceAuthorityFence } from './space-authority-fence'
import { writeSyncV2Meta } from './sync-meta'
import { RealSyncEngine } from './engine'
import {
  createQuickNote,
  listQuickNoteSyncStates,
  resetQuickNoteOutboxHook,
} from '@/lib/quick-notes/quick-note-repository'

// ---- 可复用基础设施（与 engine.test.ts 一致） ----

class FakeLockManager {
  private readonly tails = new Map<string, Promise<void>>()

  request<T>(_name: string, _options: { mode: 'exclusive' }, callback: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(_name) ?? Promise.resolve()
    const result = previous.then(callback)
    const tail = result.then(() => undefined, () => undefined)
    this.tails.set(_name, tail)
    void tail.finally(() => { if (this.tails.get(_name) === tail) this.tails.delete(_name) })
    return result
  }
}

const originalLocks = Object.getOwnPropertyDescriptor(navigator, 'locks')
const originalAdapter = spaceApi.defaults.adapter

function installLocks(value: FakeLockManager | undefined): void {
  Object.defineProperty(navigator, 'locks', { configurable: true, value })
}

function ok(data: unknown, config: InternalAxiosRequestConfig): AxiosResponse {
  return { data, status: 200, statusText: 'OK', headers: {}, config }
}

function parseBody(config: InternalAxiosRequestConfig): Record<string, unknown> {
  return typeof config.data === 'string' ? JSON.parse(config.data) : config.data
}

const catalogHash = 'a'.repeat(64)
const seedCursor = 'seed-cursor-0001'
const pullCursorNext = 'pull-cursor-0001'

/** 模拟「远端 quickNote post-image」（前端 quickNotes 表 camelCase 坐标系，与本地 outbox payload 同构）。 */
function quickNotePostImage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = new Date().toISOString()
  return {
    id: '',
    content: '',
    mood: null,
    tags: [],
    pinned: false,
    archived_at: null,
    archive_file_path: null,
    folder_id: null,
    trashed_at: null,
    migrated_to_note_id: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  }
}

/** 模拟 /sync/v2/pull 事件记录（按 ApiSyncV2EventRecord 形状）。 */
function quickNoteEvent(
  event: { id: string; content: string; action?: 'create' | 'update' | 'delete'; version?: number },
): Record<string, unknown> {
  const payload = quickNotePostImage({ id: event.id, content: event.content })
  return {
    operation_id: `remote-op-${event.id.replace(/-/g, '')}`,
    batch_id: `remote-op-${event.id.replace(/-/g, '')}`,
    entity_type: 'quickNote',
    entity_id: event.id,
    action: event.action ?? 'create',
    payload,
    version: event.version ?? 1,
    created_at: '2026-08-01T10:00:00.000Z',
  }
}

/** 预装 v2 cursor，使首个 sync 跳过 recover 直接增量 pull（与 engine.test.ts「opaque cursor」用例一致）。 */
async function seedSyncCursor(): Promise<void> {
  await withSpaceAuthorityFence(db.spaceId, (token) => writeSyncV2Meta(
    spaceDBManager.current, db.spaceId, token,
    { cursor: seedCursor, pendingAck: null, catalogHash, requiresFullRecovery: false },
  ))
}

interface V2AdapterHandlers {
  pullEvents?: Record<string, unknown>[]
  pushOutcome?: (body: Record<string, unknown>) => Record<string, unknown>
  pushAttemptsBeforeSuccess?: number
}

interface PushCallCounter { count: number }

/** 安装按 URL 分发的 v2 adapter（恢复 / ack / pull / operations/query / push）。 */
function installV2Adapter(handlers: V2AdapterHandlers = {}): PushCallCounter {
  const pushCalls: PushCallCounter = { count: 0 }
  spaceApi.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
    const url = config.url ?? ''
    if (url.endsWith('/sync/v2/recover')) {
      return ok({
        payload_jsonl_base64: '', entity_count: 0, chunk_sha256: '',
        next_page_token: null, has_more: false, catalog_hash: catalogHash,
        waterline_cursor: seedCursor,
      }, config)
    }
    if (url.endsWith('/sync/v2/ack')) {
      const body = parseBody(config)
      return ok({ client_id: body.client_id, accepted: true,
        requires_recovery: false, catalog_hash: catalogHash }, config)
    }
    if (url.endsWith('/sync/v2/pull')) {
      return ok({ events: handlers.pullEvents ?? [], next_cursor: pullCursorNext,
        has_more: false, catalog_hash: catalogHash }, config)
    }
    if (url.endsWith('/sync/v2/operations/query')) {
      const body = parseBody(config)
      const operationIds = body.operation_ids as string[]
      return ok({ items: operationIds.map((operation_id) =>
        ({ operation_id, state: 'unknown', batch_id: null, result: null })) }, config)
    }
    if (url.endsWith('/sync/v2/push')) {
      const body = parseBody(config)
      pushCalls.count += 1
      const failFirst = handlers.pushAttemptsBeforeSuccess ?? 0
      if (pushCalls.count <= failFirst) {
        throw Object.assign(new Error('Request failed with status code 500'), {
          response: { status: 500, statusText: 'Internal Server Error', data: { code: 'internal_error' } },
        })
      }
      if (handlers.pushOutcome) return ok(handlers.pushOutcome(body), config)
      const events = body.events as { operation_id: string; entity_type: string; entity_id: string }[]
      return ok({ batch_id: body.batch_id,
        applied: events.map((event) => ({ operation_id: event.operation_id,
          entity_type: event.entity_type, entity_id: event.entity_id, version: 2, resolution: null })),
        conflicts: [], errors: [] }, config)
    }
    throw new Error(`unexpected sync URL: ${url}`)
  }
  return pushCalls
}

describe('quick-note sync end-to-end (QN-S6)', () => {
  beforeEach(async () => {
    resetQuickNoteOutboxHook()
    await spaceDBManager.switchTo(`quick-note-sync-e2e-${crypto.randomUUID()}`)
    installLocks(new FakeLockManager())
  })

  afterEach(async () => {
    resetQuickNoteOutboxHook()
    spaceApi.defaults.adapter = originalAdapter
    if (originalLocks) Object.defineProperty(navigator, 'locks', originalLocks)
    else Reflect.deleteProperty(navigator, 'locks')
    await db.delete()
    spaceDBManager.close()
  })

  it('A: pull merges a remote quickNote into Dexie without clobbering an unsynced local one', async () => {
    const local = await createQuickNote({ content: 'local #A' })
    const remoteId = crypto.randomUUID()
    await seedSyncCursor()
    installV2Adapter({ pullEvents: [quickNoteEvent({ id: remoteId, content: 'remote #B', version: 2 })] })
    const engine = new RealSyncEngine(spaceDBManager.current, db.spaceId)

    await engine.sync()

    // 两条小记（local + remote），id 无重复
    const rows = await db.quickNotes.toArray()
    expect(rows).toHaveLength(2)
    expect(new Set(rows.map((row) => row.id)).size).toBe(2)

    // 远端小记按 LWW 落地：内容正确、_dirty=false、version=远端版本
    const remote = await db.quickNotes.get(remoteId)
    expect(remote).toMatchObject({ content: 'remote #B', _dirty: false })
    expect(remote!.version).toBe(2)

    // 本地小记未被 pull 覆盖/破坏：内容与 version 保持；push applied 后 _dirty 收敛为 false（QN-S2 补强）
    const keptLocal = await db.quickNotes.get(local.id)
    expect(keptLocal).toMatchObject({ content: 'local #A', _dirty: false })
    expect(keptLocal!.version).toBe(1)
    // 本地 outbox 已随 push applied 收敛，无残留
    expect(await db.outbox.where('entityId').equals(local.id).toArray()).toHaveLength(0)

    expect(engine.getStatus()).toBe('idle')
    expect(engine.getConflicts()).toEqual([])
    engine.destroy()
  })

  it('B: a higher remote version is not clobbering local, is recorded, and resolves cleanly', async () => {
    const local = await createQuickNote({ content: 'mine' })
    const localRow = await db.quickNotes.get(local.id)
    expect(localRow).toMatchObject({ version: 1 })
    await seedSyncCursor()
    // pull 携带同 id 更强版本事件 → merge 触发 pre-push dirty 冲突（本地不覆盖）
    installV2Adapter({
      pullEvents: [quickNoteEvent({ id: local.id, content: 'remote v2', action: 'update', version: 2 })],
      // QN-S8b：push 阶段服务端裁决 version_conflict 并回传权威快照（立即采纳远端）
      pushOutcome: (body) => {
        const events = body.events as { operation_id: string; entity_type: string; entity_id: string }[]
        return { batch_id: body.batch_id, applied: [],
          conflicts: events.map((event) => ({ operation_id: event.operation_id,
            entity_type: event.entity_type, entity_id: event.entity_id,
            code: 'version_conflict', resolution: 'local',
            version: 2,
            snapshot: quickNotePostImage({ id: event.entity_id, content: 'remote v2' }),
            details: {} })),
          errors: [] }
      },
    })
    const engine = new RealSyncEngine(spaceDBManager.current, db.spaceId)

    await engine.sync()

    // 本地内容未被远端覆盖
    expect((await db.quickNotes.get(local.id))).toMatchObject({ content: 'mine' })
    expect(engine.getStatus()).toBe('conflict')

    // push 阶段服务端裁决 version_conflict → outbox 行保留为 terminal_conflict（未被静默丢弃）
    const outboxRows = await db.outbox.where('entityId').equals(local.id).toArray()
    expect(outboxRows).toHaveLength(1)
    expect(outboxRows[0]).toMatchObject({ entityType: 'quickNote', entityId: local.id, synced: false })
    expect(outboxRows[0]!.transportState).toBe('terminal_conflict')

    // QN-S7/QN-S8b：两类冲突均进入面板 —— pull 阶段 pre-push（outboxId=-1）与 push 阶段 post-push（outboxId>=0）
    const conflicts = engine.getConflicts()
    const prePush = conflicts.find((c) => c.outboxId === -1)
    const postPush = conflicts.find((c) => c.outboxId >= 0)
    expect(prePush).toMatchObject({
      outboxId: -1, entityType: 'quickNote', entityId: local.id, conflictType: 'version',
    })
    expect(prePush!.localVersion).toMatchObject({ id: local.id, content: 'mine' })
    expect(prePush!.remoteVersion).toMatchObject({ id: local.id, content: 'remote v2' })
    expect(postPush).toMatchObject({
      entityType: 'quickNote', entityId: local.id, conflictType: 'version',
    })
    expect(postPush!.outboxId).toBe(outboxRows[0]!.id)
    // QN-S8b：post-push 冲突携带服务端权威快照
    expect(postPush!.remoteVersion).toMatchObject({ id: local.id, content: 'remote v2' })

    // QN-S8b：解决 post-push 冲突（accept-remote 立即采纳远端内容，不再延迟）
    await engine.resolveConflict(postPush!.outboxId, 'accept-remote')
    expect(await db.outbox.where('entityId').equals(local.id).toArray()).toHaveLength(0)
    expect((await db.quickNotes.get(local.id))).toMatchObject({ content: 'remote v2', _dirty: false })
    expect(engine.getStatus()).toBe('conflict')

    // 再解决 pre-push 冲突（accept-remote：采纳 pull 阶段的远端内容）→ 完整收敛
    await engine.resolveConflict(-1, 'accept-remote', { entityType: 'quickNote', entityId: local.id })
    expect(await db.quickNotes.get(local.id)).toMatchObject({ content: 'remote v2', _dirty: false })
    expect(engine.getConflicts()).toEqual([])
    expect(engine.getStatus()).toBe('idle')
    // 收敛后同步状态视图不再包含该小记
    expect(await listQuickNoteSyncStates()).not.toHaveProperty(local.id)
    engine.destroy()
  })

  it('B2: keep-local retains local content and makes a post-push conflict retryable', async () => {
    const local = await createQuickNote({ content: 'keep mine' })
    await seedSyncCursor()
    // 仅 push 阶段裁决 version_conflict（无 pull 冲突），聚焦 post-push 冲突
    installV2Adapter({
      pushOutcome: (body) => {
        const events = body.events as { operation_id: string; entity_type: string; entity_id: string }[]
        return { batch_id: body.batch_id, applied: [],
          conflicts: events.map((event) => ({ operation_id: event.operation_id,
            entity_type: event.entity_type, entity_id: event.entity_id,
            code: 'version_conflict', resolution: 'local', details: {} })),
          errors: [] }
      },
    })
    const engine = new RealSyncEngine(spaceDBManager.current, db.spaceId)

    await engine.sync()

    const postPush = engine.getConflicts().find((c) => c.outboxId >= 0)
    expect(postPush).toBeDefined()
    expect((await db.outbox.get(postPush!.outboxId))).toMatchObject({ transportState: 'terminal_conflict' })

    // keep-local：本地内容保留、outbox 行复位为可重试（清 terminal 诊断标记）
    await engine.resolveConflict(postPush!.outboxId, 'keep-local')

    expect(await db.quickNotes.get(local.id)).toMatchObject({ content: 'keep mine', _dirty: true })
    const retryable = await db.outbox.get(postPush!.outboxId)
    expect(retryable).toMatchObject({
      synced: false, transportState: 'ready', lastError: null,
      retryable: false, nextAttemptAt: null,
    })
    expect(retryable!.serverOutcomeCanonicalBase64).toBeNull()
    expect(engine.getConflicts()).toEqual([])
    expect(engine.getStatus()).toBe('idle')
    engine.destroy()
  })

  it('B3: post-push snapshot lets accept-remote adopt remote content immediately without a pull', async () => {
    const local = await createQuickNote({ content: 'mine' })
    await seedSyncCursor()
    // 无 pull 事件（cursor 已消费）；push 裁决 version_conflict 并回传权威快照
    installV2Adapter({
      pullEvents: [],
      pushOutcome: (body) => {
        const events = body.events as { operation_id: string; entity_type: string; entity_id: string }[]
        return { batch_id: body.batch_id, applied: [],
          conflicts: events.map((event) => ({ operation_id: event.operation_id,
            entity_type: event.entity_type, entity_id: event.entity_id,
            code: 'version_conflict', resolution: 'local',
            version: 2,
            snapshot: quickNotePostImage({ id: event.entity_id, content: 'remote now' }),
            details: {} })),
          errors: [] }
      },
    })
    const engine = new RealSyncEngine(spaceDBManager.current, db.spaceId)

    await engine.sync()
    const postPush = engine.getConflicts().find((c) => c.outboxId >= 0)
    expect(postPush).toBeDefined()
    expect(postPush!.remoteVersion).toMatchObject({ id: local.id, content: 'remote now' })
    expect((await db.quickNotes.get(local.id))).toMatchObject({ content: 'mine', _dirty: true })

    // QN-S8b：accept-remote 直接写入服务端权威快照 → 立即收敛，无需等后续 pull
    await engine.resolveConflict(postPush!.outboxId, 'accept-remote')
    expect((await db.quickNotes.get(local.id))).toMatchObject({ content: 'remote now', _dirty: false })
    expect(await db.outbox.where('entityId').equals(local.id).toArray()).toHaveLength(0)
    expect(engine.getConflicts()).toEqual([])
    expect(engine.getStatus()).toBe('idle')
    expect(await listQuickNoteSyncStates()).not.toHaveProperty(local.id)
    engine.destroy()
  })

  it('C: a failed push is retried on the next sync and converges', async () => {
    const note = await createQuickNote({ content: 'retry #C' })
    await seedSyncCursor()
    // push 首次 5xx、第二次成功；pull/query 全程正常
    installV2Adapter({ pushAttemptsBeforeSuccess: 1 })
    const engine = new RealSyncEngine(spaceDBManager.current, db.spaceId)

    // 第一次 sync：push 5xx → 引擎置 infra-error；outbox 行写入失败诊断并保留（可重试）
    await engine.sync()
    expect(engine.getStatus()).toBe('infra-error')
    const [failedRow] = await db.outbox.where('entityId').equals(note.id).toArray()
    expect(failedRow).toMatchObject({ entityType: 'quickNote', entityId: note.id, synced: false })
    expect(failedRow!.lastError).toBeTruthy()
    expect(failedRow!.lastErrorCode).toBeTruthy()
    expect(failedRow!.failedAt).toBeTruthy()
    expect(await db.syncPushBatches.toArray()).toHaveLength(1)
    // QN-S2 补强：失败诊断使该小记如实呈现 failed 状态
    expect(await listQuickNoteSyncStates()).toEqual({ [note.id]: 'failed' })

    // 第二次 sync：重试成功 → outbox 收敛（行被 applied 清除），失败标记随行消失
    await engine.sync()
    expect(engine.getStatus()).toBe('idle')
    expect(engine.getConflicts()).toEqual([])
    expect(await db.outbox.where('entityId').equals(note.id).toArray()).toHaveLength(0)
    expect(await db.syncPushBatches.toArray()).toHaveLength(0)
    // 收敛后同步状态视图不再包含该小记（push 成功 _dirty 收敛为 false）
    expect(await listQuickNoteSyncStates()).not.toHaveProperty(note.id)
    // 小记本体仍在本地
    expect((await db.quickNotes.get(note.id))).toMatchObject({ content: 'retry #C' })
    engine.destroy()
  })
})