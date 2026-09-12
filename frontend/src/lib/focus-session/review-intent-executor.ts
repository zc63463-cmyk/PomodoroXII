import { canonicalize } from 'json-canonicalize'
import {
  focusSessionAggregateSchema,
  sessionReviewDraftSchema,
  type FocusSessionAggregateView,
} from '@/lib/contracts/focus-session'
import type { JsonValue } from '@/lib/contracts/payload-hash'
import {
  canonicalNow,
  executeDurableDirectCommand,
  prepareDirectCommandIntent,
} from '@/lib/direct-command-intents'
import { requirePersistedExactSessionReviewDraft, type SessionReviewDraft } from './session-review-draft-registry'
import { focusSessionApi } from '@/services/focus-session-api'
import type { PomodoroXIDB } from '@/services/database'
import type { DirectCommandIntentRow } from '@/types'

/**
 * ★ 2026-09-11 submit_review intent 的共享执行器（会话侧 / 任务侧单一来源）。
 *
 * 背景：tasks 侧曾在自己的 resume handler map 里维护一份**抛错桩**
 * （submit_review_handler_not_bound），而会话侧另有一份内联实现 —— 两份实现
 * 让「提交复核」在任务页 hydrate 时必然失败，并冻结整批续跑。
 *
 * 这里把「准备 intent + 发请求 + 解析权威聚合 + 原子应用结果」收敛成唯一实现；
 * 两侧都只能调用本模块，执行仍然走既有基础设施（prepareDirectCommandIntent /
 * executeDurableDirectCommand），幂等与 durable 语义（in_flight 重试、终态回执、
 * 结果与业务后像同事务）完全不变。
 *
 * ★ 为什么权威结果的应用通过端口注入：``applyAuthoritativeReviewAndClearDraft``
 *   与 ``toReviewRows`` 位于 focus-session-repository（它们依赖该模块内多处私有
 *   助手）。若本模块直接 import 它们，就会形成 executor ↔ repository 的模块环；
 *   因此本模块只声明端口，由调用方把唯一实现按引用传入 —— 实现仍然只有一份。
 */

/** review intent 的 expectedVersion 语义（由持久化草稿与绑定请求比对得出）。 */
export type ReviewExpectedVersionMode = 'exact' | 'import_rebased'

/** 权威 review 结果的原子应用端口（实现见 focus-session-repository）。 */
export type ApplyAuthoritativeReview = (
  db: PomodoroXIDB,
  spaceId: string,
  sessionId: string,
  boundRequestJson: string,
  expectedVersionMode: ReviewExpectedVersionMode,
  response: FocusSessionAggregateView,
) => Promise<void>

/** 不可变 intent 请求 → 已校验的 review 草稿（canonical JSON 必须逐字一致）。 */
export function parseBoundReviewIntentRequest(requestJson: string): SessionReviewDraft {
  let request: SessionReviewDraft
  try {
    request = sessionReviewDraftSchema.parse(JSON.parse(requestJson))
  } catch {
    throw new Error('review_intent_request_invalid')
  }
  if (canonicalize(request) !== requestJson) throw new Error('review_intent_request_not_canonical')
  return request
}

/**
 * 准备（或复用）submit_review intent。会话侧两处创建入口共用，保证 intent 形状、
 * target 与 request 的绑定方式只有一份定义。
 */
export async function prepareSubmitReviewIntent(
  db: PomodoroXIDB,
  draft: SessionReviewDraft,
  operationId = draft.operationId,
): Promise<DirectCommandIntentRow> {
  const parsed = sessionReviewDraftSchema.parse(draft)
  if (db.spaceId !== parsed.spaceId) throw new Error('review_draft_space_mismatch')
  return prepareDirectCommandIntent(db, {
    kind: 'submit_review',
    spaceId: parsed.spaceId,
    targetId: parsed.sessionId,
    request: parsed as unknown as Record<string, JsonValue>,
    now: canonicalNow(),
  }, operationId)
}

/**
 * 判定绑定请求与持久化草稿的关系，并在**发送之前** fail-closed。
 *
 * - expectedVersion 相同 ⇒ ``exact``：复用既有的逐字绑定守卫；
 * - 不同 ⇒ ``import_rebased``：只可能来自导入重定基路径，业务字段必须逐一相同，
 *   且绑定版本必须为正（与 apply 侧的同模式校验一致）。
 *
 * 由此任务侧的续跑不需要知道 intent 是「在线提交」还是「导入重定基」——判定由
 * 不可变请求与持久化草稿自己说明。
 */
async function resolveReviewIntentMode(
  db: PomodoroXIDB,
  bound: SessionReviewDraft,
): Promise<ReviewExpectedVersionMode> {
  const row = await db.sessionReviewDrafts.get([bound.spaceId, bound.sessionId]) as
    Record<string, unknown> | undefined
  if (!row || row.operationId !== bound.operationId || typeof row.draftJson !== 'string') {
    throw new Error('review_draft_not_durably_bound')
  }
  let persisted: SessionReviewDraft
  try {
    persisted = sessionReviewDraftSchema.parse(JSON.parse(row.draftJson))
  } catch {
    throw new Error('review_draft_not_durably_bound')
  }
  if (canonicalize(persisted) !== row.draftJson) throw new Error('review_draft_not_durably_bound')
  if (persisted.spaceId !== bound.spaceId || persisted.sessionId !== bound.sessionId ||
      persisted.operationId !== bound.operationId) {
    throw new Error('review_draft_not_durably_bound')
  }
  if (persisted.expectedVersion === bound.expectedVersion) {
    await requirePersistedExactSessionReviewDraft(db, bound)
    return 'exact'
  }
  const { expectedVersion: _persistedVersion, ...persistedBusiness } = persisted
  const { expectedVersion: _boundVersion, ...boundBusiness } = bound
  if (canonicalize(persistedBusiness) !== canonicalize(boundBusiness) || bound.expectedVersion <= 0) {
    throw new Error('review_intent_draft_mismatch')
  }
  return 'import_rebased'
}

/**
 * 执行（或复用终态）一个已持久化的 submit_review intent。
 *
 * 会话侧在线提交、会话侧导入重定基、任务侧 hydrate 续跑三条入口都走这里。终态
 * intent 直接回放已存结果（不重发）；in_flight intent 用同一份 canonical 请求重试。
 */
export async function executeSubmitReviewIntent(input: {
  db: PomodoroXIDB
  intent: DirectCommandIntentRow
  applyAuthoritativeReview: ApplyAuthoritativeReview
}): Promise<FocusSessionAggregateView> {
  const { db, intent, applyAuthoritativeReview } = input
  if (intent.kind !== 'submit_review') throw new Error('review_intent_kind_mismatch')
  const draft = parseBoundReviewIntentRequest(intent.requestJson)
  if (draft.spaceId !== intent.spaceId || draft.sessionId !== intent.targetId) {
    throw new Error('review_intent_identity_mismatch')
  }
  const mode = await resolveReviewIntentMode(db, draft)

  return executeDurableDirectCommand({
    db,
    intent,
    businessTables: [
      db.focusSessions, db.sessionWorkItemOutcomes,
      db.sessionCommandEnvelopes, db.sessionCommandReceipts,
      db.sessionCommandQueue, db.sessionReviewDrafts,
    ],
    sendExactRequest: (request) => focusSessionApi.submitReview(
      sessionReviewDraftSchema.parse(request),
    ),
    parseResult: (value) => focusSessionAggregateSchema.parse(value),
    applyResult: (response) => applyAuthoritativeReview(
      db, draft.spaceId, draft.sessionId, intent.requestJson, mode, response,
    ),
    now: canonicalNow,
  })
}
