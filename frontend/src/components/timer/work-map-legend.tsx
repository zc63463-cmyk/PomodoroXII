'use client'

/**
 * 思考类型**图例**（ADR-0008 D9 双编码 / D17）—— 5 类 ×（形状 + 颜色 + 中文标签 + 计数）。
 *
 * ## 为什么单独成件
 * 结束态岛总览要按类型筛选，**后续准备态主图也会用同一个图例**（D13 递增路径）——
 * 故做成无状态可复用件：选中值由调用方持有，本件只"报数 + 上抛点击"。
 *
 * ## 形状/颜色**同源**（不能另抄一份）
 * 形状几何直接复用 `work-map-tree.tsx` 导出的 `TypeShape`（同一份 SVG 几何），
 * 配色复用同一批 `.wm-shape--*` CSS 类 —— D9 要求"形状 + 颜色双重编码"（色盲可辨），
 * 树改了图例不改就会分叉，所以这里是**引用**而不是复制。
 *
 * 计数：前序扫传入 `islands` 的 `MapTreeNode.thoughtType`。
 */
import { useMemo, type ReactNode } from 'react'

import type { MapIslandLayout, MapTreeNode } from '@/lib/work-map/island-layout'
import {
  THOUGHT_TYPES,
  THOUGHT_TYPE_LABEL,
  type ThoughtType,
} from '@/lib/work-map/thought-types'

import { TypeShape } from './work-map-tree'

export interface WorkMapLegendProps {
  /** 计数来源（前序扫每岛的节点树） */
  islands: readonly MapIslandLayout[]
  /** 当前选中类型；`null` = 「全部」 */
  selected?: ThoughtType | null
  /** 点击某一类 / 「全部」→ 上抛（**单选**语义；不传则纯展示） */
  onSelect?: (type: ThoughtType | null) => void
}

export function WorkMapLegend({
  islands,
  selected = null,
  onSelect,
}: WorkMapLegendProps): ReactNode {
  const counts = useMemo(() => {
    const out = new Map<ThoughtType, number>()
    const walk = (node: MapTreeNode): void => {
      if (node.thoughtType !== null) {
        out.set(node.thoughtType, (out.get(node.thoughtType) ?? 0) + 1)
      }
      for (const child of node.children) walk(child)
    }
    for (const island of islands) walk(island.tree)
    return out
  }, [islands])

  const total = THOUGHT_TYPES.reduce((sum, type) => sum + (counts.get(type) ?? 0), 0)

  return (
    <div
      className="wm-legend"
      data-testid="map-legend"
      role="group"
      aria-label="思考类型图例（点击筛选）"
    >
      <button
        type="button"
        className="wm-legend-item"
        data-testid="map-legend-all"
        aria-pressed={selected === null}
        onClick={() => onSelect?.(null)}
      >
        <span className="wm-legend-label">全部</span>
        <span className="wm-legend-count">{total}</span>
      </button>
      {THOUGHT_TYPES.map((type) => (
        <button
          key={type}
          type="button"
          className="wm-legend-item"
          data-thought={type}
          data-testid={`map-legend-${type}`}
          aria-pressed={selected === type}
          onClick={() => onSelect?.(type)}
        >
          <svg className="wm-legend-shape" viewBox="0 0 18 18" aria-hidden="true">
            <TypeShape x={9} y={9} type={type} />
          </svg>
          <span className="wm-legend-label">{THOUGHT_TYPE_LABEL[type]}</span>
          <span className="wm-legend-count">{counts.get(type) ?? 0}</span>
        </button>
      ))}
    </div>
  )
}