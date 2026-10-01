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
 *
 * ## 幕布描述块编辑（PXII-FEAT-DESC-BLOCK）
 * `Shift+Enter`（键位表 `comment`）打开注释浮层；浮层内**幕布语义**：
 * `Enter` 换行、`Shift+Enter` 提交并收起、`Esc` 放弃。清空后提交 → `comment: null`
 * → 节点盒在下次布局时收缩回 `NODE_H_BASE`（内容驱动，不是一次性标记）。
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react'

import { EDITOR_KEY_HINTS, matchEditorKey } from '@/lib/work-map/editor-keymap'
import {
  findSessionIslandLayout,
  readWorkMapLayout,
  type MapTreeNode,
} from '@/lib/work-map/island-layout'
import type { MapNodeEditOp } from '@/lib/work-map/node-edits'
import { findNextNavNode, findParentNode } from '@/lib/work-map/tree-navigation'
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
  /** 外部传入被定位节点的 cid（小视图点击定位；驱动 focus 环，不与 selectedCid 混用；ADR-0008 D15） */
  focusCid?: string | null
  /** 快速记录：追加「类型 + 文本」为会话节点子节点（页面实现写入；抛错 → 卡内提示） */
  onQuickRecord?: (type: ThoughtType, title: string) => Promise<void>
  /** 节点编辑：改名 / 加子 / 类型 / 注释 / 删除（页面实现写入；抛错 → 卡内提示） */
  onEdit?: (op: MapNodeEditOp) => Promise<void>
  /** 升格为任务（PXII-FEAT-TASK-SPACE-P0）：把节点标题/注释沉淀为正式 WorkItem，
   *  页面实现创建与导图回写；抛错 → 卡内提示。缺省 = 不提供升格入口（只读）。 */
  onPromoteNode?: (cid: string, node: MapTreeNode) => Promise<void>
}

type Overlay = 'rename' | 'add' | 'comment' | 'type'

const DELETE_CONFIRM_MS = 3000

export function TimerMapEditor({
  mapText,
  sessionId,
  focusCid,
  onQuickRecord,
  onEdit,
  onPromoteNode,
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
  /**
   * 浮层的**写入目标** cid。通常 = 选中节点；唯一例外是「未选中时按 Tab」——
   * 此时目标是**岛根**（= 快速记录的父锚），所以不能直接用 `selectedNode.cid`。
   */
  const [overlayCid, setOverlayCid] = useState<string | null>(null)
  const [actionDraft, setActionDraft] = useState('')
  const [pendingDelete, setPendingDelete] = useState(false)
  const [editError, setEditError] = useState<string | null>(null)
  const deleteTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // ── 键盘心流（PXII-FEAT-KEYMAP-FLOW）──────────────────────────────────
  /** 画布（SVG 所在块）：既是键位作用域判定的基准，也是浮层收起后的**焦点归还点** */
  const canvasRef = useRef<HTMLDivElement | null>(null)
  const actionInputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null)

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

  /** cid → 节点（浮层目标**可能不是**选中节点：加同级时是父节点，未选中 Tab 时是岛根） */
  const nodeByCid = useMemo(() => {
    const map = new Map<string, MapTreeNode>()
    if (island !== null) {
      for (const node of island.nodes) {
        if (node.cid !== null) map.set(node.cid, node)
      }
    }
    return map
  }, [island])

  /** 把焦点交给画布：键盘流的落点（点选节点后 / 浮层收起后） */
  const focusCanvas = useCallback((): void => {
    canvasRef.current?.focus({ preventScroll: true })
  }, [])

  // 改名浮层：打开即**全选**现有名称 —— 一键打字覆盖，也可按方向键微调（手感同 F2）
  useEffect(() => {
    if (overlay !== 'rename') return
    const input = actionInputRef.current
    if (input instanceof HTMLInputElement) input.select()
  }, [overlay])

  // 注释浮层：打开即聚焦并把光标置于**末尾**（接着写，而不是覆盖已有注释）——
  // 与 MindCanvas `DescBlock` 进入编辑态的手感一致（那边是 setSelectionRange(len, len)）。
  useEffect(() => {
    if (overlay !== 'comment') return
    const input = actionInputRef.current
    if (input instanceof HTMLTextAreaElement) {
      input.focus()
      input.setSelectionRange(input.value.length, input.value.length)
    }
  }, [overlay])

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

  /**
   * 收尾：清掉删除确认 / 浮层 / 错误，并把焦点**归还画布**（提交或取消后立刻能接着
   * 按 Tab、F2 —— 心流不断）。焦点归还是**显式动作**（在事件处理器里）而不是 effect
   * 副作用：一是时序确定（不必等一次渲染），二是失败路径（`editError`）不调本函数，
   * 浮层保留时焦点自然留在输入框里方便重试。
   */
  const resetActions = (): void => {
    clearDeleteTimer()
    setPendingDelete(false)
    setOverlay(null)
    setOverlayCid(null)
    setEditError(null)
    focusCanvas()
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

  /**
   * 升格为任务（PXII-FEAT-TASK-SPACE-P0）：键盘 ⇧P 与操作行按钮共用的唯一入口。
   * 与 `runEdit` 同一条纪律（busy 闸门 / 卡内错误 / 成功后焦点归还画布）——
   * 失败时浮层语义不适用（本动作无浮层），错误落 `map-edit-error` 即可重试。
   */
  const runPromote = async (): Promise<void> => {
    const node = selectedNode
    if (node === null || node.cid === null || onPromoteNode === undefined || busy) return
    const cid = node.cid
    setBusy(true)
    setEditError(null)
    try {
      await onPromoteNode(cid, node)
      resetActions()
    } catch (cause) {
      setEditError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const closeOverlay = (): void => {
    setOverlay(null)
    setOverlayCid(null)
    // 焦点归还画布：收起浮层后立刻能接着按 Tab / F2（与 resetActions 同一条收尾纪律）
    focusCanvas()
  }

  /**
   * 打开浮层（写入目标显式传入 —— 加同级作用于**父节点**、未选中 Tab 作用于**岛根**，
   * 都不是"当前选中节点"）。
   */
  const openOverlayFor = (targetCid: string, next: Overlay): void => {
    const target = nodeByCid.get(targetCid)
    if (target === undefined) return
    clearDeleteTimer()
    setPendingDelete(false)
    setEditError(null)
    setOverlayCid(targetCid)
    setOverlay(next)
    setActionDraft(
      next === 'rename'
        ? target.text
        : next === 'comment'
          ? (target.comment ?? []).join('\n')
          : '',
    )
  }

  /** 操作行按钮入口（目标 = 当前选中节点） */
  const openSelectedOverlay = (next: Overlay): void => {
    const cid = selectedNode?.cid ?? null
    if (cid === null) return
    openOverlayFor(cid, next)
  }

  const submitText = (): void => {
    const cid = overlayCid
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
    const cid = overlayCid ?? selectedNode?.cid ?? null
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

  /**
   * 导图键盘流分发（PXII-FEAT-KEYMAP-FLOW）。
   *
   * 监听挂在外层容器（冒泡），但**只在画布持有焦点时**响应：焦点在操作行/浮层控件上
   * 时按键归那些控件（Enter 激活按钮、Esc 关弹层），不抢。防穿透的最终判据在
   * `matchEditorKey`（输入框一律不匹配）—— 两层叠起来，打字绝不会误触导图动作。
   *
   * ★ 命中后必须 `stopPropagation`：`AppShell` 的全局快捷键钩子把数字键 1-5 绑成
   * **路由跳转**（`SHORTCUT_ROUTES`），不拦住的话"按 2 切问题类型"会顺手跳到
   * `/tasks`。Escape 同理（全局会把所有面板关掉）。两者都在 window 上监听，
   * 只有阻断冒泡才能让导图内的一次按键只做一件事。
   */
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    // 浮层打开 = 键盘归浮层：仅 Esc 由导图处理（收起浮层），其余交给浮层内控件。
    // 这道闸门与 `matchEditorKey` 的输入面判定**互为冗余**：即便焦点被点回画布，
    // 浮层开着时按 1 也不会静默改类型（用户以为自己还在"加子"流程里）。
    if (overlay !== null) {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        closeOverlay()
      }
      return
    }

    const target = event.target as Node | null
    if (canvasRef.current === null || target === null) return
    if (!canvasRef.current.contains(target)) return

    // 焦点停在**节点 `<g>` 上**时（用户 Tab 键浏览到某个节点），Enter/Space 归
    // 渲染器自己的激活处理（选中该节点），否则会同一次按键既选中又开「加同级」。
    // 选中后 `selectNode` 会把焦点收回画布，之后的 Enter 才走导图键位。
    if (
      (event.key === 'Enter' || event.key === ' ') &&
      target instanceof Element &&
      target.closest('[data-cid]') !== null
    ) {
      return
    }

    const action = matchEditorKey(event.nativeEvent, selectedNode !== null)
    if (action === null) return

    const currentCid = selectedNode?.cid ?? null

    // Esc 且**无可退让的对象**：只把焦点交还页面（让全局快捷键继续处理这次 Esc），
    // 不做 preventDefault —— 否则用户按 Esc 关不掉页面上其它浮层（键盘陷阱）。
    if (action.type === 'cancel' && overlay === null && currentCid === null) {
      canvasRef.current.blur()
      return
    }

    event.preventDefault()
    event.stopPropagation()

    switch (action.type) {
      case 'add-child': {
        // 已选中 → 该节点加子；未选中 → **岛根**加子（进岛最快的一条路）
        const cid = currentCid ?? island?.tree.cid ?? null
        if (cid !== null) openOverlayFor(cid, 'add')
        return
      }
      case 'add-sibling': {
        // 同级生长 = 对**父节点**加子；父节点（会话节点等）只需有 cid 可作锚点
        if (island === null || currentCid === null) return
        const parent = findParentNode(island.tree, currentCid)
        if (parent !== null && parent.cid !== null) openOverlayFor(parent.cid, 'add')
        return
      }
      case 'rename':
        openSelectedOverlay('rename')
        return
      case 'comment':
        openSelectedOverlay('comment')
        return
      case 'promote':
        void runPromote()
        return
      case 'delete':
        requestDelete()
        return
      case 'set-type':
        if (currentCid !== null) {
          void runEdit({ kind: 'type', cid: currentCid, type: action.thoughtType })
        }
        return
      case 'navigate': {
        if (island === null || currentCid === null) return
        const next = findNextNavNode(island.tree, currentCid, action.dir)
        if (next !== null) selectNode(next)
        return
      }
      case 'cancel':
        // 逐级退让：浮层 → 选中（两级都为空的情形已在上面提前返回）
        if (overlay !== null) closeOverlay()
        else {
          setSelectedCid(null)
          resetActions()
        }
        return
    }
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
    <div
      className="wm-editor flex min-h-0 flex-1 flex-col"
      data-testid="timer-map-editor"
      onKeyDown={editable ? handleKeyDown : undefined}
    >
      <div className="wm-editor-hd">
        工作导图 · 本次会话
        {island !== null ? (
          <span className="wm-editor-count">{island.nodes.length} 项</span>
        ) : null}
        {editable && island !== null ? (
          <span className="wm-editor-keys" data-testid="map-key-hints">
            {EDITOR_KEY_HINTS.map((hint) => (
              <span key={hint.keys} className="wm-key-hint">
                <kbd>{hint.keys}</kbd>
                {hint.label}
              </span>
            ))}
          </span>
        ) : null}
      </div>

      {island !== null ? (
        <div
          ref={canvasRef}
          className="wm-editor-canvas"
          data-testid="map-editor-canvas"
          tabIndex={editable ? 0 : undefined}
          role={editable ? 'application' : undefined}
          aria-label={editable ? '本次会话导图（Tab 加子 / Enter 同级 / F2 改名 / 1-5 类型 / 方向键导航）' : undefined}
        >
          <WorkMapTree
            islands={[island]}
            sessionId={sessionId}
            label="本次会话导图（编辑区）"
            selectedCid={selectedCid}
            focusCid={focusCid}
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
              onClick={() => openSelectedOverlay('rename')}
            >
              改名
            </button>
            <button
              type="button"
              className="wm-action-btn"
              data-testid="map-action-add"
              disabled={busy}
              onClick={() => openSelectedOverlay('add')}
            >
              加子
            </button>
            <button
              type="button"
              className="wm-action-btn"
              data-testid="map-action-type"
              disabled={busy}
              onClick={() => openSelectedOverlay('type')}
            >
              类型
            </button>
            <button
              type="button"
              className="wm-action-btn"
              data-testid="map-action-comment"
              disabled={busy}
              onClick={() => openSelectedOverlay('comment')}
            >
              注释
            </button>
            {onPromoteNode !== undefined ? (
              <button
                type="button"
                className="wm-action-btn"
                data-testid="map-action-promote"
                title="把节点标题与注释沉淀为正式任务"
                disabled={busy}
                onClick={() => void runPromote()}
              >
                升格为任务
              </button>
            ) : null}
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

      {/* 浮层：文本类复用输入；类型 = 5 chip + 清除（绝对定位，不撑开几何）
          ★ 判据是 `overlayCid`（浮层**写入目标**）而非 `selectedNode`：未选中时按
          Tab 给岛根加子，此刻没有选中节点但浮层必须呈现（目标 = 岛根）。 */}
      {editable && overlayCid !== null && overlay !== null ? (
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
              onClick={closeOverlay}
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
                ref={(node) => {
                  actionInputRef.current = node
                }}
                autoFocus
                className="wm-action-input"
                data-testid="map-action-input"
                aria-label="注释（Enter 换行 / Shift+Enter 完成）"
                placeholder="一行一条…（Enter 换行，Shift+Enter 完成）"
                value={actionDraft}
                onChange={(event) => setActionDraft(event.target.value)}
                // 幕布描述块的键盘语义（对齐 MindCanvas DescBlock）：
                // Enter = 换行（textarea 原生行为，不拦）；Shift+Enter = 提交并收起；
                // Esc = 放弃编辑。三者都在**输入面内**处理并阻断冒泡 —— 编辑区容器
                // 的 Esc 分支与全局快捷键都不该在这次按键上再动作。
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && event.shiftKey) {
                    event.preventDefault()
                    event.stopPropagation()
                    submitText()
                    return
                  }
                  if (event.key === 'Escape') {
                    event.preventDefault()
                    event.stopPropagation()
                    closeOverlay()
                    return
                  }
                  // 其余按键（含裸 Enter 换行）留给 textarea 与上层既有闸门
                  event.stopPropagation()
                }}
              />
            ) : (
              <input
                ref={(node) => {
                  actionInputRef.current = node
                }}
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
              onClick={closeOverlay}
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