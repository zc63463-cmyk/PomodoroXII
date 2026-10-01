'use client'

import { useRef, useState, type ChangeEvent, type FormEvent, type ReactNode } from 'react'

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
  /**
   * 本次会话挂的**二级项标题**：仅用于拆解表单上方的归属轻提示。
   * 缺省 / 空串 → 整行不渲染（父级未知时不编造归属）。
   */
  parentTitle?: string | null
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
  parentTitle,
  onUpdateSessionNote,
  onUpdateWorkItemNote: _onUpdateWorkItemNote,
  onFlushWorkItemNote,
  onSwitchWorkItemNote,
}: SessionWorkspaceProps): ReactNode {
  const [sessionNote, setSessionNote] = useState(session.sessionNote ?? '')
  const [switchError, setSwitchError] = useState<string | null>(null)
  const [createdTitle, setCreatedTitle] = useState('')
  const [createError, setCreateError] = useState<string | null>(null)
  // 拆解表单的在途标记 + 输入框引用。二者共同服务「连续拆解」心流：
  // busy 挡住回车连击造成的重复创建（每次创建都要落一条正式 WorkItem），
  // inputRef 让成功/失败两条路径都把焦点交还输入框，用户敲完一条直接敲下一条。
  //
  // ★ 判重同时用 state 与 ref：`creating` 驱动按钮 disabled（可见反馈），
  //   而 ref 在**同一 tick** 内即可生效 —— 两次回车若落在同一批渲染里，
  //   state 还没回流，只有 ref 拦得住第二个。
  const [creating, setCreating] = useState(false)
  const creatingRef = useRef(false)
  const createInputRef = useRef<HTMLInputElement>(null)

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
    if (!title || !onCreatePlanItem || creatingRef.current) return
    void (async () => {
      creatingRef.current = true
      setCreating(true)
      setCreateError(null)
      try {
        await onCreatePlanItem(title)
        setCreatedTitle('')
      } catch (cause) {
        setCreateError(cause instanceof Error ? cause.message : 'Unable to create WorkItem')
      } finally {
        creatingRef.current = false
        setCreating(false)
        // 焦点交还输入框：拆解是**连续**动作（一条接一条），不能要求用户每次
        // 重新点回输入框。失败路径同样交还 —— 输入已保留，直接改完再回车即可。
        createInputRef.current?.focus()
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

        {/* 运行中拆解子行动（原「内联新建三级」）：创建正式 WorkItem 并加入计划 */}
        {onCreatePlanItem ? (
          <form
            className="ios-plan-create-form"
            aria-label="Create plan item"
            onSubmit={handleCreateSubmit}
          >
            {/* 归属轻提示：新建项的 parentId = 会话挂的二级项（页面层传 parentTitle），
                不是当前专注的三级项 —— 三级下不能再挂四级，这里如实说明挂在哪。 */}
            {parentTitle !== undefined && parentTitle !== null && parentTitle.trim() !== '' ? (
              <div className="ios-tiny" data-testid="plan-create-parent-hint">
                在「{parentTitle}」下新建行动项
              </div>
            ) : null}
            <div className="flex items-center gap-2">
              <input
                ref={createInputRef}
                value={createdTitle}
                aria-label="新三级标题"
                placeholder="输入子行动步骤，按回车拆解…"
                onChange={(event: ChangeEvent<HTMLInputElement>) => setCreatedTitle(event.target.value)}
                className="ios-input flex-1"
              />
              <button
                type="submit"
                disabled={creating || createdTitle.trim() === ''}
                className="ios-btn-subtle"
              >
                + 拆解行动
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
