import { describe, expect, it } from 'vitest'
import {
  DEFAULT_OVERSCAN,
  NOTE_ITEM_HEIGHT,
  computeVisibleRange,
  totalListHeight,
} from './note-virtual'

const H = NOTE_ITEM_HEIGHT
const OVER = DEFAULT_OVERSCAN

describe('computeVisibleRange', () => {
  it('滚到顶部时从上边界开始', () => {
    // 视口 520px = 10 项，加上下 overscan 4 → 0..14
    expect(computeVisibleRange(0, 520, 1000)).toEqual({ start: 0, end: 14 })
  })

  it('滚到中间时窗口跟着移动', () => {
    // scrollTop = 5200 → 第 100 项；视口 10 项 → 100..110，含 overscan
    const r = computeVisibleRange(5200, 520, 1000)
    expect(r.start).toBe(100 - OVER)
    expect(r.end).toBe(110 + OVER)
  })

  it('★ 滚到底部时不会越界', () => {
    const total = 1000
    const r = computeVisibleRange(total * H, 520, total)
    expect(r.start).toBeGreaterThanOrEqual(0)
    expect(r.end).toBeLessThanOrEqual(total)
  })

  it('★ 视口高度为 0 时返回全区间（宁可慢也不能空）', () => {
    // 首帧未测量 / jsdom 下 clientHeight 恒为 0 —— 返回 0 项会让列表直接空白
    expect(computeVisibleRange(0, 0, 500)).toEqual({ start: 0, end: 500 })
  })

  it('空列表返回空区间', () => {
    expect(computeVisibleRange(0, 520, 0)).toEqual({ start: 0, end: 0 })
  })

  it('总条数少于视口容量时也返回全区间', () => {
    expect(computeVisibleRange(0, 5200, 3)).toEqual({ start: 0, end: 3 })
  })

  it('负数 scrollTop 按 0 处理（弹性滚动会给出负值）', () => {
    const r = computeVisibleRange(-100, 520, 1000)
    expect(r.start).toBe(0)
  })

  it('★ 渲染项数不随总条数增长（这才是虚拟化的目的）', () => {
    const small = computeVisibleRange(0, 520, 100)
    const huge = computeVisibleRange(0, 520, 100_000)
    expect(huge.end - huge.start).toBe(small.end - small.start)
  })

  it('滚动超出总高度时收口到末尾', () => {
    const r = computeVisibleRange(999999, 520, 50)
    expect(r.end).toBe(50)
    expect(r.start).toBeLessThan(50)
  })

  it('自定义项高生效', () => {
    // 项高 100，视口 500 → 5 项
    const r = computeVisibleRange(0, 500, 1000, 100, 0)
    expect(r).toEqual({ start: 0, end: 5 })
  })

  it('项高非法时返回空区间（防除零）', () => {
    expect(computeVisibleRange(0, 520, 100, 0)).toEqual({ start: 0, end: 0 })
  })
})

describe('totalListHeight', () => {
  it('按条数乘项高', () => {
    expect(totalListHeight(100)).toBe(100 * H)
  })

  it('空列表高度为 0', () => {
    expect(totalListHeight(0)).toBe(0)
    expect(totalListHeight(-5)).toBe(0)
  })
})
