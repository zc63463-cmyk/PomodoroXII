'use client'

/**
 * Notes view — 方案 A 阶段 3：列表 + 编辑器 + 预览。
 *
 * 数据流是单向的：本组件只跟 useNoteStore 对话，store 再走 note-repository，
 * 最终落本地 Dexie 并入 outbox —— 这里不碰 Dexie、不发 HTTP 写请求。
 *
 * 编辑器沿用项目既有的手写方式（参照 quick-note-composer），未引入
 * CodeMirror：项目的 markdown 高亮与预览都是自研的，加一个编辑器库会
 * 带来第二套渲染逻辑。等需要语法高亮时再单独评估。
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { QuickNoteMarkdown } from '@/components/quick-notes/quick-note-markdown'
import { Button } from '@/components/ui/button'
import {
  availableParents,
  buildFolderTree,
  countUnfiledNotes,
  flattenFolderTree,
} from '@/lib/folders/folder-selectors'
import dynamic from 'next/dynamic'
import { mergeTags, sameTags } from '@/lib/notes/note-tags'
import { getNoteSummary, getNoteTitle } from '@/lib/notes/note-selectors'
import { useFolderStore } from '@/stores/folder-store'
import { useNoteStore } from '@/stores/note-store'
import type { Folder, FolderTreeNode, Note } from '@/types'

/** 自动保存防抖：既避免每次按键都入队，也不会让用户等太久。 */
const AUTOSAVE_DELAY_MS = 600

/** 「未归类」是 folder_id 为 null 的笔记，用一个不可能与真实 id 冲突的哨兵。 */
const UNFILED = '__unfiled__'

const NoteEditor = dynamic(() => import('./note-editor'), {
  ssr: false, // CodeMirror 构造 EditorView 需要 DOM，SSR 阶段会报错
  loading: () => <div className="p-4 text-sm text-muted-foreground">编辑器加载中…</div>,
})

const NoteSearch = dynamic(() => import('./note-search'), {
  loading: () => <div className="border-b px-3 py-2 text-xs text-muted-foreground">…</div>,
})

const NoteVersionPanel = dynamic(() => import('./note-version-panel'), {
  loading: () => <div className="w-64 shrink-0 border-l p-3 text-xs text-muted-foreground">历史加载中…</div>,
})

export function NotesView() {
  const notes = useNoteStore((s) => s.notes)
  const currentNoteId = useNoteStore((s) => s.currentNoteId)
  const isLoading = useNoteStore((s) => s.isLoading)
  const error = useNoteStore((s) => s.error)
  const loadNotes = useNoteStore((s) => s.loadNotes)
  const createNote = useNoteStore((s) => s.createNote)
  const updateNote = useNoteStore((s) => s.updateNote)
  const deleteNote = useNoteStore((s) => s.deleteNote)

  const folders = useFolderStore((s) => s.folders)
  const loadFolders = useFolderStore((s) => s.loadFolders)
  const createFolder = useFolderStore((s) => s.createFolder)
  const renameFolder = useFolderStore((s) => s.renameFolder)
  const moveFolder = useFolderStore((s) => s.moveFolder)
  const deleteFolder = useFolderStore((s) => s.deleteFolder)

  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [isPreview, setIsPreview] = useState(false)
  const [showVersions, setShowVersions] = useState(false)
  /** 按标签筛选。与文件夹筛选互斥：选中标签时以标签为准。 */
  const [activeTag, setActiveTag] = useState<string | null>(null)
  const [saveState, setSaveState] = useState<'idle' | 'pending' | 'saved'>('idle')
  /** null = 全部；'__unfiled__' = 未归类；其余 = 文件夹 id */
  const [activeFolder, setActiveFolder] = useState<string | null>(null)
  const [seeding, setSeeding] = useState(false)

  // 编辑中的草稿。切笔记时用它重置编辑器，避免把 A 的内容写进 B。
  const editingIdRef = useRef<string | null>(null)

  const current = useMemo(
    () => notes.find((n) => n.id === currentNoteId) ?? null,
    [notes, currentNoteId],
  )

  useEffect(() => {
    void loadNotes()
    void loadFolders()
  }, [loadNotes, loadFolders])

  const folderTree = useMemo(() => buildFolderTree(folders, notes), [folders, notes])
  const unfiledCount = useMemo(() => countUnfiledNotes(notes), [notes])
  const folderOptions = useMemo(() => flattenFolderTree(folderTree), [folderTree])

  // 按选中的文件夹筛选。字段是 folder_id，未归类即 null。
  // 标签筛选优先级更高：选中标签时以标签为准（两者同时生效会让用户困惑）。
  const visibleNotes = useMemo(() => {
    if (activeTag !== null) {
      return notes.filter((n) => (n.tags ?? []).includes(activeTag))
    }
    if (activeFolder === null) return notes
    if (activeFolder === UNFILED) return notes.filter((n) => n.folder_id == null)
    return notes.filter((n) => n.folder_id === activeFolder)
  }, [notes, activeFolder, activeTag])

  // 切换笔记时把服务端/本地的最新内容载入编辑器。
  useEffect(() => {
    if (!current) {
      editingIdRef.current = null
      setTitle('')
      setContent('')
      setSaveState('idle')
      return
    }
    if (editingIdRef.current === current.id) return
    editingIdRef.current = current.id
    setTitle(current.title)
    setContent(current.content)
    setSaveState('idle')
    setIsPreview(false)
  }, [current])

  // 防抖自动保存。outbox 会合并同一实体的连续变更，所以频繁保存
  // 不会堆出大量待推事件。
  //
  // ★ 依赖必须是**原始值**而不是 current 对象：current 每次 notes 变化
  //   都是新对象引用，把它放进依赖会让 effect 反复重跑、把防抖 timer
  //   重置 —— 表现为「一直在保存中」甚至永不落库。
  const currentId = current?.id ?? null
  const savedTitle = current?.title
  const savedContent = current?.content
  const savedTags = current?.tags

  useEffect(() => {
    if (currentId == null) return
    if (title === savedTitle && content === savedContent) return

    setSaveState('pending')
    const timer = setTimeout(() => {
      // 标签由正文的 #hashtag 推导，与速记规则一致。
      // 只在标签确实变化时才写入 —— 否则每次保存都无谓地自增 version，
      // 进而多产生一次同步事件。
      const patch: Partial<Note> = { title, content }
      const nextTags = mergeTags(savedTags, content)
      if (!sameTags(nextTags, savedTags ?? [])) patch.tags = nextTags

      void updateNote(currentId, patch).then(
        () => setSaveState('saved'),
        () => setSaveState('idle'),
      )
    }, AUTOSAVE_DELAY_MS)

    return () => clearTimeout(timer)
  }, [currentId, savedTitle, savedContent, savedTags, title, content, updateNote])

  const handleCreate = async () => {
    const note = await createNote({ title: '', content: '' })
    useNoteStore.setState({ currentNoteId: note.id })
  }

  /** Cmd/Ctrl+S：立即保存，跳过防抖。 */
  const handleSaveNow = () => {
    if (!current) return
    void updateNote(current.id, { title, content })
  }

  const handleDelete = async () => {
    if (!current) return
    await deleteNote(current.id)
  }

  const handleRenameFolder = (id: string, name: string) => {
    void renameFolder(id, name)
  }

  /**
   * 铺一批示例数据，只为让文件夹层级与列表形态可见。
   * 刻意做成「两级文件夹 + 跨层级笔记」，缩进与计数一眼能看出来。
   * 仅在整个库为空时从空态触发，有数据后按钮自动消失。
   */
  const handleSeed = async () => {
    setSeeding(true)
    try {
      const work = await createFolder('工作')
      const meetings = await createFolder('会议记录', work.id)
      const reading = await createFolder('读书笔记')

      await Promise.all([
        createNote({
          title: '周会 0902',
          content: '# 周会 0902\n\n- [x] 同步进度\n- [ ] 确认排期\n',
          folder_id: meetings.id,
        }),
        createNote({
          title: 'One-on-One',
          content: '# One-on-One\n\n聊了职业发展和下季度目标。\n',
          folder_id: meetings.id,
        }),
        createNote({
          title: '《深度工作》笔记',
          content:
            '# 《深度工作》\n\n> 专注是一种可以被训练的能力。\n\n## 要点\n\n1. 减少上下文切换\n2. 设定固定时段\n',
          folder_id: reading.id,
        }),
        createNote({
          title: '灵感速记',
          content: '# 灵感速记\n\n想到一个改进同步体验的点子。\n',
          folder_id: null,
        }),
      ])
    } finally {
      setSeeding(false)
    }
  }

  const handleMoveFolder = (id: string, parentId: string | null) => {
    void moveFolder(id, parentId)
  }

  /** 恢复历史版本：走普通内容更新，会照常生成新备份，故恢复本身可再恢复。 */
  const handleRestoreVersion = async (restored: string) => {
    if (!current) return
    await updateNote(current.id, { content: restored })
    setContent(restored)
  }

  /**
   * 选中搜索命中的笔记。
   *
   * ★ 注意边界：搜索结果可能不在当前筛选的列表里。若正按某文件夹筛选，
   *   而该笔记不属于它，选中后 current 取不到（右侧会空白）——
   *   此时清掉筛选，回到全部。
   */
  const handleSelectSearchHit = (noteId: string) => {
    const hit = notes.find((n) => n.id === noteId)
    if (!hit) return
    useNoteStore.setState({ currentNoteId: noteId })
    if (activeFolder !== null && hit.folder_id !== activeFolder) {
      setActiveFolder(null)
    }
  }

  const handleDeleteFolder = (id: string, name: string) => {
    // 软删除（可恢复），且只动文件夹本身 —— 其中的笔记会变为未归类，不级联删除。
    const ok = window.confirm(
      `删除文件夹「${name}」？\n其中的笔记不会被删除，会变为未归类。`,
    )
    if (!ok) return
    void deleteFolder(id)
  }

  return (
    <div className="flex min-h-full min-w-0 flex-1">
      <aside className="flex w-64 shrink-0 flex-col border-r">
        <div className="flex items-center justify-between border-b px-3 py-3">
          <span className="text-sm font-medium">笔记</span>
          <Button size="sm" variant="outline" onClick={handleCreate}>
            新建
          </Button>
        </div>

        {/* 全文搜索走服务端 FTS5：正文在 .md 里，本地查不了 */}
        <NoteSearch
          folderId={activeFolder === UNFILED ? null : activeFolder}
          onSelect={handleSelectSearchHit}
        />

        <div className="max-h-1/2 min-h-0 shrink-0 overflow-y-auto border-b">
          <div className="flex items-center justify-between px-3 py-2">
            <span className="text-xs font-medium uppercase text-muted-foreground">
              文件夹
            </span>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void createFolder(namingFolderName(folders.length))}
            >
              +
            </Button>
          </div>

          <button
            type="button"
            onClick={() => setActiveFolder(null)}
            className={rowClass(activeFolder === null)}
          >
            <span className="block truncate text-sm">全部笔记</span>
            <span className="block text-xs text-muted-foreground">{notes.length}</span>
          </button>

          {folderTree.map((node) => (
            <FolderTreeRow
              key={node.folder.id}
              node={node}
              activeFolder={activeFolder}
              onSelect={setActiveFolder}
              onRename={handleRenameFolder}
              onDelete={handleDeleteFolder}
              onMove={handleMoveFolder}
              parentOptions={availableParents(folders, node.folder.id)}
            />
          ))}

          {unfiledCount > 0 && (
            <button
              type="button"
              onClick={() => setActiveFolder(UNFILED)}
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

        <div className="min-h-0 flex-1 overflow-y-auto">
          {visibleNotes.length === 0 && !isLoading && (
            <div className="px-3 py-6">
              <p className="text-sm text-muted-foreground">
                {notes.length === 0
                  ? '还没有笔记，点「新建」开始。'
                  : '这个文件夹里没有笔记。'}
              </p>
              {/* 空的库看不出文件夹层级，给一条一键铺示例的路。
                  仅在整个库为空时出现，有数据后自动消失。 */}
              {notes.length === 0 && (
                <Button
                  size="sm"
                  variant="outline"
                  className="mt-3"
                  disabled={seeding}
                  onClick={() => void handleSeed()}
                >
                  {seeding ? '生成中…' : '填充示例数据'}
                </Button>
              )}
            </div>
          )}
          {visibleNotes.map((note) => (
            <NoteListItem
              key={note.id}
              note={note}
              active={note.id === currentNoteId}
              onSelect={() => useNoteStore.setState({ currentNoteId: note.id })}
            />
          ))}
        </div>
      </aside>

      <section className="flex min-w-0 flex-1 flex-col">
        {error && (
          <div className="border-b bg-destructive/10 px-4 py-2 text-sm text-destructive">
            {error}
          </div>
        )}

        {!current ? (
          <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
            选择一篇笔记，或新建一篇。
          </div>
        ) : (
          <>
            <div className="flex items-center gap-2 border-b px-3 py-2">
              <input
                className="min-w-0 flex-1 bg-transparent text-base font-medium outline-none placeholder:text-muted-foreground"
                placeholder="标题"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
              <SaveIndicator state={saveState} />
              <select
                className="max-w-[10rem] border bg-background px-2 py-1 text-xs"
                value={current.folder_id ?? ''}
                onChange={(e) => {
                  const folderId = e.target.value || null
                  void updateNote(current.id, { folder_id: folderId })
                }}
                aria-label="归入文件夹"
              >
                <option value="">未归类</option>
                {folderOptions.map(({ folder, depth }) => (
                  <option key={folder.id} value={folder.id}>
                    {`${'　'.repeat(depth)}${folder.name}`}
                  </option>
                ))}
              </select>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setIsPreview((v) => !v)}
              >
                {isPreview ? '编辑' : '预览'}
              </Button>
              <Button size="sm" variant="ghost" onClick={handleDelete}>
                删除
              </Button>
              <Button
                size="sm"
                variant={showVersions ? 'default' : 'ghost'}
                onClick={() => setShowVersions((v) => !v)}
              >
                历史
              </Button>
            </div>

            {/* 标签由正文的 #hashtag 推导。点击可切到按该标签筛选，
                再点一次取消 —— 与文件夹筛选互斥，标签优先。 */}
            {current.tags && current.tags.length > 0 && (
              <div className="flex flex-wrap items-center gap-1 border-b px-3 py-1.5">
                {activeTag !== null && (
                  <span className="mr-1 text-xs text-muted-foreground">按标签筛选中</span>
                )}
                {current.tags.map((tag) => (
                  <button
                    key={tag}
                    type="button"
                    onClick={() => setActiveTag(activeTag === tag ? null : tag)}
                    className={
                      activeTag === tag
                        ? 'rounded bg-primary px-1.5 py-0.5 text-xs text-primary-foreground'
                        : 'rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground hover:text-foreground'
                    }
                  >
                    #{tag}
                  </button>
                ))}
              </div>
            )}

            <div className="flex min-h-0 flex-1">
              {isPreview ? (
                <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
                  <QuickNoteMarkdown content={content} />
                </div>
              ) : (
                <div className="min-h-0 flex-1 overflow-hidden">
                  <NoteEditor
                  value={content}
                  onChange={setContent}
                  onSave={handleSaveNow}
                />
                </div>
              )}

              {showVersions && current && (
                <NoteVersionPanel
                  noteId={current.id}
                  onRestore={handleRestoreVersion}
                  onClose={() => setShowVersions(false)}
                />
              )}
            </div>
          </>
        )}
      </section>
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
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={
        active
          ? 'block w-full border-l-2 border-primary bg-muted px-3 py-2 text-left'
          : 'block w-full border-l-2 border-transparent px-3 py-2 text-left hover:bg-muted/50'
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

function SaveIndicator({ state }: { state: 'idle' | 'pending' | 'saved' }) {
  if (state === 'idle') return null
  return (
    <span className="text-xs text-muted-foreground">
      {state === 'pending' ? '保存中…' : '已保存'}
    </span>
  )
}

/** 新建文件夹的默认名，避免一堆同名文件夹。 */
function namingFolderName(existingCount: number): string {
  return `新文件夹 ${existingCount + 1}`
}

function rowClass(active: boolean): string {
  return active
    ? 'block w-full border-l-2 border-primary bg-muted px-3 py-2 text-left'
    : 'block w-full border-l-2 border-transparent px-3 py-2 text-left hover:bg-muted/50'
}

function FolderTreeRow({
  node,
  activeFolder,
  onSelect,
  onRename,
  onDelete,
  onMove,
  parentOptions,
  depth = 0,
}: {
  node: FolderTreeNode
  activeFolder: string | null
  onSelect: (id: string) => void
  onRename: (id: string, name: string) => void
  onDelete: (id: string, name: string) => void
  onMove: (id: string, parentId: string | null) => void
  /** 可作为新父级的文件夹，已排除自身子树（避免成环）。 */
  parentOptions: Folder[]
  depth?: number
}) {
  const [editing, setEditing] = useState(false)
  const [moving, setMoving] = useState(false)
  const [draft, setDraft] = useState(node.folder.name)

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
            className="my-1 mr-2 w-full border bg-background px-1 py-0.5 text-sm outline-none"
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
            className="my-1 mr-2 w-full border bg-background px-1 py-0.5 text-sm outline-none"
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
            {parentOptions.map((parent) => (
              <option key={parent.id} value={parent.id}>
                {parent.name}
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
                  ? 'min-w-0 flex-1 border-l-2 border-primary bg-muted py-2 pl-2 pr-1 text-left'
                  : 'min-w-0 flex-1 border-l-2 border-transparent py-2 pl-2 pr-1 text-left'
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
                className="px-1 text-xs text-muted-foreground hover:text-foreground"
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
                className="px-1 text-xs text-muted-foreground hover:text-foreground"
                onClick={() => setMoving(true)}
                aria-label={`移动 ${node.folder.name}`}
              >
                ⇄
              </button>
              <button
                type="button"
                className="px-1 text-xs text-muted-foreground hover:text-destructive"
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
          activeFolder={activeFolder}
          onSelect={onSelect}
          onRename={onRename}
          onDelete={onDelete}
          onMove={onMove}
          parentOptions={parentOptions}
          depth={depth + 1}
        />
      ))}
    </>
  )
}
