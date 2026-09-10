'use client'

/**
 * 版本历史面板 —— 查看与恢复笔记的历史版本。
 *
 * ★ 后端能力一直都在（GET /notes/{id}/versions 与 /versions/{version_id}），
 *   此前只是前端没接 —— 属于「有写入也有读取，但缺入口」的最后一公里。
 *
 * 恢复的安全性：恢复走的是普通 updateNote(content)，会照常生成
 * 一个新的版本备份。也就是说**恢复本身也是可恢复的**，
 * 不会出现「一恢复就再也回不去」的情况。
 */

import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { fetchNoteVersion, listNoteVersions, type NoteVersion } from '@/lib/notes/note-api'

export interface NoteVersionPanelProps {
  noteId: string
  onRestore: (content: string) => Promise<void>
  onClose: () => void
}

export default function NoteVersionPanel({
  noteId,
  onRestore,
  onClose,
}: NoteVersionPanelProps) {
  const [versions, setVersions] = useState<NoteVersion[] | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const [previewId, setPreviewId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setVersions(null)
    setError(null)

    void listNoteVersions(noteId).then(
      (rows) => {
        if (!cancelled) setVersions(rows)
      },
      (err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      },
    )

    return () => {
      cancelled = true
    }
  }, [noteId])

  const handleSelect = async (version: NoteVersion) => {
    setBusyId(version.version_id)
    setError(null)
    try {
      const content = await fetchNoteVersion(noteId, version.version_id)
      setPreview(content)
      setPreviewId(version.version_id)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyId(null)
    }
  }

  const handleRestore = async () => {
    if (preview == null) return
    setBusyId(previewId)
    setError(null)
    try {
      await onRestore(preview)
      setPreview(null)
      setPreviewId(null)
      // 恢复后版本列表会多一条，重新拉取
      setVersions(null)
      const rows = await listNoteVersions(noteId)
      setVersions(rows)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyId(null)
    }
  }

  return (
    <aside className="flex w-64 shrink-0 flex-col border-l">
      <div className="flex items-center justify-between border-b px-3 py-2">
        <span className="text-xs font-medium uppercase text-muted-foreground">
          版本历史
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label="关闭版本历史"
          className="px-1 text-xs text-muted-foreground hover:text-foreground"
        >
          ×
        </button>
      </div>

      {error && (
        <div className="border-b bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      )}

      {preview != null ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex items-center gap-2 border-b px-3 py-2">
            <Button size="sm" onClick={() => void handleRestore()} disabled={busyId !== null}>
              恢复此版本
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setPreview(null)
                setPreviewId(null)
              }}
            >
              返回
            </Button>
          </div>
          <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap px-3 py-2 text-xs">
            {preview}
          </pre>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          {versions === null && (
            <p className="px-3 py-6 text-xs text-muted-foreground">加载中…</p>
          )}

          {versions !== null && versions.length === 0 && (
            <p className="px-3 py-6 text-xs text-muted-foreground">
              还没有历史版本。编辑正文后会自动生成备份。
            </p>
          )}

          {versions?.map((version) => (
            <button
              key={version.version_id}
              type="button"
              onClick={() => void handleSelect(version)}
              disabled={busyId !== null}
              className="focus-ring-inset transition-ui block w-full px-3 py-2 text-left hover:bg-muted/50 disabled:opacity-50"
            >
              <span className="block truncate text-xs">{formatTime(version.changed_at)}</span>
              <span className="block truncate text-xs text-muted-foreground">
                {version.change_summary || version.content_hash.slice(0, 8)}
              </span>
            </button>
          ))}
        </div>
      )}
    </aside>
  )
}

/** 把 ISO 时间戳格式化成本地可读形式。非法输入原样返回，不抛错。 */
function formatTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleString()
}
