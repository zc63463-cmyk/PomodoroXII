import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement, type ReactNode } from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QuickNotesView } from '@/components/quick-notes/quick-notes-view'
import { wireSyncEngineToStore } from '@/lib/sync'
import { createQuickNote } from '@/lib/quick-notes/quick-note-repository'
import { db, spaceDBManager } from '@/services/space-db'
import {
  useQuickNoteStore,
} from '@/stores/quick-note-store'
import { useSyncStore } from '@/stores/sync-store'
import type { CachedQuickNote } from '@/types'

type FakeSyncEngine = {
  getPendingCount: ReturnType<typeof vi.fn>
  getStatus: ReturnType<typeof vi.fn>
  getLastSyncedAt: ReturnType<typeof vi.fn>
  getConflicts: ReturnType<typeof vi.fn>
  onPullComplete: ReturnType<typeof vi.fn>
  onPushComplete: ReturnType<typeof vi.fn>
  onConflict: ReturnType<typeof vi.fn>
  onSyncComplete: ReturnType<typeof vi.fn>
  callbacks: {
    pullComplete: (() => void) | null
    pushComplete: (() => void) | null
    syncComplete: (() => void) | null
  }
}

vi.mock('lucide-react', () => ({
  ArchiveRestoreIcon: () =>
    createElement('span', { 'data-testid': 'archive-restore-icon' }),
  FileTextIcon: () => createElement('span', { 'data-testid': 'file-text-icon' }),
  GitMergeIcon: () => createElement('span', { 'data-testid': 'merge-icon' }),
  PinIcon: () => createElement('span', { 'data-testid': 'pin-icon' }),
  PlusIcon: () => createElement('span', { 'data-testid': 'plus-icon' }),
  SearchIcon: () => createElement('span', { 'data-testid': 'search-icon' }),
  Trash2Icon: () => createElement('span', { 'data-testid': 'trash-icon' }),
  XIcon: () => createElement('span', { 'data-testid': 'x-icon' }),
}))

const toastMock = vi.hoisted(() =>
  Object.assign(vi.fn((_message: string) => undefined), {
    error: vi.fn((_message: string, _options?: { description?: string }) => undefined),
  }),
)

vi.mock('sonner', () => ({
  toast: toastMock,
}))

vi.mock('@/components/ui/button', () => ({
  Button: ({
    children,
    ...props
  }: {
    children?: ReactNode
    [key: string]: unknown
  }) => createElement('button', props, children),
}))

vi.mock('@/components/ui/input', () => ({
  Input: (props: { [key: string]: unknown }) => createElement('input', props),
}))

vi.mock('@/lib/quick-notes/quick-note-preview', () => ({
  ensureQuickNotePreviewSpace: vi.fn().mockResolvedValue(undefined),
}))

function makeFakeSyncEngine(status = 'idle'): FakeSyncEngine {
  const callbacks: FakeSyncEngine['callbacks'] = {
    pullComplete: null,
    pushComplete: null,
    syncComplete: null,
  }

  return {
    callbacks,
    getPendingCount: vi.fn().mockReturnValue(1),
    getStatus: vi.fn().mockReturnValue(status),
    getLastSyncedAt: vi.fn().mockReturnValue(null),
    getConflicts: vi.fn().mockReturnValue([]),
    onPullComplete: vi.fn((cb: () => void) => {
      callbacks.pullComplete = cb
      return () => undefined
    }),
    onPushComplete: vi.fn((cb: () => void) => {
      callbacks.pushComplete = cb
      return () => undefined
    }),
    onConflict: vi.fn().mockReturnValue(() => undefined),
    onSyncComplete: vi.fn((cb: () => void) => {
      callbacks.syncComplete = cb
      return () => undefined
    }),
  }
}

function wireFakeSyncEngine(engine: FakeSyncEngine): void {
  wireSyncEngineToStore(
    engine as unknown as Parameters<typeof wireSyncEngineToStore>[0],
    'space-1',
  )
}

describe('QuickNotesView runtime sync refresh', () => {
  beforeEach(async () => {
    useQuickNoteStore.getState().reset()
    useSyncStore.getState().reset()
    await spaceDBManager.switchTo(`quick-note-runtime-sync-${crypto.randomUUID()}`)
    toastMock.mockClear()
    toastMock.error.mockClear()
  })

  afterEach(async () => {
    useQuickNoteStore.getState().reset()
    useSyncStore.getState().reset()
    await db.delete()
    spaceDBManager.close()
  })

  it('renders an active card through the real repository and store', async () => {
    await createQuickNote({
      id: 'runtime-active',
      content: '真实运行时卡片\n由 repository 写入',
      created_at: '2026-07-07T13:00:00.000Z',
      updated_at: '2026-07-07T13:00:00.000Z',
    })

    render(createElement(QuickNotesView))

    expect(await screen.findByRole('button', { name: /真实运行时卡片/ })).toBeInTheDocument()
    expect(screen.getByText('待同步')).toBeInTheDocument()
  })

  it('refreshes from a visible card to empty state after a pull tombstone', async () => {
    await createQuickNote({
      id: 'runtime-tombstone',
      content: '会被 pull tombstone 移除的卡片',
      created_at: '2026-07-07T13:00:00.000Z',
      updated_at: '2026-07-07T13:00:00.000Z',
    })

    render(createElement(QuickNotesView))

    expect(
      await screen.findByRole('button', { name: /会被 pull tombstone 移除的卡片/ }),
    ).toBeInTheDocument()

    await act(async () => {
      await db.quickNotes.update('runtime-tombstone', {
        deletion_state: 'deleted',
        _dirty: false,
      } satisfies Partial<CachedQuickNote>)
      await useQuickNoteStore.getState().refreshQuickNotesFromRepository()
    })

    await waitFor(() => {
      expect(
        screen.queryByRole('button', { name: /会被 pull tombstone 移除的卡片/ }),
      ).not.toBeInTheDocument()
    })
    expect(screen.getByText('还没有小记')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '回收站' })).toBeInTheDocument()
  })

  it('refreshes from a visible card to empty state through onPullComplete wiring', async () => {
    await createQuickNote({
      id: 'runtime-wired-pull',
      content: '通过 sync callback 移除的卡片',
      created_at: '2026-07-07T13:00:00.000Z',
      updated_at: '2026-07-07T13:00:00.000Z',
    })
    const engine = makeFakeSyncEngine()
    wireFakeSyncEngine(engine)

    render(createElement(QuickNotesView))

    expect(
      await screen.findByRole('button', { name: /通过 sync callback 移除的卡片/ }),
    ).toBeInTheDocument()

    await act(async () => {
      await db.quickNotes.update('runtime-wired-pull', {
        deletion_state: 'deleted',
        _dirty: false,
      } satisfies Partial<CachedQuickNote>)
      engine.callbacks.pullComplete?.()
    })

    await waitFor(() => {
      expect(
        screen.queryByRole('button', { name: /通过 sync callback 移除的卡片/ }),
      ).not.toBeInTheDocument()
    })
    expect(screen.getByText('还没有小记')).toBeInTheDocument()
  })

  it('refreshes active and trash UI after sync moves a note to trash', async () => {
    await createQuickNote({
      id: 'runtime-soft-delete',
      content: '同步软删后进入回收站',
      created_at: '2026-07-07T13:00:00.000Z',
      updated_at: '2026-07-07T13:00:00.000Z',
    })

    render(createElement(QuickNotesView))

    expect(
      await screen.findByRole('button', { name: /同步软删后进入回收站/ }),
    ).toBeInTheDocument()

    await act(async () => {
      await db.quickNotes.update('runtime-soft-delete', {
        trashed_at: '2026-07-07T13:30:00.000Z',
        deletion_state: 'deleted',
        _dirty: false,
      } satisfies Partial<CachedQuickNote>)
      await useQuickNoteStore.getState().refreshQuickNotesFromRepository()
    })

    await waitFor(() => {
      expect(
        screen.queryByRole('button', { name: /同步软删后进入回收站/ }),
      ).not.toBeInTheDocument()
    })
    expect(screen.getByRole('button', { name: /回收站 1/ })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /回收站 1/ }))
    expect(await screen.findByText('同步软删后进入回收站')).toBeInTheDocument()
  })

  it('clears pending status after push completion refreshes a clean local row', async () => {
    await useQuickNoteStore.getState().createQuickNote({
      id: 'runtime-push-clean',
      content: 'push 完成后状态消失',
      created_at: '2026-07-07T13:00:00.000Z',
      updated_at: '2026-07-07T13:00:00.000Z',
    })

    render(createElement(QuickNotesView))

    expect(await screen.findByRole('button', { name: /push 完成后状态消失/ })).toBeInTheDocument()
    expect(screen.getByText('待同步')).toBeInTheDocument()

    await act(async () => {
      await db.outbox.clear()
      await db.quickNotes.update('runtime-push-clean', { _dirty: false })
      await useQuickNoteStore.getState().refreshQuickNotesFromRepository()
    })

    expect(screen.getByRole('button', { name: /push 完成后状态消失/ })).toBeInTheDocument()
    await waitFor(() => {
      expect(screen.queryByText('待同步')).not.toBeInTheDocument()
    })
  })

  it('refreshes only the matching pending card to failed from outbox event error metadata', async () => {
    await useQuickNoteStore.getState().createQuickNote({
      id: 'runtime-sync-failed',
      content: '同步失败后显示失败状态',
      created_at: '2026-07-07T13:00:00.000Z',
      updated_at: '2026-07-07T13:00:00.000Z',
    })
    await useQuickNoteStore.getState().createQuickNote({
      id: 'runtime-sync-pending',
      content: '仍然只是待同步状态',
      created_at: '2026-07-07T13:01:00.000Z',
      updated_at: '2026-07-07T13:01:00.000Z',
    })
    const engine = makeFakeSyncEngine('infra-error')
    wireFakeSyncEngine(engine)

    render(createElement(QuickNotesView))

    expect(await screen.findByRole('button', { name: /同步失败后显示失败状态/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /仍然只是待同步状态/ })).toBeInTheDocument()
    expect(screen.getAllByText('待同步')).toHaveLength(2)

    await act(async () => {
      const failedOutbox = await db.outbox
        .where('entityId')
        .equals('runtime-sync-failed')
        .first()
      await db.outbox.update(failedOutbox!.id!, {
        lastError: 'server_rejected_quick_note',
        lastErrorCode: 'push_error',
        failedAt: '2026-07-07T13:10:00.000Z',
        attemptCount: 1,
      })
      engine.callbacks.syncComplete?.()
    })

    await waitFor(() => {
      expect(screen.getByText('同步失败，可稍后重试')).toBeInTheDocument()
    })
    expect(screen.getByText('待同步')).toBeInTheDocument()
    expect(useSyncStore.getState()).toMatchObject({
      status: 'infra-error',
      error: '网络异常，同步暂停',
    })
  })
})
