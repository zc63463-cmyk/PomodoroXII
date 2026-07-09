const QUICK_NOTE_TAG_PATTERN = /#[\p{L}\p{N}_-]+(?:\/[\p{L}\p{N}_-]+)*/gu

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

export function cleanupQuickNoteTags(tags: string[]): string[] {
  return normalizeQuickNoteTags(tags)
}

export function renameQuickNoteTagInList(
  tags: string[],
  from: string,
  to: string,
): string[] {
  const fromTag = normalizeQuickNoteTag(from)
  const toTag = normalizeQuickNoteTag(to)
  if (!fromTag || !toTag) return cleanupQuickNoteTags(tags)

  return normalizeQuickNoteTags(
    tags.map((tag) => (normalizeQuickNoteTag(tag) === fromTag ? toTag : tag)),
  )
}

export function replaceInlineQuickNoteHashtag(
  content: string,
  from: string,
  to: string,
): string {
  const fromTag = normalizeQuickNoteTag(from)
  const toTag = normalizeQuickNoteTag(to)
  if (!fromTag || !toTag || fromTag.includes('/') || toTag.includes('/')) {
    return content
  }

  return content.replace(QUICK_NOTE_TAG_PATTERN, (match, offset: number, source: string) => {
    if (source[offset + match.length] === '/') return match
    const tag = normalizeQuickNoteTag(match)
    return tag === fromTag ? `#${toTag}` : match
  })
}
