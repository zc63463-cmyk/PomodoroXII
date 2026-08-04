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
import { TaskSpaceRepository } from '@/lib/task-space/task-space-repository'
import { selectProjectTree, useTaskSpaceStore } from '@/stores/task-space-store'
import { useSpaceStore } from '@/stores/space-store'
import { spaceDBManager } from '@/services/space-db'

export default function TasksPage() {
  const spaceId = useSpaceStore((state) => state.currentSpaceId)
  const projects = useTaskSpaceStore((state) => state.projects)
  const workItems = useTaskSpaceStore((state) => state.workItems)
  const definitions = useTaskSpaceStore((state) => state.definitions)
  const selectedProjectId = useTaskSpaceStore((state) => state.selectedProjectId)
  const selectedWorkItemId = useTaskSpaceStore((state) => state.selectedWorkItemId)
  const isLoading = useTaskSpaceStore((state) => state.isLoading)
  const error = useTaskSpaceStore((state) => state.error)
  const hydrate = useTaskSpaceStore((state) => state.hydrate)
  const reset = useTaskSpaceStore((state) => state.reset)
  const selectProject = useTaskSpaceStore((state) => state.selectProject)
  const selectWorkItem = useTaskSpaceStore((state) => state.selectWorkItem)
  const createProject = useTaskSpaceStore((state) => state.createProject)
  const createChild = useTaskSpaceStore((state) => state.createChild)
  const [createParentId, setCreateParentId] = useState<string | null>(null)
  const [childTitle, setChildTitle] = useState('')

  useEffect(() => {
    if (!spaceId) {
      reset()
      return
    }
    let cancelled = false
    try {
      const repository = new TaskSpaceRepository(spaceDBManager.current, spaceId)
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
    }
  }, [hydrate, reset, spaceId])

  const visibleItems = selectProjectTree(workItems, selectedProjectId)
  const selectedWorkItem = workItems.find((item) => item.id === selectedWorkItemId) ?? null

  const submitChild = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!createParentId) return
    await createChild(createParentId, { title: childTitle })
    setCreateParentId(null)
    setChildTitle('')
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
              onSelect={selectWorkItem}
              onCreateChild={setCreateParentId}
            />
          ) : (
            <p className="p-4 text-sm text-muted-foreground">Select a project</p>
          )}
        </section>
        <WorkItemDetail workItem={selectedWorkItem} definitions={definitions} />
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
            <DialogFooter>
              <Button type="submit">Create</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}
