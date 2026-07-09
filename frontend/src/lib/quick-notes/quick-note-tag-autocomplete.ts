import { normalizeQuickNoteTag } from '@/lib/quick-notes/quick-note-tags'

const MAX_TAG_AUTOCOMPLETE_SUGGESTIONS = 8

export interface QuickNoteTagAutocompleteRange {
  start: number
  end: number
}

export interface QuickNoteTagAutocompleteState {
  query: string
  range: QuickNoteTagAutocompleteRange
  suggestions: string[]
}

export function getQuickNoteTagAutocompleteState(
  value: string,
  caretIndex: number,
  tags: string[],
): QuickNoteTagAutocompleteState | null {
  const boundedCaret = Math.max(0, Math.min(caretIndex, value.length))
  const tokenStart = findTokenStart(value, boundedCaret)

  if (value[tokenStart] !== '#') return null
  if (tokenStart > 0 && !/\s/.test(value[tokenStart - 1])) return null

  const query = value.slice(tokenStart + 1, boundedCaret)
  if (/\s/.test(query)) return null

  const normalizedQuery = normalizeQuickNoteTag(query)
  const suggestions = getTagSuggestions(tags, normalizedQuery)

  return {
    query: normalizedQuery,
    range: { start: tokenStart, end: boundedCaret },
    suggestions,
  }
}

export function applyQuickNoteTagAutocomplete(
  value: string,
  range: QuickNoteTagAutocompleteRange,
  tag: string,
): { value: string; caretIndex: number } {
  const normalizedTag = normalizeQuickNoteTag(tag)
  const before = value.slice(0, range.start)
  const after = value.slice(range.end).replace(/^\s/, '')
  const inserted = `#${normalizedTag} `

  return {
    value: `${before}${inserted}${after}`,
    caretIndex: before.length + inserted.length,
  }
}

function findTokenStart(value: string, caretIndex: number): number {
  let index = caretIndex
  while (index > 0 && !/\s/.test(value[index - 1] ?? '')) index -= 1
  return index
}

function getTagSuggestions(tags: string[], query: string): string[] {
  const suggestions: string[] = []
  const seen = new Set<string>()

  for (const tag of tags) {
    const normalizedTag = normalizeQuickNoteTag(tag)
    if (!normalizedTag || seen.has(normalizedTag)) continue
    if (query && !normalizedTag.includes(query)) continue

    seen.add(normalizedTag)
    suggestions.push(normalizedTag)
    if (suggestions.length >= MAX_TAG_AUTOCOMPLETE_SUGGESTIONS) break
  }

  return suggestions
}
