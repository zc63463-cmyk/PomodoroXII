import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import TimerPage from './page'
import { useSettingsStore } from '@/stores/settings-store'
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

// ★ 工单 A（2026-09-14）：today-summary 已改调 fetchFocusSummaryWindow。
//   mock 工厂必须补这个导出，否则页面测试在**模块解析期**就抛
//   「No "fetchFocusSummaryWindow" export is defined on the mock」——
//   不是断言失败，是整个文件炸。
const fetchFocusSummaryWindowMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/stats/stats-api', () => ({
  fetchFocusSummaryWindow: fetchFocusSummaryWindowMock,
}))

// ★ ADR-0008 S2 收口：建岛编排在页面测试里桩掉（真实行为见
//   session-island-launch.test.ts）；这里只断言"启动成功后确实带着
//   选中的 L3 调了它"这条接线本身。
const createLaunchSessionIslandsMock = vi.hoisted(() => vi.fn().mockResolvedValue({
  created: [], skipped: [], failed: [],
}))
vi.mock('@/lib/work-map/session-island-launch', () => ({
  createLaunchSessionIslands: createLaunchSessionIslandsMock,
}))

// ★ ADR-0008 D13 步 1：运行态导图端口读当前 L3 的 `.mm.md`（真实网络 → 桩掉）。
//   默认「尚无导图」（null）；接线断言见「运行态导图端口」describe。
const readWorkMapMock = vi.hoisted(() => vi.fn())
const writeWorkMapMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/work-map/work-map-api', () => ({
  readWorkMap: readWorkMapMock,
  writeWorkMap: writeWorkMapMock,
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

/**
 * 运行态 store 种子（工单② 与工单 B 两个 describe 共用）。
 * 从原 beforeEach 原样抽出 —— 行为逐行一致，只是不再复制第二份。
 */
function seedRunningTimerPage(): void {
  vi.clearAllMocks()
  readWorkMapMock.mockReset()
  readWorkMapMock.mockResolvedValue(null)
  writeWorkMapMock.mockReset()
  writeWorkMapMock.mockResolvedValue(0)
  fetchFocusSummaryWindowMock.mockReset()
  fetchFocusSummaryWindowMock.mockResolvedValue({
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
}

describe('TimerPage 运行中新建三级（工单②）', () => {
  beforeEach(seedRunningTimerPage)

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
    // 工单③→工单 A：运行态底部统计栏（标签「今日」= 本地日界显式窗口）
    expect(await screen.findByTestId('focus-summary-bar')).toHaveTextContent('今日 2 个番茄 · 专注 1.5h')
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

    expect(await screen.findByTestId('focus-summary-bar')).toHaveTextContent('今日 2 个番茄 · 专注 1.5h')
    expect(screen.getByRole('button', { name: 'Start focus session' })).toBeInTheDocument()
  })
})

describe('TimerPage 沉浸模式与二级归属（工单 B 2026-09-14）', () => {
  beforeEach(seedRunningTimerPage)

  it('★ 沉浸可逆：data-immersive 翻转，「退出沉浸」不在渐隐区内（永不渐隐）', async () => {
    render(createElement(TimerPage))

    const toggle = await screen.findByRole('button', { name: '沉浸模式' })
    const container = document.querySelector('[data-immersive]')
    expect(container?.getAttribute('data-immersive')).toBe('false')
    expect(toggle).toHaveAttribute('aria-pressed', 'false')

    fireEvent.click(toggle)

    const exit = screen.getByRole('button', { name: '退出沉浸' })
    expect(exit).toHaveAttribute('aria-pressed', 'true')
    expect(container?.getAttribute('data-immersive')).toBe('true')
    // 结构保证：退出按钮不落在渐隐区里，且仍可点 —— 这是"绝不允许把退出按钮
    // 自己渐隐掉"红线的可断言形式（jsdom 不加载 CSS，只能锁结构）。
    expect(screen.getByTestId('immersive-region').contains(exit)).toBe(false)
    expect(exit).toBeEnabled()

    fireEvent.click(exit)
    expect(container?.getAttribute('data-immersive')).toBe('false')
    expect(screen.getByRole('button', { name: '沉浸模式' })).toBeInTheDocument()
  })

  it('会话切换（sessionId 变化）时沉浸模式重置为关', async () => {
    render(createElement(TimerPage))
    fireEvent.click(await screen.findByRole('button', { name: '沉浸模式' }))
    expect(document.querySelector('[data-immersive]')?.getAttribute('data-immersive')).toBe('true')

    act(() => {
      useTimerStore.setState({
        session: { ...runningSession, sessionId: 'session-b' } as never,
      } as never)
    })

    await waitFor(() =>
      expect(document.querySelector('[data-immersive]')?.getAttribute('data-immersive')).toBe('false'))
    expect(screen.getByRole('button', { name: '沉浸模式' })).toBeInTheDocument()
  })

  it('二级归属：显示会话挂的二级工作项（displayKey + 标题）；查不到则留空不编造', async () => {
    render(createElement(TimerPage))

    expect(await screen.findByTestId('focus-context')).toHaveTextContent('P-2 Ship feature')

    act(() => { useTaskSpaceStore.setState({ workItems: [] } as never) })
    expect(screen.queryByTestId('focus-context')).toBeNull()
  })
})

// ── ADR-0008 D13 步 1：运行态导图端口「当前会话岛」─────────────────────────
/** 会话 session-a 的岛文件（形状与真实产出一致；session_id 对齐 runningSession）。 */
const ISLAND_FOR_RUNNING = `<!--
next_cid: 2
centers:
  - at: "node:Verify output/09-30 19:55 会话"
    cid: c1
    dir: right
    session_id: "session-a"
-->
# Verify output

<!--
cid: "c1"
session_id: "session-a"
-->
## 09-30 19:55 会话

### 验证输出
`

describe('TimerPage 运行态导图端口（ADR-0008 D13 步 1）', () => {
  beforeEach(seedRunningTimerPage)

  it('★ 以当前投入 L3 读导图；岛到端口 —— 会话节点高亮行渲染（fail-soft 读）', async () => {
    readWorkMapMock.mockResolvedValue(ISLAND_FOR_RUNNING)
    render(createElement(TimerPage))

    // 读的键 = 当前计划项的 L3（focusedWorkItemId），不是二级项
    await waitFor(() => expect(readWorkMapMock).toHaveBeenCalledWith('l3-a'))
    const sessionRow = await screen.findByTestId('map-session-node')
    expect(sessionRow).toHaveAttribute('data-current', 'true')
    expect(sessionRow).toHaveTextContent('09-30 19:55 会话')
    expect(screen.getByTestId('timer-map-port')).toHaveAttribute('data-minimal', 'false')
  })

  it('★ 沉浸切换：端口不消失、data-minimal 翻转（D12 裁决 1/2 的页面级接线）', async () => {
    readWorkMapMock.mockResolvedValue(ISLAND_FOR_RUNNING)
    render(createElement(TimerPage))
    expect(await screen.findByTestId('timer-map-port')).toHaveAttribute('data-minimal', 'false')

    fireEvent.click(screen.getByRole('button', { name: '沉浸模式' }))

    // 极简岛：同一 DOM 派生（卡片仍在，只是 data-minimal=true → CSS 隐文字）
    const port = screen.getByTestId('timer-map-port')
    expect(port).toHaveAttribute('data-minimal', 'true')
    expect(port.querySelectorAll('.ios-map-row').length).toBe(2)
    // 渐隐标记只打在伴奏卡上：端口刻意**不带** .timer-immersive-fade
    expect(port.className).not.toContain('timer-immersive-fade')
    expect(screen.getByTestId('immersive-region').querySelectorAll('.timer-immersive-fade').length)
      .toBeGreaterThan(0)
  })

  it('无导图（读回 null）→ 占位文案，端口不炸（fail-soft）', async () => {
    render(createElement(TimerPage))
    expect(await screen.findByTestId('map-port-empty')).toBeTruthy()
    expect(screen.queryByTestId('map-island')).toBeNull()
  })

  it('★ 快速记录（D13 步 2）：类型 + 文本 → 写出追加后的导图，端口即时出现新节点', async () => {
    readWorkMapMock.mockResolvedValue(ISLAND_FOR_RUNNING)
    writeWorkMapMock.mockResolvedValue(128)
    render(createElement(TimerPage))

    fireEvent.click(await screen.findByTestId('map-quick-problem'))
    fireEvent.change(screen.getByTestId('map-quick-input'), { target: { value: 'token 对照' } })
    fireEvent.click(screen.getByTestId('map-quick-submit'))

    await waitFor(() => expect(writeWorkMapMock).toHaveBeenCalledTimes(1))
    const [workItemId, written] = writeWorkMapMock.mock.calls[0] as [string, string]
    expect(workItemId).toBe('l3-a') // 写的是当前投入 L3 的导图
    expect(written).toContain('thought_type: "problem"')
    expect(written).toContain('### token 对照')
    // 端口即时反映（本地 state 已更新，无需再读一次服务端）
    expect(await screen.findByText('token 对照')).toBeTruthy()
  })
})

// ── 双体系兼容 2026-09-16：准备态 → 启动载荷带模式 ─────────────────────────
/** 准备态种子：无活动会话（locator / session 皆空）。 */
function seedIdleTimerPage(): void {
  vi.clearAllMocks()
  readWorkMapMock.mockReset()
  readWorkMapMock.mockResolvedValue(null)
  fetchFocusSummaryWindowMock.mockReset()
  fetchFocusSummaryWindowMock.mockResolvedValue({
    period_days: 1, total_sessions: 0, valid_sessions: 0, interrupted_sessions: 0,
    focused_seconds: 0, planned_seconds: 0, estimate_accuracy: 0, by_hour: [],
  })
  useSettingsStore.setState({
    pomodoroDuration: 25, shortBreakDuration: 5, longBreakDuration: 15,
    longBreakInterval: 4, autoStartBreaks: false, autoStartPomodoros: false,
  })
  useSpaceStore.setState({ currentSpaceId: 'space-1' } as never)
  useTaskSpaceStore.setState({
    workItems: [
      { id: 'l2-x', depth: 2, parentId: 'l1', title: 'Ship feature', displayKey: 'P-2', version: 3 },
    ],
    selectedWorkItemId: 'l2-x',
    selectedProjectId: 'proj-1',
    relations: [],
    definitions: [],
    hydrate: vi.fn(),
    reset: vi.fn(),
    selectWorkItem: vi.fn(),
    acknowledgeLaunch: vi.fn(),
    clearLaunchAck: vi.fn(),
    hasLaunchAck: vi.fn(() => true),
    createChild: vi.fn(),
  } as never)
  useTimerStore.setState({
    locator: null, session: null, localProvisional: null,
    ownershipMode: 'none', nowMs: Date.parse('2026-09-13T08:00:00Z'), error: null,
  } as never)
}

describe('TimerPage 双体系兼容 · 准备态模式（2026-09-16）', () => {
  beforeEach(seedIdleTimerPage)

  it('★ 启动成功后为选中的 L3 建岛（ADR-0008 S2：fire-and-forget，不阻断会话）', async () => {
    // 在 l2-x 下补一个三级项，并勾进本次计划
    useTaskSpaceStore.setState((current) => ({
      workItems: [
        ...current.workItems,
        { id: 'l3-plan', depth: 3, parentId: 'l2-x', title: '卡点分析记录', displayKey: 'P-3', version: 1 },
      ],
    }) as never)
    render(createElement(TimerPage))

    fireEvent.click(await screen.findByRole('checkbox', { name: '卡点分析记录' }))
    fireEvent.click(screen.getByRole('button', { name: 'Start focus session' }))

    await waitFor(() => expect(createLaunchSessionIslandsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: expect.any(String),
        startedAt: expect.any(String),
        level3WorkItemIds: ['l3-plan'],
      }),
    ))
  })

  it('默认 work 启动：载荷带 sessionType=work 与设置里的番茄时长', async () => {
    render(createElement(TimerPage))

    fireEvent.click(await screen.findByRole('button', { name: 'Start focus session' }))

    await waitFor(() => expect(coordinatorSpies.start).toHaveBeenCalledWith(
      expect.objectContaining({ sessionType: 'work', plannedSeconds: 1500 }),
    ))
  })

  it('切到短休后启动：载荷带 sessionType=short_break、时长取 shortBreakDuration，且不弹阻塞确认', async () => {
    render(createElement(TimerPage))

    fireEvent.click(await screen.findByRole('button', { name: '短休息' }))
    fireEvent.click(screen.getByRole('button', { name: 'Start focus session' }))

    await waitFor(() => expect(coordinatorSpies.start).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionType: 'short_break', plannedSeconds: 300, level3WorkItemIds: [],
      }),
    ))
    // 休息不是投入：依赖域的阻塞确认弹窗不该出现（即便 L2 被标记未确认）
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
