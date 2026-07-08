'use client'

import { createElement } from 'react'
import {
  getQuickNoteEditorStatusMeta,
  type QuickNoteEditorStatus,
  type QuickNoteEditorStatusTone,
} from '@/lib/quick-notes/quick-note-editor-status'
import { cn } from '@/lib/utils'

const toneClassNameByStatusTone: Record<QuickNoteEditorStatusTone, string> = {
  muted:
    'border-[color:var(--qn-border)] bg-[color:var(--qn-panel-muted)] text-[color:var(--qn-muted)]',
  info:
    'border-[color:var(--qn-border-strong)] bg-[color:var(--qn-accent-soft)] text-[color:var(--qn-accent-readable)]',
  success:
    'border-[color:var(--qn-border)] bg-[color:var(--qn-chip)] text-[color:var(--qn-accent-readable)]',
  warning:
    'border-[color:var(--qn-border-strong)] bg-[color:var(--qn-accent-soft)] text-[color:var(--qn-accent-readable)]',
  danger:
    'border-[color:var(--qn-danger-border)] bg-[color:var(--qn-danger-soft)] text-[color:var(--qn-danger)]',
}

export function QuickNoteEditorStatusLine({
  status,
  fallbackText,
  className,
}: {
  status: QuickNoteEditorStatus | null
  fallbackText?: string
  className?: string
}) {
  const meta = status ? getQuickNoteEditorStatusMeta(status) : null
  const text = meta?.text ?? fallbackText

  if (!text) return null

  const tone = meta?.tone ?? 'muted'

  return createElement(
    'span',
    {
      className: cn(
        'inline-flex w-fit items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs leading-none transition-colors',
        toneClassNameByStatusTone[tone],
        className,
      ),
      'data-quick-note-editor-status': true,
      'data-status': status ?? 'idle',
      'aria-live': meta?.ariaLive ?? 'off',
    },
    createElement('span', {
      className: cn(
        'size-1.5 rounded-full',
        tone === 'danger'
          ? 'bg-[color:var(--qn-danger)]'
          : tone === 'muted'
            ? 'bg-[color:var(--qn-subtle)]'
            : 'bg-[color:var(--qn-accent-readable)]',
      ),
      'aria-hidden': true,
    }),
    text,
  )
}
