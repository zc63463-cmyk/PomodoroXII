'use client'

import { createElement, useMemo, type ComponentPropsWithoutRef, type ReactNode } from 'react'
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { quickNoteStyles } from '@/components/quick-notes/quick-note-styles'
import { ensureBlankLineAfterTables } from '@/lib/markdown/table-boundary'
import {
  getQuickNoteImageFallbackLabel,
  getQuickNoteSafeLinkProps,
} from '@/lib/quick-notes/quick-note-markdown'
import {
  MISSING_HREF_PREFIX,
  WIKI_HREF_PREFIX,
  renderWikiLinks,
} from '@/lib/notes/note-links'
import { cn } from '@/lib/utils'

export type QuickNoteMarkdownVariant = 'preview' | 'read' | 'inline-preview'

interface QuickNoteMarkdownProps {
  content: string
  variant?: QuickNoteMarkdownVariant
  className?: string
  /**
   * wiki 链接支持（笔记域用）：把「笔记标题」解析成「笔记 id」。
   *
   * 不传时本组件行为与改动前**完全一致** —— 速记域也在使用这个渲染器，
   * 不能因为笔记域需要链接就把它拖下水。
   */
  wikiLinkResolver?: (target: string) => string | null
  /** 点击已存在的笔记链接。section 为空串表示未指定章节。 */
  onWikiLinkNavigate?: (noteId: string, section: string) => void
  /** 点击尚未创建的笔记链接（Obsidian 的行为是"点击即创建"，此处先留出入口）。 */
  onMissingNoteClick?: (target: string) => void
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
  wikiLinkResolver,
  onWikiLinkNavigate,
  onMissingNoteClick,
}: QuickNoteMarkdownProps) {
  // 只有传入 resolver 时才做 wiki 链接转换 —— 没传则正文原样渲染，
  // 速记域的既有渲染结果一个字都不变。
  //
  // ★ 表格边界修正放在**渲染前**且只影响喂给渲染器的字符串，不改存储：
  //   remark-gfm 会贪婪地把表格后面紧邻的行吞成数据行，补一个空行即可挡住。
  //   放在 wiki 链接转换之后，避免 `[[标题]]` 里的竖线造成误判。
  const rendered = useMemo(() => {
    const withLinks = wikiLinkResolver
      ? renderWikiLinks(content, wikiLinkResolver)
      : content
    return ensureBlankLineAfterTables(withLinks)
  }, [content, wikiLinkResolver])
  const linkComponent = useMemo(
    () => makeMarkdownLink({ onWikiLinkNavigate, onMissingNoteClick }),
    [onWikiLinkNavigate, onMissingNoteClick],
  )

  return createElement(
    'div',
    {
      className: cn(quickNoteStyles.markdown, getVariantClass(variant), className),
    },
    createElement(
      ReactMarkdown,
      {
        remarkPlugins: [remarkGfm],
        /**
         * ★ react-markdown 的默认 urlTransform 会做协议白名单消毒，
         *   `note:` / `note-missing:` 这种内部伪协议会被清成**空字符串** ——
         *   结果链接根本传不到 components.a，渲染出来只是普通文本。
         *   所以启用 wiki 链接时必须显式放行这两个协议；
         *   其余一律走默认消毒，不放松任何外部链接的安全策略。
         */
        urlTransform: wikiLinkResolver ? allowWikiProtocols : defaultUrlTransform,
        components: {
          a: linkComponent,
          img: MarkdownImageFallback,
          table: MarkdownTable,
        },
      },
      rendered,
    ),
  )
}

/** 还原 URL 编码；畸形输入时原样返回，不抛异常。 */
function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/** 只放行两个内部伪协议，其余交给 react-markdown 的默认消毒。 */
function allowWikiProtocols(url: string): string {
  if (url.startsWith(WIKI_HREF_PREFIX) || url.startsWith(MISSING_HREF_PREFIX)) {
    return url
  }
  return defaultUrlTransform(url)
}

interface WikiLinkHandlers {
  onWikiLinkNavigate?: (noteId: string, section: string) => void
  onMissingNoteClick?: (target: string) => void
}

/**
 * 生成 a 标签的渲染组件。用工厂函数是为了让内部的 wiki 链接处理
 * 能闭包捕获导航回调，同时保持 react-markdown 的 components 签名不变。
 */
function makeMarkdownLink(handlers: WikiLinkHandlers) {
  return function MarkdownLink({
    node: _node,
    href,
    children,
    ...props
  }: MarkdownAnchorProps): ReactNode {
    // ★ wiki 链接走自己的分支，不进外部 URL 的安全过滤 ——
    //   `note:` 是内部伪协议，`getQuickNoteSafeLinkProps` 会把它判为不安全而丢弃。
    if (href?.startsWith(WIKI_HREF_PREFIX)) {
      const [noteId, encodedSection = ''] = href.slice(WIKI_HREF_PREFIX.length).split('#')
      return createElement(
        'button',
        {
          type: 'button',
          className: 'text-primary underline underline-offset-2 hover:no-underline',
          // 章节在渲染时被 encodeURIComponent 过（要安全塞进 URL），这里还原。
          // 用 safeDecode 而不是裸 decodeURIComponent —— 畸形百分号编码会抛异常，
          // 不能让一篇写坏了的笔记把整个渲染打挂。
          onClick: () => handlers.onWikiLinkNavigate?.(noteId, safeDecode(encodedSection)),
        },
        children,
      )
    }

    if (href?.startsWith(MISSING_HREF_PREFIX)) {
      const target = decodeURIComponent(href.slice(MISSING_HREF_PREFIX.length))
      return createElement(
        'button',
        {
          type: 'button',
          title: `笔记「${target}」还没创建`,
          className: 'text-muted-foreground underline decoration-dotted underline-offset-2',
          onClick: () => handlers.onMissingNoteClick?.(target),
        },
        children,
      )
    }

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
