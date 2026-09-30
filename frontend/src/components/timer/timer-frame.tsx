'use client'

/**
 * 番茄钟页的两栏骨架（iOS 风格）—— 左焦点 / 右伴奏。
 *
 * 为什么要有这个骨架：页面原先三态各自写一套 `grid gap-6` 容器，导致
 * 「准备态 5 块垂直堆叠」与「运行态 环+3 块」骨架不同，切换时整页重排。
 * 抽成同一个骨架后，三态共用同一空间结构，焦点区位置固定。
 *
 * 两条硬约束（不可改）：
 * 1. **沉浸模式的渐隐作用域**：`data-immersive` 挂在根容器上，被渐隐的是右栏
 *    （带 `.timer-immersive-region`）。焦点区与顶栏的动作按钮**永远不渐隐** ——
 *    "退出沉浸"绝不能被自己的渐隐规则吃掉，这是结构保证而非样式巧合。
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
          style={{ background: 'var(--ios-card, var(--card))' }}
        >
          {focus}
        </section>
        {side ? (
          <aside
            className="timer-immersive-region flex min-h-0 flex-col gap-4 overflow-y-auto"
            data-testid="immersive-region"
          >
            {side}
          </aside>
        ) : null}
      </div>
    </div>
  )
}
