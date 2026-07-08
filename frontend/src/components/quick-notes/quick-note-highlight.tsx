'use client'

import { createElement, Fragment, type ReactNode } from 'react'
import { quickNoteStyles } from '@/components/quick-notes/quick-note-styles'
import { getQuickNoteSearchNeedle } from '@/lib/quick-notes/quick-note-selectors'

export function renderHighlightedText(text: string, query: string): ReactNode {
  const needle = getQuickNoteSearchNeedle(query)
  if (!needle) return text

  const source = text.toLowerCase()
  const target = needle.toLowerCase()
  const parts: ReactNode[] = []
  let cursor = 0
  let index = source.indexOf(target)

  while (index !== -1) {
    if (index > cursor) parts.push(text.slice(cursor, index))
    parts.push(
      createElement(
        'mark',
        { key: `${index}-${target}`, className: quickNoteStyles.mark },
        text.slice(index, index + target.length),
      ),
    )
    cursor = index + target.length
    index = source.indexOf(target, cursor)
  }

  if (cursor < text.length) parts.push(text.slice(cursor))
  return createElement(Fragment, null, ...parts)
}
