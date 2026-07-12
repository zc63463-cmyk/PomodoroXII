/**
 * Pull 分页循环（F1 §2.4 + §2.4b + §2.3，H2-D 新增 cursor 双协议）。
 *
 * - H2-D: 服务端返回 cursor_version=2 时优先使用 next_cursor；
 *   cursor=null 或缺失时回退旧 since/since_id/tombstone_since_id 协议。
 * - F1-D3 终止条件：has_more || tombstones_has_more
 * - F1 §2.4b：每页 merge 后立即 saveSyncMeta（防中断重复拉取；put 幂等）
 * - isFull：先 clearSyncCursors → fetchFullPage(/sync/full) → 结束 touchLastFullSync
 *   首页用 /sync/full，后续页用 /sync/pull + 游标（F1 §2.3「后续走增量」）
 * - HTTP 错误不包 try/catch（4xx/5xx 抛给上层 engine）
 */

import type { AxiosInstance } from 'axios'
import type { PomodoroXIDB } from '@/services/database'
import { applyMerge } from './merge'
import { loadSyncMeta, saveSyncMeta, touchLastFullSync } from './sync-meta'
import {
  ENTITY_TYPE_TO_TABLE,
  type ApiSyncPullResponse,
  type PullLoopResult,
  type SyncConflict,
} from './types'

export const DEFAULT_PULL_LIMIT = 1000

/** 单页增量 pull（GET /sync/pull） — cursor 优先 */
export async function fetchPullPage(
  api: AxiosInstance,
  params: {
    since: string
    since_id: string
    tombstone_since_id: string
    cursor?: number | null
    limit?: number
  },
): Promise<ApiSyncPullResponse> {
  const res = await api.get<ApiSyncPullResponse>('/sync/pull', { params })
  return res.data
}

/** 单页 full pull（GET /sync/full，首次 / 手动 fullSync 首页） */
export async function fetchFullPage(
  api: AxiosInstance,
  params?: {
    cursor?: number | null
    limit?: number
    snapshot_token?: string | null
    snapshot_offset?: number | null
  },
): Promise<ApiSyncPullResponse> {
  const res = await api.get<ApiSyncPullResponse>('/sync/full', { params })
  return res.data
}

/** 判断响应是否使用新版 cursor 协议 */
function usesCursorProtocol(page: ApiSyncPullResponse): boolean {
  return page.cursor_version === 2
}

type SnapshotSeenIds = Record<string, Set<string>>

function createSnapshotSeenIds(): SnapshotSeenIds {
  return Object.fromEntries(
    Object.values(ENTITY_TYPE_TO_TABLE).map((tableName) => [tableName, new Set<string>()]),
  )
}

function collectSnapshotSeenIds(seenIds: SnapshotSeenIds, page: ApiSyncPullResponse): void {
  for (const tableName of Object.values(ENTITY_TYPE_TO_TABLE)) {
    const rows = page[tableName] as Array<Record<string, unknown>> | undefined
    for (const row of rows ?? []) {
      seenIds[tableName]!.add(String(row.id))
    }
  }
}

async function reconcileFullSnapshot(db: PomodoroXIDB, seenIds: SnapshotSeenIds): Promise<void> {
  const pendingOutbox = (await db.outbox.toArray()).filter((event) => event.synced === false)
  const protectedEntities = new Set(
    pendingOutbox.map((event) => `${event.entityType}:${event.entityId}`),
  )
  for (const [entityType, tableName] of Object.entries(ENTITY_TYPE_TO_TABLE)) {
    const table = (
      db as unknown as Record<
        string,
        {
          toArray: () => Promise<Array<Record<string, unknown>>>
          bulkDelete: (ids: string[]) => Promise<void>
        }
      >
    )[tableName]
    if (!table) continue

    const staleIds = (await table.toArray())
      .filter((row) => {
        const entityId = String(row.id)
        return row._dirty !== true
          && !protectedEntities.has(`${entityType}:${entityId}`)
          && !seenIds[tableName]!.has(entityId)
      })
      .map((row) => String(row.id))
    if (staleIds.length > 0) await table.bulkDelete(staleIds)
  }
}

/** Pull 分页循环（F1 §2.4b：每页 merge 后立即 saveSyncMeta） */
export async function runPullLoop(
  db: PomodoroXIDB,
  api: AxiosInstance,
  options?: { isFull?: boolean; limit?: number },
): Promise<PullLoopResult> {
  const isFull = options?.isFull ?? false
  const limit = options?.limit ?? DEFAULT_PULL_LIMIT
  const dirtyConflicts: SyncConflict[] = []
  const snapshotSeenIds = isFull ? createSnapshotSeenIds() : null
  let snapshotProtocol: 'legacy' | 'materialized' | null = null
  let snapshotToken: string | null = null
  let pages = 0

  // 首页：isFull 用 /sync/full，否则用 /sync/pull + 已存游标
  const meta = await loadSyncMeta(db)
  // H2-D: isFull 始终尝试 cursor=0（后端会在无事件时 fallback 到旧协议）；
  // 增量 pull 仅在已存 cursor 时使用新协议。
  const useCursor = isFull || meta.cursor != null

  let page: ApiSyncPullResponse
  if (isFull) {
    page = await fetchFullPage(api, { cursor: 0, limit })
  } else if (useCursor) {
    page = await fetchPullPage(api, {
      since: meta.since,
      since_id: meta.sinceId,
      tombstone_since_id: meta.tombstoneSinceId,
      cursor: meta.cursor,
      limit,
    })
  } else {
    page = await fetchPullPage(api, {
      since: meta.since,
      since_id: meta.sinceId,
      tombstone_since_id: meta.tombstoneSinceId,
      limit,
    })
  }

  let lastServerTime = ''
  let pendingSnapshotCursor: number | null = null

  // 分页循环
  while (true) {
    if (isFull) {
      if (usesCursorProtocol(page) && !page.snapshot_token) {
        throw new Error('cursor v2 full response requires snapshot_token')
      }
      const pageProtocol = usesCursorProtocol(page) ? 'materialized' : 'legacy'
      if (snapshotProtocol === null) {
        snapshotProtocol = pageProtocol
        snapshotToken = pageProtocol === 'materialized' ? page.snapshot_token ?? null : null
      } else if (
        pageProtocol !== snapshotProtocol
        || (pageProtocol === 'materialized' && page.snapshot_token !== snapshotToken)
      ) {
        throw new Error('sync snapshot protocol changed during pagination')
      }
    }

    const isLastPage = !page.has_more && !page.tombstones_has_more
    if (snapshotSeenIds) collectSnapshotSeenIds(snapshotSeenIds, page)
    pages++
    lastServerTime = page.server_time
    pendingSnapshotCursor = usesCursorProtocol(page)
      ? page.next_cursor ?? pendingSnapshotCursor ?? 0
      : pendingSnapshotCursor

    if (isFull && snapshotProtocol === 'materialized' && isLastPage) {
      const terminalConflicts: SyncConflict[] = []
      await db.transaction('rw', db.tables, async () => {
        await applyMerge(db, page, terminalConflicts)
        await reconcileFullSnapshot(db, snapshotSeenIds!)
        await saveSyncMeta(db, {
          cursor: pendingSnapshotCursor,
          cursorVersion: 2,
          serverTime: page.server_time,
          since: '',
          sinceId: '',
          tombstoneSinceId: '',
        })
        await touchLastFullSync(db, lastServerTime)
      })
      dirtyConflicts.push(...terminalConflicts)
    } else {
      await applyMerge(db, page, dirtyConflicts)
      if (usesCursorProtocol(page)) {
        if (!isFull) {
          await saveSyncMeta(db, {
            cursor: pendingSnapshotCursor,
            cursorVersion: 2,
            serverTime: page.server_time,
            since: '',
            sinceId: '',
            tombstoneSinceId: '',
          })
        }
      } else {
        await saveSyncMeta(db, {
          since: page.next_since,
          sinceId: page.next_since_id,
          tombstoneSinceId: page.next_tombstone_since_id,
          serverTime: page.server_time,
          cursor: null,
          cursorVersion: null,
        })
        if (isFull && isLastPage) await touchLastFullSync(db, lastServerTime)
      }
    }

    // 3. F1-D3: 终止条件 has_more || tombstones_has_more
    if (isLastPage) break

    // 4. 下一页用 response 游标
    if (usesCursorProtocol(page) && isFull && page.snapshot_token) {
      page = await fetchFullPage(api, {
        cursor: 0,
        limit,
        snapshot_token: page.snapshot_token,
        snapshot_offset: page.snapshot_offset ?? 0,
      })
    } else if (usesCursorProtocol(page)) {
      page = await fetchPullPage(api, {
        since: '',
        since_id: '',
        tombstone_since_id: '',
        cursor: page.next_cursor,
        limit,
      })
    } else {
      page = await fetchPullPage(api, {
        since: page.next_since,
        since_id: page.next_since_id,
        tombstone_since_id: page.next_tombstone_since_id,
        limit,
      })
    }
  }

  return { pages, dirtyConflicts }
}
