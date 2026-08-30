'use client'

import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { ProjectRail } from '@/components/task-space/project-rail'
import { LaunchSessionButton } from '@/components/task-space/launch-session-button'
import { WorkItemDetail } from '@/components/task-space/work-item-detail'
import { WorkItemTree } from '@/components/task-space/work-item-tree'
import { WorkItemNoteEditor } from '@/components/task-space/work-item-note-editor'
import { TaskSpaceRepository } from '@/lib/task-space/task-space-repository'
import { WorkItemNoteRepository } from '@/lib/task-space/work-item-note-repository'
import { syncEngine } from '@/lib/sync'
import { useTaskSpaceShortcuts } from '@/hooks/use-task-space-shortcuts'
import { selectMoveCandidates, selectProjectTree, resolveTaskSpaceMutationError, useTaskSpaceStore } from '@/stores/task-space-store'
import { useSpaceStore } from '@/stores/space-store'
import { spaceDBManager } from '@/services/space-db'
import { PXII_SPACE_SWITCHED_EVENT } from '@/lib/platform'
import type { WorkItemNoteConflictRow } from '@/types'

type NoteRepositoryWithConflict = {
  conflict: (workItemId: string) => Promise<WorkItemNoteConflictRow | undefined>
}

export default function TasksPage() {
  const spaceId = useSpaceStore((state) => state.currentSpaceId)
  const projects = useTaskSpaceStore((state) => state.projects)
  const workItems = useTaskSpaceStore((state) => state.workItems)
  const definitions = useTaskSpaceStore((state) => state.definitions)
  const selectedProjectId = useTaskSpaceStore((state) => state.selectedProjectId)
  const selectedWorkItemId = useTaskSpaceStore((state) => state.selectedWorkItemId)
  const selectedNote = useTaskSpaceStore((state) => state.selectedNote)
  const noteConflict = useTaskSpaceStore((state) => state.noteConflict)
  const noteRepositoryReady = useTaskSpaceStore((state) => state.noteRepository !== null)
  const isLoading = useTaskSpaceStore((state) => state.isLoading)
  const error = useTaskSpaceStore((state) => state.error)
  const hydrate = useTaskSpaceStore((state) => state.hydrate)
  const reset = useTaskSpaceStore((state) => state.reset)
  const selectProject = useTaskSpaceStore((state) => state.selectProject)
  const selectWorkItem = useTaskSpaceStore((state) => state.selectWorkItem)
  const attachNoteRepository = useTaskSpaceStore((state) => state.attachNoteRepository)
  const loadNote = useTaskSpaceStore((state) => state.loadNote)
  const updateNoteDocument = useTaskSpaceStore((state) => state.updateNoteDocument)
  const flushNote = useTaskSpaceStore((state) => state.flushNote)
  const dispatchNote = useTaskSpaceStore((state) => state.dispatchNote)
  const resolveReloadRemoteNote = useTaskSpaceStore((state) => state.resolveReloadRemoteNote)
  const resolveOverwriteLocalNote = useTaskSpaceStore((state) => state.resolveOverwriteLocalNote)
  const createProject = useTaskSpaceStore((state) => state.createProject)
  const createChild = useTaskSpaceStore((state) => state.createChild)
  const createRoot = useTaskSpaceStore((state) => state.createRoot)
  const updateWorkItem = useTaskSpaceStore((state) => state.updateWorkItem)
  const moveWorkItem = useTaskSpaceStore((state) => state.moveWorkItem)
  const transitionWorkItem = useTaskSpaceStore((state) => state.transitionWorkItem)
  const pendingMutations = useTaskSpaceStore((state) => state.pendingMutations)
  const mutationError = useTaskSpaceStore((state) => state.mutationError)
  const [createTarget, setCreateTarget] = useState<{ kind: 'child'; parentId: string } | { kind: 'root' } | null>(null)
  const [childTitle, setChildTitle] = useState('')
  const [collapseSignal, setCollapseSignal] = useState<{ seq: number; mode: 'collapse' | 'expand' }>({ seq: 0, mode: 'expand' })

  useEffect(() => {
    if (!spaceId) {
      reset()
      return
    }
    let cancelled = false
    const run = () => {
      if (cancelled) return
      try {
        const database = spaceDBManager.current
        const repository = new TaskSpaceRepository(database, spaceId)
        const noteRepository = new WorkItemNoteRepository(database, spaceId)
        const noteRepositoryWithConflict = noteRepository as unknown as NoteRepositoryWithConflict
        attachNoteRepository({
          read: (workItemId) => noteRepository.read(workItemId),
          saveLocal: (input) => noteRepository.saveLocal(input),
          dispatchReplace: (workItemId) => noteRepository.dispatchReplace(workItemId),
          resolveReloadRemote: (workItemId) => noteRepository.resolveReloadRemote(workItemId),
          resolveOverwriteLocal: (workItemId) => noteRepository.resolveOverwriteLocal(workItemId),
          readConflict: async (workItemId) => await noteRepositoryWithConflict.conflict(workItemId) ?? null,
          retryDraft: (workItemId) => noteRepository.retryDraft(workItemId),
          persistDraft: (input) => noteRepository.persistDraft(input),
        })
        void (async () => {
          if (cancelled) return
          await hydrate(spaceId, repository)
        })()
      } catch (hydrationError) {
        // The route guard normally prevents this; keep the workbench
        // fail-closed with a stable message if it races.
        useTaskSpaceStore.setState({
          error: resolveTaskSpaceMutationError(hydrationError).message,
          isLoading: false,
        })
      }
    }
    if (spaceDBManager.currentSpaceId === spaceId) {
      run()
    } else {
      // The space store publishes currentSpaceId before its switchTo()
      // completes; hydrate only once the space database is actually ready.
      const onSpaceSwitched = () => {
        if (spaceDBManager.currentSpaceId === spaceId) run()
      }
      window.addEventListener(PXII_SPACE_SWITCHED_EVENT, onSpaceSwitched)
      return () => {
        cancelled = true
        window.removeEventListener(PXII_SPACE_SWITCHED_EVENT, onSpaceSwitched)
        attachNoteRepository(null)
      }
    }
    return () => {
      cancelled = true
      attachNoteRepository(null)
    }
  }, [attachNoteRepository, hydrate, reset, spaceId])

  useEffect(() => {
    if (!selectedWorkItemId || !noteRepositoryReady) return
    void loadNote(selectedWorkItemId)
  }, [loadNote, noteRepositoryReady, selectedWorkItemId])

  // A Note edit that reached the S4 outbox while offline is pushed by the sync
  // engine on reconnect.  When the server rejects it (version_conflict), the
  // push terminal application writes a workItemNoteConflicts row and pins the
  // note to 'conflict' — but the UI only learns about it by re-reading the
  // note.  Reload the currently selected note after each sync cycle so a
  // newly-arrived conflict (or a newly-applied remote edit) is reflected in the
  // editor instead of staying stale until the user re-selects the item.
  useEffect(() => {
    if (!selectedWorkItemId || !noteRepositoryReady) return
    const unregister = syncEngine.onSyncComplete?.(() => {
      void loadNote(selectedWorkItemId)
    })
    return unregister
  }, [loadNote, noteRepositoryReady, selectedWorkItemId])

  // Flush any debounced Note edit before the space database switches or closes
  // (space switch + logout).  spaceDBManager awaits these listeners while the
  // old DB is still open, so a dirty Note is persisted to local storage/outbox
  // instead of being dropped by the unmount/reset cancel path.
  useEffect(() => {
    const unregister = spaceDBManager.onBeforeSwitch(({ fromSpaceId }) => {
      if (fromSpaceId !== spaceId) return undefined
      return flushNote('space-switch').catch(() => undefined)
    })
    return () => unregister()
  }, [flushNote, spaceId])

  const visibleItems = selectProjectTree(workItems, selectedProjectId)
  const selectedWorkItem = workItems.find((item) => item.id === selectedWorkItemId) ?? null
  // Same-project nodes that may become a new parent: never the item itself,
  // its descendants, or a depth-3 node (all rejected by the backend anyway).
  const availableParents = selectMoveCandidates(visibleItems, selectedWorkItemId)

  const submitChild = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!createTarget) return
    try {
      if (createTarget.kind === 'root') {
        await createRoot({ title: childTitle })
      } else {
        await createChild(createTarget.parentId, { title: childTitle })
      }
      setCreateTarget(null)
      setChildTitle('')
    } catch {
      // Keep the dialog open with the typed title; the store surfaced a
      // stable error shown inside the dialog.
    }
  }

  const selectWorkItemAndDispatch = (workItemId: string) => {
    if (selectedWorkItemId && selectedWorkItemId !== workItemId) void dispatchNote(selectedWorkItemId).catch(() => undefined)
    selectWorkItem(workItemId)
  }

  // T3 前端打磨: tasks-page keyboard shortcuts (n = create, e = collapse
  // toggle, s = start focus).  Callbacks stay stable per render via
  // useCallback so the hook's effect does not thrash.
  const handleShortcutCreate = useCallback(() => {
    setCreateTarget(selectedWorkItemId ? { kind: 'child', parentId: selectedWorkItemId } : { kind: 'root' })
  }, [selectedWorkItemId])
  const handleShortcutCollapse = useCallback(() => {
    setCollapseSignal((current) => ({
      seq: current.seq + 1,
      mode: current.mode === 'collapse' ? 'expand' : 'collapse',
    }))
  }, [])
  const handleShortcutFocus = useCallback(() => {
    document.querySelector<HTMLButtonElement>('[data-launch-session]')?.click()
  }, [])
  useTaskSpaceShortcuts({
    onCreateWorkItem: handleShortcutCreate,
    onToggleCollapse: handleShortcutCollapse,
    onStartFocus: handleShortcutFocus,
  })

  const handleTreeMove = useCallback((workItemId: string, newParentId: string | null) => {
    void moveWorkItem(workItemId, newParentId).catch(() => undefined)
  }, [moveWorkItem])

  return (
    <div className="flex min-h-full min-w-0 flex-col">
      {error ? <p role="alert" className="border-b bg-destructive/10 px-4 py-2 text-sm text-destructive">{error}</p> : null}
      <div className="grid min-h-[calc(100vh-7rem)] min-w-0 flex-1 grid-cols-1 md:grid-cols-[180px_280px_minmax(0,1fr)]">
        <ProjectRail
          projects={projects}
          selectedId={selectedProjectId}
          onSelect={selectProject}
          onCreate={createProject}
        />
        <section className="min-w-0 border-y md:border-y-0 md:border-x" aria-label="Work item tree">
          <div className="flex items-center justify-between border-b px-3 py-3">
            <h2 className="text-sm font-semibold">Work items</h2>
            {isLoading ? <span className="text-xs text-muted-foreground">Loading</span> : null}
          </div>
          {selectedProjectId ? (
            <WorkItemTree
              items={visibleItems}
              selectedId={selectedWorkItemId}
              onSelect={selectWorkItemAndDispatch}
              onCreateChild={(parentId) => setCreateTarget({ kind: 'child', parentId })}
              onCreateRoot={() => setCreateTarget({ kind: 'root' })}
              definitions={definitions}
              isLoading={isLoading}
              error={error}
              pendingMutations={pendingMutations}
              onMove={handleTreeMove}
              collapseSignal={collapseSignal}
            />
          ) : (
            <p className="p-4 text-sm text-muted-foreground">Select a project</p>
          )}
        </section>
        <div className="flex min-w-0 flex-col">
          <div className="flex items-center justify-between border-b px-3 py-2">
            <h2 className="text-sm font-semibold">Work item</h2>
            <LaunchSessionButton workItem={selectedWorkItem} />
          </div>
          <WorkItemDetail
            workItem={selectedWorkItem}
            definitions={definitions}
            pendingMutations={pendingMutations}
            mutationError={mutationError}
            error={error}
            availableParents={availableParents}
            onUpdate={(input) => updateWorkItem(selectedWorkItemId ?? '', input)}
            onTransition={(statusDefinitionId) => transitionWorkItem(selectedWorkItemId ?? '', statusDefinitionId)}
            onMove={(parentId) => moveWorkItem(selectedWorkItemId ?? '', parentId)}
            noteEditor={selectedNote ? (
              <WorkItemNoteEditor
                document={selectedNote.document}
                onChange={updateNoteDocument}
                conflict={noteConflict}
                onReloadRemote={() => resolveReloadRemoteNote(selectedWorkItemId ?? selectedNote.workItemId).catch(() => undefined)}
                onOverwriteLocal={() => resolveOverwriteLocalNote(selectedWorkItemId ?? selectedNote.workItemId).catch(() => undefined)}
                saveLabel={selectedNote.syncState === 'conflict' ? 'Conflict requires review' : selectedNote.syncState === 'dirty' ? 'Local edit pending' : 'Saved'}
                onFlush={(reason) => flushNote(reason).catch(() => undefined)}
              />
            ) : undefined}
          />
        </div>
      </div>
      <Dialog
        open={createTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            setCreateTarget(null)
            setChildTitle('')
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create work item</DialogTitle>
          </DialogHeader>
          <form className="grid gap-4" onSubmit={submitChild}>
            <div className="grid gap-2">
              <Label htmlFor="child-title">Title</Label>
              <Input id="child-title" value={childTitle} onChange={(event) => setChildTitle(event.target.value)} required />
            </div>
            {createTarget !== null && mutationError?.targetId === (createTarget.kind === 'root' ? '__root__' : createTarget.parentId) && error
              ? <p role="alert" className="text-sm text-destructive">{error}</p>
              : null}
            <DialogFooter>
              <Button
                type="submit"
                disabled={createTarget !== null && pendingMutations[createTarget.kind === 'root' ? '__root__' : createTarget.parentId] === true}
              >
                Create
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}
