/**
 * 编辑区头栏（`.wm-editor-hd`）布局判别测试 —— 2026-10-03 真机回归。
 *
 * ## 现象（用户截图）
 * 窄容器下头栏被挤坏：
 * - 「工作导图 · 本次会话」标题**竖排成 4 行**（每行 2 字）
 * - 「22 项」计数同样竖排
 * - 视图切换 tab 组被压得只剩半个，右侧 tab 文字被裁切
 * - 8 个键位提示（Tab/Del/⇧P/…）横占一整行，把中间内容推到溢出
 *
 * ## 根因（三条同源）
 * 1. `.wm-editor-hd` 是 `display:flex` 且**没有** `flex-wrap` / `min-width:0`
 * 2. 标题 span 只有 `flex-shrink: 0`（来自 `.wm-editor-hd`），**不容许收缩也不换行**，
 *    容器一窄就每个汉字各占一行
 * 3. `.wm-editor-keys` 的 `margin-left: auto` 把它推到最右，与 tab 组争夺同一行空间
 *
 * 本文件锁住「窄容器下不塌」的可观察性质（用 DOM 顺序与 class 判定，
 * 不做像素级断言 —— jsdom 无布局引擎）。
 */
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { TimerMapEditor } from './timer-map-editor'

const SESSION_ID = 'c766be47-8725-443b-86e3-7cfee648a2f4'

/** 三个子岛 → 触发视图切换 tab 组（含数字序号，考验宽度压力）。 */
const THREE_SUBS = `<!--
next_cid: 20
centers:
  - at: "node:work/09-30 19:55 会话"
    cid: c1
    dir: right
    session_id: "${SESSION_ID}"
-->
# work

<!--
cid: "c1"
session_id: "${SESSION_ID}"
-->
## 09-30 19:55 会话

### 测试次一级的workitme

<!--
cid: "c10"
-->
#### 子任务一

### 导图实测改名实验并加长标题

<!--
cid: "c11"
-->
#### 子任务二

### CESHI

<!--
cid: "c12"
-->
#### 子任务三
`

function headOf(container: HTMLElement): HTMLElement {
  const head = container.querySelector('.wm-editor-hd')
  expect(head).not.toBeNull()
  return head as HTMLElement
}

describe('编辑区头栏 · 布局健壮性（2026-10-03 真机回归）', () => {
  it('★ 头栏本身是纵向三段（不再是「三者挤一行」）', () => {
    const { container } = render(
      <TimerMapEditor mapText={THREE_SUBS} sessionId={SESSION_ID} />,
    )
    const head = headOf(container)
    // 标题必须被包在自己的行容器里 —— 有了它，标题就不会被 tab 组挤压
    const row = head.querySelector('.wm-editor-hd-row')
    expect(row).toBeTruthy()
    expect(row!.querySelector('.wm-editor-title')).toBeTruthy()
  })

  it('★ 标题是独立元素（有自己的 nowrap 样式钩子，不靠父级侥幸）', () => {
    const { container } = render(
      <TimerMapEditor mapText={THREE_SUBS} sessionId={SESSION_ID} />,
    )
    const title = headOf(container).querySelector('.wm-editor-title')
    expect(title).toBeTruthy()
    // 文案完整（未被拆成多段文本节点 = 竖排折行的直接征兆）
    expect(title!.textContent).toBe('工作导图 · 本次会话')
  })

  it('★ 计数不竖排（shrink-0 + nowrap）', () => {
    const { container } = render(
      <TimerMapEditor mapText={THREE_SUBS} sessionId={SESSION_ID} />,
    )
    const count = headOf(container).querySelector('.wm-editor-count')
    expect(count).toBeTruthy()
    // 单枚胶囊、不折行
    expect(count!.className).toMatch(/shrink-0/)
    expect(count!.textContent).toMatch(/项$/)
  })

  it('★ 键位提示不再与标题/tab 抢同一行（移到独立行或可折叠）', () => {
    const { container } = render(
      <TimerMapEditor mapText={THREE_SUBS} sessionId={SESSION_ID} onEdit={async () => {}} />,
    )
    const keys = container.querySelector('[data-testid="map-key-hints"]')
    expect(keys).toBeTruthy()
    // 不再带 margin-left:auto（那正是把中间内容推挤出去的元凶）
    expect(keys!.className).not.toMatch(/ml-auto/)
  })

  it('★ 视图切换组可横向滚动（子岛多时不撑破容器）', () => {
    const { container } = render(
      <TimerMapEditor mapText={THREE_SUBS} sessionId={SESSION_ID} />,
    )
    const toggle = container.querySelector('[data-testid="map-sub-island-toggle"]')
    expect(toggle).toBeTruthy()
    expect(toggle!.className).toMatch(/scroll/)
  })

  it('子岛 tab 仍按 1..N 顺序渲染（顺序语义不变）', () => {
    render(<TimerMapEditor mapText={THREE_SUBS} sessionId={SESSION_ID} />)
    const tabs = screen.getAllByRole('button', { pressed: false })
    expect(tabs.length).toBeGreaterThan(0)
    expect(screen.getByTestId('map-view-global')).toBeTruthy()
  })

  it('★ tab 文案不再 JS 硬截断（长标题保留全文，交给 CSS 省略）', () => {
    render(<TimerMapEditor mapText={THREE_SUBS} sessionId={SESSION_ID} />)
    const labels = [...document.querySelectorAll('.wm-view-btn-label')].map(
      (el) => el.textContent ?? '',
    )
    expect(labels).toContain('导图实测改名实验并加长标题')
    // 任何 tab 文案都不得含 JS 硬截断留下的省略号
    expect(labels.every((text) => !text.endsWith('…'))).toBe(true)
    // 全文同时出现在 title/aria-label 里（tooltip 兜底）
    const btn = document
      .querySelectorAll('.wm-view-btn-label')
      [1]?.closest('button')
    expect(btn?.getAttribute('title') ?? '').toContain('导图实测改名实验并加长标题')
    expect(btn?.getAttribute('aria-label') ?? '').toContain('导图实测改名实验并加长标题')
  })
})
