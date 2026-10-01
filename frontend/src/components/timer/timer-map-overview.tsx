'use client'

/**
 * 结束态「**岛总览**」+ 类型图例 + 跨岛筛选 + 近 N 展开/归档（ADR-0008 D13 步 3-4b / D12 裁决 3 / D17 / D19-a）。
 *
 * ## 落点与形态
 * 结束态焦点区 **`SessionReview` 下方**（D12 裁决 3 原文"结束态 = 复盘区下方"），
 * 与运行态"环 + 编辑区"同型。数据来自页面读到的 `.mm.md` 原文。
 *
 * ## 近 N 展开 + 历史归档岛（D19-a，2026-10-01）
 * 默认只展开**最新 5 个会话岛**，更早的历史会话聚合为虚拟归档岛（渲染成收拢卡片）；
 * 顶部控制栏（图例右侧）提供 `[近 5 岛 | 全部展开]` 分段切换（`expandAll` 局部状态，
 * 默认近 5），**点击归档岛卡片等同切到「全部展开」**。切片是纯视图层投影，
 * 准备态主图弹层（`WorkMapPreviewOverlay` 复用本组件）与结束态全览默认同口径。
 *
 * ## 与编辑区/小视图的关键差别：**全部 islands，不滤当前会话**
 * 运行态编辑区与右栏小视图都只渲染**当前会话岛**（`findSessionIslandLayout`）；
 * 结束态总览要回答"这次会话在图里的位置"——故 `islands` 全渲染，
 * 当前会话岛仅用 `sessionId` 命中高亮（复用 `wm-box--session` 的"本次"标记）。
 *
 * ## 只读（红线 2）
 * 复盘不改图：不传 `onEdit`/`onQuickRecord`（D16 编辑入口仅运行态有），
 * 本组件不调任何写原语 —— 筛选只改 `highlightType`（**dim 不 hide**，D17）。
 *
 * fail-soft：无图 / 解析失败 → 占位（同端口/编辑区纪律）。
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react'

import {
  readWorkMapLayout,
  WORK_MAP_DEFAULT_ACTIVE_LIMIT,
} from '@/lib/work-map/island-layout'
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
  // 近 N 展开（D19-a）：默认近 5；「全部展开」/ 点归档卡 → expandAll
  const [expandAll, setExpandAll] = useState(false)
  const layout = useMemo(
    () =>
      mapText === null || mapText.trim() === ''
        ? null
        : readWorkMapLayout(mapText, { expandAll }),
    [mapText, expandAll],
  )
  // 筛选状态在本组件内部（D13 步 3-4b）：单选一类或「全部」
  const [highlightType, setHighlightType] = useState<ThoughtType | null>(null)
  // 聚焦岛（S4-3 fitToIsland）：双击地标卡 / 点击角标进入，Esc / 退出钮返回全览
  const [focusedIslandId, setFocusedIslandId] = useState<string | null>(null)
  const islands = layout?.islands ?? []
  // 计数只算真实岛（根岛 + 活跃会话岛）；归档岛是虚拟卡片，其容量单列展示
  const realIslands = islands.filter((island) => island.isArchive !== true)
  const archive = islands.find((island) => island.isArchive === true)
  const nodeCount = realIslands.reduce((sum, island) => sum + island.nodes.length, 0)
  const focusedIsland =
    focusedIslandId === null
      ? null
      : (islands.find((island) => island.rootId === focusedIslandId) ?? null)

  // 聚焦岛不在当前数据里（切「全部展开」会重解析、rootId 重建）→ 自动退出聚焦
  useEffect(() => {
    if (focusedIslandId !== null && focusedIsland === null) setFocusedIslandId(null)
  }, [focusedIslandId, focusedIsland])

  // Escape 退出聚焦，还原近 5 岛全览视角（D19-c）
  useEffect(() => {
    if (focusedIsland === null) return undefined
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setFocusedIslandId(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [focusedIsland])

  return (
    <div className="wm-overview" data-testid="timer-map-overview">
      <div className="wm-overview-hd">
        工作导图 · {title}
        {realIslands.length > 0 ? (
          <>
            <span className="wm-editor-count">
              {realIslands.length} 个岛 · {nodeCount} 项
            </span>
            {archive !== undefined ? (
              <span className="wm-editor-count" data-testid="map-archive-count">
                归档 {archive.archivedCount ?? 0} 次
              </span>
            ) : null}
          </>
        ) : null}
      </div>

      {islands.length > 0 ? (
        <>
          <div className="wm-overview-controls">
            <WorkMapLegend
              islands={realIslands}
              selected={highlightType}
              onSelect={setHighlightType}
            />
            <div className="wm-view-toggle" role="group" aria-label="岛展开范围">
              <button
                type="button"
                className="wm-view-btn"
                data-testid="map-view-near"
                aria-pressed={!expandAll}
                onClick={() => setExpandAll(false)}
              >
                近 {WORK_MAP_DEFAULT_ACTIVE_LIMIT} 岛
              </button>
              <button
                type="button"
                className="wm-view-btn"
                data-testid="map-view-all"
                aria-pressed={expandAll}
                onClick={() => setExpandAll(true)}
              >
                全部展开
              </button>
            </div>
            {focusedIsland !== null ? (
              <div className="wm-focus-bar" data-testid="map-focus-bar">
                <button
                  type="button"
                  className="wm-view-btn wm-focus-exit"
                  data-testid="map-focus-exit"
                  onClick={() => setFocusedIslandId(null)}
                >
                  ← 退出聚焦
                </button>
                <span className="wm-focus-label" data-testid="map-focus-label">
                  正在查看：{focusedIsland.tree.text}
                </span>
              </div>
            ) : null}
          </div>
          <div className="wm-overview-canvas" data-testid="map-overview-canvas">
            <WorkMapTree
              islands={islands}
              sessionId={sessionId}
              highlightType={highlightType}
              onExpandArchive={() => setExpandAll(true)}
              focusedIslandId={focusedIslandId}
              focusBounds={focusedIsland !== null ? focusedIsland.bounds : null}
              onIslandFocusRequest={setFocusedIslandId}
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