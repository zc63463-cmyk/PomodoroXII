'use client'

/**
 * 工作导图**树渲染器**（SVG）—— ADR-0008 D15：中央编辑区与右栏小视图**共用同一份**。
 *
 * ## 职责边界（改动前先读）
 * - **不做布局**：几何（盒 `box` + 连线 `path`）由 `lib/work-map/island-layout` 用 kernel
 *   的 `layoutIslands` 算好；本组件只把几何画出来
 * - **不做缩放决策**：`viewBox` = 所有岛的并集包围盒，`preserveAspectRatio` 让 SVG
 *   随容器自适应 —— 因此"小视图 vs 大编辑区"**是同一个组件的两种容器宽度**，
 *   没有第二套代码（D13「最小集」纪律：一份渲染器）
 * - **不写任何事实**：纯展示（形状/颜色映射只在渲染层，不落盘）
 * - **归档岛**（D19-a）：`isArchive` 虚拟岛画成收拢卡片（不画历史节点），
 *   点击经 `onExpandArchive` 上抛，展开与否由调用方持有状态
 * - **依赖徽章**（D19-b 紧凑态）：实体节点（`refId`）可挂 `.wm-dep-badge`
 *   （红 ⚡N / 绿 ✓ + 原生 tooltip），数据由 `dependency-map-adapter` 统计；
 *   不跑连线避让，自由边完整语义保留在 `root.note.edges`（导出侧）
 * - **地标卡与聚焦**（S4-3，D19-c 纯自持增强）：会话岛外包实底圆角卡 +
 *   左色条（当前会话蓝 / 历史灰）+ 右上胶囊角标（N 项思考 + 5 类思考点阵）；
 *   双击卡片 / 点击角标上抛聚焦请求，viewBox 平滑切到单岛（rAF 插值），
 *   非聚焦岛挂 `.wm-island--dimmed`（纯 CSS opacity，DOM 不动）
 * - **幕布描述块**（PXII-FEAT-DESC-BLOCK）：节点盒内画左引用细竖线 + 缩进小灰字
 *   （对齐 MindCanvas `DescBlock`），几何取自 `descBlockGeometry`（与度量同源）；
 *   超出可见行上限的全文走原生 `<title>` tooltip —— 替代了原先"只有一个小橙点"的
 *   降级形态（`node.box.h` 不足以容纳描述时才回落到橙点）
 * - **会话发端枢纽**（PXII-FEAT-SESSION-HUB）：会话岛根不再画成 ~150px 宽矩形卡片
 *   （标题常被截成 `10-01 14:29 会…`），而是渲染紧凑的圆形 Anchor Hub（外环 + 中心
 *   亮点，`SESSION_HUB_SIZE` 方盒）；**完整会话标题上浮到岛地标卡顶栏左侧**
 *   （`.wm-island-title`，当前会话蓝 / 历史灰，超长截断 + `<title>` 全文兜底）。
 *   几何层已按 `SESSION_HUB_SIZE` 度量 → 子节点整列左移、连线自动贴合新盒缘。
 *
 * ## 视觉（D9 形状 + 颜色双重编码）
 * 会话节点 = 发端枢纽（当前会话岛根 = 高亮呼吸环）；思考节点 = 形状（●洞察 ▲问题 ◆决策 ○复盘 □待办）+
 * 类型描边色；无类型节点 = 中性小圆。文字用与度量同一把尺子截断（`fitTextToBox`）。
 * 极简态（沉浸）由外层 `[data-minimal='true']` 派生 CSS：**只隐文字，几何不变**
 * （零布局抖动）。
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

import {
  ARCHIPELAGO_CARD_H,
  ARCHIPELAGO_CARD_W,
  ARCHIPELAGO_GAP_X,
  DESC_BAR_W,
  DESC_INDENT,
  DESC_INSET_X,
  ISLAND_TITLE_FONT_SIZE,
  NODE_H_BASE,
  SESSION_HUB_SIZE,
  descBlockGeometry,
  fitDescLineToBox,
  fitIslandTitleToWidth,
  fitTextToBox,
  layoutArchipelagoIsland,
  subIslandVisualBounds,
  visibleDescLines,
  type MapIslandLayout,
  type MapSubIsland,
  type MapTreeNode,
} from '@/lib/work-map/island-layout'
import { THOUGHT_TYPES, type ThoughtType } from '@/lib/work-map/thought-types'

export interface WorkMapTreeProps {
  /** 要渲染的岛（1..N）；几何来自 `readWorkMapLayout` */
  islands: readonly MapIslandLayout[]
  /** 当前会话 id（其岛根呈"当前会话"高亮） */
  sessionId?: string | null
  className?: string
  style?: React.CSSProperties

  /** 无障碍名（不同容器可给不同描述） */
  label?: string
  /** 当前选中节点的 cid（编辑区选中态；只影响视觉环） */
  selectedCid?: string | null
  /**
   * 被定位节点的 cid（小视图定位态；驱动中央/小视图的 wm-node--focus 环）
   * 与 selectedCid（编辑选中）区分独立（ADR-0008 D15）
   */
  focusCid?: string | null
  /**
   * 跨岛按类型筛选（D13 步 3-4b）：命中类型的节点满 opacity + 描边环，其余 **dim**
   * （`opacity` 压低，**不隐藏** —— 隐藏会拆断树结构，见 ADR-0008 D17）；
   * 连线两端都 dim 才 dim。`null` / 缺省 = 全亮。
   */
  highlightType?: ThoughtType | null
  /**
   * 当前专注的计划项（L3）标题（方案 A：高亮标识正在专注的分支）。
   * 命中当前会话岛下 depth === 1 且文本相同的节点将获得 .wm-node--current-plan 样式与 [专注中] 标记。
   */
  currentPlanTitle?: string | null
  /**
   * 点击**可编辑节点**（属当前会话岛、`cid !== null`、非会话节点）→ 上抛 cid。
   * 不给则整树**只读**（右栏小视图即如此）——只读节点点击无效、但 hover 有「只读」提示。
   */
  onSelectNode?: (cid: string) => void
  /**
   * 点击**有 cid 的节点**（小视图场景；会话节点与思考节点均有 cid）→ 上抛 cid 以在中央定位高亮。
   * 当 onSelectNode 未给而 onFocusNode 给定时生效。不与 onSelectNode 并用（ADR-0008 D15）。
   */
  onFocusNode?: (cid: string) => void
  /**
   * 点击**归档岛卡片**（`isArchive` 虚拟岛，ADR-0008 D19-a）→ 一键展开全部历史
   * （等同「全部展开」）。未提供时归档卡为纯展示。
   */
  onExpandArchive?: () => void
  /**
   * 依赖状态徽章（ADR-0008 D19-b 双轨制 · 紧凑态）：键 = 节点实体引用 id
   * （``MapTreeNode.refId``，即 ``@work_item:<id>`` 的 ``<id>``）。
   * 上游 > 0 才渲染：有未完成上游 → 红 ``⚡ N``；全部完成 → 绿 ``✓``。
   * 数据源 = ``dependency-map-adapter`` 的统计映射。未提供则不渲染任何徽章。
   */
  dependencyBadges?: ReadonlyMap<string, WorkMapDependencyBadge>
  /**
   * 聚焦岛（S4-3 fitToIsland）：非空的岛在 viewBox 中单岛呈现，其余岛挂
   * ``.wm-island--dimmed``（纯 CSS opacity，不破坏 DOM）。null / 缺省 = 全览。
   */
  focusedIslandId?: string | null
  /**
   * 聚焦目标 bounds（由调用方按岛 bounds + 32px 安全内边距意图传入原始 bounds，
   * 本组件统一加 32px padding 计算目标 viewBox）。null / 缺省 = 全岛并集。
   */
  focusBounds?: { minX: number; minY: number; maxX: number; maxY: number } | null
  /**
   * `focusBounds` 模式下的安全内边距（px），缺省 32。
   *
   * 为什么可调：右栏小视图的画布只有 ~132px 高，而一个子岛卡片本身就有 200px ——
   * 32px 的双边内边距在这里是纯浪费（会把卡片压到画布的一半）。窄视口调用方
   * 传更小的值即可让"专注跟随"真正填满视口。**缺省值不变**，既有调用零影响。
   */
  focusPadding?: number
  /**
   * 聚焦请求上抛（双击岛地标卡 / 点击胶囊角标「聚焦此岛」）→ 调用方持有
   * focusedIslandId 状态（S4-3）。未提供时卡片无聚焦交互（编辑区/小视图场景）。
   */
  onIslandFocusRequest?: (islandId: string) => void
  /**
   * 聚焦子岛 id（PXII-FEAT-NESTED-ISLAND）：选中的 L3 任务子岛在 viewBox 中聚焦呈现，
   * 其余节点/连线/子岛挂 dim。null / 缺省 = 会话全览。
   */
  focusedSubIslandId?: string | null
  /**
   * 子岛聚焦请求上抛（双击嵌套子岛卡片 / 点击子岛微标签）→ 调用方持有 focusedSubIslandId 状态。
   */
  onSubIslandFocusRequest?: (subIslandId: string) => void
  /**
   * 计划项完成态（PXII-FEAT-PLAN-CHECKOFF）：键 = 子岛**标题**（`MapSubIsland.title`，
   * 两端按 `.trim()` 归一 —— 与 `currentPlanTitle` 的既有比对口径一致）。
   * 命中 → 卡片挂 `.wm-sub-island-card--completed` / `data-completed`，色条与角标转柔和绿，
   * 但**卡内思考分支与连线依然 100% 完整可见**（完成态只调视觉权重，不裁信息）。
   * 未提供 → 不渲染任何完成态（右栏小视图与总览保持纯展示）。
   */
  planCompletion?: ReadonlyMap<string, boolean>
  /**
   * 点击子岛打勾按钮 → 上抛该子岛标题（调用方按标题匹配计划项后复用既有
   * `setCompletion(planItemId, completed)` 完成契约）。未提供 → 不渲染打勾入口。
   */
  onTogglePlanCompletion?: (subIslandTitle: string) => void
}

/**
 * 完成态查询（标题两端 `.trim()` 归一）。
 *
 * 键与 `currentPlanTitle` 的比对口径**必须一致**：计划项 `titleSnapshot` 与子岛标题
 * 可能差一个首尾空格（标题来自用户输入 / Markdown 行），`===` 直比会漏配 ——
 * 表现为"右栏打了勾，导图卡片却没变绿"。
 *
 * 返回值三态：`undefined` = **无对应计划项**（不渲染打勾入口）/ `false` 未完成 / `true` 已完成。
 */
function planCompletionOf(
  planCompletion: ReadonlyMap<string, boolean> | undefined,
  title: string,
): boolean | undefined {
  if (planCompletion === undefined) return undefined
  const direct = planCompletion.get(title)
  if (direct !== undefined) return direct
  const trimmed = title.trim()
  return trimmed === title ? undefined : planCompletion.get(trimmed)
}

/**
 * 方案 A 横向卡片流投影（**导出**：右栏小视图的专注跟随要按同一份几何算 viewBox）。
 *
 * 为什么要共用：小视图若自己拿**未投影**的子岛 bounds 当 `focusBounds`，框会落在
 * "原始 2D 排布"的子岛位置上，而画出来的却是"横向卡片流"的卡片 —— 框错位。
 * 把投影收敛成一个函数，两侧几何必然同源（D13「最小集」纪律）。
 */
export function projectArchipelagoIsland(
  island: MapIslandLayout,
  currentPlanTitle?: string | null,
): MapIslandLayout {
  if (island.sessionId === null || !island.subIslands || island.subIslands.length === 0) {
    return island
  }
  return layoutArchipelagoIsland(island, currentPlanTitle)
}

/** 一个节点的依赖徽章数据（D19-b：紧凑态不跑连线避让，用 Badge 表达）。 */
export interface WorkMapDependencyBadge {
  /** 上游 blocker 总数 */
  upstream: number
  /** 其中未完成（未 completed）的上游数 */
  blocked: number
}

const PAD = 12

/**
 * 思考类型形状（9px 视口，位于节点盒左侧 10px 处）。
 * **导出**：类型图例（`work-map-legend`）复用同一份几何 —— D9 双编码要"形状同源"，
 * 不能在图例里另抄一份（改了树没改图例就会分叉）。
 */
export function TypeShape({ x, y, type }: { x: number; y: number; type: NonNullable<MapTreeNode['thoughtType']> }): ReactNode {
  switch (type) {
    case 'insight':
      return <circle cx={x} cy={y} r={4} className="wm-shape wm-shape--insight" />
    case 'problem':
      return <polygon points={`${x},${y - 4.5} ${x + 4.5},${y + 3.5} ${x - 4.5},${y + 3.5}`} className="wm-shape wm-shape--problem" />
    case 'decision':
      return <rect x={x - 3.4} y={y - 3.4} width={6.8} height={6.8} rx={1} transform={`rotate(45 ${x} ${y})`} className="wm-shape wm-shape--decision" />
    case 'review':
      return <circle cx={x} cy={y} r={4} className="wm-shape wm-shape--review" />
    case 'todo':
      return <rect x={x - 3.6} y={y - 3.6} width={7.2} height={7.2} rx={1} className="wm-shape wm-shape--todo" />
  }
}

function NodeBox({
  node,
  currentSession,
  editable,
  selected,
  focused,
  dimmed,
  highlighted,
  badge,
  currentPlan,
  completed,
  onSelect,
  onFocus,
}: {
  node: MapTreeNode
  /**
   * 该节点是否命中 `sessionId` prop（= **当前**会话）。
   * 与 `node.sessionNode`（**是**会话节点）区分：历史会话岛的岛根同样是会话节点，
   * 只是不属于"本次" —— 两者都画发端枢纽，但只有当前会话带高亮呼吸环。
   */
  currentSession: boolean
  /** 当前专注的计划项（L3）分支高亮（方案 A） */
  currentPlan?: boolean
  /** 所属子岛已完成（PXII-FEAT-PLAN-CHECKOFF）：只加一层柔和绿意，不改变任何几何 */
  completed?: boolean
  editable: boolean
  selected: boolean
  focused: boolean
  /** 跨岛筛选：非命中类型 → dim（**只调视觉权重、不隐藏**，D17） */
  dimmed: boolean
  /** 跨岛筛选：命中类型 → 满 opacity + 描边环 */
  highlighted: boolean
  /** 依赖状态徽章（D19-b 紧凑态）；null / upstream 0 → 不渲染 */
  badge: WorkMapDependencyBadge | null
  onSelect?: (cid: string) => void
  onFocus?: (cid: string) => void
}): ReactNode {
  // 会话节点判定取**节点自身**（`session_id` 良构）—— 与几何层的紧凑度量同判据
  const isSession = node.sessionNode
  const badgeText =
    badge !== null && badge.upstream > 0
      ? badge.blocked > 0
        ? `⚡ ${badge.blocked}`
        : '✓'
      : null
  const badgeWidth = badgeText === null ? 0 : 10 + badgeText.length * 6.5
  const label = fitTextToBox(
    node.text === '' ? '（无标题）' : node.text,
    badgeText === null ? node.box.w : node.box.w - badgeWidth - 6,
    node.depth,
  )
  const textX = node.thoughtType !== null ? 24 : 12

  // ── 幕布描述块（PXII-FEAT-DESC-BLOCK）────────────────────────────────
  // 几何来自 `descBlockGeometry`（与 `measureWorkMapNode` 同一函数）：预留高度
  // 与画出的行数**同源**，不可能出现"文字画出盒外"。`box.h` 不够（手工构造的
  // 岛 / 老几何）时降级成右上角小圆点 —— 至少让"此节点有注释"可见。
  const descGeo = descBlockGeometry(node.comment, node.box.h)
  const descLines = visibleDescLines(node.comment)
  const hasDesc = descGeo !== null && node.box.h > NODE_H_BASE + 2
  // 标题行带高：有描述时标题只占顶部基础带，纵向居中于该带内（不再占满整盒）
  const titleCy = hasDesc ? NODE_H_BASE / 2 : node.box.h / 2
  const commentLines = node.comment ?? []

  const isSelectMode = onSelect !== undefined
  const isFocusMode = !isSelectMode && onFocus !== undefined

  // 可编辑 = 属当前会话岛 + 有 cid + 非会话节点（D16-a）；只读节点不给入口
  // 可定位 = 小视图场景下，只要有 cid 即可定位（包含会话节点与思考节点）
  const isActionable = isSelectMode
    ? (editable && node.cid !== null)
    : (isFocusMode && node.cid !== null)

  const actionCid = isActionable ? node.cid : null

  const handleClick = actionCid !== null
    ? (): void => {
        if (isSelectMode) {
          onSelect?.(actionCid)
        } else if (isFocusMode) {
          onFocus?.(actionCid)
        }
      }
    : undefined

  const ariaLabel = actionCid !== null
    ? (isSelectMode
        ? `编辑节点：${node.text === '' ? '（无标题）' : node.text}`
        : `定位：${node.text === '' ? '（无标题）' : node.text}`)
    : undefined

  // 原生 tooltip：完整标题 + 完整注释（> 3 行的注释靠这里 100% 可读）
  const readonlyHint = actionCid === null
    ? (isSession ? '会话节点（只读）' : '存量节点（无 cid，只读）')
    : null
  const tooltipParts: string[] = []
  // 会话发端枢纽（PXII-FEAT-SESSION-HUB）：标题已上浮到地标卡顶栏，枢纽自身
  // 只保留"这是会话发端"的语义 —— 悬停时用 `会话发端：<完整标题>` 说明来源。
  if (isSession) tooltipParts.push(`会话发端：${node.text === '' ? '（无标题）' : node.text}`)
  if (commentLines.length > 0) {
    tooltipParts.push(
      node.text === '' ? '（无标题）' : node.text,
      '',
      `[注释备忘]:\n${commentLines.join('\n')}`,
    )
  }
  if (currentPlan) tooltipParts.push('[专注中]')
  if (readonlyHint !== null) tooltipParts.push(readonlyHint)
  const tooltip = tooltipParts.length > 0 ? tooltipParts.join('\n\n') : null

  return (
    <g
      transform={`translate(${node.box.x} ${node.box.y})`}
      className={[
        'wm-node',
        currentPlan ? 'wm-node--current-plan' : '',
        completed ? 'wm-node--plan-completed' : '',
        selected ? 'wm-node--selected' : '',
        focused ? 'wm-node--focus' : '',
        dimmed ? 'wm-node--dim' : '',
        highlighted ? 'wm-node--hl' : '',
      ].filter((token) => token !== '').join(' ')}
      data-testid={currentSession ? 'wm-session-node' : undefined}
      data-thought={node.thoughtType ?? undefined}
      data-session={currentSession ? 'true' : 'false'}
      data-current-plan={currentPlan ? 'true' : undefined}
      data-plan-completed={completed ? 'true' : undefined}
      data-cid={actionCid ?? undefined}
      // 发端枢纽不画描述块/橙点（盒仅 28px，几何装不下）—— 注释全文仍由 tooltip 承载，
      // 故 data-comment / data-desc-lines 对会话节点不挂（避免"标了却没画"的假信号）
      data-comment={!isSession && node.comment !== null ? 'true' : undefined}
      data-desc-lines={!isSession && hasDesc ? descGeo.lineCount : undefined}
      data-readonly={actionCid === null ? 'true' : undefined}
      data-selected={selected ? 'true' : undefined}
      data-focus={focused ? 'true' : undefined}
      data-dim={dimmed ? 'true' : undefined}
      data-highlight={highlighted ? 'true' : undefined}
      role={actionCid !== null ? 'button' : undefined}
      tabIndex={actionCid !== null ? 0 : undefined}
      aria-label={ariaLabel}
      onClick={handleClick}
      onKeyDown={
        actionCid !== null
          ? (event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                handleClick?.()
              }
            }
          : undefined
      }
    >
      {/* 原生 tooltip：完整标题 + 完整注释（只读节点另附只读原因） */}
      {tooltip !== null ? <title>{tooltip}</title> : null}
      {isSession ? (
        <SessionHub node={node} current={currentSession} />
      ) : (
        <>
          <rect
            width={node.box.w}
            height={node.box.h}
            rx={7}
            className={[
              'wm-box',
              selected ? 'wm-box--selected' : '',
              !selected && currentPlan ? 'wm-box--current-plan' : '',
              !selected && !currentPlan && completed ? 'wm-box--plan-completed' : '',
            ]
              .filter((token) => token !== '')
              .join(' ')}
          />
          {node.thoughtType !== null ? (
            <TypeShape x={12} y={titleCy} type={node.thoughtType} />
          ) : currentPlan ? (
            <g className="wm-shape wm-shape--current-hub">
              <circle cx={12} cy={titleCy} r={4.5} fill="none" stroke="var(--ios-blue)" strokeWidth={1.5} />
              <circle cx={12} cy={titleCy} r={2} fill="var(--ios-blue)" />
            </g>
          ) : (
            <circle cx={12} cy={titleCy} r={3} className="wm-shape wm-shape--plain" />
          )}
          {/* 字号与度量同一档（root/branch/leaf）—— 截断宽度才不会与绘制宽度分叉 */}
          <text
            x={textX}
            y={titleCy}
            dy="0.32em"
            fontSize={node.depth === 0 ? 12.5 : node.depth === 1 ? 12 : 11}
            className="wm-text"
          >
            {label}
          </text>
          {/* 幕布描述块：左引用竖线 + 缩进小灰字（对齐 MindCanvas DescBlock） */}
          {hasDesc ? (
            <g className="wm-desc-group" data-testid="wm-desc-group">
              <line
                x1={DESC_INSET_X}
                y1={descGeo.barTop}
                x2={DESC_INSET_X}
                y2={descGeo.barBottom}
                className="wm-desc-bar"
                strokeWidth={DESC_BAR_W}
                strokeLinecap="round"
              />
              <text
                x={DESC_INSET_X + DESC_BAR_W + DESC_INDENT}
                className="wm-desc-text"
                fontSize={10}
                fontFamily="inherit"
              >
                {descLines.map((line, index) => (
                  <tspan
                    key={`${index}-${line}`}
                    x={DESC_INSET_X + DESC_BAR_W + DESC_INDENT}
                    y={descGeo.baselineOf(index)}
                  >
                    {fitDescLineToBox(line, node.box.w)}
                  </tspan>
                ))}
              </text>
            </g>
          ) : null}
          {/* 有注释但盒高不足以画描述（手工构造岛 / 老几何）→ 降级小圆点 */}
          {node.comment !== null && !hasDesc ? (
            <circle cx={node.box.w - 6} cy={6} r={3.5} className="wm-comment-dot" />
          ) : null}
          {/* 依赖状态徽章（D19-b 紧凑态）：红色 ⚡N = 有未完成上游；绿 ✓ = 全部完成 */}
          {badgeText !== null ? (
            <g
              className={`wm-dep-badge ${badge !== null && badge.blocked > 0 ? 'wm-dep-badge--blocked' : 'wm-dep-badge--ok'}`}
              data-testid="wm-dep-badge"
              data-blocked={badge !== null && badge.blocked > 0 ? 'true' : 'false'}
              data-upstream={badge?.upstream ?? 0}
            >
              <title>
                {`上游依赖 ${badge?.upstream ?? 0} 项 · 未完成 ${badge?.blocked ?? 0} 项`}
              </title>
              <rect
                x={node.box.w - badgeWidth - 6}
                y={titleCy - 8}
                width={badgeWidth}
                height={16}
                rx={8}
              />
              <text
                x={node.box.w - badgeWidth / 2 - 6}
                y={titleCy}
                dy="0.32em"
                textAnchor="middle"
              >
                {badgeText}
              </text>
            </g>
          ) : null}
        </>
      )}
    </g>
  )
}

/**
 * 会话**发端枢纽**（Anchor Hub，PXII-FEAT-SESSION-HUB）—— 会话岛根的紧凑形态。
 *
 * 为什么不再画宽矩形卡片：岛根文本是 `10-01 14:29 会话` 这类**会话时间戳**，
 * 横向占 ~150px 且常被截断成 `10-01 14:29 会…` —— 信息量低、视觉噪音高。
 * 上浮到地标卡顶栏后，画布内只需表达"这里是岛的发端"：
 * 外圆环（`r=10`）+ 中心亮点（`r=4`）。
 *
 * 盒仍是 `SESSION_HUB_SIZE` 方盒（几何层度量同源）——枢纽在盒内**居中**绘制并按
 * 盒尺寸**等比**收敛，故 `box.w` 与 `box.h` 不等时也不会偏心（手工构造的旧几何同样容错）。
 * 当前会话的呼吸环由 CSS 派生（`.wm-box--session-hub[data-hub-current='true']`）。
 */
function SessionHub({ node, current }: { node: MapTreeNode; current: boolean }): ReactNode {
  const cx = node.box.w / 2
  const cy = node.box.h / 2
  // 环半径按**设计常数等比**收敛：SESSION_HUB_SIZE=28 时 r = 14 × (10/14) = 10；
  // 旧几何/手工岛的盒尺寸不同也保持同一视觉比例（不写死像素）
  const ringR = Math.max(4, Math.min(cx, cy) * (HUB_RING_R / (SESSION_HUB_SIZE / 2)))
  return (
    <g
      className="wm-box--session-hub"
      data-testid="wm-session-hub"
      data-hub-current={current ? 'true' : 'false'}
    >
      <circle cx={cx} cy={cy} r={ringR} className="wm-hub-ring" />
      <circle cx={cx} cy={cy} r={Math.max(1.6, ringR * HUB_CORE_RATIO)} className="wm-hub-core" />
    </g>
  )
}

/**
 * 历史会话**归档岛卡片**（ADR-0008 D19-a）：虚拟岛的呈现形态 —— 一张收拢卡片，
 * 不画任何历史节点（节点在几何层已收拢为计数）。点击 = 一键展开全部历史。
 */
function ArchiveCard({
  island,
  onExpand,
  dimmed,
}: {
  island: MapIslandLayout
  onExpand?: () => void
  dimmed: boolean
}): ReactNode {
  const count = island.archivedCount ?? 0
  const box = island.tree.box
  const interactive = onExpand !== undefined
  return (
    <g
      transform={`translate(${box.x} ${box.y})`}
      className={dimmed ? 'wm-island--archive wm-island--dimmed' : 'wm-island--archive'}
      data-testid="wm-archive-island"
      data-archived-count={count}
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : undefined}
      aria-label={interactive ? `展开历史全览（共 ${count} 次早期专注）` : undefined}
      onClick={interactive ? onExpand : undefined}
      onKeyDown={
        interactive
          ? (event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                onExpand?.()
              }
            }
          : undefined
      }
    >
      <rect width={box.w} height={box.h} rx={10} className="wm-box" />
      <text x={16} y={box.h / 2 - 6} className="wm-archive-title">
        📁 早期会话 (共 {count} 次专注)
      </text>
      <text x={16} y={box.h / 2 + 16} className="wm-archive-sub">
        {interactive ? '点击展开历史全览' : '已展开全部历史'}
      </text>
    </g>
  )
}

/** 岛地标卡外框相对岛 bounds 的外扩量（顶部留胶囊角标条位，S4-3）。 */
const FRAME_PAD = { top: 28, right: 12, bottom: 12, left: 12 }
/** 岛地标卡最小宽度：容纳顶栏会话标题 + 呼吸位 + 右上胶囊角标（避免单短节点窄岛截断）。 */
export const MIN_ISLAND_CARD_W = 260
/** 胶囊角标几何（高度 / 圆点间距 / 思考类型点阵数）。 */
const BADGE_H = 18
const DOT_GAP = 10
/** viewBox 切换的平滑动画时长（ms；prefers-reduced-motion 时直接落位）。 */
const VIEW_BOX_EASE_MS = 240
/** 发端枢纽：设计环半径（`SESSION_HUB_SIZE` 盒内的基准；其余尺寸按比例收敛）。 */
const HUB_RING_R = 10
/** 发端枢纽：中心亮点 / 外环半径比（4 / 10）。 */
const HUB_CORE_RATIO = 0.4

type WorkMapBounds = { minX: number; minY: number; maxX: number; maxY: number }

/** 岛的「视觉 bounds」：会话岛含地标卡外框（union viewBox 不得裁掉卡片）。 */
function islandVisualBounds(island: MapIslandLayout): WorkMapBounds {
  if (island.isArchive === true || island.sessionId === null) return island.bounds
  if (island.isArchipelago === true) return island.bounds
  const minX = island.bounds.minX - FRAME_PAD.left
  const naturalW = island.bounds.maxX - island.bounds.minX + FRAME_PAD.left + FRAME_PAD.right
  const w = Math.max(MIN_ISLAND_CARD_W, naturalW)
  return {
    minX,
    minY: island.bounds.minY - FRAME_PAD.top,
    maxX: minX + w,
    maxY: island.bounds.maxY + FRAME_PAD.bottom,
  }
}

function parseViewBox(value: string): [number, number, number, number] | null {
  const parts = value.split(/[\s,]+/).map(Number)
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null
  return [parts[0], parts[1], parts[2], parts[3]]
}

const sameViewBox = (a: [number, number, number, number], b: [number, number, number, number]): boolean =>
  a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3]

/**
 * viewBox 平滑插值（S4-3 fitToIsland）：SVG 的 viewBox 是属性、CSS 无法过渡，
 * 用 rAF 逐帧 easeOutCubic 逼近目标；最终帧**逐字**落在目标串（单测可精确断言）。
 * 无 rAF / 偏好减少动态时直接落位（可及性 + jsdom 容错）。
 */
function useAnimatedViewBox(target: string): string {
  const [display, setDisplay] = useState(target)
  const displayRef = useRef(target)
  const rafRef = useRef<number | null>(null)
  useEffect(() => {
    const from = parseViewBox(displayRef.current)
    const to = parseViewBox(target)
    const settle = (): void => {
      displayRef.current = target
      setDisplay(target)
    }
    if (
      from === null ||
      to === null ||
      sameViewBox(from, to) ||
      typeof window === 'undefined' ||
      typeof window.requestAnimationFrame !== 'function' ||
      window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true
    ) {
      settle()
      return
    }
    // ★ 起点**惰性取自首帧时间戳**：rAF 的回调时间戳与 performance.now() 不同源
    //   （jsdom 实测两者相差近 1s），混用会得到负进度、永不收敛。
    let start: number | null = null
    const tick = (now: number): void => {
      const stamp =
        typeof now === 'number' && Number.isFinite(now) ? now : window.performance.now()
      if (start === null) start = stamp
      const t = Math.min(1, Math.max(0, (stamp - start) / VIEW_BOX_EASE_MS))
      const eased = 1 - (1 - t) ** 3
      const next = from
        .map((v, i) => Math.round((v + (to[i] - v) * eased) * 10) / 10)
        .join(' ')
      displayRef.current = next
      setDisplay(next)
      if (t < 1) {
        rafRef.current = window.requestAnimationFrame(tick)
      } else {
        settle()
      }
    }
    rafRef.current = window.requestAnimationFrame(tick)
    return () => {
      if (rafRef.current !== null) window.cancelAnimationFrame(rafRef.current)
    }
  }, [target])
  return display
}

/**
 * 岛**地标卡**（S4-3，对齐 MindCanvas IO-UX 规范）：会话岛外包实底圆角卡 +
 * 左侧色条（当前会话 systemBlue / 历史中性灰）+ 右上胶囊角标
 * （「N 项思考」+ 5 类思考点阵，有对应类型节点才点亮）。
 * 双击卡片或点击角标 → 上抛聚焦请求（D19-c 纯自持增强，无外渲染器）。
 *
 * **顶栏会话标题**（PXII-FEAT-SESSION-HUB）：卡内左上角画完整会话标题
 * （`.wm-island-title`）—— 会话标题的**唯一完整展示位**（画布内岛根已收拢为
 * 发端枢纽，不再承载文本）。当前会话蓝、历史会话柔和灰（CSS 派生）；
 * 可写宽度 = 角标左缘 − 起点 − 呼吸位，超长时截断并由 `<title>` 给全文。
 */
function IslandFrameCard({
  island,
  isCurrent,
  interactive,
  onRequestFocus,
}: {
  island: MapIslandLayout
  isCurrent: boolean
  interactive: boolean
  onRequestFocus?: (islandId: string) => void
}): ReactNode {
  const isArchipelago = island.isArchipelago === true
  const totalCardsW = isArchipelago
    ? island.subIslands!.length * ARCHIPELAGO_CARD_W + Math.max(0, island.subIslands!.length - 1) * ARCHIPELAGO_GAP_X
    : 0
  const x = isArchipelago ? Math.max(0, island.tree.box.x - 16) : island.bounds.minX - FRAME_PAD.left
  const y = isArchipelago ? 16 : island.bounds.minY - FRAME_PAD.top
  const naturalW = island.bounds.maxX - island.bounds.minX + FRAME_PAD.left + FRAME_PAD.right
  const w = isArchipelago ? Math.max(totalCardsW, 320) : Math.max(MIN_ISLAND_CARD_W, naturalW)
  const h = isArchipelago ? 42 : island.bounds.maxY - island.bounds.minY + FRAME_PAD.top + FRAME_PAD.bottom
  // 思考条目数 = 岛内子节点数（岛根不计）；点阵 = 5 类是否有命中
  const thoughtCount = Math.max(0, island.nodes.length - 1)
  const litTypes = new Set<ThoughtType>()
  for (const node of island.nodes) {
    if (node.thoughtType !== null) litTypes.add(node.thoughtType)
  }
  const countText = isArchipelago
    ? `${island.subIslands!.length} 子岛 · ${thoughtCount} 思考`
    : `${thoughtCount} 项思考`
  const textWidth = [...countText].reduce(
    (sum, ch) => sum + (/[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFF00-\uFF60]/.test(ch) ? 10 : 5.6),
    0,
  )
  const dotsWidth = THOUGHT_TYPES.length * DOT_GAP
  const badgeWidth = 10 + textWidth + 6 + dotsWidth + 8
  const badgeX = isArchipelago ? x + w - badgeWidth - 10 : x + w - badgeWidth - 8
  const badgeY = isArchipelago ? y + (h - BADGE_H) / 2 : y + 6
  // 顶栏标题：与角标同一条水平中线（胶囊中心），起点让出色条（4px）+ 呼吸位
  const titleX = isArchipelago ? x + 50 : x + 14
  const titleY = isArchipelago ? y + h / 2 : y + 6 + BADGE_H / 2
  const title = island.tree.text === '' ? '（无标题会话）' : island.tree.text
  // 宽度自适应：右侧不得压到角标（角标左缘 − 12px 呼吸位）
  const titleMaxW = badgeX - titleX - 12
  const titleLabel = fitIslandTitleToWidth(title, titleMaxW)

  return (
    <g
      className={`wm-island-card${isCurrent ? ' wm-island-card--current' : ''}`}
      data-testid="wm-island-card"
      data-island-id={island.rootId}
      data-thought-count={thoughtCount}
      onDoubleClick={interactive ? () => onRequestFocus?.(island.rootId) : undefined}
    >
      <title>{interactive ? '双击聚焦此岛' : undefined}</title>
      {/* 实底圆角卡（柔和投影走 CSS filter）；左色条标识当前/历史 */}
      <rect x={x} y={y} width={w} height={h} rx={12} className="wm-island-frame" />
      <rect x={x} y={y} width={4} height={h} rx={2} className="wm-island-bar" />
      {/* 顶栏会话标题（红框）：完整标题的唯一展示位，超长截断 + tooltip 全文兜底。
          `<title>` 挂在包裹 `<g>` 上（而非 `<text>` 内）—— 避免全文与截断串在
          textContent 里重复出现（对断言与读屏都是噪音）。 */}
      <g className="wm-island-title-wrap" data-testid="wm-island-title-wrap">
        <title>{title}</title>
        <text
          x={titleX}
          y={titleY}
          textAnchor="start"
          dominantBaseline="central"
          fontSize={ISLAND_TITLE_FONT_SIZE}
          className="wm-island-title"
          data-testid="wm-island-title"
          data-full-title={title}
          data-truncated={titleLabel === title ? 'false' : 'true'}
        >
          {titleLabel}
        </text>
      </g>
      {/* 胶囊角标：统计 + 点阵 + 「聚焦此岛」入口 */}
      <g
        className="wm-island-badge"
        data-testid="wm-island-badge"
        role={interactive ? 'button' : undefined}
        tabIndex={interactive ? 0 : undefined}
        aria-label={interactive ? `聚焦此岛：${island.tree.text}（${thoughtCount} 项思考）` : undefined}
        onClick={interactive ? () => onRequestFocus?.(island.rootId) : undefined}
        onKeyDown={
          interactive
            ? (event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  onRequestFocus?.(island.rootId)
                }
              }
            : undefined
        }
      >
        <rect x={badgeX} y={badgeY} width={badgeWidth} height={BADGE_H} rx={BADGE_H / 2} />
        <text x={badgeX + 10} y={badgeY + BADGE_H / 2} dy="0.32em">
          {countText}
        </text>
        {THOUGHT_TYPES.map((type, index) => (
          <g
            key={type}
            transform={`translate(${badgeX + 10 + textWidth + 6 + index * DOT_GAP} ${badgeY + BADGE_H / 2})`}
            opacity={litTypes.has(type) ? 1 : 0.16}
            data-lit={litTypes.has(type) ? 'true' : 'false'}
          >
            <TypeShape x={0} y={0} type={type} />
          </g>
        ))}
      </g>
    </g>
  )
}

/**
 * 嵌套子岛地标卡（PXII-FEAT-NESTED-ISLAND）：
 * 会话岛内每个 L3 任务子分支作为一个嵌套子岛呈现。
 * 外包半透明圆角虚线框 + 顶部微标签（L3 子岛 · N 项思考）+ 支持当前计划项高亮。
 * 双击卡片或点击微标签触发聚焦进该子岛（或退出聚焦）。
 */
function SubIslandFrameCard({
  subIsland,
  isCurrentPlan,
  isFocused,
  dimmed,
  interactive,
  planCompletion,
  onToggleCompletion,
  onRequestFocus,
}: {
  subIsland: MapSubIsland
  isCurrentPlan: boolean
  isFocused: boolean
  dimmed: boolean
  interactive: boolean
  /**
   * 该子岛对应的计划项完成态（PXII-FEAT-PLAN-CHECKOFF）：`undefined` = **无对应计划项**
   * （不渲染打勾入口）/ `false` 未完成 / `true` 已完成。
   * 完成态只调视觉权重 —— 卡片内的思考分支与连线**依然 100% 完整可见**（复盘信息不丢）。
   */
  planCompletion?: boolean
  /** 点击打勾按钮 → 上抛（调用方按标题匹配计划项切换完成态）；缺省 = 不渲染打勾入口 */
  onToggleCompletion?: () => void
  onRequestFocus?: (subIslandId: string) => void
}): ReactNode {
  const completed = planCompletion === true
  const isArchipelago =
    !isFocused && subIsland.bounds.maxX - subIsland.bounds.minX === ARCHIPELAGO_CARD_W
  const visual = isArchipelago ? subIsland.bounds : subIslandVisualBounds(subIsland, isFocused)
  const w = Math.max(1, visual.maxX - visual.minX)
  const h = Math.max(1, visual.maxY - visual.minY)
  const thoughtCount = subIsland.nodes.filter((n) => n.thoughtType !== null).length
  const tagText =
    completed
      ? '✓ 已完成'
      : isArchipelago && isCurrentPlan
      ? 'L3 子岛 · 专注中'
      : thoughtCount > 0
      ? `L3 子岛 · ${thoughtCount}项`
      : 'L3 子岛'
  const tagW = Math.max(
    50,
    Math.round(
      [...tagText].reduce(
        (s, c) =>
          s +
          (/[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFF00-\uFF60]/.test(c)
            ? 9
            : 5.5),
        0,
      ) + 12,
    ),
  )
  // 全局视图下：单叶子节点将微标签并排置于节点右侧（同高居中）；含思考项的子岛置于右上角
  const isLeaf = subIsland.nodes.length === 1
  const tagX = isArchipelago
    ? visual.maxX - tagW - 8
    : isLeaf
    ? subIsland.bounds.maxX + 6
    : Math.max(visual.minX + 8, visual.maxX - tagW - 8)
  const tagY = isArchipelago
    ? visual.minY + 6
    : isLeaf
    ? subIsland.bounds.minY + Math.max(0, (subIsland.bounds.maxY - subIsland.bounds.minY - 12) / 2)
    : visual.minY + 2

  const handleClick = interactive
    ? () => onRequestFocus?.(isFocused ? '' : subIsland.id)
    : undefined

  // 聚焦态专用几何（顶栏标题 + 状态角标 + 底部返回按钮）
  const titleX = visual.minX + 14
  const titleY = visual.minY + 16
  const title = subIsland.title === '' ? '（未命名 L3 子任务）' : subIsland.title
  const badgeText = isCurrentPlan ? '⚡ 当前专注中' : `${thoughtCount} 项思考`
  const badgeW = isCurrentPlan ? 78 : 66
  const badgeX = visual.maxX - badgeW - 12
  const badgeY = visual.minY + 7

  // ── 一键完成打勾（PXII-FEAT-PLAN-CHECKOFF）──────────────────────────────
  // 位置：微标签／角标**左侧**（标签恒在卡片右上角，左侧是唯一不会撞标题/出界的空位）。
  // 事件：`stopPropagation` 阻断冒泡 —— 卡片自身的 `onDoubleClick` 是"聚焦此岛"，
  // 打勾按钮上的一次点击绝不能顺带把视图切进/切出聚焦态。
  const checkR = 8
  const checkCx = isArchipelago
    ? tagX - checkR - 4
    : isFocused
      ? badgeX - checkR - 4
      : tagX - checkR - 4
  const checkCy = isArchipelago
    ? visual.minY + 15
    : isFocused
      ? badgeY + 9
      : tagY + (isLeaf ? 9 : 6)
  const checkHandler =
    onToggleCompletion === undefined
      ? null
      : {
          onClick: (event: React.MouseEvent) => {
            event.stopPropagation()
            onToggleCompletion()
          },
          onDoubleClick: (event: React.MouseEvent) => event.stopPropagation(),
          onKeyDown: (event: React.KeyboardEvent) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              event.stopPropagation()
              onToggleCompletion()
            }
          },
        }
  const checkNode =
    checkHandler === null ? null : (
      <g
        className={`wm-sub-island-check ${completed ? 'wm-sub-island-check--done' : ''}`}
        data-testid="wm-sub-island-check"
        data-completed={completed ? 'true' : 'false'}
        role="button"
        tabIndex={0}
        aria-pressed={completed}
        aria-label={completed ? `标记未完成：${subIsland.title}` : `标记已完成：${subIsland.title}`}
        {...checkHandler}
      >
        <title>{completed ? '点击标记未完成' : '点击标记已完成'}</title>
        <circle cx={checkCx} cy={checkCy} r={checkR} className="wm-sub-island-check-bg" />
        <text
          x={checkCx}
          y={checkCy}
          textAnchor="middle"
          dominantBaseline="central"
          fontSize={10}
          fontWeight={700}
          className="wm-sub-island-check-mark"
        >
          {completed ? '✓' : '○'}
        </text>
      </g>
    )
  /** 打勾按钮占位宽度 —— 与它同排的标题可写宽度必须扣掉，否则叠字 */
  const checkReserve = checkHandler === null ? 0 : checkR * 2 + 8

  // 底部退出胶囊按钮
  const exitW = 140
  const exitH = 20
  const exitX = visual.minX + Math.max(8, (w - exitW) / 2)
  const exitY = visual.maxY - exitH - 7

  return (
    <g
      className={[
        'wm-sub-island-card',
        isCurrentPlan ? 'wm-sub-island-card--current' : '',
        isFocused ? 'wm-sub-island-card--focused' : '',
        completed ? 'wm-sub-island-card--completed' : '',
        dimmed ? 'wm-sub-island-card--dimmed' : '',
      ]
        .filter((token) => token !== '')
        .join(' ')}
      data-testid="wm-sub-island-card"
      data-sub-island-id={subIsland.id}
      data-current-plan={isCurrentPlan ? 'true' : undefined}
      data-focused={isFocused ? 'true' : undefined}
      data-completed={completed ? 'true' : undefined}
      onDoubleClick={handleClick}
    >
      <title>
        {interactive
          ? isFocused
            ? '双击退出子岛聚焦'
            : `双击聚焦此子岛：${subIsland.title}`
          : undefined}
      </title>
      <rect
        x={visual.minX}
        y={visual.minY}
        width={w}
        height={h}
        rx={isFocused ? 12 : 8}
        className="wm-sub-island-frame"
      />
      {isArchipelago ? (
        <>
          {/* 实底卡片与左侧色条（当前计划高亮蓝 / 已完成柔和绿） */}
          {isCurrentPlan || completed ? (
            <rect
              x={visual.minX}
              y={visual.minY}
              width={4}
              height={h}
              rx={2}
              className="wm-sub-island-bar"
            />
          ) : null}

          {/* 顶栏微地标底色 */}
          <rect
            x={visual.minX}
            y={visual.minY}
            width={w}
            height={30}
            rx={12}
            className="wm-sub-island-hd-bg"
            fill={
              isCurrentPlan
                ? 'color-mix(in oklab, var(--ios-blue) 12%, transparent)'
                : 'color-mix(in oklab, var(--foreground) 3.5%, transparent)'
            }
          />
          <rect
            x={visual.minX}
            y={visual.minY + 16}
            width={w}
            height={14}
            fill={
              isCurrentPlan
                ? 'color-mix(in oklab, var(--ios-blue) 12%, transparent)'
                : 'color-mix(in oklab, var(--foreground) 3.5%, transparent)'
            }
          />
          <circle
            cx={visual.minX + 16}
            cy={visual.minY + 15}
            r={4.5}
            fill={isCurrentPlan ? 'var(--ios-blue)' : 'var(--ios-label-2)'}
          />
          <text
            x={visual.minX + 28}
            y={visual.minY + 16}
            dominantBaseline="central"
            fontSize={11.5}
            fontWeight={600}
            className="wm-sub-island-title"
            data-testid="wm-sub-island-card-title"
            fill={isCurrentPlan ? 'var(--ios-blue)' : 'var(--ios-label)'}
          >
            {fitIslandTitleToWidth(
              title,
              (isCurrentPlan ? w - 96 : w - 74) - checkReserve,
              11.5,
            )}
          </text>

          {/* 一键完成打勾（微标签左侧） */}
          {checkNode}

          {/* 右上角微标签 */}
          <g
            className="wm-sub-island-tag-wrap"
            role={interactive ? 'button' : undefined}
            tabIndex={interactive ? 0 : undefined}
            aria-label={interactive ? `聚焦子岛：${subIsland.title}` : undefined}
            onClick={handleClick}
            onKeyDown={
              interactive
                ? (event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      handleClick?.()
                    }
                  }
                : undefined
            }
          >
            <rect
              x={tagX}
              y={tagY}
              width={tagW}
              height={18}
              rx={9}
              className="wm-sub-island-tag-bg"
            />
            <text
              x={tagX + tagW / 2}
              y={tagY + 9}
              textAnchor="middle"
              dominantBaseline="central"
              fontSize={9}
              className="wm-sub-island-tag-text"
            >
              {tagText}
            </text>
          </g>

          {/* 底部点击聚焦按钮 */}
          {interactive ? (
            <g
              className="wm-sub-island-hint"
              role="button"
              tabIndex={0}
              aria-label={`点击聚焦此子岛：${subIsland.title}`}
              onClick={handleClick}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  handleClick?.()
                }
              }}
            >
              <rect
                x={visual.minX + (w - 96) / 2}
                y={visual.maxY - 24}
                width={96}
                height={18}
                rx={9}
                className="wm-sub-island-exit-bg"
              />
              <text
                x={visual.minX + w / 2}
                y={visual.maxY - 15}
                textAnchor="middle"
                dominantBaseline="central"
                fontSize={9.5}
                fontWeight={600}
                fill="var(--ios-blue)"
              >
                点击聚焦此岛 →
              </text>
            </g>
          ) : null}
        </>
      ) : isFocused ? (
        <>
          <rect
            x={visual.minX}
            y={visual.minY}
            width={4}
            height={h}
            rx={2}
            className="wm-sub-island-bar"
          />
          <text
            x={titleX}
            y={titleY}
            textAnchor="start"
            dominantBaseline="central"
            fontSize={11.5}
            fontWeight={600}
            className="wm-sub-island-title"
            data-testid="wm-sub-island-title"
          >
            🏝️ L3 子任务岛 ·{' '}
            {fitIslandTitleToWidth(title, Math.max(20, badgeX - titleX - 8 - checkReserve), 11.5)}
          </text>
          {checkNode}
          <g className="wm-sub-island-badge" data-testid="wm-sub-island-badge">
            <rect
              x={badgeX}
              y={badgeY}
              width={badgeW}
              height={18}
              rx={9}
              fill={isCurrentPlan ? 'var(--ios-blue)' : 'color-mix(in oklab, var(--foreground) 10%, transparent)'}
            />
            <text
              x={badgeX + badgeW / 2}
              y={badgeY + 9}
              textAnchor="middle"
              dominantBaseline="central"
              fontSize={9}
              fill={isCurrentPlan ? '#fff' : 'currentColor'}
              fontWeight={600}
            >
              {badgeText}
            </text>
          </g>
          {interactive ? (
            <g
              className="wm-sub-island-exit-pill"
              data-testid="map-sub-island-exit-btn"
              role="button"
              tabIndex={0}
              aria-label="返回会话全局群岛视图"
              onClick={() => onRequestFocus?.('')}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  onRequestFocus?.('')
                }
              }}
            >
              <rect
                x={exitX}
                y={exitY}
                width={exitW}
                height={exitH}
                rx={exitH / 2}
                className="wm-sub-island-exit-bg"
              />
              <text
                x={exitX + exitW / 2}
                y={exitY + exitH / 2}
                textAnchor="middle"
                dominantBaseline="central"
                fontSize={9.5}
                className="wm-sub-island-exit-text"
                fontWeight={500}
              >
                ← 返回会话全局群岛
              </text>
            </g>
          ) : null}
        </>
      ) : (
        <>
          {checkNode}
          <g
            className="wm-sub-island-tag-wrap"
            role={interactive ? 'button' : undefined}
            tabIndex={interactive ? 0 : undefined}
            aria-label={interactive ? `聚焦子岛：${subIsland.title}` : undefined}
            onClick={handleClick}
            onKeyDown={
              interactive
                ? (event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      handleClick?.()
                    }
                  }
                : undefined
            }
          >
            <rect
              x={tagX}
              y={tagY}
              width={tagW}
              height={12}
              rx={3}
              className="wm-sub-island-tag-bg"
            />
            <text
              x={tagX + tagW / 2}
              y={tagY + 6}
              textAnchor="middle"
              dominantBaseline="central"
              fontSize={8.5}
              className="wm-sub-island-tag-text"
            >
              {tagText}
            </text>
          </g>
        </>
      )}
    </g>
  )
}

export function WorkMapTree({
  islands,
  sessionId,
  className,
  style,
  label,
  selectedCid,
  focusCid,
  highlightType,
  currentPlanTitle,
  onSelectNode,
  onFocusNode,
  onExpandArchive,
  dependencyBadges,
  focusedIslandId,
  focusBounds,
  focusPadding,
  onIslandFocusRequest,
  focusedSubIslandId,
  onSubIslandFocusRequest,
  planCompletion,
  onTogglePlanCompletion,
}: WorkMapTreeProps): ReactNode {
  // 筛选只调「视觉权重」：命中 = 高亮，其余 dim；null = 全亮（D17）
  const filter = highlightType ?? null

  // 子岛聚焦解析：
  const activeSubIsland = useMemo(() => {
    if (!focusedSubIslandId) return null
    for (const island of islands) {
      const hit = island.subIslands?.find((sub) => sub.id === focusedSubIslandId)
      if (hit) return hit
    }
    return null
  }, [islands, focusedSubIslandId])

  // 方案 A（横向群岛卡片流）：当会话岛包含子岛且未处于单子岛聚焦时，将几何投影为并列横向群岛。
  // 仅在单会话岛模式（如中央编辑区）下生效，多岛全览（TimerMapOverview）维持各岛全局 2D 排布不变。
  const processedIslands = useMemo(() => {
    return islands.map((isl) => {
      if (
        islands.length === 1 &&
        activeSubIsland === null &&
        isl.subIslands &&
        isl.subIslands.length > 0 &&
        isl.sessionId !== null
      ) {
        return layoutArchipelagoIsland(isl, currentPlanTitle)
      }
      return isl
    })
  }, [islands, activeSubIsland, currentPlanTitle])
  // 聚焦态（S4-3 / PXII-FEAT-NESTED-ISLAND）：
  // 1. 显式 focusBounds（若外部传入）
  // 2. 子岛聚焦 bounds（若 activeSubIsland 存在）
  // 3. 单岛聚焦（focusedIslandId 存在时）
  // 4. 全岛并集
  const target = useMemo(() => {
    if (focusBounds != null) return focusBounds
    if (activeSubIsland != null) {
      return subIslandVisualBounds(activeSubIsland, true)
    }
    return {
      minX: Math.min(...processedIslands.map((island) => islandVisualBounds(island).minX), Number.POSITIVE_INFINITY),
      minY: Math.min(...processedIslands.map((island) => islandVisualBounds(island).minY), Number.POSITIVE_INFINITY),
      maxX: Math.max(...processedIslands.map((island) => islandVisualBounds(island).maxX), Number.NEGATIVE_INFINITY),
      maxY: Math.max(...processedIslands.map((island) => islandVisualBounds(island).maxY), Number.NEGATIVE_INFINITY),
    }
  }, [focusBounds, activeSubIsland, processedIslands])

  const pad =
    focusBounds != null
      ? (focusPadding ?? 32)
      : activeSubIsland != null
        ? 24
        : focusedIslandId != null
          ? 32
          : PAD
  const width = Math.max(1, target.maxX - target.minX + pad * 2)
  const height = Math.max(1, target.maxY - target.minY + pad * 2)
  const viewBox = useAnimatedViewBox(
    processedIslands.length === 0
      ? '0 0 1 1'
      : `${target.minX - pad} ${target.minY - pad} ${width} ${height}`,
  )

  return (
    <svg
      className={className === undefined ? 'wm-tree' : `wm-tree ${className}`}
      viewBox={viewBox}
      style={style}
      preserveAspectRatio="xMidYMin meet"
      role="img"
      aria-label={label ?? '工作导图'}
    >
      {processedIslands.map((island) => {
        // 聚焦态（S4-3）：非聚焦岛 dim（纯 CSS opacity，DOM 结构不动）
        const dimmed = focusedIslandId != null && focusedIslandId !== island.rootId
        // 归档岛是虚拟卡片（无真实节点/连线），单独呈态；点击上抛「展开历史」
        if (island.isArchive === true) {
          return (
            <ArchiveCard key={island.rootId} island={island} onExpand={onExpandArchive} dimmed={dimmed} />
          )
        }
        const current = island.sessionId === sessionId
        // 命中判据只看 thoughtType；无类型节点（会话根 / 存量标题行）在筛选下同样 dim
        const dimById = new Map<string, boolean>()
        for (const node of island.nodes) {
          dimById.set(node.id, filter !== null && node.thoughtType !== filter)
        }
        // 子岛聚焦态（PXII-FEAT-NESTED-ISLAND）：
        // 若当前处于子岛聚焦，仅渲染包含该子岛的岛
        if (activeSubIsland !== null) {
          const containsActiveSub = island.subIslands?.some((s) => s.id === activeSubIsland.id) ?? false
          if (!containsActiveSub) return null
        }

        const renderedSubIslands =
          activeSubIsland !== null
            ? (island.subIslands?.filter((sub) => sub.id === activeSubIsland.id) ?? [])
            : (island.subIslands ?? [])

        const renderedLinks =
          activeSubIsland !== null ? activeSubIsland.links : island.links

        const renderedNodes =
          activeSubIsland !== null ? activeSubIsland.nodes : island.nodes

        // 已完成子岛的**根节点** id 集合：根节点带轻微完成绿意（分支与连线不动）
        const completedRootIds = new Set<string>()
        for (const sub of renderedSubIslands) {
          if (planCompletionOf(planCompletion, sub.title) === true) completedRootIds.add(sub.rootNode.id)
        }

        return (
          <g
            key={island.rootId}
            className={dimmed ? 'wm-island--dimmed' : undefined}
            data-testid={current ? 'wm-current-island' : undefined}
          >
            {/* 会话岛地标卡（仅在全局视图且有 sessionId 时呈现） */}
            {island.sessionId !== null && activeSubIsland === null ? (
              <IslandFrameCard
                island={island}
                isCurrent={current}
                interactive={onIslandFocusRequest !== undefined}
                onRequestFocus={onIslandFocusRequest}
              />
            ) : null}

            {/* 嵌套子岛地标卡：统一 map 结构保证 key={sub.id} 的 DOM 节点在聚焦切换时稳定复用 */}
            {renderedSubIslands.map((sub) => {
              const isCurrentPlan =
                current &&
                currentPlanTitle != null &&
                currentPlanTitle.trim() !== '' &&
                sub.title === currentPlanTitle.trim()
              const isSubFocused = activeSubIsland !== null && activeSubIsland.id === sub.id
              // 完成态按**子岛标题**匹配（`plans[].titleSnapshot` 与子岛标题同源）；
              // 未传 planCompletion → `undefined`（既不打勾也不变绿，小视图/总览零变化）
              const subPlanCompletion = planCompletionOf(planCompletion, sub.title)
              return (
                <SubIslandFrameCard
                  key={sub.id}
                  subIsland={sub}
                  isCurrentPlan={isCurrentPlan}
                  isFocused={isSubFocused}
                  dimmed={false}
                  interactive={onSubIslandFocusRequest !== undefined}
                  planCompletion={subPlanCompletion}
                  onToggleCompletion={
                    onTogglePlanCompletion === undefined || subPlanCompletion === undefined
                      ? undefined
                      : () => onTogglePlanCompletion(sub.title)
                  }
                  onRequestFocus={onSubIslandFocusRequest}
                />
              )
            })}

            {/* 连线：子岛聚焦时仅渲染子岛内部连线 */}
            {renderedLinks.map((link) => {
              const dimLink =
                filter !== null &&
                (dimById.get(link.fromId) ?? false) &&
                (dimById.get(link.toId) ?? false)
              return (
                <path
                  key={`${link.fromId}->${link.toId}`}
                  d={link.path}
                  className={dimLink ? 'wm-link wm-link--dim' : 'wm-link'}
                  data-dim={dimLink ? 'true' : undefined}
                />
              )
            })}

            {/* 节点：子岛聚焦时仅渲染子岛内部节点 */}
            {renderedNodes.map((node) => {
              const isCurrentPlan =
                current &&
                node.depth === 1 &&
                currentPlanTitle != null &&
                currentPlanTitle.trim() !== '' &&
                node.text === currentPlanTitle.trim()
              const dimmedNode = filter !== null && node.thoughtType !== filter
              return (
                <NodeBox
                  key={node.id}
                  node={node}
                  currentSession={
                    activeSubIsland === null &&
                    typeof sessionId === 'string' &&
                    sessionId !== '' &&
                    node.sessionId === sessionId
                  }
                  currentPlan={isCurrentPlan}
                  completed={completedRootIds.has(node.id)}
                  badge={
                    node.refId !== null ? (dependencyBadges?.get(node.refId) ?? null) : null
                  }
                  editable={onSelectNode !== undefined && current && !node.sessionNode}
                  selected={
                    onSelectNode !== undefined &&
                    current &&
                    node.cid !== null &&
                    node.cid === (selectedCid ?? null)
                  }
                  focused={
                    node.cid !== null &&
                    node.cid === (focusCid ?? null)
                  }
                  dimmed={dimmedNode}
                  highlighted={filter !== null && node.thoughtType === filter}
                  onSelect={onSelectNode}
                  onFocus={onFocusNode}
                />
              )
            })}
          </g>
        )
      })}
    </svg>
  )
}
