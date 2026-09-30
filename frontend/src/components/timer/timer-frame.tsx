'use client'

/**
 * 番茄钟页的两栏骨架（iOS 风格）—— 左焦点 / 右伴奏。
 *
 * 为什么要有这个骨架：页面原先三态各自写一套 `grid gap-6` 容器，导致
 * 「准备态 5 块垂直堆叠」与「运行态 环+3 块」骨架不同，切换时整页重排。
 * 抽成同一个骨架后，三态共用同一空间结构，焦点区位置固定。
 *
 * 两条硬约束（不可改）：
 * 1. **沉浸模式的渐隐作用域**：`data-immersive` 挂在根容器上；被渐隐的是
 *    **显式标记 `.timer-immersive-fade` 的伴奏卡**（2026-09-30 ADR-0008 D12：
 *    原实现渐隐整个右栏 —— 但父级 `opacity` 是子树合成效果，子元素无法"逆渐隐"，
 *    导图端口必须常驻可交互，故作用域下沉到卡级）。`.timer-immersive-region`
 *    保留为右栏的**结构标记**（承载既有 testid 契约），不再承担渐隐。
 *    焦点区与顶栏的动作按钮**永远不渐隐** —— "退出沉浸"绝不能被自己的渐隐规则
 *    吃掉，这是结构保证而非样式巧合。
 * 2. **`data-testid="immersive-region"` 必须存在**（既有测试断言）。
 *
 * 职责边界：本组件只提供**骨架与容器级 iOS 外观**（背景 / 白卡 / 间距），
 * 不改变任何既有子组件（SessionClock / SessionWorkspace / SessionReview …）
 * 的内部实现与行为。
 */
import { type CSSProperties, type ReactNode } from 'react'

export interface TimerFrameProps {
  /** 顶栏左侧（二级归属等） */
  breadcrumb?: ReactNode
  /** 顶栏右侧动作（沉浸开关、返回任务页等） */
  actions?: ReactNode
  /** 左栏焦点区内容（环 / 启动器 / 复盘表单） */
  focus: ReactNode
  /** 右栏伴奏区（计划 / 笔记 / 导图 / 统计）；缺省则只渲染左栏 */
  side?: ReactNode
  /**
   * 右栏标题栏（设计稿 `.side .hd`）：全宽、带下边框，正文区自己滚动。
   * 只在传入时启用「标题栏 + 正文区」两段式（准备态「今日」用）；
   * 不传时保持原样（运行态 / 结束态右栏是若干卡片的自由滚动流，无标题栏）。
   */
  sideHeader?: ReactNode
  /**
   * 沉浸模式。**仅在运行态传入**：
   * - `true` → 右栏渐隐（保留焦点区）
   * - `false` → 不渐隐但仍带沉浸作用域
   * - `undefined`（准备态 / 结束态）→ 完全不挂 `data-immersive`，无副作用
   */
  immersive?: boolean
  /** 右栏最小宽度（准备态三栏快捷入口需要更宽） */
  sideWidth?: number
}

export function TimerFrame({
  breadcrumb,
  actions,
  focus,
  side,
  sideHeader,
  immersive,
  sideWidth = 336,
}: TimerFrameProps) {
  return (
    <div
      className="ios-scope flex min-h-full flex-col"
      // 关键视觉用 inline style 引用主题变量（双保险）：
      // 自定义类万一被其它样式压制/未加载，这里仍能生效；变量本身由
      // .ios-scope（浅色）与 .dark/.midnight/.nord .ios-scope（深色）定义。
      style={{
        background: 'var(--ios-bg, var(--background))',
        color: 'var(--ios-label, var(--foreground))',
      }}
      {...(immersive === undefined
        ? {}
        : { 'data-immersive': immersive ? 'true' : 'false' })}
    >
      {(breadcrumb || actions) ? (
        <header className="flex min-h-[52px] items-center gap-3 px-5 py-2.5">
          <div
            className="min-w-0 flex-1 text-[13px]"
            style={{ color: 'var(--ios-label-2, var(--muted-foreground))' }}
          >
            {breadcrumb}
          </div>
          {actions}
        </header>
      ) : null}

      <div
        className="timer-frame-grid min-h-0 flex-1 px-5 pb-6"
        style={{ '--timer-side-w': `${sideWidth}px` } as CSSProperties}
      >
        <section
          className="ios-card flex min-h-[520px] flex-col p-6"
          // 结构性视觉（背景 / 圆角 / 裁切）也走 inline：
          // 排查期间发现「CSS 类是否生效」无法从服务端确证，故把最关键的
          // 视觉属性提到 inline —— 它不可能被任何样式表规则覆盖。
          style={{
            background: 'var(--ios-card, var(--card, #ffffff))',
            borderRadius: 12,
            overflow: 'hidden',
          }}
        >
          {focus}
        </section>
        {side ? (
          sideHeader ? (
            // 两段式（设计稿 .side）：全宽标题栏 + 自行滚动的正文区。
            // 标题栏在渐隐区内 —— 它属于伴奏栏的一部分（运行态不传 sideHeader，
            // 因此「退出沉浸」按钮永远不在这个分支里）。
            <aside
              className="timer-immersive-region ios-side flex min-h-0 flex-col overflow-hidden"
              data-testid="immersive-region"
              style={{ borderRadius: 12 }}
            >
              <div className="ios-side-hd">
                <span className="t">{sideHeader}</span>
              </div>
              {side}
            </aside>
          ) : (
            <aside
              className="timer-immersive-region ios-card flex min-h-0 flex-col gap-4 overflow-y-auto p-4"
              data-testid="immersive-region"
              style={{ background: 'var(--ios-card, var(--card))' }}
            >
              {side}
            </aside>
          )
        ) : null}
      </div>
    </div>
  )
}
