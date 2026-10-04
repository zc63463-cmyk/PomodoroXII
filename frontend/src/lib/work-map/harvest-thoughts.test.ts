/**
 * 会话复盘提炼（harvest-thoughts）—— 纯函数行为断言（PXII-FEAT-REVIEW-HARVEST）。
 *
 * 断言锚在**协议可观察行为**上：按 `sessionId` 精确定位会话岛、只收该会话岛的
 * 思考节点、已升格项分流、无 cid 存量节点不进待办、嵌套层级的归属标题、
 * fail-soft 全空，以及 Markdown 摘要块的形状（分发顺序 / 空类不渲染 / 全空空串）。
 *
 * fixture 用**真实写侧形状**（`appendThoughtNode` / `buildSessionIsland` 的产出：
 * 笔记块归属其后的节点、块内带 `thought_type` + `cid`），保证读侧与写侧同尺度。
 */
import { describe, expect, it, vi } from 'vitest'

import { formatHarvestedNoteMarkdown, harvestSessionThoughts } from './harvest-thoughts'

const SID_A = 'sid-A'
const SID_B = 'sid-B'

const EMPTY = { todos: [], insights: [], decisions: [], problems: [], reviews: [] } as const

/**
 * 两个会话岛（A 本次、B 上一次）+ 根岛。
 *
 * A 岛子树刻意覆盖这些形态：
 * - `depth 1` 直挂会话节点：待办（c2）、洞察（c3）、复盘（c7）、已升格待办（c8）
 * - `depth 2` 嵌在计划项分支（c4，无 thought_type）下：待办（c11）、决策（c5）、问题（c6）
 * - 无 `cid` 的存量待办（结构上不可安全改名 → 不进列表）
 */
const MAP = `<!--
next_cid: 12
centers:
  - at: "node:实现依赖域阻塞计算/10-02 19:00 会话"
    cid: c1
    dir: right
    session_id: "${SID_A}"
  - at: "node:实现依赖域阻塞计算/10-01 09:00 会话"
    cid: c9
    dir: right
    session_id: "${SID_B}"
-->
# 实现依赖域阻塞计算

<!--
cid: "c9"
session_id: "${SID_B}"
-->
## 10-01 09:00 会话

<!--
thought_type: "todo"
cid: "c10"
-->
### 上一个会话的待办（不该被提炼）

<!--
cid: "c1"
session_id: "${SID_A}"
-->
## 10-02 19:00 会话

<!--
thought_type: "todo"
cid: "c2"
-->
### 写一节「岛的归档策略」草案

<!--
thought_type: "insight"
cid: "c3"
-->
### 子岛 stableId 结合五判据解决了树解析 UUID 抖动

<!--
cid: "c4"
-->
### 纯前端 Web Audio 合成

<!--
thought_type: "todo"
cid: "c11"
-->
#### 补一条自动化回归

<!--
thought_type: "decision"
cid: "c5"
-->
#### 确定采用纯前端 Web Audio 合成双音方案

<!--
thought_type: "problem"
cid: "c6"
-->
#### Chrome Autoplay 策略需要在初次点击手势时预热 AudioContext

<!--
thought_type: "review"
cid: "c7"
-->
### 上一轮结论：先做只读总览

<!--
thought_type: "todo"
cid: "c8"
-->
### [PXII-102] 已升格：补 CHANGELOG

<!--
thought_type: "todo"
-->
### 无 cid 的存量待办
`

describe('harvestSessionThoughts（会话岛思考节点提取）', () => {
  it('★ 只收指定会话岛：todos / insights / decisions / problems / reviews 五分流', () => {
    const harvested = harvestSessionThoughts(MAP, SID_A)

    expect(harvested.todos.map((item) => item.cid)).toEqual(['c2', 'c11', 'c8'])
    expect(harvested.insights).toEqual(['子岛 stableId 结合五判据解决了树解析 UUID 抖动'])
    expect(harvested.decisions).toEqual(['确定采用纯前端 Web Audio 合成双音方案'])
    expect(harvested.problems).toEqual(['Chrome Autoplay 策略需要在初次点击手势时预热 AudioContext'])
    expect(harvested.reviews).toEqual(['上一轮结论：先做只读总览'])
  })

  it('★ 别的会话岛的思考节点不越界（B 岛待办 c10 不出现）', () => {
    const harvested = harvestSessionThoughts(MAP, SID_A)

    expect(harvested.todos.map((item) => item.cid)).not.toContain('c10')
    expect(JSON.stringify(harvested)).not.toContain('上一个会话的待办')
  })

  it('★ 已升格分流：`[PXII-xxx] 标题` 标 alreadyPromoted 并解出 displayKey', () => {
    const harvested = harvestSessionThoughts(MAP, SID_A)

    expect(harvested.todos.find((item) => item.cid === 'c2')).toEqual({
      cid: 'c2',
      title: '写一节「岛的归档策略」草案',
      subIslandTitle: '10-02 19:00 会话',
      alreadyPromoted: false,
      displayKey: null,
    })
    expect(harvested.todos.find((item) => item.cid === 'c8')).toEqual({
      cid: 'c8',
      title: '[PXII-102] 已升格：补 CHANGELOG',
      subIslandTitle: '10-02 19:00 会话',
      alreadyPromoted: true,
      displayKey: 'PXII-102',
    })
  })

  it('★ subIslandTitle = 最近一层祖先标题：直挂会话节点 → 会话标题；嵌在分支下 → 分支标题', () => {
    const harvested = harvestSessionThoughts(MAP, SID_A)

    // c2 直接挂在会话节点下 → 归属会话岛本身
    expect(harvested.todos.find((item) => item.cid === 'c2')?.subIslandTitle).toBe('10-02 19:00 会话')
    // c11 嵌在「纯前端 Web Audio 合成」分支下 → 归属该分支
    expect(harvested.todos.find((item) => item.cid === 'c11')?.subIslandTitle).toBe('纯前端 Web Audio 合成')
  })

  it('★ 无 cid 的存量待办不进列表（不可安全回写编号，宁可不列也不错写）', () => {
    const harvested = harvestSessionThoughts(MAP, SID_A)

    expect(harvested.todos.map((item) => item.title)).not.toContain('无 cid 的存量待办')
    expect(harvested.todos).toHaveLength(3)
  })

  it('fail-soft：无导图 / 空 sessionId / 解析失败 / 无此会话岛 → 全空且不抛', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      expect(harvestSessionThoughts(null, SID_A)).toEqual(EMPTY)
      expect(harvestSessionThoughts(undefined, SID_A)).toEqual(EMPTY)
      expect(harvestSessionThoughts('', SID_A)).toEqual(EMPTY)
      expect(harvestSessionThoughts('   \n\t ', SID_A)).toEqual(EMPTY)
      // 空/未就绪的会话身份不猜岛
      expect(harvestSessionThoughts(MAP, '')).toEqual(EMPTY)
      expect(harvestSessionThoughts(MAP, 'not-a-session')).toEqual(EMPTY)
      // 无 H1 的脏文本：解析失败 → 全空，不抛
      const dirty = '<!--\nnote: 只有备注块，没有标题\n-->\n'
      expect(() => harvestSessionThoughts(dirty, SID_A)).not.toThrow()
      expect(harvestSessionThoughts(dirty, SID_A)).toEqual(EMPTY)
    } finally {
      warn.mockRestore()
    }
  })
})

describe('formatHarvestedNoteMarkdown（Markdown 摘要块）', () => {
  it('★ 全类型：标题行 + 按「决策 → 洞察 → 问题/卡点 → 复盘」分发，逐字符合规格', () => {
    const markdown = formatHarvestedNoteMarkdown({
      decisions: ['确定采用纯前端 Web Audio 合成双音方案，避免音频资产 404'],
      insights: ['子岛 stableId 结合五判据彻底解决了树解析 UUID 抖动'],
      problems: ['Chrome Autoplay 策略需要在初次点击手势时预热 AudioContext'],
      reviews: ['先做只读总览再开写'],
    })

    expect(markdown).toBe([
      '### 💡 本轮专注思考提炼',
      '- ⚡ **决策**：确定采用纯前端 Web Audio 合成双音方案，避免音频资产 404',
      '- 💡 **洞察**：子岛 stableId 结合五判据彻底解决了树解析 UUID 抖动',
      '- ⚠️ **问题/卡点**：Chrome Autoplay 策略需要在初次点击手势时预热 AudioContext',
      '- 🔁 **复盘**：先做只读总览再开写',
    ].join('\n'))
  })

  it('某类为空则该类条目不渲染；四类皆空 → 空串（入口优雅收起）', () => {
    const partial = formatHarvestedNoteMarkdown({
      decisions: [], insights: ['只有洞察'], problems: [], reviews: [],
    })
    expect(partial).toBe('### 💡 本轮专注思考提炼\n- 💡 **洞察**：只有洞察')
    expect(partial).not.toContain('决策')

    expect(formatHarvestedNoteMarkdown({
      decisions: [], insights: [], problems: [], reviews: [],
    })).toBe('')
  })

  it('空白条目被丢弃（不产生 `- ⚡ **决策**：` 这类空壳行）', () => {
    expect(formatHarvestedNoteMarkdown({
      decisions: ['   ', '\n\t'], insights: [], problems: [], reviews: [],
    })).toBe('')
  })

  it('与提取层串联：提取结果可直接格式化；待办是"可沉淀对象"，不进笔记块', () => {
    const markdown = formatHarvestedNoteMarkdown(harvestSessionThoughts(MAP, SID_A))

    expect(markdown.startsWith('### 💡 本轮专注思考提炼')).toBe(true)
    expect(markdown).toContain('- ⚡ **决策**：确定采用纯前端 Web Audio 合成双音方案')
    expect(markdown).toContain('- ⚠️ **问题/卡点**：Chrome Autoplay 策略需要在初次点击手势时预热 AudioContext')
    expect(markdown).not.toContain('写一节「岛的归档策略」草案')
    expect(markdown).not.toContain('补一条自动化回归')
  })
})
