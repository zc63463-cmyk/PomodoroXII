'use client'

/**
 * 右栏导图**小视图**（运行态伴奏列）—— ADR-0008 D15（原「端口」的职责拆分后的一半）。
 *
 * ## 定位（在 D15 的新分工里）
 * - **中央编辑区**（`TimerMapEditor`）= 看全 + 快速记录（沉浸时保留）
 * - **本组件（小视图）**= 缩略 + 定位：同一棵树、同一份几何，容器窄 → 自动缩小；
 *   配一个「本次会话 N 项」的计数，供"一眼看到在长"
 *
 * ## 双模式（PXII-FEAT-PORT-FOCUS-SYNC）
 * 会话含 5~9 个子岛时，横向卡片流总宽可达 1500~2500px，而本卡只有 280px ——
 * `meet` 等比缩放会把整图缩成一根线。但番茄钟执行时用户真正要看的只有
 * **「当前正在专注的那个 L3 子岛及其思考分支」**。故：
 * - `focused`（**默认**）：`currentPlanTitle` 命中某子岛 → **viewBox 对齐该子岛**
 *   （复用 `WorkMapTree.focusBounds` 的既有通道），280px 视口被该子岛充分填充，
 *   字号大而清晰、实时看到思考在生长；未命中（准备态 / 无子任务）→ **自动回退全景**
 * - `all`：维持原有的群岛全景微缩
 *
 * ★ 模式只改 **viewBox**，不改 DOM：同一棵树、同一份几何、同一份渲染代码照旧画出来，
 * 只是视口框到了子岛上（框外内容被 SVG 自然裁掉）。这条纪律有三重收益：
 * 1. `data-minimal` 沉浸态契约不变 —— 极简岛隐的是文字，与视口框无关
 * 2. 切换零重排（没有节点增删），不会出现"一切模式树就抖一下"
 * 3. 与编辑区的单子岛聚焦**共用同一条几何路径**（`subIslandVisualBounds`），不新开分叉
 *
 * ## 纪律（沿用 D12/D13 的裁决，改动前先读）
 * 1. **不随沉浸渐隐**：本卡不加 `.timer-immersive-fade` —— 用户 2026-10-01 确认
 *    「极简岛 = 小视图在沉浸时的呈现」（保留轮廓/点阵/当前高亮）
 * 2. **极简岛 = 同一 DOM + 纯 CSS**：`data-minimal` 派生，样式只隐文字（`.wm-text`），
 *    几何与容器尺寸不变 → 零布局抖动
 * 3. **fail-soft**：无导图 / 解析失败 → 占位文案（不渲染空 SVG）
 * 4. **渲染不分叉**：树由 `WorkMapTree` 承担（与编辑区共用同一份代码，D13「最小集」纪律）
 */
import { useMemo, useState, type ReactNode } from 'react'

import {
  findSessionIslandLayout,
  readWorkMapLayout,
  subIslandVisualBounds,
} from '@/lib/work-map/island-layout'

import { WorkMapTree, projectArchipelagoIsland } from './work-map-tree'

/** 小视图呈现模式（PXII-FEAT-PORT-FOCUS-SYNC） */
export type MapPortViewMode = 'focused' | 'all'

export { projectArchipelagoIsland }

export interface TimerMapPortProps {
  /** 当前会话所属 L3 的岛文件原文；null = 尚无导图 / 读取失败 */
  mapText: string | null
  /** 当前会话 id（高亮其岛根） */
  sessionId: string | null
  /** 沉浸态（极简岛）：同一 DOM，仅 CSS 派生 */
  minimal: boolean
  /** 点击有 cid 节点上抛 cid（用于中央编辑区定位高亮；ADR-0008 D15） */
  onFocusNode?: (cid: string) => void
  /** 当前专注的计划项（L3）标题（方案 A：高亮标识正在专注的分支） */
  currentPlanTitle?: string | null
  /**
   * 受控的呈现模式（缺省 = 内部自持，初始 `'focused'`）。
   * 由页面持有偏好时传入；不传则本组件自己记（切换即时生效）。
   */
  viewMode?: MapPortViewMode
  /** 模式切换上抛（受控用法）；未提供时本组件内部切换 */
  onViewModeChange?: (mode: MapPortViewMode) => void
}

export function TimerMapPort({
  mapText,
  sessionId,
  minimal,
  onFocusNode,
  currentPlanTitle,
  viewMode,
  onViewModeChange,
}: TimerMapPortProps): ReactNode {
  const island = useMemo(() => {
    if (mapText === null || sessionId === null) return null
    const layout = readWorkMapLayout(mapText)
    return layout === null ? null : findSessionIslandLayout(layout, sessionId)
  }, [mapText, sessionId])

  // 受控 / 非受控双通道：页面不需要知道偏好时（如既有调用点）本组件自己持有
  const [internalMode, setInternalMode] = useState<MapPortViewMode>('focused')
  const mode = viewMode ?? internalMode

  /**
   * 专注项命中的子岛（`focused` 模式的 viewBox 目标）。
   * 匹配口径与 `WorkMapTree` 的 `currentPlanTitle` 完全一致（`.trim()` 归一）——
   * 否则会出现"树里高亮了、小视图却没跟过去"的错位。
   *
   * ★ 必须在**投影后**的子岛上找：渲染器对单会话岛会再投影一次（方案 A 横向卡片流），
   *   拿投影前的 bounds 去框会在画面上错位（框落在旧排布的位置）。故这里走
   *   `projectArchipelagoIsland` —— 与渲染器**同一份**投影函数，几何必然同源。
   */
  const focusedSubIsland = useMemo(() => {
    if (mode !== 'focused' || island === null) return null
    const title = currentPlanTitle?.trim() ?? ''
    if (title === '') return null
    const projected = projectArchipelagoIsland(island)
    return projected.subIslands?.find((sub) => sub.title.trim() === title) ?? null
  }, [mode, island, currentPlanTitle])

  const switchMode = (next: MapPortViewMode): void => {
    if (onViewModeChange !== undefined) onViewModeChange(next)
    else setInternalMode(next)
  }

  return (
    <section
      className="ios-panel ios-map-port"
      data-testid="timer-map-port"
      data-minimal={minimal ? 'true' : 'false'}
      data-view-mode={mode}
    >
      <div className="ios-card-title">
        工作导图 · 小视图
        {island !== null ? <span className="wm-editor-count">{island.nodes.length} 项</span> : null}
        {island !== null ? (
          <span
            className="wm-port-mode-toggle"
            role="group"
            aria-label="小视图呈现模式"
            data-testid="map-port-mode-toggle"
          >
            <button
              type="button"
              className={`wm-port-mode-btn ${mode === 'focused' ? 'wm-port-mode-btn--active' : ''}`}
              aria-pressed={mode === 'focused'}
              data-testid="map-port-mode-focused"
              title="只呈现当前专注的 L3 子岛（字号更大）"
              onClick={() => switchMode('focused')}
            >
              🎯 专注项
            </button>
            <button
              type="button"
              className={`wm-port-mode-btn ${mode === 'all' ? 'wm-port-mode-btn--active' : ''}`}
              aria-pressed={mode === 'all'}
              data-testid="map-port-mode-all"
              title="呈现会话全局群岛"
              onClick={() => switchMode('all')}
            >
              🌐 全景
            </button>
          </span>
        ) : null}
      </div>
      {island !== null ? (
        <div
          className="wm-port-canvas"
          data-testid="map-port-canvas"
          data-follow={focusedSubIsland !== null ? 'true' : 'false'}
        >
          <WorkMapTree
            islands={[island]}
            sessionId={sessionId}
            label="本次会话导图（小视图）"
            currentPlanTitle={currentPlanTitle}
            onFocusNode={onFocusNode}
            // 专注跟随 = viewBox 对齐命中子岛（复用既有 `focusBounds` 通道，
            // 几何与编辑区单岛聚焦同源）。
            // ★ 这里取**非聚焦态**的 `subIslandVisualBounds`：小视图画的是群岛卡片形态
            //   （顶栏/微标签都在卡片盒内），而聚焦态那套内边距（top 32 / bottom 32）
            //   是为编辑区大画布预留横幅与返回按钮的 —— 在 ~132px 高的小画布上会把
            //   卡片压掉一半。配 `focusPadding: 6` 只留一点呼吸位，让卡片真正填满视口。
            focusBounds={
              focusedSubIsland === null
                ? null
                : subIslandVisualBounds(focusedSubIsland, false)
            }
            focusPadding={6}
          />
        </div>
      ) : (
        <p className="ios-tiny" data-testid="map-port-empty" style={{ marginTop: 6 }}>
          本次会话还没有导图记录。
        </p>
      )}
    </section>
  )
}
