import { describe, expect, it } from 'vitest'
import {
  getQuickNoteImageFallbackLabel,
  getQuickNoteSafeLinkProps,
  normalizeQuickNoteMarkdownUrl,
} from '@/lib/quick-notes/quick-note-markdown'

describe('quick note markdown policy', () => {
  it('adds safe external-link attributes to rendered markdown links', () => {
    expect(getQuickNoteSafeLinkProps('https://example.com/docs')).toEqual({
      href: 'https://example.com/docs',
      target: '_blank',
      rel: 'noreferrer',
    })
  })

  it('keeps image markdown as a safe textual link label', () => {
    expect(getQuickNoteImageFallbackLabel({
      alt: 'diagram',
      src: 'https://example.com/diagram.png',
    })).toBe('diagram: https://example.com/diagram.png')
  })

  it.each([
    'javascript:alert(1)',
    'data:text/html,<svg onload=alert(1)>',
  ])('rejects unsafe markdown link protocol %s', (href) => {
    expect(normalizeQuickNoteMarkdownUrl(href)).toBe('')
  })
})
