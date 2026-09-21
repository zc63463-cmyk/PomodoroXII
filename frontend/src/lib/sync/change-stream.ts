/**
 * TS-04 前端变更流：把服务端「已提交变更」通知接成既有 Sync v2 周期的唤醒源。
 *
 * 设计边界（与后端 `app/routes/v1/sync_events.py` 的契约一一对应）：
 *
 * - **只做失效提示，不做数据通道**：事件体只有 `space_id` 与
 *   `visible_watermark`；本模块绝不写入 cursor、ACK 或业务行，也绝不把事件内容
 *   当作数据。收到通知的唯一动作是调用既有的 `engine.sync()`。
 * - **不用原生 EventSource**：原生实现无法设置 `Authorization` 头。这里用带
 *   `AbortController` 的 streaming `fetch`，并增量解析 SSE 帧。
 * - **丢通知是安全的**：正确性由服务端连接时下发的 visible watermark 加既有
 *   Sync v2 pull/recovery 兜底；本模块的断线重连只是「尽快」而不是「保证」。
 * - **权威围栏**：Space 切换或 engine destroy 会 abort 流；此后任何迟到的回调
 *   都被 authority token 与 generation 计数拒绝，绝不能污染新 Space。
 * - **手动/在线/引导/脏标记同步不受影响**：流关闭后这些触发路径照常工作。
 */

import { tokenStorage } from '@/lib/token-storage'
import { API_V1_PREFIX } from '@/lib/platform'
import {
  requireSpaceAuthorityToken,
  type SpaceAuthorityToken,
} from './space-authority-fence'
import { SYNC_V2_PATHS } from './transport'

/** SSE 事件名与后端 `TASK_SPACE_CHANGED_EVENT` 必须一致。 */
export const TASK_SPACE_CHANGED_EVENT = 'task_space_changed'
/**
 * 路径由 `transport.ts` 的 `SYNC_V2_PATHS` 统一持有：仓库有一条门禁要求所有
 * sync 协议路径字面量只出现在 transport 中，因此变更流复用同一常量而不是自己
 * 再写一份（含注释在内都不允许出现该字面量）。
 */
export const CHANGE_STREAM_PATH = `${API_V1_PREFIX}${SYNC_V2_PATHS.events}` as const

/** 重连退避：有界指数退避，避免服务端持续不可用时打爆网络。 */
export const CHAIN_RECONNECT_BASE_MS = 1_000
export const CHAIN_RECONNECT_MAX_MS = 30_000
/** 权威复查间隔：Space 切换后旧流必须自行关闭，不能等网络事件。 */
export const AUTHORITY_RECHECK_MS = 2_000

/** 401/403 是**终态**：token 过期、Space 吊销或删除后不再重试。 */
const TERMINAL_STATUSES = new Set([401, 403, 404])

export interface ChangeStreamConfig {
  /** Space 身份；事件只对这一个 Space 生效。 */
  spaceId: string
  /** 既有同步周期入口（通常是 `engine.sync()`）。 */
  sync: () => Promise<void>
  /** 该 Space 的权威 token；迟到的回调靠它判定自己是否已过期。 */
  authority: SpaceAuthorityToken
  /** 取当前 bearer token；默认读 tokenStorage（可注入以便测试）。 */
  getToken?: () => string | null
  /** fetch 实现；默认用全局 fetch（可注入以便测试）。 */
  fetchImpl?: typeof fetch
  /** 解析出的 Space 与事件 Space 不一致时的观察钩子。 */
  onForeignEvent?: (spaceId: string) => void
  /** 传输/协议层错误（非终态）的观察钩子。 */
  onError?: (error: unknown) => void
  /** 退避与心跳参数覆盖（测试用）。 */
  reconnectBaseMs?: number
  reconnectMaxMs?: number
}

export interface ChangeStreamHandle {
  /** 关闭流：abort fetch、清重连定时器，并让此后所有回调失效。 */
  close(): void
  /** 已关闭（含权威失效导致的关闭）。 */
  readonly closed: boolean
  /** 自建立起收到的通知数（重复通知在本地合并前计数，便于观测）。 */
  readonly receivedCount: number
  /** 实际触发的同步周期数（合并与 pending 补跑后的真实次数）。 */
  readonly syncCount: number
}

interface PendingFlag {
  /** 同步进行中时置位；周期结束后补跑一次。 */
  pending: boolean
  /** 当前是否有周期在跑。 */
  running: boolean
}

/**
 * 启动一条 Space 变更流。
 *
 * 返回的 handle 是唯一关闭入口：Space 切换与 engine destroy 都必须调用它。
 */
export function startTaskSpaceChangeStream(
  config: ChangeStreamConfig,
): ChangeStreamHandle {
  const {
    spaceId,
    sync,
    authority,
    getToken = () => tokenStorage.getSpaceToken(),
    fetchImpl,
    onForeignEvent,
    onError,
    reconnectBaseMs = CHAIN_RECONNECT_BASE_MS,
    reconnectMaxMs = CHAIN_RECONNECT_MAX_MS,
  } = config

  let closed = false
  let receivedCount = 0
  let syncCount = 0
  let attempt = 0
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  let authorityTimer: ReturnType<typeof setInterval> | null = null
  let controller: AbortController | null = null

  const pending: PendingFlag = { pending: false, running: false }

  /**
   * 权威判定：token 仍存活、Space 仍匹配、且这条流没有被关闭。
   *
   * 迟到的通知/回调会在这里被拒绝 —— 这正是「Space 切换后旧流不得污染新
   * Space」的落点。
   */
  function stillAuthoritative(): boolean {
    if (closed) return false
    try {
      requireSpaceAuthorityToken(authority, spaceId)
    } catch {
      // token 已随 Space 切换或 engine destroy 失效：终止而非重连。
      shutdown()
      return false
    }
    return true
  }

  function shutdown(): void {
    if (closed) return
    closed = true
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    if (authorityTimer !== null) {
      clearInterval(authorityTimer)
      authorityTimer = null
    }
    controller?.abort()
    controller = null
  }

  /**
   * 每条通知触发一次同步；同步进行中只置一个 pending 标志，当前周期结束后
   * 补跑一次 —— 重复通知因此被合并，绝不会并发多个周期。
   */
  async function requestSync(): Promise<void> {
    if (!stillAuthoritative()) return
    if (pending.running) {
      pending.pending = true
      return
    }
    pending.running = true
    try {
      syncCount += 1
      await sync()
    } catch (error) {
      // 同步自身的失败由 engine 负责终态与重试；这里只做观察。
      onError?.(error)
    } finally {
      pending.running = false
      if (pending.pending && !closed) {
        pending.pending = false
        await requestSync()
      }
    }
  }

  function scheduleReconnect(): void {
    if (closed) return
    const delay = Math.min(reconnectBaseMs * 2 ** attempt, reconnectMaxMs)
    attempt += 1
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      if (closed) return
      void connect()
    }, delay)
  }

  /** 按 SSE 规范逐行解析一帧；只认 `event:` 与 `data:`。 */
  function handleFrame(lines: string[]): void {
    let eventName = 'message'
    const dataLines: string[] = []
    for (const line of lines) {
      if (line.startsWith(':')) continue // 心跳注释
      if (line.startsWith('event:')) {
        eventName = line.slice('event:'.length).trim()
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice('data:'.length).trim())
      }
    }
    // A frame already sitting in the buffer when close() runs must not be
    // counted or acted on: closed means closed, including in-flight bytes.
    if (closed) return
    if (eventName !== TASK_SPACE_CHANGED_EVENT) return
    if (dataLines.length === 0) return

    let payload: { space_id?: unknown; visible_watermark?: unknown }
    try {
      payload = JSON.parse(dataLines.join('\n'))
    } catch {
      // 畸形帧只丢弃，不当作数据使用。
      return
    }
    // 只接受本 Space 的事件：跨 Space 事件不得唤醒本 Space 的同步。
    if (payload.space_id !== spaceId) {
      if (typeof payload.space_id === 'string') onForeignEvent?.(payload.space_id)
      return
    }
    if (
      typeof payload.visible_watermark !== 'number' ||
      !Number.isFinite(payload.visible_watermark)
    ) {
      return
    }
    receivedCount += 1
    void requestSync()
  }

  async function readStream(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let boundary = buffer.indexOf('\n\n')
        while (boundary !== -1) {
          const raw = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)
          const lines = raw.split('\n').map((line) => line.replace(/\r$/, ''))
          handleFrame(lines)
          boundary = buffer.indexOf('\n\n')
        }
      }
    } finally {
      reader.releaseLock?.()
    }
  }

  async function connect(): Promise<void> {
    if (!stillAuthoritative()) return
    const token = getToken()
    if (!token) {
      // 无 token 等同未授权：终止，等下一次显式 bootstrap。
      shutdown()
      return
    }

    controller = new AbortController()
    const doFetch = fetchImpl ?? fetch
    try {
      const response = await doFetch(
        `${CHANGE_STREAM_PATH}?space_id=${encodeURIComponent(spaceId)}`,
        {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'text/event-stream',
          },
          signal: controller.signal,
        },
      )

      if (!response.ok) {
        if (TERMINAL_STATUSES.has(response.status)) {
          // token 过期 / Space 吊销或删除：不再重连。
          shutdown()
          return
        }
        onError?.(new Error(`change stream failed: ${response.status}`))
        scheduleReconnect()
        return
      }
      if (!response.body) {
        onError?.(new Error('change stream response has no body'))
        scheduleReconnect()
        return
      }

      // 连接成功即重置退避：断线后重连从最短间隔重新开始。
      attempt = 0
      await readStream(response.body)
      // 正常结束（服务端关闭 / abort）：若是权威失效则已 shutdown。
      if (!closed) scheduleReconnect()
    } catch (error) {
      if (closed) return
      if ((error as { name?: string })?.name === 'AbortError') return
      onError?.(error)
      scheduleReconnect()
    }
  }

  // Space 切换 / engine destroy 会让权威 token 失效，但不一定立刻有网络事件。
  // 例行复查保证旧流会自行关闭，而不是等到下一条通知才被发现。
  if (typeof setInterval === 'function') {
    authorityTimer = setInterval(() => {
      stillAuthoritative()
    }, AUTHORITY_RECHECK_MS)
    // Node/测试环境不阻止进程退出。
    ;(authorityTimer as unknown as { unref?: () => void }).unref?.()
  }

  void connect()

  return {
    close: shutdown,
    get closed() {
      return closed
    },
    get receivedCount() {
      return receivedCount
    },
    get syncCount() {
      return syncCount
    },
  }
}
