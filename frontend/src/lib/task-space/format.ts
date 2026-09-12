/**
 * Presentation-only formatting helpers for the task-space workbench.
 *
 * ★ 纯函数、无副作用。时间格式固定 `zh-CN` + `Asia/Shanghai`，让测试与
 *    渲染结果不随机器时区漂移。
 */

const DATE_TIME_FORMATTER = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})

/** `2026-09-10T12:41:29.874Z` → `2026-09-10 20:41`（无法解析时返回 null）。 */
export function formatTimestamp(iso: string | null | undefined): string | null {
  if (!iso) return null
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return null
  return DATE_TIME_FORMATTER.format(date).replace(/\//g, '-')
}

/**
 * `2026-09-10T12:41:29.874Z` → `3 小时前` / `5 分钟前` / `2 天前`；
 * 超过 30 天回落到绝对时间。`now` 由调用方注入以便测试。
 */
export function formatRelativeTime(
  iso: string | null | undefined,
  now: number = Date.now(),
): string | null {
  if (!iso) return null
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return null
  const deltaSeconds = Math.round((now - date.getTime()) / 1000)
  if (deltaSeconds < 60) return '刚刚'
  if (deltaSeconds < 3600) return `${Math.floor(deltaSeconds / 60)} 分钟前`
  if (deltaSeconds < 86400) return `${Math.floor(deltaSeconds / 3600)} 小时前`
  if (deltaSeconds < 86400 * 30) return `${Math.floor(deltaSeconds / 86400)} 天前`
  return formatTimestamp(iso)
}

/** `3660` → `1 小时 1 分钟`；`90` → `1 分钟 30 秒`；`0` → `0 秒`。 */
export function formatEffortSeconds(totalSeconds: number | null | undefined): string {
  if (totalSeconds == null || !Number.isFinite(totalSeconds)) return '—'
  const total = Math.max(0, Math.round(totalSeconds))
  if (total === 0) return '0 秒'
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  const parts: string[] = []
  if (hours > 0) parts.push(`${hours} 小时`)
  if (minutes > 0) parts.push(`${minutes} 分钟`)
  if (seconds > 0 && hours === 0) parts.push(`${seconds} 秒`)
  return parts.join(' ') || '0 秒'
}

/** 估算区间 `1 小时 – 2 小时`；两端都缺时返回 null。 */
export function formatEffortEstimate(
  lowerSeconds: number | null | undefined,
  upperSeconds: number | null | undefined,
): string | null {
  const hasLower = lowerSeconds != null && Number.isFinite(lowerSeconds)
  const hasUpper = upperSeconds != null && Number.isFinite(upperSeconds)
  if (!hasLower && !hasUpper) return null
  if (hasLower && hasUpper) {
    return `${formatEffortSeconds(lowerSeconds)} – ${formatEffortSeconds(upperSeconds)}`
  }
  return formatEffortSeconds(hasLower ? lowerSeconds : upperSeconds)
}
