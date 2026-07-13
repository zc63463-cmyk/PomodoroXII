import { describe, expect, it } from 'vitest'
import { SYNC_PULL_KEYS } from './types'
import {
  SnapshotRecoveryError,
  SyncProtocolError,
  parseSyncAckResponse,
  parseSyncClientRegistrationResponse,
  parseSyncFullResponse,
  parseSyncPullResponse,
} from './protocol'

const emptyEntities = Object.fromEntries(SYNC_PULL_KEYS.map((key) => [key, []]))

function legacyPage() {
  return {
    ...emptyEntities,
    server_time: '2026-07-13T12:00:00.000Z',
    has_more: false,
    tombstones_has_more: false,
    next_since: '2026-07-13T12:00:00.000Z',
    next_since_id: 'task-1',
    next_tombstone_since_id: 'tombstone-1',
    tombstones: [],
  }
}

function v2PullPage() {
  return {
    ...legacyPage(),
    next_since: '',
    next_since_id: '',
    next_tombstone_since_id: '',
    cursor_version: 2,
    next_cursor: 11,
  }
}

function materializedFullPage() {
  return {
    ...legacyPage(),
    next_since: '',
    next_since_id: '',
    next_tombstone_since_id: '',
    cursor_version: 2,
    next_cursor: 20,
    snapshot_token: 'snapshot-20',
    snapshot_offset: 0,
    is_full: true,
  }
}

const legacyContext = {
  requestCursor: null,
  since: '2026-07-12T00:00:00.000Z',
  sinceId: '',
  tombstoneSinceId: '',
} as const

const materializedContext = {
  protocol: null,
  snapshotToken: null,
  expectedSnapshotOffset: 0,
  snapshotCursor: null,
  recoveryRequired: false,
} as const

describe('sync protocol parsers', () => {
  it('接受合法 registration、ACK、legacy pull 与 materialized full', () => {
    expect(parseSyncClientRegistrationResponse({
      client_id: 'client-1', display_name: null, ack_cursor: 4,
      lease_expires_at: '2026-08-01T00:00:00.000Z', snapshot_required: false,
    }, 'client-1').ack_cursor).toBe(4)
    expect(parseSyncAckResponse({
      ack_cursor: 4, retention_floor: 2, current_cursor: 5,
      lease_expires_at: '2026-08-01T00:00:00.000Z',
    }, 4).ack_cursor).toBe(4)
    expect(parseSyncPullResponse(legacyPage(), legacyContext).cursor_version).toBeUndefined()
    expect(parseSyncPullResponse(v2PullPage(), { ...legacyContext, requestCursor: 10 }).next_cursor).toBe(11)
    expect(parseSyncFullResponse(materializedFullPage(), materializedContext).is_full).toBe(true)
  })

  it('拒绝缺实体 key、实体缺 id/updated_at 与未知 tombstone', () => {
    const missingKey = { ...legacyPage() } as Record<string, unknown>
    delete missingKey.tasks
    expect(() => parseSyncPullResponse(missingKey, legacyContext)).toThrow(SyncProtocolError)
    expect(() => parseSyncPullResponse({ ...legacyPage(), tasks: [{ updated_at: '2026-01-01T00:00:00Z' }] }, legacyContext)).toThrow(SyncProtocolError)
    expect(() => parseSyncPullResponse({ ...legacyPage(), tasks: [{ id: 't1', updated_at: 'bad' }] }, legacyContext)).toThrow(SyncProtocolError)
    expect(() => parseSyncPullResponse({
      ...legacyPage(),
      tombstones: [{ entity_type: 'unknown', entity_id: 'x', deleted_at: '2026-01-01T00:00:00Z' }],
    }, legacyContext)).toThrow(SyncProtocolError)
  })

  it('拒绝非 boolean flags、v2 cursor 不推进及 v2 snapshot 字段', () => {
    expect(() => parseSyncPullResponse({ ...legacyPage(), has_more: 0 }, legacyContext)).toThrow(SyncProtocolError)
    expect(() => parseSyncPullResponse({ ...v2PullPage(), next_cursor: 10, has_more: true }, {
      ...legacyContext, requestCursor: 10,
    })).toThrow(SyncProtocolError)
    expect(() => parseSyncPullResponse({ ...v2PullPage(), snapshot_token: 'forbidden' }, {
      ...legacyContext, requestCursor: 10,
    })).toThrow(SyncProtocolError)
  })

  it('拒绝 materialized full 缺 token、continuation 或 proof', () => {
    expect(() => parseSyncFullResponse({ ...materializedFullPage(), snapshot_token: undefined }, materializedContext)).toThrow(SnapshotRecoveryError)
    expect(() => parseSyncFullResponse({
      ...materializedFullPage(), has_more: true, snapshot_offset: 1,
    }, materializedContext)).toThrow(SnapshotRecoveryError)
    expect(() => parseSyncFullResponse({
      ...materializedFullPage(), recovery_proof: undefined,
    }, { ...materializedContext, recoveryRequired: true })).toThrow(SnapshotRecoveryError)
  })

  it('拒绝畸形 registration 与 ACK，包括无效 ISO timestamp 和 ACK cursor 不匹配', () => {
    expect(() => parseSyncClientRegistrationResponse({
      client_id: 'other', display_name: null, ack_cursor: 0,
      lease_expires_at: 'not-a-date', snapshot_required: false,
    }, 'client-1')).toThrow(SyncProtocolError)
    expect(() => parseSyncAckResponse({
      ack_cursor: 5, retention_floor: 0, current_cursor: 5,
      lease_expires_at: 'not-a-date',
    }, 4)).toThrow(SyncProtocolError)
  })

  it('拒绝终页 cursor 倒退、续页 terminal offset 原地不动及缺 tombstones', () => {
    expect(() => parseSyncPullResponse({ ...v2PullPage(), next_cursor: 9 }, {
      ...legacyContext, requestCursor: 10,
    })).toThrow(SyncProtocolError)
    expect(() => parseSyncFullResponse({
      ...materializedFullPage(), snapshot_token: 'snapshot-20', snapshot_offset: 1,
    }, {
      ...materializedContext,
      protocol: 'materialized',
      snapshotToken: 'snapshot-20',
      expectedSnapshotOffset: 1,
      snapshotCursor: 20,
    })).toThrow(SnapshotRecoveryError)
    const missingTombstones = { ...legacyPage() } as Record<string, unknown>
    delete missingTombstones.tombstones
    expect(() => parseSyncPullResponse(missingTombstones, legacyContext)).toThrow(SyncProtocolError)
  })

  it('拒绝缺少实体组真实领域字段的行，即使携带未知字段', () => {
    expect(() => parseSyncPullResponse({
      ...legacyPage(),
      tasks: [{
        id: 't1', updated_at: '2026-01-01T00:00:00Z', version: 1, unexpected: true,
      }],
    }, legacyContext)).toThrow(SyncProtocolError)
  })

  it('严格校验 legacy continuation 与 full 模式互斥', () => {
    expect(() => parseSyncPullResponse({ ...legacyPage(), has_more: true }, {
      ...legacyContext,
      since: '2026-07-13T12:00:00.000Z',
      sinceId: 'task-1',
      tombstoneSinceId: 'tombstone-1',
    })).toThrow(SyncProtocolError)
    expect(() => parseSyncPullResponse({
      ...legacyPage(),
      next_since: '2026-07-11T00:00:00.000Z',
    }, legacyContext)).toThrow(SyncProtocolError)
    expect(() => parseSyncFullResponse({ ...legacyPage(), is_full: false }, materializedContext)).toThrow(SyncProtocolError)
    expect(() => parseSyncFullResponse({ ...materializedFullPage(), recovery_proof: 'unexpected' }, materializedContext)).toThrow(SnapshotRecoveryError)
  })
})
