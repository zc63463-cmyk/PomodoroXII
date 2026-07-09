import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { quickNoteStyles } from '@/components/quick-notes/quick-note-styles'

const globalsCss = readFileSync(
  join(process.cwd(), 'src/app/globals.css'),
  'utf8',
)

const requiredThemeSelectors = [
  '.quick-notes-surface',
  '.dark .quick-notes-surface',
  '.midnight .quick-notes-surface',
  '.nord .quick-notes-surface',
  '.daylight .quick-notes-surface',
]

const requiredTokens = [
  '--qn-page-text',
  '--qn-text',
  '--qn-text-strong',
  '--qn-muted',
  '--qn-panel',
  '--qn-card',
  '--qn-field',
  '--qn-accent',
  '--qn-accent-foreground',
  '--qn-page-bg',
  '--qn-title-gradient',
]

describe('quick-note theme smoke', () => {
  it('defines QuickNote token blocks for every supported visual theme', () => {
    for (const selector of requiredThemeSelectors) {
      const block = getCssBlock(globalsCss, selector)

      expect(block, `${selector} block should exist`).not.toBeNull()
      for (const token of requiredTokens) {
        expect(block, `${selector} should define ${token}`).toContain(`${token}:`)
      }
    }
  })

  it('keeps QuickNote component styles on local qn visual tokens', () => {
    const styleClassNames = Object.values(quickNoteStyles).join(' ')

    expect(styleClassNames).toContain('quick-notes-surface')
    expect(styleClassNames).toContain('var(--qn-')
    expect(styleClassNames).toContain('quick-note-stage')
    expect(styleClassNames).toContain('quick-note-motion-panel')
    expect(styleClassNames).not.toContain('quick-note-timeline-dimmed')
    expect(styleClassNames).not.toMatch(/text-(white|black|slate|gray|zinc|neutral)-\d+/)
    expect(styleClassNames).not.toMatch(/bg-(slate|gray|zinc|neutral|blue|purple)-\d+/)
  })

  it('keeps explorer selected states visibly accented in dark themes', () => {
    expect(quickNoteStyles.explorerSegmentButtonActive).toContain(
      'bg-[color:var(--qn-accent)]',
    )
    expect(quickNoteStyles.explorerSegmentButtonActive).toContain(
      'text-[color:var(--qn-accent-foreground)]',
    )
    expect(quickNoteStyles.explorerTagSelected).toContain(
      '!bg-[color:var(--qn-accent)]',
    )
    expect(quickNoteStyles.explorerCalendarCellSelected).toContain(
      '!bg-[color:var(--qn-accent)]',
    )
  })

  it('defines restrained QuickNote motion primitives with reduced-motion fallback', () => {
    for (const keyframeName of [
      'qn-stage-enter',
      'qn-stage-detail-read',
      'qn-panel-enter',
      'qn-panel-slide-in',
      'qn-inline-editor-enter',
    ]) {
      expect(globalsCss).toContain(`@keyframes ${keyframeName}`)
    }

    expect(globalsCss).toContain('.quick-note-stage')
    expect(globalsCss).toContain('.quick-note-motion-panel')
    expect(globalsCss).not.toContain('qn-stage-focus-edit')
    expect(globalsCss).not.toContain('.quick-note-timeline-dimmed')
    expect(globalsCss).not.toContain('qn-stage-focus-read')
    expect(globalsCss).toContain('@media (prefers-reduced-motion: reduce)')
  })

  it('keeps focus-edit as an in-place column expansion instead of a full-stage transition', () => {
    const focusEditStageBlock = getCssBlock(
      globalsCss,
      ".quick-note-stage[data-focus-stage='focus-edit']",
    )

    expect(focusEditStageBlock).toContain('animation-name: qn-stage-enter')
    expect(focusEditStageBlock).not.toContain('qn-stage-focus-edit')
  })
})

function getCssBlock(source: string, selector: string): string | null {
  const selectorIndex = source.indexOf(`${selector} {`)
  if (selectorIndex === -1) return null

  const openIndex = source.indexOf('{', selectorIndex)
  if (openIndex === -1) return null

  let depth = 0
  for (let index = openIndex; index < source.length; index += 1) {
    const char = source[index]
    if (char === '{') depth += 1
    if (char === '}') depth -= 1
    if (depth === 0) return source.slice(openIndex + 1, index)
  }

  return null
}
