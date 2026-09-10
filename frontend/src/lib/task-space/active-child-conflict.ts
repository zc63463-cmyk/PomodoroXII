/**
 * Structured ``active_child_conflict`` signal.
 *
 * This lives in a leaf module so BOTH sides can share one class identity
 * without a component -> store import cycle: the store raises it, and the
 * view layer recognises it and forwards it to the resolution dialog.
 */

export const ACTIVE_CHILD_CONFLICT_CODE = 'active_child_conflict'

/**
 * Raised when the server refuses to complete a level-2 work item because
 * level-3 children are still active.
 *
 * A plain message is not enough: the UI must list the blocking children and
 * offer four resolutions, so the ids travel on the error object instead of
 * being re-derived from a possibly stale local tree.
 */
export class ActiveChildConflictError extends Error {
  readonly code = ACTIVE_CHILD_CONFLICT_CODE

  constructor(
    readonly workItemId: string,
    readonly conflictChildIds: string[],
  ) {
    super(ACTIVE_CHILD_CONFLICT_CODE)
    this.name = 'ActiveChildConflictError'
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Read ``details.work_item_ids`` out of a rejected HTTP response.
 *
 * The canonical v2 envelope nests them under ``details``; the legacy shape
 * nests one level deeper under ``detail``.  Both are accepted, and a missing
 * or malformed value degrades to an empty list (the dialog then renders
 * without a child list instead of crashing).
 */
export function extractActiveChildConflictIds(error: unknown): string[] {
  const read = (value: unknown): string[] => {
    if (!isRecord(value)) return []
    const raw = value.work_item_ids ?? value.workItemIds
    return Array.isArray(raw) ? raw.filter((id): id is string => typeof id === 'string') : []
  }
  if (!isRecord(error)) return []
  const response = error.response
  if (!isRecord(response)) return []
  const data = response.data
  if (isRecord(data)) {
    const fromDetails = isRecord(data.details) ? read(data.details) : []
    if (fromDetails.length > 0) return fromDetails
    const fromDetail = isRecord(data.detail) ? read(data.detail) : []
    if (fromDetail.length > 0) return fromDetail
    return read(data)
  }
  return []
}
