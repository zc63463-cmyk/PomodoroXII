/**
 * 每日导图投影 —— 纯函数单测（`readMap` 注入假读图函数，不碰 HTTP/Dexie）。
 *
 * 锁住的四件事：
 * 1. 会话 → L3 图 key 的分组（归因只到 L2，图 key 只能从计划行来）
 * 2. fail-soft 三连：404(null) / 抛错 / 解析失败，都不许炸
 * 3. 单 L2 口径：`primary` 只取一张，且 `level2Count` 如实报数
 * 4. `filterHanging` 剔除已升格待办（`[PXII-102]` 前缀）
 */
import { describe, expect, it, vi } from 'vitest'

import type { DailySessionFact } from './daily-evidence'
import {
  filterHanging,
  groupFactsByWorkItem,
  isHangingType,
  readDailyMapProjection,
  type DailyMapSlice,
} from './daily-map'

function fact(over: Partial<DailySessionFact> = {}): DailySessionFact {
  return {
    sessionId: 's1',
    startedLabel: '14:00',
    endedLabel: '14:45',
    focusedSeconds: 2700,
    level2WorkItemId: 'L2-a',
    titleSnapshot: '导图高度自适应',
    validity: 'valid',
    interrupted: false,
    ...over,
  }
}

/** 造一份含会话岛的 `.mm.md` 文本（协议 v1.3.1 形状，cid 为必需编辑键）。 */
function mapDoc(options: {
  sessionId: string
  todos?: Array<{ cid: string; title: string }>
  problems?: string[]
}): string {
  const lines: string[] = [
    '# 工作导图：导图高度自适应',
    '',
    '<!--',
    'next_cid: 99',
    'centers:',
    `  - at: "会话节点"`,
    `    cid: "c1"`,
    `    dir: "right"`,
    '-->',
    '',
    '<!--',
    'cid: "c1"',
    `session_id: "${options.sessionId}"`,
    '-->',
    '### 14:00 会话',
  ]
  for (const todo of options.todos ?? []) {
    lines.push('', '<!--', 'thought_type: "todo"', `cid: "${todo.cid}"`, '-->', `### ${todo.title}`)
  }
  for (const problem of options.problems ?? []) {
    // 问题类用稳定 cid 以便同款去重路径
    lines.push('', '<!--', 'thought_type: "problem"', `cid: "p-${problem.slice(0, 6)}"`, '-->', `### ${problem}`)
  }
  return lines.join('\n')
}

const groupedOf = (
  entries: Array<[string, { level2WorkItemId: string; title: string; sessionIds: string[] }]>,
) => new Map(entries)

describe('groupFactsByWorkItem', () => {
  it('按计划里的 L3 分组（归因只到 L2，图 key 只能来自计划行）', () => {
    const grouped = groupFactsByWorkItem(
      [fact({ sessionId: 's1' }), fact({ sessionId: 's2' })],
      new Map([
        ['s1', ['L3-a']],
        ['s2', ['L3-a']],
      ]),
      new Map([['L3-a', 'L2-a']]),
      new Map([['L3-a', '导图高度自适应']]),
    )
    expect(grouped.get('L3-a')?.sessionIds).toEqual(['s1', 's2'])
    expect(grouped.get('L3-a')?.level2WorkItemId).toBe('L2-a')
    expect(grouped.get('L3-a')?.title).toBe('导图高度自适应')
  })

  it('一个会话关联多个 L3 时各自分组（D3：一次会话在每张图上各建岛）', () => {
    const grouped = groupFactsByWorkItem(
      [fact({ sessionId: 's1' })],
      new Map([['s1', ['L3-a', 'L3-b']]]),
      new Map([
        ['L3-a', 'L2-a'],
        ['L3-b', 'L2-a'],
      ]),
      new Map([
        ['L3-a', '甲'],
        ['L3-b', '乙'],
      ]),
    )
    expect([...grouped.keys()]).toEqual(['L3-a', 'L3-b'])
  })

  it('同一 L3 被多会话命中时 sessionIds 不重复', () => {
    const grouped = groupFactsByWorkItem(
      [fact({ sessionId: 's1' }), fact({ sessionId: 's1' })],
      new Map([['s1', ['L3-a']]]),
      new Map(),
      new Map(),
    )
    expect(grouped.get('L3-a')?.sessionIds).toEqual(['s1'])
  })

  it('无计划的会话不进任何分组（不硬造图 key）', () => {
    const grouped = groupFactsByWorkItem([fact({ sessionId: 's1' })], new Map(), new Map(), new Map())
    expect(grouped.size).toBe(0)
  })
})

describe('readDailyMapProjection · fail-soft 三连', () => {
  it('404（null）→ 不产切片但不抛（"尚无导图"是正常状态）', async () => {
    const readMap = vi.fn().mockResolvedValue(null)
    const result = await readDailyMapProjection(
      groupedOf([['L3-a', { level2WorkItemId: 'L2-a', title: '甲', sessionIds: ['s1'] }]]),
      readMap,
    )
    expect(result.slices).toHaveLength(0)
    expect(result.primary).toBeNull()
    expect(result.hanging).toHaveLength(0)
  })

  it('读图抛错 → 跳过该图，其它图照常（纪律③）', async () => {
    const readMap = vi.fn(async (id: string) => {
      if (id === 'L3-bad') throw new Error('500 Internal')
      return mapDoc({ sessionId: 's2', todos: [{ cid: 'c9', title: '保留我' }] })
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const result = await readDailyMapProjection(
      groupedOf([
        ['L3-bad', { level2WorkItemId: 'L2-a', title: '坏的', sessionIds: ['s1'] }],
        ['L3-good', { level2WorkItemId: 'L2-a', title: '好的', sessionIds: ['s2'] }],
      ]),
      readMap,
    )

    expect(result.slices).toHaveLength(1)
    expect(result.primary?.workItemId).toBe('L3-good')
    expect(result.hanging.map((item) => item.title)).toContain('保留我')
    warn.mockRestore()
  })

  it('导图文本非法 → harvest 自返全空，不炸（解析 fail-soft）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const result = await readDailyMapProjection(
      groupedOf([['L3-a', { level2WorkItemId: 'L2-a', title: '甲', sessionIds: ['s1'] }]]),
      async () => '这不是一份合法导图文本 <<<',
    )
    expect(result.hanging).toHaveLength(0)
    // 切片仍在（有文本就算有图），只是提不出思考
    expect(result.slices).toHaveLength(1)
    warn.mockRestore()
  })

  it('空图字符串视同无图', async () => {
    const result = await readDailyMapProjection(
      groupedOf([['L3-a', { level2WorkItemId: 'L2-a', title: '甲', sessionIds: ['s1'] }]]),
      async () => '   ',
    )
    expect(result.slices).toHaveLength(0)
  })
})

describe('readDailyMapProjection · 悬挂项提炼', () => {
  it('按 sessionId 精确定位会话岛并提出待办与问题', async () => {
    const doc = mapDoc({
      sessionId: 's1',
      todos: [{ cid: 'c2', title: '针对 Safari 17 测试' }],
      problems: ['Chrome 滚动条延迟'],
    })
    const result = await readDailyMapProjection(
      groupedOf([['L3-a', { level2WorkItemId: 'L2-a', title: '甲', sessionIds: ['s1'] }]]),
      async () => doc,
    )
    expect(result.hanging.some((item) => item.title === '针对 Safari 17 测试')).toBe(true)
    expect(result.hanging.some((item) => item.thoughtType === 'problem')).toBe(true)
  })

  it('会话岛不匹配时提不出任何东西（不串别的会话的思考）', async () => {
    const doc = mapDoc({ sessionId: 'other', todos: [{ cid: 'c2', title: '不该出现' }] })
    const result = await readDailyMapProjection(
      groupedOf([['L3-a', { level2WorkItemId: 'L2-a', title: '甲', sessionIds: ['s1'] }]]),
      async () => doc,
    )
    expect(result.hanging).toHaveLength(0)
  })

  it('切片带上 sessionIds 供「本次会话岛」高亮', async () => {
    const doc = mapDoc({ sessionId: 's1' })
    const result = await readDailyMapProjection(
      groupedOf([['L3-a', { level2WorkItemId: 'L2-a', title: '甲', sessionIds: ['s1', 's2'] }]]),
      async () => doc,
    )
    const slice = result.primary as DailyMapSlice
    expect(slice.sessionIds).toEqual(['s1', 's2'])
  })
})

describe('readDailyMapProjection · 单 L2 口径', () => {
  it('多图时 primary 只取第一张，但 slices 全留、level2Count 如实报数', async () => {
    const result = await readDailyMapProjection(
      groupedOf([
        ['L3-a', { level2WorkItemId: 'L2-a', title: '甲', sessionIds: ['s1'] }],
        ['L3-b', { level2WorkItemId: 'L2-b', title: '乙', sessionIds: ['s2'] }],
      ]),
      async (id) => mapDoc({ sessionId: id === 'L3-a' ? 's1' : 's2' }),
    )
    expect(result.primary?.workItemId).toBe('L3-a')
    expect(result.slices).toHaveLength(2)
    expect(result.level2Count).toBe(2)
  })

  it('同 L2 的两张图 level2Count 仍为 1（口径按 L2 而非按图）', async () => {
    const result = await readDailyMapProjection(
      groupedOf([
        ['L3-a', { level2WorkItemId: 'L2-a', title: '甲', sessionIds: ['s1'] }],
        ['L3-b', { level2WorkItemId: 'L2-a', title: '乙', sessionIds: ['s2'] }],
      ]),
      async (id) => mapDoc({ sessionId: id === 'L3-a' ? 's1' : 's2' }),
    )
    expect(result.level2Count).toBe(1)
  })
})

describe('filterHanging', () => {
  it('剔除已升格待办（已变正式任务，二次展示是重复骚扰）', () => {
    const items = [
      { cid: 'c1', title: '[PXII-102] 已升格', thoughtType: 'todo' as const, sessionId: 's1' },
      { cid: 'c2', title: '还没升格', thoughtType: 'todo' as const, sessionId: 's1' },
    ]
    expect(filterHanging(items).map((item) => item.cid)).toEqual(['c2'])
  })

  it('容忍升格前缀里的空白（[ PXII-102 ]）', () => {
    const items = [
      { cid: 'c1', title: '[ PXII-102 ] 已升格', thoughtType: 'todo' as const, sessionId: 's1' },
    ]
    expect(filterHanging(items)).toHaveLength(0)
  })

  it('无 cid 的待办不进清单（结构上无法安全回写）', () => {
    const items = [{ cid: '', title: '手工节点', thoughtType: 'todo' as const, sessionId: 's1' }]
    expect(filterHanging(items)).toHaveLength(0)
  })

  it('问题类按标题保留（无 cid 也能呈现）', () => {
    const items = [
      { cid: 'p1', title: 'Chrome 延迟', thoughtType: 'problem' as const, sessionId: 's1' },
    ]
    expect(filterHanging(items)).toHaveLength(1)
  })
})

describe('isHangingType', () => {
  it('只有待办与问题进入悬挂清单', () => {
    expect(isHangingType('todo')).toBe(true)
    expect(isHangingType('problem')).toBe(true)
    expect(isHangingType('insight')).toBe(false)
    expect(isHangingType('decision')).toBe(false)
    expect(isHangingType('review')).toBe(false)
  })
})
