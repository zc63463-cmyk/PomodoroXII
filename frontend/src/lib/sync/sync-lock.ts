/**
 * Sync 互斥锁（F1 §7.3a Web Lock 主路径 + §7.3b localStorage/BroadcastChannel fallback）。
 *
 * - 主路径：navigator.locks.request('pxii-sync-' + spaceId, fn) — Web Lock API 自动跨 Tab 排队
 * - Fallback：localStorage flag + TTL 60s + BroadcastChannel 通知（Safari 旧版等无 Web Lock）
 * - 锁被占用 → 调 onSkip?.() 后 return（不抛错），由调用方决定重试策略
 */

const MUTEX_CHANNEL = 'pxii-sync-mutex'
const MUTEX_TTL_MS = 60_000

/**
 * 获取 sync 锁并执行 fn；锁被占用时调 onSkip。
 * 主路径用 Web Lock API（若可用），否则走 withFallbackLock。
 */
export async function withSyncLock(
  spaceId: string,
  fn: () => Promise<void>,
  onSkip?: () => void,
): Promise<void> {
  if (typeof navigator !== 'undefined' && 'locks' in navigator) {
    await navigator.locks.request('pxii-sync-' + spaceId, async () => {
      await fn()
    })
    return
  }
  await withFallbackLock(spaceId, fn, onSkip)
}

/**
 * Fallback 锁：localStorage flag + TTL + BroadcastChannel。
 * - flag 存在且未过期（< TTL）→ onSkip?.() + return
 * - flag 过期或不存在 → 获取锁，执行 fn，finally 释放
 */
export async function withFallbackLock(
  spaceId: string,
  fn: () => Promise<void>,
  onSkip?: () => void,
): Promise<void> {
  const flagKey = `pxii_sync_lock_${spaceId}`
  const existing = localStorage.getItem(flagKey)
  if (existing) {
    const age = Date.now() - parseInt(existing, 10)
    if (age < MUTEX_TTL_MS) {
      onSkip?.()
      return
    }
    // TTL 过期 → 强制获取
  }

  // 获取锁
  localStorage.setItem(flagKey, String(Date.now()))
  const channel = new BroadcastChannel(MUTEX_CHANNEL)
  channel.postMessage({ type: 'sync-started', spaceId })

  try {
    await fn()
  } finally {
    localStorage.removeItem(flagKey)
    channel.postMessage({ type: 'sync-ended', spaceId })
    channel.close()
  }
}
