'use client'

/**
 * 中央**导图编辑区**（运行态焦点区下半）—— ADR-0008 D15。
 *
 * ## 为什么在这里（D15 背景）
 * 用户视觉评审（2026-10-01）：焦点区环下方原本是一大块空白，而右栏 304px 里塞一棵
 * 树读不清 → **端口职责拆分**：中央大块 = 编辑区（看全、写思路）；右栏 = 小视图
 * （缩略 + 定位 + 极简岛）。沉浸模式只渐隐右栏伴奏，**中央编辑区保留**（记录面常驻）。
 *
 * ## 职责边界
 * - 渲染：与右栏小视图**共用** `WorkMapTree`（同一份几何、同一份 SVG 代码）
 * - 写入：`onQuickRecord` 由页面提供（读-改-写与 fail-soft 都在页面，见 D14 已知边界）
 * - 数据：页面已读到的 `.mm.md` 原文（本组件不发请求）
 *
 * ## 快速记录（自右栏端口迁移，D13 步 2 → D15）
 * 类型按钮行 + **浮层输入**（绝对定位，展开/收起不改变画布几何）。
 * 沉浸态下本区常驻 → "沉浸中仍能记录"由中央区承担（D12 裁决 2 的职责转移，见 D15）。
 */
import { useMemo, useState, type ReactNode } from 'react'

import {
  findSessionIslandLayout,
  readWorkMapLayout,
} from '@/lib/work-map/island-layout'
import {
  THOUGHT_TYPES,
  THOUGHT_TYPE_LABEL,
  type ThoughtType,
} from '@/lib/work-map/thought-types'

import { WorkMapTree } from './work-map-tree'

export interface TimerMapEditorProps {
  /** 当前会话所属 L3 的岛文件原文；null = 尚无导图 / 读取失败 */
  mapText: string | null
  /** 当前会话 id（高亮其岛根） */
  sessionId: string | null
  /** 快速记录：追加「类型 + 文本」为会话节点子节点（页面实现写入；抛错 → 卡内提示） */
  onQuickRecord?: (type: ThoughtType, title: string) => Promise<void>
}

export function TimerMapEditor({
  mapText,
  sessionId,
  onQuickRecord,
}: TimerMapEditorProps): ReactNode {
  const island = useMemo(() => {
    if (mapText === null || sessionId === null) return null
    const layout = readWorkMapLayout(mapText)
    return layout === null ? null : findSessionIslandLayout(layout, sessionId)
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
    <div className="wm-editor flex min-h-0 flex-1 flex-col" data-testid="timer-map-editor">
      <div className="wm-editor-hd">
        工作导图 · 本次会话
        {island !== null ? (
          <span className="wm-editor-count">{island.nodes.length} 项</span>
        ) : null}
      </div>

      {island !== null ? (
        <div className="wm-editor-canvas" data-testid="map-editor-canvas">
          <WorkMapTree
            islands={[island]}
            sessionId={sessionId}
            label="本次会话导图（编辑区）"
          />
        </div>
      ) : (
        <div className="wm-editor-canvas wm-editor-canvas--empty" data-testid="map-editor-empty">
          本次会话还没有导图记录。
        </div>
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
    </div>
  )
}
