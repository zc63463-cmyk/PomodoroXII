import { describe, it, expect, afterEach, vi } from 'vitest'
import { withSyncLock, withFallbackLock } from './sync-lock'

/**
 * sync-lock.ts 单测（SL1–SL4）。
 *
 * 验证 F1 §7.3a Web Lock 主路径 + §7.3b localStorage/BroadcastChannel fallback。
 * - SL1：navigator.locks 可用 → fn 执行
 * - SL2：fallback + flag 未过期（<60s）→ onSkip 调用，fn 不执行
 * - SL3：fallback + flag 过期（>60s）→ 强制获锁，fn 执行
 * - SL4：fallback + fn 完成 → flag 删除 + BroadcastChannel 'sync-ended'
 */

const SPACE_ID = 'space-test'
const FLAG_KEY = `pxii_sync_lock_${SPACE_ID}`

describe('sync-lock', () => {
  afterEach(() => {
    // 清理 navigator.locks mock（若 SL1 注入）
    delete (navigator as unknown as { locks?: unknown }).locks
    localStorage.clear()
    vi.restoreAllMocks()
  })

  it('SL1: Web Lock 可用 → fn 执行一次', async () => {
    const fn = vi.fn(async () => {})
    // 注入 navigator.locks mock：立即执行 callback
    Object.defineProperty(navigator, 'locks', {
      value: {
        request: vi.fn(async (_name: string, cb: () => Promise<void>) => {
          await cb()
        }),
      },
      configurable: true,
    })

    await withSyncLock(SPACE_ID, fn)

    expect(fn).toHaveBeenCalledTimes(1)
    expect(navigator.locks.request).toHaveBeenCalledWith(
      'pxii-sync-' + SPACE_ID,
      expect.any(Function),
    )
  })

  it('SL2: fallback + flag 未过期 → onSkip 调用，fn 不执行', async () => {
    const fn = vi.fn(async () => {})
    const onSkip = vi.fn()
    // flag 30s 前设置（< 60s TTL）
    localStorage.setItem(FLAG_KEY, String(Date.now() - 30_000))

    await withSyncLock(SPACE_ID, fn, onSkip)

    expect(fn).not.toHaveBeenCalled()
    expect(onSkip).toHaveBeenCalledTimes(1)
  })

  it('SL3: fallback + flag 过期 → 强制获锁，fn 执行', async () => {
    let flagDuringFn: string | null = null
    const fn = vi.fn(async () => {
      // fn 执行期间 flag 应已被设为新时间戳
      flagDuringFn = localStorage.getItem(FLAG_KEY)
    })
    // flag 90s 前设置（> 60s TTL）
    localStorage.setItem(FLAG_KEY, String(Date.now() - 90_000))

    await withSyncLock(SPACE_ID, fn)

    expect(fn).toHaveBeenCalledTimes(1)
    // fn 执行期间 flag 存在且为新时间戳（> 旧值）
    expect(flagDuringFn).not.toBeNull()
    expect(Number(flagDuringFn)).toBeGreaterThan(Date.now() - 90_000)
    // fn 完成后 flag 被 finally 释放
    expect(localStorage.getItem(FLAG_KEY)).toBeNull()
  })

  it('SL4: fallback + fn 完成 → flag 删除 + BroadcastChannel sync-ended', async () => {
    const fn = vi.fn(async () => {})
    const posted: Array<{ type: string; spaceId: string }> = []
    // 拦截 BroadcastChannel.postMessage
    const origBC = globalThis.BroadcastChannel
    class MockBC {
      postMessage(msg: { type: string; spaceId: string }) {
        posted.push(msg)
      }
      close() {}
      onmessage: unknown = null
    }
    globalThis.BroadcastChannel = MockBC as unknown as typeof BroadcastChannel

    await withFallbackLock(SPACE_ID, fn)

    // fn 执行后 flag 被删除
    expect(localStorage.getItem(FLAG_KEY)).toBeNull()
    // 收到 sync-started 与 sync-ended 两条广播
    expect(posted).toEqual([
      { type: 'sync-started', spaceId: SPACE_ID },
      { type: 'sync-ended', spaceId: SPACE_ID },
    ])
    expect(fn).toHaveBeenCalledTimes(1)

    globalThis.BroadcastChannel = origBC
  })
})
