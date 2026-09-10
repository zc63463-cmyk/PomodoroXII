import { createElement } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { QuickNoteMarkdown } from '@/components/quick-notes/quick-note-markdown'

describe('QuickNoteMarkdown', () => {
  it('renders unsafe markdown links as inert text instead of empty clickable links', () => {
    render(createElement(QuickNoteMarkdown, {
      content: [
        '[javascript link](javascript:alert(1))',
        '[data link](data:text/html;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+)',
        '[safe link](https://example.com/docs)',
      ].join('\n\n'),
    }))

    expect(screen.queryByRole('link', { name: 'javascript link' })).toBeNull()
    expect(screen.queryByRole('link', { name: 'data link' })).toBeNull()
    expect(screen.getByText('javascript link').closest('a')).toBeNull()
    expect(screen.getByText('data link').closest('a')).toBeNull()
    expect(screen.getByRole('link', { name: 'safe link' })).toHaveAttribute(
      'href',
      'https://example.com/docs',
    )
  })

  it('wraps GFM tables in a horizontal overflow container', () => {
    const { container } = render(createElement(QuickNoteMarkdown, {
      content: [
        '| Wide heading | Another heading |',
        '| --- | --- |',
        '| A long cell value | Another long cell value |',
      ].join('\n'),
      variant: 'preview',
    }))

    const table = container.querySelector('table')
    expect(table).not.toBeNull()
    expect(table?.parentElement).toHaveClass('quick-note-markdown-table-scroll')
  })

  /**
   * ★ 回归：remark-gfm 的表格行是贪婪匹配的，表格后面**没有空行**时，
   *   紧随其后的那一行会被吞成表格的数据行 —— 用户写完表格直接换行接着写，
   *   后面的正文就整个跑进表格里了。
   *   修法在渲染前补一个空行（lib/markdown/table-boundary），不动存储。
   */
  it('★ does not swallow the paragraph that follows a table without a blank line', () => {
    const { container } = render(createElement(QuickNoteMarkdown, {
      content: [
        '| 列 1 | 列 2 |',
        '| --- | --- |',
        '| 内容 A | 内容 B |',
        '表格后面的正文',
      ].join('\n'),
    }))

    const table = container.querySelector('table')
    expect(table).not.toBeNull()

    // 表格里只有一行数据，"表格后面的正文"不该被吞进去
    const bodyRows = table?.querySelectorAll('tbody tr') ?? []
    expect(bodyRows).toHaveLength(1)

    // 它应该是表格外的一个独立段落
    const paragraph = Array.from(container.querySelectorAll('p')).find(
      (p) => p.textContent === '表格后面的正文',
    )
    expect(paragraph).toBeTruthy()
  })

  /**
   * wiki 链接是笔记域需要的，但渲染器为速记域共用 ——
   * 所以「不传 resolver 时行为不变」必须被钉死，否则一次改动会影响两个域。
   */
  it('leaves [[wiki links]] untouched when no resolver is provided', () => {
    render(createElement(QuickNoteMarkdown, { content: '参考 [[某篇笔记]] 的说法' }))

    // 没有 resolver → 不做转换，按普通文本渲染，不产生可点的链接/按钮
    expect(screen.getByText(/某篇笔记/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '某篇笔记' })).toBeNull()
  })

  it('renders a resolved wiki link as a button that navigates', () => {
    const navigated: Array<[string, string]> = []
    render(createElement(QuickNoteMarkdown, {
      content: '参考 [[某篇笔记]] 的说法',
      wikiLinkResolver: (target: string) => (target === '某篇笔记' ? 'note-1' : null),
      onWikiLinkNavigate: (noteId: string, section: string) =>
        navigated.push([noteId, section]),
    }))

    fireEvent.click(screen.getByRole('button', { name: '某篇笔记' }))
    expect(navigated).toEqual([['note-1', '']])
  })

  it('passes the section through when the link targets a heading', () => {
    const navigated: Array<[string, string]> = []
    render(createElement(QuickNoteMarkdown, {
      content: '[[某篇笔记#第二节]]',
      wikiLinkResolver: () => 'note-1',
      onWikiLinkNavigate: (noteId: string, section: string) =>
        navigated.push([noteId, section]),
    }))

    fireEvent.click(screen.getByRole('button', { name: '某篇笔记' }))
    expect(navigated).toEqual([['note-1', '第二节']])
  })

  it('★ shows the alias as the label but resolves by the target', () => {
    const navigated: string[] = []
    render(createElement(QuickNoteMarkdown, {
      content: '[[某篇笔记|另一种说法]]',
      wikiLinkResolver: () => 'note-1',
      onWikiLinkNavigate: (noteId: string) => navigated.push(noteId),
    }))

    // 显示的是别名，点的还是目标笔记
    fireEvent.click(screen.getByRole('button', { name: '另一种说法' }))
    expect(navigated).toEqual(['note-1'])
  })

  it('★ renders an unresolved link as a create affordance, not a dead link', () => {
    const clicked: string[] = []
    render(createElement(QuickNoteMarkdown, {
      content: '[[还没写的题目]]',
      wikiLinkResolver: () => null,
      onMissingNoteClick: (target: string) => clicked.push(target),
    }))

    const missing = screen.getByRole('button', { name: '还没写的题目' })
    expect(missing).toHaveAttribute('title', '笔记「还没写的题目」还没创建')
    fireEvent.click(missing)
    expect(clicked).toEqual(['还没写的题目'])
  })
})
