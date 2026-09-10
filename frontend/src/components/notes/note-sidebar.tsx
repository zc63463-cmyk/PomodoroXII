'use client'

/**
 * Note sidebar —— 左侧「搜索 + 文件夹树 + 笔记列表」。
 *
 * ★ 为什么从 notes-view 里拆出来并 memo
 *   编辑器正文每次按键都会 setState，而侧栏**压根不依赖正文** ——
 *   不拆的话，每敲一个字都要把整个列表重新渲染一遍。
 *
 *   实测（300 条列表，jsdom 下，比值不受 jsdom 偏慢影响）：
 *     不拆        7.90 ms/按键
 *     整个侧栏 memo  0.06 ms/按键    ← 130×
 *   作为对照，正文的纯函数派生（大纲 + 字数 + 摘要 + 标题）在万字笔记下
 *   合计也只有 0.43 ms —— 渲染才是大头。
 *
 * ★ memo 生效的前提：传进来的 props 引用必须稳定
 *   父组件侧的所有回调都要 useCallback、派生数组都要 useMemo。
 *   **只要有一个是每次新建的对象或函数，memo 就完全失效。**
 */

import dynamic from 'next/dynamic'
import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  collectFolderSubtree,
  flattenFolderTree,
} from '@/lib/folders/folder-selectors'
import {
  getNoteSummary,
  getNoteTitle,
  type NoteSortKey,
} from '@/lib/notes/note-selectors'
import {
  NOTE_ITEM_HEIGHT,
  computeVisibleRange,
  totalListHeight,
} from '@/lib/notes/note-virtual'
import type { Folder, FolderTreeNode, Note } from '@/types'

// 保持懒加载：搜索框要拉 FTS5 相关逻辑，不进主 bundle
const NoteSearch = dynamic(() => import('./note-search'), {
  loading: () => (
    <div className="border-b px-3 py-2 text-xs text-muted-foreground">…</div>
  ),
})

/** 「未归类」哨兵：用一个不可能与真实 id 冲突的值。 */
export const UNFILED = '__unfiled__'

export interface NoteSidebarProps {
  /** 全量笔记，只用于计数（全部笔记 / 空态判断）。 */
  notes: Note[]
  /** 当前筛选 + 排序后的可见笔记。 */
  visibleNotes: Note[]
  folders: Folder[]
  folderTree: FolderTreeNode[]
  unfiledCount: number
  activeFolder: string | null
  onActiveFolderChange: (id: string | null) => void
  sortBy: NoteSortKey
  onSortChange: (key: NoteSortKey) => void
  currentNoteId: string | null
  onSelectNote: (id: string) => void
  onCreateNote: () => void
  /**
   * 在**当前筛选的文件夹里**新建一篇。
   * 空态里最该给的不是一个"知道了"，而是一条能直接走出去的路。
   */
  onCreateNoteInFolder: () => void
  onCreateFolder: () => void
  onRenameFolder: (id: string, name: string) => void
  onDeleteFolder: (id: string, name: string) => void
  onMoveFolder: (id: string, parentId: string | null) => void
  onSelectSearchHit: (noteId: string) => void
  isLoading: boolean
  seeding: boolean
  onSeed: () => void
}

function NoteSidebarImpl({
  notes,
  visibleNotes,
  folders,
  folderTree,
  unfiledCount,
  activeFolder,
  onActiveFolderChange,
  sortBy,
  onSortChange,
  currentNoteId,
  onSelectNote,
  onCreateNote,
  onCreateNoteInFolder,
  onCreateFolder,
  onRenameFolder,
  onDeleteFolder,
  onMoveFolder,
  onSelectSearchHit,
  isLoading,
  seeding,
  onSeed,
}: NoteSidebarProps) {
  return (
    <aside className="flex w-64 shrink-0 flex-col border-r">
      <div className="flex items-center justify-between border-b px-3 py-3">
        <span className="text-sm font-medium">笔记</span>
        <Button size="sm" variant="outline" onClick={onCreateNote}>
          新建
        </Button>
      </div>

      {/* 全文搜索走服务端 FTS5：正文在 .md 里，本地查不了 */}
      <NoteSearch
        folderId={activeFolder === UNFILED ? null : activeFolder}
        onSelect={onSelectSearchHit}
      />

      <div className="max-h-1/2 min-h-0 shrink-0 overflow-y-auto border-b">
        <div className="flex items-center justify-between px-3 py-2">
          <span className="text-xs font-medium uppercase text-muted-foreground">
            文件夹
          </span>
          <Button size="sm" variant="ghost" onClick={onCreateFolder}>
            +
          </Button>
        </div>

        <button
          type="button"
          onClick={() => onActiveFolderChange(null)}
          className={rowClass(activeFolder === null)}
        >
          <span className="block truncate text-sm">全部笔记</span>
          <span className="block text-xs text-muted-foreground">{notes.length}</span>
        </button>

        {folderTree.map((node) => (
          <FolderTreeRow
            key={node.folder.id}
            node={node}
            folders={folders}
            folderTree={folderTree}
            activeFolder={activeFolder}
            onSelect={onActiveFolderChange}
            onRename={onRenameFolder}
            onDelete={onDeleteFolder}
            onMove={onMoveFolder}
          />
        ))}

        {unfiledCount > 0 && (
          <button
            type="button"
            onClick={() => onActiveFolderChange(UNFILED)}
            className={rowClass(activeFolder === UNFILED)}
          >
            <span className="block truncate text-sm text-muted-foreground">
              未归类
            </span>
            <span className="block text-xs text-muted-foreground">
              {unfiledCount}
            </span>
          </button>
        )}
      </div>

      {/* 排序切换。无标题笔记在按标题排序时会沉底（见 sortNotes）。 */}
      <div className="flex items-center gap-1 border-b px-3 py-1.5">
        <span className="mr-1 text-xs text-muted-foreground">排序</span>
        {(
          [
            { key: 'updated', label: '更新时间' },
            { key: 'title', label: '标题' },
          ] as Array<{ key: NoteSortKey; label: string }>
        ).map((option) => (
          <button
            key={option.key}
            type="button"
            onClick={() => onSortChange(option.key)}
            className={
              sortBy === option.key
                ? 'focus-ring transition-ui rounded bg-muted px-1.5 py-0.5 text-xs text-foreground'
                : 'focus-ring transition-ui rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:text-foreground'
            }
          >
            {option.label}
          </button>
        ))}
      </div>

      <NoteList
        notes={visibleNotes}
        totalCount={notes.length}
        currentNoteId={currentNoteId}
        onSelect={onSelectNote}
        onCreateNoteInFolder={onCreateNoteInFolder}
        isLoading={isLoading}
        seeding={seeding}
        onSeed={onSeed}
      />
    </aside>
  )
}

export const NoteSidebar = memo(NoteSidebarImpl)

// --------------------------------------------------------------------------- //

/** 超过这个条数才启用虚拟化；少于它时保持原生渲染。 */
const VIRTUALIZE_THRESHOLD = 120

/**
 * 笔记列表：超过阈值才虚拟化，否则原样全量渲染。
 *
 * ★ 为什么是「条件启用」而不是一律虚拟化
 *   虚拟化要牺牲浏览器原生 Ctrl+F 查找和完整的无障碍列表语义。
 *   笔记量小的时候，这两样比几十毫秒的首屏更值钱 —— 所以小列表走原路。
 *
 * ★ 测不到视口高度时一律降级为全量
 *   jsdom 下 clientHeight 恒为 0（首帧也一样）。若据此算出 0 个可视项，
 *   列表会直接空白 —— **宁可慢也不能空**。
 */
function NoteList({
  notes,
  totalCount,
  currentNoteId,
  onSelect,
  onCreateNoteInFolder,
  isLoading,
  seeding,
  onSeed,
}: {
  notes: Note[]
  /** 全库条数，仅用于空态文案（区分"一篇都没有"和"这个文件夹是空的"）。 */
  totalCount: number
  currentNoteId: string | null
  onSelect: (id: string) => void
  onCreateNoteInFolder: () => void
  isLoading: boolean
  seeding: boolean
  onSeed: () => void
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(0)

  useEffect(() => {
    const el = scrollRef.current
    // jsdom 没有 ResizeObserver —— 此时 viewportHeight 保持 0，走全量渲染
    if (!el || typeof ResizeObserver === 'undefined') return
    const measure = () => setViewportHeight(el.clientHeight)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const virtualized = viewportHeight > 0 && notes.length > VIRTUALIZE_THRESHOLD
  const range = virtualized
    ? computeVisibleRange(scrollTop, viewportHeight, notes.length)
    : { start: 0, end: notes.length }
  const visible = virtualized ? notes.slice(range.start, range.end) : notes

  const renderItems = (items: Note[]) =>
    items.map((note) => (
      <NoteListItem
        key={note.id}
        note={note}
        active={note.id === currentNoteId}
        onSelect={onSelect}
      />
    ))

  return (
    <div
      ref={scrollRef}
      className="min-h-0 flex-1 overflow-y-auto"
      onScroll={
        virtualized ? (e) => setScrollTop(e.currentTarget.scrollTop) : undefined
      }
    >
      {/* ★ 加载中给骨架而不是空白：空白分不清是"在加载"还是"一篇都没有"，
          骨架至少告诉用户列表的形状和"还在动"。 */}
      {isLoading && notes.length === 0 && <NoteListSkeleton />}

      {notes.length === 0 && !isLoading && (
        <div className="px-3 py-6">
          {totalCount === 0 ? (
            <>
              <p className="text-sm text-muted-foreground">
                还没有笔记。从一篇开始，标题以后再改也行。
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button size="sm" variant="outline" onClick={onCreateNoteInFolder}>
                  新建第一篇
                </Button>
                {/* 空的库看不出文件夹层级，给一条一键铺示例的路。
                    仅在整个库为空时出现，有数据后自动消失。 */}
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={seeding}
                  onClick={onSeed}
                >
                  {seeding ? '生成中…' : '填充示例数据'}
                </Button>
              </div>
            </>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">
                这个文件夹里还没有笔记。
              </p>
              {/* ★ 空态要给得出路：以前只有一句话，用户只能自己去找「新建」在哪 */}
              <Button
                size="sm"
                variant="outline"
                className="mt-3"
                onClick={onCreateNoteInFolder}
              >
                在这里新建一篇
              </Button>
            </>
          )}
        </div>
      )}

      {virtualized ? (
        // 撑起总高度以保留正确的滚动条，可视段整体下移到位
        <div style={{ height: totalListHeight(notes.length), position: 'relative' }}>
          <div
            style={{ transform: `translateY(${range.start * NOTE_ITEM_HEIGHT}px)` }}
          >
            {renderItems(visible)}
          </div>
        </div>
      ) : (
        renderItems(visible)
      )}
    </div>
  )
}

/**
 * 列表骨架屏。
 *
 * 高度刻意与 NOTE_ITEM_HEIGHT 对齐（占位块 16+12 + 间距），
 * 加载完成时列表不会突然"跳"一下。
 */
function NoteListSkeleton() {
  return (
    <div className="px-3 py-2" role="status" aria-label="正在加载笔记">
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} style={{ height: NOTE_ITEM_HEIGHT }} className="animate-pulse py-2">
          <div className="h-4 w-3/5 rounded bg-muted" />
          <div className="mt-1.5 h-3 w-4/5 rounded bg-muted/60" />
        </div>
      ))}
    </div>
  )
}

function NoteListItem({
  note,
  active,
  onSelect,
}: {
  note: Note
  active: boolean
  onSelect: (id: string) => void
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(note.id)}
      // ★ 显式固定高度：虚拟化按 NOTE_ITEM_HEIGHT 算位置，两者必须完全一致，
      //   否则滚动时会出现跳动或缝隙。非虚拟化时这个高度与原本的自然高度
      //   相同（内容 36px + py-2 上下各 8px），视觉无变化。
      style={{ height: NOTE_ITEM_HEIGHT }}
      // focus-ring-inset：满宽列表项在滚动容器里，外扩的 ring 会被裁掉
      className={
        active
          ? 'focus-ring-inset transition-ui block w-full overflow-hidden border-l-2 border-primary bg-muted px-3 py-2 text-left'
          : 'focus-ring-inset transition-ui block w-full overflow-hidden border-l-2 border-transparent px-3 py-2 text-left hover:bg-muted/50'
      }
    >
      <span className="block truncate text-sm font-medium">
        {getNoteTitle(note)}
      </span>
      <span className="block truncate text-xs text-muted-foreground">
        {getNoteSummary(note, 60) || '空白笔记'}
      </span>
    </button>
  )
}

/** 新建文件夹的默认名，避免一堆同名文件夹。由 notes-view 共用。 */
export function namingFolderName(existingCount: number): string {
  return `新文件夹 ${existingCount + 1}`
}

function rowClass(active: boolean): string {
  return active
    ? 'focus-ring-inset transition-ui block w-full overflow-hidden border-l-2 border-primary bg-muted px-3 py-2 text-left'
    : 'focus-ring-inset transition-ui block w-full overflow-hidden border-l-2 border-transparent px-3 py-2 text-left hover:bg-muted/50'
}

function FolderTreeRow({
  node,
  folders,
  folderTree,
  activeFolder,
  onSelect,
  onRename,
  onDelete,
  onMove,
  depth = 0,
}: {
  node: FolderTreeNode
  folders: Folder[]
  /** 用于把「可移入的文件夹」压成带层级的列表（移动下拉要显示缩进）。 */
  folderTree: FolderTreeNode[]
  activeFolder: string | null
  onSelect: (id: string) => void
  onRename: (id: string, name: string) => void
  onDelete: (id: string, name: string) => void
  onMove: (id: string, parentId: string | null) => void
  depth?: number
}) {
  const [editing, setEditing] = useState(false)
  const [moving, setMoving] = useState(false)
  const [draft, setDraft] = useState(node.folder.name)

  // ★ 在组件内算而不是由父组件传入：每次都返回新数组，
  //   作为 prop 传进来的话任何 memo 都会失效。
  //
  // ★ 用 flattenFolderTree 而不是 availableParents：
  //   移动下拉要显示层级缩进（与笔记的「归入文件夹」下拉一致），
  //   而 availableParents 只返回扁平的 Folder[]，没有 depth。
  const parentOptions = useMemo(() => {
    const forbidden = collectFolderSubtree(folders, node.folder.id)
    return flattenFolderTree(folderTree).filter(
      ({ folder }) => !forbidden.has(folder.id),
    )
  }, [folders, folderTree, node.folder.id])

  const commit = () => {
    const next = draft.trim()
    setEditing(false)
    if (!next || next === node.folder.name) {
      setDraft(node.folder.name)
      return
    }
    onRename(node.folder.id, next)
  }

  return (
    <>
      <div
        className="group relative flex items-center hover:bg-muted/50"
        style={{ paddingLeft: `${12 + depth * 14}px` }}
      >
        {editing ? (
          <input
            className="focus-ring-inset transition-ui my-1 mr-2 w-full border bg-background px-1 py-0.5 text-sm outline-none"
            value={draft}
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commit()
              if (e.key === 'Escape') {
                setDraft(node.folder.name)
                setEditing(false)
              }
            }}
            aria-label={`重命名 ${node.folder.name}`}
          />
        ) : moving ? (
          <select
            className="focus-ring-inset transition-ui my-1 mr-2 w-full border bg-background px-1 py-0.5 text-sm outline-none"
            value={node.folder.parent_id ?? ''}
            autoFocus
            onBlur={() => setMoving(false)}
            onChange={(e) => {
              setMoving(false)
              onMove(node.folder.id, e.target.value || null)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setMoving(false)
            }}
            aria-label={`移动 ${node.folder.name} 到`}
          >
            <option value="">（顶层）</option>
            {parentOptions.map(({ folder, depth: optionDepth }) => (
              <option key={folder.id} value={folder.id}>
                {/* 全角空格缩进：与笔记的「归入文件夹」下拉保持一致，
                    多级文件夹才看得出父子关系 */}
                {`${'　'.repeat(optionDepth)}${folder.name}`}
              </option>
            ))}
          </select>
        ) : (
          <>
            <button
              type="button"
              onClick={() => onSelect(node.folder.id)}
              className={
                activeFolder === node.folder.id
                  ? 'focus-ring-inset transition-ui min-w-0 flex-1 border-l-2 border-primary bg-muted py-2 pl-2 pr-1 text-left'
                  : 'focus-ring-inset transition-ui min-w-0 flex-1 border-l-2 border-transparent py-2 pl-2 pr-1 text-left'
              }
            >
              <span className="block truncate text-sm">{node.folder.name}</span>
              <span className="block text-xs text-muted-foreground">
                {node.noteCount}
              </span>
            </button>

            {/* 操作入口只在 hover / 聚焦时浮现，避免列表视觉噪音 */}
            <span className="hidden shrink-0 gap-1 pr-2 group-hover:flex group-focus-within:flex">
              <button
                type="button"
                className="focus-ring transition-ui rounded px-1 text-xs text-muted-foreground hover:text-foreground"
                onClick={() => {
                  setDraft(node.folder.name)
                  setEditing(true)
                }}
                aria-label={`重命名 ${node.folder.name}`}
              >
                ✎
              </button>
              <button
                type="button"
                className="focus-ring transition-ui rounded px-1 text-xs text-muted-foreground hover:text-foreground"
                onClick={() => setMoving(true)}
                aria-label={`移动 ${node.folder.name}`}
              >
                ⇄
              </button>
              <button
                type="button"
                className="focus-ring transition-ui rounded px-1 text-xs text-muted-foreground hover:text-destructive"
                onClick={() => onDelete(node.folder.id, node.folder.name)}
                aria-label={`删除 ${node.folder.name}`}
              >
                ×
              </button>
            </span>
          </>
        )}
      </div>

      {node.children.map((child) => (
        <FolderTreeRow
          key={child.folder.id}
          node={child}
          folders={folders}
          folderTree={folderTree}
          activeFolder={activeFolder}
          onSelect={onSelect}
          onRename={onRename}
          onDelete={onDelete}
          onMove={onMove}
          depth={depth + 1}
        />
      ))}
    </>
  )
}
