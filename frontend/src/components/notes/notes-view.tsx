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
import { getNoteSummary, getNoteTitle } from '@/lib/notes/note-selectors'
import { useNoteStore } from '@/stores/note-store'
import type { Note } from '@/types'

/** 自动保存防抖：既避免每次按键都入队，也不会让用户等太久。 */
const AUTOSAVE_DELAY_MS = 600

export function NotesView() {
  const notes = useNoteStore((s) => s.notes)
  const currentNoteId = useNoteStore((s) => s.currentNoteId)
  const isLoading = useNoteStore((s) => s.isLoading)
  const error = useNoteStore((s) => s.error)
  const loadNotes = useNoteStore((s) => s.loadNotes)
  const createNote = useNoteStore((s) => s.createNote)
  const updateNote = useNoteStore((s) => s.updateNote)
  const deleteNote = useNoteStore((s) => s.deleteNote)

  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [isPreview, setIsPreview] = useState(false)
  const [saveState, setSaveState] = useState<'idle' | 'pending' | 'saved'>('idle')

  // 编辑中的草稿。切笔记时用它重置编辑器，避免把 A 的内容写进 B。
  const editingIdRef = useRef<string | null>(null)

  const current = useMemo(
    () => notes.find((n) => n.id === currentNoteId) ?? null,
    [notes, currentNoteId],
  )

  useEffect(() => {
    void loadNotes()
  }, [loadNotes])

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
  useEffect(() => {
    if (!current) return
    if (title === current.title && content === current.content) return

    setSaveState('pending')
    const timer = setTimeout(() => {
      void updateNote(current.id, { title, content }).then(
        () => setSaveState('saved'),
        () => setSaveState('idle'),
      )
    }, AUTOSAVE_DELAY_MS)

    return () => clearTimeout(timer)
  }, [title, content, current, updateNote])

  const handleCreate = async () => {
    const note = await createNote({ title: '', content: '' })
    useNoteStore.setState({ currentNoteId: note.id })
  }

  const handleDelete = async () => {
    if (!current) return
    await deleteNote(current.id)
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

        <div className="min-h-0 flex-1 overflow-y-auto">
          {notes.length === 0 && !isLoading && (
            <p className="px-3 py-6 text-sm text-muted-foreground">
              还没有笔记，点「新建」开始。
            </p>
          )}
          {notes.map((note) => (
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
            </div>

            {isPreview ? (
              <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
                <QuickNoteMarkdown content={content} />
              </div>
            ) : (
              <textarea
                className="min-h-0 flex-1 resize-none bg-transparent px-4 py-3 font-mono text-sm outline-none"
                placeholder="用 Markdown 写点什么…"
                value={content}
                onChange={(e) => setContent(e.target.value)}
              />
            )}
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
