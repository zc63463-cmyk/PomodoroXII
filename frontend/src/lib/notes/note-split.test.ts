import { describe, expect, it } from 'vitest'
import {
  deriveSplitTitle,
  isSplittableRange,
  planNoteSplit,
  sanitizeLinkTitle,
} from './note-split'

describe('sanitizeLinkTitle', () => {
  it('剔除会破坏链接语法的字符', () => {
    expect(sanitizeLinkTitle('a[b]c')).toBe('abc')
    expect(sanitizeLinkTitle('a|b')).toBe('ab')
    expect(sanitizeLinkTitle('a#b')).toBe('ab')
  })

  it('正常标题原样返回', () => {
    expect(sanitizeLinkTitle('深度工作')).toBe('深度工作')
  })

  it('清完只剩空白时返回空串（由调用方兜底为「未命名」）', () => {
    expect(sanitizeLinkTitle('[[|#]]')).toBe('')
  })
})

describe('deriveSplitTitle', () => {
  it('取第一个非空行（选中时常常带上前导空行）', () => {
    expect(deriveSplitTitle('\n\n深度工作\n正文')).toBe('深度工作')
  })

  it('去掉 Markdown 标题标记', () => {
    expect(deriveSplitTitle('## 小节标题\n正文')).toBe('小节标题')
    expect(deriveSplitTitle('#### 四级')).toBe('四级')
  })

  it('去掉列表与任务列表标记', () => {
    expect(deriveSplitTitle('- 列表项')).toBe('列表项')
    expect(deriveSplitTitle('- [ ] 待办项')).toBe('待办项')
    expect(deriveSplitTitle('1. 有序项')).toBe('有序项')
  })

  it('去掉引用标记与强调符号', () => {
    expect(deriveSplitTitle('> 引用行')).toBe('引用行')
    expect(deriveSplitTitle('**粗体标题**')).toBe('粗体标题')
    expect(deriveSplitTitle('`代码标题`')).toBe('代码标题')
  })

  it('全空白时兜底为「未命名」', () => {
    expect(deriveSplitTitle('   \n  \n ')).toBe('未命名')
    expect(deriveSplitTitle('')).toBe('未命名')
  })

  it('标题里的非法字符被剔除，不会产出坏链接', () => {
    expect(deriveSplitTitle('带[括号]的标题')).toBe('带括号的标题')
  })

  it('超长标题截断到 50 字', () => {
    const title = deriveSplitTitle('长'.repeat(80))
    expect(title).toHaveLength(50)
  })
})

describe('planNoteSplit', () => {
  const content = '开头段落\n\n第二段内容\n\n结尾段落'

  it('拆出选中部分作为新笔记正文', () => {
    const from = content.indexOf('第二段内容')
    const plan = planNoteSplit(content, from, from + '第二段内容'.length)

    expect(plan).not.toBeNull()
    expect(plan!.newContent).toBe('第二段内容')
    expect(plan!.title).toBe('第二段内容')
  })

  it('★ 原文留下指向新笔记的链接', () => {
    const from = content.indexOf('第二段内容')
    const plan = planNoteSplit(content, from, from + '第二段内容'.length)

    expect(plan!.sourceContent).toBe('开头段落\n\n[[第二段内容]]\n\n结尾段落')
  })

  it('选区首尾的空白不参与搬运', () => {
    const from = content.indexOf('第二段内容') - 2
    const plan = planNoteSplit(content, from, from + '第二段内容'.length + 2)

    expect(plan!.newContent).toBe('第二段内容')
  })

  it('拆分后不留下连续空行', () => {
    // 选中范围跨过整个中间段（含其前后空行）
    const from = content.indexOf('第二段内容') - 2
    const to = content.indexOf('结尾段落') - 2
    const plan = planNoteSplit(content, from, to)

    expect(plan!.sourceContent).not.toMatch(/\n{3,}/)
    expect(plan!.sourceContent).toContain('[[第二段内容]]')
  })

  it('空选区返回 null', () => {
    expect(planNoteSplit(content, 5, 5)).toBeNull()
  })

  it('选区全是空白返回 null', () => {
    expect(planNoteSplit(content, 4, 6)).toBeNull()
  })

  it('越界返回 null', () => {
    expect(planNoteSplit(content, 0, content.length + 1)).toBeNull()
    expect(planNoteSplit(content, -1, 5)).toBeNull()
  })

  it('非整数偏移返回 null', () => {
    expect(planNoteSplit(content, 1.5, 5)).toBeNull()
  })

  it('新笔记正文原样保留（不删首行标题）', () => {
    const src = '## 小节\n\n小节正文内容'
    const from = src.indexOf('## 小节')
    const plan = planNoteSplit(src, from, src.length)

    // 首行标题要留在新笔记里，否则新笔记会丢掉自己的结构
    expect(plan!.newContent).toBe('## 小节\n\n小节正文内容')
    expect(plan!.title).toBe('小节')
  })
})

describe('isSplittableRange', () => {
  const content = '开头\n\n中段\n\n结尾'

  it('部分选区可拆', () => {
    expect(isSplittableRange(content, 0, 2)).toBe(true)
  })

  it('★ 选中整篇不可拆（拆完原笔记只剩链接，等于重命名）', () => {
    expect(isSplittableRange(content, 0, content.length)).toBe(false)
  })

  it('选区含首尾空白但覆盖整篇时同样不可拆', () => {
    expect(isSplittableRange(content, 0, content.length)).toBe(false)
  })

  it('空选区不可拆', () => {
    expect(isSplittableRange(content, 3, 3)).toBe(false)
    expect(isSplittableRange(content, 2, 4)).toBe(false) // 纯换行
  })
})
