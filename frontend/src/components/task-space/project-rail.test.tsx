import { createElement, type ReactNode } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { CachedProject } from '@/types'
import { resolveCreateProjectError } from './project-rail'

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
  Dialog: ({ open, children }: { open?: boolean; children?: ReactNode }) => (open ? children : null),
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

const created = (id = 'project-2'): CachedProject => ({ ...project, id, key: 'TASK', name: 'Tasks' })

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (reason: unknown) => void }

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function axiosError(status: number, detail: unknown, headers: Record<string, string> = {}): Error {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    isAxiosError: true,
    response: { status, data: detail, headers },
  })
}

function openDialog() {
  fireEvent.click(screen.getByRole('button', { name: 'Create project' }))
}

function fillForm(name = 'Tasks', key = 'TASK', description = '') {
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: name } })
  fireEvent.change(screen.getByLabelText('Key'), { target: { value: key } })
  fireEvent.change(screen.getByLabelText('Description'), { target: { value: description } })
}

function submitForm(container: HTMLElement) {
  const form = container.querySelector('form')
  if (!form) throw new Error('expected form in container')
  fireEvent.submit(form)
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

  it('guards against double submission: one mutation, pending locks the form', async () => {
    const pending = deferred<CachedProject>()
    const onCreate = vi.fn(() => pending.promise)
    const { container } = render(createElement(ProjectRail, {
      projects: [],
      selectedId: null,
      onSelect: vi.fn(),
      onCreate,
    }))

    openDialog()
    fillForm()
    submitForm(container)
    submitForm(container)

    expect(onCreate).toHaveBeenCalledTimes(1)
    expect(onCreate).toHaveBeenCalledWith({ name: 'Tasks', key: 'TASK', description: null })
    expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled()
    expect(screen.getByLabelText('Name')).toBeDisabled()
    expect(screen.getByLabelText('Key')).toBeDisabled()
    expect(screen.getByLabelText('Description')).toBeDisabled()

    pending.resolve(created())
    await waitFor(() => {
      expect(screen.queryByRole('heading', { name: 'Create project' })).toBeNull()
    })

    // Pending cleared: a fresh dialog can submit again.
    openDialog()
    expect(screen.getByRole('button', { name: 'Create' })).not.toBeDisabled()
  })

  it('closes the dialog, clears the form and error after a successful create', async () => {
    const onCreate = vi.fn().mockResolvedValue(created())
    const { container } = render(createElement(ProjectRail, {
      projects: [],
      selectedId: null,
      onSelect: vi.fn(),
      onCreate,
    }))

    openDialog()
    fillForm('Roadmap', 'RM', 'planning')
    submitForm(container)

    await waitFor(() => {
      expect(screen.queryByRole('heading', { name: 'Create project' })).toBeNull()
    })
    expect(onCreate).toHaveBeenCalledTimes(1)
    expect(onCreate).toHaveBeenCalledWith({ name: 'Roadmap', key: 'RM', description: 'planning' })

    // Re-open: the form is reset and no error is left behind.
    openDialog()
    expect(screen.getByLabelText('Name')).toHaveValue('')
    expect(screen.getByLabelText('Key')).toHaveValue('')
    expect(screen.getByLabelText('Description')).toHaveValue('')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('keeps the dialog open with a stable Chinese message on project_key_conflict (409)', async () => {
    const conflict = axiosError(409, {
      detail: { code: 'project_key_conflict', retryable: false, details: {} },
    })
    const onCreate = vi.fn().mockRejectedValue(conflict)
    const { container } = render(createElement(ProjectRail, {
      projects: [],
      selectedId: null,
      onSelect: vi.fn(),
      onCreate,
    }))

    openDialog()
    fillForm('Tasks', 'TASK', 'ops')
    submitForm(container)

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('该 Key 已被当前空间使用，请更换 Key。')
    })
    expect(screen.queryByText('Request failed with status code 409')).toBeNull()
    expect(screen.queryByRole('heading', { name: 'Create project' })).not.toBeNull()
    expect(screen.getByLabelText('Name')).toHaveValue('Tasks')
    expect(screen.getByLabelText('Key')).toHaveValue('TASK')
    expect(screen.getByLabelText('Description')).toHaveValue('ops')
  })

  it('shows a stable validation message on invalid_payload_hash (422) without leaking axios text', async () => {
    const invalid = axiosError(422, {
      detail: { code: 'invalid_payload_hash', retryable: false, details: {} },
    })
    const onCreate = vi.fn().mockRejectedValue(invalid)
    const { container } = render(createElement(ProjectRail, {
      projects: [],
      selectedId: null,
      onSelect: vi.fn(),
      onCreate,
    }))

    openDialog()
    fillForm('Tasks', 'TASK', '')
    submitForm(container)

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('请求内容校验失败，请刷新后重试。')
    })
    expect(screen.queryByText(/Request failed with status code 422/)).toBeNull()
    expect(screen.queryByRole('heading', { name: 'Create project' })).not.toBeNull()
    expect(screen.getByLabelText('Name')).toHaveValue('Tasks')
    expect(screen.getByLabelText('Key')).toHaveValue('TASK')
  })

  it('unmounts safely while a create request is pending', async () => {
    const pending = deferred<CachedProject>()
    const onCreate = vi.fn(() => pending.promise)
    const { container, unmount } = render(createElement(ProjectRail, {
      projects: [],
      selectedId: null,
      onSelect: vi.fn(),
      onCreate,
    }))

    openDialog()
    fillForm()
    submitForm(container)
    expect(onCreate).toHaveBeenCalledTimes(1)

    unmount()
    pending.reject(new Error('late rejection after unmount'))

    // Resolve must also settle silently: no unhandled rejection, no store writes.
    await waitFor(() => {
      expect(onCreate).toHaveBeenCalledTimes(1)
    })
  })

  it('shows a closed generic message for network or unknown errors', async () => {
    const network = axiosError(0, 'Network Error')
    const onCreate = vi.fn().mockRejectedValue(network)
    const { container } = render(createElement(ProjectRail, {
      projects: [],
      selectedId: null,
      onSelect: vi.fn(),
      onCreate,
    }))

    openDialog()
    fillForm()
    submitForm(container)

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('无法创建项目，请检查服务连接后重试。')
    })
    expect(screen.queryByText('Network Error')).toBeNull()
    expect(screen.queryByRole('heading', { name: 'Create project' })).not.toBeNull()
  })
})

describe('resolveCreateProjectError', () => {
  it('maps project_key_conflict from a structured detail object', () => {
    const error = axiosError(409, { detail: { code: 'project_key_conflict', retryable: false, details: {} } })
    expect(resolveCreateProjectError(error)).toBe('该 Key 已被当前空间使用，请更换 Key。')
  })

  it('maps project_key_conflict from a legacy string detail plus error-code header', () => {
    const error = axiosError(409, { detail: 'Project key conflict', error_type: 'conflict' }, {
      'x-pomodoroxii-error-code': 'project_key_conflict',
    })
    expect(resolveCreateProjectError(error)).toBe('该 Key 已被当前空间使用，请更换 Key。')
  })

  it('maps project_key_conflict from a canonical top-level code', () => {
    const error = axiosError(409, { code: 'project_key_conflict', message: 'Project key conflict', retryable: false, details: {} })
    expect(resolveCreateProjectError(error)).toBe('该 Key 已被当前空间使用，请更换 Key。')
  })

  it('maps invalid_payload_hash to a stable validation message', () => {
    const error = axiosError(422, { detail: { code: 'invalid_payload_hash', retryable: false, details: {} } })
    expect(resolveCreateProjectError(error)).toBe('请求内容校验失败，请刷新后重试。')
  })

  it('never leaks raw axios text for unknown statuses', () => {
    const error = axiosError(500, { detail: 'boom' })
    expect(resolveCreateProjectError(error)).toBe('无法创建项目，请检查服务连接后重试。')
    expect(resolveCreateProjectError(new Error('plain error'))).toBe('无法创建项目，请检查服务连接后重试。')
    expect(resolveCreateProjectError(null)).toBe('无法创建项目，请检查服务连接后重试。')
  })
})
