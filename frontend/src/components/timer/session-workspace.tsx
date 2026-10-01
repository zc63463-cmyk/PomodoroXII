'use client'

import { useState, type ChangeEvent, type FormEvent, type ReactNode } from 'react'

interface PlanItem {
  id: string
  workItemId: string
  titleSnapshot: string
  currentDuringSession: boolean
  completionDraft: boolean
}

interface AvailableItem {
  id: string
  title: string
}

export interface SessionWorkspaceProps {
  session: { sessionNote?: string }
  plans: PlanItem[]
  availableLevel3?: AvailableItem[]
  onSetCurrent?: (workItemId: string | null) => void | Promise<void>
  onSetCompletionDraft?: (planItemId: string, completionDraft: boolean) => void | Promise<void>
  onAddPlanItem?: (workItemId: string) => void | Promise<void>
  onRemovePlanItem?: (planItemId: string) => void | Promise<void>
  /**
   * 运行中新建三级（工单② 2026-09-13）：规格 L645-649 把它列为首版运行态
   * 必须覆盖的交互，S07 要求「创建正式 WorkItem 并加入计划」。页面层沿用
   * 任务页创建三级同一入口（task-space-store.createChild），不新开直连 API。
   * 失败必须可见：实现方应抛出，由本组件以 role="alert" 呈现原因。
   */
  onCreatePlanItem?: (title: string) => Promise<void> | void
  onUpdateSessionNote?: (value: string) => void | Promise<void>
  onUpdateWorkItemNote?: (value: string) => void | Promise<void>
  onFlushWorkItemNote?: (reason: 'current-item-change') => Promise<void>
  onSwitchWorkItemNote?: (workItemId: string) => Promise<void | (() => Promise<void>)>
  onAllocateMinutes?: (seconds: number) => void
}

export function SessionWorkspace({
  session,
  plans,
  availableLevel3 = [],
  onSetCurrent,
  onSetCompletionDraft,
  onAddPlanItem,
  onRemovePlanItem,
  onCreatePlanItem,
  onUpdateSessionNote,
  onUpdateWorkItemNote: _onUpdateWorkItemNote,
  onFlushWorkItemNote,
  onSwitchWorkItemNote,
}: SessionWorkspaceProps): ReactNode {
  const [sessionNote, setSessionNote] = useState(session.sessionNote ?? '')
  const [switchError, setSwitchError] = useState<string | null>(null)
  const [createdTitle, setCreatedTitle] = useState('')
  const [createError, setCreateError] = useState<string | null>(null)

  const selectCurrent = (workItemId: string) => {
    if (!onSwitchWorkItemNote && !onFlushWorkItemNote) {
      void onSetCurrent?.(workItemId)
      return
    }
    setSwitchError(null)
    void (async () => {
      let rollback: (() => Promise<void>) | void = undefined
      try {
        if (onSwitchWorkItemNote) rollback = await onSwitchWorkItemNote(workItemId)
        else await onFlushWorkItemNote?.('current-item-change')
        await onSetCurrent?.(workItemId)
      } catch (cause) {
        await rollback?.().catch(() => undefined)
        setSwitchError(cause instanceof Error ? cause.message : 'Unable to switch current WorkItem')
      }
    })()
  }

  const handleCreateSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const title = createdTitle.trim()
    if (!title || !onCreatePlanItem) return
    void (async () => {
      setCreateError(null)
      try {
        await onCreatePlanItem(title)
        setCreatedTitle('')
      } catch (cause) {
        setCreateError(cause instanceof Error ? cause.message : 'Unable to create WorkItem')
      }
    })()
  }

  return (
    <section aria-label="Session workspace" className="flex flex-col gap-4">
      {/* ── 卡片 1：本次计划 ────────────────────────────────────────── */}
      <section aria-label="Session plan" className="ios-panel ios-plan-card">
        <div className="ios-card-title flex items-center justify-between">
          <div className="flex items-center gap-1.5 font-medium">
            <span>本次计划</span>
            <span className="sr-only">Current plan</span>
          </div>
          {plans.length > 0 ? (
            <span className="wm-editor-count">{plans.length} 项</span>
          ) : null}
        </div>

        {plans.length > 0 ? (
          <div className="ios-plan-list">
            {plans.map((plan) => (
              <div
                key={plan.id}
                className="ios-plan-item"
                data-current={plan.currentDuringSession ? 'true' : 'false'}
              >
                <input
                  type="radio"
                  name="current-session-plan"
                  aria-label={`Work on ${plan.titleSnapshot}`}
                  checked={plan.currentDuringSession}
                  onChange={() => void selectCurrent(plan.workItemId)}
                  className="ios-plan-radio"
                />

                <button
                  type="button"
                  aria-label={`Work on ${plan.titleSnapshot}`}
                  onClick={() => void selectCurrent(plan.workItemId)}
                  className="ios-plan-title-btn"
                >
                  <span className="ios-plan-title" title={plan.titleSnapshot}>
                    {plan.titleSnapshot}
                  </span>
                  {plan.currentDuringSession ? (
                    <span className="ios-plan-badge">专注中</span>
                  ) : null}
                </button>

                <div className="ios-plan-actions">
                  <label
                    className="ios-plan-check-label"
                    title={plan.completionDraft ? '标记未完成' : '标记已完成'}
                  >
                    <input
                      type="checkbox"
                      aria-label={`Mark ${plan.titleSnapshot} complete`}
                      checked={plan.completionDraft}
                      onChange={(event: ChangeEvent<HTMLInputElement>) =>
                        void onSetCompletionDraft?.(plan.id, event.target.checked)
                      }
                    />
                    <span>{plan.completionDraft ? '已完成' : '完成'}</span>
                  </label>

                  <button
                    type="button"
                    aria-label={`Remove ${plan.titleSnapshot} from plan`}
                    onClick={() => void onRemovePlanItem?.(plan.id)}
                    className="ios-plan-remove-btn"
                    title="移出本次计划"
                  >
                    <span aria-hidden="true">✕</span>
                    <span className="sr-only">Remove {plan.titleSnapshot} from plan</span>
                  </button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p role="status" className="ios-tiny" style={{ marginTop: 2 }}>
            {availableLevel3.length > 0
              ? '还没有计划项 —— 用下面的「Add … to plan」把三级项加入本次会话。'
              : '这次会话还没有计划项（启动时未选三级项，当前二级项下也没有可加入的三级项）。'}
          </p>
        )}

        {/* 可选候选三级项 */}
        {availableLevel3.length > 0 ? (
          <div className="ios-candidate-group">
            <div className="ios-candidate-label">可选三级项加入计划：</div>
            <div className="ios-candidate-chips">
              {availableLevel3.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  aria-label={`Add ${item.title} to plan`}
                  onClick={() => void onAddPlanItem?.(item.id)}
                  className="ios-chip-btn"
                >
                  <span aria-hidden="true" className="font-bold">+</span>
                  <span>{item.title}</span>
                  <span className="sr-only">Add {item.title} to plan</span>
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {/* 运行中内联新建三级项 */}
        {onCreatePlanItem ? (
          <form
            className="ios-plan-create-form"
            aria-label="Create plan item"
            onSubmit={handleCreateSubmit}
          >
            <div className="flex items-center gap-2">
              <input
                value={createdTitle}
                aria-label="新三级标题"
                placeholder="新建三级工作项并加入计划…"
                onChange={(event: ChangeEvent<HTMLInputElement>) => setCreatedTitle(event.target.value)}
                className="ios-input flex-1"
              />
              <button
                type="submit"
                disabled={createdTitle.trim() === ''}
                className="ios-btn-subtle"
              >
                + 新建三级
              </button>
            </div>
            {createError ? (
              <p role="alert" className="ios-error-text">
                {createError}
              </p>
            ) : null}
          </form>
        ) : null}

        {switchError ? (
          <p role="alert" className="ios-error-text">
            {switchError}
          </p>
        ) : null}
      </section>

      {/* ── 卡片 2：会话速记 ────────────────────────────────────────── */}
      <section className="ios-panel ios-note-card">
        <div className="ios-card-title flex items-center justify-between">
          <label htmlFor="session-note" className="flex items-center gap-1 font-medium" style={{ cursor: 'pointer' }}>
            <span>会话速记</span>
            <span className="sr-only">Session note</span>
          </label>
          <span className="ios-tiny" style={{ color: 'var(--ios-label-3)' }}>
            随手备忘
          </span>
        </div>
        <textarea
          id="session-note"
          aria-label="Session note"
          value={sessionNote}
          onChange={(event: ChangeEvent<HTMLTextAreaElement>) => {
            setSessionNote(event.target.value)
            void onUpdateSessionNote?.(event.target.value)
          }}
          placeholder="随手记下这轮专注的闪念、待办或临时备忘…"
          rows={3}
          className="ios-textarea"
        />
      </section>
    </section>
  )
}
