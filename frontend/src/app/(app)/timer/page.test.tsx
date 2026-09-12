import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import TimerPage from './page'
import { useSpaceStore } from '@/stores/space-store'
import { useTaskSpaceStore } from '@/stores/task-space-store'
import { useTimerStore } from '@/stores/timer-store'

/**
 * 工单②（2026-09-13）页面级接线测试：运行中新建三级。
 *
 * 计时页依赖很重（IndexedDB 绑定、活跃会话协调器、复盘草稿……），这里把
 * 全部外部依赖 mock 成惰性桩，只保留真实的三家 store（space/timer/task-space），
 * 以便断言「创建入口收到的 parentId = 会话二级」「创建成功后加入计划」
 * 「失败可见且不改计划」这条链路。
 */

const pushMock = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: pushMock }) }))

const fakeDatabase = vi.hoisted(() => ({ focusSessions: { get: vi.fn(async () => undefined) } }))
vi.mock('@/services/space-db', () => ({
  spaceDBManager: { currentBinding: { database: fakeDatabase, spaceId: 'space-1' } },
}))
vi.mock('@/services/meta-database', () => ({ metaDB: {} }))

vi.mock('@/lib/task-space/task-space-repository', () => ({
  TaskSpaceRepository: class { listCachedRelations = async () => [] },
}))
vi.mock('@/lib/task-space/work-item-note-repository', () => ({
  WorkItemNoteRepository: class {
    read = vi.fn(async () => null)
    appendBlocks = vi.fn()
  },
}))
vi.mock('@/lib/focus-session/focus-session-repository', () => ({
  FocusSessionRepository: class {
    listCached = async () => []
    addPlanItem = vi.fn().mockResolvedValue(undefined)
  },
  readSessionCommandReceipts: async () => [],
}))
vi.mock('@/lib/task-space/timer-note-composer-draft-registry', () => ({
  TimerNoteComposerDraftController: class {
    hydrate = vi.fn().mockResolvedValue(undefined)
    dispose = vi.fn().mockResolvedValue(undefined)
    flush = vi.fn().mockResolvedValue(undefined)
    switchTo = vi.fn().mockResolvedValue(undefined)
  },
}))

const fetchFocusSummaryMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/stats/stats-api', () => ({
  fetchFocusSummary: fetchFocusSummaryMock,
}))

const coordinatorSpies = vi.hoisted(() => ({
  start: vi.fn(), pause: vi.fn(), resume: vi.fn(), end: vi.fn(),
  takeover: vi.fn(), updateSessionNote: vi.fn(), setCurrentPlanItem: vi.fn(),
  addPlanItem: vi.fn().mockResolvedValue(undefined),
  removePlanItem: vi.fn(), setCompletionDraft: vi.fn(),
}))
// ★ 必须是稳定引用：页面首效应的依赖数组里有 identity/provisionalLock，
//   每次渲染返回新字面量会触发无限 setState 循环（实测直接 OOM 打崩 worker）。
const identityStub = vi.hoisted(() => ({ deviceId: 'dev-1', tabId: 'tab-1' }))
const lockStub = vi.hoisted(() => ({}))
vi.mock('@/lib/focus-session/active-session-provider', () => ({
  useActiveSessionCoordinator: () => coordinatorSpies,
  useActiveSessionIdentity: () => identityStub,
  useActiveSessionProvisionalLock: () => lockStub,
}))

const runningSession = {
  sessionId: 'session-a', startedAt: '2026-09-13T08:00:00Z', endedAt: null,
  pauseStartedAt: null, plannedSeconds: 1500, pausedSeconds: 0, focusedSeconds: 0,
  clockState: 'running', version: 1,
}
const aggregate = {
  session: runningSession,
  context: { sessionId: 'session-a', level2WorkItemId: 'l2-x' },
  attribution: { effective: true },
  plan: [{ id: 'plan-a', workItemId: 'l3-a', titleSnapshot: 'Verify output', currentDuringSession: true, completionDraft: false, removedAt: null }],
  outcomes: [], commandEnvelopes: [], commandReceipts: [],
}

describe('TimerPage 运行中新建三级（工单②）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fetchFocusSummaryMock.mockReset()
    fetchFocusSummaryMock.mockResolvedValue({
      period_days: 1, total_sessions: 3, valid_sessions: 2, interrupted_sessions: 1,
      focused_seconds: 5400, planned_seconds: 7200, estimate_accuracy: 0.75, by_hour: [],
    })
    useSpaceStore.setState({ currentSpaceId: 'space-1' } as never)
    useTaskSpaceStore.setState({
      workItems: [
        { id: 'l2-x', depth: 2, parentId: 'l1', title: 'Ship feature', displayKey: 'P-2', version: 3 },
        { id: 'l3-a', depth: 3, parentId: 'l2-x', title: 'Verify output', displayKey: 'P-3', version: 2 },
      ],
      selectedWorkItemId: null,
      selectedProjectId: 'proj-1',
      relations: [],
      definitions: [],
      hydrate: vi.fn(),
      reset: vi.fn(),
      selectWorkItem: vi.fn(),
      acknowledgeLaunch: vi.fn(),
      clearLaunchAck: vi.fn(),
      hasLaunchAck: vi.fn(() => false),
      createChild: vi.fn(),
    } as never)
    useTimerStore.setState({
      locator: { ownerDeviceId: 'dev-1', ownerTabId: 'tab-1', session: aggregate } as never,
      session: runningSession as never,
      localProvisional: null,
      ownershipMode: 'owner',
      nowMs: Date.parse('2026-09-13T08:10:00Z'),
      error: null,
    } as never)
  })

  it('创建被调用时 parentId = 会话二级项；成功后新项加入计划、输入清空', async () => {
    const createChild = vi.fn(async (parentId: string, input: { title?: string }) => {
      const created = { id: 'l3-new', depth: 3, parentId, title: input.title, displayKey: 'P-9', version: 1 }
      // 复刻 store.createChild 的行为：先落 workItems 再返回
      useTaskSpaceStore.setState((current) => ({ workItems: [...current.workItems, created] }) as never)
      return created
    })
    useTaskSpaceStore.setState({ createChild } as never)

    render(createElement(TimerPage))

    fireEvent.change(screen.getByLabelText('新三级标题'), { target: { value: '新三级 A' } })
    fireEvent.click(screen.getByRole('button', { name: '+ 新建三级' }))

    await waitFor(() => expect(createChild).toHaveBeenCalledWith('l2-x', { title: '新三级 A' }))
    await waitFor(() => expect(coordinatorSpies.addPlanItem).toHaveBeenCalledWith(
      expect.objectContaining({ workItemId: 'l3-new' }),
    ))
    await waitFor(() => expect(screen.getByLabelText('新三级标题')).toHaveValue(''))
    // 工单③：运行态底部统计栏（标签按服务端真实口径 = 近 1 天）
    expect(await screen.findByTestId('focus-summary-bar')).toHaveTextContent('近 1 天 2 个番茄 · 专注 1.5h')
  })

  it('创建被拒（离线禁令）：alert 呈现原因、输入保留、计划不动', async () => {
    useTaskSpaceStore.setState({
      createChild: vi.fn().mockRejectedValue(new Error('offline_formal_creation_forbidden')),
    } as never)

    render(createElement(TimerPage))

    fireEvent.change(screen.getByLabelText('新三级标题'), { target: { value: '离线想建' } })
    fireEvent.click(screen.getByRole('button', { name: '+ 新建三级' }))

    const alerts = await screen.findAllByRole('alert')
    expect(alerts.map((node) => node.textContent).join('\n')).toContain('offline_formal_creation_forbidden')
    expect(coordinatorSpies.addPlanItem).not.toHaveBeenCalled()
    expect(screen.getByLabelText('新三级标题')).toHaveValue('离线想建')
  })

  it('准备态布局底部同样渲染统计栏（工单③：规格 L457/L505 两处）', async () => {
    useTimerStore.setState({
      locator: null, session: null, localProvisional: null,
      ownershipMode: 'none', nowMs: Date.parse('2026-09-13T08:10:00Z'), error: null,
    } as never)

    render(createElement(TimerPage))

    expect(await screen.findByTestId('focus-summary-bar')).toHaveTextContent('近 1 天 2 个番茄 · 专注 1.5h')
    expect(screen.getByRole('button', { name: 'Start focus session' })).toBeInTheDocument()
  })
})
