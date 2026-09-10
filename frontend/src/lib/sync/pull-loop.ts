import type { AxiosInstance } from 'axios'

import type { PomodoroXIDB } from '@/services/database'
import { applySyncEventRecord } from './merge'
import {
  loadSyncV2Meta,
  persistSyncV2MetaInCurrentTransaction,
  sendPendingAck,
} from './sync-meta'
import {
  requireSpaceAuthorityToken,
  requireSpaceDatabaseBinding,
  type SpaceAuthorityToken,
} from './space-authority-fence'
import { syncV2Pull } from './transport'
import { runFullRecovery } from './recovery'
import type { ApiSyncV2PullResponse, PullLoopResult, SyncConflict } from './types'

export const SYNC_V2_PULL_LIMIT = 500

export function validateSyncV2PullLimit(limit: number | undefined): number {
  const value = limit ?? SYNC_V2_PULL_LIMIT
  if (!Number.isSafeInteger(value) || value < 1 || value > SYNC_V2_PULL_LIMIT) {
    throw new Error('sync v2 pull limit must be an integer from 1 to 500')
  }
  return value
}

export function assertPullProgress(
  requestedCursor: string | null,
  page: ApiSyncV2PullResponse,
): void {
  if (page.has_more && page.events.length === 0) {
    throw new Error('Pull page claims more events without a record')
  }
  if ((page.has_more || page.events.length > 0) && page.next_cursor === requestedCursor) {
    throw new Error('Pull cursor did not advance')
  }
}

export async function runPullLoopV2(
  db: PomodoroXIDB,
  api: AxiosInstance,
  spaceId: string,
  clientId: string,
  token: SpaceAuthorityToken,
  options: { limit?: number; scope?: string } = {},
): Promise<PullLoopResult> {
  const scope = options.scope ?? ''
  requireSpaceAuthorityToken(token, spaceId)
  requireSpaceDatabaseBinding(db, spaceId)
  let meta = await loadSyncV2Meta(db)
  /**
   * ★★ 需要全量恢复时**自动恢复**，不要直接 throw。
   *
   *   直接 throw 会死锁：清除 `requiresFullRecovery` 的代码在 pull 成功之后
   *   （见本函数末尾），而这里一 throw，pull 就永远不执行 —— 标记永远清不掉，
   *   状态栏永久"同步出错"，且**不会发出任何同步请求**（后端日志空空如也）。
   *
   *   触发场景：服务端 catalog_hash 变化（例如新增实体）会要求 full recovery。
   *   这里跑一次恢复即可继续，无需用户手动清 IndexedDB。
   */
  if (meta.requiresFullRecovery) {
    await runFullRecovery(db, api, spaceId, clientId, token)
    meta = await loadSyncV2Meta(db)
    // 恢复完仍为 true 才是真的恢复失败，此时才抛错
    if (meta.requiresFullRecovery) throw new Error('sync v2 full recovery required')
  }
  if (meta.pendingAck !== null) {
    await sendPendingAck(db, api, spaceId, clientId, token)
    meta = await loadSyncV2Meta(db)
  }
  const initialCursor = scope ? (meta.scopeCursors[scope] ?? null) : meta.cursor
  if (initialCursor === null) {
    throw new Error(
      scope
        ? `sync v2 scope cursor is not installed: ${scope}`
        : 'sync v2 cursor is not installed',
    )
  }
  const limit = validateSyncV2PullLimit(options.limit)
  let cursor: string | null = initialCursor
  let pages = 0
  const dirtyConflicts: SyncConflict[] = []
  while (true) {
    const response: ApiSyncV2PullResponse =
      (await syncV2Pull(api, { client_id: clientId, cursor, limit, scope })).data
    assertPullProgress(cursor, response)
    const runTransaction = db.transaction.bind(db) as unknown as (
      mode: 'rw', ...args: unknown[]
    ) => Promise<void>
    await runTransaction('rw', ...db.tables, async () => {
      requireSpaceAuthorityToken(token, spaceId)
      for (const record of response.events) {
        await applySyncEventRecord(db, spaceId, token, record, dirtyConflicts)
      }
      if (scope) {
        // ★ 作用域游标**不参与 ACK**：服务端的 ack_sequence 是单值的，
        //   而 ACK 会驱动 retention 裁剪（见 backend/app/sync/retention.py）。
        //   用作用域游标去 ACK 会让服务端误判客户端的消费进度，进而裁剪掉
        //   其它作用域尚未消费的事件 —— 那是不可逆的数据丢失。
        //   代价是启用作用域订阅后 retention 推进依赖全量游标，
        //   服务端会偏保守地保留账本（安全方向）。
        const current = await loadSyncV2Meta(db)
        await persistSyncV2MetaInCurrentTransaction(db, spaceId, token, {
          scopeCursors: { ...current.scopeCursors, [scope]: response.next_cursor },
          catalogHash: response.catalog_hash,
          requiresFullRecovery: false,
        })
      } else {
        await persistSyncV2MetaInCurrentTransaction(db, spaceId, token, {
          cursor: response.next_cursor,
          pendingAck: response.next_cursor,
          catalogHash: response.catalog_hash,
          requiresFullRecovery: false,
        })
      }
    })
    if (!scope) await sendPendingAck(db, api, spaceId, clientId, token)
    pages += 1
    cursor = response.next_cursor
    if (!response.has_more) break
  }
  return { pages, dirtyConflicts }
}
