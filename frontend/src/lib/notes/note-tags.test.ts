import { describe, expect, it } from 'vitest'
import { extractTags, mergeTags, normalizeTag, normalizeTags, sameTags } from './note-tags'

describe('normalizeTag', () => {
  it('去掉 # 前缀并转小写', () => {
    expect(normalizeTag('#Work')).toBe('work')
    expect(normalizeTag('##Deep')).toBe('deep')
  })

  it('去首尾空白', () => {
    expect(normalizeTag('  #tag  ')).toBe('tag')
  })

  it('空串返回空串', () => {
    expect(normalizeTag('#')).toBe('')
    expect(normalizeTag('   ')).toBe('')
  })
})

describe('normalizeTags', () => {
  it('去重且保持顺序', () => {
    expect(normalizeTags(['#b', 'a', '#b', 'C'])).toEqual(['b', 'a', 'c'])
  })

  it('丢弃空标签', () => {
    expect(normalizeTags(['#', 'ok', '  '])).toEqual(['ok'])
  })
})

describe('extractTags', () => {
  it('提取正文中的 hashtag', () => {
    expect(extractTags('#工作 #想法 正文')).toEqual(['工作', '想法'])
  })

  it('支持层级标签', () => {
    expect(extractTags('#项目/前端')).toEqual(['项目/前端'])
  })

  it('支持英文与数字', () => {
    expect(extractTags('#todo #2026 #v2')).toEqual(['todo', '2026', 'v2'])
  })

  it('★ 标题的 # 不是标签', () => {
    // ATX 标题：# 后紧跟空格。正则要求 # 后至少有一个有效字符且不含空格。
    expect(extractTags('# 这是一级标题')).toEqual([])
  })

  it('合法的 # 开头但紧邻空格也不算', () => {
    expect(extractTags('# 标题 正文 #真标签')).toEqual(['真标签'])
  })

  it('无标签返回空数组', () => {
    expect(extractTags('纯正文内容')).toEqual([])
    expect(extractTags('')).toEqual([])
  })

  it('重复标签只算一次', () => {
    expect(extractTags('#a 中间 #a')).toEqual(['a'])
  })
})

describe('mergeTags', () => {
  it('★ 取并集：已存标签不因正文删字而丢失', () => {
    // 正文里只写了 #new，但已存有 old —— 合并后两个都在
    expect(mergeTags(['old'], '正文 #new')).toEqual(['old', 'new'])
  })

  it('去重：正文与已存重叠时只保留一个', () => {
    expect(mergeTags(['work'], '#work')).toEqual(['work'])
  })

  it('无已存标签时等于正文提取', () => {
    expect(mergeTags(undefined, '#a #b')).toEqual(['a', 'b'])
    expect(mergeTags([], '#a #b')).toEqual(['a', 'b'])
  })

  it('已存标签保留顺序在前', () => {
    expect(mergeTags(['z', 'a'], '#m')).toEqual(['z', 'a', 'm'])
  })
})

describe('sameTags', () => {
  it('长度不同即不同', () => {
    expect(sameTags(['a'], ['a', 'b'])).toBe(false)
  })

  it('规范化后比较（忽略 # 与大小写）', () => {
    expect(sameTags(['#A'], ['a'])).toBe(true)
  })

  it('内容不同则不同', () => {
    expect(sameTags(['a'], ['b'])).toBe(false)
  })

  it('都为空相同', () => {
    expect(sameTags([], [])).toBe(true)
  })
})
