import { describe, it, expect } from 'vitest'
import type { InternalAxiosRequestConfig } from 'axios'
import { ensureMutationIdempotencyKey, buildBatchIdempotencyKey } from '@/services/idempotency'
import type { OutboxEvent } from '@/types'

function makeConfig(method: string): InternalAxiosRequestConfig {
  return {
    method,
    url: '/test',
    headers: {},
  } as InternalAxiosRequestConfig
}

describe('ensureMutationIdempotencyKey', () => {
  it('POST generates a UUID Idempotency-Key', () => {
    const config = makeConfig('post')
    const result = ensureMutationIdempotencyKey(config)
    expect(result.headers['Idempotency-Key']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    )
  })

  it('PUT generates a UUID Idempotency-Key', () => {
    const config = makeConfig('put')
    const result = ensureMutationIdempotencyKey(config)
    expect(result.headers['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('PATCH generates a UUID Idempotency-Key', () => {
    const config = makeConfig('patch')
    const result = ensureMutationIdempotencyKey(config)
    expect(result.headers['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('DELETE generates a UUID Idempotency-Key', () => {
    const config = makeConfig('delete')
    const result = ensureMutationIdempotencyKey(config)
    expect(result.headers['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('explicit caller key is preserved unchanged', () => {
    const config = makeConfig('post')
    config.headers!['Idempotency-Key'] = 'my-explicit-key-123'
    const result = ensureMutationIdempotencyKey(config)
    expect(result.headers['Idempotency-Key']).toBe('my-explicit-key-123')
  })

  it('GET does not add Idempotency-Key', () => {
    const config = makeConfig('get')
    const result = ensureMutationIdempotencyKey(config)
    expect(result.headers['Idempotency-Key']).toBeUndefined()
  })

  it('HEAD does not add Idempotency-Key', () => {
    const config = makeConfig('head')
    const result = ensureMutationIdempotencyKey(config)
    expect(result.headers['Idempotency-Key']).toBeUndefined()
  })

  it('does not overwrite existing key on second call (idempotent)', () => {
    const config = makeConfig('post')
    const first = ensureMutationIdempotencyKey(config)
    const firstKey = first.headers['Idempotency-Key']
    const second = ensureMutationIdempotencyKey(first)
    expect(second.headers['Idempotency-Key']).toBe(firstKey)
  })
})

describe('buildBatchIdempotencyKey', () => {
  function makeRow(operationId: string, id = 1): OutboxEvent {
    return {
      id,
      entityType: 'task',
      entityId: `e${id}`,
      action: 'create',
      payload: '{}',
      createdAt: 1000,
      synced: false,
      operationId,
      expectedVersion: null,
      requiresVersionRebase: false,
    }
  }

  it('rejects empty batch', async () => {
    await expect(buildBatchIdempotencyKey([])).rejects.toThrow('empty batch')
  })

  it('rejects row with missing operationId', async () => {
    const row = makeRow('')
    await expect(buildBatchIdempotencyKey([row])).rejects.toThrow('operationId')
  })

  it('rejects row with undefined operationId', async () => {
    const row = makeRow('op-1')
    row.operationId = undefined
    await expect(buildBatchIdempotencyKey([row])).rejects.toThrow('operationId')
  })

  it('returns sync- prefixed key of length 69', async () => {
    const key = await buildBatchIdempotencyKey([makeRow('op-1')])
    expect(key).toMatch(/^sync-[0-9a-f]{64}$/)
    expect(key).toHaveLength(69)
  })

  it('produces same key for same operationIds in same order', async () => {
    const rows1 = [makeRow('op-1', 1), makeRow('op-2', 2)]
    const rows2 = [makeRow('op-1', 1), makeRow('op-2', 2)]
    const key1 = await buildBatchIdempotencyKey(rows1)
    const key2 = await buildBatchIdempotencyKey(rows2)
    expect(key1).toBe(key2)
  })

  it('produces different key for different order', async () => {
    const key1 = await buildBatchIdempotencyKey([makeRow('op-1', 1), makeRow('op-2', 2)])
    const key2 = await buildBatchIdempotencyKey([makeRow('op-2', 2), makeRow('op-1', 1)])
    expect(key1).not.toBe(key2)
  })

  it('produces different key for different operationIds', async () => {
    const key1 = await buildBatchIdempotencyKey([makeRow('op-1')])
    const key2 = await buildBatchIdempotencyKey([makeRow('op-2')])
    expect(key1).not.toBe(key2)
  })
})
