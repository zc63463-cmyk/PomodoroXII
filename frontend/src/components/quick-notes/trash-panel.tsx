'use client'

import { createElement, useState } from 'react'
import { ArchiveRestoreIcon, Trash2Icon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { quickNoteStyles } from '@/components/quick-notes/quick-note-styles'
import { getQuickNoteTitle } from '@/lib/quick-notes/quick-note-selectors'
import type { QuickNote } from '@/types'

export function TrashPanel({
  notes,
  onRestore,
  onPurge,
  pendingById = {},
}: {
  notes: QuickNote[]
  onRestore: (id: string) => boolean | void | Promise<boolean | void>
  onPurge: (id: string) => boolean | void | Promise<boolean | void>
  pendingById?: Record<string, 'restore' | 'purge'>
}) {
  const [confirmingPurgeId, setConfirmingPurgeId] = useState<string | null>(null)

  async function confirmPurge(id: string) {
    const result = await onPurge(id)
    if (result === false) return
    setConfirmingPurgeId((current) => (current === id ? null : current))
  }

  return createElement(
    'section',
    { className: quickNoteStyles.panelRelaxed },
    createElement(
      'div',
      { className: 'mb-3 flex items-center justify-between' },
      createElement('h2', { className: quickNoteStyles.panelTitle }, '回收站'),
      createElement('span', { className: quickNoteStyles.metaText }, `${notes.length} 条`),
    ),
    notes.length === 0
      ? createElement('p', { className: quickNoteStyles.metaText }, '回收站是空的。')
      : createElement(
          'div',
          { className: 'grid gap-2' },
          ...notes.map((note) => {
            const isConfirming = confirmingPurgeId === note.id
            const pendingAction = pendingById[note.id]
            const isPending = pendingAction !== undefined

            return createElement(
              'div',
              {
                key: note.id,
                className: quickNoteStyles.trashRow,
              },
              createElement(
                'span',
                { className: quickNoteStyles.trashTitle },
                getQuickNoteTitle(note),
              ),
              createElement(
                'div',
                { className: 'flex shrink-0 items-center gap-1' },
                createElement(
                  Button,
                  {
                    type: 'button',
                    variant: 'ghost',
                    size: 'icon-sm',
                    disabled: isPending,
                    onClick: () => {
                      setConfirmingPurgeId(null)
                      void onRestore(note.id)
                    },
                    'aria-label': '恢复小记',
                    className: quickNoteStyles.ghostButton,
                  },
                  createElement(ArchiveRestoreIcon),
                ),
                isConfirming
                  ? createElement(
                      Button,
                      {
                        type: 'button',
                        variant: 'ghost',
                        size: 'sm',
                        disabled: isPending,
                        onClick: () => setConfirmingPurgeId(null),
                        className: quickNoteStyles.ghostButton,
                      },
                      '取消',
                    )
                  : null,
                createElement(
                  Button,
                  {
                    type: 'button',
                    variant: 'destructive',
                    size: isConfirming ? 'sm' : 'icon-sm',
                    disabled: isPending,
                    onClick: () => {
                      if (!isConfirming) {
                        setConfirmingPurgeId(note.id)
                        return
                      }

                      void confirmPurge(note.id)
                    },
                    'aria-label': isConfirming ? '确认彻底删除小记' : '彻底删除小记',
                  },
                  isConfirming ? '确认彻删' : createElement(Trash2Icon),
                ),
              ),
            )
          }),
        ),
  )
}
