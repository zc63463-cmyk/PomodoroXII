'use client'

import { createElement, useEffect, useMemo, useState } from 'react'
import {
  ArchiveRestoreIcon,
  FileTextIcon,
  FolderIcon,
  NotebookTextIcon,
  RefreshCwIcon,
  Trash2Icon,
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { useTrashStore } from '@/stores/trash-store'
import type { Folder, Note, QuickNote } from '@/types'

type TrashEntityKind = 'note' | 'quickNote' | 'folder'
type PendingAction = 'restore' | 'purge' | 'empty'

interface TrashItem {
  id: string
  kind: TrashEntityKind
  title: string
  description: string
  trashedAt: string | null
  updatedAt: string
}

const KIND_LABEL: Record<TrashEntityKind, string> = {
  note: '笔记',
  quickNote: '小记',
  folder: '文件夹',
}

export function TrashView() {
  const {
    trashedNotes,
    trashedQuickNotes,
    trashedFolders,
    isLoading,
    error,
    loadTrashed,
    restoreNote,
    restoreQuickNote,
    restoreFolder,
    purgeNote,
    purgeQuickNote,
    purgeFolder,
    emptyTrash,
  } = useTrashStore()
  const [pendingByKey, setPendingByKey] = useState<Record<string, PendingAction>>({})

  useEffect(() => {
    void loadTrashed().catch(() => undefined)
  }, [loadTrashed])

  const items = useMemo(
    () =>
      [
        ...trashedNotes.map(toNoteTrashItem),
        ...trashedQuickNotes.map(toQuickNoteTrashItem),
        ...trashedFolders.map(toFolderTrashItem),
      ].sort((left, right) =>
        (right.trashedAt ?? right.updatedAt).localeCompare(left.trashedAt ?? left.updatedAt),
      ),
    [trashedFolders, trashedNotes, trashedQuickNotes],
  )
  const hasTrash = items.length > 0
  const isBusy = isLoading || Object.keys(pendingByKey).length > 0

  async function runItemAction(
    item: TrashItem,
    action: 'restore' | 'purge',
  ): Promise<void> {
    const key = itemKey(item)
    if (pendingByKey[key]) return
    setPendingByKey((current) => ({ ...current, [key]: action }))
    try {
      if (action === 'restore') {
        await restoreItem(item)
        toast(`${KIND_LABEL[item.kind]}已恢复`)
      } else {
        await purgeItem(item)
        toast(`${KIND_LABEL[item.kind]}已彻底删除`)
      }
    } catch (caught) {
      toast.error(action === 'restore' ? '恢复失败' : '彻底删除失败', {
        description: caught instanceof Error ? caught.message : '请稍后重试',
      })
    } finally {
      setPendingByKey((current) => clearPending(current, key))
    }
  }

  async function restoreItem(item: TrashItem): Promise<void> {
    if (item.kind === 'note') await restoreNote(item.id)
    else if (item.kind === 'quickNote') await restoreQuickNote(item.id)
    else await restoreFolder(item.id)
  }

  async function purgeItem(item: TrashItem): Promise<void> {
    if (item.kind === 'note') await purgeNote(item.id)
    else if (item.kind === 'quickNote') await purgeQuickNote(item.id)
    else await purgeFolder(item.id)
  }

  async function handleEmptyTrash(): Promise<void> {
    if (!hasTrash || pendingByKey.__empty) return
    setPendingByKey((current) => ({ ...current, __empty: 'empty' }))
    try {
      await emptyTrash()
      toast('回收站已清空')
    } catch (caught) {
      toast.error('清空回收站失败', {
        description: caught instanceof Error ? caught.message : '请稍后重试',
      })
    } finally {
      setPendingByKey((current) => clearPending(current, '__empty'))
    }
  }

  return createElement(
    'main',
    { className: 'min-h-full bg-background px-4 py-6 sm:px-6 lg:px-8' },
    createElement(
      'section',
      { className: 'mx-auto flex w-full max-w-5xl flex-col gap-5' },
      createHeader({ hasTrash, isBusy, loadTrashed, handleEmptyTrash }),
      error
        ? createElement(
            'div',
            {
              className:
                'rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive',
            },
            error,
          )
        : null,
      createElement(
        'div',
        { className: 'grid gap-3 sm:grid-cols-3' },
        createElement(TrashMetric, { label: '笔记', value: trashedNotes.length }),
        createElement(TrashMetric, { label: '小记', value: trashedQuickNotes.length }),
        createElement(TrashMetric, { label: '文件夹', value: trashedFolders.length }),
      ),
      isLoading && !hasTrash
        ? createElement(TrashEmptyState, {
            title: '正在读取回收站',
            description: '稍等一下，正在从本地资料库整理已删除项目。',
          })
        : hasTrash
          ? createElement(
              'div',
              { className: 'grid gap-3' },
              ...items.map((item) =>
                createElement(TrashItemCard, {
                  key: itemKey(item),
                  item,
                  isBusy,
                  pending: pendingByKey[itemKey(item)],
                  onAction: runItemAction,
                }),
              ),
            )
          : createElement(TrashEmptyState, {
              title: '回收站是空的',
              description: '删除的笔记、小记和文件夹会出现在这里。',
            }),
    ),
  )
}

function createHeader({
  hasTrash,
  isBusy,
  loadTrashed,
  handleEmptyTrash,
}: {
  hasTrash: boolean
  isBusy: boolean
  loadTrashed: () => Promise<void>
  handleEmptyTrash: () => Promise<void>
}) {
  return createElement(
    'header',
    { className: 'flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between' },
    createElement(
      'div',
      null,
      createElement(
        'p',
        {
          className:
            'text-xs font-medium tracking-[0.24em] text-muted-foreground uppercase',
        },
        'Trash',
      ),
      createElement(
        'h1',
        { className: 'mt-1 text-3xl font-semibold tracking-tight text-foreground' },
        '回收站',
      ),
      createElement(
        'p',
        { className: 'mt-2 max-w-2xl text-sm leading-6 text-muted-foreground' },
        '统一管理已移除的笔记、小记和文件夹。恢复会回到原列表，彻删会从本地资料库移除。',
      ),
    ),
    createElement(
      'div',
      { className: 'flex flex-wrap gap-2' },
      createElement(
        Button,
        {
          type: 'button',
          variant: 'outline',
          onClick: () => void loadTrashed(),
          disabled: isBusy,
        },
        createElement(RefreshCwIcon),
        '刷新',
      ),
      createElement(
        Button,
        {
          type: 'button',
          variant: 'destructive',
          onClick: () => void handleEmptyTrash(),
          disabled: !hasTrash || isBusy,
        },
        createElement(Trash2Icon),
        '清空回收站',
      ),
    ),
  )
}

function TrashMetric({ label, value }: { label: string; value: number }) {
  return createElement(
    Card,
    { size: 'sm' },
    createElement(
      CardContent,
      { className: 'flex items-center justify-between' },
      createElement('span', { className: 'text-sm text-muted-foreground' }, label),
      createElement('strong', { className: 'text-2xl font-semibold text-foreground' }, value),
    ),
  )
}

function TrashItemCard({
  item,
  isBusy,
  pending,
  onAction,
}: {
  item: TrashItem
  isBusy: boolean
  pending?: PendingAction
  onAction: (item: TrashItem, action: 'restore' | 'purge') => Promise<void>
}) {
  return createElement(
    Card,
    { size: 'sm' },
    createElement(
      CardHeader,
      { className: 'border-b' },
      createElement(
        CardTitle,
        { className: 'flex min-w-0 items-center gap-2' },
        kindIcon(item.kind),
        createElement('span', { className: 'truncate' }, item.title),
      ),
      createElement(
        CardDescription,
        null,
        `${KIND_LABEL[item.kind]} · 删除于 ${formatTime(item.trashedAt)}`,
      ),
      createElement(
        CardAction,
        { className: 'flex gap-2' },
        createElement(
          Button,
          {
            type: 'button',
            variant: 'outline',
            size: 'sm',
            onClick: () => void onAction(item, 'restore'),
            disabled: isBusy,
            'aria-label': `恢复${KIND_LABEL[item.kind]} ${item.title}`,
          },
          createElement(ArchiveRestoreIcon),
          pending === 'restore' ? '恢复中' : '恢复',
        ),
        createElement(
          Button,
          {
            type: 'button',
            variant: 'destructive',
            size: 'sm',
            onClick: () => void onAction(item, 'purge'),
            disabled: isBusy,
            'aria-label': `彻删${KIND_LABEL[item.kind]} ${item.title}`,
          },
          createElement(Trash2Icon),
          pending === 'purge' ? '删除中' : '彻删',
        ),
      ),
    ),
    createElement(
      CardContent,
      null,
      createElement(
        'p',
        { className: 'line-clamp-2 text-sm leading-6 text-muted-foreground' },
        item.description,
      ),
    ),
  )
}

function TrashEmptyState({
  title,
  description,
}: {
  title: string
  description: string
}) {
  return createElement(
    'div',
    {
      className:
        'rounded-2xl border border-dashed border-border bg-muted/30 px-6 py-14 text-center',
    },
    createElement('h2', { className: 'text-base font-semibold text-foreground' }, title),
    createElement('p', { className: 'mt-2 text-sm text-muted-foreground' }, description),
  )
}

function toNoteTrashItem(note: Note): TrashItem {
  return {
    id: note.id,
    kind: 'note',
    title: note.title || '未命名笔记',
    description: note.summary || firstLine(note.content) || '没有预览内容',
    trashedAt: note.trashed_at,
    updatedAt: note.updated_at,
  }
}

function toQuickNoteTrashItem(note: QuickNote): TrashItem {
  return {
    id: note.id,
    kind: 'quickNote',
    title: firstLine(note.content) || '未命名小记',
    description: note.content,
    trashedAt: note.trashed_at,
    updatedAt: note.updated_at,
  }
}

function toFolderTrashItem(folder: Folder): TrashItem {
  return {
    id: folder.id,
    kind: 'folder',
    title: folder.name || '未命名文件夹',
    description: folder.is_system ? '系统文件夹' : '文件夹',
    trashedAt: folder.trashed_at,
    updatedAt: folder.updated_at,
  }
}

function firstLine(value: string): string {
  return value.split(/\r?\n/).find((line) => line.trim())?.trim() ?? ''
}

function itemKey(item: TrashItem): string {
  return `${item.kind}:${item.id}`
}

function clearPending<T extends Record<string, unknown>>(pending: T, key: string): T {
  const next = { ...pending }
  delete next[key]
  return next
}

function kindIcon(kind: TrashEntityKind) {
  if (kind === 'note') {
    return createElement(NotebookTextIcon, {
      className: 'size-4 shrink-0 text-muted-foreground',
    })
  }
  if (kind === 'folder') {
    return createElement(FolderIcon, {
      className: 'size-4 shrink-0 text-muted-foreground',
    })
  }
  return createElement(FileTextIcon, {
    className: 'size-4 shrink-0 text-muted-foreground',
  })
}

function formatTime(iso: string | null): string {
  if (!iso) return '未知时间'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '未知时间'
  return date.toLocaleString('zh-CN', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}
