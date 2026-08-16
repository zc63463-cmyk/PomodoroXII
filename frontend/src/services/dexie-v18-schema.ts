export const DEXIE_V17_NATIVE_VERSION = 170 as const
export const DEXIE_V18_NATIVE_VERSION = 180 as const

export interface V18SchemaIndex {
  name: string
  keyPath: string | string[]
  unique: boolean
  multiEntry: boolean
}

export interface V18SchemaDefinition {
  name: string
  keyPath: string | string[] | null
  autoIncrement: boolean
  indexes: V18SchemaIndex[]
  removed?: boolean
}

export interface V18SchemaInventory {
  name: string
  keyPath: string | string[] | null
  autoIncrement: boolean
  indexes: V18SchemaIndex[]
}

const index = (keyPath: string | string[], name = typeof keyPath === 'string' ? keyPath : `[${keyPath.join('+')}]`): V18SchemaIndex => ({
  name,
  keyPath,
  unique: false,
  multiEntry: false,
})

const store = (
  name: string,
  keyPath: string | string[] | null,
  indexes: V18SchemaIndex[] = [],
  autoIncrement = false,
): V18SchemaDefinition => ({ name, keyPath, autoIncrement, indexes })

const removed = (name: string): V18SchemaDefinition => ({
  name, keyPath: null, autoIncrement: false, indexes: [], removed: true,
})

const definitions = [
  store('directCommandIntents', 'operationId', [index(['spaceId', 'kind', 'state']), index('state'), index('createdAt')]),
  store('folders', 'id', [index('parent_id'), index('sort_order'), index('trashed_at')]),
  store('focusSessions', 'id', [index('startedAt'), index('endedAt'), index('updatedAt'), index('version'), index('validity'), index('reviewState')]),
  store('habitCheckIns', 'id', [index('habit_id'), index('date')]),
  store('habits', 'id', [index('sort_order'), index('archived_at'), index('created_at')]),
  store('labels', 'id', [index('name')]),
  store('memoComments', 'id', [index('note_id'), index('created_at')]),
  store('notes', 'id', [index('title'), index('updated_at'), index('folder_id'), index('status'), index('trashed_at')]),
  store('outbox', 'id', [index('spaceId'), index('entityType'), index('entityId'), index('operationId'), index('transportState'), index('createdAt')], true),
  store('projects', 'id', [index('key'), index('name')]),
  store('quickNotes', 'id', [index('created_at'), index('mood'), index('pinned'), index('archived_at'), index('folder_id'), index('trashed_at')]),
  store('reflectionTemplates', 'id', [index('category'), index('use_count'), index('is_builtin')]),
  store('reflections', 'id', [index('date'), index('mood')]),
  store('reportTemplates', 'id', [index('created_at')]),
  store('reports', 'id', [index('date')]),
  store('scheduleQuickNotes', 'id', [index('schedule_id'), index('quick_note_id'), index(['schedule_id', 'quick_note_id'])]),
  store('schedules', 'id', [index('due_at'), index('completed_at'), index('priority'), index('all_day')]),
  store('sessionActivationApplications', 'receiptId', [index('spaceId'), index('sessionId'), index('operationId')]),
  store('sessionActivationConflicts', 'id', [index('spaceId'), index('sessionId'), index('state'), index('createdAt')]),
  store('sessionAttributionRevisions', 'id', [index('sessionId'), index('revision'), index('effective')]),
  store('sessionCommandEnvelopes', 'commandId', [index('spaceId'), index('sessionId'), index('createdAt')]),
  store('sessionCommandQueue', 'commandId', [index('spaceId'), index('sessionId'), index('state'), index('createdAt')]),
  store('sessionCommandReceipts', ['commandId', 'attempt'], [index('commandId'), index('state'), index('recordedAt')]),
  store('sessionCommandReconciliationAttempts', 'operationId', [index('state'), index('createdAt')]),
  store('sessionReviewDrafts', ['spaceId', 'sessionId'], [index('updatedAt')]),
  store('sessionTaskContexts', 'id', [index('sessionId'), index('projectId'), index('level2WorkItemId')]),
  store('sessionWorkItemOutcomes', 'id', [index('sessionId'), index('workItemId'), index('result')]),
  store('sessionWorkItemPlans', 'id', [index('sessionId'), index('workItemId'), index('planRank')]),
  store('settings', 'key'),
  store('statusDefinitions', 'id', [index('projectId'), index('rank')]),
  store('syncMeta', 'key'),
  store('tags', 'id', [index('name')]),
  store('timeBlocks', 'id', [index('date'), index('status'), index('start_minute')]),
  store('timerNoteComposerDrafts', ['spaceId', 'workItemId'], [index('updatedAt')]),
  store('typeDefinitions', 'id', [index('projectId'), index('rank')]),
  store('workItemLabels', 'id', [index('workItemId'), index('labelId'), index(['workItemId', 'labelId'])]),
  store('workItemNoteConflicts', 'id', [index('spaceId'), index('workItemId'), index('createdAt')]),
  store('workItemNotes', 'id', [index('workItemId'), index('version'), index('updatedAt')]),
  store('workItems', 'id', [index('projectId'), index('parent_id'), index('status_definition_id'), index('updatedAt'), index('version')]),
  removed('tasks'), removed('sessions'), removed('sessionEvents'), removed('sessionContexts'),
  removed('cognitiveMarks'), removed('taskTags'), removed('taskRelations'), removed('focusPatterns'),
  removed('taskQuickNotes'), removed('sessionQuickNotes'),
] as const

export const V18_STORE_DEFINITIONS = Object.freeze(
  Object.fromEntries(definitions.map((definition) => [definition.name, definition])) as Record<string, V18SchemaDefinition>,
)

export type V18StoreName = keyof typeof V18_STORE_DEFINITIONS

export const V18_REMOVED_STORE_NAMES = Object.freeze(
  definitions.filter((definition) => definition.removed).map((definition) => definition.name),
)

export function toDexieStoreStrings(
  source: Record<string, V18SchemaDefinition> = V18_STORE_DEFINITIONS,
): Record<string, string | null> {
  return Object.fromEntries(Object.values(source).map((definition) => {
    if (definition.removed) return [definition.name, null]
    const primary = Array.isArray(definition.keyPath)
      ? `[${definition.keyPath.join('+')}]`
      : `${definition.autoIncrement ? '++' : ''}${definition.keyPath ?? ''}`
    const indexes = definition.indexes.map((entry) =>
      Array.isArray(entry.keyPath) ? `[${entry.keyPath.join('+')}]` : entry.name,
    )
    return [definition.name, [primary, ...indexes].filter(Boolean).join(', ')]
  }))
}

export function expectedV18SchemaInventory(): V18SchemaInventory[] {
  return Object.values(V18_STORE_DEFINITIONS)
    .filter((definition) => !definition.removed)
    .map(({ name, keyPath, autoIncrement, indexes }) => ({
      name, keyPath, autoIncrement,
      indexes: indexes.map((entry) => ({ ...entry })).sort((left, right) => left.name.localeCompare(right.name)),
    }))
    .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
}

export function applyNativeV18Schema(
  database: IDBDatabase,
  transaction: IDBTransaction,
  source: Record<string, V18SchemaDefinition> = V18_STORE_DEFINITIONS,
  rowsByStore: Map<string, unknown[]> = new Map(),
): void {
  // Native DDL must be synchronous within the same versionchange callback.
  // Surviving rows were collected by scanLegacyV17InsideUpgrade before DDL.
  for (const name of Array.from(database.objectStoreNames)) database.deleteObjectStore(name)
  for (const definition of Object.values(source)) {
    if (definition.removed) continue
    const objectStore = database.createObjectStore(definition.name, {
      keyPath: definition.keyPath ?? undefined,
      autoIncrement: definition.autoIncrement,
    })
    for (const entry of definition.indexes) objectStore.createIndex(entry.name, entry.keyPath, {
      unique: entry.unique, multiEntry: entry.multiEntry,
    })
    for (const row of rowsByStore.get(definition.name) ?? []) {
      if (row && typeof row === 'object') objectStore.put(row)
    }
  }
}
