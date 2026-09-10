'use client'

/**
 * 笔记全文搜索 —— 走服务端 FTS5（note-api 的 searchNotes）。
 *
 * ★ 为什么不用本地过滤
 *   Dexie 里只存了元数据，**正文在 .md 文件里**，本地查不了全文。
 *   服务端 index.db 有 FTS5 虚拟表（trigram 分词，支持中文子串），
 *   这才是正确的全文检索入口。
 *
 * ★ 防抖是必须的
 *   每个字符都发请求会打爆后端。300ms 是输入手感与请求量的折中。
 *
 * ★ 竞态处理
 *   先发的慢请求可能后到，覆盖掉新结果。用 seq 序号丢弃过期响应，
 *   不能只靠 useEffect cleanup（那只能取消未发出的请求）。
 */

import { useEffect, useRef, useState } from 'react'
import { searchNotes, type NoteSearchHit } from '@/lib/notes/note-api'

const SEARCH_DELAY_MS = 300

export interface NoteSearchProps {
  /** 选中某条结果时回调（传的是 note_id）。 */
  onSelect: (noteId: string) => void
  /** 限定在某个文件夹内搜索；null 表示全文搜索。 */
  folderId?: string | null
}

export default function NoteSearch({ onSelect, folderId = null }: NoteSearchProps) {
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<NoteSearchHit[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // 只接受「最后一次发起」的响应，避免慢请求覆盖新结果
  const seqRef = useRef(0)

  useEffect(() => {
    const trimmed = query.trim()
    if (trimmed.length === 0) {
      setHits(null)
      setSearching(false)
      setError(null)
      return
    }

    setSearching(true)
    setError(null)
    const seq = ++seqRef.current

    const timer = setTimeout(() => {
      void searchNotes(trimmed, { folderId, limit: 20 }).then(
        (rows) => {
          if (seq !== seqRef.current) return // 过期响应，丢弃
          setHits(rows)
          setSearching(false)
        },
        (err: unknown) => {
          if (seq !== seqRef.current) return
          setError(err instanceof Error ? err.message : String(err))
          setSearching(false)
        },
      )
    }, SEARCH_DELAY_MS)

    return () => clearTimeout(timer)
  }, [query, folderId])

  return (
    <div className="border-b px-3 py-2">
      <input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="搜索笔记全文…"
        aria-label="搜索笔记"
        className="focus-ring-inset transition-ui w-full rounded border bg-background px-2 py-1 text-sm outline-none placeholder:text-muted-foreground"
      />

      {error && <p className="mt-1 text-xs text-destructive">{error}</p>}

      {/* 有关键词才展示结果区；无关键词时不占地方 */}
      {query.trim().length > 0 && (
        <div className="mt-2">
          {searching && <p className="text-xs text-muted-foreground">搜索中…</p>}

          {!searching && hits !== null && hits.length === 0 && (
            <p className="text-xs text-muted-foreground">没有匹配的笔记</p>
          )}

          {!searching && hits !== null && hits.length > 0 && (
            <ul className="flex max-h-64 flex-col overflow-y-auto">
              {hits.map((hit) => (
                <li key={hit.note_id}>
                  <button
                    type="button"
                    onClick={() => onSelect(hit.note_id)}
                    className="block w-full rounded px-2 py-1.5 text-left hover:bg-muted/50"
                  >
                    <span className="block truncate text-sm">
                      {hit.title || '(未命名)'}
                    </span>
                    {hit.excerpt && (
                      <span className="block truncate text-xs text-muted-foreground">
                        {hit.excerpt}
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
