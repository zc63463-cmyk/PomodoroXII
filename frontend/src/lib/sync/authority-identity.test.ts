import { readFileSync } from 'node:fs'

import { canonicalize } from 'json-canonicalize'
import { describe, expect, it } from 'vitest'

import { hashCommandPayload } from '@/lib/contracts/payload-hash'
import { INITIAL_S4_OUTBOX_FIELDS, type FrozenOutboxIdentity } from '@/services/database'
import type { OutboxEvent } from '@/types'
import {
  FROZEN_OUTBOX_IDENTITY_KEYS,
  buildReadyRootIdentities,
  decodeCanonicalBase64,
  freezeOutboxIdentity,
  requireSameFrozenIdentity,
  requireSameReadyRootSet,
  sha256HexBytes,
} from './authority-identity'
import vectors from './fixtures/sync-event-canonical-vectors.json'

type CanonicalEventVector = {
  name: string
  event: unknown
  canonicalUtf8: string
  canonicalBytes: number
  sha256: string
}

const timestamp = '2026-08-07T01:00:00.000Z'

async function scheduleRow(overrides: Partial<OutboxEvent> = {}): Promise<OutboxEvent> {
  const payload = {
    id: 'schedule-a', title: 'Focus', due_at: timestamp, completed_at: null,
    priority: 'medium', color: '#123456', all_day: false,
    start_time: null, end_time: null, created_at: timestamp, updated_at: timestamp,
  }
  return {
    id: 1, spaceId: 'space-a', entityType: 'schedule', entityId: 'schedule-a',
    action: 'create', payload: JSON.stringify(payload),
    payloadHash: await hashCommandPayload(payload), operationId: 'operation-a',
    compoundOperationId: null, compoundOrder: null, expectedVersion: null,
    requiresVersionRebase: false, transportState: 'ready', createdAt: timestamp,
    synced: false, lastError: null, lastErrorCode: null, failedAt: null,
    attemptCount: 0, ...INITIAL_S4_OUTBOX_FIELDS, ...overrides,
  }
}

describe('frozen outbox authority identity', () => {
  it('freezes canonical post-image bytes and every immutable authority field', async () => {
    const frozen = await freezeOutboxIdentity(await scheduleRow())
    expect(FROZEN_OUTBOX_IDENTITY_KEYS).toHaveLength(15)
    expect(JSON.parse(new TextDecoder().decode(
      decodeCanonicalBase64(frozen.payloadCanonicalBase64),
    ))).toMatchObject({ id: 'schedule-a' })
    expect(frozen).toMatchObject({
      durableKey: 1, spaceId: 'space-a', operationId: 'operation-a',
      retryPredecessorOperationId: null, attemptCount: 0,
    })
  })

  it.each(FROZEN_OUTBOX_IDENTITY_KEYS)(
    'rejects independent %s drift',
    async (key) => {
      const frozen = await freezeOutboxIdentity(await scheduleRow())
      const mutated = structuredClone(frozen) as FrozenOutboxIdentity
      Object.assign(mutated, {
        [key]: typeof frozen[key] === 'number'
          ? (frozen[key] as number) + 1
          : frozen[key] === null ? 'drift' : `${String(frozen[key])}-drift`,
      })
      expect(() => requireSameFrozenIdentity(frozen, mutated))
        .toThrow(`outbox_identity_drift:${key}`)
    },
  )

  it('hashes sorted standalone roots and rejects root-set drift', async () => {
    const first = await scheduleRow()
    const second = await scheduleRow({
      id: 2, entityId: 'schedule-b', operationId: 'operation-b',
      payload: (await scheduleRow()).payload.replaceAll('schedule-a', 'schedule-b'),
    })
    second.payloadHash = await hashCommandPayload(JSON.parse(second.payload))
    const roots = await buildReadyRootIdentities([second, first])
    expect(roots.readyRoots.map((root) => root.rootId)).toEqual([
      'operation-a', 'operation-b',
    ])
    expect(roots.readyRootSetSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(() => requireSameReadyRootSet(
      roots.readyRoots, roots.readyRootSetSha256,
      roots.readyRoots, '0'.repeat(64),
    )).toThrow('ready_root_identity_drift')
  })

  it('rejects persisted payload/business-hash disagreement', async () => {
    await expect(freezeOutboxIdentity(await scheduleRow({ payloadHash: '0'.repeat(64) })))
      .rejects.toThrow('outbox_payload_hash_mismatch')
  })
})

describe('cross-language Sync canonical vectors', () => {
  it('matches the backend authority fixture byte-for-byte', () => {
    const backend = readFileSync('../backend/tests/fixtures/sync_event_canonical_vectors.json')
    const frontend = readFileSync('src/lib/sync/fixtures/sync-event-canonical-vectors.json')
    expect(frontend.equals(backend)).toBe(true)
  })

  it.each(vectors as CanonicalEventVector[])('matches canonical bytes and digest for $name', async (vector) => {
    const canonical = canonicalize(vector.event)
    expect(canonical).toBe(vector.canonicalUtf8)
    const bytes = new TextEncoder().encode(canonical!)
    expect(bytes.byteLength).toBe(vector.canonicalBytes)
    await expect(sha256HexBytes(bytes)).resolves.toBe(vector.sha256)
  })
})
