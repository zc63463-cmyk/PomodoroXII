'use client'

/**
 * Sync status bar (F0 §5.4 / S1-4 增强 / S1-4.1 UX).
 *
 * 状态映射（DR-8 文案对齐）：
 * - idle: CheckIcon (green) + lastSyncedAt (HH:mm 本地时间)
 * - syncing: Loader2Icon + "同步中" + pendingCount（disabled 不可点）
 * - conflict: AlertCircleIcon (amber) + "冲突待处理"
 * - error: AlertCircleIcon (red) + error 文案
 * - infra-error: CloudOffIcon (red) + "网络异常，同步暂停"
 *
 * S1-4.1：点击触发 sync()（非 syncing 时可点）+ 本地时间格式化。
 *
 * Note: 使用 createElement 替代 JSX（vitest 无 transform）。
 */

import { createElement } from 'react'
import { useSync } from '@/hooks/use-sync'
import {
  CheckIcon,
  CloudOffIcon,
  AlertCircleIcon,
  Loader2Icon,
} from 'lucide-react'

function formatTime(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  // S1-4.1：本地时间（S14-6）
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${hh}:${mm}`
}

export function SyncStatusBar() {
  const { status, lastSyncedAt, pendingCount, error, sync } = useSync()

  let icon: React.ReactNode
  let text: string

  switch (status) {
    case 'syncing':
      icon = createElement(Loader2Icon, { className: 'size-3 animate-spin' })
      text = `同步中${pendingCount > 0 ? ` (${pendingCount})` : ''}`
      break
    case 'conflict':
      icon = createElement(AlertCircleIcon, { className: 'size-3 text-amber-500' })
      text = '冲突待处理'
      break
    case 'error':
      icon = createElement(AlertCircleIcon, { className: 'size-3 text-red-500' })
      text = error ?? '同步出错'
      break
    case 'infra-error':
      icon = createElement(CloudOffIcon, { className: 'size-3 text-red-500' })
      text = '网络异常，同步暂停'
      break
    case 'idle':
    default:
      icon = createElement(CheckIcon, { className: 'size-3 text-green-500' })
      text = lastSyncedAt ? `已同步 ${formatTime(lastSyncedAt)}` : 'Sync'
      break
  }

  // S1-4.1：syncing 时 disabled，其他状态可点击触发 sync
  const isClickable = status !== 'syncing'
  const className = isClickable
    ? 'flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer hover:text-foreground'
    : 'flex items-center gap-1.5 text-xs text-muted-foreground pointer-events-none opacity-60'

  return createElement(
    'span',
    {
      role: 'button',
      tabIndex: 0,
      onClick: isClickable ? sync : undefined,
      title: '点击立即同步',
      className,
    },
    icon,
    createElement('span', null, text),
  )
}
