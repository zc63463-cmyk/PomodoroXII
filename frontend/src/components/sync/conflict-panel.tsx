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
        conflicts.map((c: SyncConflict, i: number) => {
          // P1a：同周期 pre-push（编辑冲突）与 post-push（远端已更新）双条目并存并标注差异
          const isPostPush = c.outboxId >= 0
          const remote = c.remoteVersion as Record<string, unknown> | null | undefined
          const preview =
            typeof remote?.content === 'string' && remote.content.length > 0
              ? remote.content
              : typeof remote?.title === 'string' && remote.title.length > 0
                ? remote.title
                : null
          return createElement(
            'li',
            {
              key: `${c.outboxId}-${c.entityType}-${c.entityId}-${i}`,
              className:
                'flex flex-col gap-1 rounded border p-2 text-sm',
            },
            createElement(
              'span',
              { className: 'flex w-full items-center justify-between gap-2' },
              createElement(
                'span',
                null,
                `${isPostPush ? '远端已更新' : '编辑冲突'}：${c.entityType} / ${c.entityId} (${c.conflictType})`,
              ),
              createElement(
                'span',
                { className: 'flex gap-2' },
                createElement(
                  Button,
                  {
                    size: 'sm',
                    variant: 'default',
                    onClick: () => resolveConflict(
                      c.outboxId,
                      'accept-remote',
                      { entityType: c.entityType, entityId: c.entityId },
                    ),
                  },
                  '接受远端',
                ),
                createElement(
                  Button,
                  {
                    size: 'sm',
                    variant: 'outline',
                    onClick: () => resolveConflict(
                      c.outboxId,
                      'keep-local',
                      { entityType: c.entityType, entityId: c.entityId },
                    ),
                  },
                  '保留本地',
                ),
              ),
            ),
            // QN-S8b F4：post-push 且服务端回传快照时，展示远端内容预览
            preview !== null
              ? createElement(
                  'span',
                  { className: 'text-xs opacity-70' },
                  `远端：${preview.slice(0, 48)}`,
                )
              : null,
          )
        }),
      ),
    ),
  )
}
