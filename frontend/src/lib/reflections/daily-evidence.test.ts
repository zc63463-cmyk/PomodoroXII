/**
 * 今日事实投影 —— 纯函数单测。
 *
 * 锁住的是**口径**而非实现：日界跨零点、休息型/进行中排除、归因缺失 fail-soft、
 * cid 去重、时长格式化、注入块的"无事实返空串"纪律。
 * 全部可在纯内存里跑（无 fake-indexeddb、无 IO）。
 */
import { describe, expect, it } from 'vitest'

import {
  collectDailyEvidence,
  countsAsInvestment,
  DEFAULT_DAY_BOUNDARY,
  emptyDailyEvidence,
  formatDailyEvidenceMarkdown,
  formatDuration,
  type AttributionRow,
  type HangingThought,
  type PlanRow,
  type SessionRow,
} from './daily-evidence'

/** 构造一条会话行；只写关心的字段，其余给合理默认。 */
function session(over: Partial<SessionRow> & { id: string }): SessionRow {
  return {
    startedAt: '2026-10-03T06:00:00.000Z',
    endedAt: '2026-10-03T06:45:00.000Z',
    focusedSeconds: 2700,
    pausedSeconds: 0,
    validity: 'valid',
    timerCompletion: 'completed',
    sessionType: 'work',
    overallProgress: 'progressed',
    ...over,
  }
}

function attribution(over: Partial<AttributionRow> & { sessionId: string }): AttributionRow {
  return {
    level2WorkItemId: 'L2-a',
    projectId: 'P1',
    effective: true,
    ...over,
  }
}

function plan(over: Partial<PlanRow> & { sessionId: string }): PlanRow {
  return {
    workItemId: 'L3-a',
    titleSnapshot: '导图高度自适应',
    planRank: 0,
    removedAt: null,
    currentDuringSession: true,
    ...over,
  }
}

// --------------------------------------------------------------------------- //

describe('countsAsInvestment（计入"今日投入"的唯一真值源）', () => {
  it('排除休息型会话（净专注恒 0，计入会稀释投入语义）', () => {
    expect(countsAsInvestment(session({ id: 's', sessionType: 'short_break' }))).toBe(false)
    expect(countsAsInvestment(session({ id: 's', sessionType: 'long_break' }))).toBe(false)
  })

  it('排除进行中会话（endedAt 为 null，时长还在长）', () => {
    expect(countsAsInvestment(session({ id: 's', endedAt: null }))).toBe(false)
  })

  it('保留已结束的投入型会话', () => {
    expect(countsAsInvestment(session({ id: 's', sessionType: 'work' }))).toBe(true)
    expect(countsAsInvestment(session({ id: 's', sessionType: 'free' }))).toBe(true)
    expect(countsAsInvestment(session({ id: 's', sessionType: 'countdown' }))).toBe(true)
  })
})

describe('collectDailyEvidence · 日界与归属', () => {
  it('跨零点的会话按日界归属到前一天', () => {
    // 本地时间 10-03 01:30（东八区 = 前日 17:30Z）。用本地构造函数造，
    // **不硬编码 UTC 偏移** —— 否则本机时区一变断言就假失败。
    const lateStart = new Date(2026, 9, 3, 1, 30, 0, 0)
    const late = session({
      id: 'late',
      startedAt: lateStart.toISOString(),
      endedAt: new Date(lateStart.getTime() + 45 * 60 * 1000).toISOString(),
    })

    // 日界 4 点：01:30 往前推 4h = 10-02 21:30 → 归 10-02
    const withBoundary = collectDailyEvidence('2026-10-02', [late], [], [], [], 4)
    expect(withBoundary.sessionCount).toBe(1)
    // 且不该出现在 10-03
    expect(collectDailyEvidence('2026-10-03', [late], [], [], [], 4).sessionCount).toBe(0)

    // 日界 0 点：01:30 就是 10-03 凌晨 → 归 10-03
    const noBoundary = collectDailyEvidence('2026-10-03', [late], [], [], [], 0)
    expect(noBoundary.sessionCount).toBe(1)
    expect(collectDailyEvidence('2026-10-02', [late], [], [], [], 0).sessionCount).toBe(0)
  })

  it('默认日界为 4 点（DEFAULT_DAY_BOUNDARY 落在允许区间内）', () => {
    expect(DEFAULT_DAY_BOUNDARY).toBe(4)
    expect(DEFAULT_DAY_BOUNDARY).toBeGreaterThanOrEqual(0)
    expect(DEFAULT_DAY_BOUNDARY).toBeLessThanOrEqual(6)
  })

  it('进行中与休息型会话不进时间轴（即使落在当日）', () => {
    const rows = [
      session({ id: 'a' }),
      session({ id: 'b', sessionType: 'short_break' }),
      session({ id: 'c', endedAt: null }),
    ]
    const snapshot = collectDailyEvidence('2026-10-03', rows)
    expect(snapshot.sessionCount).toBe(1)
    expect(snapshot.sessions[0]?.sessionId).toBe('a')
  })
})

describe('collectDailyEvidence · 归因与聚合', () => {
  it('只认 effective 归因，非 effective 一律忽略', () => {
    const rows = [session({ id: 'a' })]
    const snapshot = collectDailyEvidence('2026-10-03', rows, [
      attribution({ sessionId: 'a', level2WorkItemId: 'L2-real', effective: true }),
      attribution({ sessionId: 'a', level2WorkItemId: 'L2-stale', effective: false }),
    ])
    expect(snapshot.sessions[0]?.level2WorkItemId).toBe('L2-real')
  })

  it('归因缺失是 fail-soft：会话仍进时间轴（事实是真的），只是没有二级归属', () => {
    const snapshot = collectDailyEvidence('2026-10-03', [session({ id: 'a' })], [])
    expect(snapshot.sessionCount).toBe(1)
    expect(snapshot.sessions[0]?.level2WorkItemId).toBeNull()
    // 归因缺失时归入「未归因任务」桶，而不是丢事实
    expect(snapshot.byLevel2[0]?.level2WorkItemId).toBe('__unattributed__')
    expect(snapshot.byLevel2[0]?.titleSnapshot).toBe('未归因任务')
  })

  it('按二级工作项聚合并按投入降序', () => {
    const rows = [
      session({ id: 'a', focusedSeconds: 600 }),
      session({ id: 'b', focusedSeconds: 1800 }),
      session({ id: 'c', focusedSeconds: 900 }),
    ]
    const snapshot = collectDailyEvidence('2026-10-03', rows, [
      attribution({ sessionId: 'a', level2WorkItemId: 'L2-small' }),
      attribution({ sessionId: 'b', level2WorkItemId: 'L2-big' }),
      attribution({ sessionId: 'c', level2WorkItemId: 'L2-small' }),
    ])
    expect(snapshot.byLevel2.map((slice) => slice.level2WorkItemId)).toEqual([
      'L2-big',
      'L2-small',
    ])
    expect(snapshot.byLevel2[1]?.focusedSeconds).toBe(1500)
    expect(snapshot.byLevel2[1]?.sessionCount).toBe(2)
    expect(snapshot.totalFocusedSeconds).toBe(3300)
  })

  it('计划标题优先 currentDuringSession，且忽略已移除的计划', () => {
    const rows = [session({ id: 'a' })]
    const snapshot = collectDailyEvidence('2026-10-03', rows, [attribution({ sessionId: 'a' })], [
      plan({ sessionId: 'a', titleSnapshot: '被移除的计划', planRank: 0, removedAt: '2026-10-03T01:00:00.000Z' }),
      plan({
        sessionId: 'a',
        titleSnapshot: '当前计划',
        planRank: 9,
        currentDuringSession: true,
      }),
    ])
    expect(snapshot.sessions[0]?.titleSnapshot).toBe('当前计划')
  })

  it('没有 currentDuringSession 时取 planRank 最小者', () => {
    const snapshot = collectDailyEvidence(
      '2026-10-03',
      [session({ id: 'a' })],
      [attribution({ sessionId: 'a' })],
      [
        plan({ sessionId: 'a', titleSnapshot: '靠后', planRank: 5, currentDuringSession: false }),
        plan({ sessionId: 'a', titleSnapshot: '靠前', planRank: 1, currentDuringSession: false }),
      ],
    )
    expect(snapshot.sessions[0]?.titleSnapshot).toBe('靠前')
  })
})

describe('collectDailyEvidence · 计数与悬挂项', () => {
  it('有效数与中断数各自独立统计', () => {
    const rows = [
      session({ id: 'a', validity: 'valid', timerCompletion: 'completed' }),
      session({ id: 'b', validity: 'invalid', timerCompletion: 'interrupted' }),
      session({ id: 'c', validity: 'valid', overallProgress: 'interrupted' }),
    ]
    const snapshot = collectDailyEvidence('2026-10-03', rows)
    expect(snapshot.sessionCount).toBe(3)
    expect(snapshot.validCount).toBe(2)
    // timerCompletion 与 overallProgress 两个来源都算中断
    expect(snapshot.interruptedCount).toBe(2)
  })

  it('悬挂项按 cid 去重（同一节点被多会话命中只留一条）', () => {
    const hanging: HangingThought[] = [
      { cid: 'c1', title: '针对 Safari 17 测试', thoughtType: 'todo', sessionId: 'a' },
      { cid: 'c1', title: '针对 Safari 17 测试', thoughtType: 'todo', sessionId: 'b' },
      { cid: 'c2', title: 'Chrome 滚动条延迟', thoughtType: 'problem', sessionId: 'a' },
    ]
    const snapshot = collectDailyEvidence('2026-10-03', [session({ id: 'a' })], [], [], hanging)
    expect(snapshot.hanging).toHaveLength(2)
    expect(snapshot.hanging[0]?.cid).toBe('c1')
  })

  it('无 cid 的悬挂项被丢弃（结构上无法安全回写，宁可不列）', () => {
    const hanging: HangingThought[] = [
      { cid: '', title: '手工写的存量节点', thoughtType: 'todo', sessionId: 'a' },
    ]
    const snapshot = collectDailyEvidence('2026-10-03', [session({ id: 'a' })], [], [], hanging)
    expect(snapshot.hanging).toHaveLength(0)
  })

  it('即使无会话，悬挂项仍透传（导图有东西但当天没番茄也要看得见）', () => {
    const hanging: HangingThought[] = [
      { cid: 'c9', title: '遗留思考', thoughtType: 'insight', sessionId: 'old' },
    ]
    const snapshot = collectDailyEvidence('2026-10-03', [], [], [], hanging)
    expect(snapshot.isEmpty).toBe(true)
    expect(snapshot.hanging).toHaveLength(1)
  })

  it('emptyDailyEvidence 每次新建，避免调用方互相污染', () => {
    const a = emptyDailyEvidence('2026-10-03')
    const b = emptyDailyEvidence('2026-10-03')
    a.sessions.push({
      sessionId: 'x',
      startedLabel: '00:00',
      endedLabel: '00:30',
      focusedSeconds: 1,
      level2WorkItemId: null,
      titleSnapshot: null,
      validity: 'valid',
      interrupted: false,
    })
    expect(b.sessions).toHaveLength(0)
  })
})

describe('formatDuration', () => {
  it('按 人/小时+分钟 输出，绝不出现裸秒数', () => {
    expect(formatDuration(0)).toBe('0m')
    expect(formatDuration(45 * 60)).toBe('45m')
    expect(formatDuration(3600)).toBe('1h')
    expect(formatDuration(2 * 3600 + 40 * 60)).toBe('2h 40m')
  })

  it('负数与小数被夹住', () => {
    expect(formatDuration(-10)).toBe('0m')
    expect(formatDuration(90.9)).toBe('1m')
  })
})

describe('formatDailyEvidenceMarkdown（注入块的形状与纪律）', () => {
  it('无事实时返回空串 —— 调用方据此收起入口，不留空白占位', () => {
    expect(formatDailyEvidenceMarkdown(emptyDailyEvidence('2026-10-03'))).toBe('')
  })

  it('产出含时长、分布与悬挂项的 markdown 块', () => {
    const rows = [session({ id: 'a', focusedSeconds: 2700 }), session({ id: 'b', focusedSeconds: 1800 })]
    const hanging: HangingThought[] = [
      { cid: 'c1', title: '针对 Safari 17 测试', thoughtType: 'todo', sessionId: 'a' },
    ]
    const snapshot = collectDailyEvidence(
      '2026-10-03',
      rows,
      [attribution({ sessionId: 'a', level2WorkItemId: 'L2-x' }), attribution({ sessionId: 'b', level2WorkItemId: 'L2-y' })],
      [],
      hanging,
    )
    const md = formatDailyEvidenceMarkdown(snapshot)
    expect(md).toContain('## 今日事实（系统预填）')
    expect(md).toContain('1h 15m 净专注')
    expect(md).toContain('2 个会话')
    expect(md).toContain('**悬挂中的思考**')
    expect(md).toContain('⏳ 针对 Safari 17 测试')
  })

  it('中断数为 0 时不出现"中断"字样（不做无意义的报忧）', () => {
    const md = formatDailyEvidenceMarkdown(collectDailyEvidence('2026-10-03', [session({ id: 'a' })]))
    expect(md).not.toContain('中断')
  })
})
