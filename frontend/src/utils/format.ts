// ============================================================
// PomodoroXI - Time & Date formatting utilities
// ============================================================

/**
 * Format minutes to readable string (e.g. "1小时30分钟")
 */
export function formatMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes}分钟`
  const hrs = Math.floor(minutes / 60)
  const mins = minutes % 60
  if (mins === 0) return `${hrs}小时`
  return `${hrs}小时${mins}分钟`
}

/**
 * Format Date or ISO string to YYYY-MM-DD
 */
export function formatDate(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date
  const year = d.getFullYear()
  const month = (d.getMonth() + 1).toString().padStart(2, '0')
  const day = d.getDate().toString().padStart(2, '0')
  return `${year}-${month}-${day}`
}

/**
 * Format Date or ISO string to YYYY-MM-DD HH:mm:ss
 */
export function formatDateTime(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date
  return `${formatDate(d)} ${formatTimeOfDay(d)}`
}

/**
 * Format time to HH:mm:ss
 */
export function formatTimeOfDay(date: Date): string {
  const hrs = date.getHours().toString().padStart(2, '0')
  const mins = date.getMinutes().toString().padStart(2, '0')
  const secs = date.getSeconds().toString().padStart(2, '0')
  return `${hrs}:${mins}:${secs}`
}

/**
 * Format seconds to MM:SS
 */
export function formatMMSS(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60)
  const s = totalSeconds % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

/**
 * Normalize server-returned ISO timestamps for client-side parsing.
 * Server uses `datetime.utcnow().isoformat()` (no suffix) but the time
 * is actually UTC.  `new Date()` interprets suffix-less ISO as local time,
 * causing an 8-hour skew on GMT+8 machines.
 * NOTE: ISO dates always contain '-' in the date portion (e.g. 2026-06-09T13:00:00),
 * so we must check the TIME portion (after 'T') for timezone offset signs.
 */
function normalizeISOTimestamp(iso: string): string {
  if (!iso) return iso
  if (iso.endsWith('Z')) return iso
  // Pure date (no T) — don't append Z, it would create an invalid ISO string
  if (!iso.includes('T')) return iso
  const timePart = iso.split('T')[1]
  if (timePart && (timePart.includes('+') || (timePart.includes('-') && timePart.lastIndexOf('-') > 0))) return iso
  return iso + 'Z'
}

/**
 * Get relative time description (e.g. "3分钟前", "昨天")
 */
export function formatRelativeTime(date: Date | string): string {
  const normalized = typeof date === 'string' ? normalizeISOTimestamp(date) : date
  const d = typeof normalized === 'string' ? new Date(normalized) : normalized
  const now = new Date()
  const diffMs = now.getTime() - d.getTime()
  const diffSecs = Math.floor(diffMs / 1000)
  const diffMins = Math.floor(diffSecs / 60)
  const diffHours = Math.floor(diffMins / 60)
  const diffDays = Math.floor(diffHours / 24)

  if (diffSecs < 60) return '刚刚'
  if (diffMins < 60) return `${diffMins}分钟前`
  if (diffHours < 24) return `${diffHours}小时前`
  if (diffDays === 1) return '昨天'
  if (diffDays < 7) return `${diffDays}天前`
  if (diffDays < 30) return `${Math.floor(diffDays / 7)}周前`
  if (diffDays < 365) return `${Math.floor(diffDays / 30)}个月前`
  return `${Math.floor(diffDays / 365)}年前`
}

/**
 * Friendly date display ("今天", "昨天", or YYYY-MM-DD)
 */
export function formatFriendlyDate(dateStr: string): string {
  const today = formatDate(new Date())
  const yesterday = formatDate(new Date(Date.now() - 86400000))
  if (dateStr === today) return '今天'
  if (dateStr === yesterday) return '昨天'
  return dateStr
}

/**
 * Format seconds to human-readable duration (e.g. "25 分钟")
 */
export function formatDuration(seconds: number): string {
  const mins = Math.round(seconds / 60)
  if (mins < 60) return `${mins} 分钟`
  const hrs = Math.floor(mins / 60)
  const remainingMins = mins % 60
  if (remainingMins === 0) return `${hrs} 小时`
  return `${hrs} 小时 ${remainingMins} 分钟`
}

/**
 * Get Chinese weekday name
 */
export function getWeekdayName(date: Date | string): string {
  const weekdays = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六']
  // Use local time consistently for both string and Date inputs.
  // Previously string inputs used getUTCDay() while Date inputs used getDay(),
  // causing inconsistency at timezone boundaries.
  const d = typeof date === 'string' ? new Date(date + 'T12:00:00') : date
  if (isNaN(d.getTime())) return ''
  return weekdays[d.getDay()]
}

/**
 * Get today's date string (YYYY-MM-DD)
 */
export function getToday(): string {
  return formatDate(new Date())
}

/**
 * Get this week's start/end dates (Monday to Sunday)
 */
export function getThisWeek(): [string, string] {
  const now = new Date()
  const dayOfWeek = now.getDay()
  const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek
  const monday = new Date(now)
  monday.setDate(now.getDate() + mondayOffset)
  const sunday = new Date(monday)
  sunday.setDate(monday.getDate() + 6)
  return [formatDate(monday), formatDate(sunday)]
}

/**
 * Get this month's start/end dates
 */
export function getThisMonth(): [string, string] {
  const now = new Date()
  const firstDay = new Date(now.getFullYear(), now.getMonth(), 1)
  const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0)
  return [formatDate(firstDay), formatDate(lastDay)]
}

/**
 * Get ISO string for current time
 */
export function nowISO(): string {
  return new Date().toISOString()
}

/**
 * Parse YYYY-MM-DD to Date (noon to avoid timezone issues)
 */
export function parseDate(dateStr: string): Date | null {
  const d = new Date(dateStr + 'T12:00:00')
  return isNaN(d.getTime()) ? null : d
}
