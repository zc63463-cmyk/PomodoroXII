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
import { loadSyncMeta, saveSyncMeta, clearSyncCursors, touchLastFullSync } from './sync-meta'
import type { ApiSyncPullResponse, PullLoopResult, SyncConflict } from './types'

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
  params?: { cursor?: number | null; limit?: number },
): Promise<ApiSyncPullResponse> {
  const res = await api.get<ApiSyncPullResponse>('/sync/full', { params })
  return res.data
}

/** 判断响应是否使用新版 cursor 协议 */
function usesCursorProtocol(page: ApiSyncPullResponse): boolean {
  return page.cursor_version != null && page.cursor_version >= 2
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
  let pages = 0

  // isFull → 清所有游标，保留 serverTime/lastFullSync/lastSyncAt
  if (isFull) {
    await clearSyncCursors(db)
  }

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

  // 分页循环
  while (true) {
    // 1. merge 远端行到 Dexie（收集 dirtyConflicts）
    await applyMerge(db, page, dirtyConflicts)
    pages++
    lastServerTime = page.server_time

    // 2. F1 §2.4b + H2-D: 每页 merge 后立即持久化游标
    if (usesCursorProtocol(page)) {
      // 新版 cursor 协议：持久化 next_cursor，同时清空旧游标
      await saveSyncMeta(db, {
        cursor: page.next_cursor ?? 0,
        cursorVersion: page.cursor_version,
        serverTime: page.server_time,
        // 保留旧游标为空串，以便回退兼容
        since: '',
        sinceId: '',
        tombstoneSinceId: '',
      })
    } else {
      // 旧版 since 协议
      await saveSyncMeta(db, {
        since: page.next_since,
        sinceId: page.next_since_id,
        tombstoneSinceId: page.next_tombstone_since_id,
        serverTime: page.server_time,
        // cursor 保持 null，表示未启用
        cursor: null,
        cursorVersion: null,
      })
    }

    // 3. F1-D3: 终止条件 has_more || tombstones_has_more
    if (!page.has_more && !page.tombstones_has_more) break

    // 4. 下一页用 response 游标
    if (usesCursorProtocol(page)) {
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

  // isFull 成功结束 → 写 last_full_sync
  if (isFull) {
    await touchLastFullSync(db, lastServerTime)
  }

  return { pages, dirtyConflicts }
}
