'use client'

import { FormEvent, useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import type { QuickNoteSaveState } from '@/components/quick-notes/quick-note-composer'
import type { QuickNoteDraftConflict } from '@/components/quick-notes/quick-note-conflict-panel'
import { useQuickNoteDraftSession } from '@/components/quick-notes/use-quick-note-draft-session'
import { useQuickNoteExistingEditRecovery } from '@/components/quick-notes/use-quick-note-existing-edit-recovery'
import type { QuickNote } from '@/types'
import type { QuickNoteLifecycleState } from '@/lib/quick-notes/quick-note-repository'
import { QUICK_NOTE_TYPING_IDLE_MS } from '@/lib/quick-notes/quick-note-editor-status'
import { spaceDBManager } from '@/services/space-db'

interface UseQuickNoteEditorOptions {
  quickNotes: QuickNote[]
  trashedQuickNotes: QuickNote[]
  projectCommittedQuickNote: (note: QuickNote) => undefined
  describeQuickNoteError: (error: unknown, fallback: string) => string
  lifecycleStateById?: Record<string, QuickNoteLifecycleState>
}

export function useQuickNoteEditor({
  quickNotes,
  trashedQuickNotes,
  projectCommittedQuickNote,
  describeQuickNoteError,
  lifecycleStateById = {},
}: UseQuickNoteEditorOptions) {
  const session = useQuickNoteDraftSession({ onRecorded: projectCommittedQuickNote })
  const existingEdit = useQuickNoteExistingEditRecovery({ onCommitted: projectCommittedQuickNote })
  const saveExistingEdit = existingEdit.save
  const [editingDraft, setEditingDraft] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingNoteSnapshot, setEditingNoteSnapshot] = useState<QuickNote | null>(null)
  const [editingBaseContent, setEditingBaseContent] = useState('')
  const [draftConflict, setDraftConflict] = useState<QuickNoteDraftConflict | null>(null)
  const [isTyping, setIsTyping] = useState(false)
  const [saveState, setSaveState] = useState<QuickNoteSaveState>('saved')
  const autosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const draftConflictRef = useRef<QuickNoteDraftConflict | null>(null)
  const latestEditingDraftRef = useRef('')
  const editingIdRef = useRef<string | null>(null)
  const saveSequenceRef = useRef(0)
  const saveQueueRef = useRef<Promise<unknown>>(Promise.resolve())
  const typingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mountedRef = useRef(true)
  const lifecycleEpochRef = useRef(0)
  const draft = editingId === null ? session.draft : editingDraft
  const draftSaveState =
    session.issue?.code === 'projection-failed' && !session.draft.trim()
      ? 'idle'
      : session.saveState
  draftConflictRef.current = draftConflict
  editingIdRef.current = editingId

  const editingNote =
    (editingNoteSnapshot?.id === editingId ? editingNoteSnapshot : null) ??
    quickNotes.find((note) => note.id === editingId) ??
    null

  const invalidateExistingEdit = useCallback(() => {
    if (editingIdRef.current === null) return
    if (autosaveTimerRef.current) {
      clearTimeout(autosaveTimerRef.current)
      autosaveTimerRef.current = null
    }
    if (typingTimerRef.current) {
      clearTimeout(typingTimerRef.current)
      typingTimerRef.current = null
    }
    saveSequenceRef.current += 1
    editingIdRef.current = null
    latestEditingDraftRef.current = ''
    setEditingId(null)
    setEditingNoteSnapshot(null)
    setEditingBaseContent('')
    setEditingDraft('')
    setDraftConflict(null)
    setIsTyping(false)
    setSaveState('saved')
  }, [])

  const cancelEdit = invalidateExistingEdit

  useEffect(() => {
    mountedRef.current = true
    const unsubscribeSwitch = spaceDBManager.onSwitch(() => {
      lifecycleEpochRef.current += 1
      if (typingTimerRef.current) clearTimeout(typingTimerRef.current)
      typingTimerRef.current = null
      setIsTyping(false)
      invalidateExistingEdit()
    })

    return () => {
      mountedRef.current = false
      lifecycleEpochRef.current += 1
      saveSequenceRef.current += 1
      if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current)
      if (typingTimerRef.current) clearTimeout(typingTimerRef.current)
      unsubscribeSwitch()
    }
  }, [invalidateExistingEdit])

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

    const draftHasLocalChanges =
      latestEditingDraftRef.current.trim() !== editingBaseContent.trim()
    const remoteChanged =
      editingNoteSnapshot?.id === editingId &&
      (refreshedNote.content !== editingNoteSnapshot.content ||
        refreshedNote.updated_at !== editingNoteSnapshot.updated_at)

    if (remoteChanged && draftHasLocalChanges) {
      if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current)
      if (typingTimerRef.current) clearTimeout(typingTimerRef.current)
      setIsTyping(false)
      setDraftConflict({
        note: refreshedNote,
        localDraft: latestEditingDraftRef.current,
        remoteContent: refreshedNote.content,
      })
      setSaveState('unsaved')
      return
    }

    const shouldAdoptRemoteDraft =
      latestEditingDraftRef.current.trim() === editingBaseContent.trim()
    setEditingNoteSnapshot(refreshedNote)
    setEditingBaseContent(refreshedNote.content)
    setDraftConflict(null)
    if (shouldAdoptRemoteDraft) {
      latestEditingDraftRef.current = refreshedNote.content
      setEditingDraft(refreshedNote.content)
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
      if (editingIdRef.current !== null) {
        const lifecycleEpoch = lifecycleEpochRef.current
        try {
          const saved = await saveExistingEdit({ closeAfterSave })
          if (!mountedRef.current || lifecycleEpochRef.current !== lifecycleEpoch) return false
          if (!saved) {
            setSaveState('failed')
            toast.error('小记保存失败', {
              description: '请稍后重试',
            })
          }
          return saved
        } catch (error) {
          if (mountedRef.current && lifecycleEpochRef.current === lifecycleEpoch) {
            setSaveState('failed')
            toast.error('小记保存失败', {
              description: describeQuickNoteError(error, '请稍后重试'),
            })
          }
          return false
        }
      }
      if (!editingNote) return false
      const content = latestEditingDraftRef.current.trim()
      if (!content) {
        setSaveState('unsaved')
        setIsTyping(false)
        toast.error('小记内容不能为空')
        return false
      }

      if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current)
      if (typingTimerRef.current) clearTimeout(typingTimerRef.current)
      const saveSequence = saveSequenceRef.current + 1
      saveSequenceRef.current = saveSequence
      setIsTyping(false)
      setSaveState('saving')

      const queuedSave = saveQueueRef.current
        .then(async () => {
          if (!mountedRef.current || saveSequenceRef.current !== saveSequence) return false
          if (latestEditingDraftRef.current.trim() !== content) {
            setSaveState('unsaved')
            return false
          }

          const saved = await saveExistingEdit({ closeAfterSave })
          if (!saved) {
            throw new Error('QuickNote existing edit was not committed')
          }
          if (!mountedRef.current || saveSequenceRef.current !== saveSequence) return false
          if (latestEditingDraftRef.current.trim() !== content) {
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
            invalidateExistingEdit()
          }

          return true
        })
        .catch((error: unknown) => {
          if (mountedRef.current && saveSequenceRef.current === saveSequence) {
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
    [describeQuickNoteError, editingNote, invalidateExistingEdit, saveExistingEdit],
  )

  useEffect(() => {
    if (!editingNote) return
    if (draftConflictRef.current) {
      if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current)
      setSaveState('unsaved')
      return
    }

    if (editingDraft.trim() === editingNote.content.trim()) {
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
  }, [editingDraft, editingNote, saveEditedDraft])

  function updateDraft(value: string) {
    if (typingTimerRef.current) {
      clearTimeout(typingTimerRef.current)
      typingTimerRef.current = null
    }
    const hasDraft = value.trim().length > 0
    setIsTyping(hasDraft)
    if (hasDraft) {
      typingTimerRef.current = setTimeout(() => {
        if (mountedRef.current) setIsTyping(false)
      }, QUICK_NOTE_TYPING_IDLE_MS)
    }

    if (editingIdRef.current === null) {
      session.change(value)
      return
    }

    latestEditingDraftRef.current = value
    setEditingDraft(value)
    existingEdit.change(value)
  }

  async function submitDraft(event: FormEvent<HTMLFormElement>): Promise<boolean> {
    event.preventDefault()

    if (editingNote) {
      if (!latestEditingDraftRef.current.trim()) {
        setIsTyping(false)
        toast.error('小记内容不能为空')
        return false
      }
      if (draftConflict) return false
      return saveEditedDraft({ closeAfterSave: false })
    }

    if (typingTimerRef.current) {
      clearTimeout(typingTimerRef.current)
      typingTimerRef.current = null
    }
    setIsTyping(false)
    const lifecycleEpoch = lifecycleEpochRef.current
    const result = await session.record()
    if (!mountedRef.current || lifecycleEpochRef.current !== lifecycleEpoch) return false
    switch (result.kind) {
      case 'recorded':
        if (result.visibility === 'pending') {
          toast('小记已记录，列表将在稍后刷新')
        }
        return true
      case 'empty':
        toast.error('先写点内容再记录')
        return false
      case 'busy':
        toast.error('草稿正在丢弃，请稍后再记录')
        return false
      case 'failed':
        toast.error('小记创建失败', {
          description: '草稿仍保留在本机，请稍后重试',
        })
        return false
      default: {
        const exhaustiveResult: never = result
        return exhaustiveResult
      }
    }
  }

  const discardNewDraft = useCallback(async () => {
    if (editingIdRef.current !== null) return
    const lifecycleEpoch = lifecycleEpochRef.current
    const result = await session.discard()
    if (!mountedRef.current || lifecycleEpochRef.current !== lifecycleEpoch) return
    switch (result.kind) {
      case 'discarded':
        if (typingTimerRef.current) {
          clearTimeout(typingTimerRef.current)
          typingTimerRef.current = null
        }
        setIsTyping(false)
        return
      case 'superseded':
        return
      case 'busy':
        toast.error('草稿正在记录，请稍后再丢弃')
        return
      case 'failed':
        toast.error('丢弃草稿失败，输入已保留')
        return
      default: {
        const exhaustiveResult: never = result
        return exhaustiveResult
      }
    }
  }, [session])

  function startEdit(note: QuickNote) {
    void existingEdit.start(note)
    if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current)
    if (typingTimerRef.current) clearTimeout(typingTimerRef.current)
    saveSequenceRef.current += 1
    editingIdRef.current = note.id
    latestEditingDraftRef.current = note.content
    setIsTyping(false)
    setEditingId(note.id)
    setEditingNoteSnapshot(note)
    setEditingBaseContent(note.content)
    setDraftConflict(null)
    setEditingDraft(note.content)
    setSaveState('saved')
  }

  function keepLocalDraft() {
    setDraftConflict(null)
    setIsTyping(false)
    void saveEditedDraft({ closeAfterSave: false })
  }

  function useRemoteDraft() {
    if (!draftConflict) return
    if (typingTimerRef.current) clearTimeout(typingTimerRef.current)
    setIsTyping(false)
    latestEditingDraftRef.current = draftConflict.remoteContent
    setEditingNoteSnapshot(draftConflict.note)
    setEditingBaseContent(draftConflict.remoteContent)
    setEditingDraft(draftConflict.remoteContent)
    setDraftConflict(null)
    setSaveState('saved')
  }

  function mergeRemoteDraft() {
    if (!draftConflict) return
    if (typingTimerRef.current) clearTimeout(typingTimerRef.current)
    setIsTyping(false)
    const merged = [
      draftConflict.localDraft.trimEnd(),
      '',
      '--- 远端版本 ---',
      draftConflict.remoteContent.trim(),
    ].join('\n')
    latestEditingDraftRef.current = merged
    setEditingNoteSnapshot(draftConflict.note)
    setEditingBaseContent(draftConflict.remoteContent)
    setEditingDraft(merged)
    setDraftConflict(null)
    setSaveState('unsaved')
  }

  return {
    cancelEdit,
    discardNewDraft,
    draftConflict,
    draftSaveState,
    draft,
    editingId,
    editingNote,
    isTyping,
    keepLocalDraft,
    mergeRemoteDraft,
    saveState,
    setDraft: updateDraft,
    startEdit,
    submitDraft,
    useRemoteDraft,
  }
}
