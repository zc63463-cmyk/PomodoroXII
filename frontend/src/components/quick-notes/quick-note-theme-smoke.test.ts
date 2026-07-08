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
    expect(styleClassNames).not.toMatch(/text-(white|black|slate|gray|zinc|neutral)-\d+/)
    expect(styleClassNames).not.toMatch(/bg-(slate|gray|zinc|neutral|blue|purple)-\d+/)
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
