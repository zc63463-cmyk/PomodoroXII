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
 *
 * ## 视觉（D9 形状 + 颜色双重编码）
 * 会话节点 = 高亮框（当前会话岛根）；思考节点 = 形状（●洞察 ▲问题 ◆决策 ○复盘 □待办）+
 * 类型描边色；无类型节点 = 中性小圆。文字用与度量同一把尺子截断（`fitTextToBox`）。
 * 极简态（沉浸）由外层 `[data-minimal='true']` 派生 CSS：**只隐文字，几何不变**
 * （零布局抖动）。
 */
import type { ReactNode } from 'react'

import { fitTextToBox, type MapIslandLayout, type MapTreeNode } from '@/lib/work-map/island-layout'

export interface WorkMapTreeProps {
  /** 要渲染的岛（1..N）；几何来自 `readWorkMapLayout` */
  islands: readonly MapIslandLayout[]
  /** 当前会话 id（其岛根呈"当前会话"高亮） */
  sessionId?: string | null
  className?: string
  /** 无障碍名（不同容器可给不同描述） */
  label?: string
}

const PAD = 12

function unionBounds(islands: readonly MapIslandLayout[]): {
  minX: number
  minY: number
  maxX: number
  maxY: number
} {
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const island of islands) {
    minX = Math.min(minX, island.bounds.minX)
    minY = Math.min(minY, island.bounds.minY)
    maxX = Math.max(maxX, island.bounds.maxX)
    maxY = Math.max(maxY, island.bounds.maxY)
  }
  if (!Number.isFinite(minX)) return { minX: 0, minY: 0, maxX: 1, maxY: 1 }
  return { minX, minY, maxX, maxY }
}

/** 思考类型形状（9px 视口，位于节点盒左侧 10px 处）。 */
function TypeShape({ x, y, type }: { x: number; y: number; type: NonNullable<MapTreeNode['thoughtType']> }): ReactNode {
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

function NodeBox({ node, isSession }: { node: MapTreeNode; isSession: boolean }): ReactNode {
  const label = fitTextToBox(node.text === '' ? '（无标题）' : node.text, node.box.w, node.depth)
  const textX = node.thoughtType !== null ? 24 : 12
  return (
    <g
      transform={`translate(${node.box.x} ${node.box.y})`}
      className="wm-node"
      data-testid={isSession ? 'wm-session-node' : undefined}
      data-thought={node.thoughtType ?? undefined}
      data-session={isSession ? 'true' : 'false'}
    >
      <rect
        width={node.box.w}
        height={node.box.h}
        rx={7}
        className={isSession ? 'wm-box wm-box--session' : 'wm-box'}
      />
      {node.thoughtType !== null ? (
        <TypeShape x={12} y={node.box.h / 2} type={node.thoughtType} />
      ) : (
        <circle cx={12} cy={node.box.h / 2} r={3} className="wm-shape wm-shape--plain" />
      )}
      {/* 字号与度量同一档（root/branch/leaf）—— 截断宽度才不会与绘制宽度分叉 */}
      <text
        x={textX}
        y={node.box.h / 2}
        dy="0.32em"
        fontSize={node.depth === 0 ? 12.5 : node.depth === 1 ? 12 : 11}
        className="wm-text"
      >
        {label}
      </text>
    </g>
  )
}

export function WorkMapTree({ islands, sessionId, className, label }: WorkMapTreeProps): ReactNode {
  const bounds = unionBounds(islands)
  const width = Math.max(1, bounds.maxX - bounds.minX + PAD * 2)
  const height = Math.max(1, bounds.maxY - bounds.minY + PAD * 2)
  const viewBox = `${bounds.minX - PAD} ${bounds.minY - PAD} ${width} ${height}`

  return (
    <svg
      className={className === undefined ? 'wm-tree' : `wm-tree ${className}`}
      viewBox={viewBox}
      preserveAspectRatio="xMidYMin meet"
      role="img"
      aria-label={label ?? '工作导图'}
    >
      {islands.map((island) => (
        <g key={island.rootId} data-testid={island.sessionId === sessionId ? 'wm-current-island' : undefined}>
          {island.links.map((link) => (
            <path key={`${link.fromId}->${link.toId}`} d={link.path} className="wm-link" />
          ))}
          {island.nodes.map((node) => (
            <NodeBox key={node.id} node={node} isSession={node.sessionId === sessionId} />
          ))}
        </g>
      ))}
    </svg>
  )
}
