import type { PomodoroXIDB } from '@/services/database'

export const QUICK_NOTE_NEW_DRAFT_KEY = 'quickNote:newDraft:v1'
export const QUICK_NOTE_NEW_DRAFT_VERSION = 1 as const

export interface QuickNoteNewDraftSnapshot {
  version: typeof QUICK_NOTE_NEW_DRAFT_VERSION
  content: string
  updatedAt: string
}

export interface QuickNoteDraftRepository {
  load: () => Promise<QuickNoteNewDraftSnapshot | null>
  save: (content: string, updatedAt?: string) => Promise<void>
  clear: () => Promise<void>
}

export function createQuickNoteDraftRepository(
  database: PomodoroXIDB,
): QuickNoteDraftRepository {
  return {
    async load() {
      const row = await database.settings.get(QUICK_NOTE_NEW_DRAFT_KEY)
      if (!row) return null

      try {
        const snapshot: unknown = JSON.parse(row.value)
        if (!isSupportedSnapshot(snapshot)) {
          await database.settings.delete(QUICK_NOTE_NEW_DRAFT_KEY)
          return null
        }
        if (!snapshot.content.trim()) {
          await database.settings.delete(QUICK_NOTE_NEW_DRAFT_KEY)
          return null
        }
        return snapshot
      } catch {
        await database.settings.delete(QUICK_NOTE_NEW_DRAFT_KEY)
        return null
      }
    },

    async save(content, updatedAt = new Date().toISOString()) {
      if (!content.trim()) {
        await database.settings.delete(QUICK_NOTE_NEW_DRAFT_KEY)
        return
      }

      const snapshot: QuickNoteNewDraftSnapshot = {
        version: QUICK_NOTE_NEW_DRAFT_VERSION,
        content,
        updatedAt,
      }
      await database.settings.put({
        key: QUICK_NOTE_NEW_DRAFT_KEY,
        value: JSON.stringify(snapshot),
      })
    },

    async clear() {
      await database.settings.delete(QUICK_NOTE_NEW_DRAFT_KEY)
    },
  }
}

function isSupportedSnapshot(value: unknown): value is QuickNoteNewDraftSnapshot {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Record<string, unknown>
  return (
    candidate.version === QUICK_NOTE_NEW_DRAFT_VERSION &&
    typeof candidate.content === 'string' &&
    typeof candidate.updatedAt === 'string'
  )
}
