import { dexieDbNameForSpace } from '@/lib/platform'
import { DEXIE_V17_NATIVE_VERSION, DEXIE_V18_NATIVE_VERSION, V18_REMOVED_STORE_NAMES, V18_STORE_DEFINITIONS, applyNativeV18Schema } from './dexie-v18-schema'

export const REMOVED_V18_TABLES = V18_REMOVED_STORE_NAMES

const LEGACY_REFERENCE_PATHS = new Map<string, readonly string[]>([
  ['quickNotes', ['session_id']],
  ['timeBlocks', ['task_id']],
  ['reflections', ['related_task_ids', 'auto_linked_session_ids']],
  ['reports', ['config.task_ids', 'config.session_id', 'config.session_type', 'config.session_types']],
  ['reportTemplates', ['config.task_ids', 'config.session_id', 'config.session_type', 'config.session_types']],
])

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function hasOwnPath(row: Record<string, unknown>, path: string): boolean {
  let current: unknown = row
  for (const segment of path.split('.')) {
    if (!isRecord(current) || !Object.prototype.hasOwnProperty.call(current, segment)) return false
    current = current[segment]
  }
  return true
}

function findLegacyReference(tableName: string, value: unknown): string | null {
  if (!isRecord(value)) return 'non_object_row'
  for (const path of LEGACY_REFERENCE_PATHS.get(tableName) ?? []) {
    if (hasOwnPath(value, path)) return path
  }
  if (tableName === 'reports' || tableName === 'reportTemplates') {
    const config = value.config
    if (isRecord(config) && Array.isArray(config.dimensions) && config.dimensions.some((dimension) =>
      dimension === 'task_type' || dimension === 'session_type')) return 'config.dimensions'
  }
  return null
}

interface ScanCallbacks {
  onRejected(error: Error): void
  onClean(rowsByStore: Map<string, unknown[]>): void
}

export function scanLegacyV17InsideUpgrade(transaction: IDBTransaction, callbacks: ScanCallbacks): void {
  const requiredStores = new Set<string>([
    ...REMOVED_V18_TABLES, ...LEGACY_REFERENCE_PATHS.keys(), 'outbox',
  ])
  const available = new Set(Array.from(transaction.objectStoreNames))
  const missing = [...requiredStores].filter((name) => !available.has(name)).sort()
  if (missing.length > 0) {
    callbacks.onRejected(new Error(`unsupported_client_schema:missing:${missing.join(',')}`))
    return
  }

  const rowsByStore = new Map<string, unknown[]>()
  let pending = 0
  let settled = false
  const reject = (error: Error) => {
    if (settled) return
    settled = true
    callbacks.onRejected(error)
  }
  const done = () => {
    if (settled) return
    pending -= 1
    if (pending === 0) {
      settled = true
      callbacks.onClean(rowsByStore)
    }
  }
  const scheduleScan = (name: string) => {
    pending += 1
    const request = transaction.objectStore(name).getAll()
    request.onerror = () => reject(new Error(`legacy_client_scan_failed:${name}`))
    request.onsuccess = () => {
      if (settled) return
      const rows = request.result as unknown[]
      rowsByStore.set(name, rows)
      if (REMOVED_V18_TABLE_NAMES.has(name) && rows.length > 0) {
        reject(new Error(`legacy_client_data_present:${name}`))
        return
      }
      if (name === 'outbox' && rows.length > 0) {
        reject(new Error('legacy_client_data_present:outbox'))
        return
      }
      if (rows.some((row) => findLegacyReference(name, row) !== null)) {
        const reference = rows.map((row) => findLegacyReference(name, row)).find(Boolean)
        reject(new Error(`legacy_client_data_present:${name}.${reference}`))
        return
      }
      done()
    }
  }

  const REMOVED_V18_TABLE_NAMES = new Set<string>(REMOVED_V18_TABLES)
  // Scan every existing store so surviving rows can be replayed into the
  // recreated v18 inventory. The required set above only controls the
  // fail-closed v17 contract, not the preservation set.
  for (const name of available) scheduleScan(name)
}

export async function atomicDexieV18Cutover(dbName: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.open(dbName, DEXIE_V18_NATIVE_VERSION)
    let rejection: Error | null = null
    request.onupgradeneeded = (event) => {
      const database = request.result
      const transaction = request.transaction
      if (!transaction) {
        rejection = new Error('dexie_v18_cutover_missing_transaction')
        return
      }
      const apply = (rowsByStore?: Map<string, unknown[]>) => {
        try {
          // The scanner owns the IDB request barrier. DDL is intentionally only
          // reached from its final request callback in this same transaction.
          applyNativeV18Schema(database, transaction, V18_STORE_DEFINITIONS, rowsByStore)
        } catch (error) {
          rejection = error instanceof Error ? error : new Error('dexie_v18_schema_apply_failed')
          try { transaction.abort() } catch { /* transaction already inactive */ }
        }
      }
      if (event.oldVersion === 0) {
        apply()
      } else if (event.oldVersion !== DEXIE_V17_NATIVE_VERSION) {
        rejection = new Error(`unsupported_client_schema:${event.oldVersion}`)
        try { transaction.abort() } catch { /* noop */ }
      } else {
        scanLegacyV17InsideUpgrade(transaction, {
          onRejected(error) {
            rejection = error
            try { transaction.abort() } catch { /* noop */ }
          },
          onClean(rowsByStore) { apply(rowsByStore) },
        })
      }
    }
    // An old v17 connection receives versionchange and may close before the
    // request can proceed. onblocked is informational; rejecting here creates
    // a false failure before that versionchange handler has a chance to close.
    request.onblocked = () => undefined
    request.onerror = () => reject(rejection ?? request.error ?? new Error('dexie_v18_cutover_failed'))
    request.onsuccess = () => { request.result.close(); resolve() }
  })
}

async function readNativeReceiptSchema(
  dbName: string,
): Promise<{ version: number; keyPath: string | string[] | null; storeNames: string[] }> {
  return await new Promise<{ version: number; keyPath: string | string[] | null; storeNames: string[] }>((resolve, reject) => {
    const request = indexedDB.open(dbName)
    request.onsuccess = () => {
      const database = request.result
      try {
        const storeNames = Array.from(database.objectStoreNames).sort()
        const keyPath = database.objectStoreNames.contains('sessionCommandReceipts')
          ? database.transaction('sessionCommandReceipts', 'readonly').objectStore('sessionCommandReceipts').keyPath
          : null
        resolve({ version: database.version, keyPath, storeNames })
      } catch (error) {
        reject(error)
      } finally {
        database.close()
      }
    }
    request.onerror = () => reject(request.error ?? new Error('dexie_v18_schema_probe_failed'))
  })
}

function stableSerialize(value: unknown): string {
  if (value instanceof Date) return JSON.stringify(value.toISOString())
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(',')}}`
  }
  const serialized = JSON.stringify(value)
  return serialized === undefined ? String(value) : serialized
}

function assertNativeV18Inventory(storeNames: string[]): void {
  const expected = Object.values(V18_STORE_DEFINITIONS)
    .filter((definition) => !definition.removed)
    .map((definition) => definition.name)
    .sort()
  if (stableSerialize(storeNames) !== stableSerialize(expected)) {
    const unexpected = storeNames.find((name) => !expected.includes(name))
    throw new Error(unexpected ? `unsupported_client_schema:180_store:${unexpected}` : 'unsupported_client_schema:180_inventory')
  }
}

export async function openPomodoroXIDB(spaceId: string) {
  if (!spaceId.trim()) throw new Error('spaceId is required')
  const dbName = dexieDbNameForSpace(spaceId)
  await atomicDexieV18Cutover(dbName)
  const nativeReceiptSchema = await readNativeReceiptSchema(dbName)
  assertNativeV18Inventory(nativeReceiptSchema.storeNames)
  const nativeReceiptKeyPath = nativeReceiptSchema.keyPath
  if (!Array.isArray(nativeReceiptKeyPath) || nativeReceiptKeyPath.length !== 2 ||
      nativeReceiptKeyPath[0] !== 'commandId' || nativeReceiptKeyPath[1] !== 'attempt') {
    throw new Error('unsupported_client_schema:180_receipt_key')
  }
  const { PomodoroXIDB } = await import('./database')
  const database = new PomodoroXIDB(spaceId, dbName)
  await database.open()
  if (database.name !== dbName || database.spaceId !== spaceId || database.verno !== 18) {
    database.close()
    throw new Error('space_database_open_identity_mismatch')
  }
  // V18 is the locked breaking cutover. A database already opened with an
  // earlier draft of V18 may still carry the old commandId-only receipt key;
  // refuse it explicitly instead of allowing composite-key writes to fail
  // nondeterministically or overwrite receipt history.
  return database
}

export { DEXIE_V17_NATIVE_VERSION, DEXIE_V18_NATIVE_VERSION }
