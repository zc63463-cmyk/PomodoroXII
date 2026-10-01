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
import type { ThoughtType } from '@/lib/work-map/thought-types'

export interface WorkMapTreeProps {
  /** 要渲染的岛（1..N）；几何来自 `readWorkMapLayout` */
  islands: readonly MapIslandLayout[]
  /** 当前会话 id（其岛根呈"当前会话"高亮） */
  sessionId?: string | null
  className?: string
  /** 无障碍名（不同容器可给不同描述） */
  label?: string
  /** 当前选中节点的 cid（编辑区选中态；只影响视觉环） */
  selectedCid?: string | null
  /**
   * 跨岛按类型筛选（D13 步 3-4b）：命中类型的节点满 opacity + 描边环，其余 **dim**
   * （`opacity` 压低，**不隐藏** —— 隐藏会拆断树结构，见 ADR-0008 D17）；
   * 连线两端都 dim 才 dim。`null` / 缺省 = 全亮。
   */
  highlightType?: ThoughtType | null
  /**
   * 点击**可编辑节点**（属当前会话岛、`cid !== null`、非会话节点）→ 上抛 cid。
   * 不给则整树**只读**（右栏小视图即如此）——只读节点点击无效、但 hover 有「只读」提示。
   */
  onSelectNode?: (cid: string) => void
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
  isSession,
  editable,
  selected,
  dimmed,
  highlighted,
  onSelect,
}: {
  node: MapTreeNode
  isSession: boolean
  editable: boolean
  selected: boolean
  /** 跨岛筛选：非命中类型 → dim（**只调视觉权重、不隐藏**，D17） */
  dimmed: boolean
  /** 跨岛筛选：命中类型 → 满 opacity + 描边环 */
  highlighted: boolean
  onSelect?: (cid: string) => void
}): ReactNode {
  const label = fitTextToBox(node.text === '' ? '（无标题）' : node.text, node.box.w, node.depth)
  const textX = node.thoughtType !== null ? 24 : 12
  // 可编辑 = 属当前会话岛 + 有 cid + 非会话节点（D16-a）；只读节点不给入口
  const editableCid = editable && node.cid !== null ? node.cid : null
  const activate = editableCid !== null ? (): void => onSelect?.(editableCid) : undefined
  return (
    <g
      transform={`translate(${node.box.x} ${node.box.y})`}
      className={[
        'wm-node',
        selected ? 'wm-node--selected' : '',
        dimmed ? 'wm-node--dim' : '',
        highlighted ? 'wm-node--hl' : '',
      ].filter((token) => token !== '').join(' ')}
      data-testid={isSession ? 'wm-session-node' : undefined}
      data-thought={node.thoughtType ?? undefined}
      data-session={isSession ? 'true' : 'false'}
      data-cid={editableCid ?? undefined}
      data-comment={node.comment !== null ? 'true' : undefined}
      data-readonly={editableCid === null ? 'true' : undefined}
      data-selected={selected ? 'true' : undefined}
      data-dim={dimmed ? 'true' : undefined}
      data-highlight={highlighted ? 'true' : undefined}
      role={editableCid !== null ? 'button' : undefined}
      tabIndex={editableCid !== null ? 0 : undefined}
      aria-label={editableCid !== null ? `编辑节点：${node.text === '' ? '（无标题）' : node.text}` : undefined}
      onClick={activate}
      onKeyDown={
        editableCid !== null
          ? (event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                onSelect?.(editableCid)
              }
            }
          : undefined
      }
    >
      {/* 只读节点的 hover 提示（SVG 原生 tooltip）——点击无效但原因可见 */}
      {editableCid === null ? (
        <title>{isSession ? '会话节点（只读）' : '存量节点（无 cid，只读）'}</title>
      ) : null}
      <rect
        width={node.box.w}
        height={node.box.h}
        rx={7}
        className={
          selected ? 'wm-box wm-box--selected' : isSession ? 'wm-box wm-box--session' : 'wm-box'
        }
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
      {/* 带注释的节点：右上角小圆点（D13 步 3-2 §3.5） */}
      {node.comment !== null ? (
        <circle cx={node.box.w - 6} cy={6} r={3.5} className="wm-comment-dot" />
      ) : null}
    </g>
  )
}

export function WorkMapTree({
  islands,
  sessionId,
  className,
  label,
  selectedCid,
  highlightType,
  onSelectNode,
}: WorkMapTreeProps): ReactNode {
  const bounds = unionBounds(islands)
  // 筛选只调「视觉权重」：命中 = 高亮，其余 dim；null = 全亮（D17）
  const filter = highlightType ?? null
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
      {islands.map((island) => {
        const current = island.sessionId === sessionId
        // 命中判据只看 thoughtType；无类型节点（会话根 / 存量标题行）在筛选下同样 dim
        const dimById = new Map<string, boolean>()
        for (const node of island.nodes) {
          dimById.set(node.id, filter !== null && node.thoughtType !== filter)
        }
        return (
          <g key={island.rootId} data-testid={current ? 'wm-current-island' : undefined}>
            {island.links.map((link) => {
              // 两端都 dim 才 dim：一端亮则线亮，树结构不被筛选打散（D17）
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
            {island.nodes.map((node) => (
              <NodeBox
                key={node.id}
                node={node}
                isSession={node.sessionId === sessionId}
                // 可编辑面只在「当前会话岛」：其它岛/无 cid/会话节点一律只读（D16-a）
                editable={onSelectNode !== undefined && current && !node.sessionNode}
                selected={
                  onSelectNode !== undefined &&
                  current &&
                  node.cid !== null &&
                  node.cid === (selectedCid ?? null)
                }
                dimmed={dimById.get(node.id) ?? false}
                highlighted={filter !== null && node.thoughtType === filter}
                onSelect={onSelectNode}
              />
            ))}
          </g>
        )
      })}
    </svg>
  )
}
