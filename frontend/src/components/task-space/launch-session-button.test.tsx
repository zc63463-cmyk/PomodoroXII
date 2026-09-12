import { createElement, type ReactNode } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { CachedWorkItem } from '@/types'

const push = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }))
vi.mock('@/components/ui/button', () => ({
  Button: ({ children, ...props }: { children?: ReactNode } & Record<string, unknown>) => createElement('button', props, children),
}))

import { LaunchSessionButton } from './launch-session-button'

const item = (overrides: Partial<CachedWorkItem> = {}): CachedWorkItem => ({
  id: 'l2',
  projectId: 'project-1',
  displayKey: 'RM-2',
  title: 'Ship feature',
  description: null,
  typeDefinitionId: 'type-task',
  statusDefinitionId: 'status-open',
  priority: 'medium',
  parentId: 'l1',
  childRank: 0,
  depth: 2,
  completionWindowStart: null,
  completionWindowEnd: null,
  reviewPoint: null,
  hardDeadline: null,
  effortEstimateLowerSeconds: null,
  effortEstimateUpperSeconds: null,
  effortActualSeconds: 0,
  confidence: null,
  completedAt: null,
  cancelledAt: null,
  archivedAt: null,
  markedAsAttention: false,
  labelIds: [],
  version: 1,
  createdAt: '2026-07-15T08:00:00.000Z',
  updatedAt: '2026-07-15T08:00:00.000Z',
  ...overrides,
})

describe('LaunchSessionButton', () => {
  beforeEach(() => {
    push.mockClear()
  })

  it('is disabled with a stable accessible name while no WorkItem is selected', () => {
    render(createElement(LaunchSessionButton, { workItem: null }))
    const button = screen.getByRole('button', { name: 'Start focus session' })
    expect(button).toBeDisabled()
    fireEvent.click(button)
    expect(push).not.toHaveBeenCalled()
  })

  it('is enabled once a WorkItem is selected and navigates to the timer page', () => {
    const workItem = item()
    render(createElement(LaunchSessionButton, { workItem }))
    const button = screen.getByRole('button', { name: /Start focus session/ })
    expect(button).not.toBeDisabled()
    fireEvent.click(button)
    expect(push).toHaveBeenCalledWith('/timer')
  })

  it('keeps a stable accessible name that identifies the selected WorkItem', () => {
    render(createElement(LaunchSessionButton, { workItem: item({ displayKey: 'RM-7', title: 'Verify output' }) }))
    expect(screen.getByRole('button', { name: 'Start focus session for RM-7 Verify output' })).not.toBeDisabled()
  })

  // ★ 2026-09-11：fail-closed 回归 —— blocked 但漏传 onBlocked 时必须禁止启动。
  // 修复前：按钮可点且静默 router.push('/timer')，被阻塞任务的唯一拦截形同虚设。
  it('does not launch a blocked WorkItem when onBlocked is missing (fail-closed)', () => {
    const workItem = item()
    render(createElement(LaunchSessionButton, { workItem, blocked: true }))
    const button = screen.getByRole('button', { name: /Start focus session/ })
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('title', '该任务存在未完成的上游依赖')
    fireEvent.click(button)
    expect(push).not.toHaveBeenCalled()
  })

  it('reports the blocked WorkItem through onBlocked without navigating (regression)', () => {
    const workItem = item()
    const onBlocked = vi.fn()
    render(createElement(LaunchSessionButton, { workItem, blocked: true, onBlocked }))
    const button = screen.getByRole('button', { name: /Start focus session/ })
    expect(button).not.toBeDisabled()
    fireEvent.click(button)
    expect(onBlocked).toHaveBeenCalledTimes(1)
    expect(onBlocked).toHaveBeenCalledWith(workItem)
    expect(push).not.toHaveBeenCalled()
  })

  it('navigates directly for a non-blocked WorkItem even when onBlocked is provided (regression)', () => {
    const workItem = item()
    const onBlocked = vi.fn()
    render(createElement(LaunchSessionButton, { workItem, blocked: false, onBlocked }))
    const button = screen.getByRole('button', { name: /Start focus session/ })
    expect(button).not.toBeDisabled()
    fireEvent.click(button)
    expect(push).toHaveBeenCalledWith('/timer')
    expect(onBlocked).not.toHaveBeenCalled()
  })

  // ★ 2026-09-11：第二道守卫的常驻回归 —— 程序化 dispatchEvent **不受**
  // disabled 语义过滤（此前只在验收中用临时探针验证过）。这一对用例把它
  // 锁进库内：blocked 下不导航；对照组证明事件确实到达 handler。
  it('never navigates for a blocked item even when the disabled state is bypassed', () => {
    const workItem = item()
    render(createElement(LaunchSessionButton, { workItem, blocked: true }))
    const button = screen.getByRole('button', { name: /Start focus session/ })
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(push).not.toHaveBeenCalled()
  })

  it('control: the same programmatic click does navigate when not blocked', () => {
    const workItem = item()
    render(createElement(LaunchSessionButton, { workItem }))
    const button = screen.getByRole('button', { name: /Start focus session/ })
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(push).toHaveBeenCalledWith('/timer')
  })
})
