import { canonicalize } from 'json-canonicalize'
import type { Table } from 'dexie'
import { hashCommandPayload, type JsonValue } from '@/lib/contracts/payload-hash'
import type { DirectCommandIntentRow } from '@/types'
import type { PomodoroXIDB } from '@/services/database'

/** One canonical caller-intent timestamp is used for every newly-created row. */
export const canonicalNow = (): string => new Date().toISOString()

export type DirectCommandKind = DirectCommandIntentRow['kind']

export type DirectCommandHandlerMap = Record<DirectCommandKind, {
  executeExact(intent: DirectCommandIntentRow): Promise<void>
}>

export interface DirectCommandResumeResult {
  failed: Array<{ operationId: string; code: string }>
}

type PrepareInput = Omit<
  DirectCommandIntentRow,
  'operationId' | 'requestJson' | 'requestHash' | 'state' | 'resultJson' |
  'resultHash' | 'failureCode' | 'createdAt' | 'updatedAt'
> & {
  request: Record<string, JsonValue>
  now: string
}

/**
 * Persist one immutable direct-command envelope before transport.
 * Reusing an operation ID is allowed only when every identity field and the
 * canonical request are byte-for-byte identical.
 */
export async function prepareDirectCommandIntent(
  db: PomodoroXIDB,
  input: PrepareInput,
  requestedOperationId = crypto.randomUUID(),
): Promise<DirectCommandIntentRow> {
  const exactRequest: Record<string, JsonValue> = {
    ...input.request,
    operationId: requestedOperationId,
  }
  const requestJson = canonicalize(exactRequest)
  if (requestJson === undefined) throw new Error('direct_command_request_not_canonical')
  const requestHash = await hashCommandPayload(exactRequest)
  const row: DirectCommandIntentRow = {
    operationId: requestedOperationId,
    kind: input.kind,
    spaceId: input.spaceId,
    targetId: input.targetId,
    requestJson,
    requestHash,
    state: 'prepared',
    resultJson: null,
    resultHash: null,
    failureCode: null,
    createdAt: input.now,
    updatedAt: input.now,
  }

  return db.transaction('rw', db.directCommandIntents, async () => {
    const existing = await db.directCommandIntents.get(row.operationId)
    if (existing) {
      if (
        existing.requestJson !== row.requestJson ||
        existing.requestHash !== row.requestHash ||
        existing.kind !== row.kind ||
        existing.spaceId !== row.spaceId ||
        existing.targetId !== row.targetId
      ) {
        throw new Error('direct_command_operation_payload_mismatch')
      }
      return existing as unknown as DirectCommandIntentRow
    }
    await db.directCommandIntents.add(row as unknown as Record<string, unknown>)
    return row
  })
}

interface DurableDirectCommandInput<TResult> {
  db: PomodoroXIDB
  intent: DirectCommandIntentRow
  businessTables: Table[]
  parseResult(value: unknown): TResult
  sendExactRequest(value: Record<string, JsonValue>): Promise<unknown>
  applyResult(result: TResult): Promise<void>
  now(): string
}

/**
 * Send an immutable intent and atomically install its business post-image and
 * terminal result. A transport response loss leaves the intent in_flight so a
 * restart can retry the exact request without inventing a new operation ID.
 */
export async function executeDurableDirectCommand<TResult>(
  input: DurableDirectCommandInput<TResult>,
): Promise<TResult> {
  const exactRequest = JSON.parse(input.intent.requestJson) as Record<string, JsonValue>
  const started = await input.db.transaction(
    'rw', input.db.directCommandIntents,
    async (): Promise<{ terminal: TResult; hasTerminal: boolean }> => {
      const current = await input.db.directCommandIntents.get(input.intent.operationId)
      if (
        !current ||
        current.requestJson !== input.intent.requestJson ||
        current.requestHash !== input.intent.requestHash ||
        current.kind !== input.intent.kind ||
        current.spaceId !== input.intent.spaceId
      ) {
        throw new Error('direct_command_intent_lost')
      }
      const typed = current as unknown as DirectCommandIntentRow
      if (typed.state === 'terminal') {
        if (!typed.resultJson || !typed.resultHash) {
          throw new Error('direct_command_terminal_result_missing')
        }
        return { terminal: input.parseResult(JSON.parse(typed.resultJson)), hasTerminal: true }
      }
      if (typed.state === 'failed') throw new Error('direct_command_intent_failed')
      await input.db.directCommandIntents.update(input.intent.operationId, {
        state: 'in_flight', updatedAt: input.now(),
      })
      return { terminal: undefined as TResult, hasTerminal: false }
    },
  )
  if (started.hasTerminal) return started.terminal

  const result = input.parseResult(await input.sendExactRequest(exactRequest))
  const resultJson = canonicalize(result)
  if (resultJson === undefined) throw new Error('direct_command_result_not_canonical')
  const resultHash = await hashCommandPayload(result)

  const transaction = input.db.transaction.bind(input.db) as unknown as (...args: unknown[]) => Promise<unknown>
  await transaction(
    'rw', input.db.directCommandIntents, ...input.businessTables,
    async () => {
      const current = await input.db.directCommandIntents.get(input.intent.operationId)
      if (
        !current ||
        current.requestJson !== input.intent.requestJson ||
        current.requestHash !== input.intent.requestHash ||
        current.kind !== input.intent.kind ||
        current.state === 'terminal'
      ) {
        throw new Error('direct_command_intent_lost')
      }
      await input.applyResult(result)
      await input.db.directCommandIntents.update(input.intent.operationId, {
        state: 'terminal', resultJson, resultHash, failureCode: null, updatedAt: input.now(),
      })
    },
  )
  return result
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function responseField(value: unknown, field: string): unknown {
  if (!isRecord(value)) return undefined
  const direct = value[field]
  if (direct !== undefined) return direct
  const detail = value.detail
  return isRecord(detail) ? detail[field] : undefined
}

function nonRetryableFailureCode(error: unknown): string | null {
  const response = isRecord(error) ? error.response : undefined
  const data = isRecord(response) ? response.data : undefined
  const code = responseField(data, 'code')
  const retryable = responseField(data, 'retryable')
  return typeof code === 'string' && code.length > 0 && retryable === false ? code : null
}

async function markIntentFailed(
  db: PomodoroXIDB,
  intent: DirectCommandIntentRow,
  failureCode: string,
): Promise<void> {
  await db.transaction('rw', db.directCommandIntents, async () => {
    const current = await db.directCommandIntents.get(intent.operationId)
    if (
      !current ||
      current.requestJson !== intent.requestJson ||
      current.requestHash !== intent.requestHash ||
      current.kind !== intent.kind ||
      current.spaceId !== intent.spaceId ||
      current.state === 'terminal' ||
      current.state === 'failed'
    ) {
      throw new Error('direct_command_intent_lost')
    }
    await db.directCommandIntents.update(intent.operationId, {
      state: 'failed', failureCode, resultJson: null, resultHash: null, updatedAt: canonicalNow(),
    })
  })
}

/** Axios 传输码：与 task-space-store 的「无应答」判定保持同一口径。 */
const NETWORK_ERROR_CODES = new Set([
  'ERR_NETWORK',
  'ERR_INTERNET_DISCONNECTED',
  'ECONNABORTED',
  'ECONNRESET',
  'ETIMEDOUT',
])

/**
 * ★ 2026-09-11 续跑失败的三分类（**不改动**既有规范化错误判定口径：
 * ``nonRetryableFailureCode`` 仍是「带 response 且 retryable:false」才返回码）：
 *
 *  1. 规范化不可重试 → failed（原样保留）；
 *  2. 传输类失败：有 HTTP 应答但不是规范化拒绝（可重试 / 未知），或无应答的
 *     连接类错误 → **中止本轮**，intent 保持 pending，下轮用同一份请求重试；
 *  3. 程序性错误（handler 未绑定、本地内部异常等既无应答也无传输标记的错误）
 *     → 本 intent 记 failed（稳定码 ``handler_error:<kind>``），**继续**后续 intent。
 *
 * 第 3 条是本次修复的核心：此前这类错误被重新抛出，循环随之终止，其后所有
 * pending intent 永不恢复 —— 任务页刷新也修不好（每次 hydrate 都在同一条上停摆）。
 *
 * ★ 决策记录（2026-09-11，裁决 = 方案 A「一次性 + 可见」，勿擅自改成 B/C）：
 *   - 不做尝试上限（方案 B）：需要给 intent 行加 attemptCount + Dexie 版本迁移，
 *     且当前**唯一重试触发点**是任务页 hydrate（stores/task-space-store.ts）——
 *     「重试 N 次」实际分散在 N 次页面访问里，收益不成立；等「会话内自动重试」
 *     或「失败操作面板」需求出现时再评估（届时 B 的收益才成立）。
 *   - 不做定向映射（方案 C）：需要执行器返回类型化错误 `{code, retryable}`，
 *     归入「下次动 durable 命令体系时顺路做」的改造（对 outbox 侧同样受益），
 *     不单独排期。当前未知错误落进永久判死是 fail-safe 方向。
 *   - 可行性前提：绝大多数 intent 的用户输入仍留在表单草稿里，重新执行会生成
 *     新 intent（submit_review 的草稿持久化在 sessionReviewDrafts）。
 *   - 配套可见性：failed 列表由 stores/task-space-store.ts 翻译成
 *     「有 N 项操作未能提交（…）」提示（lib/task-space/intent-failure-summary）。
 *   - 翻案判据（满足任一即重新评估）：① 真实事故——某类程序性错误导致用户
 *     操作实质丢失且手动重做不可行；② 引入会话内重试触发点。
 */
type IntentFailureDisposition =
  | { kind: 'failed'; code: string }
  | { kind: 'abort' }
  | { kind: 'handler_error'; code: string }

function classifyIntentFailure(error: unknown, intentKind: string): IntentFailureDisposition {
  const normalized = nonRetryableFailureCode(error)
  if (normalized) return { kind: 'failed', code: normalized }
  // 有应答：无论可重试还是未规范化，都属于「下轮重试」，绝不判死。
  if (isRecord(error) && isRecord(error.response)) return { kind: 'abort' }
  // 无应答的连接类失败：同样是「下轮重试」，不能把 intent 标记 failed。
  if (isRecord(error) && error.isAxiosError === true) return { kind: 'abort' }
  const transportCode = isRecord(error) && typeof error.code === 'string' ? error.code : ''
  if (NETWORK_ERROR_CODES.has(transportCode)) return { kind: 'abort' }
  return { kind: 'handler_error', code: `handler_error:${intentKind}` }
}

/**
 * Resume every pending intent in creation order.
 *
 * 语义契约（见 ``classifyIntentFailure``）：
 * - 规范化不可重试拒绝 / 程序性 handler 错误 ⇒ 该 intent 记 failed 并**继续**；
 * - 传输失败或可重试拒绝 ⇒ **中止本轮**抛出，留下的 pending intent 下轮重试。
 *
 * ``markIntentFailed`` 自身抛错（intent 身份漂移 / 已终态等完整性守卫）仍然向上
 * 传播：那是数据一致性问题，不能被静默吞掉。
 */
export async function resumePendingDirectCommandIntents(
  db: PomodoroXIDB,
  handlers: DirectCommandHandlerMap,
): Promise<DirectCommandResumeResult> {
  const pending = await db.directCommandIntents
    .where('state')
    .anyOf('prepared', 'in_flight')
    .sortBy('createdAt')
  const failed: DirectCommandResumeResult['failed'] = []
  for (const row of pending) {
    const handler = handlers[row.kind as DirectCommandKind]
    const intent = row as unknown as DirectCommandIntentRow
    if (!handler) {
      // ★ 程序性错误（handler 未绑定）：按 intent 记录后继续，整批不再停摆。
      const code = `handler_error:${intent.kind}`
      await markIntentFailed(db, intent, code)
      failed.push({ operationId: intent.operationId, code })
      continue
    }
    try {
      await handler.executeExact(intent)
    } catch (error) {
      const disposition = classifyIntentFailure(error, intent.kind)
      if (disposition.kind === 'abort') throw error
      await markIntentFailed(db, intent, disposition.code)
      failed.push({ operationId: intent.operationId, code: disposition.code })
    }
  }
  return { failed }
}
