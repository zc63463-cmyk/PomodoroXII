/**
 * QN-S8 评估用复现测试（单用例）：验证 post-push `version_conflict` 时
 * 本地 pull cursor 与远端更高版本事件的相对位置 —— 决定方案 A（force pull）是否可行。
 *
 * 关键问题：冲突发生时，本地 cursor 是否「必然」尚未包含远端更高版本事件？
 * 反例构造：本地 cursor 已消费过远端事件（该事件因 outbox 保护在 pull 阶段被丢弃、cursor 仍前移，
 * 见 merge.ts applySyncEventRecord / pull-loop.ts persistSyncV2MetaInCurrentTransaction），
 * 随后 push 被裁决 version_conflict。此时 accept-remote 后再调度增量 pull，
 * 由于事件已在 cursor 之内，服务端不会重放 —— 内容不会被远端覆盖。
 *
 * 技术边界：只 mock transport 网络层；quick-note-repository / Dexie 全程真实。
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
  resetQuickNoteOutboxHook,
} from '@/lib/quick-notes/quick-note-repository'

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

/** 预装 v2 cursor，使首个 sync 跳过 recover 直接增量 pull（等价于远端事件已被此前某次 pull 消费）。 */
async function seedSyncCursor(): Promise<void> {
  await withSpaceAuthorityFence(db.spaceId, (token) => writeSyncV2Meta(
    spaceDBManager.current, db.spaceId, token,
    { cursor: 'seed-cursor-0001', pendingAck: null, catalogHash, requiresFullRecovery: false },
  ))
}

/** pull 恒为空（同 cursor 不重放事件）；push 恒被裁决 version_conflict。 */
function installV2Adapter(): void {
  spaceApi.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
    const url = config.url ?? ''
    if (url.endsWith('/sync/v2/recover')) {
      return ok({
        payload_jsonl_base64: '', entity_count: 0, chunk_sha256: '',
        next_page_token: null, has_more: false, catalog_hash: catalogHash,
        waterline_cursor: 'seed-cursor-0001',
      }, config)
    }
    if (url.endsWith('/sync/v2/ack')) {
      const body = parseBody(config)
      return ok({ client_id: body.client_id, accepted: true,
        requires_recovery: false, catalog_hash: catalogHash }, config)
    }
    if (url.endsWith('/sync/v2/pull')) {
      return ok({ events: [], next_cursor: 'seed-cursor-0001',
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
      const events = body.events as { operation_id: string; entity_type: string; entity_id: string }[]
      return ok({ batch_id: body.batch_id, applied: [],
        conflicts: events.map((event) => ({ operation_id: event.operation_id,
          entity_type: event.entity_type, entity_id: event.entity_id,
          code: 'version_conflict', resolution: 'manual', details: {} })),
        errors: [] }, config)
    }
    throw new Error(`unexpected sync URL: ${url}`)
  }
}

describe('quick-note sync cursor semantics (QN-S8)', () => {
  beforeEach(async () => {
    resetQuickNoteOutboxHook()
    await spaceDBManager.switchTo(`quick-note-sync-cursor-${crypto.randomUUID()}`)
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

  it('后置 push conflict 且远端事件已在 cursor 内时，accept-remote 后的增量 pull 无法重放远端内容', async () => {
    const local = await createQuickNote({ content: 'mine' })
    await seedSyncCursor()
    installV2Adapter()
    const engine = new RealSyncEngine(spaceDBManager.current, db.spaceId)

    // 首次 sync：pull 无新事件（cursor 内事件不会重放），push 被裁决 version_conflict
    await engine.sync()
    const postPush = engine.getConflicts().find((c) => c.outboxId >= 0)
    expect(postPush).toBeDefined()
    expect(postPush!.remoteVersion).toBeNull() // 协议不回传远端快照（buildPushConflicts 置 null）
    expect((await db.quickNotes.get(local.id))).toMatchObject({ content: 'mine' })

    // accept-remote：删 outbox + _dirty 收敛，但内容保持不变（放弃本地、未采纳远端）
    await engine.resolveConflict(postPush!.outboxId, 'accept-remote')
    expect(await db.outbox.where('entityId').equals(local.id).toArray()).toHaveLength(0)
    expect((await db.quickNotes.get(local.id))).toMatchObject({ content: 'mine', _dirty: false })

    // 方案 A 的 force pull：再次同步（同 cursor 增量 pull）——事件不重放，内容仍为本地值
    expect(engine.getConflicts()).toEqual([])
    await engine.sync()
    expect((await db.quickNotes.get(local.id))).toMatchObject({ content: 'mine', _dirty: false })
    expect(engine.getStatus()).toBe('idle')

    // 结论：冲突时 cursor 已包含远端事件 ⇒ 增量 force pull 无法即时收敛，方案 A（force pull）失效
    engine.destroy()
  })
})