import { createElement } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('lucide-react', () => ({}))
vi.mock('@/components/ui/button', () => ({
  Button: ({ children, ...props }: { children?: unknown } & Record<string, unknown>) =>
    createElement('button', props, children as never),
}))
import { WaitingResumeHint } from './waiting-resume-hint'

const hint = (): Element | null => document.querySelector('[data-waiting-resume-hint]')

describe('WaitingResumeHint', () => {
  it('resumes to the server-recorded prior state on click', () => {
    const onResume = vi.fn()
    render(createElement(WaitingResumeHint, {
      upstreamCount: 2,
      target: { statusDefinitionId: 'sys-status-in-progress', name: '进行中' },
      onResume,
    }))

    expect(hint()?.textContent).toContain('上游依赖已全部完成（2 项）')
    expect(hint()?.getAttribute('data-waiting-resume-target')).toBe('sys-status-in-progress')
    fireEvent.click(screen.getByText('恢复为进行中'))
    expect(onResume).toHaveBeenCalledTimes(1)
  })

  it('resumes a previously paused item back to paused — never to in_progress', () => {
    const onResume = vi.fn()
    render(createElement(WaitingResumeHint, {
      upstreamCount: 1,
      target: { statusDefinitionId: 'sys-status-paused', name: '已暂停' },
      onResume,
    }))

    expect(hint()?.textContent).toContain('建议把状态恢复为「已暂停」')
    expect(screen.queryByText('恢复为进行中')).toBeNull()
    fireEvent.click(screen.getByText('恢复为已暂停'))
    expect(onResume).toHaveBeenCalledTimes(1)
  })

  it('offers no one-click resume without a recorded prior state, and says why', () => {
    render(createElement(WaitingResumeHint, { upstreamCount: 3, onResume: vi.fn() }))

    expect(hint()?.getAttribute('data-waiting-resume-target')).toBe('unknown')
    expect(hint()?.textContent).toContain('上游依赖已全部完成（3 项）')
    expect(hint()?.textContent).toContain('未能确定要恢复到的状态')
    expect(hint()?.textContent).toContain('自行选择')
    // 绝不默认切进行中：没有记录就没有任何一键入口。
    expect(screen.queryByText('恢复为进行中')).toBeNull()
    expect(document.querySelector('[data-resume-waiting]')).toBeNull()
  })

  it('states the caller-supplied reason when there is no record', () => {
    render(createElement(WaitingResumeHint, {
      upstreamCount: 1,
      unresolvedReason: '没有记录到进入「等待」前的状态，请在本页「状态」中自行选择要恢复到的状态。',
    }))
    expect(hint()?.textContent).toContain('没有记录到进入「等待」前的状态')
    expect(document.querySelector('[data-resume-waiting]')).toBeNull()
  })

  it('degrades to the explanation when a recorded target has no usable status', () => {
    // 记录的前态在当前空间不可用（已归档 / 不存在 / 终态 / waiting 类目）：
    // 调用点给 target=null + 原因，组件不得冒充命中。
    render(createElement(WaitingResumeHint, {
      upstreamCount: 2,
      target: null,
      unresolvedReason: '记录的前态在当前空间中不可用（可能已归档或不存在），请自行选择。',
    }))
    expect(hint()?.textContent).toContain('记录的前态在当前空间中不可用')
    expect(hint()?.getAttribute('data-waiting-resume-target')).toBe('unknown')
    expect(document.querySelector('[data-resume-waiting]')).toBeNull()
  })

  it('disables with a reason while a mutation is in flight', () => {
    render(createElement(WaitingResumeHint, {
      upstreamCount: 1,
      target: { statusDefinitionId: 'sys-status-in-progress', name: '进行中' },
      onResume: vi.fn(),
      pending: true,
    }))
    const button = screen.getByText('恢复为进行中')
    expect(button).toBeDisabled()
    expect(button.getAttribute('title')).toContain('上一次操作仍在处理中')
  })

  it('disables with a reason for an archived item', () => {
    render(createElement(WaitingResumeHint, {
      upstreamCount: 1,
      target: { statusDefinitionId: 'sys-status-paused', name: '已暂停' },
      onResume: vi.fn(),
      archived: true,
    }))
    const button = screen.getByText('恢复为已暂停')
    expect(button).toBeDisabled()
    expect(button.getAttribute('title')).toContain('已归档')
  })
})
