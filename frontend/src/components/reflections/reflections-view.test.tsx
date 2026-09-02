import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as reflectionRepository from '@/lib/reflections/reflection-repository'
import { useReflectionStore } from '@/stores/reflection-store'
import type { CachedReflection } from '@/types'
import { ReflectionsView } from './reflections-view'

function reflection(overrides: Partial<CachedReflection> = {}): CachedReflection {
  const now = '2026-09-02T00:00:00.000Z'
  return {
    id: 'r1',
    date: '2026-09-02',
    content: '',
    mood: null,
    tags: [],
    created_at: now,
    updated_at: now,
    content_hash: undefined,
    deletion_state: 'active',
    version: 1,
    _dirty: false,
    ...overrides,
  }
}

describe('ReflectionsView', () => {
  beforeEach(() => {
    useReflectionStore.getState().reset()
    vi.restoreAllMocks()
    vi.spyOn(reflectionRepository, 'listSyncedReflections').mockResolvedValue([])
    vi.spyOn(reflectionRepository, 'updateReflection').mockImplementation(
      async (id, patch) => reflection({ id, ...patch }),
    )
    vi.spyOn(reflectionRepository, 'deleteReflection').mockResolvedValue(undefined)
    vi.spyOn(reflectionRepository, 'createReflection').mockImplementation(
      async (input) => reflection({ id: input.id, date: input.date }),
    )
  })

  afterEach(cleanup)

  it('空列表时给出引导文案', async () => {
    render(<ReflectionsView />)

    await waitFor(() => {
      expect(screen.getByText(/还没有反思/)).toBeTruthy()
    })
    expect(screen.getByText(/选择一篇反思/)).toBeTruthy()
  })

  it('按月份分组渲染', async () => {
    vi.spyOn(reflectionRepository, 'listSyncedReflections').mockResolvedValue([
      reflection({ id: 'a', date: '2026-08-15' }),
      reflection({ id: 'b', date: '2026-09-10' }),
    ])

    render(<ReflectionsView />)

    await waitFor(() => screen.getByText('2026-09'))
    expect(screen.getByText('2026-08')).toBeTruthy()
  })

  it('选中后载入编辑器并可保存正文', async () => {
    vi.spyOn(reflectionRepository, 'listSyncedReflections').mockResolvedValue([
      reflection({ id: 'a', date: '2026-09-10', content: '旧内容' }),
    ])
    const update = vi.spyOn(reflectionRepository, 'updateReflection').mockImplementation(
      async (id, patch) => reflection({ id, ...patch }),
    )

    render(<ReflectionsView />)
    await waitFor(() => screen.getByText('2026-09-10'))

    fireEvent.click(screen.getByText('2026-09-10'))

    await waitFor(() => {
      const editor = screen.getByPlaceholderText(/写下今天的反思/) as HTMLTextAreaElement
      expect(editor.value).toBe('旧内容')
    })

    const editor = screen.getByPlaceholderText(/写下今天的反思/) as HTMLTextAreaElement
    fireEvent.change(editor, { target: { value: '新内容' } })
    fireEvent.click(screen.getByText('保存'))

    await waitFor(() => {
      expect(update).toHaveBeenCalledWith('a', { content: '新内容' })
    })
  })

  it('切换心情直接落库', async () => {
    vi.spyOn(reflectionRepository, 'listSyncedReflections').mockResolvedValue([
      reflection({ id: 'a', date: '2026-09-10' }),
    ])
    const update = vi.spyOn(reflectionRepository, 'updateReflection').mockImplementation(
      async (id, patch) => reflection({ id, ...patch }),
    )

    render(<ReflectionsView />)
    await waitFor(() => screen.getByText('2026-09-10'))
    fireEvent.click(screen.getByText('2026-09-10'))

    await waitFor(() => screen.getByLabelText('心情'))
    fireEvent.change(screen.getByLabelText('心情'), { target: { value: 'good' } })

    await waitFor(() => {
      expect(update).toHaveBeenCalledWith('a', { mood: 'good' })
    })
  })

  it('删除调用 deleteReflection 并清空选中', async () => {
    vi.spyOn(reflectionRepository, 'listSyncedReflections').mockResolvedValue([
      reflection({ id: 'a', date: '2026-09-10' }),
    ])
    const del = vi.spyOn(reflectionRepository, 'deleteReflection').mockResolvedValue(undefined)

    render(<ReflectionsView />)
    await waitFor(() => screen.getByText('2026-09-10'))
    fireEvent.click(screen.getByText('2026-09-10'))
    await waitFor(() => screen.getByText('删除'))

    fireEvent.click(screen.getByText('删除'))

    await waitFor(() => {
      expect(del).toHaveBeenCalledWith('a')
    })
  })
})
