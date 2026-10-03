'use client'

import { useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  STATUS_CATEGORY_VALUES,
  readStatusDefinition,
  type StatusCategoryValue,
  type StatusDefinition,
} from '@/lib/contracts/task-space'

/**
 * 状态定义管理面板（状态双轴阶段 3）。
 *
 * ★ 双轴的心智模型在 UI 上必须**可见**，否则用户会把 status 当成 category：
 *   - 左列是**固定轴**（5 个 category，不可增删 —— 由服务端 CHECK 与编译器保证）；
 *   - 每个 category 下可挂**多条 status**（用户可自定义的只有这些）。
 *   - 每组的第一行若是 `system` 行，标「系统」且**不可删/不可改名**
 *     （它是该category 的语义锚点：会话完成/取消、报表聚合都按它找）。
 *
 * ★ 为什么不给 category 加"新建"按钮
 *   固定轴不是用户能扩展的 —— 那是阶段 1 迁移（017）的事。加了按钮就会
 *   产生"点了没反应"或"到后端才报错"的体验。UI 上明确表达"这层不可改"。
 *
 * 所有写操作都**委派给上层**（`onCreate` / `onRename` / `onArchive` / `onReorder`），
 * 本组件不直接调 API —— 这样离线优先的 intent/outbox 逻辑只有一处实现。
 */

export interface StatusDefinitionPanelProps {
  /** `definitions.statuses` 的原始行（开放 record，脏数据要能扛）。 */
  rows: readonly unknown[]
  /** 已归档的（默认隐藏）。 */
  showArchived?: boolean
  onCreate?: (input: {
    name: string
    category: StatusCategoryValue
    color?: string | null
  }) => void | Promise<void>
  onRename?: (input: {
    statusId: string
    name: string
    expectedVersion: number
  }) => void | Promise<void>
  onArchive?: (input: { statusId: string; expectedVersion: number }) => void | Promise<void>
  /** 集合级重排：把 statusId 移到同category 内的第index 位。 */
  onReorder?: (input: { statusId: string; rank: number }) => void | Promise<void>
  /** 归档被拒（409 status_definition_in_use 等）时的提示。 */
  errorMessage?: string | null
}

const CATEGORY_LABELS: Record<StatusCategoryValue, string> = {
  not_started: '待投入',
  in_progress: '进行中',
  waiting: '等待',
  completed: '已结束-完成',
  cancelled: '已结束-取消',
}

const CATEGORY_HINTS: Record<StatusCategoryValue, string> = {
  not_started: '还没开始',
  in_progress: '正在做或已暂停',
  waiting: '卡在别人身上（可记录等待前态）',
  completed: '做完了',
  cancelled: '主动放弃（≠完成，依赖它的人仍被阻塞）',
}

const PALETTE = ['#64748b', '#1d4ed8', '#6d28d9', '#059669', '#dc2626', '#d97706']

function groupByCategory(rows: readonly unknown[]): Map<string, StatusDefinition[]> {
  const out = new Map<string, StatusDefinition[]>()
  for (const raw of rows) {
    const parsed = readStatusDefinition(raw)
    if (!parsed) continue
    const bucket = out.get(parsed.category) ?? []
    bucket.push(parsed)
    out.set(parsed.category, bucket)
  }
  for (const bucket of out.values()) {
    // 系统行排最前，其余按 rank（与后端 (rank, id) 排序一致）
    bucket.sort((a, b) => {
      if (a.system !== b.system) return a.system ? -1 : 1
      if (a.rank !== b.rank) return a.rank - b.rank
      return a.id.localeCompare(b.id)
    })
  }
  return out
}

export function StatusDefinitionPanel({
  rows,
  showArchived = false,
  onCreate,
  onRename,
  onArchive,
  onReorder,
  errorMessage,
}: StatusDefinitionPanelProps) {
  const [creating, setCreating] = useState<StatusCategoryValue | null>(null)
  const [draftName, setDraftName] = useState('')
  const [draftColor, setDraftColor] = useState<string>(PALETTE[0])
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)

  const grouped = useMemo(() => groupByCategory(rows), [rows])
  const visible = useMemo(
    () => (showArchived ? rows : rows.filter((raw) => readStatusDefinition(raw)?.archivedAt == null)),
    [rows, showArchived],
  )
  const groupedVisible = useMemo(() => groupByCategory(visible), [visible])

  const startCreate = (category: StatusCategoryValue) => {
    setCreating(category)
    setDraftName('')
    setDraftColor(PALETTE[groupedVisible.get(category)?.length ?? 0 % PALETTE.length] ?? PALETTE[0])
    setRenamingId(null)
  }

  const submitCreate = async () => {
    const name = draftName.trim()
    if (!creating || !name || !onCreate) return
    setBusyId('__create__')
    try {
      await onCreate({ name, category: creating, color: draftColor })
      setCreating(null)
      setDraftName('')
    } finally {
      setBusyId(null)
    }
  }

  const submitRename = async (row: StatusDefinition) => {
    const name = renameDraft.trim()
    if (!name || name === row.name || !onRename) {
      setRenamingId(null)
      return
    }
    setBusyId(row.id)
    try {
      await onRename({ statusId: row.id, name, expectedVersion: row.version })
      setRenamingId(null)
    } finally {
      setBusyId(null)
    }
  }

  const doArchive = async (row: StatusDefinition) => {
    if (!onArchive) return
    setBusyId(row.id)
    try {
      await onArchive({ statusId: row.id, expectedVersion: row.version })
    } finally {
      setBusyId(null)
    }
  }

  /** 上移一位（组内）。★ 集合级重排，后端刻意不锁行版本。 */
  const move = async (row: StatusDefinition, delta: number) => {
    if (!onReorder) return
    const bucket = groupedVisible.get(row.category) ?? []
    const index = bucket.findIndex((r) => r.id === row.id)
    const target = index + delta
    if (target < 0 || target >= bucket.length) return
    setBusyId(row.id)
    try {
      await onReorder({ statusId: row.id, rank: target })
    } finally {
      setBusyId(null)
    }
  }

  const total = visible.length
  const userCount = useMemo(
    () =>
      visible.filter((raw) => {
        const row = readStatusDefinition(raw)
        return row !== null && !row.system
      }).length,
    [visible],
  )

  return (
    <section
      aria-label="状态定义管理"
      data-testid="status-definition-panel"
      className="flex flex-col gap-4"
    >
      <header className="flex items-baseline justify-between gap-3">
        <div>
          <h2 className="text-sm font-medium">状态</h2>
          <p className="text-xs text-muted-foreground">
            固定轴 {STATUS_CATEGORY_VALUES.length} 类（不可增删） · 你自定义了 {userCount} 个（共{' '}
            {total} 个）
          </p>
        </div>
      </header>

      {errorMessage ? (
        <p
          role="alert"
          data-testid="status-definition-error"
          className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          {errorMessage}
        </p>
      ) : null}

      <div className="flex flex-col gap-3">
        {STATUS_CATEGORY_VALUES.map((category) => {
          const bucket = groupedVisible.get(category) ?? []
          const isCreating = creating === category
          return (
            <div
              key={category}
              data-testid={`status-group-${category}`}
              className="rounded-lg border"
            >
              <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">
                    {CATEGORY_LABELS[category]}
                    <span className="ml-2 text-xs font-normal text-muted-foreground">
                      {category}
                    </span>
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {CATEGORY_HINTS[category]}
                  </p>
                </div>
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  data-testid={`status-add-${category}`}
                  disabled={!onCreate || creating !== null}
                  onClick={() => startCreate(category)}
                >
                  + 添加
                </Button>
              </div>

              <ul className="flex flex-col gap-1 p-2">
                {bucket.length === 0 && !isCreating ? (
                  <li className="px-2 py-3 text-xs text-muted-foreground">
                    这一类还没有状态
                  </li>
                ) : null}

                {bucket.map((row, index) => {
                  const isRenaming = renamingId === row.id
                  const busy = busyId === row.id
                  return (
                    <li
                      key={row.id}
                      data-testid={`status-row-${row.id}`}
                      className="flex items-center gap-2 rounded-md px-2 py-1 hover:bg-accent/50"
                    >
                      <span
                        aria-hidden
                        className="size-2.5 shrink-0 rounded-full"
                        style={{ backgroundColor: row.color ?? '#cbd5e1' }}
                      />
                      {isRenaming ? (
                        <Input
                          autoFocus
                          value={renameDraft}
                          aria-label="状态名称"
                          data-testid={`status-rename-input-${row.id}`}
                          onChange={(e) => setRenameDraft(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') void submitRename(row)
                            if (e.key === 'Escape') setRenamingId(null)
                          }}
                          className="h-7 flex-1"
                        />
                      ) : (
                        <span className="min-w-0 flex-1 truncate text-sm">
                          {row.name}
                          {row.system ? (
                            <span
                              data-testid={`status-system-${row.id}`}
                              className="ml-2 rounded border border-dashed px-1 text-[10px] text-muted-foreground"
                            >
                              系统
                            </span>
                          ) : null}
                          {row.archivedAt ? (
                            <span className="ml-2 text-[10px] text-muted-foreground">
                              已归档
                            </span>
                          ) : null}
                        </span>
                      )}

                      <span className="flex shrink-0 items-center gap-1">
                        <Button
                          type="button"
                          size="icon-xs"
                          variant="ghost"
                          aria-label={`上移 ${row.name}`}
                          disabled={!onReorder || index === 0 || busy}
                          onClick={() => void move(row, -1)}
                        >
                          ↑
                        </Button>
                        <Button
                          type="button"
                          size="icon-xs"
                          variant="ghost"
                          aria-label={`下移 ${row.name}`}
                          disabled={
                            !onReorder || index === bucket.length - 1 || busy
                          }
                          onClick={() => void move(row, 1)}
                        >
                          ↓
                        </Button>
                        {row.system ? null : (
                          <>
                            <Button
                              type="button"
                              size="xs"
                              variant="ghost"
                              aria-label={`重命名 ${row.name}`}
                              disabled={isRenaming || busy}
                              onClick={() => {
                                setRenamingId(row.id)
                                setRenameDraft(row.name)
                              }}
                            >
                              改名
                            </Button>
                            <Button
                              type="button"
                              size="xs"
                              variant="ghost"
                              aria-label={`归档 ${row.name}`}
                              disabled={busy}
                              // 归档可能被后端 409 拒绝（有work_items 引用）——
                              // 错误由上层捕获后经 errorMessage 透出。
                              onClick={() => void doArchive(row)}
                            >
                              归档
                            </Button>
                          </>
                        )}
                        {isRenaming ? (
                          <Button
                            type="button"
                            size="xs"
                            variant="ghost"
                            onClick={() => void submitRename(row)}
                            disabled={busy}
                          >
                            保存
                          </Button>
                        ) : null}
                      </span>
                    </li>
                  )
                })}

                {isCreating ? (
                  <li className="flex flex-col gap-2 rounded-md border border-dashed p-2">
                    <Input
                      autoFocus
                      value={draftName}
                      aria-label="新状态名称"
                      placeholder={`在「${CATEGORY_LABELS[creating]}」下新建`}
                      data-testid={`status-create-input-${creating}`}
                      onChange={(e) => setDraftName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void submitCreate()
                        if (e.key === 'Escape') setCreating(null)
                      }}
                      className="h-7"
                    />
                    <div className="flex items-center gap-2">
                      <div className="flex items-center gap-1">
                        {PALETTE.map((color) => (
                          <button
                            key={color}
                            type="button"
                            aria-label={`颜色 ${color}`}
                            aria-pressed={draftColor === color}
                            onClick={() => setDraftColor(color)}
                            className="size-4 rounded-full border-2"
                            style={{
                              backgroundColor: color,
                              borderColor:
                                draftColor === color ? '#1f2937' : 'transparent',
                            }}
                          />
                        ))}
                      </div>
                      <span className="ml-auto flex gap-1">
                        <Button
                          type="button"
                          size="xs"
                          variant="ghost"
                          onClick={() => setCreating(null)}
                        >
                          取消
                        </Button>
                        <Button
                          type="button"
                          size="xs"
                          disabled={!draftName.trim() || busyId === '__create__'}
                          onClick={() => void submitCreate()}
                        >
                          创建
                        </Button>
                      </span>
                    </div>
                  </li>
                ) : null}
              </ul>
            </div>
          )
        })}
      </div>
    </section>
  )
}
