'use client'

/**
 * 准备态「**主图**」弹层（ADR-0008 D18 / D13 步 3-4a，方案 C）。
 *
 * ## 为什么是弹层
 * 准备态的核心任务是"选任务 + 开始"，主图是辅助信息 → 点按钮弹全屏层，
 * **不挤占启动器、不改准备态布局**；内容直接复用结束态全览的渲染件。
 *
 * ## 职责边界
 * - 本件只做**弹层壳**：backdrop / 关闭（Esc · backdrop · 按钮）/ 焦点 / body 滚动锁
 * - **内容零重复**：直接渲染 `TimerMapOverview`（图例 + 全部 islands + 类型筛选），
 *   仅把标题换成「主图」（D18 红线 4：禁止复制同功能渲染代码）
 * - **只读**：不传任何编辑回调（D16 编辑入口仅运行态有），本件不调写原语
 *
 * ## a11y 底线（红线 5）
 * `role="dialog"` + `aria-modal` + Esc 可关 + **焦点归还触发元素** + 滚动锁**卸载必解锁**。
 * 有意**不做**完整焦点陷阱（Tab 循环）——见交付报告「已知限制」。
 */
import { useEffect, useRef, type ReactNode } from 'react'

import { TimerMapOverview } from './timer-map-overview'

export interface WorkMapPreviewOverlayProps {
  open: boolean
  /** 读图中（准备态懒读）：显示「读取中…」，而不是空态占位 */
  loading: boolean
  /** 三级项导图原文；null = 尚无导图 / 读取失败（fail-soft 占位） */
  mapText: string | null
  onClose: () => void
}

export function WorkMapPreviewOverlay({
  open,
  loading,
  mapText,
  onClose,
}: WorkMapPreviewOverlayProps): ReactNode {
  const panelRef = useRef<HTMLDivElement | null>(null)

  // 打开：记住开前焦点（= 触发按钮）→ 聚焦面板 → 锁 body 滚动；
  // 关闭或卸载：**全部还原**（滚动锁尤其不能泄漏）。
  useEffect(() => {
    if (!open) return
    const previousFocus = document.activeElement as HTMLElement | null
    const body = document.body
    const previousOverflow = body.style.overflow
    body.style.overflow = 'hidden'
    panelRef.current?.focus()
    return () => {
      body.style.overflow = previousOverflow
      previousFocus?.focus?.()
    }
  }, [open])

  // Esc 关闭
  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [open, onClose])

  if (!open) return null

  return (
    <div
      className="wm-preview-backdrop"
      data-testid="map-preview-backdrop"
      // 只有点**背景**才关；点面板内部不关（事件目标是面板时不等）
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        ref={panelRef}
        // ★ `ios-scope` 不可省：弹层挂在页面根部（`TimerFrame` 之外），而 `.wm-*`
        //   的配色全走 `--ios-*` 令牌 —— 不套作用域时令牌未定义，节点盒会渲染成黑块
        //   （真机截图抓到过）。套上后与番茄钟页同一套主题令牌 + 字体栈。
        className="wm-preview-panel ios-scope"
        role="dialog"
        aria-modal="true"
        aria-label="工作导图 · 主图"
        tabIndex={-1}
        data-testid="map-preview-panel"
      >
        <div className="wm-preview-bar">
          <button
            type="button"
            className="wm-preview-close"
            data-testid="map-preview-close"
            aria-label="关闭主图"
            onClick={onClose}
          >
            关闭
          </button>
        </div>
        {loading ? (
          <>
            <div className="wm-overview-hd">工作导图 · 主图</div>
            <p className="ios-tiny wm-preview-loading" data-testid="map-preview-loading">
              读取中…
            </p>
          </>
        ) : (
          <TimerMapOverview mapText={mapText} sessionId={null} title="主图" />
        )}
      </div>
    </div>
  )
}