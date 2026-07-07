/**
 * Sync toast 通知 stub（S1-4 前为 no-op）。
 *
 * S1-4 实装 sonner toast 时替换为真实通知：
 * - notifyRemoteWin：远端胜出（resolution='remote'）计数
 * - notifyCircularRef：循环引用冲突计数
 */

/** S1-4 前 no-op；预留 remoteWin 计数通知 */
export function notifyRemoteWin(_count: number): void {}

/** S1-4 前 no-op；预留 circularRef 计数通知 */
export function notifyCircularRef(_count: number): void {}
