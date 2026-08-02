/**
 * S3-Task10: 幂等键生成与批量幂等键推导。
 *
 * 契约 1: ensureMutationIdempotencyKey — 对 POST/PUT/PATCH/DELETE 注入 Idempotency-Key。
 *         使用 AxiosHeaders.has()/set() 大小写无关 API，保留调用方任意大小写的原值。
 * 契约 2: buildBatchIdempotencyKey — 按 operationId 顺序 SHA-256，返回 sync-${hex}。
 *         仅使用 Web Crypto API (crypto.subtle)，不添加 node:crypto 回退。
 */

import type { InternalAxiosRequestConfig } from 'axios'
import type { OutboxEvent } from '@/types'

const MUTATION_METHODS = new Set(['post', 'put', 'patch', 'delete'])

export function ensureMutationIdempotencyKey(
  config: InternalAxiosRequestConfig,
): InternalAxiosRequestConfig {
  const method = (config.method ?? 'get').toLowerCase()
  if (MUTATION_METHODS.has(method) && config.headers) {
    if (!config.headers.has('Idempotency-Key')) {
      config.headers.set('Idempotency-Key', crypto.randomUUID())
    }
  }
  return config
}

export async function buildBatchIdempotencyKey(
  rows: readonly OutboxEvent[],
): Promise<string> {
  if (rows.length === 0) {
    throw new Error('Cannot build idempotency key for empty batch')
  }
  const operationIds = rows.map((r) => r.operationId)
  if (operationIds.some((id) => !id)) {
    throw new Error('All outbox rows must have a non-null operationId')
  }
  const joined = operationIds.join('\n')
  const hex = await sha256Hex(joined)
  return `sync-${hex}`
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('')
}
