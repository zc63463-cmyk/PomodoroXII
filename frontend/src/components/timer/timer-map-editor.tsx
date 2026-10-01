'use client'

/**
 * 中央**导图编辑区**（运行态焦点区下半）—— ADR-0008 D15 / D16（D13 步 3-2）。
 *
 * ## 为什么在这里（D15 背景）
 * 用户视觉评审（2026-10-01）：焦点区环下方原本是一大块空白，而右栏 304px 里塞一棵
 * 树读不清 → **端口职责拆分**：中央大块 = 编辑区（看全、写思路）；右栏 = 小视图
 * （缩略 + 定位 + 极简岛）。沉浸模式只渐隐右栏伴奏，**中央编辑区保留**（记录面常驻）。
 *
 * ## 职责边界
 * - 渲染：与右栏小视图**共用** `WorkMapTree`（同一份几何、同一份 SVG 代码）
 * - 写入：`onQuickRecord`（快速记录）/ `onEdit`（节点编辑）由页面提供
 *   （读-改-写与 fail-soft 都在页面；本组件不发请求、不 know 会话/岛，见 D16-a）
 * - 数据：页面已读到的 `.mm.md` 原文（本组件只读它来做几何与选中态）
 *
 * ## 快速记录（自右栏端口迁移，D13 步 2 → D15）
 * 类型按钮行 + **浮层输入**（绝对定位，展开/收起不改变画布几何）。
 *
 * ## 节点编辑（D16 / 步 3-2）
 * 点击**可编辑节点**（当前会话岛内 `cid !== null` 且非会话节点）→ 选中：视觉环 +
 * 快速记录行**上方**的操作行（改名/加子/类型/注释/删除）。三个文本类操作复用浮层输入；
 * 类型 = 5 chip + 清除；删除 = **二次确认**（首次点变「确认删除？」、3 秒回退，不用
 * `window.confirm`）。选中态是组件内部 state，IO 全部上抛（模式同 quickRecord）。
 * 操作行/浮层是**动作入口**，不参与极简岛的文字隐藏（同 D12 裁决 2 的口径）。
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

import {
  findSessionIslandLayout,
  readWorkMapLayout,
  type MapTreeNode,
} from '@/lib/work-map/island-layout'
import type { MapNodeEditOp } from '@/lib/work-map/node-edits'
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
  /** 节点编辑：改名 / 加子 / 类型 / 注释 / 删除（页面实现写入；抛错 → 卡内提示） */
  onEdit?: (op: MapNodeEditOp) => Promise<void>
}

type Overlay = 'rename' | 'add' | 'comment' | 'type'

const DELETE_CONFIRM_MS = 3000

export function TimerMapEditor({
  mapText,
  sessionId,
  onQuickRecord,
  onEdit,
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

  // ── 节点编辑（D16）────────────────────────────────────────────────────
  const [selectedCid, setSelectedCid] = useState<string | null>(null)
  const [overlay, setOverlay] = useState<Overlay | null>(null)
  const [actionDraft, setActionDraft] = useState('')
  const [pendingDelete, setPendingDelete] = useState(false)
  const [editError, setEditError] = useState<string | null>(null)
  const deleteTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 选中节点按 cid 从当前几何里**重新求**：写回重建树后 cid 不变，选中态自然跟随；
  // 被删掉的节点自然求不到 → 操作行自动收起。
  const selectedNode: MapTreeNode | null = useMemo(() => {
    if (island === null || selectedCid === null) return null
    return (
      island.nodes.find(
        (node) => node.cid !== null && node.cid === selectedCid && !node.sessionNode,
      ) ?? null
    )
  }, [island, selectedCid])

  useEffect(
    () => () => {
      if (deleteTimer.current !== null) clearTimeout(deleteTimer.current)
    },
    [],
  )

  const clearDeleteTimer = (): void => {
    if (deleteTimer.current !== null) {
      clearTimeout(deleteTimer.current)
      deleteTimer.current = null
    }
  }

  const resetActions = (): void => {
    clearDeleteTimer()
    setPendingDelete(false)
    setOverlay(null)
    setEditError(null)
  }

  const selectNode = (cid: string): void => {
    setSelectedCid(cid)
    resetActions()
  }

  const runEdit = async (op: MapNodeEditOp): Promise<void> => {
    if (onEdit === undefined || busy) return
    setBusy(true)
    setEditError(null)
    try {
      await onEdit(op)
      resetActions()
    } catch (cause) {
      setEditError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const openOverlay = (next: Overlay): void => {
    if (selectedNode === null) return
    clearDeleteTimer()
    setPendingDelete(false)
    setEditError(null)
    setOverlay(next)
    setActionDraft(
      next === 'rename'
        ? selectedNode.text
        : next === 'comment'
          ? (selectedNode.comment ?? []).join('\n')
          : '',
    )
  }

  const submitText = (): void => {
    const cid = selectedNode?.cid ?? null
    if (cid === null) return
    if (overlay === 'rename' || overlay === 'add') {
      const title = actionDraft.trim()
      if (title === '') return
      void runEdit(
        overlay === 'rename' ? { kind: 'rename', cid, title } : { kind: 'add', cid, title },
      )
      return
    }
    if (overlay !== 'comment') return
    const lines = actionDraft
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '')
    void runEdit({ kind: 'comment', cid, comment: lines.length === 0 ? null : lines })
  }

  const submitType = (type: ThoughtType | null): void => {
    const cid = selectedNode?.cid ?? null
    if (cid === null) return
    void runEdit({ kind: 'type', cid, type })
  }

  const requestDelete = (): void => {
    const cid = selectedNode?.cid ?? null
    if (cid === null) return
    if (!pendingDelete) {
      setPendingDelete(true)
      clearDeleteTimer()
      deleteTimer.current = setTimeout(() => {
        setPendingDelete(false)
        deleteTimer.current = null
      }, DELETE_CONFIRM_MS)
      return
    }
    void runEdit({ kind: 'delete', cid })
  }

  const submitQuick = async (): Promise<void> => {
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

  const editable = onEdit !== undefined

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
            selectedCid={selectedCid}
            onSelectNode={editable ? selectNode : undefined}
          />
        </div>
      ) : (
        <div className="wm-editor-canvas wm-editor-canvas--empty" data-testid="map-editor-empty">
          本次会话还没有导图记录。
        </div>
      )}

      {/* 操作行（选中后出现；在快速记录行上方） */}
      {editable && selectedNode !== null ? (
        <>
          <div className="wm-actions" data-testid="map-node-actions">
            <button
              type="button"
              className="wm-action-btn"
              data-testid="map-action-rename"
              disabled={busy}
              onClick={() => openOverlay('rename')}
            >
              改名
            </button>
            <button
              type="button"
              className="wm-action-btn"
              data-testid="map-action-add"
              disabled={busy}
              onClick={() => openOverlay('add')}
            >
              加子
            </button>
            <button
              type="button"
              className="wm-action-btn"
              data-testid="map-action-type"
              disabled={busy}
              onClick={() => openOverlay('type')}
            >
              类型
            </button>
            <button
              type="button"
              className="wm-action-btn"
              data-testid="map-action-comment"
              disabled={busy}
              onClick={() => openOverlay('comment')}
            >
              注释
            </button>
            <button
              type="button"
              className="wm-action-btn wm-action-btn--danger"
              data-testid="map-action-delete"
              aria-live="polite"
              disabled={busy}
              onClick={requestDelete}
            >
              {pendingDelete ? '确认删除？' : '删除'}
            </button>
          </div>
          {selectedNode.comment !== null ? (
            <ul className="wm-node-comment" data-testid="map-node-comment">
              {selectedNode.comment.map((item, index) => (
                <li key={`${index}-${item}`}>{item}</li>
              ))}
            </ul>
          ) : null}
        </>
      ) : null}

      {/* 浮层：文本类复用输入；类型 = 5 chip + 清除（绝对定位，不撑开几何） */}
      {editable && selectedNode !== null && overlay !== null ? (
        overlay === 'type' ? (
          <div className="wm-action-pop" data-testid="map-action-pop">
            {THOUGHT_TYPES.map((type) => (
              <button
                key={type}
                type="button"
                className="wm-action-chip"
                data-thought={type}
                data-testid={`map-action-type-${type}`}
                disabled={busy}
                onClick={() => submitType(type)}
              >
                {THOUGHT_TYPE_LABEL[type]}
              </button>
            ))}
            <button
              type="button"
              className="wm-action-chip"
              data-testid="map-action-type-clear"
              disabled={busy}
              onClick={() => submitType(null)}
            >
              清除类型
            </button>
            <button
              type="button"
              className="wm-action-btn"
              data-testid="map-action-cancel"
              onClick={() => setOverlay(null)}
            >
              取消
            </button>
          </div>
        ) : (
          <form
            className="wm-action-pop"
            data-testid="map-action-pop"
            onSubmit={(event) => {
              event.preventDefault()
              submitText()
            }}
          >
            {overlay === 'comment' ? (
              <textarea
                autoFocus
                className="wm-action-input"
                data-testid="map-action-input"
                aria-label="注释（一行一条）"
                placeholder="一行一条…"
                value={actionDraft}
                onChange={(event) => setActionDraft(event.target.value)}
              />
            ) : (
              <input
                autoFocus
                className="wm-action-input"
                data-testid="map-action-input"
                aria-label={overlay === 'rename' ? '新标题' : '子节点标题'}
                placeholder={overlay === 'rename' ? '新标题…' : '子节点标题…'}
                value={actionDraft}
                onChange={(event) => setActionDraft(event.target.value)}
              />
            )}
            <button
              type="submit"
              className="wm-action-submit"
              data-testid="map-action-submit"
              disabled={busy || (overlay !== 'comment' && actionDraft.trim() === '')}
            >
              {busy ? '保存中…' : '确定'}
            </button>
            <button
              type="button"
              className="wm-action-btn"
              data-testid="map-action-cancel"
              onClick={() => setOverlay(null)}
            >
              取消
            </button>
          </form>
        )
      ) : null}

      {editError !== null ? (
        <p className="ios-tiny" role="status" data-testid="map-edit-error">
          编辑失败：{editError}
        </p>
      ) : null}

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
            void submitQuick()
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