import { describe, expect, it, vi } from 'vitest'

vi.mock('@/components/quick-notes/quick-notes-view', () => ({
  QuickNotesView: function QuickNotesView() { return null },
}))

import { QuickNotesView } from '@/components/quick-notes/quick-notes-view'
import NotesPage from './page'

describe('NotesPage', () => {
  it('renders the Quick Notes workspace and forwards a compose request', async () => {
    const page = await NotesPage({
      searchParams: Promise.resolve({ compose: 'palette-request-1' }),
    })

    expect(page.type).toBe(QuickNotesView)
    expect(page.props).toMatchObject({ composeRequestKey: 'palette-request-1' })
  })
})
