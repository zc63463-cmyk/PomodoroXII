/**
 * BlockerAck 本地记录（个人视图级、不同步）。
 *
 * ★ 为什么先落在这里：BlockerAckModal 的注释一直声称 "the caller can record
 *   a BlockerAck event"，而全仓没有任何记录通道 —— "never silent" 的
 *   override 决定实际无声无痕。审计 / 活动流（Activity Rule）尚未建设，
 *   先用 append-only 本地日志兜底：可查、可清、可断言，不引入同步协议、
 *   不新增服务端表。
 * ★ 与画布布局同款取舍：localStorage + 上限裁剪；配额满 / 隐私模式静默
 *   降级，绝不因记录失败打断交互。
 * ★ 这不是事实数据：不进同步、不进 Dexie、不参与派生；将来有审计流后
 *   整模块删除即可。
 */

const STORAGE_KEY = 'pxii.blockerAcks.v1'
const MAX_ENTRIES = 200

export interface BlockerAckEntry {
  /** 被强制启动的二级工作项。 */
  workItemId: string
  /** 本次被 override 的未完成上游。 */
  blockerIds: string[]
  /** 从哪个入口确认的。 */
  source: 'tasks' | 'timer'
  /** ISO 时间戳。 */
  at: string
}

function isEntry(value: unknown): value is BlockerAckEntry {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return (
    typeof record.workItemId === 'string'
    && Array.isArray(record.blockerIds)
    && record.blockerIds.every((id) => typeof id === 'string')
    && (record.source === 'tasks' || record.source === 'timer')
    && typeof record.at === 'string'
  )
}

export function readBlockerAcks(): BlockerAckEntry[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isEntry)
  } catch {
    return []
  }
}

export function recordBlockerAck(entry: {
  workItemId: string
  blockerIds: string[]
  source: BlockerAckEntry['source']
  at?: string
}): void {
  if (typeof window === 'undefined') return
  try {
    const next = [...readBlockerAcks(), {
      workItemId: entry.workItemId,
      blockerIds: [...entry.blockerIds],
      source: entry.source,
      at: entry.at ?? new Date().toISOString(),
    }]
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(next.slice(Math.max(0, next.length - MAX_ENTRIES))),
    )
  } catch {
    // 记录失败绝不打断交互（与布局偏好同款取舍）。
  }
}

export function clearBlockerAcks(): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.removeItem(STORAGE_KEY)
  } catch {
    // ignore
  }
}
