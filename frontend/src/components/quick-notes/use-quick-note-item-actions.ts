'use client'

import { useCallback, useMemo, useState } from 'react'
import { toast } from 'sonner'
import type { QuickNote } from '@/types'

type QuickNotePendingAction = 'delete' | 'pin' | 'restore' | 'purge'

interface UseQuickNoteItemActionsOptions {
  quickNotes: QuickNote[]
  editingId: string | null
  cancelEdit: () => void
  deleteQuickNote: (id: string) => Promise<void>
  restoreQuickNote: (id: string) => Promise<void>
  purgeQuickNote: (id: string) => Promise<void>
  togglePin: (id: string) => Promise<void>
  describeQuickNoteError: (error: unknown, fallback: string) => string
}

export function useQuickNoteItemActions({
  quickNotes,
  editingId,
  cancelEdit,
  deleteQuickNote,
  restoreQuickNote,
  purgeQuickNote,
  togglePin,
  describeQuickNoteError,
}: UseQuickNoteItemActionsOptions) {
  const [pendingById, setPendingById] = useState<Record<string, QuickNotePendingAction>>({})

  const restoreFromTrash = useCallback(
    async (id: string, opts: { silent?: boolean } = {}) => {
      if (pendingById[id]) return
      try {
        setPendingById((current) => ({ ...current, [id]: 'restore' }))
        await restoreQuickNote(id)
        if (!opts.silent) toast('小记已恢复')
      } catch (error) {
        toast.error('小记恢复失败', {
          description: describeQuickNoteError(error, '请稍后重试'),
        })
      } finally {
        setPendingById((current) => clearPending(current, id))
      }
    },
    [describeQuickNoteError, pendingById, restoreQuickNote],
  )

  const moveToTrashWithUndo = useCallback(
    async (id: string) => {
      if (pendingById[id]) return
      const note = quickNotes.find((item) => item.id === id)
      try {
        setPendingById((current) => ({ ...current, [id]: 'delete' }))
        await deleteQuickNote(id)
        if (editingId === id) cancelEdit()
        toast('小记已移到回收站', {
          description: note?.content.split(/\r?\n/).find(Boolean)?.slice(0, 40),
          action: {
            label: '撤销',
            onClick: () => void restoreFromTrash(id, { silent: true }),
          },
        })
      } catch (error) {
        toast.error('小记删除失败', {
          description: describeQuickNoteError(error, '请稍后重试'),
        })
      } finally {
        setPendingById((current) => clearPending(current, id))
      }
    },
    [
      cancelEdit,
      deleteQuickNote,
      describeQuickNoteError,
      editingId,
      pendingById,
      quickNotes,
      restoreFromTrash,
    ],
  )

  const purgeFromTrash = useCallback(
    async (id: string): Promise<boolean> => {
      if (pendingById[id]) return false
      try {
        setPendingById((current) => ({ ...current, [id]: 'purge' }))
        await purgeQuickNote(id)
        if (editingId === id) cancelEdit()
        toast('小记已彻底删除')
        return true
      } catch (error) {
        toast.error('小记彻底删除失败', {
          description: describeQuickNoteError(error, '请稍后重试'),
        })
        return false
      } finally {
        setPendingById((current) => clearPending(current, id))
      }
    },
    [cancelEdit, describeQuickNoteError, editingId, pendingById, purgeQuickNote],
  )

  const togglePinWithPending = useCallback(
    async (id: string) => {
      if (pendingById[id]) return
      try {
        setPendingById((current) => ({ ...current, [id]: 'pin' }))
        await togglePin(id)
      } catch (error) {
        toast.error('小记置顶更新失败', {
          description: describeQuickNoteError(error, '请稍后重试'),
        })
      } finally {
        setPendingById((current) => clearPending(current, id))
      }
    },
    [describeQuickNoteError, pendingById, togglePin],
  )

  const timelinePendingById = useMemo(() => filterTimelinePending(pendingById), [pendingById])
  const trashPendingById = useMemo(() => filterTrashPending(pendingById), [pendingById])

  return {
    moveToTrashWithUndo,
    purgeFromTrash,
    restoreFromTrash,
    timelinePendingById,
    togglePinWithPending,
    trashPendingById,
  }
}

function clearPending<T extends Record<string, unknown>>(pending: T, id: string): T {
  const next = { ...pending }
  delete next[id]
  return next
}

function filterTimelinePending(
  pending: Record<string, QuickNotePendingAction>,
): Record<string, 'delete' | 'pin'> {
  return Object.fromEntries(
    Object.entries(pending).filter((entry): entry is [string, 'delete' | 'pin'] =>
      entry[1] === 'delete' || entry[1] === 'pin',
    ),
  )
}

function filterTrashPending(
  pending: Record<string, QuickNotePendingAction>,
): Record<string, 'restore' | 'purge'> {
  return Object.fromEntries(
    Object.entries(pending).filter((entry): entry is [string, 'restore' | 'purge'] =>
      entry[1] === 'restore' || entry[1] === 'purge',
    ),
  )
}
