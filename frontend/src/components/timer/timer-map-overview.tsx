'use client'

/**
 * 结束态「**岛总览**」+ 类型图例 + 跨岛筛选（ADR-0008 D13 步 3-4b / D12 裁决 3 / D17）。
 *
 * ## 落点与形态
 * 结束态焦点区 **`SessionReview` 下方**（D12 裁决 3 原文"结束态 = 复盘区下方"），
 * 与运行态"环 + 编辑区"同型。数据来自页面读到的 `.mm.md` 原文。
 *
 * ## 与编辑区/小视图的关键差别：**全部 islands，不滤当前会话**
 * 运行态编辑区与右栏小视图都只渲染**当前会话岛**（`findSessionIslandLayout`）；
 * 结束态总览要回答"这次会话在图里的位置"——故 `islands={layout.islands}` 全渲染，
 * 当前会话岛仅用 `sessionId` 命中高亮（复用 `wm-box--session` 的"本次"标记）。
 *
 * ## 只读（红线 2）
 * 复盘不改图：不传 `onEdit`/`onQuickRecord`（D16 编辑入口仅运行态有），
 * 本组件不调任何写原语 —— 筛选只改 `highlightType`（**dim 不 hide**，D17）。
 *
 * fail-soft：无图 / 解析失败 → 占位（同端口/编辑区纪律）。
 */
import { useMemo, useState, type ReactNode } from 'react'

import { readWorkMapLayout } from '@/lib/work-map/island-layout'
import type { ThoughtType } from '@/lib/work-map/thought-types'

import { WorkMapLegend } from './work-map-legend'
import { WorkMapTree } from './work-map-tree'

export interface TimerMapOverviewProps {
  /** 结束会话所属 L3 的岛文件原文；null = 尚无导图 / 读取失败 */
  mapText: string | null
  /** 本次会话 id（其岛根呈"本次"高亮）；准备态主图无"本次"语义，传 null */
  sessionId: string | null
  /**
   * 标题后缀（渲染为 `工作导图 · <title>`）：结束态默认「岛总览」，
   * 准备态弹层传「主图」（ADR-0008 D18）。**只改文案，不改内容**。
   */
  title?: string
}

export function TimerMapOverview({
  mapText,
  sessionId,
  title = '岛总览',
}: TimerMapOverviewProps): ReactNode {
  const layout = useMemo(
    () => (mapText === null || mapText.trim() === '' ? null : readWorkMapLayout(mapText)),
    [mapText],
  )
  // 筛选状态在本组件内部（D13 步 3-4b）：单选一类或「全部」
  const [highlightType, setHighlightType] = useState<ThoughtType | null>(null)
  const islands = layout?.islands ?? []
  const nodeCount = islands.reduce((sum, island) => sum + island.nodes.length, 0)

  return (
    <div className="wm-overview" data-testid="timer-map-overview">
      <div className="wm-overview-hd">
        工作导图 · {title}
        {islands.length > 0 ? (
          <span className="wm-editor-count">
            {islands.length} 个岛 · {nodeCount} 项
          </span>
        ) : null}
      </div>

      {islands.length > 0 ? (
        <>
          <WorkMapLegend
            islands={islands}
            selected={highlightType}
            onSelect={setHighlightType}
          />
          <div className="wm-overview-canvas" data-testid="map-overview-canvas">
            <WorkMapTree
              islands={islands}
              sessionId={sessionId}
              highlightType={highlightType}
              label="工作导图 · 岛总览"
            />
          </div>
        </>
      ) : (
        <div
          className="wm-overview-canvas wm-overview-canvas--empty"
          data-testid="map-overview-empty"
        >
          这份导图还没有可总览的岛。
        </div>
      )}
    </div>
  )
}