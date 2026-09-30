'use client'

/**
 * 运行态导图端口「当前会话岛」—— ADR-0008 D13 步 1/2（含 D12 极简岛裁决）。
 *
 * ## 结构（运行态右栏新增一格；演示稿节点原文「端口位置：运行态网格」）
 * ```
 * 工作导图 · 当前会话岛          ← 卡标题（.ios-card-title）
 *   ╭ 岛轮廓 ─────────────────╮
 *   │ ○ 本次会话              │  ← 岛根 = 会话节点（高亮行）
 *   │ ◆ 09-30 23:18 会话 当前 │
 *   │ ▲ token 对照：灰阶…     │  ← 快速记录落的节点（▲ = 问题，D9 形状）
 *   ╰─────────────────────────╯
 *   [洞察] [问题] [决策] [复盘] [待办]   ← 快速记录（D13 步 2）
 * ```
 *
 * ## 四条纪律（改动前先读）
 * 1. **不随沉浸渐隐**：本卡**不加** `.timer-immersive-fade`（D12 裁决 1）——
 *    父级 `opacity` 是子树合成效果，一旦进入渐隐子树就无法"逆渐隐"
 * 2. **极简岛 = 同一 DOM + 纯 CSS**：沉浸态由 `data-minimal` 派生，样式只把**文字
 *    标注** `visibility: hidden`（保留行盒）→ 容器尺寸不变 = 零布局抖动（D12 裁决 2）；
 *    **「快速记录」按钮行是动作入口，不属"文字标注"** → 极简态保留可点（否则
 *    D5 冲突里"沉浸时仍能记录思路"无解）
 * 3. **记录输入是浮层**（`position: absolute`）→ 展开/收起不撑开容器
 * 4. **fail-soft**：无导图 / 解析失败 → 占位文案；写失败 → 卡内一行错误，绝不抛
 *
 * ## 数据与职责边界
 * - 页面已读到 `.mm.md` 原文后传入（本组件不发请求——便于单测、也避免重复 IO）
 * - 写入由页面完成（`onQuickRecord` 回调）：组件只收集"类型 + 文本"
 * - 类型标记：形状 + 颜色双重编码（D9 强制，色盲可辨）；映射只在渲染层（不落盘）
 */
import { useMemo, useState } from 'react'

import { findSessionIsland, readWorkMapView } from '@/lib/work-map/island-view'
import {
  THOUGHT_TYPES,
  THOUGHT_TYPE_LABEL,
  type ThoughtType,
} from '@/lib/work-map/thought-types'

export interface TimerMapPortProps {
  /** 当前会话所属 L3 的岛文件原文；null = 尚无导图 / 读取失败（fail-soft 由页面兜） */
  mapText: string | null
  /** 当前会话 id（用于在岛上定位"本次会话"节点） */
  sessionId: string | null
  /** 沉浸态（D12 极简岛）：同一 DOM，仅 CSS 派生 */
  minimal: boolean
  /**
   * 快速记录（D13 步 2）：把「类型 + 文本」追加为会话节点子节点。
   * 不传 = 只读端口（不渲染类型行）；抛错 = 展示卡内错误文案。
   */
  onQuickRecord?: (type: ThoughtType, title: string) => Promise<void>
}

export function TimerMapPort({
  mapText,
  sessionId,
  minimal,
  onQuickRecord,
}: TimerMapPortProps) {
  const island = useMemo(() => {
    if (mapText === null || sessionId === null) return null
    const view = readWorkMapView(mapText)
    return view === null ? null : findSessionIsland(view, sessionId)
  }, [mapText, sessionId])

  const [activeType, setActiveType] = useState<ThoughtType | null>(null)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [quickError, setQuickError] = useState<string | null>(null)

  const submit = async (): Promise<void> => {
    if (activeType === null || busy) return
    const title = draft.trim()
    if (title === '' || onQuickRecord === undefined) return
    setBusy(true)
    setQuickError(null)
    try {
      await onQuickRecord(activeType, title)
      setDraft('')
      setActiveType(null)
    } catch (cause) {
      setQuickError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section
      className="ios-panel ios-map-port"
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
                <span
                  className="ios-map-shape"
                  data-kind={isSessionNode ? 'session' : 'node'}
                  {...(node.thoughtType !== null ? { 'data-thought': node.thoughtType } : {})}
                />
                <span className="ios-map-node-text">
                  {node.text === '' ? '（无标题）' : node.text}
                </span>
                {isSessionNode ? <span className="ios-map-tail">当前</span> : null}
                {!isSessionNode && node.thoughtType !== null ? (
                  <span className="ios-map-tail">{THOUGHT_TYPE_LABEL[node.thoughtType]}</span>
                ) : null}
              </div>
            )
          })}
        </div>
      ) : (
        <p className="ios-tiny" data-testid="map-port-empty" style={{ marginTop: 6 }}>
          本次会话还没有导图记录。
        </p>
      )}

      {onQuickRecord !== undefined ? (
        <div className="ios-map-quick" data-testid="map-quick">
          {THOUGHT_TYPES.map((type) => (
            <button
              key={type}
              type="button"
              className="ios-map-quick-btn"
              data-thought={type}
              data-testid={`map-quick-${type}`}
              aria-label={`记录${THOUGHT_TYPE_LABEL[type]}`}
              aria-pressed={activeType === type}
              disabled={busy}
              onClick={() => {
                setActiveType(type)
                setQuickError(null)
              }}
            >
              {THOUGHT_TYPE_LABEL[type]}
            </button>
          ))}
        </div>
      ) : null}

      {onQuickRecord !== undefined && activeType !== null ? (
        <form
          className="ios-map-quick-pop"
          data-testid="map-quick-pop"
          onSubmit={(event) => {
            event.preventDefault()
            void submit()
          }}
        >
          <input
            // 浮层是「点即输」的快捷路径：打开即聚焦（用户刚主动点了类型按钮）
            autoFocus
            className="ios-map-quick-input"
            data-testid="map-quick-input"
            aria-label={`${THOUGHT_TYPE_LABEL[activeType]}内容`}
            placeholder={`${THOUGHT_TYPE_LABEL[activeType]}…（Enter 记下）`}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
          <button
            type="submit"
            className="ios-map-quick-submit"
            data-testid="map-quick-submit"
            disabled={busy || draft.trim() === ''}
          >
            {busy ? '记录中…' : '记下'}
          </button>
        </form>
      ) : null}

      {quickError !== null ? (
        <p className="ios-tiny" role="status" data-testid="map-quick-error">
          记录失败：{quickError}
        </p>
      ) : null}
    </section>
  )
}
