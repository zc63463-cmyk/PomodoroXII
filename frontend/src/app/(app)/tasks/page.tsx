'use client'

import { useEffect, useState } from 'react'
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
import { WorkItemDetail } from '@/components/task-space/work-item-detail'
import { WorkItemTree } from '@/components/task-space/work-item-tree'
import { WorkItemNoteEditor } from '@/components/task-space/work-item-note-editor'
import { TaskSpaceRepository } from '@/lib/task-space/task-space-repository'
import { WorkItemNoteRepository } from '@/lib/task-space/work-item-note-repository'
import { selectProjectTree, useTaskSpaceStore } from '@/stores/task-space-store'
import { useSpaceStore } from '@/stores/space-store'
import { spaceDBManager } from '@/services/space-db'
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
  const updateWorkItem = useTaskSpaceStore((state) => state.updateWorkItem)
  const moveWorkItem = useTaskSpaceStore((state) => state.moveWorkItem)
  const transitionWorkItem = useTaskSpaceStore((state) => state.transitionWorkItem)
  const pendingMutations = useTaskSpaceStore((state) => state.pendingMutations)
  const mutationError = useTaskSpaceStore((state) => state.mutationError)
  const [createParentId, setCreateParentId] = useState<string | null>(null)
  const [childTitle, setChildTitle] = useState('')

  useEffect(() => {
    if (!spaceId) {
      reset()
      return
    }
    let cancelled = false
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
      })
      void (async () => {
        if (cancelled) return
        await hydrate(spaceId, repository)
      })()
    } catch (hydrationError) {
      // The route guard normally prevents this; keep the workbench fail-closed if it races.
      useTaskSpaceStore.setState({ error: (hydrationError as Error).message, isLoading: false })
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

  const visibleItems = selectProjectTree(workItems, selectedProjectId)
  const selectedWorkItem = workItems.find((item) => item.id === selectedWorkItemId) ?? null
  // Only same-project nodes at depth < 3 can become a new parent.
  const availableParents = selectedWorkItem
    ? visibleItems.filter((item) => item.depth < 3 && item.id !== selectedWorkItem.id)
    : []

  const submitChild = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!createParentId) return
    try {
      await createChild(createParentId, { title: childTitle })
      setCreateParentId(null)
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
              onCreateChild={setCreateParentId}
              definitions={definitions}
              isLoading={isLoading}
              error={error}
              pendingMutations={pendingMutations}
            />
          ) : (
            <p className="p-4 text-sm text-muted-foreground">Select a project</p>
          )}
        </section>
        <WorkItemDetail
          workItem={selectedWorkItem}
          definitions={definitions}
          pendingMutations={pendingMutations}
          mutationError={mutationError}
          error={error}
          availableParents={availableParents}
          onUpdate={(input) => updateWorkItem(selectedWorkItemId ?? '', input)}
          onTransition={(statusDefinitionId) => transitionWorkItem(selectedWorkItemId ?? '', statusDefinitionId)}
          onMove={(parentId) => moveWorkItem(selectedWorkItemId ?? '', parentId, 0)}
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
      <Dialog
        open={createParentId !== null}
        onOpenChange={(open) => {
          if (!open) {
            setCreateParentId(null)
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
            {createParentId !== null && mutationError?.targetId === createParentId && error
              ? <p role="alert" className="text-sm text-destructive">{error}</p>
              : null}
            <DialogFooter>
              <Button
                type="submit"
                disabled={createParentId !== null && pendingMutations[createParentId] === true}
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
