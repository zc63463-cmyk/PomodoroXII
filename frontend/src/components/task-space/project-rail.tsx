'use client'

import { createElement, useState, type FormEvent } from 'react'
import { Plus } from 'lucide-react'
import type { CachedProject } from '@/types'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'

export interface ProjectCreateInput {
  name: string
  key: string
  description: string | null
}

export interface ProjectRailProps {
  projects: CachedProject[]
  selectedId: string | null
  onSelect: (projectId: string) => void
  onCreate?: (input: ProjectCreateInput) => Promise<unknown> | unknown
  isOnline?: boolean
}

function browserOnline(): boolean {
  return typeof navigator === 'undefined' || navigator.onLine !== false
}

export function ProjectRail({
  projects,
  selectedId,
  onSelect,
  onCreate,
  isOnline = browserOnline(),
}: ProjectRailProps) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [key, setKey] = useState('')
  const [description, setDescription] = useState('')
  const [submitError, setSubmitError] = useState<string | null>(null)

  const resetForm = () => {
    setName('')
    setKey('')
    setDescription('')
    setSubmitError(null)
  }

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!onCreate || !name.trim() || !key.trim()) return
    try {
      await onCreate({ name: name.trim(), key: key.trim(), description: description.trim() || null })
      setOpen(false)
      resetForm()
    } catch (error) {
      setSubmitError((error as Error).message)
    }
  }

  const projectList = projects.length === 0
    ? createElement('p', { className: 'px-2 py-3 text-sm text-muted-foreground' }, 'No projects yet')
    : createElement(
        'ul',
        { className: 'space-y-1' },
        ...projects.map((project) => createElement(
          'li',
          { key: project.id },
          createElement(
            'button',
            {
              type: 'button',
              'aria-label': `${project.key} ${project.name}`,
              'aria-pressed': project.id === selectedId,
              className: cn(
                'flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-2 text-left text-sm transition-colors',
                project.id === selectedId ? 'bg-primary/10 text-primary' : 'text-foreground hover:bg-muted',
              ),
              onClick: () => onSelect(project.id),
            },
            createElement('span', { className: 'shrink-0 font-mono text-xs text-muted-foreground' }, project.key),
            createElement('span', { className: 'min-w-0 truncate' }, project.name),
          ),
        )),
      )

  const dialog = createElement(
    Dialog,
    {
      open,
      onOpenChange: (nextOpen: boolean) => {
        setOpen(nextOpen)
        if (!nextOpen) resetForm()
      },
    },
    createElement(
      DialogContent,
      null,
      createElement(
        DialogHeader,
        null,
        createElement(DialogTitle, null, 'Create project'),
        createElement(DialogDescription, null, 'Project keys are normalized to uppercase.'),
      ),
      createElement(
        'form',
        { className: 'grid gap-4', onSubmit: submit },
        createElement(
          'div',
          { className: 'grid gap-2' },
          createElement(Label, { htmlFor: 'project-name' }, 'Name'),
          createElement(Input, { id: 'project-name', value: name, onChange: (event) => setName(event.target.value), required: true }),
        ),
        createElement(
          'div',
          { className: 'grid gap-2' },
          createElement(Label, { htmlFor: 'project-key' }, 'Key'),
          createElement(Input, { id: 'project-key', value: key, onChange: (event) => setKey(event.target.value), required: true }),
        ),
        createElement(
          'div',
          { className: 'grid gap-2' },
          createElement(Label, { htmlFor: 'project-description' }, 'Description'),
          createElement(Input, { id: 'project-description', value: description, onChange: (event) => setDescription(event.target.value) }),
        ),
        submitError ? createElement('p', { role: 'alert', className: 'text-sm text-destructive' }, submitError) : null,
        createElement(
          DialogFooter,
          null,
          createElement(Button, { type: 'submit' }, 'Create'),
        ),
      ),
    ),
  )

  return createElement(
    'aside',
    { 'aria-label': 'Projects', className: 'flex min-h-0 flex-col bg-muted/20' },
    createElement(
      'div',
      { className: 'flex items-center justify-between border-b px-3 py-3' },
      createElement('h2', { className: 'text-sm font-semibold' }, 'Projects'),
      createElement(
        Button,
        {
          type: 'button',
          variant: 'ghost',
          size: 'icon-sm',
          'aria-label': 'Create project',
          title: isOnline ? 'Create project' : 'Project creation is unavailable offline',
          disabled: !isOnline || !onCreate,
          onClick: () => setOpen(true),
        },
        createElement(Plus, { 'aria-hidden': true }),
      ),
    ),
    createElement('nav', { className: 'min-h-0 flex-1 overflow-y-auto p-2', 'aria-label': 'Project list' }, projectList),
    dialog,
  )
}
