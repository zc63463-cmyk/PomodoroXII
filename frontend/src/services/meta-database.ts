/**
 * Meta IndexedDB for space list cache (F0 §3.3).
 *
 * Stores SpaceMeta records in a separate Dexie DB (pxii_meta) so that
 * the space list is available offline without opening a per-space DB.
 */

import Dexie, { type Table } from 'dexie'
import { META_DB_NAME } from '@/lib/platform'
import { canonicalize } from 'json-canonicalize'
import { hashCommandPayload, type JsonValue } from '@/lib/contracts/payload-hash'

export interface SpaceMeta {
  id: string
  name: string
  db_path: string
  notes_dir: string
  is_default: boolean
  created_at: string
  updated_at: string
}

export interface ActiveSessionLocatorMirror {
  key: 'active'
  spaceId: string
  sessionId: string
  operationId: string
  state: 'claiming' | 'active' | 'releasing'
  ownerDeviceId: string
  ownerTabId: string
  ownershipEpoch: number
  leaseExpiresAt: string
  updatedAt: string
}

export interface DeviceIdentityRow { key: 'device'; deviceId: string; createdAt: string }
export interface SessionTabRow {
  tabId: string
  deviceId: string
  openedAt: string
  lastSeenAt: string
  closedAt: string | null
}
export interface ProvisionalOperationRow {
  operationId: string
  deviceId: string
  tabId: string
  spaceId: string
  sessionId: string
  cachedOwnershipEpoch: number | null
  intentJson: string
  payloadHash: string
  state: 'pending' | 'activating' | 'conflict' | 'awaiting_s4' | 'resolved'
  resolutionOperationId?: string | null
  resolutionConflictIdentityJson?: string | null
  resolutionSelectedRole?: 'active' | 'candidate' | null
  resolutionResolvedAt?: string | null
  resolutionRequestHash?: string | null
  createdAt: string
  updatedAt: string
}

export interface CanonicalProvisionalStartIntent {
  operationId: string
  spaceId: string
  sessionId: string
  deviceId: string
  tabId: string
  level2WorkItemId: string
  level3WorkItemIds: string[]
  plannedSeconds: number
  startedAt: string
  expectedWorkItemVersions: Record<string, number>
}

export async function buildProvisionalOperationRow(
  input: CanonicalProvisionalStartIntent,
  cachedOwnershipEpoch: number | null,
): Promise<ProvisionalOperationRow> {
  if (cachedOwnershipEpoch !== null &&
      (!Number.isInteger(cachedOwnershipEpoch) || cachedOwnershipEpoch <= 0)) {
    throw new Error('cachedOwnershipEpoch must be null or a positive integer')
  }
  const intent = {
    spaceId: input.spaceId,
    sessionId: input.sessionId,
    deviceId: input.deviceId,
    tabId: input.tabId,
    level2WorkItemId: input.level2WorkItemId,
    level3WorkItemIds: input.level3WorkItemIds,
    plannedSeconds: input.plannedSeconds,
    startedAt: input.startedAt,
    expectedWorkItemVersions: input.expectedWorkItemVersions,
  }
  const intentJson = canonicalize(intent)
  if (intentJson === undefined) throw new Error('provisional_intent_not_canonical')
  return {
    operationId: input.operationId,
    deviceId: input.deviceId,
    tabId: input.tabId,
    spaceId: input.spaceId,
    sessionId: input.sessionId,
    cachedOwnershipEpoch,
    intentJson,
    payloadHash: await hashCommandPayload(intent as JsonValue),
    state: 'pending',
    createdAt: input.startedAt,
    updatedAt: input.startedAt,
  }
}

export type ProvisionalClaimResult =
  | { disposition: 'created'; row: ProvisionalOperationRow }
  | { disposition: 'existing'; row: ProvisionalOperationRow }

export class MetaDB extends Dexie {
  spaces!: Table<SpaceMeta, string>
  activeSessionLocator!: Table<ActiveSessionLocatorMirror, string>
  deviceIdentity!: Table<DeviceIdentityRow, string>
  sessionTabs!: Table<SessionTabRow, string>
  provisionalOperations!: Table<ProvisionalOperationRow, string>

  constructor(name = META_DB_NAME) {
    super(name) // 'pxii_meta'
    this.version(1).stores({ spaces: 'id, name, is_default' })
    this.version(2).stores({
      spaces: 'id, name, is_default',
      activeSessionLocator: 'key, spaceId, sessionId, state, ownershipEpoch',
      deviceIdentity: 'key, deviceId',
      sessionTabs: 'tabId, deviceId, lastSeenAt, closedAt',
      provisionalOperations: 'operationId, deviceId, spaceId, sessionId, state, createdAt',
    })
  }

  async putSpaces(spaces: SpaceMeta[]): Promise<void> {
    await this.spaces.bulkPut(spaces)
  }

  async getAllSpaces(): Promise<SpaceMeta[]> {
    return this.spaces.toArray()
  }

  async clearSpaces(): Promise<void> {
    await this.spaces.clear()
  }

  async putLocator(locator: ActiveSessionLocatorMirror | null): Promise<void> {
    if (locator === null) await this.activeSessionLocator.clear()
    else await this.activeSessionLocator.put(locator)
  }

  async claimProvisional(row: ProvisionalOperationRow): Promise<ProvisionalClaimResult> {
    if (row.cachedOwnershipEpoch !== null &&
        (!Number.isInteger(row.cachedOwnershipEpoch) || row.cachedOwnershipEpoch <= 0)) {
      throw new Error('cachedOwnershipEpoch must be null or a positive integer')
    }
    return this.transaction('rw', this.provisionalOperations, async () => {
      const existing = await this.provisionalOperations.get(row.operationId)
      if (existing) {
        const sameIntent = existing.intentJson === row.intentJson &&
          existing.payloadHash === row.payloadHash && existing.spaceId === row.spaceId &&
          existing.sessionId === row.sessionId && existing.deviceId === row.deviceId &&
          existing.tabId === row.tabId &&
          existing.cachedOwnershipEpoch === row.cachedOwnershipEpoch &&
          existing.createdAt === row.createdAt
        if (!sameIntent) throw new Error('idempotency_conflict')
        return { disposition: 'existing', row: existing } as const
      }
      const blockingStates = new Set<ProvisionalOperationRow['state']>([
        'pending', 'activating', 'conflict',
      ])
      const active = await this.provisionalOperations
        .where('deviceId').equals(row.deviceId)
        .and((item) => blockingStates.has(item.state))
        .first()
      if (active) throw new Error('active_session_exists')
      await this.provisionalOperations.add(row)
      return { disposition: 'created', row } as const
    })
  }
}

export const metaDB = new MetaDB()
