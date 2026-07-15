import { describe, expect, it } from 'vitest'
import { isQuickNotePreviewRoute } from '@/lib/quick-notes/quick-note-preview'

describe('isQuickNotePreviewRoute', () => {
  it.each(['/quick-notes', '/notes'])('allows the Quick Notes workspace route %s', (route) => {
    expect(isQuickNotePreviewRoute(route)).toBe(true)
  })

  it('does not bypass auth for unrelated application routes', () => {
    expect(isQuickNotePreviewRoute('/tasks')).toBe(false)
  })
})
