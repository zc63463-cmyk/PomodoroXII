import { createElement, type ReactNode } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { CachedProject } from '@/types'

vi.mock('lucide-react', () => ({
  Plus: (props: Record<string, unknown>) => createElement('span', props),
}))
vi.mock('@/components/ui/button', () => ({
  Button: ({ children, ...props }: { children?: ReactNode } & Record<string, unknown>) => createElement('button', props, children),
}))
vi.mock('@/components/ui/input', () => ({
  Input: (props: Record<string, unknown>) => createElement('input', props),
}))
vi.mock('@/components/ui/label', () => ({
  Label: ({ children, ...props }: { children?: ReactNode } & Record<string, unknown>) => createElement('label', props, children),
}))
vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children }: { children?: ReactNode }) => children,
  DialogContent: ({ children }: { children?: ReactNode }) => children,
  DialogDescription: ({ children }: { children?: ReactNode }) => createElement('p', null, children),
  DialogFooter: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  DialogHeader: ({ children }: { children?: ReactNode }) => createElement('div', null, children),
  DialogTitle: ({ children }: { children?: ReactNode }) => createElement('h2', null, children),
}))
import { ProjectRail } from './project-rail'

const project: CachedProject = {
  id: 'project-1',
  key: 'RM',
  name: 'Roadmap',
  description: 'Planning',
  nextWorkItemNumber: 2,
  rank: 0,
  archivedAt: null,
  version: 1,
  createdAt: '2026-07-15T08:00:00.000Z',
  updatedAt: '2026-07-15T08:00:00.000Z',
}

describe('ProjectRail', () => {
  it('selects a project and keeps formal creation unavailable offline', () => {
    const onSelect = vi.fn()
    const onCreate = vi.fn()
    render(createElement(ProjectRail, {
      projects: [project],
      selectedId: null,
      onSelect,
      onCreate,
      isOnline: false,
    }))

    fireEvent.click(screen.getByRole('button', { name: /RM Roadmap/ }))
    expect(onSelect).toHaveBeenCalledWith('project-1')
    expect(screen.getByRole('button', { name: 'Create project' })).toBeDisabled()
  })
})
