/**
 * Sync toast 通知（S1-4 sonner 实装）。
 *
 * - notifyRemoteWin：远端胜出（LWW 自动接受远端版本）计数 → toast.info
 * - notifyCircularRef：循环引用冲突计数 → toast.warning
 *
 * D19: count <= 0 不触发（避免无意义通知噪音）。
 * Toaster 已在 app/providers.tsx 挂载。
 */

import { toast } from 'sonner'

export function notifyRemoteWin(count: number): void {
  if (count <= 0) return
  toast.info(`远端胜出 ${count} 项（LWW 自动接受远端版本）`)
}

export function notifyCircularRef(count: number): void {
  if (count <= 0) return
  toast.warning(`检测到 ${count} 处循环引用冲突，请人工处理`)
}
