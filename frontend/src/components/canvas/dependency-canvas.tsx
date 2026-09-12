'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  applyNodeChanges,
} from '@xyflow/react'
// ★ 缺了这行，画布就是截图里的惨状：节点无定位样式（不可见）、MiniMap 黑块。
import '@xyflow/react/dist/style.css'

import { DependencyCanvasNode } from '@/components/canvas/dependency-canvas-node'
import { DependencyEdge } from '@/components/canvas/dependency-edge'
import type { DependencyCanvasNode as DependencyCanvasNodeType } from '@/lib/canvas/graph-adapter'
import { toCanvasGraph } from '@/lib/canvas/graph-adapter'
import {
  clearCanvasLayout,
  loadCanvasLayout,
  saveCanvasLayout,
} from '@/lib/canvas/layout-storage'
import type { ResolvedCanvasItem } from '@/lib/canvas/graph-adapter'
import type { DependencyGraph } from '@/lib/task-space/dependency-graph'

export interface DependencyCanvasProps {
  graph: DependencyGraph
  /** null = 全项目视图（无焦点高亮）。 */
  focusId: string | null
  /** 布局持久化键（必须包含方向/范围，如 `deps.<id>.LR.neighborhood`）。 */
  layoutKey?: string | null
  /** LR（上游在左，默认）或 TB（上游在上）。 */
  direction?: 'LR' | 'TB'
  /** 点击连线上的 ✕ 解除依赖（不传则不渲染解除按钮）。 */
  onRemoveEdge?: (input: { from: string; to: string }) => void
  /** 节点解析：状态类目与投入，用于节点信息密度。 */
  resolve?: (id: string) => ResolvedCanvasItem | undefined
  onSelectNode?: (workItemId: string) => void
  /**
   * 视口裁剪（只渲染可见节点）。默认关闭：个人量级的图不需要，
   * 而且它在 jsdom/零尺寸容器下不渲染任何节点，测试无法断言。
   * 图超过数百节点时再打开。
   */
  onlyRenderVisibleElements?: boolean
}

const nodeTypes = { workItem: DependencyCanvasNode }
const edgeTypes = { dependency: DependencyEdge }

/**
 * 依赖关系自由画布。
 *
 * ★ 能力：拖拽微调（位置持久化）、MiniMap 全局视图、滚轮/控件缩放。
 * ★ 数据仍是只读的依赖域投影 —— 画布改的是**布局**，永远不改关系事实；
 *   关系的增删仍在列表视图（依赖必须显式建立）。
 */
export function DependencyCanvas({
  graph,
  focusId,
  layoutKey = null,
  direction = 'LR',
  onRemoveEdge,
  resolve,
  onSelectNode,
  onlyRenderVisibleElements = false,
}: DependencyCanvasProps) {
  const [resetSeq, setResetSeq] = useState(0)
  // ★ 回调经 ref 委托：调用方（关系卡）的重渲染会传进新函数身份
  //  （如「添加依赖」搜索框每敲一个字），若直接进依赖就会把整张图
  //  （布局 + localStorage + 锚点分布 + 全部边对象）无谓重建一遍。
  //  ref 永远指向最新回调，useMemo 依赖只留真正影响图数据的项。
  const callbacksRef = useRef({ onRemoveEdge, resolve })
  callbacksRef.current = { onRemoveEdge, resolve }
  const canvasGraph = useMemo(
    () => toCanvasGraph(graph, focusId, layoutKey, {
      direction,
      onRemoveEdge: (input) => callbacksRef.current.onRemoveEdge?.(input),
      resolve: (id) => callbacksRef.current.resolve?.(id),
    }),
    [graph, focusId, layoutKey, direction, resetSeq],
  )
  const [nodes, setNodes] = useState<DependencyCanvasNodeType[]>(canvasGraph.nodes)

  // 焦点/图变化（切换当前项）时重建画布节点；已保存的手动位置优先。
  useEffect(() => {
    setNodes(canvasGraph.nodes)
  }, [canvasGraph.nodes])

  const resetLayout = useCallback(() => {
    if (layoutKey) clearCanvasLayout(layoutKey)
    setResetSeq((current) => current + 1)
  }, [layoutKey])

  // 连线避障的障碍列表：来自当前画布节点的实时矩形（不含本边两端）。
  // ★ 节点矩形经 ref 读取：拖拽每帧都会 setNodes，若把 nodes 放进依赖，
  //   全部边对象每帧重建、边组件 memo 全部失效。障碍闭包保持稳定身份，
  //   查询时才读最新位置 —— 边对象只随图数据变化，拖拽零额外渲染。
  const nodesRef = useRef(nodes)
  nodesRef.current = nodes
  const obstaclesFor = useCallback((sourceId: string, targetId: string) => nodesRef.current
    .filter((node) => node.id !== sourceId && node.id !== targetId)
    .map((node) => ({
      x: node.position.x,
      y: node.position.y,
      width: node.measured?.width ?? 150,
      height: node.measured?.height ?? 42,
    })), [])
  const edgesWithObstacles = useMemo(
    () => canvasGraph.edges.map((edge) => ({
      ...edge,
      data: { ...edge.data, obstaclesFor },
    })),
    [canvasGraph.edges, obstaclesFor],
  )

  const onNodesChange = useCallback(
    (changes: Parameters<typeof applyNodeChanges<DependencyCanvasNodeType>>[0]) => {
      setNodes((current) => applyNodeChanges<DependencyCanvasNodeType>(changes, current))
    },
    [],
  )

  const persistPositions = useCallback(() => {
    if (!layoutKey) return
    const positions: Record<string, { x: number; y: number }> = {}
    for (const node of nodes) positions[node.id] = node.position
    saveCanvasLayout(layoutKey, positions)
  }, [layoutKey, nodes])

  const onNodeClick = useCallback((_: unknown, node: DependencyCanvasNodeType) => {
    if (node.id !== focusId) onSelectNode?.(node.id)
  }, [focusId, onSelectNode])

  const miniMapNodeColor = useCallback(
    (node: DependencyCanvasNodeType) => (node.data.isFocus ? '#2563eb' : node.data.blocked ? '#f97316' : '#cbd5e1'),
    [],
  )

  return (
    <div className="grid gap-1" data-dependency-canvas-wrap>
      <div data-dependency-canvas className="relative h-72 overflow-hidden rounded-md border">
      <button
        type="button"
        data-canvas-reset-layout
        title="清除手动微调，恢复自动布局"
        onClick={resetLayout}
        className="absolute left-2 top-2 z-10 rounded border bg-background px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-muted"
      >
        重置布局
      </button>
      <ReactFlow<DependencyCanvasNodeType>
        // ★ key = 布局键：fitView 只在挂载时生效。切换方向（LR↔TB）、
        //   范围（邻域↔全图）或选中项后坐标系完全不同，不重挂载的话
        //   视口还停在旧位置，新图可能整个在视野外。图数据变化（增删边）
        //   不改 key —— 不会打断当前视图。
        key={layoutKey ?? 'dependency-canvas'}
        nodes={nodes}
        edges={edgesWithObstacles}
        nodeTypes={nodeTypes as never}
        edgeTypes={edgeTypes as never}
        onNodesChange={onNodesChange}
        onNodeClick={onNodeClick}
        onNodeDragStop={persistPositions}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        minZoom={0.4}
        maxZoom={1.6}
        onlyRenderVisibleElements={onlyRenderVisibleElements}
        proOptions={{ hideAttribution: false }}
        nodesDraggable
        edgesFocusable={false}
        deleteKeyCode={null}
      >
        <Background gap={16} size={1} />
        <MiniMap pannable zoomable nodeColor={miniMapNodeColor} />
        <Controls showInteractive={false} />
      </ReactFlow>
      </div>
      <p className="text-xs text-muted-foreground">
        箭头指向被依赖的上游（我等的一方） · 红色虚线 = 依赖环 · 橙色虚线/「需解决」= 上游已取消待确认 · 🔒 = 有未完成上游 · ⚡N = 完成后可解锁 N 项
      </p>
    </div>
  )
}

/** 供测试与「重置布局」入口使用：读取某键下已保存的位置。 */
export function readSavedLayout(key: string | null): ReturnType<typeof loadCanvasLayout> {
  return key ? loadCanvasLayout(key) : null
}
