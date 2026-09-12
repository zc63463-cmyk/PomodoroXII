'use client'

import { createElement, useEffect, useState, type ReactNode } from 'react'
import {
  WORK_ITEM_PRIORITY_VALUES,
  type TaskSpaceDefinitions,
  type WorkItemPriority,
} from '@/lib/contracts/task-space'
import type { CachedWorkItem } from '@/types'
import { Button } from '@/components/ui/button'
import { EffortReviewCard } from '@/components/task-space/effort-review-card'
import { ActiveChildConflictError } from '@/lib/task-space/active-child-conflict'
import {
  formatEffortEstimate,
  formatEffortSeconds,
  formatRelativeTime,
  formatTimestamp,
} from '@/lib/task-space/format'

export interface WorkItemDetailProps {
  workItem?: CachedWorkItem | null
  definitions?: TaskSpaceDefinitions | null
  noteEditor?: ReactNode
  /** Dependency management card (rendered between the form and the note). */
  relationsCard?: ReactNode
  /** 页面注入的状态提示横幅（如 Waiting 恢复建议），渲染在子项提示之后。 */
  statusHint?: ReactNode
  pendingMutations?: Record<string, boolean>
  mutationError?: { targetId: string; code: string } | null
  error?: string | null
  /** Same-project nodes that may become the new parent (depth < 3). */
  availableParents?: CachedWorkItem[]
  // ★ 2026-09-11：priority 走受限值域类型 —— 组件只可能提交规范英文值或 null。
  onUpdate?: (input: { title: string; description: string | null; priority: WorkItemPriority | null }) => Promise<unknown> | unknown
  onTransition?: (statusDefinitionId: string) => Promise<unknown> | unknown
  onMove?: (parentId: string | null) => Promise<unknown> | unknown
  /** Soft-delete / undo the work item (idempotent server side). */
  onTrash?: () => Promise<unknown> | unknown
  onRestore?: () => Promise<unknown> | unknown
  /** D5 Y: toggle one label on the work item (add=true converges to the
   * union; add=false removes it). Idempotent set semantics server side. */
  onToggleLabel?: (labelId: string, add: boolean) => Promise<unknown> | unknown
  /** 未完成的直接子项数：把「父项带子项不能直接完成」的域规则从报错前置为提示。 */
  openChildCount?: number | null
}

function definitionLabel(
  definitions: TaskSpaceDefinitions | null | undefined,
  group: 'statuses' | 'types',
  id: string,
): string {
  const entry = definitions?.[group].find((candidate) => (
    typeof candidate.id === 'string' && candidate.id === id
  ))
  if (!entry) return id
  for (const key of ['label', 'name', 'title'] as const) {
    if (typeof entry[key] === 'string' && entry[key]) return entry[key] as string
  }
  return id
}

/** 优先级中文标签：只用于展示，业务载荷恒为英文规范值。 */
const PRIORITY_LABELS: Record<WorkItemPriority, string> = {
  low: '低',
  medium: '中',
  high: '高',
  urgent: '紧急',
}

function timing(label: string, value: string | null, hint?: string | null): ReactNode {
  if (!value) return null
  return createElement(
    'div',
    { className: 'grid grid-cols-[auto_1fr] gap-3 text-sm' },
    createElement('dt', { className: 'text-muted-foreground' }, label),
    createElement('dd', { className: 'truncate', title: hint ?? undefined }, value),
  )
}

export function WorkItemDetail({
  workItem,
  definitions,
  noteEditor,
  relationsCard,
  statusHint,
  pendingMutations = {},
  mutationError = null,
  error = null,
  availableParents = [],
  onUpdate,
  onTransition,
  onMove,
  onTrash,
  onRestore,
  onToggleLabel,
  openChildCount = null,
}: WorkItemDetailProps) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  // '' = 未设置（null）；其余恒为规范英文值域内的成员。
  const [priority, setPriority] = useState<WorkItemPriority | ''>('')

  // The draft always mirrors the store post-image; it is reset only when the
  // selected item or its version changes (i.e. after a successful mutation).
  useEffect(() => {
    setName(workItem?.title ?? '')
    setDescription(workItem?.description ?? '')
    setPriority(workItem?.priority ?? '')
  }, [workItem?.id, workItem?.version, workItem?.title, workItem?.description, workItem?.priority])

  if (!workItem) {
    return createElement(
      'section',
      { 'aria-label': 'Work item detail', className: 'flex min-h-full items-center justify-center p-6' },
      createElement('p', { className: 'text-sm text-muted-foreground' }, '在左侧选择一个工作项'),
    )
  }

  const pending = pendingMutations[workItem.id] === true
  const readonly = workItem.archivedAt !== null
  const visibleError = mutationError?.targetId === workItem.id ? error : null
  const statusOptions = definitions?.statuses ?? []
  // 草稿与权威 post-image 逐字段比对（与服务端同样的 trim 语义），
  // 让保存按钮只在真正有改动时可用 —— 用户不必猜「要不要点一下保存」。
  const dirty = (
    name.trim() !== (workItem.title ?? '')
    || description.trim() !== (workItem.description ?? '')
    // 优先级是受限选择：值要么是 ''（未设置）要么是规范英文值，无需 trim。
    || priority !== (workItem.priority ?? '')
  )
  const effortEstimate = formatEffortEstimate(
    workItem.effortEstimateLowerSeconds,
    workItem.effortEstimateUpperSeconds,
  )

  const save = async () => {
    if (!onUpdate) return
    try {
      await onUpdate({
        title: name.trim(),
        description: description.trim() || null,
        // 受限选择的空选项 = 未设置；其余即规范英文值本身。
        priority: priority || null,
      })
    } catch {
      // Keep the draft; the store has already surfaced a stable error.
    }
  }

  const changeStatus = async (statusDefinitionId: string) => {
    if (!onTransition || statusDefinitionId === workItem.statusDefinitionId) return
    try {
      await onTransition(statusDefinitionId)
    } catch (error) {
      // A blocked completion is a resolvable state, not a dead end: let the
      // structured signal reach the page so it can open the four-way dialog.
      if (error instanceof ActiveChildConflictError) throw error
      // Stable error is surfaced by the store; keep the previous status.
    }
  }

  const changeParent = async (parentId: string) => {
    if (!onMove) return
    try {
      await onMove(parentId === '' ? null : parentId)
    } catch {
      // Stable error is surfaced by the store; keep the previous tree.
    }
  }

  const trash = async () => {
    if (!onTrash) return
    try {
      await onTrash()
    } catch {
      // Stable error is surfaced by the store; the item stays live.
    }
  }

  const restore = async () => {
    if (!onRestore) return
    try {
      await onRestore()
    } catch {
      // Stable error is surfaced by the store; the item stays archived.
    }
  }

  const toggleLabel = async (labelId: string, add: boolean) => {
    if (!onToggleLabel) return
    try {
      await onToggleLabel(labelId, add)
    } catch {
      // Stable error is surfaced by the store; keep the current label set.
    }
  }

  // D5 Y: labels render as removable chips plus an add-select over the
  // Space-scoped definitions (archived definitions stay selectable only as
  // already-applied chips).
  const labels = definitions?.labels ?? []
  const applied = labels.filter((label) => (
    typeof label.id === 'string' && workItem.labelIds.includes(label.id)
  ))
  const available = labels.filter((label) => (
    typeof label.id === 'string'
    && !workItem.labelIds.includes(label.id)
    && (label.archived_at ?? label.archivedAt) == null
  ))
  const labelName = (label: Record<string, unknown>): string =>
    String(label.name ?? label.label ?? label.id ?? '')

  return createElement(
    'article',
    { 'aria-label': 'Work item detail', className: 'min-w-0 p-5' },
    createElement(
      'header',
      { className: 'flex min-w-0 items-start justify-between gap-4 border-b pb-4' },
      createElement(
        'div',
        { className: 'min-w-0' },
        createElement('p', { className: 'font-mono text-xs text-muted-foreground' }, workItem.displayKey),
        createElement('h1', { className: 'truncate text-xl font-semibold' }, workItem.title),
      ),
      createElement(
        'div',
        { className: 'flex shrink-0 items-center gap-2' },
        createElement('span', { className: 'text-xs text-muted-foreground' }, `v${workItem.version}`),
        readonly && onRestore
          ? createElement(
              Button,
              {
                type: 'button',
                variant: 'outline',
                size: 'sm',
                disabled: pending,
                'aria-label': 'Restore work item',
                ...({ 'data-work-item-restore': true } as unknown as Record<string, never>),
                onClick: () => void restore(),
              },
              '恢复',
            )
          : null,
        !readonly && onTrash
          ? createElement(
              Button,
              {
                type: 'button',
                variant: 'ghost',
                size: 'sm',
                disabled: pending,
                'aria-label': 'Move work item to trash',
                ...({ 'data-work-item-trash': true } as unknown as Record<string, never>),
                onClick: () => void trash(),
              },
              '移至回收站',
            )
          : null,
      ),
    ),
    readonly
      ? createElement(
          'p',
          { role: 'status', className: 'border-b bg-muted/40 py-2 text-sm text-muted-foreground', 'data-archived-banner': true },
          '该工作项已在回收站中。',
        )
      : null,
    visibleError
      ? createElement('p', { role: 'alert', className: 'border-b py-3 text-sm text-destructive' }, visibleError)
      : null,
    // 父子完成护栏的前置提示：域规则（带未完成子项不能直接完成）是后端强制的，
    // 但以前它只在用户点了完成、收到报错之后才以弹窗形式出现。这里把它提前
    // 摆出来，让用户在动手前就知道会发生什么。
    (openChildCount ?? 0) > 0
      ? createElement(
          'p',
          {
            role: 'status',
            'data-open-children-hint': true,
            className: 'border-b bg-amber-50 px-4 py-2 text-sm text-amber-800',
          },
          workItem.depth === 2
            ? `还有 ${openChildCount} 个未完成的子项 —— 标记「已完成」前需要先处理（取消 / 移动 / 完成）。`
            : `包含 ${openChildCount} 个未完成的子项。`,
        )
      : null,
    statusHint ?? null,
    createElement(
      'section',
      { 'aria-label': 'Edit work item', className: 'grid gap-3 border-b py-4' },
      createElement(
        'div',
        { className: 'grid gap-1' },
        createElement('label', { htmlFor: 'wi-title', className: 'text-xs font-medium text-muted-foreground' }, '标题'),
        createElement('input', {
          id: 'wi-title', className: 'h-9 rounded-md border bg-background px-3 text-sm outline-none',
          value: name, disabled: pending || readonly,
          onChange: (event: React.ChangeEvent<HTMLInputElement>) => setName(event.target.value),
        }),
      ),
      createElement(
        'div',
        { className: 'grid gap-1' },
        createElement('label', { htmlFor: 'wi-description', className: 'text-xs font-medium text-muted-foreground' }, '描述'),
        createElement('textarea', {
          id: 'wi-description', className: 'min-h-20 rounded-md border bg-background px-3 py-2 text-sm outline-none',
          value: description, disabled: pending || readonly,
          onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => setDescription(event.target.value),
        }),
      ),
      createElement(
        'div',
        { className: 'grid gap-1' },
        createElement('label', { htmlFor: 'wi-priority', className: 'text-xs font-medium text-muted-foreground' }, '优先级'),
        // ★ 2026-09-11：自由文本改为受限选择。以前用户输入「高」会被前端、
        // API（只限长度）双双放行，最后撞 DB CHECK 得到不可读的 500；现在
        // 选项即值域（与后端 contracts 同源），存储值恒为英文规范值，
        // 中文标签只出现在展示层。
        createElement(
          'select',
          {
            id: 'wi-priority',
            className: 'h-9 rounded-md border bg-background px-2 text-sm outline-none',
            value: priority,
            disabled: pending || readonly,
            // 选项由 WORK_ITEM_PRIORITY_VALUES 生成，这里的断言只是 DOM 边界的窄化。
            onChange: (event: React.ChangeEvent<HTMLSelectElement>) => (
              setPriority(event.target.value as WorkItemPriority | '')
            ),
          },
          createElement('option', { value: '' }, '未设置'),
          WORK_ITEM_PRIORITY_VALUES.map((value) => createElement(
            'option',
            { key: value, value },
            PRIORITY_LABELS[value],
          )),
        ),
      ),
      createElement(
        'div',
        { className: 'flex items-center gap-3' },
        createElement(
          Button,
          {
            type: 'button',
            size: 'sm',
            disabled: pending || readonly || !onUpdate || !dirty,
            ...({ 'data-save-changes': true } as unknown as Record<string, never>),
            onClick: () => void save(),
          },
          '保存更改',
        ),
        dirty
          ? createElement(
              'span',
              { 'data-dirty-hint': true, className: 'text-xs text-amber-600' },
              '有未保存的更改',
            )
          : createElement(
              'span',
              { className: 'text-xs text-muted-foreground' },
              '更改会立即保存到本地并同步',
            ),
      ),
    ),
    createElement(
      'dl',
      { className: 'grid gap-3 border-b py-4 sm:grid-cols-2' },
      createElement(
        'div',
        { className: 'grid grid-cols-[auto_1fr] items-center gap-3 text-sm' },
        createElement('dt', { className: 'text-muted-foreground' }, '状态'),
        createElement(
          'dd',
          { className: 'min-w-0' },
          createElement(
            'select',
            {
              'aria-label': '状态',
              className: 'h-9 w-full rounded-md border bg-background px-2 text-sm outline-none',
              value: workItem.statusDefinitionId,
              disabled: pending || readonly || !onTransition,
              onChange: (event: React.ChangeEvent<HTMLSelectElement>) => void changeStatus(event.target.value),
            },
            statusOptions.length === 0
              ? createElement('option', { value: workItem.statusDefinitionId }, workItem.statusDefinitionId)
              : statusOptions.map((status) => createElement(
                  'option',
                  { key: String(status.id), value: String(status.id) },
                  String(status.label ?? status.name ?? status.id),
                )),
          ),
        ),
      ),
      createElement(
        'div',
        { className: 'grid grid-cols-[auto_1fr] items-center gap-3 text-sm' },
        createElement('dt', { className: 'text-muted-foreground' }, '类型'),
        createElement('dd', { className: 'truncate' }, definitionLabel(definitions, 'types', workItem.typeDefinitionId)),
      ),
      createElement(
        'div',
        { className: 'grid grid-cols-[auto_1fr] items-center gap-3 text-sm' },
        createElement('dt', { className: 'text-muted-foreground' }, '父任务'),
        createElement(
          'dd',
          { className: 'min-w-0' },
          createElement(
            'select',
            {
              'aria-label': '父任务',
              className: 'h-9 w-full rounded-md border bg-background px-2 text-sm outline-none',
              value: workItem.parentId ?? '',
              disabled: pending || readonly || !onMove,
              onChange: (event: React.ChangeEvent<HTMLSelectElement>) => void changeParent(event.target.value),
            },
            createElement('option', { value: '' }, 'No parent'),
            availableParents.map((parent) => createElement(
              'option',
              { key: parent.id, value: parent.id },
              `${parent.displayKey} ${parent.title}`,
            )),
          ),
        ),
      ),
      createElement(
        'div',
        { className: 'grid grid-cols-[auto_1fr] gap-3 text-sm' },
        createElement('dt', { className: 'text-muted-foreground' }, '投入'),
        createElement(
          'dd',
          null,
          formatEffortSeconds(workItem.effortActualSeconds),
          effortEstimate ? createElement(
            'span',
            { className: 'text-muted-foreground' },
            `（估算 ${effortEstimate}）`,
          ) : null,
        ),
      ),
    ),
    createElement(
      'dl',
      { className: 'grid gap-2 border-b py-4' },
      timing('完成窗口开始', formatTimestamp(workItem.completionWindowStart)),
      timing('完成窗口结束', formatTimestamp(workItem.completionWindowEnd)),
      timing('回顾点', formatTimestamp(workItem.reviewPoint)),
      timing('硬截止', formatTimestamp(workItem.hardDeadline)),
      timing('创建于', formatTimestamp(workItem.createdAt), formatRelativeTime(workItem.createdAt)),
      timing('更新于', formatTimestamp(workItem.updatedAt), formatRelativeTime(workItem.updatedAt)),
    ),
    createElement(
      'section',
      { 'aria-label': 'Work item labels', className: 'grid gap-2 border-b py-4' },
      createElement('h2', { className: 'text-sm font-medium text-muted-foreground' }, '标签'),
      createElement(
        'div',
        { className: 'flex flex-wrap items-center gap-1.5' },
        applied.map((label) => {
          const labelId = String(label.id)
          return createElement(
            'span',
            { key: labelId, className: 'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs' },
            labelName(label),
            !readonly && onToggleLabel
              ? createElement('button', {
                  type: 'button',
                  'aria-label': `Remove label ${labelName(label)}`,
                  disabled: pending,
                  className: 'text-muted-foreground hover:text-destructive',
                  onClick: () => void toggleLabel(labelId, false),
                }, '×')
              : null,
          )
        }),
        createElement(
          'select',
          {
            'aria-label': '添加标签',
            className: 'h-8 rounded-md border bg-background px-2 text-xs outline-none',
            defaultValue: '',
            disabled: pending || readonly || !onToggleLabel || available.length === 0,
            onChange: (event: React.ChangeEvent<HTMLSelectElement>) => {
              const labelId = event.target.value
              if (labelId) void toggleLabel(labelId, true)
              event.target.value = ''
            },
          },
          createElement('option', { value: '' }, available.length === 0 ? 'No labels' : 'Add label…'),
          available.map((label) => (
            createElement('option', { key: String(label.id), value: String(label.id) }, labelName(label))
          )),
        ),
      ),
    ),
    relationsCard ?? null,
    // Effort review sits between the basic form and the note editor: level-2
    // items are the review unit (highlighted), level-3 items show it muted.
    workItem.depth >= 2
      ? createElement(EffortReviewCard, {
          key: `effort-${workItem.id}`,
          workItem,
          highlighted: workItem.depth === 2,
        })
      : null,
    createElement(
      'section',
      {
        'aria-label': 'Work item note editor',
        'data-note-editor-mount': true,
        'data-work-item-id': workItem.id,
        className: 'min-w-0 pt-4',
      },
      noteEditor ?? createElement(
        'div',
        { className: 'rounded-md border border-dashed p-4 text-sm text-muted-foreground' },
        '暂无笔记 —— 在下方输入即可开始记录，支持段落与勾选清单。',
      ),
    ),
  )
}
