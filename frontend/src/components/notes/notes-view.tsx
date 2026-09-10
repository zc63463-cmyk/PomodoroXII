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

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { QuickNoteMarkdown } from '@/components/quick-notes/quick-note-markdown'
import { Button } from '@/components/ui/button'
import {
  buildFolderTree,
  countUnfiledNotes,
  flattenFolderTree,
} from '@/lib/folders/folder-selectors'
import dynamic from 'next/dynamic'
import {
  NoteSidebar,
  UNFILED,
  namingFolderName,
} from '@/components/notes/note-sidebar'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { mergeTags, sameTags } from '@/lib/notes/note-tags'
import {
  buildBacklinkIndex,
  buildTitleIndex,
  findNotesReferencing,
  rewriteLinksInContent,
  titleKey,
  type BacklinkEntry,
} from '@/lib/notes/note-links'
import { buildNoteTemplate, shouldPromptSummary } from '@/lib/notes/note-summary'
import { isSplittableRange, planNoteSplit } from '@/lib/notes/note-split'
import { adviseTitle } from '@/lib/notes/note-title'
import { sortNotes, type NoteSortKey } from '@/lib/notes/note-selectors'
import { useFolderStore } from '@/stores/folder-store'
import { useNoteStore } from '@/stores/note-store'
import type { Note } from '@/types'

/** 自动保存防抖：既避免每次按键都入队，也不会让用户等太久。 */
const AUTOSAVE_DELAY_MS = 600

/**
 * 按住 Alt 多久才算"想预览"。
 *
 * ★ 为什么要延迟而不是按下即显示
 *   macOS 上 Option+字母是输入法组合键（用于输入特殊字符），
 *   按下即显示的话，每敲一个特殊字符预览都要闪一下。
 *   300ms 足以把"短按组合键"和"按住不放"区分开。
 */
const ALT_PREVIEW_DELAY_MS = 300

const NoteEditor = dynamic(() => import('./note-editor'), {
  ssr: false, // CodeMirror 构造 EditorView 需要 DOM，SSR 阶段会报错
  loading: () => <div className="p-4 text-sm text-muted-foreground">编辑器加载中…</div>,
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
  /** 编辑器内的当前选区。切换笔记时必须清空 —— 偏移是相对旧正文的。 */
  const [selection, setSelection] = useState<{ from: number; to: number } | null>(null)
  /**
   * 视图模式。原先用 isPreview 布尔在「编辑 / 预览」间切换，
   * 但两者互斥显示 —— 同一时刻只看到一个，滚动同步无从谈起。
   * 分屏模式（左写右看）才是滚动同步真正有意义的场景。
   */
  const [viewMode, setViewMode] = useState<'edit' | 'split' | 'preview'>('edit')
  const [showVersions, setShowVersions] = useState(false)
  /** 按标签筛选。与文件夹筛选互斥：选中标签时以标签为准。 */
  const [activeTag, setActiveTag] = useState<string | null>(null)
  const [sortBy, setSortBy] = useState<NoteSortKey>('updated')
  /** 待确认的删除动作。删除是破坏性操作，两处统一走 ConfirmDialog。 */
  const [noteDeleteOpen, setNoteDeleteOpen] = useState(false)
  const [pendingFolderDeletion, setPendingFolderDeletion] = useState<{
    id: string
    name: string
  } | null>(null)
  const previewRef = useRef<HTMLDivElement | null>(null)

  /**
   * 编辑器滚动 → 预览跟随。
   *
   * ★ 用「滚动百分比」而非行号映射：后者更精确，但要建立
   *   源码行 ↔ 渲染后 DOM 位置的对应关系，成本高一个量级。
   *   百分比映射对纯文本为主的笔记足够，且实现简单可靠。
   *   局限：正文里图片/代码块较多导致两侧高度差异大时，会有偏移。
   */
  const syncPreviewScroll = useCallback((percent: number) => {
    const el = previewRef.current
    if (!el) return
    const max = el.scrollHeight - el.clientHeight
    if (max <= 0) return
    el.scrollTop = percent * max
  }, [])
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

  /**
   * wiki 链接索引。刻意**不落库**——链接是正文的派生物，正文已经同步了，
   * 再存一份链接表既冗余又要改同步 schema。这里在渲染时从内存里的 notes 算。
   */
  /**
   * 标题规范提示。
   *
   * ★ 全新空笔记刻意不提示 —— 刚点「新建」就弹一条「给它一个标题」很烦，
   *   用户很可能只是想先把想法倒出来，标题最后再定。
   */
  const titleAdvice = useMemo(() => {
    if (!title.trim() && !content.trim()) return null
    return adviseTitle(title)
  }, [title, content])

  /** 长文仍未填摘要时的轻提示。短文不催，见 shouldPromptSummary。 */
  const needSummary = useMemo(() => shouldPromptSummary(content), [content])

  const titleIndex = useMemo(() => buildTitleIndex(notes), [notes])
  const resolveWikiLink = useCallback(
    (target: string) => titleIndex.get(titleKey(target)) ?? null,
    [titleIndex],
  )
  const backlinkIndex = useMemo(() => buildBacklinkIndex(notes), [notes])
  // ★ 依赖用 id 而不是 current 对象：current 每次 notes 变化都是新对象引用，
  //   会让这个 memo 反复失效 —— 而我们要的只是它指向哪一篇。
  const currentBacklinks = useMemo(
    () => (currentNoteId ? backlinkIndex.get(currentNoteId) ?? [] : []),
    [backlinkIndex, currentNoteId],
  )

  /**
   * `[[` 补全的候选标题：所有活跃笔记的标题，排除当前这篇
   * （自己链自己没有意义，还会污染候选列表）。
   */
  const noteTitles = useMemo(
    () =>
      notes
        .filter((note) => note.trashed_at === null && note.id !== current?.id)
        .map((note) => note.title)
        .filter((title) => title.trim() !== ''),
    [notes, current?.id],
  )

  /** 点击正文里的 `[[标题]]` → 跳到那篇笔记。 */
  const handleWikiLinkNavigate = useCallback((noteId: string) => {
    useNoteStore.setState({ currentNoteId: noteId })
  }, [])

  /**
   * 待处理的失效引用：改了标题之后，还有别的笔记的正文在引用**旧标题**。
   *
   * ★ 只"发现并提示"，**不自动改写**：批量修改别人的正文会产生多条同步事件，
   *   必须是用户看得见、点得动的动作，否则就是一次静默的大批量写入。
   */
  const [staleLink, setStaleLink] = useState<{ oldTitle: string; sourceIds: string[] } | null>(
    null,
  )

  // 保存回调里要读最新的 notes，但不该把它放进 effect 依赖（数组引用每次都变，
  // 会把防抖 timer 冲掉）。
  const notesRef = useRef(notes)
  notesRef.current = notes

  /** 切换笔记时清掉上一份的失效引用提示（提示只对当前这篇有意义） */
  useEffect(() => {
    setStaleLink(null)
  }, [current?.id])

  /**
   * 把引用了旧标题的笔记正文改成新标题。
   * 逐条更新而非一次批量 —— 每条是独立的同步事件，失败时好定位、好重试。
   */
  const handleUpdateStaleLinks = useCallback(async () => {
    if (!staleLink || !current) return
    const affected = findNotesReferencing(notesRef.current, staleLink.oldTitle, current.id)
    const newTitle = current.title
    for (const note of affected) {
      await updateNote(note.id, {
        content: rewriteLinksInContent(note.content, staleLink.oldTitle, newTitle),
      })
    }
    setStaleLink(null)
  }, [current, staleLink, updateNote])

  /**
   * 点击一个尚未创建的链接 → 直接建出来（Obsidian 的"点击即创建"）。
   * 这比显示"链接失效"有用得多：写的时候先占位，回头再补内容。
   */
  const handleMissingNoteClick = useCallback(
    async (target: string) => {
      const note = await createNote({ title: target, content: '' })
      useNoteStore.setState({ currentNoteId: note.id })
    },
    [createNote],
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
    if (activeFolder === null) {
      return sortNotes(notes, sortBy)
    }
    if (activeFolder === UNFILED) {
      return sortNotes(
        notes.filter((n) => n.folder_id == null),
        sortBy,
      )
    }
    return sortNotes(
      notes.filter((n) => n.folder_id === activeFolder),
      sortBy,
    )
  }, [notes, activeFolder, activeTag, sortBy])

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
    // 选区偏移是相对**旧正文**的，换笔记后必须作废，否则拆分会切错内容
    setSelection(null)
    setSaveState('idle')
    setViewMode('edit')
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
        () => {
          setSaveState('saved')
          // ★ 标题改了 → 可能有别的笔记仍在引用旧标题。
          //   只记录待处理，交给用户在提示条上确认，绝不静默替他改别人的正文。
          if (savedTitle !== undefined && savedTitle !== title) {
            const affected = findNotesReferencing(notesRef.current, savedTitle, currentId)
            if (affected.length > 0) {
              setStaleLink({
                oldTitle: savedTitle,
                sourceIds: affected.map((note) => note.id),
              })
            }
          }
        },
        () => setSaveState('idle'),
      )
    }, AUTOSAVE_DELAY_MS)

    return () => clearTimeout(timer)
  }, [currentId, savedTitle, savedContent, savedTags, title, content, updateNote])

  /**
   * 按住 Alt 临时预览。
   *
   * ★ 挂在 window 而不是编辑器上：按住 Alt 时焦点不一定在编辑器里
   *   （比如刚点过侧栏），但用户的心智是"按住就能看"。
   *
   * ★ 为什么延迟 ALT_PREVIEW_DELAY_MS 才生效（见常量注释）
   *
   * ★ 为什么监听 blur：按住 Alt 再 Alt+Tab 切走时，keyup 永远收不到，
   *   预览会一直卡在屏幕上。窗口失焦必须强制还原。
   */
  const [altHeld, setAltHeld] = useState(false)
  const altTimerRef = useRef<number | null>(null)

  useEffect(() => {
    const clearTimer = () => {
      if (altTimerRef.current !== null) {
        window.clearTimeout(altTimerRef.current)
        altTimerRef.current = null
      }
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Alt' || e.repeat) return
      clearTimer()
      altTimerRef.current = window.setTimeout(
        () => setAltHeld(true),
        ALT_PREVIEW_DELAY_MS,
      )
    }
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key !== 'Alt') return
      clearTimer()
      setAltHeld(false)
    }
    const onBlur = () => {
      clearTimer()
      setAltHeld(false)
    }

    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)
    return () => {
      clearTimer()
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
    }
  }, [])

  // 只在编辑模式下有意义：分屏和预览本来就看得到渲染结果
  const altPreviewActive = altHeld && viewMode === 'edit'

  const handleCreate = useCallback(async () => {
    // 新笔记预置一行摘要 —— 等写到两百字再提示，远不如一开始就把它摆在那儿
    const note = await createNote({ title: '', content: buildNoteTemplate() })
    useNoteStore.setState({ currentNoteId: note.id })
  }, [createNote])

  /**
   * 在**当前筛选的文件夹里**新建。空态里的「在这里新建一篇」用它。
   * UNFILED（未归类）对应 folder_id = null。
   */
  const handleCreateInFolder = useCallback(async () => {
    const note = await createNote({
      title: '',
      content: buildNoteTemplate(),
      folder_id: activeFolder === UNFILED ? null : activeFolder,
    })
    useNoteStore.setState({ currentNoteId: note.id })
  }, [createNote, activeFolder])

  /** 选中列表里的笔记。用 store 直接设，避免依赖 current 对象。 */
  const handleSelectNote = useCallback((id: string) => {
    useNoteStore.setState({ currentNoteId: id })
  }, [])

  const handleCreateFolder = useCallback(() => {
    void createFolder(namingFolderName(folders.length))
  }, [createFolder, folders.length])

  /** Cmd/Ctrl+S：立即保存，跳过防抖。 */
  const handleSaveNow = () => {
    if (!current) return
    void updateNote(current.id, { title, content })
  }

  /** 拆分进行中。用 ref 而非 state：只用于防重复点击，不需要触发渲染。 */
  const splittingRef = useRef(false)

  /**
   * 把选中的段落拆成一篇独立笔记，原文留下指向它的链接。
   *
   * ★ 顺序必须是「建新 → 存旧 → 才切换」：
   *   1. 先建新笔记：创建失败时原文一字未动，没有丢失窗口
   *   2. 显式 updateNote 存旧，而不是靠防抖 —— 切到新笔记会让 currentId 变化，
   *      自动保存的 effect 随之清理 timer，改过的正文就永远落不了库
   *   3. 最后才切过去，此时两篇都已落库
   */
  const handleSplit = async () => {
    if (!current || !selection || splittingRef.current) return
    const plan = planNoteSplit(content, selection.from, selection.to)
    if (!plan) return

    splittingRef.current = true
    try {
      const created = await createNote({
        title: plan.title,
        content: plan.newContent,
        folder_id: current.folder_id,
      })
      await updateNote(current.id, { content: plan.sourceContent })
      setSelection(null)
      useNoteStore.setState({ currentNoteId: created.id })
    } finally {
      splittingRef.current = false
    }
  }

  /** 是否可拆分：有选区、且选区不是整篇。 */
  const canSplit =
    viewMode !== 'preview' &&
    selection != null &&
    isSplittableRange(content, selection.from, selection.to)

  // 删除是不可逆的第一等动作，两处都走确认框：
  // 删笔记此前**完全没有**确认，删文件夹用的是 window.confirm —— 规则不一致。
  const handleDelete = () => setNoteDeleteOpen(true)

  const confirmDeleteNote = async () => {
    if (!current) return
    await deleteNote(current.id)
  }

  const handleRenameFolder = useCallback(
    (id: string, name: string) => {
      void renameFolder(id, name)
    },
    [renameFolder],
  )

  /**
   * 铺一批示例数据，只为让文件夹层级与列表形态可见。
   * 刻意做成「两级文件夹 + 跨层级笔记」，缩进与计数一眼能看出来。
   * 仅在整个库为空时从空态触发，有数据后按钮自动消失。
   */
  const handleSeed = useCallback(async () => {
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
  }, [createFolder, createNote])

  const handleMoveFolder = useCallback(
    (id: string, parentId: string | null) => {
      void moveFolder(id, parentId)
    },
    [moveFolder],
  )

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
  const handleSelectSearchHit = useCallback(
    (noteId: string) => {
      const hit = notes.find((n) => n.id === noteId)
      if (!hit) return
      useNoteStore.setState({ currentNoteId: noteId })
      if (activeFolder !== null && hit.folder_id !== activeFolder) {
        setActiveFolder(null)
      }
    },
    [notes, activeFolder],
  )

  const handleDeleteFolder = useCallback((id: string, name: string) => {
    setPendingFolderDeletion({ id, name })
  }, [])

  const confirmDeleteFolder = useCallback(() => {
    if (!pendingFolderDeletion) return
    void deleteFolder(pendingFolderDeletion.id)
  }, [pendingFolderDeletion, deleteFolder])

  return (
    <div className="flex min-h-full min-w-0 flex-1">
      {/* ★ 侧栏不依赖正文，却被塞在同一个组件里跟著每次按键重渲染。
          抽成 memo 组件后，正文变化不再波及列表（实测 300 条 7.90 → 0.06 ms）。
          代价：所有 props 必须引用稳定 —— 见下方成片的 useCallback，
          任何一个用普通函数传进去，memo 就完全失效。 */}
      <NoteSidebar
        notes={notes}
        visibleNotes={visibleNotes}
        folders={folders}
        folderTree={folderTree}
        unfiledCount={unfiledCount}
        activeFolder={activeFolder}
        onActiveFolderChange={setActiveFolder}
        sortBy={sortBy}
        onSortChange={setSortBy}
        currentNoteId={currentNoteId}
        onSelectNote={handleSelectNote}
        onCreateNote={handleCreate}
        onCreateNoteInFolder={handleCreateInFolder}
        onCreateFolder={handleCreateFolder}
        onRenameFolder={handleRenameFolder}
        onDeleteFolder={handleDeleteFolder}
        onMoveFolder={handleMoveFolder}
        onSelectSearchHit={handleSelectSearchHit}
        isLoading={isLoading}
        seeding={seeding}
        onSeed={handleSeed}
      />

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
            <div className="border-b px-3 py-2">
              <div className="flex items-center gap-2">
              <input
                className="focus-ring-inset transition-ui min-w-0 flex-1 rounded-sm bg-transparent px-1 text-base font-medium outline-none placeholder:text-muted-foreground"
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
              {(
                [
                  { key: 'edit', label: '编辑' },
                  { key: 'split', label: '分屏' },
                  { key: 'preview', label: '预览' },
                ] as Array<{ key: typeof viewMode; label: string }>
              ).map((mode) => (
                <Button
                  key={mode.key}
                  size="sm"
                  variant={viewMode === mode.key ? 'default' : 'ghost'}
                  onClick={() => setViewMode(mode.key)}
                >
                  {mode.label}
                </Button>
              ))}
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
              {/* 拆分：把选中的段落拆成独立笔记，原文留下链接。
                  预览模式下没有编辑器，也就没有选区，直接禁用。 */}
              <Button
                size="sm"
                variant="ghost"
                onClick={handleSplit}
                disabled={!canSplit}
                aria-label="拆分选中段落为新笔记"
                title={
                  viewMode === 'preview'
                    ? '切到编辑模式才能拆分'
                    : selection
                      ? '把选中的段落拆成一篇新笔记'
                      : '先选中要拆出来的段落'
                }
              >
                拆分
              </Button>
              </div>

              {/* 标题与摘要的轻提示。
                  ★ 都是「提示」不是校验：不阻断输入、不强制，
                    用户完全可以不理会。 */}
              {titleAdvice?.level === 'hint' && (
                <p className="mt-1 text-xs text-muted-foreground" role="status">
                  {titleAdvice.message}
                </p>
              )}
              {needSummary && (
                <p className="mt-1 text-xs text-muted-foreground" role="status">
                  这篇已经不短了，还没有摘要 —— 在正文第一行写一句
                  <code className="mx-1 rounded bg-muted px-1">&gt; 摘要：…</code>
                  将来一眼就知道它讲什么
                </p>
              )}
            </div>

            {/* ★ 改名后的失效引用提示。
                改标题不会自动改别人的正文——那是一次静默的批量写入。
                这里只把「还有 N 篇在引用旧标题」摆出来，交给用户点一下。 */}
            {staleLink && (
              <div className="flex items-center gap-3 border-b bg-amber-50 px-3 py-2 text-xs dark:bg-amber-950/30">
                <span className="min-w-0 flex-1 text-muted-foreground">
                  有 <b>{staleLink.sourceIds.length}</b> 篇笔记仍在引用旧标题
                  「{staleLink.oldTitle}」，链接已失效
                </span>
                <Button size="xs" onClick={() => void handleUpdateStaleLinks()}>
                  更新引用
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => setStaleLink(null)}
                  aria-label="忽略失效引用"
                >
                  忽略
                </Button>
              </div>
            )}

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
                        ? 'focus-ring transition-ui rounded bg-primary px-1.5 py-0.5 text-xs text-primary-foreground'
                        : 'focus-ring transition-ui rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground hover:text-foreground'
                    }
                  >
                    #{tag}
                  </button>
                ))}
              </div>
            )}

            <div className="flex min-h-0 flex-1">
              {/* 编辑 / 分屏 都显示编辑器 */}
              {viewMode !== 'preview' && (
                // relative：为 Alt 临时预览的覆盖层提供定位上下文
                <div className="relative min-h-0 flex-1 overflow-hidden">
                  <NoteEditor
                    value={content}
                    onChange={setContent}
                    onSave={handleSaveNow}
                    onSelectionChange={setSelection}
                    noteTitles={noteTitles}
                    // 只在分屏时同步滚动 —— 编辑模式下预览不可见，同步无意义
                    onScrollPercent={
                      viewMode === 'split' ? syncPreviewScroll : undefined
                    }
                  />

                  {/* ★ 按住 Alt 临时看渲染结果。
                      用**覆盖层**而不是切 viewMode：切模式会卸载 CodeMirror，
                      光标位置随之丢失 —— 松开 Alt 后光标跳回开头，
                      这个功能就失去了意义。覆盖层让编辑器实例全程不动。 */}
                  {altPreviewActive && (
                    <div className="absolute inset-0 flex flex-col bg-background">
                      <div className="shrink-0 border-b px-3 py-1 text-xs text-muted-foreground">
                        松开 Alt 返回编辑
                      </div>
                      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
                        <QuickNoteMarkdown
                          content={content}
                          wikiLinkResolver={resolveWikiLink}
                          onWikiLinkNavigate={handleWikiLinkNavigate}
                          onMissingNoteClick={handleMissingNoteClick}
                        />
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* 分屏 / 预览 都显示渲染结果 */}
              {viewMode !== 'edit' && (
                <div
                  ref={previewRef}
                  className={
                    viewMode === 'split'
                      ? 'min-h-0 flex-1 overflow-y-auto border-l px-4 py-3'
                      : 'min-h-0 flex-1 overflow-y-auto px-4 py-3'
                  }
                >
                  <QuickNoteMarkdown
                    content={content}
                    wikiLinkResolver={resolveWikiLink}
                    onWikiLinkNavigate={handleWikiLinkNavigate}
                    onMissingNoteClick={handleMissingNoteClick}
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

            {/* 反向链接：谁引用了当前这篇。
                ★ 刻意放在编辑/预览区**之外**——它是笔记的元信息，不是预览的一部分，
                  编辑模式下同样该看得见（"谁引用了我"在写作时最有用）。 */}
            <BacklinkPanel entries={currentBacklinks} onSelect={handleSelectNote} />
          </>
        )}
      </section>

      {/* 删除确认。两处删除（笔记 / 文件夹）走同一个组件，保持规则一致。 */}
      <ConfirmDialog
        open={noteDeleteOpen}
        onOpenChange={setNoteDeleteOpen}
        title="删除这篇笔记？"
        description={
          current
            ? `「${getNoteTitleForPrompt(current)}」会移到回收站，可以在回收站里恢复。`
            : '会移到回收站，可以在回收站里恢复。'
        }
        confirmLabel="删除笔记"
        onConfirm={() => void confirmDeleteNote()}
      />

      <ConfirmDialog
        open={pendingFolderDeletion !== null}
        onOpenChange={(open) => {
          if (!open) setPendingFolderDeletion(null)
        }}
        title={`删除文件夹「${pendingFolderDeletion?.name ?? ''}」？`}
        description="只删除文件夹本身，其中的笔记不会被删除，会变为未归类。"
        confirmLabel="删除文件夹"
        onConfirm={confirmDeleteFolder}
      />
    </div>
  )
}

/** 确认框里的笔记名：空标题时给个可辨识的兜底，避免出现「删除『』？」。 */
function getNoteTitleForPrompt(note: Note): string {
  const title = note.title.trim()
  if (title) return title
  const firstLine = note.content
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0)
  return firstLine ? firstLine.slice(0, 20) : '未命名笔记'
}

/**
 * 反向链接面板。
 *
 * ★ 刻意放在编辑/预览区**之外**——它是笔记的元信息，不是预览的一部分，
 *   编辑模式下同样该看得见（"谁引用了我"在写作时最有用）。
 *
 * ★ 用 memo 包住：面板只依赖「谁引用了当前这篇」，与正文无关，
 *   不该跟着每次按键重建 DOM。entries 是 useMemo 产物、onSelect 是 useCallback，
 *   两个 props 都稳定，memo 才能生效。
 */
const BacklinkPanel = memo(function BacklinkPanel({
  entries,
  onSelect,
}: {
  entries: BacklinkEntry[]
  onSelect: (noteId: string) => void
}) {
  if (entries.length === 0) return null

  return (
    <div role="region" aria-label="反向链接" className="shrink-0 border-t px-4 py-3">
      <div className="text-xs font-medium uppercase text-muted-foreground">
        反向链接 · {entries.length}
      </div>
      <ul className="mt-2 flex flex-col gap-1.5">
        {entries.map((entry, index) => (
          <li key={`${entry.sourceId}-${index}`}>
            <button
              type="button"
              className="focus-ring transition-ui rounded text-left text-sm text-primary underline-offset-2 hover:underline"
              onClick={() => onSelect(entry.sourceId)}
            >
              {entry.sourceTitle || '(无标题)'}
            </button>
            {entry.context && (
              <span className="ml-2 text-xs text-muted-foreground">
                {entry.context}
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
})

function SaveIndicator({ state }: { state: 'idle' | 'pending' | 'saved' }) {
  if (state === 'idle') return null
  return (
    <span className="text-xs text-muted-foreground">
      {state === 'pending' ? '保存中…' : '已保存'}
    </span>
  )
}
