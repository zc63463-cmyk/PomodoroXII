/**
 * 时间戳规范化（F1 附录 D / DR-9）。
 *
 * 对齐后端 sync_safety.normalize_timestamp：输出毫秒精度 ISO 字符串，
 * 字典序与时间序一致（ISO 8601 保证），供 applyMerge LWW 比较。
 *
 * - 空串 / null / undefined → ''
 * - 非法格式（new Date NaN）→ ''
 * - 合法 → d.toISOString()（毫秒精度）
 *
 * 后端微秒精度，JS Date 仅毫秒；LWW 用字符串比较，毫秒精度足够。
 */
export function normalizeTs(ts: string | undefined | null): string {
  if (!ts) return ''
  try {
    const d = new Date(ts)
    if (isNaN(d.getTime())) return ''
    return d.toISOString()
  } catch {
    return ''
  }
}
