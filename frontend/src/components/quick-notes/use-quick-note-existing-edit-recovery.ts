'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { QuickNoteDraftConflict } from '@/components/quick-notes/quick-note-conflict-panel'
import type { QuickNote } from '@/types'
import { createDexieQuickNoteExistingEditRecoveryAdapter, type QuickNoteExistingEditRecoveryAdapter } from '@/lib/quick-notes/quick-note-existing-edit-recovery'
import { spaceDBManager } from '@/services/space-db'
import { commitQuickNoteExistingEdit } from '@/lib/quick-notes/quick-note-repository'
import type { PomodoroXIDB } from '@/services/database'

export type QuickNoteExistingEditSaveState = 'saved' | 'unsaved' | 'saving' | 'failed'

export interface QuickNoteExistingEditSession {
  draft: string
  editingId: string | null
  editingNote: QuickNote | null
  conflict: QuickNoteDraftConflict | null
  saveState: QuickNoteExistingEditSaveState
  isTyping: boolean
  start(note: QuickNote): Promise<void>
  change(value: string): void
  save(options?: { closeAfterSave?: boolean }): Promise<boolean>
  cancel(): Promise<'cancelled' | 'preserved'>
  keepLocal(): Promise<boolean>
  useRemote(): Promise<void>
  mergeRemote(): Promise<void>
}

export function useQuickNoteExistingEditRecovery(): QuickNoteExistingEditSession {
  const [draft, setDraft] = useState('')
  const [editingNote, setEditingNote] = useState<QuickNote | null>(null)
  const [conflict, setConflict] = useState<QuickNoteDraftConflict | null>(null)
  const [saveState, setSaveState] = useState<QuickNoteExistingEditSaveState>('saved')
  const adapterRef = useRef<QuickNoteExistingEditRecoveryAdapter | null>(null)
  const spaceIdRef = useRef<string | null>(null)
  const editIdRef = useRef('')
  const revisionRef = useRef(0)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const draftRef = useRef('')
  const noteRef = useRef<QuickNote | null>(null)
  const databaseRef = useRef<PomodoroXIDB | null>(null)
  const checkpoint = useCallback(async () => {
    const current = noteRef.current
    const adapter = adapterRef.current
    if (!current || !adapter || !spaceIdRef.current) return
    await adapter.save({ version: 1, editId: editIdRef.current, revision: revisionRef.current, spaceId: spaceIdRef.current, noteId: current.id, baseContent: current.content, baseUpdatedAt: current.updated_at, draft: draftRef.current, checkpointedAt: new Date().toISOString() })
  }, [])
  const start = useCallback(async (note: QuickNote) => {
    const spaceId = spaceDBManager.currentSpaceId
    if (!spaceId) throw new Error('QuickNote existing edit requires an active Space')
    const database = spaceDBManager.current
    const adapter = createDexieQuickNoteExistingEditRecoveryAdapter(database, spaceId)
    databaseRef.current = database
    adapterRef.current = adapter; spaceIdRef.current = spaceId; editIdRef.current = crypto.randomUUID(); revisionRef.current = 0; noteRef.current = note
    const loaded = await adapter.load(note.id)
    const restored = loaded.kind === 'valid' && loaded.snapshot.baseUpdatedAt === note.updated_at ? loaded.snapshot : null
    const value = restored?.draft ?? note.content
    if (restored) { editIdRef.current = restored.editId; revisionRef.current = restored.revision }
    draftRef.current = value; setEditingNote(note); setDraft(value); setConflict(null); setSaveState(restored ? 'unsaved' : 'saved')
  }, [])
  const change = useCallback((value: string) => { draftRef.current = value; revisionRef.current += 1; setDraft(value); setSaveState('unsaved'); if (timerRef.current) clearTimeout(timerRef.current); timerRef.current = setTimeout(() => { void checkpoint() }, 500) }, [checkpoint])
  const cancel = useCallback(async () => { if (timerRef.current) clearTimeout(timerRef.current); const note = noteRef.current; const adapter = adapterRef.current; if (note && adapter) await adapter.clearIfOwned(note.id, editIdRef.current, revisionRef.current); noteRef.current = null; setEditingNote(null); setDraft(''); setConflict(null); setSaveState('saved'); return 'cancelled' as const }, [])
  useEffect(() => {
    const unsubscribe = spaceDBManager.onSwitch(() => {
      if (timerRef.current) clearTimeout(timerRef.current)
      noteRef.current = null
      adapterRef.current = null
      spaceIdRef.current = null
      databaseRef.current = null
      setEditingNote(null)
      setDraft('')
      setConflict(null)
      setSaveState('saved')
    })
    return () => { if (timerRef.current) clearTimeout(timerRef.current); unsubscribe() }
  }, [])
  const save = useCallback(async ({ closeAfterSave = false }: { closeAfterSave?: boolean } = {}) => {
    const note = noteRef.current
    const adapter = adapterRef.current
    const spaceId = spaceIdRef.current
    const database = databaseRef.current
    if (!note || !adapter || !spaceId || !database || spaceDBManager.currentSpaceId !== spaceId) return false
    if (!draftRef.current.trim()) { setSaveState('unsaved'); return false }
    if (timerRef.current) clearTimeout(timerRef.current)
    await checkpoint()
    setSaveState('saving')
    const result = await commitQuickNoteExistingEdit(database, { id: note.id, expectedUpdatedAt: note.updated_at, content: draftRef.current })
    if (result.kind === 'conflict') { setConflict({ note: result.note, localDraft: draftRef.current, remoteContent: result.note.content }); setSaveState('unsaved'); return false }
    if (result.kind !== 'saved') { setSaveState('failed'); return false }
    noteRef.current = result.note; setEditingNote(result.note); await adapter.clearIfOwned(note.id, editIdRef.current, revisionRef.current); setSaveState('saved')
    if (closeAfterSave) await cancel()
    return true
  }, [cancel, checkpoint])
  return { draft, editingId: editingNote?.id ?? null, editingNote, conflict, saveState, isTyping: false, start, change,
    save, cancel, keepLocal: async () => save(),
    useRemote: async () => {
      if (!conflict) return
      noteRef.current = conflict.note
      draftRef.current = conflict.remoteContent
      revisionRef.current += 1
      setEditingNote(conflict.note)
      setDraft(conflict.remoteContent)
      setConflict(null)
      setSaveState('saved')
    },
    mergeRemote: async () => {
      if (!conflict) return
      const merged = `${conflict.localDraft.trimEnd()}\n\n--- 远端版本 ---\n${conflict.remoteContent.trim()}`
      noteRef.current = conflict.note
      draftRef.current = merged
      revisionRef.current += 1
      setEditingNote(conflict.note)
      setDraft(merged)
      setConflict(null)
      setSaveState('unsaved')
    } }
}
