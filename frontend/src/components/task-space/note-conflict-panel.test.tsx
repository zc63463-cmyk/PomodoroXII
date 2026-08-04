import { createElement, type ReactNode } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { WorkItemNoteConflictRow } from '@/types'

vi.mock('@/components/ui/button', () => ({
  Button: ({ children, ...props }: { children?: ReactNode } & Record<string, unknown>) => createElement('button', props, children),
}))

import { NoteConflictPanel } from './note-conflict-panel'

const conflict: WorkItemNoteConflictRow = {
  spaceId: 'space-1',
  workItemId: 'work-item-1',
  noteId: 'note-1',
  localDocument: { contentVersion: 1, blocks: [{ type: 'paragraph', blockId: 'local', text: 'Local copy' }] },
  localRevision: 4,
  baseVersion: 2,
  remoteDocument: { contentVersion: 1, blocks: [{ type: 'paragraph', blockId: 'remote', text: 'Remote copy' }] },
  remoteVersion: 3,
  detectedAt: '2026-07-15T08:00:00.000Z',
}

describe('NoteConflictPanel', () => {
  it('shows both read-only versions and only explicit reload/overwrite decisions', () => {
    const onReloadRemote = vi.fn()
    const onOverwriteLocal = vi.fn()
    render(createElement(NoteConflictPanel, { conflict, onReloadRemote, onOverwriteLocal }))

    expect(screen.getByRole('heading', { name: 'Work item note conflict' })).toBeVisible()
    expect(screen.getByText('Local revision 4')).toBeVisible()
    expect(screen.getByText('Remote version 3')).toBeVisible()
    expect(screen.getByText('Local copy')).toBeVisible()
    expect(screen.getByText('Remote copy')).toBeVisible()
    expect(screen.queryByRole('button', { name: /merge/i })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Reload remote' }))
    fireEvent.click(screen.getByRole('button', { name: 'Use reviewed local copy' }))
    expect(onReloadRemote).toHaveBeenCalledOnce()
    expect(onOverwriteLocal).toHaveBeenCalledOnce()
  })
})
