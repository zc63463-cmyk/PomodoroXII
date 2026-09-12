'use client'

import { createElement } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import type { CachedWorkItem } from '@/types'

interface LaunchSessionButtonProps {
  workItem: CachedWorkItem | null
  /**
   * Derived dependency signal.  When true the click is intercepted and
   * reported through ``onBlocked`` instead of navigating — starting focus on
   * a blocked item is allowed, but only after an explicit acknowledgement.
   */
  blocked?: boolean
  onBlocked?: (workItem: CachedWorkItem) => void
}

/**
 * ★ 2026-09-11：blocked 但调用方漏传 onBlocked 时展示的可读原因。
 * 为什么：此前该组合会落进 onClick 的兜底分支直接 ``router.push('/timer')``，
 * 拦截能力依赖调用方「记得传 onBlocked」，漏传即静默放行 —— 与已修的
 * ack 死链同源（规则靠调用方自觉）。这里改为 fail-closed：宁可禁点并给出
 * 原因，也绝不静默启动被阻塞任务。
 */
const BLOCKED_WITHOUT_HANDLER_REASON = '该任务存在未完成的上游依赖'

/**
 * Entry point that carries the currently selected WorkItem from the Task
 * Space page into the Focus Session launcher on /timer. The selection itself
 * stays in the shared task-space store (selectedWorkItemId), so switching
 * pages does not lose the space context.
 */
export function LaunchSessionButton({
  workItem,
  blocked = false,
  onBlocked,
}: LaunchSessionButtonProps) {
  const router = useRouter()
  const label = workItem
    ? `Start focus session for ${workItem.displayKey} ${workItem.title}`
    : 'Start focus session'
  // ★ 2026-09-11：fail-closed —— blocked 且缺少 onBlocked 时按禁用处理，
  // 并附带中文原因；不能把「拦截」寄托在调用方传参是否齐全上。
  const blockedWithoutHandler = blocked && !onBlocked
  return createElement(Button, {
    type: 'button',
    variant: 'outline',
    size: 'sm',
    disabled: workItem === null || blockedWithoutHandler,
    'aria-label': label,
    ...(blockedWithoutHandler ? { title: BLOCKED_WITHOUT_HANDLER_REASON } : {}),
    onClick: () => {
      if (workItem === null) return
      if (blocked) {
        if (onBlocked) onBlocked(workItem)
        // ★ 2026-09-11：blocked 且无 onBlocked 时绝不静默 push；这是 disabled
        // 之外的第二道保险，防止程序化 dispatchEvent（不受禁用态过滤）或
        // 未来重构误删 disabled 时回归静默放行。
        return
      }
      router.push('/timer')
    },
    // Tasks-page shortcut (`s`) clicks this button programmatically.  The
    // spread bypasses Button's excess-property check for data attributes.
    ...({ 'data-launch-session': 'true' } as unknown as Record<string, never>),
  }, 'Start focus session')
}
