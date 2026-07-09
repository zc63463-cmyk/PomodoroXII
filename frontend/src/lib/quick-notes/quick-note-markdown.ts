const SAFE_ABSOLUTE_PROTOCOLS = new Set(['http:', 'https:', 'mailto:', 'tel:'])
const ABSOLUTE_PROTOCOL_PATTERN = /^[a-z][a-z\d+.-]*:/i

export interface QuickNoteSafeLinkProps {
  href: string
  target: '_blank'
  rel: 'noreferrer'
}

export function getQuickNoteSafeLinkProps(
  href: string | undefined,
): QuickNoteSafeLinkProps {
  return {
    href: normalizeQuickNoteMarkdownUrl(href),
    target: '_blank',
    rel: 'noreferrer',
  }
}

export function normalizeQuickNoteMarkdownUrl(href: string | undefined): string {
  const value = href?.trim() ?? ''
  if (!value) return ''

  if (!ABSOLUTE_PROTOCOL_PATTERN.test(value)) return value

  try {
    const url = new URL(value)
    return SAFE_ABSOLUTE_PROTOCOLS.has(url.protocol) ? value : ''
  } catch {
    return ''
  }
}

export function getQuickNoteImageFallbackLabel({
  alt,
  src,
}: {
  alt?: string
  src?: string
}): string {
  const cleanAlt = alt?.trim() ?? ''
  const cleanSrc = normalizeQuickNoteMarkdownUrl(src)

  if (cleanAlt && cleanSrc) return `${cleanAlt}: ${cleanSrc}`
  if (cleanAlt) return cleanAlt
  if (cleanSrc) return cleanSrc
  return 'image'
}
