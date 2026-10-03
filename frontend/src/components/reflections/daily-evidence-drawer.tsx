'use client'

/**
 * 今日事实抽屉（反思页 · Phase 1）—— 反思页的**证据侧栏**。
 *
 * ## 职责边界（重要，与 `session-review.tsx` 同一纪律）
 * 本组件只负责**展示 + 收集用户意图**，不碰数据层：
 * - 快照由页面注入（`snapshot`），页面自己决定何时读、怎么读
 * - 「注入正文」由页面注入 `onInject`，组件内**不碰 store / 不碰 repository**
 * 这样组件能在 jsdom 里用两个 spy 穷举交互，数据接线由页面自己的测试钉住。
 *
 * ## 三条产品纪律（写进 UI，不只是注释）
 * 1. **无事实就整体消失** —— `isEmpty` 时返回 `null`，不产生空白占位
 *    （与 `session-review-harvest.tsx:71` 同一纪律）。
 * 2. **不评分、不打人格分** —— 只给"事实账本"（时长/会话数/有效率/中断），
 *    绝不出现"今日专注 59 分"这类有辱自尊的设计。
 * 3. **不评判地呈现未完成** —— 悬挂项标题旁只标"来自哪个会话"，
 *    不用红色警告、不加"你拖延了"字样。
 *
 * ## 时长与日期标签一律复用 lib 侧函数
 * `formatDuration` / 时间轴标签都由 `daily-evidence.ts` 算好传入，
 * 组件内**不重算时长**——避免两把尺子（与项目"日界单一事实源"同源纪律）。
 */
import {
  formatDuration,
  type DailyEvidenceSnapshot,
  type DailySessionFact,
} from '@/lib/reflections/daily-evidence'
import type { DailyMapProjection } from '@/lib/reflections/daily-map'
import { filterHanging, isHangingType } from '@/lib/reflections/daily-map'
import { TimerMapOverview } from '@/components/timer/timer-map-overview'

export interface DailyEvidenceDrawerProps {
  snapshot: DailyEvidenceSnapshot
  /**
   * 今日导图投影（Phase 2）。
   *
   * **由页面注入**而非组件自取 —— 导图走 HTTP，组件自取会让它同时持有
   * 数据与渲染两件事，且测试必须 stub 全局单例。故与 snapshot 一样是纯 props。
   */
  map?: DailyMapProjection | null
  /** 一键把今日提炼注入正文（页面负责追加语义与草稿基线） */
  onInject?: () => void
  /** 注入进行中（按钮禁用） */
  injecting?: boolean
  /** 读事实中（首屏骨架） */
  loading?: boolean
}

function validityLabel(fact: DailySessionFact): string {
  if (fact.interrupted) return '中断'
  if (fact.validity === 'valid') return '有效'
  if (fact.validity === 'invalid') return '已废弃'
  return '待定'
}

function validityTone(fact: DailySessionFact): string {
  if (fact.interrupted) return 'text-[var(--warn,#8a5a00)]'
  if (fact.validity === 'valid') return 'text-[var(--ok,#2f6f4f)]'
  return 'text-muted-foreground'
}

export function DailyEvidenceDrawer({
  snapshot,
  map = null,
  onInject,
  injecting = false,
  loading = false,
}: DailyEvidenceDrawerProps) {
  // 悬挂项：已升格的不再悬挂（避免"已是正式任务"的东西二次骚扰）
  const hanging = map === null ? snapshot.hanging : filterHanging(map.hanging)

  // 纪律①：**loading 期间**收起身影，避免闪烁一个空壳。
  if (loading) return null

  // 「当天没有番茄事实」也必须**看得见**（2026-10-03 修正）：
  // 原实现 `isEmpty → return null`，与「这个功能根本不存在」在界面上完全同形 ——
  // 用户看到的就是「改了没生效」，而真相是「今天确实没记录」。
  // 改为**始终渲染外壳**，把 isEmpty 呈现为一条中性说明；
  // 仍然不做的：不摆空图表格、不放无动作的按钮。
  const canInject = !snapshot.isEmpty && Boolean(onInject) && !injecting

  return (
    <aside
      className="flex w-[336px] shrink-0 flex-col border-l bg-[#fcfcfb]"
      aria-label="今日事实"
      data-testid="daily-evidence-drawer"
    >
      <header className="border-b px-3 py-2">
        <p className="text-[11.5px] text-muted-foreground">今日事实</p>
        <p className="mt-0.5 text-[13.5px] font-medium">{snapshot.dateKey}</p>
      </header>

      {snapshot.isEmpty ? (
        <div
          className="flex flex-1 items-center px-5 py-8 text-center"
          data-testid="daily-evidence-empty"
        >
          <p className="text-[12px] leading-relaxed text-muted-foreground">
            这一天没有番茄钟记录。
            <br />
            跑一个番茄后回来，这里会出现当天的时长、会话与思考。
          </p>
        </div>
      ) : (
        <>

      {/* 纪律②：事实账本，不评分 */}
      <div className="grid grid-cols-3 gap-2 px-3 py-3">
        <div className="rounded-lg border bg-card px-2 py-1.5">
          <p className="text-[17px] tabular-nums leading-tight">
            {formatDuration(snapshot.totalFocusedSeconds)}
          </p>
          <p className="mt-0.5 text-[10.5px] text-muted-foreground">净专注</p>
        </div>
        <div className="rounded-lg border bg-card px-2 py-1.5">
          <p className="text-[17px] tabular-nums leading-tight">{snapshot.sessionCount}</p>
          <p className="mt-0.5 text-[10.5px] text-muted-foreground">会话数</p>
        </div>
        <div className="rounded-lg border bg-card px-2 py-1.5">
          <p className="text-[17px] tabular-nums leading-tight">{snapshot.interruptedCount}</p>
          <p className="mt-0.5 text-[10.5px] text-muted-foreground">中断</p>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <section className="border-t px-3 py-2.5">
          <p className="mb-2 text-[11px] text-muted-foreground">会话时间轴</p>
          <ol className="relative space-y-2 border-l pl-3">
            {snapshot.sessions.map((fact) => (
              <li key={fact.sessionId} className="relative">
                <span
                  className="absolute -left-[15px] top-1.5 size-1.5 rounded-full border-2 border-[#fcfcfb] bg-muted-foreground/60"
                  aria-hidden="true"
                />
                <p className="text-[11px] tabular-nums text-muted-foreground">
                  {fact.startedLabel} – {fact.endedLabel}
                </p>
                <p className="text-[12.5px] leading-snug">
                  {fact.titleSnapshot ?? '未记录任务标题'}
                </p>
                <p className="mt-0.5 text-[10.5px] text-muted-foreground">
                  {formatDuration(fact.focusedSeconds)} ·{' '}
                  <span className={validityTone(fact)}>{validityLabel(fact)}</span>
                </p>
              </li>
            ))}
          </ol>
        </section>

        {snapshot.byLevel2.length > 0 ? (
          <section className="border-t px-3 py-2.5">
            <p className="mb-2 text-[11px] text-muted-foreground">投入分布</p>
            <ul className="space-y-1">
              {snapshot.byLevel2.map((slice) => (
                <li key={slice.level2WorkItemId} className="flex items-baseline gap-2 text-[12px]">
                  <span className="min-w-0 flex-1 truncate">{slice.titleSnapshot}</span>
                  <span className="shrink-0 tabular-nums text-[11px] text-muted-foreground">
                    {formatDuration(slice.focusedSeconds)}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {hanging.length > 0 ? (
          <section className="border-t px-3 py-2.5" data-testid="daily-hanging">
            <p className="mb-2 text-[11px] text-muted-foreground">
              悬挂中的思考 · {hanging.length}
            </p>
            <ul className="space-y-1.5">
              {hanging.map((item) => (
                <li key={item.cid} className="text-[12px] leading-snug">
                  <span aria-hidden="true" className="mr-1 text-muted-foreground">
                    {isHangingType(item.thoughtType) && item.thoughtType === 'problem' ? '⚠' : '○'}
                  </span>
                  {item.title}
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {/*
          今日岛总览：直接复用 TimerMapOverview（类型图例 / 近 N 岛 / 双击聚焦
          / dim 不 hide 全部免费获得）。**零新增渲染代码** —— 另写一份树就是
          ADR-0008 D18 红线 4 明令禁止的"复制同功能渲染代码"。
        */}
        {map?.primary != null ? (
          <section className="border-t px-3 py-2.5" data-testid="daily-map-section">
            <p className="mb-2 flex items-baseline justify-between text-[11px] text-muted-foreground">
              <span>今日岛总览</span>
              {map.level2Count > 1 ? (
                // 单 L2 口径的诚实说明：确实只呈现了一张图
                <span title="首期按单个二级工作项呈现">仅呈现 1 / {map.level2Count} 个工作项</span>
              ) : null}
            </p>
            <div className="overflow-hidden rounded-lg border bg-card">
              <TimerMapOverview
                mapText={map.primary.mapText}
                sessionId={null}
                sessionIds={map.primary.sessionIds}
                title={`${map.primary.title} · 今日`}
              />
            </div>
          </section>
        ) : null}
      </div>
        </>
      )}

      {/* 注入按钮只在真有事实时出现（isEmpty 时无内容可注入，摆个禁用按钮是噪音） */}
      {snapshot.isEmpty ? null : (
      <footer className="border-t bg-card p-3">
        <button
          type="button"
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2 text-[12.5px] text-primary-foreground disabled:opacity-40"
          disabled={!canInject}
          onClick={() => onInject?.()}
          data-testid="daily-evidence-inject"
        >
          {injecting ? '注入中…' : '一键引入今日提炼'}
        </button>
        <p className="mt-1.5 text-[10.5px] leading-relaxed text-muted-foreground">
          注入是<b>追加</b>到正文末尾，不会覆盖你已写的内容。
        </p>
      </footer>
      )}
    </aside>
  )
}
