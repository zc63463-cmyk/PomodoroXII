const QUICK_NOTE_TAG_PATTERN = /#[\p{L}\p{N}_-]+/gu

export function extractQuickNoteTags(content: string): string[] {
  return normalizeQuickNoteTags(content.match(QUICK_NOTE_TAG_PATTERN) ?? [])
}

export function mergeQuickNoteTags(...tagGroups: Array<string[] | undefined>): string[] {
  return normalizeQuickNoteTags(tagGroups.flatMap((tags) => tags ?? []))
}

export function normalizeQuickNoteTag(tag: string): string {
  return tag.trim().replace(/^#+/, '').toLowerCase()
}

export function normalizeQuickNoteTags(tags: string[]): string[] {
  const normalized: string[] = []
  const seen = new Set<string>()

  for (const tag of tags) {
    const normalizedTag = normalizeQuickNoteTag(tag)
    if (!normalizedTag || seen.has(normalizedTag)) continue
    seen.add(normalizedTag)
    normalized.push(normalizedTag)
  }

  return normalized
}
