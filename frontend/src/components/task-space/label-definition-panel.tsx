'use client'

import { useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { labelSchema, type Label } from '@/lib/contracts/task-space'

/**
 * 标签定义管理面板（D5 Y 接续，2026-10-04）。
 *
 * ★ 为什么这个面板现在才存在
 *   后端 3 个命令（Create/Update/ArchiveLabel）+ REST 3 端点 + repository 3 方法
 *   + resume 重放注册**早就齐全**，详情页的标签 chips 与 add-select 也早就画好了
 *   （work-item-detail.tsx）。唯独缺「**建标签的入口**」——
 *   于是 `definitions.labels` 恒为空，add-select 永远没有选项，
 *   库里 6 个空间的 `labels` 表**全是 0 行**。
 *   ⇒ 「0 使用」是「0 入口」的结果，不是「没需求」。别再读反了。
 *
 * ★ 标签与状态的区别（别把两者的心智模型混在一起）
 *   - 状态是**单选、互斥、驱动行为**的（进行中/等待/完成…），有固定轴，UI 不可增删；
 *   - 标签是**多选、纯标注、不改变任何行为**的：一个工作项可以同时有 5 个标签，
 *     打标签不会让它变成「进行中」，也不会影响子项完成守卫。
 *   所以这里**不分组、不重排**（标签表根本没有 rank 列，见 models/work_item_definition.py:56）。
 *
 * ★ 归档是软删除（写 `archived_at`，不物理删行）
 *   因为标签参与 sync post-image：物理删除会让对端在重放时找不到被引用行。
 *   归档后仍可作为「已应用 chip」显示，只是不能再新增选用。
 *
 * 所有写操作都**委派给上层**（onCreate / onRename / onArchive），本组件不碰 API ——
 * 离线优先的 intent/outbox 逻辑只有一处实现（在 repository）。
 */

export interface LabelDefinitionPanelProps {
  /** `definitions.labels` 的原始行（开放 record，脏数据要能扛）。 */
  rows: readonly unknown[]
  /** 已归档的默认隐藏（归档项仍会作为已应用 chip 显示在详情页）。 */
  showArchived?: boolean
  onCreate?: (input: { name: string; color?: string | null }) => void | Promise<void>
  onRename?: (input: { labelId: string; name: string }) => void | Promise<void>
  onArchive?: (input: { labelId: string }) => void | Promise<void>
  /** 归档被拒 / 名称冲突等（后端 409 label_name_conflict）的说人话提示。 */
  errorMessage?: string | null
}

/** 与状态面板同一套色板，视觉一致。 */
const PALETTE = ['#64748b', '#1d4ed8', '#6d28d9', '#059669', '#dc2626', '#d97706']

/** 脏数据防御：definitions.labels 是服务端权威的开放 record，解析失败就跳过而不是崩。 */
function readLabel(raw: unknown): Label | null {
  const parsed = labelSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}

export function LabelDefinitionPanel({
  rows,
  showArchived = false,
  onCreate,
  onRename,
  onArchive,
  errorMessage,
}: LabelDefinitionPanelProps) {
  const [creating, setCreating] = useState(false)
  const [draftName, setDraftName] = useState('')
  const [draftColor, setDraftColor] = useState<string>(PALETTE[0])
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)

  const all = useMemo(
    () =>
      rows
        .map(readLabel)
        .filter((row): row is Label => row !== null)
        .sort((a, b) => a.name.localeCompare(b.name)),
    [rows],
  )
  const visible = useMemo(
    () => (showArchived ? all : all.filter((row) => row.archivedAt == null)),
    [all, showArchived],
  )
  const archivedCount = all.length - all.filter((row) => row.archivedAt == null).length

  const startCreate = () => {
    setCreating(true)
    setDraftName('')
    setDraftColor(PALETTE[all.length % PALETTE.length] ?? PALETTE[0])
    setRenamingId(null)
  }

  const submitCreate = async () => {
    const name = draftName.trim()
    if (!name || !onCreate) return
    setBusyId('__create__')
    try {
      await onCreate({ name, color: draftColor })
      setCreating(false)
      setDraftName('')
    } finally {
      setBusyId(null)
    }
  }

  const submitRename = async (row: Label) => {
    const name = renameDraft.trim()
    if (!name || name === row.name || !onRename) {
      setRenamingId(null)
      return
    }
    setBusyId(row.id)
    try {
      // ★ 不传 expectedVersion：repository 从本地缓存行自取（走服务端 CAS）。
      await onRename({ labelId: row.id, name })
      setRenamingId(null)
    } finally {
      setBusyId(null)
    }
  }

  const doArchive = async (row: Label) => {
    if (!onArchive) return
    setBusyId(row.id)
    try {
      await onArchive({ labelId: row.id })
    } finally {
      setBusyId(null)
    }
  }

  return (
    <section
      aria-label="标签定义管理"
      data-testid="label-definition-panel"
      className="flex flex-col gap-4"
    >
      <header className="flex items-baseline justify-between gap-3">
        <div>
          <h2 className="text-sm font-medium">标签</h2>
          <p className="text-xs text-muted-foreground">
            共 {all.filter((row) => row.archivedAt == null).length} 个
            {archivedCount > 0 ? `（另有 ${archivedCount} 个已归档）` : ''} · 标签是
            <b>多选标注</b>，不改变工作项状态
          </p>
        </div>
        <Button
          type="button"
          size="xs"
          variant="ghost"
          data-testid="label-add"
          disabled={!onCreate || creating}
          onClick={startCreate}
        >
          + 新建标签
        </Button>
      </header>

      {errorMessage ? (
        <p
          role="alert"
          data-testid="label-definition-error"
          className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          {errorMessage}
        </p>
      ) : null}

      {creating ? (
        <div
          data-testid="label-create-form"
          className="flex flex-col gap-2 rounded-lg border p-3"
        >
          <Input
            autoFocus
            value={draftName}
            aria-label="标签名称"
            placeholder="例如：重要 / 本周 / 等待回复"
            data-testid="label-create-name"
            onChange={(e) => setDraftName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submitCreate()
              if (e.key === 'Escape') setCreating(false)
            }}
            className="h-8"
          />
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1" role="group" aria-label="标签颜色">
              {PALETTE.map((color) => (
                <button
                  key={color}
                  type="button"
                  aria-label={`颜色 ${color}`}
                  aria-pressed={draftColor === color}
                  data-testid={`label-color-${color}`}
                  onClick={() => setDraftColor(color)}
                  className={
                    draftColor === color
                      ? 'size-5 rounded-full ring-2 ring-offset-2 ring-foreground/40'
                      : 'size-5 rounded-full'
                  }
                  style={{ backgroundColor: color }}
                />
              ))}
            </div>
            <div className="ml-auto flex items-center gap-1">
              <Button
                type="button"
                size="xs"
                variant="ghost"
                onClick={() => setCreating(false)}
                disabled={busyId === '__create__'}
              >
                取消
              </Button>
              <Button
                type="button"
                size="xs"
                data-testid="label-create-submit"
                onClick={() => void submitCreate()}
                disabled={!draftName.trim() || busyId === '__create__'}
              >
                创建
              </Button>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            标签名在空间内唯一（后端唯一约束），重名会被拒绝。
          </p>
        </div>
      ) : null}

      <ul className="flex flex-col gap-1" data-testid="label-list">
        {visible.length === 0 && !creating ? (
          <li
            data-testid="label-empty"
            className="rounded-md border border-dashed px-3 py-4 text-xs text-muted-foreground"
          >
            {all.length === 0
              ? '还没有标签。建一个（如「重要」「本周」）后，就能在工作项详情里给它打标；标签可多选，不影响状态。'
              : '当前没有未归档的标签。勾选「显示已归档」可查看。'}
          </li>
        ) : null}

        {visible.map((row) => {
          const isRenaming = renamingId === row.id
          const busy = busyId === row.id
          return (
            <li
              key={row.id}
              data-testid={`label-row-${row.id}`}
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
                  aria-label="标签名称"
                  data-testid={`label-rename-input-${row.id}`}
                  onChange={(e) => setRenameDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void submitRename(row)
                    if (e.key === 'Escape') setRenamingId(null)
                  }}
                  className="h-7 flex-1"
                />
              ) : (
                <span
                  className="min-w-0 flex-1 truncate text-sm"
                  data-testid={`label-name-${row.id}`}
                >
                  {row.name}
                  {row.archivedAt ? (
                    <span className="ml-2 text-xs text-muted-foreground">已归档</span>
                  ) : null}
                </span>
              )}

              {isRenaming ? (
                <>
                  <Button
                    type="button"
                    size="xs"
                    data-testid={`label-rename-save-${row.id}`}
                    disabled={!renameDraft.trim() || busy}
                    onClick={() => void submitRename(row)}
                  >
                    保存
                  </Button>
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    onClick={() => setRenamingId(null)}
                    disabled={busy}
                  >
                    取消
                  </Button>
                </>
              ) : (
                <>
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    data-testid={`label-rename-${row.id}`}
                    disabled={!onRename || busy || row.archivedAt != null}
                    onClick={() => {
                      setRenamingId(row.id)
                      setRenameDraft(row.name)
                      setCreating(false)
                    }}
                  >
                    改名
                  </Button>
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    data-testid={`label-archive-${row.id}`}
                    disabled={!onArchive || busy || row.archivedAt != null}
                    onClick={() => void doArchive(row)}
                  >
                    归档
                  </Button>
                </>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}
