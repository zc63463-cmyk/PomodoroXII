/**
 * Note API —— 空间级（space token）的笔记远程调用封装。
 *
 * 只覆盖**必须走服务端**的能力：正文全文检索。笔记正文不进 Dexie 索引，
 * FTS5 建在服务端的 index.db（trigram 分词，支持中文子串），本地无法替代。
 *
 * 列表、增删改一律走本地仓储（note-repository）+ 同步引擎，
 * 不经过这里 —— 离线优先要求写操作先落本地。
 */

import { spaceApi } from '@/services/api'

/**
 * 服务端 `NoteSearchResultItem` 的线格式。
 * 注意后端返回的是 **snake_case**，与本地 `Note` 的字段命名不完全一致。
 */
export interface NoteSearchHit {
  note_id: string
  title: string
  folder_id: string | null
  /** 命中位置周边的正文片段，用于搜索结果预览。 */
  excerpt: string
  score: number
}

export interface SearchNotesOptions {
  /** 限定在某个文件夹内搜索。 */
  folderId?: string | null
  limit?: number
  signal?: AbortSignal
}

/**
 * 正文全文检索（服务端 FTS5）。
 *
 * 后端对短查询（< 3 字符）会回退到 SQL LIKE —— trigram 分词无法为过短查询
 * 产生词元，这是预期行为，不是故障。
 */
export async function searchNotes(
  query: string,
  options: SearchNotesOptions = {},
): Promise<NoteSearchHit[]> {
  const trimmed = query.trim()
  if (!trimmed) return []

  const params: Record<string, string | number> = {
    q: trimmed,
    limit: options.limit ?? 20,
  }
  if (options.folderId) params.folder_id = options.folderId

  const res = await spaceApi.get<NoteSearchHit[]>('/notes/search', {
    params,
    ...(options.signal ? { signal: options.signal } : {}),
  })
  return res.data
}
