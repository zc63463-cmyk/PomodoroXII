import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import {
  decodeCanonicalStandardBase64,
  parseSyncV2PullResponse,
  parseSyncV2RecoveryResponse,
} from './response-schema'

const hash = 'a'.repeat(64)
const cursor = 'cursor-token-1234'

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

describe('Sync v2 response boundaries', () => {
  it('rejects noncanonical base64 and validates canonical JSONL/count metadata', () => {
    const raw = new TextEncoder().encode('{"id":"a"}\n')
    const encoded = Buffer.from(raw).toString('base64')
    expect(Array.from(decodeCanonicalStandardBase64(encoded))).toEqual(Array.from(raw))
    expect(() => decodeCanonicalStandardBase64(`${encoded}\n`)).toThrow()

    expect(parseSyncV2RecoveryResponse({
      payload_jsonl_base64: encoded,
      entity_count: 1,
      chunk_sha256: sha256(raw),
      next_page_token: null,
      has_more: false,
      catalog_hash: hash,
      waterline_cursor: cursor,
    })).toMatchObject({ entity_count: 1 })

    expect(() => parseSyncV2RecoveryResponse({
      payload_jsonl_base64: encoded,
      entity_count: 2,
      chunk_sha256: sha256(raw),
      next_page_token: null,
      has_more: false,
      catalog_hash: hash,
      waterline_cursor: cursor,
    })).toThrow()
    expect(() => parseSyncV2RecoveryResponse({
      payload_jsonl_base64: Buffer.from('{"id":"a"} \n').toString('base64'),
      entity_count: 1,
      chunk_sha256: sha256(raw),
      next_page_token: null,
      has_more: false,
      catalog_hash: hash,
      waterline_cursor: cursor,
    })).toThrow()
  })

  it('rejects impossible UTC calendar timestamps before applying pull data', () => {
    const event = {
      operation_id: 'op-a', batch_id: 'batch-a', entity_type: 'note', entity_id: 'note-a',
      action: 'create', payload: {}, version: 0, created_at: '2026-02-30T10:00:00.000Z',
    }
    expect(() => parseSyncV2PullResponse({
      events: [event], next_cursor: cursor, has_more: false, catalog_hash: hash,
    })).toThrow()
  })
})
