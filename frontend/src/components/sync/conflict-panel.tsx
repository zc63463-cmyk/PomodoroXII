'use client'

/**
 * ConflictPanel (S1-4).
 *
 * 显示同步冲突列表，提供"接受远端"/"保留本地"按钮。
 * S1-Hard-3: outboxId=-1 (pre-push dirty) 按钮必须可点。
 *
 * Note: 使用 createElement 替代 JSX，因 vitest 无 JSX transform。
 */

import { createElement } from 'react'
import { useSync } from '@/hooks/use-sync'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import type { SyncConflict } from '@/lib/sync/types'

export function ConflictPanel() {
  const { status, conflicts, resolveConflict } = useSync()
  const open = status === 'conflict' && conflicts.length > 0

  return createElement(
    Dialog,
    { open },
    createElement(
      DialogContent,
      null,
      createElement(
        DialogHeader,
        null,
        createElement(DialogTitle, null, '同步冲突'),
        createElement(
          DialogDescription,
          null,
          '以下条目本地与远端版本不一致，请选择保留方向。',
        ),
      ),
      createElement(
        'ul',
        { className: 'space-y-3' },
        conflicts.map((c: SyncConflict, i: number) =>
          createElement(
            'li',
            {
              key: `${c.outboxId}-${c.entityType}-${c.entityId}-${i}`,
              className:
                'flex items-center justify-between rounded border p-2 text-sm',
            },
            createElement(
              'span',
              null,
              `${c.entityType} / ${c.entityId} (${c.conflictType})`,
            ),
            createElement(
              'span',
              { className: 'flex gap-2' },
              createElement(
                Button,
                {
                  size: 'sm',
                  variant: 'default',
                  onClick: () => resolveConflict(c.outboxId, 'accept-remote'),
                },
                '接受远端',
              ),
              createElement(
                Button,
                {
                  size: 'sm',
                  variant: 'outline',
                  onClick: () => resolveConflict(c.outboxId, 'keep-local'),
                },
                '保留本地',
              ),
            ),
          ),
        ),
      ),
    ),
  )
}
