/**
 * S3-Task10: 幂等键生成与批量幂等键推导。
 *
 * 契约 1: ensureMutationIdempotencyKey — 对 POST/PUT/PATCH/DELETE 注入 Idempotency-Key。
 * 契约 2: buildBatchIdempotencyKey — 按 operationId 顺序 SHA-256，返回 sync-${hex}。
 */

import type { InternalAxiosRequestConfig } from 'axios'
import type { OutboxEvent } from '@/types'

const MUTATION_METHODS = new Set(['post', 'put', 'patch', 'delete'])

/**
 * 确保变更请求携带 Idempotency-Key 头。
 *
 * 对 POST/PUT/PATCH/DELETE 请求，若未预设 Idempotency-Key 则生成 crypto.randomUUID()。
 * GET/HEAD 不受影响。已存在的 Idempotency-Key 永不被覆盖。
 *
 * 必须在 Authorization 注入后调用，保证 401/CF 重试复用原 config/header。
 */
export function ensureMutationIdempotencyKey(
  config: InternalAxiosRequestConfig,
): InternalAxiosRequestConfig {
  const method = (config.method ?? 'get').toLowerCase()
  if (MUTATION_METHODS.has(method) && config.headers) {
    if (!config.headers['Idempotency-Key']) {
      config.headers['Idempotency-Key'] = crypto.randomUUID()
    }
  }
  return config
}

/**
 * 为一批 outbox 事件构建确定性批量幂等键。
 *
 * - 拒绝空 batch 或任何缺失 operationId 的 row
 * - 按传入顺序以 \n 拼接 operationId，SHA-256 hex
 * - 返回 `sync-${hex}`（5 + 64 = 69 字符）
 * - 相同已持久化 operation IDs 产生相同 key
 */
export async function buildBatchIdempotencyKey(
  rows: OutboxEvent[],
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

/**
 * SHA-256 hex 摘要。优先使用 Web Crypto API，回退 Node.js crypto 模块。
 */
async function sha256Hex(input: string): Promise<string> {
  // Prefer Web Crypto API (browsers + Node.js 20+ globalThis.crypto)
  if (globalThis.crypto?.subtle) {
    const data = new TextEncoder().encode(input)
    const hashBuffer = await globalThis.crypto.subtle.digest('SHA-256', data)
    const hashArray = Array.from(new Uint8Array(hashBuffer))
    return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('')
  }
  // Fallback: Node.js crypto module
  const { createHash } = await import('node:crypto')
  return createHash('sha256').update(input).digest('hex')
}
