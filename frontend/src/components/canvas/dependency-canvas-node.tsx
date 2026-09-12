'use client'

import { createElement, memo, type ReactNode } from 'react'
import { Handle, Position } from '@xyflow/react'
import type { NodeProps } from '@xyflow/react'

import type { DependencyCanvasNodeData } from '@/lib/canvas/graph-adapter'
import { GRAPH_NODE_WIDTH } from '@/lib/task-space/dependency-graph'

/**
 * 依赖画布的任务节点（信息密度版）：状态色条 · ⚡N 解锁徽标 · 投入进度条 ·
 * 🔒 阻塞 · ⟳ 环。左右隐藏连接桩，React Flow 按几何就近选桩。
 *
 * ★ 宽度必须锁定为布局常量：布局 / 锚点分布 / 避障全按 GRAPH_NODE_WIDTH
 *   计算，节点若随内容自动变宽（长标题），自动布局下相邻列节点会重叠。
 */

const STATUS_COLORS: Record<string, string> = {
  completed: '#22c55e',
  cancelled: '#9ca3af',
  in_progress: '#3b82f6',
  waiting: '#f59e0b',
}

function DependencyCanvasNodeComponent({ data }: NodeProps): ReactNode {
  const node = data as DependencyCanvasNodeData
  const border = node.cyclic ? '#dc2626' : node.isFocus ? '#2563eb' : '#94a3b8'
  const background = node.isFocus ? '#dbeafe' : node.blocked ? '#fff7ed' : '#ffffff'
  const strip = node.statusCategory ? STATUS_COLORS[node.statusCategory] ?? '#a78bfa' : null
  const estimateUpper = node.effortEstimateUpperSeconds ?? null
  const actual = node.effortActualSeconds ?? 0
  const effortPct = estimateUpper != null && estimateUpper > 0
    ? Math.min(100, Math.round((actual / estimateUpper) * 100))
    : null

  return createElement(
    'div',
    {
      'data-dependency-node': true,
      'data-node-cyclic': node.cyclic ? 'true' : 'false',
      className: 'relative overflow-hidden rounded-lg border py-1 pl-2.5 pr-2 shadow-sm',
      style: {
        background,
        borderColor: border,
        borderWidth: node.isFocus ? 2 : 1,
        width: GRAPH_NODE_WIDTH,
      },
    },
    strip
      ? createElement('span', {
          'aria-hidden': true,
          'data-status-strip': node.statusCategory,
          className: 'absolute inset-y-0 left-0 w-1',
          style: { background: strip },
        })
      : null,
    createElement(Handle, { type: 'target', position: Position.Left, style: { width: 6, height: 6, opacity: 0 } }),
    createElement(Handle, { type: 'source', position: Position.Right, style: { width: 6, height: 6, opacity: 0 } }),
    createElement(
      'div',
      { className: 'flex items-center justify-between gap-1' },
      createElement(
        'span',
        { className: 'truncate text-[10px] text-muted-foreground' },
        `${node.cyclic ? '⟳ ' : ''}${node.blocked ? '🔒 ' : ''}${node.code}`,
      ),
      node.unlocks >= 2
        ? createElement(
            'span',
            {
              'data-unlocks-badge': true,
              title: `完成后沿下游可解锁 ${node.unlocks} 个任务`,
              className: 'shrink-0 rounded-full border px-1 text-[9px] text-amber-600',
            },
            `⚡${node.unlocks}`,
          )
        : null,
    ),
    // 宽度已锁定 + truncate：超长标题由 CSS 省略号处理，不再手动截字
    //（手动 slice 反而在宽度富余时白白丢字）。
    createElement('div', { className: 'truncate text-xs' }, node.title),
    effortPct !== null
      ? createElement(
          'div',
          {
            'data-effort-bar': String(effortPct),
            title: `投入 ${actual}s / 估算上限 ${estimateUpper}s`,
            className: 'mt-1 h-0.5 w-full overflow-hidden rounded bg-muted',
          },
          createElement('div', {
            className: 'h-full rounded',
            style: { width: `${effortPct}%`, background: effortPct >= 100 ? '#22c55e' : '#3b82f6' },
          }),
        )
      : null,
  )
}

export const DependencyCanvasNode = memo(DependencyCanvasNodeComponent)
