import { describe, expect, it } from 'vitest'
import {
  buildNoteTemplate,
  detectSummary,
  hasSummary,
  shouldPromptSummary,
  withSummary,
} from './note-summary'

describe('detectSummary', () => {
  it('解析顶部摘要块', () => {
    expect(detectSummary('> 摘要：这是摘要\n\n正文')).toBe('这是摘要')
  })

  it('接受英文冒号', () => {
    expect(detectSummary('> 摘要: 这是摘要')).toBe('这是摘要')
  })

  it('没有摘要块时返回 null', () => {
    expect(detectSummary('只有正文')).toBeNull()
  })

  it('★ 摘要块为空时视为未填写（占位符不算填了）', () => {
    expect(detectSummary('> 摘要：\n\n正文')).toBeNull()
    expect(detectSummary('> 摘要：   \n\n正文')).toBeNull()
  })

  it('★ 正文中间的引用块不会被误判成摘要', () => {
    const content = '正文开头\n\n随便写点什么\n\n随便写点什么\n随便写点什么\n> 摘要：这段在正文中间'
    expect(detectSummary(content)).toBeNull()
  })
})

describe('hasSummary', () => {
  it('已填写为 true', () => {
    expect(hasSummary('> 摘要：有')).toBe(true)
  })

  it('未填写（含占位）为 false', () => {
    expect(hasSummary('> 摘要：')).toBe(false)
    expect(hasSummary('正文')).toBe(false)
  })
})

describe('shouldPromptSummary', () => {
  it('长文未填摘要 → 提示', () => {
    expect(shouldPromptSummary('字'.repeat(250))).toBe(true)
  })

  it('长文已填摘要 → 不提示', () => {
    expect(shouldPromptSummary(`> 摘要：有\n\n${'字'.repeat(250)}`)).toBe(false)
  })

  it('★ 短文未填摘要 → 不提示（刚开的新笔记不该一上来就催）', () => {
    expect(shouldPromptSummary('刚写了几个字')).toBe(false)
  })

  it('阈值按非空白字符计算', () => {
    // 250 个字符但全是空白，不应触发提示
    expect(shouldPromptSummary(' '.repeat(250))).toBe(false)
  })
})

describe('buildNoteTemplate', () => {
  it('只给一个待填的摘要块，不塞多余内容', () => {
    expect(buildNoteTemplate()).toBe('> 摘要：\n\n')
  })
})

describe('withSummary', () => {
  it('没有摘要块时插到开头并与正文隔开', () => {
    expect(withSummary('正文内容', '这是摘要')).toBe('> 摘要：这是摘要\n\n正文内容')
  })

  it('★ 已有摘要块时就地替换，不动正文其余部分', () => {
    const content = '> 摘要：旧摘要\n\n正文第一段\n\n正文第二段'
    expect(withSummary(content, '新摘要')).toBe(
      '> 摘要：新摘要\n\n正文第一段\n\n正文第二段',
    )
  })

  it('替换的是摘要行而不是第一个引用的其它行', () => {
    // 第一行是普通引用，第二行才是摘要 —— 只应替换摘要行
    const content = '> 普通引用\n> 摘要：旧\n\n正文'
    expect(withSummary(content, '新')).toBe('> 普通引用\n> 摘要：新\n\n正文')
  })

  it('空正文时只写摘要块', () => {
    expect(withSummary('', '摘要')).toBe('> 摘要：摘要\n')
  })

  it('写入后可被 detectSummary 读回（往返一致）', () => {
    const content = withSummary('正文', '往返测试')
    expect(detectSummary(content)).toBe('往返测试')
  })
})
