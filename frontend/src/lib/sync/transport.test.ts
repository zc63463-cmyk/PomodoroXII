import axios, { type AxiosResponse, type InternalAxiosRequestConfig } from 'axios'
import { describe, expect, it } from 'vitest'

import {
  SYNC_V2_ERROR_ACCEPT,
  syncV2Ack,
  syncV2Pull,
  syncV2Push,
  syncV2QueryOperations,
  syncV2Recover,
  syncV2Status,
} from './transport'

const catalogHash = 'a'.repeat(64)
const cursor = 'opaque-cursor-0001'

function adapter(responseData: unknown, capture: InternalAxiosRequestConfig[]) {
  return async (config: InternalAxiosRequestConfig): Promise<AxiosResponse> => {
    capture.push(config)
    return { data: responseData, status: 200, statusText: 'OK', headers: {}, config }
  }
}

describe('Sync v2 transport', () => {
  it('owns all six URLs, preserves config, and forces the canonical Accept header', async () => {
    const calls: InternalAxiosRequestConfig[] = []
    const api = axios.create()
    const config = { headers: { 'X-Test': 'kept' } }

    api.defaults.adapter = adapter({ items: [{
      operation_id: 'op-a', state: 'unknown', batch_id: null, result: null,
    }] }, calls)
    await syncV2QueryOperations(api, { client_id: 'client-a', operation_ids: ['op-a'] }, config)

    api.defaults.adapter = adapter({
      batch_id: 'batch-a', applied: [], conflicts: [], errors: [],
    }, calls)
    await syncV2Push(api, { client_id: 'client-a', batch_id: 'batch-a', events: [] }, config)

    api.defaults.adapter = adapter({
      events: [], next_cursor: cursor, has_more: false, catalog_hash: catalogHash,
    }, calls)
    await syncV2Pull(api, { client_id: 'client-a', cursor: null }, config)

    api.defaults.adapter = adapter({
      payload_jsonl_base64: '', entity_count: 0, chunk_sha256: '0'.repeat(64),
      next_page_token: null, has_more: false, catalog_hash: catalogHash,
      waterline_cursor: cursor,
    }, calls)
    await syncV2Recover(api, { client_id: 'client-a', page_token: null }, config)

    api.defaults.adapter = adapter({
      client_id: 'client-a', accepted: true, requires_recovery: false,
      catalog_hash: catalogHash,
    }, calls)
    await syncV2Ack(api, { client_id: 'client-a', cursor }, config)

    api.defaults.adapter = adapter({
      catalog_hash: catalogHash, client_id: 'client-a', registered: true,
      requires_recovery: false, recovery_action: null,
      visible_event_count: 0, active_client_count: 1, recovery_client_count: 0,
    }, calls)
    await syncV2Status(api, { client_id: 'client-a' }, config)

    expect(calls.map((call) => call.url)).toEqual([
      '/sync/v2/operations/query', '/sync/v2/push',
      '/sync/v2/pull', '/sync/v2/recover',
      '/sync/v2/ack', '/sync/v2/status',
    ])
    for (const call of calls) {
      expect(call.headers.get('Accept')).toBe(SYNC_V2_ERROR_ACCEPT)
      expect(call.headers.get('X-Test')).toBe('kept')
    }
  })

  it('rejects strict response extras and query reordering before returning data', async () => {
    const api = axios.create()
    api.defaults.adapter = adapter({ items: [
      { operation_id: 'op-b', state: 'unknown', batch_id: null, result: null },
      { operation_id: 'op-a', state: 'unknown', batch_id: null, result: null },
    ] }, [])
    await expect(syncV2QueryOperations(api, {
      client_id: 'client-a', operation_ids: ['op-a', 'op-b'],
    }))
      .rejects.toThrow('order/coverage')

    api.defaults.adapter = adapter({
      events: [], next_cursor: cursor, has_more: false,
      catalog_hash: catalogHash, unexpected: true,
    }, [])
    await expect(syncV2Pull(api, { client_id: 'client-a', cursor: null })).rejects.toThrow()
  })
})
