'use client'

/**
 * 中央**导图编辑区**（运行态焦点区下半）—— ADR-0008 D15 / D16（D13 步 3-2）。
 *
 * ## 为什么在这里（D15 背景）
 * 用户视觉评审（2026-10-01）：焦点区环下方原本是一大块空白，而右栏 304px 里塞一棵
 * 树读不清 → **端口职责拆分**：中央大块 = 编辑区（看全、写思路）；右栏 = 小视图
 * （缩略 + 定位 + 极简岛）。沉浸模式只渐隐右栏伴奏，**中央编辑区保留**（记录面常驻）。
 *
 * ## 职责边界
 * - 渲染：与右栏小视图**共用** `WorkMapTree`（同一份几何、同一份 SVG 代码）
 * - 写入：`onQuickRecord`（快速记录）/ `onEdit`（节点编辑）由页面提供
 *   （读-改-写与 fail-soft 都在页面；本组件不发请求、不 know 会话/岛，见 D16-a）
 * - 数据：页面已读到的 `.mm.md` 原文（本组件只读它来做几何与选中态）
 *
 * ## 快速记录（自右栏端口迁移，D13 步 2 → D15）
 * 类型按钮行 + **浮层输入**（绝对定位，展开/收起不改变画布几何）。
 *
 * ## 节点编辑（D16 / 步 3-2）
 * 点击**可编辑节点**（当前会话岛内 `cid !== null` 且非会话节点）→ 选中：视觉环 +
 * 快速记录行**上方**的操作行（改名/加子/类型/注释/删除）。三个文本类操作复用浮层输入；
 * 类型 = 5 chip + 清除；删除 = **二次确认**（首次点变「确认删除？」、3 秒回退，不用
 * `window.confirm`）。选中态是组件内部 state，IO 全部上抛（模式同 quickRecord）。
 * 操作行/浮层是**动作入口**，不参与极简岛的文字隐藏（同 D12 裁决 2 的口径）。
 *
 * ## 幕布描述块编辑（PXII-FEAT-DESC-BLOCK）
 * `Shift+Enter`（键位表 `comment`）打开注释浮层；浮层内**幕布语义**：
 * `Enter` 换行、`Shift+Enter` 提交并收起、`Esc` 放弃。清空后提交 → `comment: null`
 * → 节点盒在下次布局时收缩回 `NODE_H_BASE`（内容驱动，不是一次性标记）。
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react'

import { EDITOR_KEY_HINTS, isTextEntryTarget, matchEditorKey } from '@/lib/work-map/editor-keymap'
import {
  ARCHIPELAGO_CARD_W,
  ARCHIPELAGO_GAP_X,
  findSessionIslandLayout,
  readWorkMapLayout,
  type MapTreeNode,
} from '@/lib/work-map/island-layout'
import type { MapNodeEditOp } from '@/lib/work-map/node-edits'
import { findNextNavNode, findParentNode } from '@/lib/work-map/tree-navigation'
import {
  THOUGHT_TYPES,
  THOUGHT_TYPE_LABEL,
  type ThoughtType,
} from '@/lib/work-map/thought-types'

import { WorkMapTree } from './work-map-tree'

export interface TimerMapEditorProps {
  /** 当前会话所属 L3 的岛文件原文；null = 尚无导图 / 读取失败 */
  mapText: string | null
  /** 当前会话 id（高亮其岛根） */
  sessionId: string | null
  /** 外部传入被定位节点的 cid（小视图点击定位；驱动 focus 环，不与 selectedCid 混用；ADR-0008 D15） */
  focusCid?: string | null
  /** 当前专注的计划项（L3）标题（方案 A：高亮标识正在专注的分支） */
  currentPlanTitle?: string | null
  /** 快速记录：追加「类型 + 文本」为会话节点子节点（页面实现写入；抛错 → 卡内提示） */
  onQuickRecord?: (type: ThoughtType, title: string) => Promise<void>
  /** 节点编辑：改名 / 加子 / 类型 / 注释 / 删除（页面实现写入；抛错 → 卡内提示） */
  onEdit?: (op: MapNodeEditOp) => Promise<void>
  /** 升格为任务（PXII-FEAT-TASK-SPACE-P0）：把节点标题/注释沉淀为正式 WorkItem，
   *  页面实现创建与导图回写；抛错 → 卡内提示。缺省 = 不提供升格入口（只读）。 */
  onPromoteNode?: (cid: string, node: MapTreeNode) => Promise<void>
  /**
   * 本次会话的计划项（PXII-FEAT-PLAN-CHECKOFF）：按 `titleSnapshot` 与子岛标题匹配，
   * 命中即可在**当前思考卡片上就地闭环**完成打勾，不必抬手切到右栏清单。
   * 缺省 = 不渲染任何打勾入口（只读编辑区）。
   */
  plans?: PlanItemLike[]
  /**
   * 完成态写回：**复用页面层既有的 `setCompletion(planItemId, completionDraft)`**
   * （`PXII-FEAT-PLAN-CHECKOFF` 红线 2：不发明第二套完成状态）。
   * 本组件只做「标题 → 计划项」的匹配与事件上抛，状态机与持久化都在页面。
   */
  onSetCompletionDraft?: (planItemId: string, completionDraft: boolean) => Promise<void> | void
}

/**
 * 计划项在导图侧需要的**最小投影**（结构化兼容页面 `aggregate.plan` 的元素）。
 * 刻意只取这四个字段：导图不参与计划项的增删改，只做「标题匹配 → 打勾」。
 */
export interface PlanItemLike {
  id: string
  workItemId: string
  titleSnapshot: string
  completionDraft: boolean
}

type Overlay = 'rename' | 'add' | 'comment' | 'type'

const DELETE_CONFIRM_MS = 3000

/**
 * 画布容器宽度的**兜底值**。jsdom 里 `clientWidth` 恒为 0（无布局引擎），
 * 而溢出判定必须可测 —— 兜底到 860 与「适应」按钮既有口径一致（同款兜底）。
 */
const DEFAULT_CANVAS_W = 860

/** 翻页步长 = 1 张卡片宽 + 1 个卡间距（PXII-FEAT-ARCHIPELAGO-OVERFLOW） */
const ARCHIPELAGO_PAGE_STEP = ARCHIPELAGO_CARD_W + ARCHIPELAGO_GAP_X

/**
 * 群岛流内容区的**最小宽度**与**两侧留白**（与 `layoutArchipelagoIsland` 同源：
 * 那边 `totalW = Math.max(780, totalCardsW + 32)`）。
 *
 * 编辑区沿用 860 而非 780 —— 视口最小宽度下的保底，避免 3 张卡（858px）时
 * 内容比视口还窄、SVG 被拉伸。
 */
const ARCHIPELAGO_MIN_CONTENT_W = 860
const ARCHIPELAGO_CONTENT_PAD_X = 32

/** 遮罩显隐的裁剪阈值：被裁不足 10px 时视为「已到边界」，避免边缘抖动闪烁 */
const OVERFLOW_EDGE_EPS = 10

/**
 * 群岛流导航动作（PXII-FEAT-ARCHIPELAGO-NAV）—— 纯数据，与 React 无关。
 *
 * `focus-index` 用 **0 基下标**（数字键 1 → 下标 0），越界判定留给匹配器。
 */
export type ArchipelagoNavAction =
  | { type: 'focus-index'; index: number }
  | { type: 'step'; delta: 1 | -1 }
  | { type: 'reset' }

/**
 * 群岛流导航键位匹配（PXII-FEAT-ARCHIPELAGO-NAV）。
 *
 * | 键 | 动作 |
 * |---|---|
 * | `[` / `Alt+←` | 上一个子岛（首岛循环到末岛） |
 * | `]` / `Alt+→` | 下一个子岛（末岛循环到首岛） |
 * | `1`~`9` | 直达第 N 个子岛（越界 → 不匹配） |
 * | `0` | 退出聚焦态（仅聚焦态下有接收者） |
 *
 * ## 与「数字键 1-5 直切类型」的**分层**（关键）
 * 导图键位表（`matchEditorKey`）里 1~5 = 思考类型直切，前提是**有选中节点**。
 * 本匹配器只在**无选中节点**时接管数字键 —— 有接收者时类型直切优先，
 * 无接收者时数字键才有"第 N 个子岛"这一层新语义。两层互斥，不会互相吃掉。
 *
 * ## 防穿透（红线）
 * 输入面（input / textarea / select / contentEditable）一律 `null`：打字中的
 * `[` `]` `1`~`9` 必须是字符。判据复用 `isTextEntryTarget`（事件目标是浏览器
 * 给出的事实，比 state 标志位可靠）。`Ctrl/Cmd` 组合同样让位；快速记录输入态
 * （`isQuickRecording`）同样整体让位 —— 用户正在写东西时不允许任何视图跳转。
 */
export function matchArchipelagoNavKey(
  e: KeyboardEvent,
  ctx: {
    islandCount: number
    hasSelectedNode: boolean
    isFocused: boolean
    /** 快速记录输入态（`activeType !== null || draft !== ''`）→ 一切切岛键让位 */
    isQuickRecording: boolean
  },
): ArchipelagoNavAction | null {
  if (ctx.islandCount <= 0) return null
  if (ctx.isQuickRecording) return null
  if (isTextEntryTarget(e.target)) return null
  // 判定次序同 `matchEditorKey`：修饰键优先于裸键，裸键要求无任何修饰。
  if (e.ctrlKey || e.metaKey) return null
  // 本矩阵不含任何 Shift 组合（`{` `}` 不属于切岛键位）
  if (e.shiftKey) return null
  // Alt 只在方向键上放行（Alt+←/→）；其余 Alt 组合让给系统
  if (e.altKey) {
    if (e.key === 'ArrowLeft') return { type: 'step', delta: -1 }
    if (e.key === 'ArrowRight') return { type: 'step', delta: 1 }
    return null
  }
  if (e.key === '[') return { type: 'step', delta: -1 }
  if (e.key === ']') return { type: 'step', delta: 1 }
  // `0`：只在聚焦态有接收者；全局态让键继续冒泡（不吞无副作用的按键）
  if (e.key === '0') return ctx.isFocused ? { type: 'reset' } : null
  // 数字键：仅无选中节点时接管（有选中 → 让给类型直切）
  if (!ctx.hasSelectedNode && e.key.length === 1 && e.key >= '1' && e.key <= '9') {
    const index = Number(e.key) - 1
    return index < ctx.islandCount ? { type: 'focus-index', index } : null
  }
  return null
}

export function TimerMapEditor({
  mapText,
  sessionId,
  focusCid,
  currentPlanTitle,
  onQuickRecord,
  onEdit,
  onPromoteNode,
  plans,
  onSetCompletionDraft,
}: TimerMapEditorProps): ReactNode {
  const island = useMemo(() => {
    if (mapText === null || sessionId === null) return null
    const layout = readWorkMapLayout(mapText)
    return layout === null ? null : findSessionIslandLayout(layout, sessionId)
  }, [mapText, sessionId])

  const [activeType, setActiveType] = useState<ThoughtType | null>(null)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [quickError, setQuickError] = useState<string | null>(null)

  // ── 节点编辑（D16）────────────────────────────────────────────────────
  const [selectedCid, setSelectedCid] = useState<string | null>(null)
  const [overlay, setOverlay] = useState<Overlay | null>(null)
  /**
   * 浮层的**写入目标** cid。通常 = 选中节点；唯一例外是「未选中时按 Tab」——
   * 此时目标是**岛根**（= 快速记录的父锚），所以不能直接用 `selectedNode.cid`。
   */
  const [overlayCid, setOverlayCid] = useState<string | null>(null)
  const [actionDraft, setActionDraft] = useState('')
  const [pendingDelete, setPendingDelete] = useState(false)
  const [editError, setEditError] = useState<string | null>(null)
  const deleteTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // ── 嵌套子岛与缩放平移（PXII-FEAT-NESTED-ISLAND & ZOOM-PAN）───────────────
  const [focusedSubIslandId, setFocusedSubIslandId] = useState<string | null>(null)

  const [zoom, setZoom] = useState(1.0)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [isPanning, setIsPanning] = useState(false)
  const panStartRef = useRef<{ startX: number; startY: number; initPanX: number; initPanY: number } | null>(null)

  const focusedSubIsland = useMemo(() => {
    if (!focusedSubIslandId || !island?.subIslands) return null
    return (
      island.subIslands.find(
        (sub) =>
          sub.id === focusedSubIslandId ||
          (sub.cid !== null && sub.cid === focusedSubIslandId) ||
          sub.title === focusedSubIslandId ||
          `sub:${sub.title}` === focusedSubIslandId ||
          (focusedSubIslandId.startsWith('sub:') && sub.title === focusedSubIslandId.slice(4)),
      ) ?? null
    )
  }, [focusedSubIslandId, island])

  // 跨重新解析状态对齐：当 mapText 编辑更新后，始终锚定在当前同一子岛
  useEffect(() => {
    if (focusedSubIsland && focusedSubIslandId !== focusedSubIsland.id) {
      setFocusedSubIslandId(focusedSubIsland.id)
    }
  }, [focusedSubIsland, focusedSubIslandId])

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    const target = e.target as HTMLElement | SVGElement
    if (
      target.closest('button') ||
      target.closest('input') ||
      target.closest('textarea') ||
      target.closest('[role="button"]') ||
      target.closest('.wm-canvas-toolbar') ||
      target.closest('.wm-sub-island-banner') ||
      target.closest('.wm-action-pop') ||
      target.closest('.ios-map-quick-pop')
    ) {
      return
    }
    panStartRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      initPanX: pan.x,
      initPanY: pan.y,
    }
    setIsPanning(true)
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      // ignore
    }
  }

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!panStartRef.current) return
    const dx = e.clientX - panStartRef.current.startX
    const dy = e.clientY - panStartRef.current.startY
    setPan({
      x: Math.round(panStartRef.current.initPanX + dx),
      y: Math.round(panStartRef.current.initPanY + dy),
    })
  }

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (panStartRef.current) {
      panStartRef.current = null
      setIsPanning(false)
      try {
        e.currentTarget.releasePointerCapture(e.pointerId)
      } catch {
        // ignore
      }
    }
  }

  const handleWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    if (e.ctrlKey || e.metaKey || e.altKey) {
      e.preventDefault()
      const delta = e.deltaY > 0 ? -0.15 : 0.15
      setZoom((z) => Math.min(2.5, Math.max(0.6, Math.round((z + delta) * 10) / 10)))
    } else {
      const moveX = e.deltaX !== 0 ? e.deltaX : (e.shiftKey ? e.deltaY : e.deltaY * 0.8)
      setPan((p) => ({
        x: Math.round(p.x - moveX),
        y: e.shiftKey || e.deltaX !== 0 ? p.y : Math.round(p.y - e.deltaY * 0.2),
      }))
    }
  }

  // ── 键盘心流（PXII-FEAT-KEYMAP-FLOW）──────────────────────────────────
  /** 画布（SVG 所在块）：既是键位作用域判定的基准，也是浮层收起后的**焦点归还点** */
  const canvasRef = useRef<HTMLDivElement | null>(null)
  const actionInputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null)

  // 选中节点按 cid 从当前几何里**重新求**：写回重建树后 cid 不变，选中态自然跟随；
  // 被删掉的节点自然求不到 → 操作行自动收起。
  const selectedNode: MapTreeNode | null = useMemo(() => {
    if (island === null || selectedCid === null) return null
    return (
      island.nodes.find(
        (node) => node.cid !== null && node.cid === selectedCid && !node.sessionNode,
      ) ?? null
    )
  }, [island, selectedCid])

  /** cid → 节点（浮层目标**可能不是**选中节点：加同级时是父节点，未选中 Tab 时是岛根） */
  const nodeByCid = useMemo(() => {
    const map = new Map<string, MapTreeNode>()
    if (island !== null) {
      for (const node of island.nodes) {
        if (node.cid !== null) map.set(node.cid, node)
      }
    }
    return map
  }, [island])

  /** 把焦点交给画布：键盘流的落点（点选节点后 / 浮层收起后） */
  const focusCanvas = useCallback((): void => {
    canvasRef.current?.focus({ preventScroll: true })
  }, [])

  // ── 群岛流导航（PXII-FEAT-ARCHIPELAGO-NAV / OVERFLOW）────────────────────
  const subIslands = island?.subIslands ?? []

  // ── 子岛完成态（PXII-FEAT-PLAN-CHECKOFF）────────────────────────────────
  /**
   * 计划项完成态投影：键 = `titleSnapshot`，值 = `completionDraft`。
   *
   * 标题匹配是外派单 §1.1 的既定口径（`plans.find(p => p.titleSnapshot === subIsland.title)`），
   * 这里把它预计算成 Map，避免每个子岛每帧一次 O(n) 扫描。只读投影 —— 完成态的
   * **写**走 `onSetCompletionDraft`（页面既有的 `setCompletion` 状态机），本组件不持有。
   */
  const planCompletion = useMemo(() => {
    if (plans === undefined || plans.length === 0) return undefined
    const map = new Map<string, boolean>()
    for (const plan of plans) map.set(plan.titleSnapshot, plan.completionDraft)
    return map
  }, [plans])

  /** 计划项完成态查询（含 `.trim()` 归一；未命中 → `undefined`） */
  const planForSubIsland = useCallback(
    (title: string): PlanItemLike | null => {
      if (plans === undefined) return null
      const direct = plans.find((plan) => plan.titleSnapshot === title)
      if (direct !== undefined) return direct
      const trimmed = title.trim()
      return plans.find((plan) => plan.titleSnapshot.trim() === trimmed) ?? null
    },
    [plans],
  )

  /**
   * 一键切换完成（打勾按钮 / `Alt+D` / `Ctrl+Enter` 三处入口共用的唯一落点）。
   *
   * 完成态写回**完全复用页面既有的 `setCompletion(planItemId, completionDraft)`**
   * （红线 2：不发明第二套完成状态）；本组件只负责「子岛标题 → 计划项 id」的匹配。
   * 匹配不到计划项 → 静默 no-op（子岛可能来自历史会话 / 未加入本次计划）。
   */
  const toggleSubIslandCompletion = useCallback(
    (title: string): void => {
      if (onSetCompletionDraft === undefined) return
      const plan = planForSubIsland(title)
      if (plan === null) return
      void onSetCompletionDraft(plan.id, !plan.completionDraft)
    },
    [onSetCompletionDraft, planForSubIsland],
  )

  /** 当前聚焦子岛对应的计划项（横幅胶囊用）；未聚焦 / 未命中 → null */
  const focusedPlan = useMemo(() => {
    if (focusedSubIslandId === null || focusedSubIsland === null) return null
    return planForSubIsland(focusedSubIsland.title)
  }, [focusedSubIslandId, focusedSubIsland, planForSubIsland])

  /**
   * 画布可视宽度。jsdom 无布局引擎（`clientWidth` 恒 0）→ 兜底 `DEFAULT_CANVAS_W`，
   * 让溢出判定在测试里也是确定的；真实浏览器里由 ResizeObserver 实时校正。
   */
  const [canvasWidth, setCanvasWidth] = useState(DEFAULT_CANVAS_W)
  useEffect(() => {
    const el = canvasRef.current
    if (el === null) return
    const measure = (): void => {
      setCanvasWidth(el.clientWidth > 0 ? el.clientWidth : DEFAULT_CANVAS_W)
    }
    measure()
    window.addEventListener('resize', measure)
    // ResizeObserver 在 jsdom 下不存在 → 有则用（容器随窗口/布局变化时实时校正）
    const observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    observer?.observe(el)
    return () => {
      window.removeEventListener('resize', measure)
      observer?.disconnect()
    }
  }, [island])

  /** 全部子岛卡片横向平铺的总宽（与 `layoutArchipelagoIsland` 同一份几何常量） */
  const archipelagoCardsW =
    subIslands.length === 0
      ? 0
      : subIslands.length * ARCHIPELAGO_CARD_W + (subIslands.length - 1) * ARCHIPELAGO_GAP_X

  /**
   * **内容宽度 = 渲染宽度**（同源红线）：下面给 `WorkMapTree` 的 `style.width`
   * 与此处用同一个表达式，否则遮罩会在"其实没溢出"时误亮、或在溢出时不亮。
   *
   * - 子岛 ≤ 2 个：不撑宽（`style` 为 undefined）→ SVG 按 100% 等比缩进视口 → 无溢出；
   * - 子岛 > 2 个：显式撑到 `max(860, 卡片总宽 + 32)` → 超出视口的部分即横向溢出。
   */
  const archipelagoContentW =
    subIslands.length > 2
      ? Math.max(
          ARCHIPELAGO_MIN_CONTENT_W,
          archipelagoCardsW + ARCHIPELAGO_CONTENT_PAD_X,
        )
      : 0

  /** 溢出指示只在**全局群岛视图**且内容确实超出视口时激活；单子岛聚焦态一律收起 */
  const overflowActive = focusedSubIslandId === null && archipelagoContentW > 0
  // 内容自视口左缘起排布（transformOrigin: center center + 初始 pan 0 = 左对齐呈现）：
  // 左溢 = 已把内容右移（pan.x < 0）；右溢 = 内容右缘仍在视口右缘之外。
  // 容差 10px 吸收亚像素抖动，避免边界处遮罩反复闪烁。
  const canScrollLeft = overflowActive && pan.x < -OVERFLOW_EDGE_EPS
  const canScrollRight =
    overflowActive && canvasWidth - pan.x < archipelagoContentW - OVERFLOW_EDGE_EPS

  /**
   * 切换子岛 / 退出聚焦时的**状态收敛**：节点选中及其衍生 UI 一并收起。
   *
   * 必要性（不是洁癖）：聚焦态下渲染器只画当前子岛，选中节点若在别的岛上就**不可见**，
   * 而操作行仍会呈现 —— 用户可能对着看不见的节点按删除。视图切走 = 选中态失效。
   */
  const clearNodeSelection = (): void => {
    clearDeleteTimer()
    setPendingDelete(false)
    setSelectedCid(null)
    setOverlay(null)
    setOverlayCid(null)
    setEditError(null)
  }

  /**
   * 一键聚焦第 index 个子岛（0 基）：清选中 → 复位缩放平移 → 聚焦。
   *
   * 「自动平移居中」由渲染器负责：聚焦态下 `WorkMapTree` 按
   * `subIslandVisualBounds(sub, true)` 自适应框定该岛（同既有 Tab 按钮的落点），
   * 故这里只需把视口复位到基准，不必自己算平移量。
   *
   * 不抢焦点：切岛可能发生在快速记录浮层开着的时候（输入框持有焦点），
   * 强行 `focusCanvas` 会打断打字。键盘路径下事件目标本就在画布内，无需归还。
   */
  const focusSubIslandAt = (index: number): void => {
    const sub = subIslands[index]
    if (sub === undefined) return
    clearNodeSelection()
    setFocusedSubIslandId(sub.id)
    setZoom(1.0)
    setPan({ x: 0, y: 0 })
  }

  /** 退出子岛聚焦 → 回到会话全局群岛视图（`0` / Esc / 横幅与 Tab 按钮共用同一落点） */
  const exitSubIslandFocus = (): void => {
    clearNodeSelection()
    setFocusedSubIslandId(null)
    setZoom(1.0)
    setPan({ x: 0, y: 0 })
  }

  /**
   * 翻页一个步长（294px = 1 卡宽 + 1 卡间距）。
   * `delta = 1` 看右边（内容左移）／`delta = -1` 看左边（内容右移）。
   * 结果夹在 `[-maxScrollRight, 0]`：滚到边界即停，不会翻出空白区。
   */
  const scrollArchipelago = (delta: 1 | -1): void => {
    const maxScrollRight = Math.max(0, archipelagoContentW - canvasWidth)
    setPan((p) => {
      const next = p.x - delta * ARCHIPELAGO_PAGE_STEP
      return { x: Math.round(Math.max(-maxScrollRight, Math.min(0, next))), y: p.y }
    })
  }

  /** 群岛导航动作落地（键盘与按钮共用的唯一入口） */
  const applyArchipelagoNav = (action: ArchipelagoNavAction): void => {
    if (action.type === 'reset') {
      exitSubIslandFocus()
      return
    }
    if (action.type === 'focus-index') {
      focusSubIslandAt(action.index)
      return
    }
    // 环形步进：未聚焦时 `]` → 首岛、`[` → 末岛；已聚焦则前后环绕
    const count = subIslands.length
    if (count === 0) return
    const current = subIslands.findIndex(
      (sub) =>
        sub.id === focusedSubIslandId ||
        (sub.cid !== null && sub.cid === focusedSubIslandId) ||
        sub.title === focusedSubIslandId ||
        `sub:${sub.title}` === focusedSubIslandId ||
        (focusedSubIslandId !== null &&
          focusedSubIslandId.startsWith('sub:') &&
          sub.title === focusedSubIslandId.slice(4)),
    )
    const base = current === -1 ? (action.delta === 1 ? -1 : 0) : current
    focusSubIslandAt(((base + action.delta) % count + count) % count)
  }

  // 改名浮层：打开即**全选**现有名称 —— 一键打字覆盖，也可按方向键微调（手感同 F2）
  useEffect(() => {
    if (overlay !== 'rename') return
    const input = actionInputRef.current
    if (input instanceof HTMLInputElement) input.select()
  }, [overlay])

  // 注释浮层：打开即聚焦并把光标置于**末尾**（接着写，而不是覆盖已有注释）——
  // 与 MindCanvas `DescBlock` 进入编辑态的手感一致（那边是 setSelectionRange(len, len)）。
  useEffect(() => {
    if (overlay !== 'comment') return
    const input = actionInputRef.current
    if (input instanceof HTMLTextAreaElement) {
      input.focus()
      input.setSelectionRange(input.value.length, input.value.length)
    }
  }, [overlay])

  useEffect(
    () => () => {
      if (deleteTimer.current !== null) clearTimeout(deleteTimer.current)
    },
    [],
  )

  const clearDeleteTimer = (): void => {
    if (deleteTimer.current !== null) {
      clearTimeout(deleteTimer.current)
      deleteTimer.current = null
    }
  }

  /**
   * 收尾：清掉删除确认 / 浮层 / 错误，并把焦点**归还画布**（提交或取消后立刻能接着
   * 按 Tab、F2 —— 心流不断）。焦点归还是**显式动作**（在事件处理器里）而不是 effect
   * 副作用：一是时序确定（不必等一次渲染），二是失败路径（`editError`）不调本函数，
   * 浮层保留时焦点自然留在输入框里方便重试。
   */
  const resetActions = (): void => {
    clearDeleteTimer()
    setPendingDelete(false)
    setOverlay(null)
    setOverlayCid(null)
    setEditError(null)
    focusCanvas()
  }

  const selectNode = (cid: string): void => {
    setSelectedCid(cid)
    resetActions()
  }

  const runEdit = async (op: MapNodeEditOp): Promise<void> => {
    if (onEdit === undefined || busy) return
    setBusy(true)
    setEditError(null)
    try {
      await onEdit(op)
      resetActions()
    } catch (cause) {
      setEditError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  /**
   * 升格为任务（PXII-FEAT-TASK-SPACE-P0）：键盘 ⇧P 与操作行按钮共用的唯一入口。
   * 与 `runEdit` 同一条纪律（busy 闸门 / 卡内错误 / 成功后焦点归还画布）——
   * 失败时浮层语义不适用（本动作无浮层），错误落 `map-edit-error` 即可重试。
   */
  const runPromote = async (): Promise<void> => {
    const node = selectedNode
    if (node === null || node.cid === null || onPromoteNode === undefined || busy) return
    const cid = node.cid
    setBusy(true)
    setEditError(null)
    try {
      await onPromoteNode(cid, node)
      resetActions()
    } catch (cause) {
      setEditError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const closeOverlay = (): void => {
    setOverlay(null)
    setOverlayCid(null)
    // 焦点归还画布：收起浮层后立刻能接着按 Tab / F2（与 resetActions 同一条收尾纪律）
    focusCanvas()
  }

  /**
   * 打开浮层（写入目标显式传入 —— 加同级作用于**父节点**、未选中 Tab 作用于**岛根**，
   * 都不是"当前选中节点"）。
   */
  const openOverlayFor = (targetCid: string, next: Overlay): void => {
    const target = nodeByCid.get(targetCid)
    if (target === undefined) return
    clearDeleteTimer()
    setPendingDelete(false)
    setEditError(null)
    setOverlayCid(targetCid)
    setOverlay(next)
    setActionDraft(
      next === 'rename'
        ? target.text
        : next === 'comment'
          ? (target.comment ?? []).join('\n')
          : '',
    )
  }

  /** 操作行按钮入口（目标 = 当前选中节点） */
  const openSelectedOverlay = (next: Overlay): void => {
    const cid = selectedNode?.cid ?? null
    if (cid === null) return
    openOverlayFor(cid, next)
  }

  const submitText = (): void => {
    const cid = overlayCid
    if (cid === null) return
    if (overlay === 'rename' || overlay === 'add') {
      const title = actionDraft.trim()
      if (title === '') return
      void runEdit(
        overlay === 'rename' ? { kind: 'rename', cid, title } : { kind: 'add', cid, title },
      )
      return
    }
    if (overlay !== 'comment') return
    const lines = actionDraft
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '')
    void runEdit({ kind: 'comment', cid, comment: lines.length === 0 ? null : lines })
  }

  const submitType = (type: ThoughtType | null): void => {
    const cid = overlayCid ?? selectedNode?.cid ?? null
    if (cid === null) return
    void runEdit({ kind: 'type', cid, type })
  }

  const requestDelete = (): void => {
    const cid = selectedNode?.cid ?? null
    if (cid === null) return
    if (!pendingDelete) {
      setPendingDelete(true)
      clearDeleteTimer()
      deleteTimer.current = setTimeout(() => {
        setPendingDelete(false)
        deleteTimer.current = null
      }, DELETE_CONFIRM_MS)
      return
    }
    void runEdit({ kind: 'delete', cid })
  }

  /**
   * 导图键盘流分发（PXII-FEAT-KEYMAP-FLOW）。
   *
   * 监听挂在外层容器（冒泡），但**只在画布持有焦点时**响应：焦点在操作行/浮层控件上
   * 时按键归那些控件（Enter 激活按钮、Esc 关弹层），不抢。防穿透的最终判据在
   * `matchEditorKey`（输入框一律不匹配）—— 两层叠起来，打字绝不会误触导图动作。
   *
   * ★ 命中后必须 `stopPropagation`：`AppShell` 的全局快捷键钩子把数字键 1-5 绑成
   * **路由跳转**（`SHORTCUT_ROUTES`），不拦住的话"按 2 切问题类型"会顺手跳到
   * `/tasks`。Escape 同理（全局会把所有面板关掉）。两者都在 window 上监听，
   * 只有阻断冒泡才能让导图内的一次按键只做一件事。
   */
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    // 浮层打开 = 键盘归浮层：仅 Esc 由导图处理（收起浮层），其余交给浮层内控件。
    // 这道闸门与 `matchEditorKey` 的输入面判定**互为冗余**：即便焦点被点回画布，
    // 浮层开着时按 1 也不会静默改类型（用户以为自己还在"加子"流程里）。
    if (overlay !== null) {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        closeOverlay()
      }
      return
    }

    const target = event.target as Node | null
    if (canvasRef.current === null || target === null) return
    if (!canvasRef.current.contains(target)) return

    // ── 一键完成（PXII-FEAT-PLAN-CHECKOFF）───────────────────────────────
    // `Alt+D` / `Ctrl+Enter`：**只在单子岛聚焦态且该子岛命中计划项时**认领。
    // 放在「节点 <g> 的 Enter/Space 归渲染器」闸门**之前** —— 否则 Ctrl+Enter 会被
    // 那道闸门当成裸 Enter 吞掉（焦点恰在节点上时快捷键静默失效）。
    // 防穿透沿用同一判据：打字态（输入面）一律让位，`Ctrl+Enter` 在文本域里
    // 常是"提交"、`Alt+D` 在部分 IME 下是输入辅助，抢走会打断用户。
    if (
      !isTextEntryTarget(event.nativeEvent.target) &&
      focusedSubIsland !== null &&
      focusedPlan !== null
    ) {
      const isAltD = event.altKey && !event.ctrlKey && !event.metaKey && (event.key === 'd' || event.key === 'D')
      const isCtrlEnter = (event.ctrlKey || event.metaKey) && !event.altKey && event.key === 'Enter'
      if (isAltD || isCtrlEnter) {
        event.preventDefault()
        event.stopPropagation()
        toggleSubIslandCompletion(focusedSubIsland.title)
        return
      }
    }

    // 焦点停在**节点 `<g>` 上**时（用户 Tab 键浏览到某个节点），Enter/Space 归
    // 渲染器自己的激活处理（选中该节点），否则会同一次按键既选中又开「加同级」。
    // 选中后 `selectNode` 会把焦点收回画布，之后的 Enter 才走导图键位。
    if (
      (event.key === 'Enter' || event.key === ' ') &&
      target instanceof Element &&
      target.closest('[data-cid]') !== null
    ) {
      return
    }

    const action = matchEditorKey(event.nativeEvent, selectedNode !== null)
    if (action === null) {
      // 导图键位未命中 → 再看群岛流导航键位（`[` `]` / Alt+←→ / 1~9 / 0）。
      // 两层互斥：`matchEditorKey` 在有选中节点时已接管 1~5（类型直切），
      // 群岛匹配器也只在**无选中**时认数字键，所以不会有按键被两层同时认领。
      const nav = matchArchipelagoNavKey(event.nativeEvent, {
        islandCount: subIslands.length,
        hasSelectedNode: selectedNode !== null,
        isFocused: focusedSubIslandId !== null,
        isQuickRecording: activeType !== null || draft !== '',
      })
      if (nav === null) return
      // 命中即拦截：全局数字键 1-5 是**路由跳转**（AppShell），不拦会顺手跳页
      event.preventDefault()
      event.stopPropagation()
      applyArchipelagoNav(nav)
      return
    }

    const currentCid = selectedNode?.cid ?? null

    // Esc 且**无可退让的对象**：只把焦点交还页面（让全局快捷键继续处理这次 Esc），
    // 不做 preventDefault —— 否则用户按 Esc 关不掉页面上其它浮层（键盘陷阱）。
    // ★ 聚焦子岛时**有**可退让对象（退出聚焦，PXII-FEAT-ARCHIPELAGO-NAV），
    //   故不在此早退，落到下面 switch 的 cancel 分支逐级退让。
    if (
      action.type === 'cancel' &&
      overlay === null &&
      currentCid === null &&
      focusedSubIslandId === null
    ) {
      canvasRef.current.blur()
      return
    }

    event.preventDefault()
    event.stopPropagation()

    switch (action.type) {
      case 'add-child': {
        // 已选中 → 该节点加子；未选中 → **岛根**加子（进岛最快的一条路）
        const cid = currentCid ?? island?.tree.cid ?? null
        if (cid !== null) openOverlayFor(cid, 'add')
        return
      }
      case 'add-sibling': {
        // 同级生长 = 对**父节点**加子；父节点（会话节点等）只需有 cid 可作锚点
        if (island === null || currentCid === null) return
        const parent = findParentNode(island.tree, currentCid)
        if (parent !== null && parent.cid !== null) openOverlayFor(parent.cid, 'add')
        return
      }
      case 'rename':
        openSelectedOverlay('rename')
        return
      case 'comment':
        openSelectedOverlay('comment')
        return
      case 'promote':
        void runPromote()
        return
      case 'delete':
        requestDelete()
        return
      case 'set-type':
        if (currentCid !== null) {
          void runEdit({ kind: 'type', cid: currentCid, type: action.thoughtType })
        }
        return
      case 'navigate': {
        if (island === null || currentCid === null) return
        const next = findNextNavNode(island.tree, currentCid, action.dir)
        if (next !== null) selectNode(next)
        return
      }
      case 'cancel':
        // 逐级退让：浮层 → 子岛聚焦 → 选中
        if (overlay !== null) closeOverlay()
        else if (focusedSubIslandId !== null) exitSubIslandFocus()
        else {
          setSelectedCid(null)
          resetActions()
        }
        return
    }
  }

  const submitQuick = async (): Promise<void> => {
    if (activeType === null || busy) return
    const title = draft.trim()
    if (title === '') return

    // 优先：若处于子岛聚焦态且该子岛具备持久编辑键 cid，且编辑能力已开放 → 直接挂在该子岛下
    if (focusedSubIsland !== null && focusedSubIsland.cid !== null && onEdit !== undefined) {
      setBusy(true)
      setQuickError(null)
      try {
        await onEdit({ kind: 'add', cid: focusedSubIsland.cid, title, thoughtType: activeType })
        setDraft('')
        setActiveType(null)
      } catch (cause) {
        setQuickError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        setBusy(false)
      }
      return
    }

    if (onQuickRecord === undefined) return
    setBusy(true)
    setQuickError(null)
    try {
      await onQuickRecord(activeType, title)
      setDraft('')
      setActiveType(null)
    } catch (cause) {
      setQuickError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const editable = onEdit !== undefined

  return (
    <div
      className="wm-editor flex min-h-0 flex-1 flex-col"
      data-testid="timer-map-editor"
      onKeyDown={editable ? handleKeyDown : undefined}
    >
      <div className="wm-editor-hd">
        <span>工作导图 · 本次会话</span>
        {island !== null ? (
          <span className="wm-editor-count">{island.nodes.length} 项</span>
        ) : null}
        {/* 子岛视图切换（会话全局岛视图 vs L3子任务岛视图） */}
        {island !== null && island.subIslands && island.subIslands.length > 0 ? (
          <div
            className="wm-sub-island-toggle"
            role="group"
            aria-label="导图视图切换"
            data-testid="map-sub-island-toggle"
          >
            <button
              type="button"
              className={`wm-view-btn ${focusedSubIsland === null ? 'wm-view-btn--active' : ''}`}
              aria-pressed={focusedSubIsland === null}
              data-testid="map-view-global"
              onClick={exitSubIslandFocus}
            >
              🌐 会话全局
            </button>
            {island.subIslands.map((sub, idx) => {
              const isCurrent =
                currentPlanTitle != null &&
                currentPlanTitle.trim() !== '' &&
                sub.title === currentPlanTitle.trim()
              const isFocused = focusedSubIsland !== null && focusedSubIsland.id === sub.id
              return (
                <button
                  key={sub.id}
                  type="button"
                  className={`wm-view-btn ${isFocused ? 'wm-view-btn--active' : ''}`}
                  aria-pressed={isFocused}
                  data-testid={`map-view-sub-${sub.id}`}
                  onClick={() => {
                    // 再点已聚焦的 Tab = 退出（与横幅按钮同一落点）
                    if (isFocused) exitSubIslandFocus()
                    else focusSubIslandAt(idx)
                  }}
                  title={`聚焦子岛：${sub.title}（快捷键 ${idx + 1}）`}
                  aria-label={`聚焦子岛：${sub.title}`}
                  aria-keyshortcuts={idx < 9 ? String(idx + 1) : undefined}
                >
                  {isCurrent ? '⚡ ' : '🏝️ '}
                  {`${idx + 1}. `}
                  {sub.title.length > 7 ? `${sub.title.slice(0, 7)}…` : sub.title}
                  {isCurrent ? ' (专注中)' : ''}
                </button>
              )
            })}
          </div>
        ) : null}
        {editable && island !== null ? (
          <span className="wm-editor-keys" data-testid="map-key-hints">
            {EDITOR_KEY_HINTS.map((hint) => (
              <span key={hint.keys} className="wm-key-hint">
                <kbd>{hint.keys}</kbd>
                {hint.label}
              </span>
            ))}
          </span>
        ) : null}
      </div>

      {island !== null ? (
        <div
          ref={canvasRef}
          className="wm-editor-canvas"
          data-testid="map-editor-canvas"
          tabIndex={editable ? 0 : undefined}
          role={editable ? 'application' : undefined}
          aria-label={editable ? '本次会话导图（Tab 加子 / Enter 同级 / F2 改名 / 1-5 类型 / 方向键导航）' : undefined}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          onWheel={handleWheel}
        >
          {focusedSubIsland !== null ? (
            <div className="wm-sub-island-banner" data-testid="map-sub-island-banner">
              <span>
                正在聚焦 L3 子岛：<strong>{focusedSubIsland.title}</strong>
              </span>
              {/* 完成胶囊（PXII-FEAT-PLAN-CHECKOFF）：只在该子岛命中计划项时出现 ——
                  未加入本次计划的子岛没有完成态可切换，不画"点了没反应"的假入口。 */}
              {focusedPlan !== null ? (
                <button
                  type="button"
                  className={`wm-sub-island-check-pill ${
                    focusedPlan.completionDraft ? 'wm-sub-island-check-pill--done' : ''
                  }`}
                  data-testid="map-sub-island-complete"
                  data-completed={focusedPlan.completionDraft ? 'true' : 'false'}
                  aria-pressed={focusedPlan.completionDraft}
                  aria-keyshortcuts="Alt+D Control+Enter"
                  title={focusedPlan.completionDraft ? '标记未完成（Alt+D）' : '标记已完成（Alt+D）'}
                  onClick={() => toggleSubIslandCompletion(focusedSubIsland.title)}
                >
                  {focusedPlan.completionDraft ? '✓ 已完成' : '○ 标记完成'}
                </button>
              ) : null}
              <button
                type="button"
                className="wm-sub-island-exit-btn"
                data-testid="map-sub-island-exit"
                onClick={exitSubIslandFocus}
              >
                退出子岛聚焦
              </button>
            </div>
          ) : null}

          {/* 缩放与平移视口 */}
          <div
            className="wm-canvas-viewport"
            data-testid="map-canvas-viewport"
            style={{
              transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
              transformOrigin: 'center center',
              transition: isPanning ? 'none' : 'transform 0.15s cubic-bezier(0.2, 0, 0, 1)',
              cursor: isPanning ? 'grabbing' : zoom > 1 ? 'grab' : 'default',
            }}
          >
            <WorkMapTree
              islands={[island]}
              sessionId={sessionId}
              label="本次会话导图（编辑区）"
              selectedCid={selectedCid}
              focusCid={focusCid}
              currentPlanTitle={currentPlanTitle}
              focusedSubIslandId={focusedSubIslandId}
              style={
                focusedSubIslandId === null && island.subIslands && island.subIslands.length > 2
                  ? {
                      width: `${archipelagoContentW}px`,
                      height: '100%',
                      minWidth: '100%',
                    }
                  : undefined
              }
              onSubIslandFocusRequest={(subId) => {
                setFocusedSubIslandId(subId || null)
                setZoom(1.0)
                setPan({ x: 0, y: 0 })
              }}
              planCompletion={planCompletion}
              onTogglePlanCompletion={
                onSetCompletionDraft === undefined ? undefined : toggleSubIslandCompletion
              }
              onSelectNode={editable ? selectNode : undefined}
            />
          </div>

          {/* 左右溢出渐变遮罩 + 悬浮翻页微按钮（PXII-FEAT-ARCHIPELAGO-OVERFLOW）
              只在全局群岛视图且卡片总宽超出视口时出现；进入单子岛聚焦态自动隐藏。 */}
          {overflowActive && (canScrollLeft || canScrollRight) ? (
            <>
              <div
                className={`wm-archipelago-fade-mask wm-archipelago-fade-mask--left ${
                  canScrollLeft ? 'is-visible' : ''
                }`}
                data-testid="map-fade-left"
                data-visible={canScrollLeft}
                aria-hidden="true"
              />
              <div
                className={`wm-archipelago-fade-mask wm-archipelago-fade-mask--right ${
                  canScrollRight ? 'is-visible' : ''
                }`}
                data-testid="map-fade-right"
                data-visible={canScrollRight}
                aria-hidden="true"
              />
              <button
                type="button"
                className="wm-archipelago-nav-btn wm-archipelago-nav-btn--left"
                data-testid="map-scroll-left"
                aria-label="向左翻页（上一张卡片）"
                title="向左翻页"
                disabled={!canScrollLeft}
                aria-disabled={!canScrollLeft}
                onClick={() => scrollArchipelago(-1)}
              >
                ‹
              </button>
              <button
                type="button"
                className="wm-archipelago-nav-btn wm-archipelago-nav-btn--right"
                data-testid="map-scroll-right"
                aria-label="向右翻页（下一张卡片）"
                title="向右翻页"
                disabled={!canScrollRight}
                aria-disabled={!canScrollRight}
                onClick={() => scrollArchipelago(1)}
              >
                ›
              </button>
            </>
          ) : null}

          {/* 浮动缩放控制条 */}
          <div
            className="wm-canvas-toolbar"
            data-testid="map-canvas-toolbar"
            role="toolbar"
            aria-label="画布缩放控制"
          >
            <button
              type="button"
              className="wm-canvas-tool-btn"
              data-testid="map-zoom-out"
              aria-label="缩小"
              title="缩小"
              disabled={zoom <= 0.6}
              onClick={() => setZoom((z) => Math.max(0.6, Math.round((z - 0.2) * 10) / 10))}
            >
              −
            </button>
            <button
              type="button"
              className="wm-canvas-tool-btn wm-canvas-tool-btn--label"
              data-testid="map-zoom-reset"
              aria-label="重置缩放"
              title="点击重置为 100%"
              onClick={() => {
                setZoom(1.0)
                setPan({ x: 0, y: 0 })
              }}
            >
              {Math.round(zoom * 100)}%
            </button>
            <button
              type="button"
              className="wm-canvas-tool-btn"
              data-testid="map-zoom-in"
              aria-label="放大"
              title="放大"
              disabled={zoom >= 2.5}
              onClick={() => setZoom((z) => Math.min(2.5, Math.round((z + 0.2) * 10) / 10))}
            >
              +
            </button>
            <button
              type="button"
              className="wm-canvas-tool-btn"
              data-testid="map-zoom-fit"
              aria-label="自适应居中"
              title="重置缩放并适应视图"
              onClick={() => {
                if (
                  focusedSubIslandId === null &&
                  island.subIslands &&
                  island.subIslands.length > 3
                ) {
                  const totalW =
                    island.subIslands.length * 270 +
                    (island.subIslands.length - 1) * 24 +
                    32
                  const containerW = canvasRef.current?.clientWidth ?? 860
                  const fitZoom = Math.max(
                    0.4,
                    Math.min(1.0, Math.round((containerW / totalW) * 10) / 10),
                  )
                  setZoom(fitZoom)
                  setPan({ x: 0, y: 0 })
                } else {
                  setZoom(1.0)
                  setPan({ x: 0, y: 0 })
                  setFocusedSubIslandId(null)
                }
              }}
            >
              适应
            </button>
          </div>
        </div>
      ) : (
        <div className="wm-editor-canvas wm-editor-canvas--empty" data-testid="map-editor-empty">
          本次会话还没有导图记录。
        </div>
      )}

      {/* 操作行（选中后出现；在快速记录行上方） */}
      {editable && selectedNode !== null ? (
        <>
          <div className="wm-actions" data-testid="map-node-actions">
            <button
              type="button"
              className="wm-action-btn"
              data-testid="map-action-rename"
              disabled={busy}
              onClick={() => openSelectedOverlay('rename')}
            >
              改名
            </button>
            <button
              type="button"
              className="wm-action-btn"
              data-testid="map-action-add"
              disabled={busy}
              onClick={() => openSelectedOverlay('add')}
            >
              加子
            </button>
            <button
              type="button"
              className="wm-action-btn"
              data-testid="map-action-type"
              disabled={busy}
              onClick={() => openSelectedOverlay('type')}
            >
              类型
            </button>
            <button
              type="button"
              className="wm-action-btn"
              data-testid="map-action-comment"
              disabled={busy}
              onClick={() => openSelectedOverlay('comment')}
            >
              注释
            </button>
            {onPromoteNode !== undefined ? (
              <button
                type="button"
                className="wm-action-btn"
                data-testid="map-action-promote"
                title="把节点标题与注释沉淀为正式任务"
                disabled={busy}
                onClick={() => void runPromote()}
              >
                升格为任务
              </button>
            ) : null}
            <button
              type="button"
              className="wm-action-btn wm-action-btn--danger"
              data-testid="map-action-delete"
              aria-live="polite"
              disabled={busy}
              onClick={requestDelete}
            >
              {pendingDelete ? '确认删除？' : '删除'}
            </button>
          </div>
          {selectedNode.comment !== null ? (
            <ul className="wm-node-comment" data-testid="map-node-comment">
              {selectedNode.comment.map((item, index) => (
                <li key={`${index}-${item}`}>{item}</li>
              ))}
            </ul>
          ) : null}
        </>
      ) : null}

      {/* 浮层：文本类复用输入；类型 = 5 chip + 清除（绝对定位，不撑开几何）
          ★ 判据是 `overlayCid`（浮层**写入目标**）而非 `selectedNode`：未选中时按
          Tab 给岛根加子，此刻没有选中节点但浮层必须呈现（目标 = 岛根）。 */}
      {editable && overlayCid !== null && overlay !== null ? (
        overlay === 'type' ? (
          <div className="wm-action-pop" data-testid="map-action-pop">
            {THOUGHT_TYPES.map((type) => (
              <button
                key={type}
                type="button"
                className="wm-action-chip"
                data-thought={type}
                data-testid={`map-action-type-${type}`}
                disabled={busy}
                onClick={() => submitType(type)}
              >
                {THOUGHT_TYPE_LABEL[type]}
              </button>
            ))}
            <button
              type="button"
              className="wm-action-chip"
              data-testid="map-action-type-clear"
              disabled={busy}
              onClick={() => submitType(null)}
            >
              清除类型
            </button>
            <button
              type="button"
              className="wm-action-btn"
              data-testid="map-action-cancel"
              onClick={closeOverlay}
            >
              取消
            </button>
          </div>
        ) : (
          <form
            className="wm-action-pop"
            data-testid="map-action-pop"
            onSubmit={(event) => {
              event.preventDefault()
              submitText()
            }}
          >
            {overlay === 'comment' ? (
              <textarea
                ref={(node) => {
                  actionInputRef.current = node
                }}
                autoFocus
                className="wm-action-input"
                data-testid="map-action-input"
                aria-label="注释（Enter 换行 / Shift+Enter 完成）"
                placeholder="一行一条…（Enter 换行，Shift+Enter 完成）"
                value={actionDraft}
                onChange={(event) => setActionDraft(event.target.value)}
                // 幕布描述块的键盘语义（对齐 MindCanvas DescBlock）：
                // Enter = 换行（textarea 原生行为，不拦）；Shift+Enter = 提交并收起；
                // Esc = 放弃编辑。三者都在**输入面内**处理并阻断冒泡 —— 编辑区容器
                // 的 Esc 分支与全局快捷键都不该在这次按键上再动作。
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && event.shiftKey) {
                    event.preventDefault()
                    event.stopPropagation()
                    submitText()
                    return
                  }
                  if (event.key === 'Escape') {
                    event.preventDefault()
                    event.stopPropagation()
                    closeOverlay()
                    return
                  }
                  // 其余按键（含裸 Enter 换行）留给 textarea 与上层既有闸门
                  event.stopPropagation()
                }}
              />
            ) : (
              <input
                ref={(node) => {
                  actionInputRef.current = node
                }}
                autoFocus
                className="wm-action-input"
                data-testid="map-action-input"
                aria-label={overlay === 'rename' ? '新标题' : '子节点标题'}
                placeholder={overlay === 'rename' ? '新标题…' : '子节点标题…'}
                value={actionDraft}
                onChange={(event) => setActionDraft(event.target.value)}
              />
            )}
            <button
              type="submit"
              className="wm-action-submit"
              data-testid="map-action-submit"
              disabled={busy || (overlay !== 'comment' && actionDraft.trim() === '')}
            >
              {busy ? '保存中…' : '确定'}
            </button>
            <button
              type="button"
              className="wm-action-btn"
              data-testid="map-action-cancel"
              onClick={closeOverlay}
            >
              取消
            </button>
          </form>
        )
      ) : null}

      {editError !== null ? (
        <p className="ios-tiny" role="status" data-testid="map-edit-error">
          编辑失败：{editError}
        </p>
      ) : null}

      {onQuickRecord !== undefined ? (
        <div className="ios-map-quick" data-testid="map-quick">
          {THOUGHT_TYPES.map((type) => (
            <button
              key={type}
              type="button"
              className="ios-map-quick-btn"
              data-thought={type}
              data-testid={`map-quick-${type}`}
              aria-label={`记录${THOUGHT_TYPE_LABEL[type]}`}
              aria-pressed={activeType === type}
              disabled={busy}
              onClick={() => {
                setActiveType(type)
                setQuickError(null)
              }}
            >
              {THOUGHT_TYPE_LABEL[type]}
            </button>
          ))}
        </div>
      ) : null}

      {onQuickRecord !== undefined && activeType !== null ? (
        <form
          className="ios-map-quick-pop"
          data-testid="map-quick-pop"
          onSubmit={(event) => {
            event.preventDefault()
            void submitQuick()
          }}
        >
          <input
            // 浮层是「点即输」的快捷路径：打开即聚焦（用户刚主动点了类型按钮）
            autoFocus
            className="ios-map-quick-input"
            data-testid="map-quick-input"
            aria-label={`${THOUGHT_TYPE_LABEL[activeType]}内容`}
            placeholder={
              focusedSubIsland !== null
                ? `${THOUGHT_TYPE_LABEL[activeType]}…（追加到 L3 子岛「${focusedSubIsland.title.length > 8 ? `${focusedSubIsland.title.slice(0, 8)}…` : focusedSubIsland.title}」）`
                : `${THOUGHT_TYPE_LABEL[activeType]}…（Enter 记下）`
            }
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
          <button
            type="submit"
            className="ios-map-quick-submit"
            data-testid="map-quick-submit"
            disabled={busy || draft.trim() === ''}
          >
            {busy ? '记录中…' : '记下'}
          </button>
        </form>
      ) : null}

      {quickError !== null ? (
        <p className="ios-tiny" role="status" data-testid="map-quick-error">
          记录失败：{quickError}
        </p>
      ) : null}
    </div>
  )
}