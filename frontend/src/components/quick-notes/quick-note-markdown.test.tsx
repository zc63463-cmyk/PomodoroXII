import { createElement } from 'react'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { QuickNoteMarkdown } from '@/components/quick-notes/quick-note-markdown'

describe('QuickNoteMarkdown', () => {
  it('renders unsafe markdown links as inert text instead of empty clickable links', () => {
    render(createElement(QuickNoteMarkdown, {
      content: [
        '[javascript link](javascript:alert(1))',
        '[data link](data:text/html;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+)',
        '[safe link](https://example.com/docs)',
      ].join('\n\n'),
    }))

    expect(screen.queryByRole('link', { name: 'javascript link' })).toBeNull()
    expect(screen.queryByRole('link', { name: 'data link' })).toBeNull()
    expect(screen.getByText('javascript link').closest('a')).toBeNull()
    expect(screen.getByText('data link').closest('a')).toBeNull()
    expect(screen.getByRole('link', { name: 'safe link' })).toHaveAttribute(
      'href',
      'https://example.com/docs',
    )
  })

  it('wraps GFM tables in a horizontal overflow container', () => {
    const { container } = render(createElement(QuickNoteMarkdown, {
      content: [
        '| Wide heading | Another heading |',
        '| --- | --- |',
        '| A long cell value | Another long cell value |',
      ].join('\n'),
      variant: 'preview',
    }))

    const table = container.querySelector('table')
    expect(table).not.toBeNull()
    expect(table?.parentElement).toHaveClass('quick-note-markdown-table-scroll')
  })
})
