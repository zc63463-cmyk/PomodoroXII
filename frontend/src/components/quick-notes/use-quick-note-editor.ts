'use client'

import { FormEvent, useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import type { QuickNoteSaveState } from '@/components/quick-notes/quick-note-composer'
import type { QuickNoteDraftConflict } from '@/components/quick-notes/quick-note-conflict-panel'
import type { QuickNote } from '@/types'
import type {
  QuickNoteCreateInput,
  QuickNoteLifecycleState,
  QuickNoteUpdateInput,
} from '@/lib/quick-notes/quick-note-repository'

interface UseQuickNoteEditorOptions {
  quickNotes: QuickNote[]
  trashedQuickNotes: QuickNote[]
  createQuickNote: (data: QuickNoteCreateInput) => Promise<QuickNote>
  updateQuickNote: (id: string, data: QuickNoteUpdateInput) => Promise<void>
  describeQuickNoteError: (error: unknown, fallback: string) => string
  lifecycleStateById?: Record<string, QuickNoteLifecycleState>
}

export function useQuickNoteEditor({
  quickNotes,
  trashedQuickNotes,
  createQuickNote,
  updateQuickNote,
  describeQuickNoteError,
  lifecycleStateById = {},
}: UseQuickNoteEditorOptions) {
  const [draft, setDraft] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingNoteSnapshot, setEditingNoteSnapshot] = useState<QuickNote | null>(null)
  const [editingBaseContent, setEditingBaseContent] = useState('')
  const [draftConflict, setDraftConflict] = useState<QuickNoteDraftConflict | null>(null)
  const [saveState, setSaveState] = useState<QuickNoteSaveState>('saved')
  const autosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const latestDraftRef = useRef(draft)
  const saveSequenceRef = useRef(0)
  const saveQueueRef = useRef<Promise<unknown>>(Promise.resolve())
  const remoteUpdateToastRef = useRef<string | null>(null)

  const editingNote =
    (editingNoteSnapshot?.id === editingId ? editingNoteSnapshot : null) ??
    quickNotes.find((note) => note.id === editingId) ??
    null

  const cancelEdit = useCallback(() => {
    if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current)
    saveSequenceRef.current += 1
    setEditingId(null)
    setEditingNoteSnapshot(null)
    setEditingBaseContent('')
    setDraftConflict(null)
    setDraft('')
    setSaveState('saved')
  }, [])

  useEffect(() => {
    latestDraftRef.current = draft
  }, [draft])

  useEffect(() => {
    if (!editingId) return
    const refreshedNote = quickNotes.find((note) => note.id === editingId)
    if (!refreshedNote) return

    if (
      editingNoteSnapshot?.id === editingId &&
      refreshedNote.updated_at < editingNoteSnapshot.updated_at
    ) {
      return
    }

    const draftHasLocalChanges = latestDraftRef.current.trim() !== editingBaseContent.trim()
    const remoteChanged =
      editingNoteSnapshot?.id === editingId &&
      (refreshedNote.content !== editingNoteSnapshot.content ||
        refreshedNote.updated_at !== editingNoteSnapshot.updated_at)

    if (remoteChanged && draftHasLocalChanges) {
      if (remoteUpdateToastRef.current !== refreshedNote.updated_at) {
        remoteUpdateToastRef.current = refreshedNote.updated_at
        toast('有远端更新，已保留你的本地草稿')
      }
      setDraftConflict({
        note: refreshedNote,
        localDraft: latestDraftRef.current,
        remoteContent: refreshedNote.content,
      })
      setSaveState('unsaved')
      return
    }

    const shouldAdoptRemoteDraft = latestDraftRef.current.trim() === editingBaseContent.trim()
    setEditingNoteSnapshot(refreshedNote)
    setEditingBaseContent(refreshedNote.content)
    setDraftConflict(null)
    remoteUpdateToastRef.current = null
    if (shouldAdoptRemoteDraft) {
      setDraft(refreshedNote.content)
    }
  }, [editingBaseContent, editingId, editingNoteSnapshot, quickNotes])

  useEffect(() => {
    if (!editingId) return
    const stillActive = quickNotes.some((note) => note.id === editingId)
    const movedToTrash = trashedQuickNotes.some((note) => note.id === editingId)
    const lifecycleState = lifecycleStateById[editingId]
    if (lifecycleState === 'converted') {
      cancelEdit()
      toast('当前小记已迁移为笔记')
      return
    }
    if (lifecycleState === 'archived') {
      cancelEdit()
      toast('当前小记已归档')
      return
    }
    if (!movedToTrash && lifecycleState !== 'sync-deleted') return
    if (stillActive) return

    cancelEdit()
    toast('当前小记已在同步中移除/移入回收站')
  }, [cancelEdit, editingId, lifecycleStateById, quickNotes, trashedQuickNotes])

  const saveEditedDraft = useCallback(
    async ({ closeAfterSave }: { closeAfterSave: boolean }) => {
      if (!editingNote) return false
      const content = latestDraftRef.current.trim()
      if (!content) {
        setSaveState('unsaved')
        toast.error('小记内容不能为空')
        return false
      }

      if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current)
      const saveSequence = saveSequenceRef.current + 1
      saveSequenceRef.current = saveSequence
      setSaveState('saving')

      const queuedSave = saveQueueRef.current
        .then(async () => {
          if (saveSequenceRef.current !== saveSequence) return false
          if (latestDraftRef.current.trim() !== content) {
            setSaveState('unsaved')
            return false
          }

          await updateQuickNote(editingNote.id, { content })
          if (saveSequenceRef.current !== saveSequence) return false
          if (latestDraftRef.current.trim() !== content) {
            setSaveState('unsaved')
            return false
          }

          setEditingNoteSnapshot({
            ...editingNote,
            content,
            updated_at: new Date().toISOString(),
          })
          setEditingBaseContent(content)
          setDraftConflict(null)
          setSaveState('saved')

          if (closeAfterSave) {
            setEditingId(null)
            setEditingNoteSnapshot(null)
            setEditingBaseContent('')
            setDraft('')
            return true
          }

          return true
        })
        .catch((error: unknown) => {
          if (saveSequenceRef.current === saveSequence) {
            setSaveState('failed')
            toast.error('小记保存失败', {
              description: describeQuickNoteError(error, '请稍后重试'),
            })
          }

          return false
        })

      saveQueueRef.current = queuedSave.then(() => undefined, () => undefined)
      return queuedSave
    },
    [describeQuickNoteError, editingNote, updateQuickNote],
  )

  useEffect(() => {
    if (!editingNote) return
    if (draft.trim() === editingNote.content.trim()) {
      setSaveState('saved')
      return
    }

    setSaveState('unsaved')
    if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current)
    autosaveTimerRef.current = setTimeout(() => {
      void saveEditedDraft({ closeAfterSave: false })
    }, 900)

    return () => {
      if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current)
    }
  }, [draft, editingNote, saveEditedDraft])

  async function submitDraft(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const content = draft.trim()
    if (!content) {
      toast.error(editingNote ? '小记内容不能为空' : '先写点内容再记录')
      return
    }

    if (editingNote) {
      await saveEditedDraft({ closeAfterSave: false })
    } else {
      try {
        await createQuickNote({ content })
        setDraft('')
      } catch (error) {
        toast.error('小记创建失败', {
          description: describeQuickNoteError(error, '请稍后重试'),
        })
      }
    }
  }

  function startEdit(note: QuickNote) {
    if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current)
    saveSequenceRef.current += 1
    setEditingId(note.id)
    setEditingNoteSnapshot(note)
    setEditingBaseContent(note.content)
    setDraftConflict(null)
    remoteUpdateToastRef.current = null
    setDraft(note.content)
    setSaveState('saved')
  }

  function keepLocalDraft() {
    setDraftConflict(null)
    setSaveState('unsaved')
  }

  function useRemoteDraft() {
    if (!draftConflict) return
    setEditingNoteSnapshot(draftConflict.note)
    setEditingBaseContent(draftConflict.remoteContent)
    setDraft(draftConflict.remoteContent)
    setDraftConflict(null)
    setSaveState('saved')
  }

  function mergeRemoteDraft() {
    if (!draftConflict) return
    const merged = [
      draftConflict.localDraft.trimEnd(),
      '',
      '--- 远端版本 ---',
      draftConflict.remoteContent.trim(),
    ].join('\n')
    setEditingNoteSnapshot(draftConflict.note)
    setEditingBaseContent(draftConflict.remoteContent)
    setDraft(merged)
    setDraftConflict(null)
    setSaveState('unsaved')
  }

  return {
    cancelEdit,
    draftConflict,
    draft,
    editingId,
    editingNote,
    keepLocalDraft,
    mergeRemoteDraft,
    saveState,
    setDraft,
    startEdit,
    submitDraft,
    useRemoteDraft,
  }
}
