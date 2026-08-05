import { describe, it, expect } from 'vitest'
import { AxiosHeaders } from 'axios'
import type { InternalAxiosRequestConfig } from 'axios'
import { ensureMutationIdempotencyKey, buildBatchIdempotencyKey } from '@/services/idempotency'
import type { OutboxEvent } from '@/types'

function makeConfig(method: string): InternalAxiosRequestConfig {
  return {
    method,
    url: '/test',
    headers: new AxiosHeaders(),
  } as InternalAxiosRequestConfig
}

describe('ensureMutationIdempotencyKey', () => {
  it('POST generates a UUID Idempotency-Key', () => {
    const config = makeConfig('post')
    const result = ensureMutationIdempotencyKey(config)
    expect(result.headers.get('Idempotency-Key')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    )
  })

  it('PUT / PATCH / DELETE all generate a UUID', () => {
    for (const method of ['put', 'patch', 'delete']) {
      const result = ensureMutationIdempotencyKey(makeConfig(method))
      expect(result.headers.get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/)
    }
  })

  it('GET / HEAD do not add Idempotency-Key', () => {
    for (const method of ['get', 'head']) {
      const result = ensureMutationIdempotencyKey(makeConfig(method))
      expect(result.headers.get('Idempotency-Key')).toBeUndefined()
    }
  })

  it('preserves explicit lowercase idempotency-key (case-insensitive)', () => {
    const config = makeConfig('post')
    config.headers.set('idempotency-key', 'my-explicit-key-123')
    const result = ensureMutationIdempotencyKey(config)
    expect(result.headers.get('Idempotency-Key')).toBe('my-explicit-key-123')
    expect(result.headers.get('IDEMPOTENCY-KEY')).toBe('my-explicit-key-123')
  })

  it('preserves explicit mixed-case key and does not overwrite', () => {
    const config = makeConfig('post')
    config.headers.set('IDEMPOTENCY-key', 'mixed-case-value')
    const result = ensureMutationIdempotencyKey(config)
    expect(result.headers.get('Idempotency-Key')).toBe('mixed-case-value')
  })

  it('does not overwrite existing key on second call (idempotent)', () => {
    const config = makeConfig('post')
    const first = ensureMutationIdempotencyKey(config)
    const firstKey = first.headers.get('Idempotency-Key')
    const second = ensureMutationIdempotencyKey(first)
    expect(second.headers.get('Idempotency-Key')).toBe(firstKey)
  })
})

describe('buildBatchIdempotencyKey', () => {
  function makeRow(operationId: string, id = 1): OutboxEvent {
    return {
      id,
      spaceId: 'idempotency-test',
      entityType: 'note',
      entityId: `e${id}`,
      action: 'create',
      payload: '{}',
      createdAt: '2026-07-06T00:00:00.000Z',
      synced: false,
      payloadHash: '0'.repeat(64),
      compoundOperationId: null,
      compoundOrder: null,
      operationId,
      expectedVersion: null,
      requiresVersionRebase: false,
      transportState: 'ready',
      lastError: null,
      lastErrorCode: null,
      failedAt: null,
      attemptCount: 0,
    }
  }

  it('rejects empty batch', async () => {
    await expect(buildBatchIdempotencyKey([])).rejects.toThrow('empty batch')
  })

  it('rejects row with missing operationId', async () => {
    const row = makeRow('op-1')
    await expect(buildBatchIdempotencyKey([row])).resolves.toBeDefined()
    const emptyRow = { ...makeRow(''), operationId: '' }
    await expect(buildBatchIdempotencyKey([emptyRow])).rejects.toThrow('operationId')
  })

  it('returns sync- prefixed key of length 69', async () => {
    const key = await buildBatchIdempotencyKey([makeRow('op-1')])
    expect(key).toMatch(/^sync-[0-9a-f]{64}$/)
    expect(key).toHaveLength(69)
  })

  it('accepts the minimal persisted operation-id row shape', async () => {
    const key = await buildBatchIdempotencyKey([
      { operationId: 'op-a' },
      { operationId: 'op-b' },
    ])
    expect(key).toMatch(/^sync-[0-9a-f]{64}$/)
  })

  it('produces same key for same operationIds in same order', async () => {
    const rows1 = [makeRow('op-1', 1), makeRow('op-2', 2)]
    const rows2 = [makeRow('op-1', 1), makeRow('op-2', 2)]
    expect(await buildBatchIdempotencyKey(rows1)).toBe(await buildBatchIdempotencyKey(rows2))
  })

  it('produces different key for different order', async () => {
    const key1 = await buildBatchIdempotencyKey([makeRow('op-1', 1), makeRow('op-2', 2)])
    const key2 = await buildBatchIdempotencyKey([makeRow('op-2', 2), makeRow('op-1', 1)])
    expect(key1).not.toBe(key2)
  })
})
