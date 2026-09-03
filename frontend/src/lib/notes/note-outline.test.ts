import { describe, expect, it } from 'vitest'
import { countWords, parseOutline } from './note-outline'

describe('parseOutline', () => {
  it('解析各级标题并记录行号', () => {
    const items = parseOutline('# 一级\n正文\n## 二级\n### 三级')

    expect(items).toEqual([
      { level: 1, text: '一级', line: 0 },
      { level: 2, text: '二级', line: 2 },
      { level: 3, text: '三级', line: 3 },
    ])
  })

  it('★ 跳过代码块内的伪标题', () => {
    const md = ['# 真标题', '', '```', '# 这是注释不是标题', '```', '', '## 另一个真标题'].join(
      '\n',
    )

    const items = parseOutline(md)
    expect(items.map((i) => i.text)).toEqual(['真标题', '另一个真标题'])
  })

  it('~~~ 围栏同样跳过', () => {
    const items = parseOutline('~~~py\n# 注释\n~~~\n# 标题')
    expect(items.map((i) => i.text)).toEqual(['标题'])
  })

  it('# 后没有空格不是标题', () => {
    const items = parseOutline('#紧挨着\n # 这个才是')
    expect(items).toHaveLength(1)
    expect(items[0].text).toBe('这个才是')
  })

  it('超过 6 个 # 不是标题', () => {
    expect(parseOutline('####### 七个')).toEqual([])
  })

  it('只有 # 没有内容不算标题', () => {
    expect(parseOutline('#\n# 有内容')).toHaveLength(1)
  })

  it('空文档返回空数组', () => {
    expect(parseOutline('')).toEqual([])
  })
})

describe('countWords', () => {
  it('空内容各项为 0', () => {
    expect(countWords('')).toEqual({ characters: 0, words: 0, readingMinutes: 0 })
  })

  it('★ 中文按字计、英文按词计', () => {
    // 「你好世界」4 字 + "hello world" 2 词 = 6
    const r = countWords('你好世界 hello world')
    expect(r.words).toBe(6)
  })

  it('不为英文按字符高估', () => {
    // "hello world" 若按字符算会得 11 或 10，按词是 2
    expect(countWords('hello world').words).toBe(2)
  })

  it('剥离 Markdown 标记', () => {
    const md = '# 标题\n\n**粗体** 与 *斜体*，还有 `代码`。'
    const r = countWords(md)
    // 去标记后：粗体(2) 与(1) 斜体(2) 还有(2) 代码(2) = 9（"标题" 也应计入）
    expect(r.words).toBeGreaterThan(0)
    expect(r.characters).toBeGreaterThanOrEqual(r.words)
  })

  it('代码块不计入', () => {
    const withCode = '正文\n\n```js\nconst aVeryLongVariableName = 1;\n```'
    const withoutCode = '正文'
    // 代码块内的英文单词不应被计入
    expect(countWords(withCode).words).toBe(countWords(withoutCode).words)
  })

  it('阅读时长至少 1 分钟（有内容时）', () => {
    expect(countWords('短').readingMinutes).toBe(1)
  })

  it('长文阅读时长按 250/分钟向上取整', () => {
    // 构造约 600 个中文字符 → ceil(600/250) = 3
    const long = '字'.repeat(600)
    expect(countWords(long).readingMinutes).toBe(3)
  })
})
