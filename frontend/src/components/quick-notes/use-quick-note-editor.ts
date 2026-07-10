'use client'

import { FormEvent, useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import type {
  QuickNoteDraftSaveState,
  QuickNoteSaveState,
} from '@/components/quick-notes/quick-note-composer'
import type { QuickNoteDraftConflict } from '@/components/quick-notes/quick-note-conflict-panel'
import type { QuickNote } from '@/types'
import type {
  QuickNoteCreateInput,
  QuickNoteLifecycleState,
  QuickNoteUpdateInput,
} from '@/lib/quick-notes/quick-note-repository'
import {
  createQuickNoteDraftRepository,
  type QuickNoteDraftRepository,
} from '@/lib/quick-notes/quick-note-draft-repository'
import { QUICK_NOTE_TYPING_IDLE_MS } from '@/lib/quick-notes/quick-note-editor-status'
import { spaceDBManager } from '@/services/space-db'

export const QUICK_NOTE_NEW_DRAFT_DEBOUNCE_MS = 500
export const QUICK_NOTE_DRAFT_FLUSH_TIMEOUT_MS = 3000

interface UseQuickNoteEditorOptions {
  quickNotes: QuickNote[]
  trashedQuickNotes: QuickNote[]
  createQuickNote: (data: QuickNoteCreateInput) => Promise<QuickNote>
  updateQuickNote: (id: string, data: QuickNoteUpdateInput) => Promise<void>
  describeQuickNoteError: (error: unknown, fallback: string) => string
  lifecycleStateById?: Record<string, QuickNoteLifecycleState>
}

interface ActiveDraftContext {
  spaceId: string
  repository: QuickNoteDraftRepository
  writeQueue: Promise<void>
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
  const [isTyping, setIsTyping] = useState(false)
  const [saveState, setSaveState] = useState<QuickNoteSaveState>('saved')
  const [draftSaveState, setDraftSaveState] = useState<QuickNoteDraftSaveState>('idle')
  const draftSaveStateRef = useRef<QuickNoteDraftSaveState>('idle')
  const autosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const newDraftSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const draftConflictRef = useRef<QuickNoteDraftConflict | null>(null)
  const latestDraftRef = useRef(draft)
  const editingIdRef = useRef<string | null>(null)
  const newDraftBeforeEditRef = useRef('')
  const saveSequenceRef = useRef(0)
  const saveQueueRef = useRef<Promise<unknown>>(Promise.resolve())
  const draftSaveSequenceRef = useRef(0)
  const draftLoadSequenceRef = useRef(0)
  const draftInputRevisionRef = useRef(0)
  const activeDraftContextRef = useRef<ActiveDraftContext | null>(null)
  const typingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const mountedRef = useRef(true)
  draftConflictRef.current = draftConflict
  draftSaveStateRef.current = draftSaveState
  editingIdRef.current = editingId

  const editingNote =
    (editingNoteSnapshot?.id === editingId ? editingNoteSnapshot : null) ??
    quickNotes.find((note) => note.id === editingId) ??
    null

  const clearNewDraftSaveTimer = useCallback(() => {
    if (!newDraftSaveTimerRef.current) return
    clearTimeout(newDraftSaveTimerRef.current)
    newDraftSaveTimerRef.current = null
  }, [])

  const enqueueDraftWrite = useCallback(
    (context: ActiveDraftContext, write: () => Promise<void>): Promise<void> => {
      const queued = context.writeQueue.then(write)
      context.writeQueue = queued.catch(() => undefined)
      return queued
    },
    [],
  )

  const persistNewDraft = useCallback(
    async ({
      context = activeDraftContextRef.current,
      updateState = true,
    }: {
      context?: ActiveDraftContext | null
      updateState?: boolean
    } = {}) => {
      clearNewDraftSaveTimer()
      if (!context || editingIdRef.current !== null) return

      const content = latestDraftRef.current
      const sequence = draftSaveSequenceRef.current + 1
      draftSaveSequenceRef.current = sequence
      if (updateState && mountedRef.current) setDraftSaveState('saving')

      try {
        await enqueueDraftWrite(context, async () => {
          if (content.trim()) {
            await context.repository.save(content)
          } else {
            await context.repository.clear()
          }
        })

        if (
          updateState &&
          mountedRef.current &&
          activeDraftContextRef.current === context &&
          editingIdRef.current === null &&
          draftSaveSequenceRef.current === sequence &&
          latestDraftRef.current === content
        ) {
          setDraftSaveState(content.trim() ? 'saved' : 'idle')
        }
      } catch {
        if (
          updateState &&
          mountedRef.current &&
          activeDraftContextRef.current === context &&
          draftSaveSequenceRef.current === sequence
        ) {
          setDraftSaveState('failed')
        }
      }
    },
    [clearNewDraftSaveTimer, enqueueDraftWrite],
  )

  const scheduleNewDraftSave = useCallback(() => {
    clearNewDraftSaveTimer()
    draftSaveSequenceRef.current += 1
    setDraftSaveState(latestDraftRef.current.trim() ? 'dirty' : 'idle')
    newDraftSaveTimerRef.current = setTimeout(() => {
      newDraftSaveTimerRef.current = null
      void persistNewDraft()
    }, QUICK_NOTE_NEW_DRAFT_DEBOUNCE_MS)
  }, [clearNewDraftSaveTimer, persistNewDraft])

  const loadNewDraft = useCallback(async (context: ActiveDraftContext) => {
    const loadSequence = draftLoadSequenceRef.current + 1
    draftLoadSequenceRef.current = loadSequence
    const inputRevision = draftInputRevisionRef.current

    const snapshot = await context.repository.load()
    if (
      !snapshot ||
      !mountedRef.current ||
      activeDraftContextRef.current !== context ||
      draftLoadSequenceRef.current !== loadSequence ||
      draftInputRevisionRef.current !== inputRevision ||
      editingIdRef.current !== null ||
      latestDraftRef.current.trim()
    ) {
      return
    }

    latestDraftRef.current = snapshot.content
    newDraftBeforeEditRef.current = snapshot.content
    setDraft(snapshot.content)
    setDraftSaveState('restored')
  }, [])

  const activateSpaceDraft = useCallback(
    (spaceId: string) => {
      clearNewDraftSaveTimer()
      draftLoadSequenceRef.current += 1
      draftSaveSequenceRef.current += 1
      draftInputRevisionRef.current += 1
      saveSequenceRef.current += 1
      if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current)
      const context: ActiveDraftContext = {
        spaceId,
        repository: createQuickNoteDraftRepository(spaceDBManager.current),
        writeQueue: Promise.resolve(),
      }
      activeDraftContextRef.current = context
      latestDraftRef.current = ''
      newDraftBeforeEditRef.current = ''
      editingIdRef.current = null
      setDraft('')
      setEditingId(null)
      setEditingNoteSnapshot(null)
      setEditingBaseContent('')
      setDraftConflict(null)
      setIsTyping(false)
      setSaveState('saved')
      setDraftSaveState('idle')
      void loadNewDraft(context)
    },
    [clearNewDraftSaveTimer, loadNewDraft],
  )

  const clearPersistedNewDraft = useCallback(
    async (context: ActiveDraftContext | null) => {
      clearNewDraftSaveTimer()
      draftSaveSequenceRef.current += 1
      if (!context) return
      try {
        await enqueueDraftWrite(context, () => context.repository.clear())
        if (mountedRef.current && activeDraftContextRef.current === context) {
          setDraftSaveState('idle')
        }
      } catch (error) {
        if (mountedRef.current && activeDraftContextRef.current === context) {
          setDraftSaveState('failed')
        }
        throw error
      }
    },
    [clearNewDraftSaveTimer, enqueueDraftWrite],
  )

  const discardNewDraft = useCallback(async () => {
    if (editingIdRef.current !== null) return
    const context = activeDraftContextRef.current
    if (!context) return
    const inputRevision = draftInputRevisionRef.current
    try {
      await clearPersistedNewDraft(context)
      if (
        activeDraftContextRef.current !== context ||
        editingIdRef.current !== null ||
        draftInputRevisionRef.current !== inputRevision
      ) {
        if (activeDraftContextRef.current === context && editingIdRef.current === null) {
          scheduleNewDraftSave()
        }
        return
      }
      draftInputRevisionRef.current += 1
      latestDraftRef.current = ''
      newDraftBeforeEditRef.current = ''
      setDraft('')
      setIsTyping(false)
    } catch {
      if (mountedRef.current) {
        setDraftSaveState('failed')
        toast.error('丢弃草稿失败，输入已保留')
      }
    }
  }, [clearPersistedNewDraft, scheduleNewDraftSave])

  const cancelEdit = useCallback(() => {
    if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current)
    if (typingTimerRef.current) clearTimeout(typingTimerRef.current)
    saveSequenceRef.current += 1
    const restoredNewDraft = newDraftBeforeEditRef.current
    editingIdRef.current = null
    latestDraftRef.current = restoredNewDraft
    setEditingId(null)
    setEditingNoteSnapshot(null)
    setEditingBaseContent('')
    setDraftConflict(null)
    setIsTyping(false)
    setDraft(restoredNewDraft)
    setSaveState('saved')
    setDraftSaveState(restoredNewDraft.trim() ? 'saved' : 'idle')
  }, [])

  useEffect(() => {
    latestDraftRef.current = draft
  }, [draft])

  useEffect(() => {
    mountedRef.current = true
    const unsubscribeBeforeSwitch = spaceDBManager.onBeforeSwitch(
      async ({ fromSpaceId }) => {
        const context = activeDraftContextRef.current
        if (!context || context.spaceId !== fromSpaceId || editingIdRef.current !== null) return
        const capturedContext: ActiveDraftContext = {
          spaceId: fromSpaceId,
          repository: context.repository,
          writeQueue: context.writeQueue,
        }
        let timeoutId: ReturnType<typeof setTimeout> | null = null
        const timeout = new Promise<void>((resolve) => {
          timeoutId = setTimeout(resolve, QUICK_NOTE_DRAFT_FLUSH_TIMEOUT_MS)
        })
        try {
          await Promise.race([
            persistNewDraft({ context: capturedContext }),
            timeout,
          ])
        } finally {
          if (timeoutId) clearTimeout(timeoutId)
        }
      },
    )
    const unsubscribeSwitch = spaceDBManager.onSwitch((spaceId) => {
      if (mountedRef.current) activateSpaceDraft(spaceId)
    })

    if (spaceDBManager.hasSpace && spaceDBManager.currentSpaceId) {
      activateSpaceDraft(spaceDBManager.currentSpaceId)
    }

    const handlePageHide = () => {
      if (draftSaveStateRef.current === 'saved' || draftSaveStateRef.current === 'restored') return
      void persistNewDraft({ updateState: false })
    }
    window.addEventListener('pagehide', handlePageHide)

    return () => {
      mountedRef.current = false
      clearNewDraftSaveTimer()
      if (typingTimerRef.current) clearTimeout(typingTimerRef.current)
      if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current)
      unsubscribeBeforeSwitch()
      unsubscribeSwitch()
      window.removeEventListener('pagehide', handlePageHide)
      if (draftSaveStateRef.current !== 'saved' && draftSaveStateRef.current !== 'restored') {
        void persistNewDraft({ updateState: false })
      }
    }
  }, [activateSpaceDraft, clearNewDraftSaveTimer, persistNewDraft])

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
      if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current)
      if (typingTimerRef.current) clearTimeout(typingTimerRef.current)
      setIsTyping(false)
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
    if (shouldAdoptRemoteDraft) {
      latestDraftRef.current = refreshedNote.content
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
            latestDraftRef.current = newDraftBeforeEditRef.current
            setDraft(newDraftBeforeEditRef.current)
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
    if (draftConflictRef.current) {
      if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current)
      setSaveState('unsaved')
      return
    }

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

  function updateDraft(value: string) {
    latestDraftRef.current = value
    draftInputRevisionRef.current += 1
    setDraft(value)
    if (typingTimerRef.current) clearTimeout(typingTimerRef.current)
    const hasDraft = value.trim().length > 0
    setIsTyping(hasDraft)
    if (hasDraft) {
      typingTimerRef.current = setTimeout(() => {
        if (mountedRef.current) setIsTyping(false)
      }, QUICK_NOTE_TYPING_IDLE_MS)
    }
    if (editingIdRef.current === null) scheduleNewDraftSave()
  }

  async function submitDraft(event: FormEvent<HTMLFormElement>): Promise<boolean> {
    event.preventDefault()
    const content = latestDraftRef.current.trim()
    if (!content) {
      setIsTyping(false)
      toast.error(editingNote ? '小记内容不能为空' : '先写点内容再记录')
      return false
    }

    if (editingNote) {
      if (draftConflict) return false
      return saveEditedDraft({ closeAfterSave: false })
    }

    const context = activeDraftContextRef.current
    const inputRevision = draftInputRevisionRef.current
    clearNewDraftSaveTimer()
    try {
      await createQuickNote({ content })
      const inputStillMatchesSubmission =
        activeDraftContextRef.current === context &&
        editingIdRef.current === null &&
        draftInputRevisionRef.current === inputRevision &&
        latestDraftRef.current.trim() === content

      if (inputStillMatchesSubmission) {
        if (typingTimerRef.current) clearTimeout(typingTimerRef.current)
        draftInputRevisionRef.current += 1
        latestDraftRef.current = ''
        newDraftBeforeEditRef.current = ''
        setIsTyping(false)
        setDraft('')
        await clearPersistedNewDraft(context).catch(() => undefined)
      } else if (activeDraftContextRef.current === context && editingIdRef.current === null) {
        scheduleNewDraftSave()
      }
      return true
    } catch (error) {
      setDraftSaveState(content ? 'dirty' : 'idle')
      toast.error('小记创建失败', {
        description: describeQuickNoteError(error, '请稍后重试'),
      })
      return false
    }
  }

  function startEdit(note: QuickNote) {
    if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current)
    if (typingTimerRef.current) clearTimeout(typingTimerRef.current)
    newDraftBeforeEditRef.current = latestDraftRef.current
    void persistNewDraft()
    saveSequenceRef.current += 1
    editingIdRef.current = note.id
    latestDraftRef.current = note.content
    setIsTyping(false)
    setEditingId(note.id)
    setEditingNoteSnapshot(note)
    setEditingBaseContent(note.content)
    setDraftConflict(null)
    setDraft(note.content)
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
    latestDraftRef.current = draftConflict.remoteContent
    setEditingNoteSnapshot(draftConflict.note)
    setEditingBaseContent(draftConflict.remoteContent)
    setDraft(draftConflict.remoteContent)
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
    latestDraftRef.current = merged
    setEditingNoteSnapshot(draftConflict.note)
    setEditingBaseContent(draftConflict.remoteContent)
    setDraft(merged)
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
    flushNewDraft: persistNewDraft,
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
