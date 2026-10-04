'use client'

/**
 * 「继续上次」三栏快捷入口（准备态）—— 设计稿 `设计稿-番茄钟页面UI优化.html` 复刻。
 *
 * ## 结构（与设计稿逐条对应）
 * ```
 * .ios-groups                        设计稿 .groups —— 固定三列 repeat(3,minmax(0,1fr))
 *   └ 列                            每层一列，列内竖向
 *       ├ .ios-group-hd               设计稿 .gh：层名 + 计数胶囊 + 排序口径
 *       └ .ios-quick                  设计稿 .quick：列表卡（行间 hairline）
 *           └ .ios-qrow               设计稿 .qrow：单选圈 + 两行（标题 / 元信息）
 * ```
 *
 * ## 一处**有意偏离**设计稿（需知悉）
 * 设计稿的文字说明写「某一层没有条目时**整层隐藏**，三层全空则退化为一句文案」。
 * 本组件**不这么做**：三列恒显，空层在列表卡里放一行「暂无」占位。
 * 理由（实测）：本机账号在「111」空间近 7 天**零会话**，按"空层隐藏"规则
 * 三栏一栏都不渲染 —— 用户因此**看不到结构本身**，无法判断布局是否已就位
 * （这正是 2026-09-30 用户连续两次反馈"你的三列布局在哪"的直接原因）。
 * 恒显三列让结构在任何数据量下都可被验证；有数据时行为与设计稿完全一致。
 * 若日后要回到"空层隐藏"，把 `EMPTY_LAYER_VISIBLE` 置 false 即可。
 *
 * ## 职责边界
 * 分桶 / 排序 / 去重全在 `lib/task-space/continue-previous.ts`（纯函数，已单测）；
 * 本组件只负责展示与选择回调，时间格式化由调用方注入（复用页面本地化口径）。
 */
import type { ReactNode } from 'react'

/** 空层是否保留占位（见头注「一处有意偏离」）。 */
export const EMPTY_LAYER_VISIBLE = true

export interface ContinuePreviousItem {
  workItemId: string
  displayKey: string
  title: string
  /** 最近一次会话开始时间（ISO） */
  lastSessionAt: string
  sessionCount: number
  priority?: string | null
}

export interface ContinuePreviousBucketsView {
  today: ContinuePreviousItem[]
  yesterday: ContinuePreviousItem[]
  withinWeek: ContinuePreviousItem[]
}

export interface ContinuePreviousProps {
  buckets: ContinuePreviousBucketsView
  selectedWorkItemId: string | null
  onSelect: (workItemId: string) => void
  /** 时间显示（注入，复用页面口径） */
  formatSessionTime: (iso: string) => string
}

const PRIORITY_LEVEL: Record<string, 'high' | 'mid' | 'low'> = {
  high: 'high',
  medium: 'mid',
  mid: 'mid',
  low: 'low',
}
const PRIORITY_LABEL: Record<'high' | 'mid' | 'low', string> = { high: '高', mid: '中', low: '低' }

interface LayerProps {
  title: string
  sortLabel: string
  items: ContinuePreviousItem[]
  selectedWorkItemId: string | null
  onSelect: (workItemId: string) => void
  formatSessionTime: (iso: string) => string
  /** 是否显示优先级标签（七天内堆积按优先级排布） */
  showPriority?: boolean
  testId: string
}

function Layer({
  title,
  sortLabel,
  items,
  selectedWorkItemId,
  onSelect,
  formatSessionTime,
  showPriority = false,
  testId,
}: LayerProps): ReactNode {
  return (
    <section className="min-w-0" data-testid={testId}>
      <div className="ios-group-hd">
        <div className="r1">
          {title}
          <span className="cnt">{items.length}</span>
        </div>
        <div className="sort">{sortLabel}</div>
      </div>
      <div className="ios-quick">
        {items.length === 0 && EMPTY_LAYER_VISIBLE ? (
          <div className="ios-qrow" data-empty="true">
            <span className="qempty">暂无</span>
          </div>
        ) : null}
        {items.map((item) => {
          const level = item.priority ? PRIORITY_LEVEL[item.priority] : undefined
          return (
            <button
              key={item.workItemId}
              type="button"
              className="ios-qrow"
              data-tappable="true"
              data-selected={selectedWorkItemId === item.workItemId ? 'true' : 'false'}
              onClick={() => onSelect(item.workItemId)}
            >
              <span className="ios-radio" data-size="sm" />
              <span className="qbody">
                <span className="qt">{item.title}</span>
                <span className="qmeta">
                  {showPriority && level ? (
                    <span className="ios-prio" data-level={level}>
                      {PRIORITY_LABEL[level]}
                    </span>
                  ) : null}
                  <span>
                    {formatSessionTime(item.lastSessionAt)} · {item.sessionCount} 次
                  </span>
                </span>
              </span>
            </button>
          )
        })}
      </div>
    </section>
  )
}

export function ContinuePrevious(props: ContinuePreviousProps): ReactNode {
  const { buckets, selectedWorkItemId, onSelect, formatSessionTime } = props

  return (
    <div className="ios-groups" data-testid="continue-previous">
      <Layer
        title="最近打开"
        sortLabel="按最近会话时间"
        items={buckets.today}
        selectedWorkItemId={selectedWorkItemId}
        onSelect={onSelect}
        formatSessionTime={formatSessionTime}
        testId="bucket-today"
      />
      <Layer
        title="昨日未完成"
        sortLabel="按最近会话时间"
        items={buckets.yesterday}
        selectedWorkItemId={selectedWorkItemId}
        onSelect={onSelect}
        formatSessionTime={formatSessionTime}
        testId="bucket-yesterday"
      />
      <Layer
        title="七天内堆积"
        sortLabel="按优先级排布"
        items={buckets.withinWeek}
        selectedWorkItemId={selectedWorkItemId}
        onSelect={onSelect}
        formatSessionTime={formatSessionTime}
        showPriority
        testId="bucket-week"
      />
    </div>
  )
}
