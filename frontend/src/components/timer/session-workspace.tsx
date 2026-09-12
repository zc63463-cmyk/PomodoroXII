'use client'

import { createElement, useState } from 'react'

interface PlanItem {
  id: string
  workItemId: string
  titleSnapshot: string
  currentDuringSession: boolean
  completionDraft: boolean
}

interface AvailableItem { id: string; title: string }

interface SessionWorkspaceProps {
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
  session, plans, availableLevel3 = [], onSetCurrent, onSetCompletionDraft,
  onAddPlanItem, onRemovePlanItem, onCreatePlanItem, onUpdateSessionNote,
  onUpdateWorkItemNote: _onUpdateWorkItemNote,
  onFlushWorkItemNote, onSwitchWorkItemNote,
}: SessionWorkspaceProps) {
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
  return createElement(
    'section', { 'aria-label': 'Session workspace', className: 'grid gap-6' },
    createElement('section', { 'aria-label': 'Session plan', className: 'grid gap-2' },
      createElement('h2', null, 'Current plan'),
      plans.map((plan) => createElement('div', { key: plan.id, className: 'flex items-center gap-2' },
        createElement('input', {
          type: 'radio', name: 'current-session-plan',
          'aria-label': `Work on ${plan.titleSnapshot}`,
          checked: plan.currentDuringSession,
          onChange: () => void selectCurrent(plan.workItemId),
        }),
        createElement('button', { type: 'button', onClick: () => void selectCurrent(plan.workItemId) }, `Work on ${plan.titleSnapshot}`),
        createElement('label', null,
          createElement('input', {
            type: 'checkbox', 'aria-label': `Mark ${plan.titleSnapshot} complete`, checked: plan.completionDraft,
            onChange: (event: React.ChangeEvent<HTMLInputElement>) => void onSetCompletionDraft?.(plan.id, event.target.checked),
          }),
        ),
        createElement('button', { type: 'button', onClick: () => void onRemovePlanItem?.(plan.id) }, `Remove ${plan.titleSnapshot} from plan`),
      )),
      // 空计划必须说出来：此前 plans 为空时这一节标题下什么都没有 ——
      // 用户看到「Current plan」+ 空白，只会判定"坏了"。
      plans.length === 0
        ? createElement('p', { role: 'status', className: 'text-sm text-muted-foreground' },
            availableLevel3.length > 0
              ? '还没有计划项 —— 用下面的「Add … to plan」把三级项加入本次会话。'
              : '这次会话还没有计划项（启动时未选三级项，当前二级项下也没有可加入的三级项）。')
        : null,
      availableLevel3.map((item) => createElement('button', { key: item.id, type: 'button', onClick: () => void onAddPlanItem?.(item.id) }, `Add ${item.title} to plan`)),
      // 内联新建：提交后清空输入；失败（离线/后端拒绝）保留输入并把原因
      // 呈现为 alert —— 用户要据此行动，不能静默（创建离线被禁是既有规则）。
      onCreatePlanItem ? createElement('form', {
        className: 'grid gap-2',
        'aria-label': 'Create plan item',
        onSubmit: (event: React.FormEvent<HTMLFormElement>) => {
          event.preventDefault()
          const title = createdTitle.trim()
          if (!title) return
          void (async () => {
            setCreateError(null)
            try {
              await onCreatePlanItem(title)
              setCreatedTitle('')
            } catch (cause) {
              setCreateError(cause instanceof Error ? cause.message : 'Unable to create WorkItem')
            }
          })()
        },
      },
      createElement('input', {
        value: createdTitle,
        'aria-label': '新三级标题',
        placeholder: '新建三级工作项并加入计划…',
        onChange: (event: React.ChangeEvent<HTMLInputElement>) => setCreatedTitle(event.target.value),
      }),
      createElement('button', { type: 'submit', disabled: createdTitle.trim() === '' }, '+ 新建三级'),
      ) : null,
      createError ? createElement('p', { role: 'alert' }, createError) : null,
    ),
    switchError ? createElement('p', { role: 'alert' }, switchError) : null,
    createElement('label', { className: 'grid gap-2', htmlFor: 'session-note' },
      'Session note',
      createElement('textarea', {
        id: 'session-note', value: sessionNote,
        onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => {
          setSessionNote(event.target.value)
          void onUpdateSessionNote?.(event.target.value)
        },
      }),
    ),
  )
}
