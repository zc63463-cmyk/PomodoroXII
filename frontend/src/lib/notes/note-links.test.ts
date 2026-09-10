import { describe, expect, it } from 'vitest'
import type { Note } from '@/types'
import {
  MISSING_HREF_PREFIX,
  WIKI_HREF_PREFIX,
  buildBacklinkIndex,
  buildTitleIndex,
  findNotesReferencing,
  applyWikiLinkInsertion,
  matchNoteTitles,
  parseWikiLinks,
  renderWikiLinks,
  rewriteLinksInContent,
  titleKey,
} from './note-links'

function note(overrides: Partial<Note> = {}): Note {
  const now = '2026-09-03T10:00:00.000Z'
  return {
    id: 'n1',
    title: '想法 A',
    content: '',
    summary: '',
    tags: [],
    category: null,
    folder_id: null,
    status: 'active',
    trashed_at: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  }
}

describe('parseWikiLinks', () => {
  it('解析最简单的链接', () => {
    const links = parseWikiLinks('见 [[想法 A]] 的论述')
    expect(links).toHaveLength(1)
    expect(links[0]).toMatchObject({ target: '想法 A', label: '想法 A', section: '' })
  })

  it('解析带别名的链接', () => {
    const links = parseWikiLinks('见 [[想法 A|另一面]]')
    expect(links[0]).toMatchObject({ target: '想法 A', label: '另一面' })
  })

  it('解析带章节的链接', () => {
    const links = parseWikiLinks('见 [[想法 A#第二节]]')
    expect(links[0]).toMatchObject({ target: '想法 A', section: '第二节' })
  })

  it('同时带章节与别名', () => {
    const links = parseWikiLinks('[[想法 A#第二节|见此]]')
    expect(links[0]).toMatchObject({
      target: '想法 A',
      section: '第二节',
      label: '见此',
    })
  })

  it('一条正文里的多个链接', () => {
    expect(parseWikiLinks('[[A]] 与 [[B]] 还有 [[A]]')).toHaveLength(3)
  })

  it('★ 空标题不是有效链接', () => {
    expect(parseWikiLinks('[[]]')).toHaveLength(0)
    expect(parseWikiLinks('[[ ]]')).toHaveLength(0)
  })

  it('没有链接时返回空', () => {
    expect(parseWikiLinks('普通正文')).toEqual([])
  })

  it('★ 两条相邻链接不会被贪婪匹配连成一条', () => {
    const links = parseWikiLinks('[[A]][[B]]')
    expect(links.map((link) => link.target)).toEqual(['A', 'B'])
  })
})

describe('buildTitleIndex', () => {
  it('标题 → id，且大小写不敏感', () => {
    const index = buildTitleIndex([note({ id: 'x', title: 'Deep Work' })])
    expect(index.get(titleKey('deep work'))).toBe('x')
  })

  it('★ 已删除的笔记不参与索引', () => {
    const index = buildTitleIndex([
      note({ id: 'x', title: 'A', trashed_at: '2026-09-03T00:00:00.000Z' }),
    ])
    expect(index.size).toBe(0)
  })

  it('★ 空标题不参与索引（否则会误链所有空标题笔记）', () => {
    const index = buildTitleIndex([note({ id: 'x', title: '   ' })])
    expect(index.size).toBe(0)
  })

  it('标题冲突时以先出现者为准', () => {
    const index = buildTitleIndex([
      note({ id: 'first', title: '同名' }),
      note({ id: 'second', title: '同名' }),
    ])
    expect(index.get(titleKey('同名'))).toBe('first')
  })
})

describe('renderWikiLinks', () => {
  const resolve = (target: string) =>
    target === '想法 A' ? 'note-1' : null

  it('存在的目标渲染成 note: 链接', () => {
    const out = renderWikiLinks('见 [[想法 A]]', resolve)
    expect(out).toBe(`见 [想法 A](${WIKI_HREF_PREFIX}note-1)`)
  })

  it('不存在的目标渲染成 note-missing: 链接（供视觉区分）', () => {
    const out = renderWikiLinks('见 [[还没写]]', resolve)
    expect(out).toBe(`见 [还没写](${MISSING_HREF_PREFIX}%E8%BF%98%E6%B2%A1%E5%86%99)`)
  })

  it('★ 别名只影响显示文字，不影响目标', () => {
    const out = renderWikiLinks('[[想法 A|另一面]]', resolve)
    expect(out).toBe(`[另一面](${WIKI_HREF_PREFIX}note-1)`)
  })

  it('章节编码进 href 的 anchor', () => {
    const out = renderWikiLinks('[[想法 A#第二节]]', resolve)
    expect(out).toContain(`${WIKI_HREF_PREFIX}note-1#`)
  })

  it('无链接时原样返回', () => {
    expect(renderWikiLinks('普通正文', resolve)).toBe('普通正文')
  })
})

describe('buildBacklinkIndex', () => {
  it('★ 反查：谁引用了当前笔记', () => {
    const target = note({ id: 't', title: '目标' })
    const source = note({ id: 's', title: '来源', content: '这里提到 [[目标]] 了' })
    const index = buildBacklinkIndex([target, source])

    expect(index.get('t')).toHaveLength(1)
    expect(index.get('t')?.[0]).toMatchObject({ sourceId: 's', sourceTitle: '来源' })
  })

  it('带上下文（引用所在的那一整行）', () => {
    const target = note({ id: 't', title: '目标' })
    const source = note({ id: 's', title: '来源', content: '第一行\n这里提到 [[目标]] 了\n第三行' })
    const index = buildBacklinkIndex([target, source])

    expect(index.get('t')?.[0].context).toBe('这里提到 [[目标]] 了')
  })

  it('★ 引用不存在的标题不构成反向链接', () => {
    const orphan = note({ id: 'o', title: '孤儿', content: '[[不存在的题目]]' })
    expect(buildBacklinkIndex([orphan]).size).toBe(0)
  })

  it('反向链接可有多条来源', () => {
    const target = note({ id: 't', title: '目标' })
    const a = note({ id: 'a', title: 'A', content: '[[目标]]' })
    const b = note({ id: 'b', title: 'B', content: '[[目标]] [[目标]]' })
    const index = buildBacklinkIndex([target, a, b])

    expect(index.get('t')).toHaveLength(3)
  })
})

describe('编辑器补全', () => {
  it('★ 前缀匹配优先于包含匹配', () => {
    const titles = ['关于深度的思考', '深度工作', '浅尝辄止']
    expect(matchNoteTitles('深度', titles)).toEqual(['深度工作', '关于深度的思考'])
  })

  it('大小写不敏感', () => {
    expect(matchNoteTitles('deep', ['Deep Work'])).toEqual(['Deep Work'])
  })

  it('前缀为空时按长度升序给出全部', () => {
    const titles = ['很长的一个标题', '短', '中等标题']
    expect(matchNoteTitles('', titles)).toEqual(['短', '中等标题', '很长的一个标题'])
  })

  it('没有命中时返回空', () => {
    expect(matchNoteTitles('不存在', ['A', 'B'])).toEqual([])
  })

  it('空标题不进候选', () => {
    expect(matchNoteTitles('', ['', '   ', '有效'])).toEqual(['有效'])
  })

  it('去重（同一标题大小写不同只出现一次）', () => {
    expect(matchNoteTitles('', ['Foo', 'foo'])).toHaveLength(1)
  })

  it('尊重 limit', () => {
    expect(matchNoteTitles('', ['a', 'b', 'c', 'd'], 2)).toHaveLength(2)
  })

  it('★ 光标后已有 ]] 时只补标题，不重复闭合', () => {
    expect(applyWikiLinkInsertion('某篇笔记', ']] 的说法')).toBe('某篇笔记')
    expect(applyWikiLinkInsertion('某篇笔记', '的说法')).toBe('某篇笔记]]')
  })
})

describe('重命名联动', () => {
  it('★ 找出引用了旧标题的笔记（排除自己）', () => {
    const renamed = note({ id: 'r', title: '旧标题', content: '[[旧标题]] 自引用' })
    const other = note({ id: 'o', title: '别的', content: '指向 [[旧标题]]' })
    const unrelated = note({ id: 'u', title: '无关', content: '指向 [[别的]]' })

    const found = findNotesReferencing([renamed, other, unrelated], '旧标题', 'r')
    expect(found.map((item) => item.id)).toEqual(['o'])
  })

  it('★ 改写只动目标，保留别名与章节', () => {
    const out = rewriteLinksInContent('[[旧标题#第二节|见此]]', '旧标题', '新标题')
    expect(out).toBe('[[新标题#第二节|见此]]')
  })

  it('大小写不同的引用也会被改写', () => {
    const out = rewriteLinksInContent('[[Old Title]]', 'old title', 'New Title')
    expect(out).toBe('[[New Title]]')
  })

  it('不相关的链接不受影响', () => {
    const out = rewriteLinksInContent('[[A]] [[B]]', 'A', 'A2')
    expect(out).toBe('[[A2]] [[B]]')
  })

  it('旧标题为空时不动正文', () => {
    expect(rewriteLinksInContent('[[A]]', '   ', 'B')).toBe('[[A]]')
  })
})
