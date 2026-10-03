/**
 * 今日事实投影（反思页 · 读侧第一层）—— **纯函数，不碰 Dexie、不发 HTTP**。
 *
 * ## 解决什么问题
 * 反思页原本是一个纯文本壳：用户得凭记忆手写"今天做了什么"。而番茄钟已经
 * 落下了高精度行为遥测（`focus_sessions`），会话计划里还带着 `titleSnapshot`
 * （会话开始那一刻的任务标题）。这些事实躺在 Dexie 里没人读。
 *
 * 本模块把它们**聚合成一份当日事实快照**，供反思页渲染"今日事实抽屉"并一键
 * 注入正文 —— 把"回忆发生了什么"的提取负荷降为零（认知脚手架原则）。
 *
 * ## 为什么拆成"纯函数 + IO 包装"两层
 * - 本文件（`collect*` 纯函数）：输入若干行，输出快照。**可在 vitest 里直接喂
 *   构造数据断言边界**，不碰 fake-indexeddb。
 * - IO 在 `daily-evidence-provider.ts`：只负责按索引取行再交给纯函数。
 * 这是仓库既有范式（`lib/task-space/continue-previous.ts` 的
 * `aggregateEntries` 纯函数 + `readContinuePrevious` IO 包装）。
 *
 * ## 三条口径裁定（都是踩坑后的固化，别改）
 *
 * **① 日界必须可配，且跨零点归属按 `startedAt`。**
 * 反思页原本用无日界参数的 `toDateKey`，而番茄事实用 `toDateKeyWithBoundary`。
 * 两把尺子不一致 → 凌晨 1 点的番茄会算进"昨天"，而反思稿在"今天"。
 * 故本模块的日界由调用方传入，**默认 4 点**（夜猫子口径，见 `DEFAULT_DAY_BOUNDARY`）。
 *
 * **② 只统计已结束的投入型会话。**
 * `BREAK_SESSION_TYPES`（休息型）净专注恒为 0 且免复盘，算进来会稀释"投入"语义；
 * `endedAt === null` 是**进行中**的会话，它的时长还在长 —— 计入会让"今日投入"随时钟跳动。
 * 两者都排除，且排除口径**集中在此函数**（唯一真值源）。
 *
 * **③ 主键名陷阱：Dexie 行的主键是 `id`，而 `CachedFocusSession` 类型把它
 * rename 成了 `sessionId`**（`types/index.ts:560`）。本模块的入参类型
 * `SessionRow` 用 `id` 承载，因为那是**库里真实的列名**；IO 层负责从
 * `sessionId` 剥回 `id`（见 provider）。少剥一层 → 全盘 `undefined`。
 *
 * ## 归因：只认 effective，且缺失不炸
 * DB 级有部分唯一索引保证「每会话恰好一条 effective」（`models/session_revision.py:19-39`），
 * 但本地 provisional 行可能一条都没有。本模块对**缺失归因**采取 fail-soft：
 * 会话仍进时间轴（事实是真的：用户确实专注了），只是 `level2WorkItemId` 为 null，
 * UI 照常显示时间与时长 —— **绝不因为归因缺失而丢事实**。
 */
import { toDateKeyWithBoundary } from '@/lib/habits/habit-selectors'
import type { ThoughtType } from '@/lib/work-map/thought-types'

// --------------------------------------------------------------------------- //
// 输入行（形状与 Dexie 真实列一致；IO 层负责适配）
// --------------------------------------------------------------------------- //

/** `focusSessions` 表的行投影。主键列名是 **`id`**（见文件头注③）。 */
export interface SessionRow {
  id: string
  startedAt: string
  endedAt: string | null
  focusedSeconds: number
  pausedSeconds: number
  validity: 'pending' | 'valid' | 'invalid'
  timerCompletion: 'completed' | 'ended_early' | 'interrupted' | null
  sessionType: 'work' | 'short_break' | 'long_break' | 'free' | 'countdown'
  overallProgress: 'smooth' | 'progressed' | 'stuck' | 'interrupted' | null
}

/** `sessionAttributionRevisions` 表的行投影。 */
export interface AttributionRow {
  sessionId: string
  level2WorkItemId: string
  projectId: string
  effective: boolean
}

/** `sessionWorkItemPlans` 表的行投影（只取抽屉要用的字段）。 */
export interface PlanRow {
  sessionId: string
  workItemId: string
  titleSnapshot: string
  planRank: number
  removedAt: string | null
  currentDuringSession: boolean
}

// --------------------------------------------------------------------------- //
// 输出
// --------------------------------------------------------------------------- //

/** 时间轴上的一条会话事实。 */
export interface DailySessionFact {
  sessionId: string
  /** 本地 HH:mm（按日界偏移后的日期键归属） */
  startedLabel: string
  endedLabel: string
  focusedSeconds: number
  /** 已归因的二级工作项 id；缺失为 null（fail-soft，见文件头注） */
  level2WorkItemId: string | null
  /** 会话开始那一刻的任务标题（计划表快照，优先 currentDuringSession） */
  titleSnapshot: string | null
  validity: SessionRow['validity']
  /** 是否被中断（`timerCompletion === 'interrupted'`，或推进度自评中断） */
  interrupted: boolean
}

/** 按二级工作项聚合的投入分布。 */
export interface Level2Slice {
  level2WorkItemId: string
  titleSnapshot: string
  focusedSeconds: number
  sessionCount: number
}

/** 悬挂中的思考项（来自导图提炼，按 cid 去重后并入）。 */
export interface HangingThought {
  /** 唯一跨渲染编辑键（无 cid 的存量节点不会出现在这里，见文件头注） */
  cid: string
  title: string
  thoughtType: ThoughtType
  /** 所属会话 id —— 用于"来自哪个会话"的溯源文案 */
  sessionId: string
}

export interface DailyEvidenceSnapshot {
  dateKey: string
  /** 净专注合计（秒），只含已结束的投入型会话 */
  totalFocusedSeconds: number
  sessionCount: number
  /** 有效会话数（`validity === 'valid'`） */
  validCount: number
  /** 被中断的会话数 */
  interruptedCount: number
  /** 时间轴（按开始时刻升序） */
  sessions: DailySessionFact[]
  /** 按二级工作项聚合的投入分布（降序） */
  byLevel2: Level2Slice[]
  /** 悬挂中的思考项（todos + problems，dedupByCid） */
  hanging: HangingThought[]
  /** 当日无任何已结束投入型会话 —— UI 据此优雅收起整个抽屉 */
  isEmpty: boolean
}

// --------------------------------------------------------------------------- //
// 默认值
// --------------------------------------------------------------------------- //

/**
 * 默认日界小时：**4 点**。
 *
 * 依据是本项目自己的作息事实：凌晨 1-2 点收尾的番茄属于"那晚"的工作，
 * 归到第二天会让当日事实凭空多出一小时、次日又莫名缺失。4 点是夜猫子与
 * 常规作息之间的折中，且落在 `toDateKeyWithBoundary` 允许的 0..6 区间内。
 *
 * 调用方可覆盖；**一旦用户有了明确作息设定，改这里或传参，不要写第二把尺子**。
 */
export const DEFAULT_DAY_BOUNDARY = 4

/** 空快照（fail-soft 的统一出口，每次新建，避免调用方互相污染）。 */
export function emptyDailyEvidence(dateKey: string): DailyEvidenceSnapshot {
  return {
    dateKey,
    totalFocusedSeconds: 0,
    sessionCount: 0,
    validCount: 0,
    interruptedCount: 0,
    sessions: [],
    byLevel2: [],
    hanging: [],
    isEmpty: true,
  }
}

// --------------------------------------------------------------------------- //
// 纯函数
// --------------------------------------------------------------------------- //

const REST_TYPES: ReadonlySet<string> = new Set(['short_break', 'long_break'])

/** 该会话是否计入"今日投入"（排除口径的唯一真值源，见文件头注②）。 */
export function countsAsInvestment(row: SessionRow): boolean {
  if (REST_TYPES.has(row.sessionType)) return false
  return row.endedAt !== null
}

/** UTC ISO 串 → 本地 HH:mm。 */
function timeLabel(iso: string, dayBoundaryHour: number): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '--:--'
  // 与归属日同口径地平移，保证"跨零点的那条会话"显示成夜里而不是凌晨
  const shifted = new Date(date.getTime() - dayBoundaryHour * 3600 * 1000)
  const h = String(shifted.getHours()).padStart(2, '0')
  const m = String(shifted.getMinutes()).padStart(2, '0')
  return `${h}:${m}`
}

/** 会话是否属于该日期键（按 `startedAt` 归属 —— 见文件头注①）。 */
function isOnDateKey(row: SessionRow, dateKey: string, dayBoundaryHour: number): boolean {
  const started = new Date(row.startedAt)
  if (Number.isNaN(started.getTime())) return false
  return toDateKeyWithBoundary(started, dayBoundaryHour) === dateKey
}

/**
 * 从已加载的行聚合当日事实快照。
 *
 * @param dateKey 目标日期（YYYY-MM-DD）
 * @param rows 全部会话行（IO 层可先按 `startedAt` 索引收窄，也可全给；本函数会**再次**
 *             按日界过滤，故收窄只是性能优化、不是正确性依赖）
 * @param attributions 归因行（可空）
 * @param plans 计划行（可空）
 * @param hanging 导图提炼出的悬挂项（可空）
 * @param dayBoundaryHour 日界小时，默认 {@link DEFAULT_DAY_BOUNDARY}
 */
export function collectDailyEvidence(
  dateKey: string,
  rows: readonly SessionRow[],
  attributions: readonly AttributionRow[] = [],
  plans: readonly PlanRow[] = [],
  hanging: readonly HangingThought[] = [],
  dayBoundaryHour: number = DEFAULT_DAY_BOUNDARY,
): DailyEvidenceSnapshot {
  // 注意：悬挂项在**任何早退分支都要透传** —— 「当天没跑番茄但导图里有遗留思考」
  // 是真实场景（复盘历史某天、或当天只读图没开工），不能因为会话数组为空就丢掉。
  if (rows.length === 0) return { ...emptyDailyEvidence(dateKey), hanging: dedupHanging(hanging) }

  // 归因：只认 effective；同一会话出现多条 effective 时取 revision 最小者（稳定）
  const effectiveBySession = new Map<string, AttributionRow>()
  for (const row of attributions) {
    if (!row.effective) continue
    const current = effectiveBySession.get(row.sessionId)
    if (current === undefined) {
      effectiveBySession.set(row.sessionId, row)
      continue
    }
    // 竞态容忍：DB 层面不可能出现，但本地 provisional 行可能；取先到的稳定项
  }

  // 计划：currentDuringSession 优先，其次 planRank 最小
  const planBySession = new Map<string, PlanRow>()
  for (const plan of plans) {
    if (plan.removedAt !== null) continue
    const current = planBySession.get(plan.sessionId)
    if (current === undefined) {
      planBySession.set(plan.sessionId, plan)
      continue
    }
    const better =
      plan.currentDuringSession !== current.currentDuringSession
        ? plan.currentDuringSession
        : plan.planRank < current.planRank
    if (better) planBySession.set(plan.sessionId, plan)
  }

  const facts: DailySessionFact[] = []
  for (const row of rows) {
    if (!countsAsInvestment(row)) continue
    if (!isOnDateKey(row, dateKey, dayBoundaryHour)) continue

    const attribution = effectiveBySession.get(row.id)
    const plan = planBySession.get(row.id)
    facts.push({
      sessionId: row.id,
      startedLabel: timeLabel(row.startedAt, dayBoundaryHour),
      endedLabel: row.endedAt === null ? '--:--' : timeLabel(row.endedAt, dayBoundaryHour),
      focusedSeconds: Math.max(0, row.focusedSeconds),
      level2WorkItemId: attribution?.level2WorkItemId ?? null,
      titleSnapshot: plan?.titleSnapshot ?? null,
      validity: row.validity,
      interrupted: row.timerCompletion === 'interrupted' || row.overallProgress === 'interrupted',
    })
  }

  if (facts.length === 0) {
    return { ...emptyDailyEvidence(dateKey), hanging: dedupHanging(hanging) }
  }

  facts.sort((left, right) => left.startedLabel.localeCompare(right.startedLabel))

  // 二级工作项聚合：优先用计划的标题快照，缺失时退化为「未归因任务」
  const sliceMap = new Map<string, Level2Slice>()
  for (const fact of facts) {
    const key = fact.level2WorkItemId ?? '__unattributed__'
    const existing = sliceMap.get(key)
    if (existing === undefined) {
      sliceMap.set(key, {
        level2WorkItemId: key,
        titleSnapshot: fact.titleSnapshot ?? '未归因任务',
        focusedSeconds: fact.focusedSeconds,
        sessionCount: 1,
      })
      continue
    }
    existing.focusedSeconds += fact.focusedSeconds
    existing.sessionCount += 1
    // 标题取先出现的那条（非空优先），避免被「未归因任务」覆盖
    if (existing.titleSnapshot === '未归因任务' && fact.titleSnapshot !== null) {
      existing.titleSnapshot = fact.titleSnapshot
    }
  }

  return {
    dateKey,
    totalFocusedSeconds: facts.reduce((sum, fact) => sum + fact.focusedSeconds, 0),
    sessionCount: facts.length,
    validCount: facts.filter((fact) => fact.validity === 'valid').length,
    interruptedCount: facts.filter((fact) => fact.interrupted).length,
    sessions: facts,
    byLevel2: [...sliceMap.values()].sort((left, right) => right.focusedSeconds - left.focusedSeconds),
    hanging: dedupHanging(hanging),
    isEmpty: false,
  }
}

/**
 * 悬挂项按 `cid` 去重。
 *
 * 为什么 cid 是唯一键：kernel 的 `EditableNode.id` 每次解析都重分配
 * （`EditableNode.id 不进入序列化`），跨渲染只能认笔记块里的 `cid`
 * （ADR-0008 D16-a）。同一节点若被多个会话的提炼结果命中，**按 cid 合并**，
 * 并保留先出现的那条溯源信息。
 */
function dedupHanging(hanging: readonly HangingThought[]): HangingThought[] {
  const seen = new Set<string>()
  const out: HangingThought[] = []
  for (const item of hanging) {
    if (item.cid === '' || seen.has(item.cid)) continue
    seen.add(item.cid)
    out.push(item)
  }
  return out
}

// --------------------------------------------------------------------------- //
// 注入正文的 markdown 生成
// --------------------------------------------------------------------------- //

/** 秒 → 「2h 40m」/「45m」/「0m」（反思语境下要一眼可读，不要 9700 秒）。 */
export function formatDuration(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds))
  const h = Math.floor(safe / 3600)
  const m = Math.floor((safe % 3600) / 60)
  if (h === 0) return `${m}m`
  return m === 0 ? `${h}h` : `${h}h ${m}m`
}

/**
 * 生成「今日提炼」markdown 块（可直接落进反思正文）。
 *
 * ## 为什么是**追加**而不是替换
 * 反思正文是用户的写作区，注入只能**加一段事实**，绝不能覆写已有文字
 * （否则用户先写后注入就会被抹掉）。UI 侧再用"光标/末尾追加"接上。
 *
 * ## 无事实时返回**空串**
 * 调用方据此优雅收起入口，不产生空白占位（与
 * `harvest-thoughts.ts` 的 `formatHarvestedNoteMarkdown` 同一纪律）。
 */
export function formatDailyEvidenceMarkdown(snapshot: DailyEvidenceSnapshot): string {
  if (snapshot.isEmpty) return ''

  const lines: string[] = []
  lines.push('## 今日事实（系统预填）')
  lines.push('')
  lines.push(
    `${formatDuration(snapshot.totalFocusedSeconds)} 净专注 · ` +
      `${snapshot.sessionCount} 个会话 · 有效 ${snapshot.validCount}` +
      (snapshot.interruptedCount > 0 ? ` · 中断 ${snapshot.interruptedCount}` : ''),
  )

  if (snapshot.byLevel2.length > 0) {
    lines.push('')
    for (const slice of snapshot.byLevel2) {
      lines.push(
        `- ${slice.titleSnapshot} —— ${formatDuration(slice.focusedSeconds)}` +
          `（${slice.sessionCount} 个会话）`,
      )
    }
  }

  if (snapshot.hanging.length > 0) {
    lines.push('')
    lines.push('**悬挂中的思考**')
    for (const item of snapshot.hanging) {
      const icon = item.thoughtType === 'problem' ? '⚠️' : '⏳'
      lines.push(`- ${icon} ${item.title}`)
    }
  }

  return lines.join('\n')
}
