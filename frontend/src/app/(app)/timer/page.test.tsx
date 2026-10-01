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

/**
 * D13 步 3-4b：结束态「岛总览」要走 `readLocalAggregate` 的**真实表访问路径**，
 * 故 fakeDatabase 从"只有 focusSessions.get"扩成「可变 store + 通用表链桩」。
 * 既有用例只用到 `focusSessions.get`（store 默认为空 → 与原行为等价）。
 */
const fakeStore = vi.hoisted(() => ({
  focusSessions: [] as Array<Record<string, unknown>>,
  sessionTaskContexts: [] as Array<Record<string, unknown>>,
  sessionAttributionRevisions: [] as Array<Record<string, unknown>>,
  sessionWorkItemPlans: [] as Array<Record<string, unknown>>,
  sessionWorkItemOutcomes: [] as Array<Record<string, unknown>>,
  sessionCommandEnvelopes: [] as Array<Record<string, unknown>>,
}))
const fakeDatabase = vi.hoisted(() => {
  const table = (key: keyof typeof fakeStore) => {
    const rows = () => fakeStore[key]
    const chain = {
      first: async () => rows()[0],
      toArray: async () => rows(),
      count: async () => rows().length,
    }
    return {
      get: async () => rows()[0],
      toArray: async () => rows(),
      where: () => ({ equals: () => chain }),
      orderBy: () => ({ toArray: async () => rows(), reverse: () => ({ toArray: async () => rows() }) }),
      put: async () => undefined,
      add: async () => undefined,
      delete: async () => undefined,
    }
  }
  return {
    focusSessions: table('focusSessions'),
    sessionTaskContexts: table('sessionTaskContexts'),
    sessionAttributionRevisions: table('sessionAttributionRevisions'),
    sessionWorkItemPlans: table('sessionWorkItemPlans'),
    sessionWorkItemOutcomes: table('sessionWorkItemOutcomes'),
    sessionCommandEnvelopes: table('sessionCommandEnvelopes'),
    sessionReviewDrafts: table('sessionCommandEnvelopes'),
  }
})
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
/** 结束态总览用例需要控制「本地缓存会话列表」（默认空 = 既有行为）。 */
const focusListCachedMock = vi.hoisted(() => vi.fn(async () => [] as Array<Record<string, unknown>>))
vi.mock('@/lib/focus-session/focus-session-repository', () => ({
  FocusSessionRepository: class {
    listCached = focusListCachedMock
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
  focusListCachedMock.mockReset()
  focusListCachedMock.mockResolvedValue([])
  for (const rows of Object.values(fakeStore)) rows.length = 0
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

/** 带一个**可编辑节点**（cid c2）的岛 —— 节点编辑页面接线断言。 */
const ISLAND_EDITABLE_FOR_RUNNING = `<!--
next_cid: 3
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

<!--
thought_type: "problem"
cid: "c2"
-->
### 旧标题
`

describe('TimerPage 运行态导图端口（ADR-0008 D13 步 1）', () => {
  beforeEach(seedRunningTimerPage)

  it('★ 以当前投入 L3 读导图；中央编辑区与小视图**各自**渲染同一棵树', async () => {
    readWorkMapMock.mockResolvedValue(ISLAND_FOR_RUNNING)
    render(createElement(TimerPage))

    // 读的键 = 当前计划项的 L3（focusedWorkItemId），不是二级项
    await waitFor(() => expect(readWorkMapMock).toHaveBeenCalledWith('l3-a'))
    // 中央编辑区（D15：焦点区下半）
    const editor = await screen.findByTestId('timer-map-editor')
    expect(editor.querySelector('svg.wm-tree')).not.toBeNull()
    expect(screen.getByTestId('map-editor-canvas')).toBeTruthy()
    // 右栏小视图
    expect(screen.getByTestId('timer-map-port')).toHaveAttribute('data-minimal', 'false')
    expect(screen.getByTestId('map-port-canvas')).toBeTruthy()
    // 两处都出现会话节点（同一份几何渲染两次）
    expect(screen.getAllByTestId('wm-session-node').length).toBe(2)
  })

  it('★ 沉浸切换：小视图 data-minimal 翻转、编辑区保留（D15：记录面常驻中央）', async () => {
    readWorkMapMock.mockResolvedValue(ISLAND_FOR_RUNNING)
    render(createElement(TimerPage))
    expect(await screen.findByTestId('timer-map-port')).toHaveAttribute('data-minimal', 'false')

    fireEvent.click(screen.getByRole('button', { name: '沉浸模式' }))

    // 极简岛：小视图同一 DOM 派生（卡片仍在，只是 data-minimal=true → CSS 隐文字）
    const port = screen.getByTestId('timer-map-port')
    expect(port).toHaveAttribute('data-minimal', 'true')
    expect(port.querySelectorAll('.wm-node').length).toBe(2)
    // 渐隐标记只打在伴奏卡上：小视图刻意**不带** .timer-immersive-fade
    expect(port.className).not.toContain('timer-immersive-fade')
    expect(screen.getByTestId('immersive-region').querySelectorAll('.timer-immersive-fade').length)
      .toBeGreaterThan(0)
    // ★ 用户 2026-10-01 裁决：沉浸时**中央编辑区保留**（不在渐隐区、仍在 DOM）
    const editor = screen.getByTestId('timer-map-editor')
    expect(screen.getByTestId('immersive-region').contains(editor)).toBe(false)
    expect(editor.querySelector('svg.wm-tree')).not.toBeNull()
  })

  it('无导图（读回 null）→ 两处都显示占位，页面不炸（fail-soft）', async () => {
    render(createElement(TimerPage))
    expect(await screen.findByTestId('map-port-empty')).toBeTruthy()
    expect(screen.getByTestId('map-editor-empty')).toBeTruthy()
    expect(screen.queryByTestId('map-port-canvas')).toBeNull()
  })

  it('★ 快速记录（D13 步 2 → D15 迁至编辑区）：类型 + 文本 → 写出追加后的导图并即时可见', async () => {
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
    // 即时反映（本地 state 已更新，无需再读一次服务端）。
    // 注意：中央编辑区与右栏小视图都会渲染该文本（同一份几何渲染两次）
    // → 用 canvas 作用域断言，避免多重命中歧义。
    const canvas = screen.getByTestId('map-editor-canvas')
    await waitFor(() => expect(canvas.textContent).toContain('token 对照'))
  })

  it('★ 节点编辑接线：改名 → writeWorkMap 收到含新标题、不含旧标题的文本（本地即时反映）', async () => {
    readWorkMapMock.mockResolvedValue(ISLAND_EDITABLE_FOR_RUNNING)
    writeWorkMapMock.mockResolvedValue(64)
    render(createElement(TimerPage))

    const canvas = await screen.findByTestId('map-editor-canvas')
    const node = canvas.querySelector('.wm-node[data-cid="c2"]')
    expect(node).not.toBeNull()
    fireEvent.click(node!)
    fireEvent.click(screen.getByTestId('map-action-rename'))
    fireEvent.change(screen.getByTestId('map-action-input'), { target: { value: '新标题' } })
    fireEvent.click(screen.getByTestId('map-action-submit'))

    await waitFor(() => expect(writeWorkMapMock).toHaveBeenCalledTimes(1))
    const [workItemId, written] = writeWorkMapMock.mock.calls[0] as [string, string]
    expect(workItemId).toBe('l3-a')
    expect(written).toContain('### 新标题')
    expect(written).not.toContain('### 旧标题')
    // 即时反映（不等下一次读）：编辑区画布已含新标题
    await waitFor(() =>
      expect(screen.getByTestId('map-editor-canvas').textContent).toContain('新标题'),
    )
  })

  it('★ 节点编辑接线：删除二次确认 → 文本少一个节点、该 cid 消失', async () => {
    readWorkMapMock.mockResolvedValue(ISLAND_EDITABLE_FOR_RUNNING)
    writeWorkMapMock.mockResolvedValue(48)
    render(createElement(TimerPage))

    const canvas = await screen.findByTestId('map-editor-canvas')
    fireEvent.click(canvas.querySelector('.wm-node[data-cid="c2"]')!)
    fireEvent.click(screen.getByTestId('map-action-delete'))
    expect(writeWorkMapMock).not.toHaveBeenCalled() // 第一次点击只确认
    fireEvent.click(screen.getByTestId('map-action-delete'))

    await waitFor(() => expect(writeWorkMapMock).toHaveBeenCalledTimes(1))
    const written = writeWorkMapMock.mock.calls[0][1] as string
    expect(written).not.toContain('cid: "c2"')
    expect(written).not.toContain('### 旧标题')
    expect(written).toContain('### 验证输出')
  })

  it('★ 点即定位（ADR-0008 D15）：小视图点击带 cid 节点 → 中央编辑区对应节点获得 wm-node--focus 环，存量无 cid 节点不响应', async () => {
    readWorkMapMock.mockResolvedValue(ISLAND_EDITABLE_FOR_RUNNING)
    render(createElement(TimerPage))

    const port = await screen.findByTestId('timer-map-port')
    const editor = screen.getByTestId('timer-map-editor')

    // 初始状态：无 focus 环
    expect(editor.querySelector('.wm-node--focus')).toBeNull()

    // 1. 在右栏小视图中点击带 cid 的思考节点（cid="c2"）
    const portThoughtNode = port.querySelector('.wm-node[data-thought="problem"]')
    expect(portThoughtNode).not.toBeNull()
    fireEvent.click(portThoughtNode!)

    // 中央编辑区中对应节点出现 focus 环
    const editorThoughtNode = editor.querySelector('.wm-node[data-thought="problem"]')
    expect(editorThoughtNode).toHaveClass('wm-node--focus')
    expect(editorThoughtNode).toHaveAttribute('data-focus', 'true')

    // 2. 点击右栏小视图的会话节点（带 cid="c1"）
    const portSessionNode = port.querySelector('[data-testid="wm-session-node"]')
    expect(portSessionNode).not.toBeNull()
    fireEvent.click(portSessionNode!)

    const editorSessionNode = editor.querySelector('[data-testid="wm-session-node"]')
    expect(editorSessionNode).toHaveClass('wm-node--focus')
    expect(editorThoughtNode).not.toHaveClass('wm-node--focus')

    // 3. 点击无 cid 存量标题行：不触发定位
    const portReadonlyNode = port.querySelector('.wm-node[data-readonly="true"]')
    expect(portReadonlyNode).not.toBeNull()
    fireEvent.click(portReadonlyNode!)
    const editorStockNode = editor.querySelector('.wm-node:not([data-session="true"])[data-readonly="true"]')
    expect(editorStockNode).not.toHaveClass('wm-node--focus')
  })

  it('★ 沉浸极简态下点即定位仍生效，写回操作成功后清空 focus 环', async () => {
    readWorkMapMock.mockResolvedValue(ISLAND_EDITABLE_FOR_RUNNING)
    writeWorkMapMock.mockResolvedValue(128)
    render(createElement(TimerPage))

    // 进入沉浸模式
    fireEvent.click(await screen.findByRole('button', { name: '沉浸模式' }))
    const port = screen.getByTestId('timer-map-port')
    expect(port).toHaveAttribute('data-minimal', 'true')
    const editor = screen.getByTestId('timer-map-editor')

    // 极简态下点小视图思考节点
    const portThoughtNode = port.querySelector('.wm-node[data-thought="problem"]')
    fireEvent.click(portThoughtNode!)

    const editorThoughtNode = editor.querySelector('.wm-node[data-thought="problem"]')
    expect(editorThoughtNode).toHaveClass('wm-node--focus')

    // 快速记录一条新思路 → 写回成功后清空 focus 环
    fireEvent.click(screen.getByTestId('map-quick-todo'))
    fireEvent.change(screen.getByTestId('map-quick-input'), { target: { value: '新待办' } })
    fireEvent.click(screen.getByTestId('map-quick-submit'))

    await waitFor(() => expect(writeWorkMapMock).toHaveBeenCalled())
    // focus 环已被清空
    await waitFor(() => expect(editor.querySelector('.wm-node--focus')).toBeNull())
  })
})

// ── D13 步 3-4b：结束态「岛总览」──────────────────────────────────────────
const ENDED_SESSION_ID = 'session-e'

/** 结束会话所属 L3 的岛（会话岛 + 一个 problem / 一个 todo）。 */
const ISLAND_FOR_ENDED = `<!--
next_cid: 4
centers:
  - at: "node:Verify output/09-30 19:55 会话"
    cid: c1
    dir: right
    session_id: "${ENDED_SESSION_ID}"
-->
# Verify output

<!--
cid: "c1"
session_id: "${ENDED_SESSION_ID}"
-->
## 09-30 19:55 会话

<!--
thought_type: "problem"
cid: "c2"
-->
### 甲

<!--
thought_type: "todo"
cid: "c3"
-->
### 乙
`

/**
 * 结束态种子：locator / 本地临时皆空 → 走 `focusRepository.listCached()` +
 * `readLocalAggregate()` 的真实路径把 `endedAggregate` 立起来。
 */
function seedEndedTimerPage(): void {
  focusListCachedMock.mockResolvedValue([
    {
      sessionId: ENDED_SESSION_ID, clockState: 'ended', reviewState: 'pending',
      ownershipState: 'owned', validity: 'pending',
    },
  ])
  fakeStore.focusSessions.push({
    id: ENDED_SESSION_ID, sessionId: ENDED_SESSION_ID,
    startedAt: '2026-09-13T08:00:00Z', endedAt: '2026-09-13T08:25:00Z', pauseStartedAt: null,
    plannedSeconds: 1500, pausedSeconds: 0, focusedSeconds: 1200, breakSeconds: 0,
    grossSeconds: 1500, timerCompletion: 'completed', clockState: 'ended', version: 2,
    sessionRevision: 1, validity: 'pending', validityReason: null, reviewState: 'pending',
    ownershipState: 'owned', sessionType: 'work', overallProgress: null, mood: null,
    sessionNote: null,
  })
  fakeStore.sessionTaskContexts.push({ sessionId: ENDED_SESSION_ID, level2WorkItemId: 'l2-x' })
  fakeStore.sessionAttributionRevisions.push({ sessionId: ENDED_SESSION_ID, effective: true })
  fakeStore.sessionWorkItemPlans.push({
    id: 'plan-e', sessionId: ENDED_SESSION_ID, workItemId: 'l3-a', titleSnapshot: 'Verify output',
    currentDuringSession: true, completionDraft: false, removedAt: null, planRank: 0,
  })
  useTimerStore.setState({
    locator: null, session: null, localProvisional: null,
    ownershipMode: 'none', nowMs: Date.parse('2026-09-13T08:26:00Z'), error: null,
  } as never)
}

describe('TimerPage 结束态岛总览（ADR-0008 D13 步 3-4b）', () => {
  beforeEach(seedRunningTimerPage)

  it('★ 读结束会话 focused plan item 的 L3 导图；总览挂在复盘面板**下方**且只读', async () => {
    seedEndedTimerPage()
    readWorkMapMock.mockResolvedValue(ISLAND_FOR_ENDED)
    render(createElement(TimerPage))

    // 键 = 结束会话 focused plan item 的 L3（不是二级项）
    await waitFor(() => expect(readWorkMapMock).toHaveBeenCalledWith('l3-a'))

    const overview = await screen.findByTestId('timer-map-overview')
    expect(screen.getByTestId('map-overview-canvas')).toBeTruthy()
    expect(overview).toHaveTextContent('工作导图 · 岛总览')
    // 「复盘面板下方」= 焦点容器里最后一个直接子（前面是复盘面板）
    const focusContainer = overview.parentElement as HTMLElement
    expect(focusContainer.children.length).toBeGreaterThanOrEqual(2)
    expect([...focusContainer.children].indexOf(overview)).toBe(focusContainer.children.length - 1)
    // 只读：无编辑入口、无快速记录行
    expect(overview.querySelectorAll('.wm-node[data-cid]')).toHaveLength(0)
    expect(screen.queryByTestId('map-node-actions')).toBeNull()
    expect(screen.queryByTestId('map-quick')).toBeNull()
  })

  it('★ 结束态总览可筛选（图例点「问题」→ 命中高亮、其余 dim、节点数不变）', async () => {
    seedEndedTimerPage()
    readWorkMapMock.mockResolvedValue(ISLAND_FOR_ENDED)
    render(createElement(TimerPage))

    // 先等地图到位（总览容器先出现、canvas 在 endedMapText 落定后才渲染 → 逐步增强）
    await screen.findByTestId('map-overview-canvas')
    const overview = screen.getByTestId('timer-map-overview')
    const total = overview.querySelectorAll('.wm-node').length
    expect(total).toBeGreaterThan(1)

    fireEvent.click(screen.getByTestId('map-legend-problem'))

    expect(overview.querySelectorAll('.wm-node').length).toBe(total) // dim 不 hide
    expect(overview.querySelectorAll('.wm-node[data-highlight="true"]').length).toBeGreaterThan(0)
    expect(overview.querySelectorAll('.wm-node[data-dim="true"]').length).toBeGreaterThan(0)
  })
})

// ── 双体系兼容 2026-09-16：准备态 → 启动载荷带模式 ─────────────────────────
/** 准备态种子：无活动会话（locator / session 皆空）。 */
function seedIdleTimerPage(): void {
  vi.clearAllMocks()
  readWorkMapMock.mockReset()
  readWorkMapMock.mockResolvedValue(null)
  writeWorkMapMock.mockReset()
  writeWorkMapMock.mockResolvedValue(0)
  focusListCachedMock.mockReset()
  focusListCachedMock.mockResolvedValue([])
  for (const rows of Object.values(fakeStore)) rows.length = 0
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

// ── D13 步 3-4a：准备态「主图」弹层（方案 C，ADR-0008 D18）──────────────────
describe('TimerPage 准备态主图弹层（ADR-0008 D18）', () => {
  beforeEach(seedIdleTimerPage)

  it('★ 选中非三级 → 按钮 disabled + aria-disabled + 提示；选中三级 → 可点', async () => {
    useTaskSpaceStore.setState((current) => ({
      workItems: [
        ...current.workItems,
        { id: 'l3-a', depth: 3, parentId: 'l2-x', title: 'Verify output', displayKey: 'P-3', version: 2 },
      ],
    }) as never)
    const { rerender } = render(createElement(TimerPage))

    // 种子默认 selectedWorkItemId = 'l2-x'（二级）→ 不可点
    const button = await screen.findByTestId('launcher-view-map')
    expect(button).toBeDisabled()
    expect(button).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByTestId('launcher-selected-title')).toHaveTextContent('已选：Ship feature')
    expect(screen.getByTestId('launcher-view-map-hint')).toHaveTextContent('选择三级项后可查看主图')

    // 切到三级项 → 可点、提示消失（store 更新触发页面重渲染 → 需包 act）
    act(() => {
      useTaskSpaceStore.setState({ selectedWorkItemId: 'l3-a' } as never)
    })
    rerender(createElement(TimerPage))
    expect(screen.getByTestId('launcher-view-map')).toBeEnabled()
    expect(screen.getByTestId('launcher-selected-title')).toHaveTextContent('已选：Verify output')
    expect(screen.queryByTestId('launcher-view-map-hint')).toBeNull()
  })

  it('★ 懒读 + 弹层：**打开前不读**；点开才 readWorkMap(L3)、面板 role=dialog、内容=主图；Esc 关 + 焦点归还', async () => {
    useTaskSpaceStore.setState((current) => ({
      workItems: [
        ...current.workItems,
        { id: 'l3-a', depth: 3, parentId: 'l2-x', title: 'Verify output', displayKey: 'P-3', version: 2 },
      ],
    }) as never)
    useTaskSpaceStore.setState({ selectedWorkItemId: 'l3-a' } as never)
    readWorkMapMock.mockResolvedValue(ISLAND_FOR_ENDED)
    render(createElement(TimerPage))

    const button = await screen.findByTestId('launcher-view-map')
    // 懒读：**没打开之前一次都不读**
    expect(readWorkMapMock).not.toHaveBeenCalled()
    expect(screen.queryByTestId('map-preview-panel')).toBeNull()

    button.focus()
    fireEvent.click(button)

    const panel = await screen.findByTestId('map-preview-panel')
    expect(panel).toHaveAttribute('role', 'dialog')
    expect(panel).toHaveAttribute('aria-modal', 'true')
    expect(panel).toHaveAttribute('aria-label', '工作导图 · 主图')

    await waitFor(() => expect(readWorkMapMock).toHaveBeenCalledWith('l3-a'))
    expect(await screen.findByTestId('map-overview-canvas')).toBeTruthy()
    expect(screen.getByTestId('timer-map-overview')).toHaveTextContent('工作导图 · 主图')
    // 只读：无编辑入口
    expect(document.querySelectorAll('.wm-node[data-cid]')).toHaveLength(0)

    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByTestId('map-preview-panel')).toBeNull())
    expect(document.activeElement).toBe(button) // 焦点归还触发按钮
  })
})

describe('TimerPage 双体系兼容 · 准备态模式（2026-09-16）', () => {
  beforeEach(seedIdleTimerPage)

  it('★ 启动成功后为选中的 L3 建岛（ADR-0008 S2：fire-and-forget，不阻断会话）', async () => {
    // 在 l2-x 下补一个三级项，经「任务选择」Modal 勾进本次计划（②落地后的路径）
    useTaskSpaceStore.setState((current) => ({
      workItems: [
        ...current.workItems,
        { id: 'l3-plan', depth: 3, parentId: 'l2-x', title: '卡点分析记录', displayKey: 'P-3', version: 1 },
      ],
    }) as never)
    render(createElement(TimerPage))

    fireEvent.click(await screen.findByTestId('launcher-browse-all'))
    fireEvent.click(await screen.findByRole('checkbox', { name: '卡点分析记录' }))
    fireEvent.click(screen.getByRole('button', { name: '完成' }))
    await waitFor(() => expect(screen.queryByTestId('task-picker-modal')).toBeNull())

    fireEvent.click(screen.getByRole('button', { name: 'Start focus session' }))

    await waitFor(() => expect(createLaunchSessionIslandsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: expect.any(String),
        startedAt: expect.any(String),
        level3WorkItemIds: ['l3-plan'],
      }),
    ))
  })

  it('★ ② 任务选择 Modal：勾三级 → 关闭 → 启动器摘要可见（无内联控件），CTA 载荷带计划', async () => {
    useTaskSpaceStore.setState((current) => ({
      workItems: [
        ...current.workItems,
        { id: 'l3-plan', depth: 3, parentId: 'l2-x', title: '卡点分析记录', displayKey: 'P-3', version: 1 },
      ],
    }) as never)
    render(createElement(TimerPage))

    // 打开 Modal：含归属 select + 三级 checkbox + 筛选（外派单验收 1）
    fireEvent.click(await screen.findByTestId('launcher-browse-all'))
    expect(await screen.findByTestId('task-picker-modal')).toHaveAttribute('role', 'dialog')
    expect(screen.getByLabelText('Level 2 attribution')).toBeInTheDocument()
    expect(screen.getByLabelText('搜索工作项')).toBeInTheDocument()
    expect(screen.getByLabelText('按状态筛选')).toBeInTheDocument()

    // 勾三级 → 关闭
    fireEvent.click(await screen.findByRole('checkbox', { name: '卡点分析记录' }))
    fireEvent.click(screen.getByRole('button', { name: '完成' }))
    await waitFor(() => expect(screen.queryByTestId('task-picker-modal')).toBeNull())

    // 启动器摘要可见；归属 select 不再内联在启动器里（外派单验收 3）
    expect(screen.queryByLabelText('Level 2 attribution')).toBeNull()
    expect(screen.getByTestId('launcher-attribution-summary')).toHaveTextContent('归属：Ship feature')
    expect(screen.getByTestId('launcher-attribution-summary')).toHaveTextContent('三级计划 1 项')

    // 开始专注仍可达：载荷带归属与计划（外派单验收 5）
    fireEvent.click(screen.getByRole('button', { name: 'Start focus session' }))
    await waitFor(() => expect(coordinatorSpies.start).toHaveBeenCalledWith(
      expect.objectContaining({ level2WorkItemId: 'l2-x', level3WorkItemIds: ['l3-plan'] }),
    ))
  })

  it('★ 启动选择从 store 的 selectedWorkItemId 派生（行为断言，替代源码 grep）', async () => {
    // 种子默认 selectedWorkItemId='l2-x'（二级）→ 派生：归属=自身、计划 0 项。
    // 可观察面 = 启动器摘要（launcher-attribution-summary）—— 它不读源码、
    // 只反映 deriveLaunchSelection(workItems, selectedWorkItemId) 的真实产物。
    render(createElement(TimerPage))

    expect(await screen.findByTestId('launcher-attribution-summary')).toHaveTextContent('归属：Ship feature')
    expect(screen.getByTestId('launcher-attribution-summary')).toHaveTextContent('三级计划 0 项')

    // store 切到三级项 → 派生跟着变：归属=父二级（Ship feature）、该三级冻结进计划 1 项
    act(() => {
      useTaskSpaceStore.setState((current) => ({
        workItems: [
          ...current.workItems,
          { id: 'l3-a', depth: 3, parentId: 'l2-x', title: 'Verify output', displayKey: 'P-3', version: 2 },
        ],
        selectedWorkItemId: 'l3-a',
      }) as never)
    })
    expect(await screen.findByTestId('launcher-attribution-summary')).toHaveTextContent('归属：Ship feature')
    expect(screen.getByTestId('launcher-attribution-summary')).toHaveTextContent('三级计划 1 项')

    // 同一派生源的第二个可观察面：Modal 内归属 select 的 value 同步为该二级项
    fireEvent.click(screen.getByTestId('launcher-browse-all'))
    expect(await screen.findByLabelText('Level 2 attribution')).toHaveValue('l2-x')
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
