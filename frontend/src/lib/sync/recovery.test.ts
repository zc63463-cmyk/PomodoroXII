import { createHash } from 'node:crypto'
import { canonicalize } from 'json-canonicalize'
import { describe, expect, it } from 'vitest'

import {
  assertRecoveryTokenProgress,
  parseCanonicalJsonLines,
  verifyChunkSha256,
  runFullRecovery,
} from './recovery'
import { openPomodoroXIDB } from '@/services/dexie-v18-cutover'
import { loadSyncV2Meta } from './sync-meta'
import { withSpaceAuthorityFence } from './space-authority-fence'
import type { AxiosInstance } from 'axios'

const record = {
  kind: 'entity', entity_type: 'note', entity_id: 'note-a', version: 1,
  updated_at: '2026-07-14T10:00:00.000Z', payload: { id: 'note-a' },
} as const

describe('Sync v2 recovery byte authority', () => {
  it('parses only canonical UTF-8 JSONL snapshot records', () => {
    const bytes = new TextEncoder().encode(`${canonicalize(record)}\n`)
    expect(parseCanonicalJsonLines(bytes)).toEqual([record])
    expect(() => parseCanonicalJsonLines(
      new TextEncoder().encode(`{ "kind":"entity" }\n`),
    )).toThrow('not canonical')
    expect(() => parseCanonicalJsonLines(
      new TextEncoder().encode(JSON.stringify(record)),
    )).toThrow('end with LF')
  })

  it('hashes the exact downloaded bytes and requires page-token progress', async () => {
    const bytes = new TextEncoder().encode(`${canonicalize(record)}\n`)
    const expected = createHash('sha256').update(bytes).digest('hex')
    await expect(verifyChunkSha256(bytes, expected)).resolves.toBeUndefined()
    await expect(verifyChunkSha256(bytes, '0'.repeat(64))).rejects.toThrow('hash mismatch')

    expect(() => assertRecoveryTokenProgress('page-a', {
      payload_jsonl_base64: '', entity_count: 0, chunk_sha256: '0'.repeat(64),
      next_page_token: 'page-a', has_more: true, catalog_hash: 'a'.repeat(64),
      waterline_cursor: 'cursor-token-1234',
    })).toThrow('did not advance')
  })

  it('commits an empty recovery waterline before ACK and clears staging', async () => {
    const db = await openPomodoroXIDB(`recovery-test-${crypto.randomUUID()}`)
    const originalLocks = Object.getOwnPropertyDescriptor(navigator, 'locks')
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: { request: async <T>(_name: string, _options: unknown, body: () => Promise<T>) => body() },
    })
    const calls: string[] = []
    const catalogHash = 'a'.repeat(64)
    const waterline = 'cursor-token-1234'
    const api = {
      get: async () => {
        calls.push('recover')
        return { data: {
          payload_jsonl_base64: '', entity_count: 0,
          chunk_sha256: createHash('sha256').update(new Uint8Array()).digest('hex'),
          next_page_token: null, has_more: false, catalog_hash: catalogHash,
          waterline_cursor: waterline,
        } }
      },
      post: async () => {
        calls.push('ack')
        expect((await loadSyncV2Meta(db)).pendingAck).toBe(waterline)
        return { data: {
          client_id: 'client-a', accepted: true, requires_recovery: false,
          catalog_hash: catalogHash,
        } }
      },
    } as unknown as AxiosInstance
    try {
      await withSpaceAuthorityFence(db.spaceId, (token) =>
        runFullRecovery(db, api, db.spaceId, 'client-a', token))
      expect(calls).toEqual(['recover', 'ack'])
      expect(await db.syncRecoveryState.get('active')).toBeUndefined()
      expect(await db.syncRecoveryChunks.count()).toBe(0)
      expect(await loadSyncV2Meta(db)).toEqual({
        cursor: waterline, pendingAck: null, catalogHash, requiresFullRecovery: false,
      })
    } finally {
      await db.delete()
      if (originalLocks) Object.defineProperty(navigator, 'locks', originalLocks)
      else Reflect.deleteProperty(navigator, 'locks')
    }
  })
})
