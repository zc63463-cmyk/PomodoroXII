'use client'

import { createElement, type ComponentPropsWithoutRef, type ReactNode } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { quickNoteStyles } from '@/components/quick-notes/quick-note-styles'
import {
  getQuickNoteImageFallbackLabel,
  getQuickNoteSafeLinkProps,
} from '@/lib/quick-notes/quick-note-markdown'
import { cn } from '@/lib/utils'

export type QuickNoteMarkdownVariant = 'preview' | 'read' | 'inline-preview'

interface QuickNoteMarkdownProps {
  content: string
  variant?: QuickNoteMarkdownVariant
  className?: string
}

type MarkdownAnchorProps = ComponentPropsWithoutRef<'a'> & {
  node?: unknown
}

type MarkdownImageProps = ComponentPropsWithoutRef<'img'> & {
  node?: unknown
}

type MarkdownTableProps = ComponentPropsWithoutRef<'table'> & {
  node?: unknown
}

export function QuickNoteMarkdown({
  content,
  variant = 'read',
  className,
}: QuickNoteMarkdownProps) {
  return createElement(
    'div',
    {
      className: cn(quickNoteStyles.markdown, getVariantClass(variant), className),
    },
    createElement(
      ReactMarkdown,
      {
        remarkPlugins: [remarkGfm],
        components: {
          a: MarkdownLink,
          img: MarkdownImageFallback,
          table: MarkdownTable,
        },
      },
      content,
    ),
  )
}

function MarkdownLink({
  node: _node,
  href,
  children,
  ...props
}: MarkdownAnchorProps): ReactNode {
  const linkProps = getQuickNoteSafeLinkProps(href)

  if (!linkProps.href) {
    return createElement('span', null, children)
  }

  return createElement(
    'a',
    {
      ...props,
      ...linkProps,
    },
    children,
  )
}

function MarkdownImageFallback({
  node: _node,
  alt,
  src,
}: MarkdownImageProps): ReactNode {
  const source = typeof src === 'string' ? src : undefined
  const linkProps = getQuickNoteSafeLinkProps(source)
  const label = getQuickNoteImageFallbackLabel({ alt, src: linkProps.href })

  if (!linkProps.href) {
    return createElement('span', null, label)
  }

  return createElement('a', linkProps, label)
}

function MarkdownTable({
  node: _node,
  children,
  ...props
}: MarkdownTableProps): ReactNode {
  return createElement(
    'div',
    {
      className: quickNoteStyles.markdownTableScroll,
    },
    createElement('table', props, children),
  )
}

function getVariantClass(variant: QuickNoteMarkdownVariant): string {
  if (variant === 'preview') return quickNoteStyles.markdownPreview
  if (variant === 'inline-preview') return quickNoteStyles.markdownInlinePreview
  return quickNoteStyles.markdownRead
}
