'use client'

/**
 * 运行态导图端口「当前会话岛」—— ADR-0008 D13 步 1（含 D12 极简岛裁决）。
 *
 * ## 结构（运行态右栏新增一格；演示稿节点原文「端口位置：运行态网格」）
 * ```
 * 工作导图 · 当前会话岛          ← 卡标题（.ios-card-title）
 *   ╭ 岛轮廓 ─────────────────╮
 *   │ ○ 本次会话        当前 │  ← 岛根 = 会话节点（高亮行）
 *   │ ● 子节点行 …            │
 *   ╰─────────────────────────╯
 * ```
 *
 * ## 三条纪律（改动前先读）
 * 1. **不随沉浸渐隐**：本卡**不加** `.timer-immersive-fade`（D12 裁决 1）——
 *    父级 `opacity` 是子树合成效果，一旦进入渐隐子树就无法"逆渐隐"
 * 2. **极简岛 = 同一 DOM + 纯 CSS**：沉浸态由 `data-minimal` 派生，样式只把文字
 *    标注 `visibility: hidden`（保留行盒）→ 容器尺寸不变 = **零布局抖动**（D12 裁决 2）。
 *    组件在两种呈态下渲染**完全相同**的子树，不做条件分支
 * 3. **fail-soft**：无导图 / 解析失败 → 一句占位文案，绝不抛（ADR-0008 不变量 4）
 *
 * ## 数据来源与边界
 * - 页面已读到 `.mm.md` 原文后传入（本组件不发请求——便于单测、也避免重复 IO）
 * - 岛定位：`findSessionIsland(view, sessionId)`；会话节点 = 带 `session_id` 的岛根行
 * - 思考类型点阵（D9）留待**步 2**（写侧定义节点属性键后接入）——本步所有节点
 *   渲染中性点，不做未定义字段的猜测
 */
import { useMemo } from 'react'

import { findSessionIsland, readWorkMapView } from '@/lib/work-map/island-view'

export interface TimerMapPortProps {
  /** 当前会话所属 L3 的岛文件原文；null = 尚无导图 / 读取失败（fail-soft 由页面兜） */
  mapText: string | null
  /** 当前会话 id（用于在岛上定位"本次会话"节点） */
  sessionId: string | null
  /** 沉浸态（D12 极简岛）：同一 DOM，仅 CSS 派生 */
  minimal: boolean
}

export function TimerMapPort({ mapText, sessionId, minimal }: TimerMapPortProps) {
  const island = useMemo(() => {
    if (mapText === null || sessionId === null) return null
    const view = readWorkMapView(mapText)
    return view === null ? null : findSessionIsland(view, sessionId)
  }, [mapText, sessionId])

  return (
    <section
      className="ios-panel"
      data-testid="timer-map-port"
      data-minimal={minimal ? 'true' : 'false'}
    >
      <div className="ios-card-title">工作导图 · 当前会话岛</div>
      {island ? (
        <div className="ios-map-island" data-testid="map-island">
          <div className="ios-map-island-hd">
            <span className="ios-map-shape" data-kind="island" />
            <span className="ios-map-node-text">本次会话</span>
          </div>
          {island.nodes.map((node) => {
            const isSessionNode = node.note?.session_id === sessionId
            return (
              <div
                key={node.id}
                className="ios-map-row"
                data-current={isSessionNode ? 'true' : 'false'}
                data-testid={isSessionNode ? 'map-session-node' : undefined}
              >
                <span className="ios-map-shape" data-kind={isSessionNode ? 'session' : 'node'} />
                <span className="ios-map-node-text">{node.text === '' ? '（无标题）' : node.text}</span>
                {isSessionNode ? <span className="ios-map-tail">当前</span> : null}
              </div>
            )
          })}
        </div>
      ) : (
        <p className="ios-tiny" data-testid="map-port-empty" style={{ marginTop: 6 }}>
          本次会话还没有导图记录。
        </p>
      )}
    </section>
  )
}
