'use client'

/**
 * 右栏导图**小视图**（运行态伴奏列）—— ADR-0008 D15（原「端口」的职责拆分后的一半）。
 *
 * ## 定位（在 D15 的新分工里）
 * - **中央编辑区**（`TimerMapEditor`）= 看全 + 快速记录（沉浸时保留）
 * - **本组件（小视图）**= 缩略 + 定位：同一棵树、同一份几何，容器窄 → 自动缩小；
 *   配一个「本次会话 N 项」的计数，供"一眼看到在长"
 *
 * ## 纪律（沿用 D12/D13 的裁决，改动前先读）
 * 1. **不随沉浸渐隐**：本卡不加 `.timer-immersive-fade` —— 用户 2026-10-01 确认
 *    「极简岛 = 小视图在沉浸时的呈现」（保留轮廓/点阵/当前高亮）
 * 2. **极简岛 = 同一 DOM + 纯 CSS**：`data-minimal` 派生，样式只隐文字（`.wm-text`），
 *    几何与容器尺寸不变 → 零布局抖动
 * 3. **fail-soft**：无导图 / 解析失败 → 占位文案（不渲染空 SVG）
 * 4. **渲染不分叉**：树由 `WorkMapTree` 承担（与编辑区共用同一份代码，D13「最小集」纪律）
 */
import { useMemo, type ReactNode } from 'react'

import { findSessionIslandLayout, readWorkMapLayout } from '@/lib/work-map/island-layout'

import { WorkMapTree } from './work-map-tree'

export interface TimerMapPortProps {
  /** 当前会话所属 L3 的岛文件原文；null = 尚无导图 / 读取失败 */
  mapText: string | null
  /** 当前会话 id（高亮其岛根） */
  sessionId: string | null
  /** 沉浸态（极简岛）：同一 DOM，仅 CSS 派生 */
  minimal: boolean
  /** 点击有 cid 节点上抛 cid（用于中央编辑区定位高亮；ADR-0008 D15） */
  onFocusNode?: (cid: string) => void
}

export function TimerMapPort({
  mapText,
  sessionId,
  minimal,
  onFocusNode,
}: TimerMapPortProps): ReactNode {
  const island = useMemo(() => {
    if (mapText === null || sessionId === null) return null
    const layout = readWorkMapLayout(mapText)
    return layout === null ? null : findSessionIslandLayout(layout, sessionId)
  }, [mapText, sessionId])

  return (
    <section
      className="ios-panel ios-map-port"
      data-testid="timer-map-port"
      data-minimal={minimal ? 'true' : 'false'}
    >
      <div className="ios-card-title">
        工作导图 · 小视图
        {island !== null ? <span className="wm-editor-count">{island.nodes.length} 项</span> : null}
      </div>
      {island !== null ? (
        <div className="wm-port-canvas" data-testid="map-port-canvas">
          <WorkMapTree
            islands={[island]}
            sessionId={sessionId}
            label="本次会话导图（小视图）"
            onFocusNode={onFocusNode}
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
