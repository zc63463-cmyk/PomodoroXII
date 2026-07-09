import type { QuickNote } from '@/types'
import type { QuickNoteFocusMode } from '@/stores/quick-note-store'

export function getSelectedQuickNote(
  quickNotes: QuickNote[],
  selectedQuickNoteId: string | null,
): QuickNote | null {
  if (!selectedQuickNoteId) return null
  return quickNotes.find((note) => note.id === selectedQuickNoteId) ?? null
}

export function isFocusEdit(mode: QuickNoteFocusMode): boolean {
  return mode === 'focus-edit'
}

export function isDetailRead(mode: QuickNoteFocusMode): boolean {
  return mode === 'detail-read'
}
