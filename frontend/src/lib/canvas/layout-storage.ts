/**
 * 画布布局持久化（本地视图偏好）。
 *
 * ★ 为什么进 localStorage 而不是 Dexie/同步协议：手动微调的节点位置是
 *   **个人视图偏好**，不是事实数据 —— 进同步协议会让其它端的布局被覆盖，
 *   属于污染。localStorage 已满足「刷新后保持微调结果」；未来若要多端
 *   携带，再迁 Dexie 本地表（不同步）。
 */

const PREFIX = 'pxii.canvas.layout.'

export interface CanvasPosition {
  x: number
  y: number
}

export function loadCanvasLayout(key: string): Record<string, CanvasPosition> | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(PREFIX + key)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return null
    const out: Record<string, CanvasPosition> = {}
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (
        typeof value === 'object' && value !== null
        && typeof (value as CanvasPosition).x === 'number'
        && typeof (value as CanvasPosition).y === 'number'
      ) {
        out[id] = value as CanvasPosition
      }
    }
    return out
  } catch {
    return null
  }
}

export function saveCanvasLayout(key: string, positions: Record<string, CanvasPosition>): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(PREFIX + key, JSON.stringify(positions))
  } catch {
    // 配额满 / 隐私模式：布局偏好丢失是可接受的，绝不因此打断交互。
  }
}

export function clearCanvasLayout(key: string): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.removeItem(PREFIX + key)
  } catch {
    // ignore
  }
}
