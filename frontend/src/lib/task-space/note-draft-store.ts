import type { WorkItemNoteDocument } from '@/lib/contracts/task-space'
import { canonicalNow } from '@/lib/direct-command-intents'

/**
 * Durable retryable draft for a failed Note autosave flush.
 *
 * Decision record (Wave 2 Task D): the failed flush currently only lives in
 * the in-memory NoteAutosaveController, so it is lost when the repository is
 * rebound (item/space switch, logout, reload).  We persist the failed edit to
 * a schema-safe per-space localStorage collection instead of adding a Dexie
 * table, because the Dexie v18/v19 native cutover inventory is strict and
 * adding a table would force a risky schema version bump for existing
 * installs.  localStorage is durable across reload/space-switch and is
 * space-scoped by key.
 *
 * Honest limitation: if the underlying failure is a storage/quota error,
 * localStorage persistence can also fail; in that case the in-memory
 * controller draft remains the only retry path and we do NOT claim reliable
 * persistence.
 */

export interface NoteEditDraft {
  spaceId: string
  workItemId: string
  expectedLocalRevision: number
  document: WorkItemNoteDocument
  operationId: string
  now: string
  createdAt: string
}

const KEY_PREFIX = 'pxii:noteDraft:'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const draftKey = (spaceId: string, workItemId: string): string =>
  `${KEY_PREFIX}${spaceId}:${workItemId}`

export function parseNoteEditDraft(
  raw: string,
  spaceId: string,
  workItemId: string,
): NoteEditDraft | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isRecord(parsed)) return null
  if (parsed.spaceId !== spaceId || parsed.workItemId !== workItemId) return null
  if (
    typeof parsed.expectedLocalRevision !== 'number' ||
    typeof parsed.operationId !== 'string' ||
    typeof parsed.now !== 'string' ||
    typeof parsed.createdAt !== 'string' ||
    !isRecord(parsed.document)
  ) {
    return null
  }
  return parsed as unknown as NoteEditDraft
}

export function persistNoteEditDraft(draft: NoteEditDraft): void {
  try {
    localStorage.setItem(draftKey(draft.spaceId, draft.workItemId), JSON.stringify(draft))
  } catch {
    // Storage unavailable: nothing durable can be written; the in-memory
    // controller draft remains the only retry path.
  }
}

export function loadNoteEditDraft(spaceId: string, workItemId: string): NoteEditDraft | null {
  const raw = localStorage.getItem(draftKey(spaceId, workItemId))
  if (raw === null) return null
  return parseNoteEditDraft(raw, spaceId, workItemId)
}

export function clearNoteEditDraft(spaceId: string, workItemId: string): void {
  try {
    localStorage.removeItem(draftKey(spaceId, workItemId))
  } catch {
    // best-effort removal
  }
}

export function buildNoteEditDraft(input: {
  spaceId: string
  workItemId: string
  expectedLocalRevision: number
  document: WorkItemNoteDocument
  operationId: string
  now: string
}): NoteEditDraft {
  return {
    ...input,
    createdAt: canonicalNow(),
  }
}
