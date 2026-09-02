import { describe, expect, it } from 'vitest'
import {
  computeReflectionStreak,
  countMoods,
  groupReflectionsByMonth,
  monthOf,
  reflectionExcerpt,
} from './reflection-selectors'
import type { Reflection } from '@/types'

function reflection(overrides: Partial<Reflection> = {}): Reflection {
  const now = '2026-09-02T00:00:00.000Z'
  return {
    id: 'r1',
    date: '2026-09-02',
    content: '',
    mood: null,
    tags: [],
    created_at: now,
    updated_at: now,
    ...overrides,
  }
}

describe('monthOf', () => {
  it('切出 YYYY-MM', () => {
    expect(monthOf('2026-09-02')).toBe('2026-09')
    expect(monthOf('2026-01-15')).toBe('2026-01')
  })
})

describe('groupReflectionsByMonth', () => {
  it('按月份分组，新月份在前，组内日期倒序', () => {
    const groups = groupReflectionsByMonth([
      reflection({ id: 'a', date: '2026-08-15' }),
      reflection({ id: 'b', date: '2026-09-01' }),
      reflection({ id: 'c', date: '2026-09-10' }),
    ])

    expect(groups.map((g) => g.month)).toEqual(['2026-09', '2026-08'])
    expect(groups[0].reflections.map((r) => r.id)).toEqual(['c', 'b'])
    expect(groups[1].reflections.map((r) => r.id)).toEqual(['a'])
  })

  it('空输入返回空数组', () => {
    expect(groupReflectionsByMonth([])).toEqual([])
  })
})

describe('countMoods', () => {
  it('按固定顺序返回，含 0 的项', () => {
    const counts = countMoods([
      reflection({ id: 'a', mood: 'good' }),
      reflection({ id: 'b', mood: 'good' }),
      reflection({ id: 'c', mood: 'bad' }),
      reflection({ id: 'd', mood: null }), // 未记录心情的不计
    ])

    expect(counts).toEqual([
      { mood: 'great', count: 0 },
      { mood: 'good', count: 2 },
      { mood: 'normal', count: 0 },
      { mood: 'bad', count: 1 },
      { mood: 'terrible', count: 0 },
    ])
  })
})

describe('computeReflectionStreak', () => {
  it('今天有记录则从今天数', () => {
    const list = [
      reflection({ date: '2026-09-02' }),
      reflection({ date: '2026-09-01' }),
    ]
    expect(computeReflectionStreak(list, '2026-09-02')).toBe(2)
  })

  it('★ 今天还没写不算断链', () => {
    const list = [
      reflection({ date: '2026-09-01' }),
      reflection({ date: '2026-08-31' }),
    ]
    expect(computeReflectionStreak(list, '2026-09-02')).toBe(2)
  })

  it('中断一天则从头数', () => {
    const list = [
      reflection({ date: '2026-09-02' }),
      reflection({ date: '2026-08-31' }),
    ]
    expect(computeReflectionStreak(list, '2026-09-02')).toBe(1)
  })

  it('无记录 → 0', () => {
    expect(computeReflectionStreak([], '2026-09-02')).toBe(0)
  })

  it('★ 跨月正确', () => {
    const list = [
      reflection({ date: '2026-09-01' }),
      reflection({ date: '2026-08-31' }),
      reflection({ date: '2026-08-30' }),
    ]
    expect(computeReflectionStreak(list, '2026-09-02')).toBe(3)
  })
})

describe('reflectionExcerpt', () => {
  it('取正文首行并去掉 Markdown 标记', () => {
    expect(reflectionExcerpt(reflection({ content: '## 标题\n\n正文' }))).toBe('标题')
  })

  it('空正文回退为占位', () => {
    expect(reflectionExcerpt(reflection({ content: '   \n  ' }))).toBe('(空白)')
  })

  it('超长截断', () => {
    const long = 'x'.repeat(200)
    const out = reflectionExcerpt(reflection({ content: long }))
    expect(out).toHaveLength(81) // 80 + 省略号
    expect(out.endsWith('…')).toBe(true)
  })
})
