'use client'

/**
 * 复盘提炼卡片（PXII-FEAT-REVIEW-HARVEST）—— 复盘面板内的**交互分区**。
 *
 * ## 职责边界（重要）
 * 本组件只负责「展示 + 收集用户意图」，**不碰数据层**：
 * - 建任务（`taskRepository.createWorkItem`）与导图编号回注（`applyMapNodeEdit`）
 *   由页面注入的 `onPromoteTodos` 完成（红线：严禁绕过仓储层）；
 * - 写会话笔记由页面注入的 `onInjectNote` 完成（复用既有 `updateSessionNote`）。
 * 这样组件可以在 jsdom 里用两个 spy 穷举交互，页面接线则各自被它自己的测试钉住。
 *
 * ## 「默认全选」的最省心实现
 * 记的是**取消勾选**的集合（`deselected`），勾选态 = 不在集合里。于是：
 * 1. 新出现的待办天然是勾选的，不需要 `useEffect` 去同步 props；
 * 2. 沉淀成功后升格项离开 `pending` 列表时不会留下"幽灵选中"；
 * 3. 会话切换由页面用 `key={sessionId}` 重挂载清账（见 timer/page.tsx）。
 *
 * ## fail-soft / 优雅收起
 * 待办与笔记**双双为空** → 返回 `null`，不产生空白占位（规格 §四.4 与 §五.3）；
 * 两个动作都把异常收在卡内状态文案里，绝不上抛炸掉复盘表单。
 */
import { useMemo, useState } from 'react'

import {
  formatHarvestedNoteMarkdown,
  type HarvestedThoughts,
  type HarvestedTodoItem,
} from '@/lib/work-map/harvest-thoughts'

export interface SessionReviewHarvestProps {
  thoughts: HarvestedThoughts
  /** 一键批量沉淀待办任务（页面：建 WorkItem + 导图回写 `[PXII-xxx] 标题`） */
  onPromoteTodos?: (items: HarvestedTodoItem[]) => Promise<void>
  /** 一键注入/追加到复盘笔记草稿（页面：双换行追加进 session_note） */
  onInjectNote?: (markdownSnippet: string) => Promise<void> | void
  disabled?: boolean
}

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

export function SessionReviewHarvest({
  thoughts,
  onPromoteTodos,
  onInjectNote,
  disabled = false,
}: SessionReviewHarvestProps) {
  const [deselected, setDeselected] = useState<ReadonlySet<string>>(() => new Set<string>())
  const [promoting, setPromoting] = useState(false)
  const [injecting, setInjecting] = useState(false)
  const [noteOpen, setNoteOpen] = useState(false)
  const [status, setStatus] = useState<string | null>(null)

  const pendingTodos = useMemo(
    () => thoughts.todos.filter((item) => !item.alreadyPromoted),
    [thoughts.todos],
  )
  const promotedTodos = useMemo(
    () => thoughts.todos.filter((item) => item.alreadyPromoted),
    [thoughts.todos],
  )
  const noteMarkdown = useMemo(() => formatHarvestedNoteMarkdown(thoughts), [thoughts])

  const selected = pendingTodos.filter((item) => !deselected.has(item.cid))
  const busy = promoting || injecting
  const locked = disabled || busy

  // 无待办、无笔记 → 优雅收起（不占地，也不渲染空卡片）
  if (pendingTodos.length === 0 && promotedTodos.length === 0 && noteMarkdown === '') return null

  const toggle = (cid: string, checked: boolean) => {
    setDeselected((previous) => {
      const next = new Set(previous)
      if (checked) next.delete(cid)
      else next.add(cid)
      return next
    })
  }

  const promote = async () => {
    if (promoting || selected.length === 0) return
    setPromoting(true)
    setStatus(null)
    try {
      await onPromoteTodos?.(selected)
      setDeselected(new Set<string>())
      setStatus(`已沉淀 ${selected.length} 项为正式任务`)
    } catch (cause) {
      setStatus(`沉淀失败：${errorText(cause)}`)
    } finally {
      setPromoting(false)
    }
  }

  const inject = async () => {
    if (injecting || noteMarkdown === '') return
    setInjecting(true)
    setStatus(null)
    try {
      await onInjectNote?.(noteMarkdown)
      setStatus('复盘笔记已注入')
    } catch (cause) {
      setStatus(`注入失败：${errorText(cause)}`)
    } finally {
      setInjecting(false)
    }
  }

  return (
    <section className="harvest-card" aria-label="复盘提炼" data-testid="review-harvest">
      <div className="harvest-hd">
        <span className="harvest-hd-title">复盘提炼</span>
        <span className="ios-tiny">把本轮记在图里的思考，直接变成任务与笔记</span>
      </div>

      {pendingTodos.length > 0 || promotedTodos.length > 0 ? (
        <div className="harvest-block">
          <div className="harvest-block-title">待办沉淀</div>

          {pendingTodos.length > 0 ? (
            <ul className="harvest-list">
              {pendingTodos.map((item) => (
                <li key={item.cid}>
                  <label className="harvest-item">
                    <input
                      type="checkbox"
                      className="harvest-check"
                      aria-label={`沉淀 ${item.title}`}
                      checked={!deselected.has(item.cid)}
                      disabled={locked}
                      onChange={(event) => toggle(item.cid, event.target.checked)}
                    />
                    <span className="harvest-title">{item.title}</span>
                    <span className="harvest-sub">{item.subIslandTitle}</span>
                  </label>
                </li>
              ))}
            </ul>
          ) : null}

          {promotedTodos.length > 0 ? (
            <ul className="harvest-list harvest-list--done">
              {promotedTodos.map((item) => (
                <li key={item.cid} className="harvest-done" data-testid="harvest-promoted">
                  <span className="harvest-done-mark" aria-hidden="true">✓</span>
                  <span className="harvest-done-key">{`[${item.displayKey ?? '—'}]`}</span>
                  <span className="harvest-done-title">{item.title}</span>
                </li>
              ))}
            </ul>
          ) : null}

          <button
            type="button"
            className="ios-btn ios-btn-primary harvest-submit"
            disabled={locked || selected.length === 0}
            onClick={() => { void promote() }}
          >
            {promoting ? '沉淀中…' : `一键沉淀为任务 (${selected.length})`}
          </button>
        </div>
      ) : null}

      {noteMarkdown !== '' ? (
        <div className="harvest-block">
          <div className="harvest-block-title">复盘笔记</div>
          <button
            type="button"
            className="ios-chip-btn harvest-toggle"
            aria-expanded={noteOpen}
            onClick={() => setNoteOpen((value) => !value)}
          >
            {noteOpen ? '收起预览' : '展开预览'}
          </button>
          {noteOpen ? <pre className="harvest-preview" data-testid="harvest-preview">{noteMarkdown}</pre> : null}
          <button
            type="button"
            className="ios-btn-subtle harvest-submit"
            disabled={locked}
            onClick={() => { void inject() }}
          >
            {injecting ? '注入中…' : '注入复盘笔记'}
          </button>
        </div>
      ) : null}

      {status !== null ? (
        <p className="ios-tiny harvest-status" aria-live="polite" data-testid="harvest-status">{status}</p>
      ) : null}
    </section>
  )
}
