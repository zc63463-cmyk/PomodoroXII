'use client'

import { createElement, useEffect, useState, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import type { CachedWorkItem } from '@/types'

/**
 * Structured resolution panel for the backend ``active_child_conflict``
 * rejection (v1.2 §9.2).
 *
 * Completing a level-2 item is refused while any level-3 child is still
 * active.  Surfacing a one-line toast would leave the user stuck, so the
 * dialog lists the blocking children and offers four explicit exits:
 *
 * 1. cancel every active child, then complete the parent;
 * 2. relocate every active child under another live level-2 item, then
 *    complete the parent;
 * 3. give up on completing and leave the parent in progress;
 * 4. dismiss without touching anything.
 */
export interface ActiveChildConflictDialogProps {
  open: boolean
  parentItem: CachedWorkItem
  conflictChildIds: string[]
  availableLevel2Parents: CachedWorkItem[]
  /** Optional resolved rows; when absent the raw ids are listed instead. */
  conflictChildren?: CachedWorkItem[]
  onClose: () => void
  onCancelChildrenAndComplete: () => Promise<void>
  onMoveChildrenAndComplete: (targetParentId: string) => Promise<void>
  /** Explicit "stay in progress".  Defaults to ``onClose``. */
  onKeepActive?: () => void
  /** Set while one of the two mutating resolutions is in flight. */
  busy?: boolean
  /**
   * ★ 2026-09-11：空间可以合法地不含 cancelled / completed 类目状态
   * （status_definitions 是空间自定义的，缺类目不是异常数据）。
   * 非空时对应按钮禁用，并在弹窗内展示这条中文原因 —— 绝不静默空转：
   * 旧实现只在页面 handler 里 `if (!statusId) return`，点了没反应。
   */
  cancelChildrenUnavailableReason?: string | null
  moveChildrenUnavailableReason?: string | null
}

const titleOf = (item: CachedWorkItem | undefined, id: string): string => (
  item ? `${item.displayKey} ${item.title}`.trim() : id
)

export function ActiveChildConflictDialog({
  open,
  parentItem,
  conflictChildIds,
  availableLevel2Parents,
  conflictChildren = [],
  onClose,
  onCancelChildrenAndComplete,
  onMoveChildrenAndComplete,
  onKeepActive,
  busy = false,
  cancelChildrenUnavailableReason = null,
  moveChildrenUnavailableReason = null,
}: ActiveChildConflictDialogProps): ReactNode {
  const [targetParentId, setTargetParentId] = useState('')

  // Reopening must never carry the previous destination over.
  useEffect(() => {
    if (open) setTargetParentId(availableLevel2Parents[0]?.id ?? '')
  }, [open, availableLevel2Parents])

  if (!open) return null

  const byId = new Map(conflictChildren.map((child) => [child.id, child]))
  const canMove = availableLevel2Parents.length > 0 && targetParentId !== ''
  // ★ 2026-09-11：去重后的不可用原因条 —— 同一条原因只列一次。
  const unavailableReasons = Array.from(new Set(
    [cancelChildrenUnavailableReason, moveChildrenUnavailableReason]
      .filter((reason): reason is string => typeof reason === 'string' && reason.length > 0),
  ))

  const run = async (action: () => Promise<void>) => {
    try {
      await action()
    } catch {
      // The store already surfaced a stable, closed message; keep the dialog
      // open so the user can pick a different resolution.
    }
  }

  return createElement(
    'div',
    {
      role: 'dialog',
      'aria-modal': true,
      'aria-labelledby': 'active-child-conflict-title',
      'data-active-child-conflict': true,
      className: 'fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4',
    },
    createElement(
      'div',
      { className: 'grid w-full max-w-lg gap-4 rounded-lg border bg-background p-5 shadow-lg' },
      createElement(
        'div',
        { className: 'grid gap-1' },
        createElement(
          'h2',
          { id: 'active-child-conflict-title', className: 'text-base font-semibold' },
          `无法完成「${titleOf(parentItem, parentItem.id)}」`,
        ),
        createElement(
          'p',
          { className: 'text-sm text-muted-foreground' },
          '该二级工作项下仍有未完成的三级工作项，请选择处理方式。',
        ),
      ),
      createElement(
        'ul',
        { className: 'grid max-h-48 gap-1 overflow-auto rounded-md border p-2 text-sm', 'data-conflict-children': true },
        conflictChildIds.length === 0
          ? createElement('li', { className: 'text-muted-foreground' }, '存在未完成的三级工作项')
          : conflictChildIds.map((id) => createElement(
              'li',
              { key: id, className: 'truncate' },
              titleOf(byId.get(id), id),
            )),
      ),
      unavailableReasons.length === 0
        ? null
        : createElement(
            'ul',
            {
              role: 'status',
              'data-resolution-unavailable': true,
              className: 'grid gap-1 rounded-md border border-dashed p-2 text-xs text-muted-foreground',
            },
            unavailableReasons.map((reason) => createElement('li', { key: reason }, reason)),
          ),
      createElement(
        'div',
        { className: 'grid gap-2' },
        createElement(
          Button,
          {
            type: 'button',
            disabled: busy || Boolean(cancelChildrenUnavailableReason),
            ...({ 'data-resolution': 'cancel-children' } as unknown as Record<string, never>),
            onClick: () => void run(onCancelChildrenAndComplete),
          },
          '取消未完成三级并完成',
        ),
        createElement(
          'div',
          { className: 'grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2' },
          createElement(
            'select',
            {
              'aria-label': '迁移目标二级工作项',
              className: 'h-9 w-full rounded-md border bg-background px-2 text-sm outline-none',
              value: targetParentId,
              disabled: busy || availableLevel2Parents.length === 0,
              onChange: (event: React.ChangeEvent<HTMLSelectElement>) => setTargetParentId(event.target.value),
            },
            availableLevel2Parents.length === 0
              ? createElement('option', { value: '' }, '无可迁移的二级工作项')
              : availableLevel2Parents.map((parent) => createElement(
                  'option',
                  { key: parent.id, value: parent.id },
                  titleOf(parent, parent.id),
                )),
          ),
          createElement(
            Button,
            {
              type: 'button',
              variant: 'outline',
              disabled: busy || !canMove || Boolean(moveChildrenUnavailableReason),
              ...({ 'data-resolution': 'move-children' } as unknown as Record<string, never>),
              onClick: () => void run(() => onMoveChildrenAndComplete(targetParentId)),
            },
            '迁移并完成',
          ),
        ),
      ),
      createElement(
        'div',
        { className: 'flex justify-end gap-2' },
        createElement(
          Button,
          {
            type: 'button',
            variant: 'ghost',
            disabled: busy,
            ...({ 'data-resolution': 'keep-active' } as unknown as Record<string, never>),
            onClick: () => (onKeepActive ?? onClose)(),
          },
          '放弃完成，保持进行中',
        ),
        createElement(
          Button,
          {
            type: 'button',
            variant: 'ghost',
            disabled: busy,
            ...({ 'data-resolution': 'dismiss' } as unknown as Record<string, never>),
            onClick: () => onClose(),
          },
          '返回',
        ),
      ),
    ),
  )
}
