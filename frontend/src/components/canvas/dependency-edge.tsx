'use client'

import { memo } from 'react'
import {
  BaseEdge,
  EdgeLabelRenderer,
  getSmoothStepPath,
  useInternalNode,
  type EdgeProps,
  type Position,
} from '@xyflow/react'

import type { DependencyEdgeData } from '@/lib/canvas/graph-adapter'
import {
  anchorPoint,
  findHorizontalChannelY,
  orthogonalChannelPath,
  selectSides,
  type RoutingRect,
} from '@/lib/canvas/edge-routing'

/**
 * 依赖关系的定向正交边（draw.io 式路由的渲染层）。
 *
 * ★ 锚点比例由适配层按「节点 × 候选侧」预先分布；**选侧按实时几何重算**
 *   （useInternalNode 取实时矩形）——节点被拖动后几何已变，侧别必须跟随，
 *   否则会绕行错位。
 * ★ 避障：水平主干若穿过中间节点，通道整体平移到最近空隙
 *   （findHorizontalChannelY）；障碍列表由画布经 data.obstaclesFor 注入。
 * ★ 交互：常驻小 ✕ 内联解除依赖 —— 操作闭环留在图上，不必切回列表。
 */

function measuredRect(node: NonNullable<ReturnType<typeof useInternalNode>>): RoutingRect {
  return {
    x: node.internals.positionAbsolute.x,
    y: node.internals.positionAbsolute.y,
    width: node.measured.width ?? 150,
    height: node.measured.height ?? 42,
  }
}

function DependencyEdgeComponent({
  id,
  source,
  target,
  data,
  markerEnd,
  style,
}: EdgeProps) {
  const sourceNode = useInternalNode(source)
  const targetNode = useInternalNode(target)
  if (!sourceNode || !targetNode || !data) return null

  const edgeData = data as DependencyEdgeData
  const sourceRect = measuredRect(sourceNode)
  const targetRect = measuredRect(targetNode)

  // ★ 选侧按实时几何重算：节点被拖动后几何已变，侧别必须跟随。
  const liveSides = selectSides(sourceRect, targetRect)
  const sourceAnchor = anchorPoint(sourceRect, {
    side: liveSides.sourceSide,
    fraction: edgeData.sourceFractions?.[liveSides.sourceSide] ?? 0.5,
  })
  const targetAnchor = anchorPoint(targetRect, {
    side: liveSides.targetSide,
    fraction: edgeData.targetFractions?.[liveSides.targetSide] ?? 0.5,
  })

  const horizontalRoute = liveSides.sourceSide !== 'top' && liveSides.sourceSide !== 'bottom'
    && liveSides.targetSide !== 'top' && liveSides.targetSide !== 'bottom'

  let path: string
  let labelX: number
  let labelY: number
  if (horizontalRoute) {
    const obstacles = edgeData.obstaclesFor?.(source, target) ?? []
    const channelY = findHorizontalChannelY(
      sourceAnchor.x, sourceAnchor.y, targetAnchor.x, targetAnchor.y, obstacles,
    )
    const base = (sourceAnchor.y + targetAnchor.y) / 2
    if (channelY !== base) {
      // 需要绕行：走自绘的圆角正交通道。
      path = orthogonalChannelPath(
        sourceAnchor.x, sourceAnchor.y, targetAnchor.x, targetAnchor.y, channelY,
      )
      labelX = (sourceAnchor.x + targetAnchor.x) / 2
      labelY = channelY
    } else {
      const [smoothPath, lx, ly] = getSmoothStepPath({
        sourceX: sourceAnchor.x,
        sourceY: sourceAnchor.y,
        sourcePosition: liveSides.sourceSide as Position,
        targetX: targetAnchor.x,
        targetY: targetAnchor.y,
        targetPosition: liveSides.targetSide as Position,
        borderRadius: 8,
      })
      path = smoothPath
      labelX = lx
      labelY = ly
    }
  } else {
    const [smoothPath, lx, ly] = getSmoothStepPath({
      sourceX: sourceAnchor.x,
      sourceY: sourceAnchor.y,
      sourcePosition: liveSides.sourceSide as Position,
      targetX: targetAnchor.x,
      targetY: targetAnchor.y,
      targetPosition: liveSides.targetSide as Position,
      borderRadius: 8,
    })
    path = smoothPath
    labelX = lx
    labelY = ly
  }

  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} style={style} />
      {/* ★ D2（ADR-0004）：broken 边（上游已取消且未确认）的**只读**角标 ——
          画布零 I/O，这里不提供任何写动作（确认在关系卡片里）。 */}
      {edgeData.broken ? (
        <EdgeLabelRenderer>
          <span
            data-broken-edge-badge={id}
            title="上游已取消且未确认 —— 请在关系卡片中确认「不再需要」或解除依赖"
            className="nodrag nopan pointer-events-none absolute rounded-full border border-amber-600/70 bg-background px-1.5 py-0.5 text-[10px] leading-none text-amber-700"
            style={{
              transform: 'translate(-50%, -170%)',
              left: labelX,
              top: labelY,
            }}
          >
            需解决
          </span>
        </EdgeLabelRenderer>
      ) : null}
      {edgeData.onRemoveEdge ? (
        <EdgeLabelRenderer>
          <button
            type="button"
            aria-label="解除这条依赖"
            data-remove-relation-edge={id}
            className="nodrag nopan absolute flex h-4 w-4 items-center justify-center rounded-full border bg-background text-[10px] leading-none text-muted-foreground opacity-40 hover:border-destructive hover:text-destructive hover:opacity-100"
            style={{
              transform: 'translate(-50%, -50%)',
              left: labelX,
              top: labelY,
              pointerEvents: 'all',
            }}
            onClick={(event) => {
              event.stopPropagation()
              edgeData.onRemoveEdge?.({ from: source, to: target })
            }}
          >
            ✕
          </button>
        </EdgeLabelRenderer>
      ) : null}
    </>
  )
}

export const DependencyEdge = memo(DependencyEdgeComponent)
