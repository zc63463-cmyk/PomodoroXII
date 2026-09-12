import { describe, expect, it } from 'vitest'
import { intentFailureLabel, summarizeIntentFailures } from './intent-failure-summary'

describe('intentFailureLabel', () => {
  it('maps handler_error kinds to Chinese action names', () => {
    expect(intentFailureLabel('handler_error:submit_review')).toBe('提交复盘')
    expect(intentFailureLabel('handler_error:move_work_item')).toBe('移动工作项')
    expect(intentFailureLabel('handler_error:create_relation')).toBe('添加依赖')
  })

  it('falls back for unknown kinds and never leaks raw codes', () => {
    expect(intentFailureLabel('handler_error:some_future_kind')).toBe('一项操作')
    expect(intentFailureLabel('weird_server_code')).toBe('同步被拒绝')
  })

  it('maps the canonical server rejection codes users can actually hit', () => {
    expect(intentFailureLabel('project_key_conflict')).toBe('项目标识冲突')
    expect(intentFailureLabel('version_conflict')).toBe('版本冲突')
    expect(intentFailureLabel('not_found')).toBe('目标不存在')
  })
})

describe('summarizeIntentFailures', () => {
  it('returns null for an empty list (no banner)', () => {
    expect(summarizeIntentFailures([])).toBeNull()
  })

  it('counts every failure and dedupes labels in first-seen order', () => {
    // 回归（2026-09-11 裁决 A）：failed 是永久终态，提示必须说清「哪类操作没提交」，
    // 而不是无效的「请刷新页面重试」。
    expect(summarizeIntentFailures([
      { code: 'handler_error:submit_review' },
      { code: 'handler_error:submit_review' },
      { code: 'handler_error:move_work_item' },
    ])).toBe('有 3 项操作未能提交（提交复盘、移动工作项），请重新执行对应操作。')
  })

  it('never surfaces raw english codes', () => {
    const message = summarizeIntentFailures([{ code: 'totally_unknown_code' }])
    expect(message).toBe('有 1 项操作未能提交（同步被拒绝），请重新执行对应操作。')
    expect(message).not.toContain('totally_unknown_code')
  })
})
