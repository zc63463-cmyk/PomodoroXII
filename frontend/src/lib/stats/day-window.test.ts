import { describe, expect, it } from 'vitest'
import { todayStartIso } from './day-window'

/**
 * 工单 A2：窗口起点纯函数。断言全程 TZ 安全 —— 不写死 UTC 串
 *（测试环境 TZ=UTC，但实现必须在任意本地时区正确），而是：
 *  ① 正则断言格式与服务端 pattern 同构；
 *  ② 把产出的 ISO 解析回时间戳，与「本地零点」的瞬时等值比较。
 */
function expectLocalMidnightOf(iso: string, year: number, month: number, day: number): void {
  expect(iso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
  expect(new Date(iso).getTime()).toBe(new Date(year, month - 1, day).getTime())
}

describe('todayStartIso（工单 A2 今日窗口起点）', () => {
  it('午夜后 + h=0：起点 = 当日本地零点（默认日界不变）', () => {
    const now = new Date(2026, 8, 14, 0, 30, 0)
    expectLocalMidnightOf(todayStartIso(now, 0), 2026, 9, 14)
  })

  it('★ 01:00 + h=3：深夜属于昨天 —— 起点 = 昨日本地零点', () => {
    const now = new Date(2026, 8, 14, 1, 0, 0)
    expectLocalMidnightOf(todayStartIso(now, 3), 2026, 9, 13)
  })

  it('10:00 + h=3：白天属于今天 —— 起点 = 本日本地零点', () => {
    const now = new Date(2026, 8, 14, 10, 0, 0)
    expectLocalMidnightOf(todayStartIso(now, 3), 2026, 9, 14)
  })

  it('跨月边界：09-01 凌晨 + h=3 → 起点落在 08-31（由 Date 处理进借位）', () => {
    const now = new Date(2026, 8, 1, 1, 0, 0)
    expectLocalMidnightOf(todayStartIso(now, 3), 2026, 8, 31)
  })
})
