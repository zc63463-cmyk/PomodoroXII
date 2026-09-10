import { describe, expect, it } from 'vitest'
import { adviseTitle, hasTitleAdvice } from './note-title'

describe('adviseTitle', () => {
  it('正常标题无需提示', () => {
    expect(adviseTitle('番茄工作法')).toEqual({ level: 'ok', message: '' })
    expect(adviseTitle('深度工作的三个前提')).toEqual({ level: 'ok', message: '' })
  })

  it('空标题提示补充', () => {
    expect(adviseTitle('')).toMatchObject({ level: 'hint' })
    expect(adviseTitle('   ')).toMatchObject({ level: 'hint' })
  })

  it('★ 会破坏链接的字符优先提示（比长度问题更重要）', () => {
    expect(adviseTitle('带[括号]的短标题')).toMatchObject({ level: 'hint' })
    expect(adviseTitle('a|b')).toMatchObject({ level: 'hint' })
    expect(adviseTitle('a#b')).toMatchObject({ level: 'hint' })
  })

  it('句末标点提示', () => {
    expect(adviseTitle('这是一个标题。')).toMatchObject({ level: 'hint' })
    expect(adviseTitle('这是一个标题？')).toMatchObject({ level: 'hint' })
  })

  it('冗余前缀提示，并指出该去掉哪个词', () => {
    expect(adviseTitle('关于番茄工作法')).toMatchObject({
      level: 'hint',
      message: expect.stringContaining('关于'),
    })
  })

  it('过短提示', () => {
    expect(adviseTitle('复盘')).toMatchObject({ level: 'hint' })
  })

  it('过长提示', () => {
    expect(adviseTitle('这是一个非常非常长的标题长到已经不像一个标题而像一段话了')).toMatchObject({
      level: 'hint',
    })
  })

  it('★ 一次只给一条最该改的建议（不刷屏）', () => {
    // 既以「关于」开头又超长 —— 只返回一条
    const advice = adviseTitle('关于一个非常非常长的标题长到已经不像一个标题而像一段话了')
    expect(advice.level).toBe('hint')
    expect(advice.message).not.toContain('并且')
  })

  it('★ 优先级：链接非法字符 > 句末标点 > 冗余前缀 > 长度', () => {
    // 既含 # 又以「关于」开头 → 应先报字符问题
    expect(adviseTitle('关于#标签')).toMatchObject({
      message: expect.stringContaining('失效'),
    })
    // 既以「关于」开头又过短 → 应先报前缀（前缀是更具体的可行动建议）
    expect(adviseTitle('关于x')).toMatchObject({
      message: expect.stringContaining('关于'),
    })
  })

  it('边界长度：3 字与 24 字都不提示', () => {
    expect(adviseTitle('一二三')).toMatchObject({ level: 'ok' })
    expect(adviseTitle('一'.repeat(24))).toMatchObject({ level: 'ok' })
    expect(adviseTitle('一'.repeat(25))).toMatchObject({ level: 'hint' })
  })

  it('提示文案非空（ok 以外都有具体文案）', () => {
    expect(adviseTitle('复盘').message.length).toBeGreaterThan(0)
    expect(adviseTitle('番茄工作法').message).toBe('')
  })
})

describe('hasTitleAdvice', () => {
  it('有提示为 true', () => {
    expect(hasTitleAdvice('复盘')).toBe(true)
  })

  it('正常标题为 false', () => {
    expect(hasTitleAdvice('番茄工作法')).toBe(false)
  })
})
