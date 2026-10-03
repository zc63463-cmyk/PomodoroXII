import { describe, expect, it } from 'vitest'
import {
  STATUS_CATEGORY_VALUES,
  readStatusDefinition,
  statusDefinitionSchema,
  systemStatusIdByCategory,
} from './task-space'

/**
 * 状态双轴 · 契约层测试。
 *
 * ★ 重点不是"schema 能解析"，而是**系统行优先**这条不变量：
 *阶段 2 开放用户自定义 status 后，同一 category 下有多条 status，
 * 而后端按 (rank, id) 排序 —— 一旦按"第一条"取语义锚点
 * （新建默认状态 / 会话完成目标 / 派生阻塞态），就可能取到用户行。
 */

const base = {
  icon: null,
  color: null,
  rank: 0,
  system: false,
  archivedAt: null,
  version: 1,
  createdAt: '2026-10-03T00:00:00.000Z',
  updatedAt: '2026-10-03T00:00:00.000Z',
}

const systemRow = (category: string, id: string, rank = 0) => ({
  id,
  name: category,
  category,
  ...base,
  rank,
  system: true,
})

const userRow = (category: string, id: string, name: string, rank = 0) => ({
  id,
  name,
  category,
  ...base,
  rank,
  system: false,
})

describe('statusDefinitionSchema', () => {
  it('接受一条合法的系统行', () => {
    const parsed = statusDefinitionSchema.safeParse(systemRow('waiting', 'sys-status-waiting'))
    expect(parsed.success).toBe(true)
  })

  it('★ 未知 category **不**导致解析失败（刻意宽松）', () => {
    // definitions.statuses 在 wire 上是开放 record；服务端先加值、客户端后升级时
    // 不能整页崩。闭集校验在服务端（DB CHECK + require_enum_value）。
    const parsed = statusDefinitionSchema.safeParse({
      ...systemRow('blocked', 'sys-x'),
    })
    expect(parsed.success).toBe(true)
  })

  it('拒绝缺字段 / 多余字段（.strict()）', () => {
    expect(statusDefinitionSchema.safeParse({ id: 'x' }).success).toBe(false)
    const extra = { ...systemRow('waiting', 'sys-x'), nickname: 'oops' }
    expect(statusDefinitionSchema.safeParse(extra).success).toBe(false)
  })

  it('category 闭集恰为 5 个（与后端 CHECK 一致）', () => {
    expect([...STATUS_CATEGORY_VALUES]).toEqual([
      'not_started',
      'in_progress',
      'waiting',
      'completed',
      'cancelled',
    ])
  })
})

describe('readStatusDefinition', () => {
  it('合法行返回解析结果', () => {
    expect(readStatusDefinition(systemRow('completed', 'sys-done'))?.id).toBe('sys-done')
  })

  it('非法行返回 null 而不是抛（definitions 里是开放 record，不能炸读路径）', () => {
    expect(readStatusDefinition({ nope: true })).toBeNull()
    expect(readStatusDefinition(null)).toBeNull()
    expect(readStatusDefinition('x')).toBeNull()
  })
})

describe('systemStatusIdByCategory', () => {
  it('★ 用户行排在前面时，仍返回系统行', () => {
    // 后端按 (rank, id) 排序；用户行 rank 更小 ⇒ "第一条"是用户行。
    const rows = [
      userRow('waiting', 'u-review', '等设计 review', 0),
      systemRow('waiting', 'sys-status-waiting', 1),
    ]
    expect(systemStatusIdByCategory(rows, 'waiting')).toBe('sys-status-waiting')
  })

  it('★ 用户行 rank 更大时同样返回系统行', () => {
    const rows = [
      systemRow('waiting', 'sys-status-waiting', 0),
      userRow('waiting', 'u-review', '等设计 review', 9),
    ]
    expect(systemStatusIdByCategory(rows, 'waiting')).toBe('sys-status-waiting')
  })

  it('无系统行时退回第一条（退化但不崩）', () => {
    const rows = [userRow('waiting', 'u-a', 'A', 0), userRow('waiting', 'u-b', 'B', 1)]
    expect(systemStatusIdByCategory(rows, 'waiting')).toBe('u-a')
  })

  it('已归档的系统行不算数（取活跃的）', () => {
    const rows = [
      { ...systemRow('waiting', 'sys-old', 0), archivedAt: '2026-10-03T00:00:00.000Z' },
      userRow('waiting', 'u-a', 'A', 1),
    ]
    expect(systemStatusIdByCategory(rows, 'waiting')).toBe('u-a')
  })

  it('category 不存在时返回 null', () => {
    expect(systemStatusIdByCategory([systemRow('waiting', 'sys-w')], 'completed')).toBeNull()
    expect(systemStatusIdByCategory([], 'waiting')).toBeNull()
  })

  it('脏数据（非法行）被跳过而不是让整组失效', () => {
    const rows = [null, { garbage: 1 }, userRow('waiting', 'u-a', 'A', 0)]
    expect(systemStatusIdByCategory(rows, 'waiting')).toBe('u-a')
  })

  it('★ 端到端：模拟"用户建了三个 waiting 状态"的真实形态', () => {
    const rows = [
      userRow('waiting', 'u-1', '等设计 review', 0),
      userRow('waiting', 'u-2', '需要授权', 1),
      systemRow('waiting', 'sys-status-waiting', 2),
      systemRow('completed', 'sys-status-completed', 0),
    ]
    expect(systemStatusIdByCategory(rows, 'waiting')).toBe('sys-status-waiting')
    expect(systemStatusIdByCategory(rows, 'completed')).toBe('sys-status-completed')
  })
})
