/**
 * 结束态「岛总览」（TimerMapOverview）—— ADR-0008 D13 步 3-4b / D17。
 *
 * 断言锚在可观察量上：**全部 islands**（不滤当前会话）+ 岛/项计数、当前会话岛高亮、
 * **只读**（无编辑入口）、筛选 **dim 不 hide**（节点数不变、树结构未断）、fail-soft 占位。
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { addChildNode } from '@/lib/work-map/node-edits'
import { readWorkMapLayout } from '@/lib/work-map/island-layout'
import { appendThoughtNode } from '@/lib/work-map/thought-nodes'
import { buildSessionIsland } from '@/lib/work-map/session-island'

import { TimerMapOverview } from './timer-map-overview'
import { MIN_ISLAND_CARD_W } from './work-map-tree'

const SID = 'c766be47-8725-443b-86e3-7cfee648a2f4'

const BASE = `<!--
next_cid: 2
centers:
  - at: "node:测试次一级的workitme/09-30 19:55 会话"
    cid: c1
    dir: right
    session_id: "${SID}"
-->
# 测试次一级的workitme

<!--
cid: "c1"
session_id: "${SID}"
-->
## 09-30 19:55 会话

### 测试次一级的workitme
`

/** 两个 problem + 一个 todo。 */
const DOC = (() => {
  let text = addChildNode(BASE, { parentCid: 'c1', title: '甲', thoughtType: 'problem' }).text
  text = addChildNode(text, { parentCid: 'c1', title: '乙', thoughtType: 'problem' }).text
  return addChildNode(text, { parentCid: 'c1', title: '丙', thoughtType: 'todo' }).text
})()

describe('TimerMapOverview（结束态岛总览）', () => {
  it('★ 渲染**全部** islands（不滤当前会话）+ 岛数/项数计数；当前会话岛高亮', () => {
    const { container } = render(<TimerMapOverview mapText={DOC} sessionId={SID} />)
    expect(screen.getByTestId('timer-map-overview')).toHaveTextContent('工作导图 · 岛总览')
    expect(screen.getByTestId('timer-map-overview')).toHaveTextContent('2 个岛')
    const canvas = screen.getByTestId('map-overview-canvas')
    expect(canvas.querySelector('svg.wm-tree')).not.toBeNull()
    // 当前会话岛（本次）被标出且只有它
    expect(canvas.querySelectorAll('[data-testid="wm-current-island"]')).toHaveLength(1)
    expect(canvas.querySelectorAll('[data-testid="wm-session-node"]')).toHaveLength(1)
    expect(container.querySelectorAll('.wm-link').length).toBeGreaterThan(0)
  })

  it('★ title prop：默认「岛总览」；准备态主图弹层传「主图」（只改文案不改内容）', () => {
    const { unmount } = render(<TimerMapOverview mapText={DOC} sessionId={SID} />)
    expect(screen.getByTestId('timer-map-overview')).toHaveTextContent('工作导图 · 岛总览')
    unmount()

    render(<TimerMapOverview mapText={DOC} sessionId={null} title="主图" />)
    expect(screen.getByTestId('timer-map-overview')).toHaveTextContent('工作导图 · 主图')
    // 内容不变：图例 + 全部 islands 照旧
    expect(screen.getByTestId('map-legend')).toBeTruthy()
    expect(screen.getByTestId('map-overview-canvas')).toBeTruthy()
  })

  it('★ 只读（红线 2）：无编辑入口 —— 无 data-cid、无操作行、无快速记录行', () => {
    const { container } = render(<TimerMapOverview mapText={DOC} sessionId={SID} />)
    expect(container.querySelectorAll('.wm-node[data-cid]')).toHaveLength(0)
    expect(screen.queryByTestId('map-node-actions')).toBeNull()
    expect(screen.queryByTestId('map-quick')).toBeNull()
  })

  it('★ 筛选 dim 不 hide：点「问题」→ 命中高亮、其余 dim，**节点数不变**、连线仍在', () => {
    const { container } = render(<TimerMapOverview mapText={DOC} sessionId={SID} />)
    const total = container.querySelectorAll('.wm-node').length
    expect(total).toBeGreaterThanOrEqual(6) // 根 H1 + 会话岛 5
    expect(container.querySelectorAll('.wm-node[data-dim="true"]')).toHaveLength(0)

    fireEvent.click(screen.getByTestId('map-legend-problem'))

    // dim 而非 hide：节点**一个都没少**（hide 会让这个数变小）
    expect(container.querySelectorAll('.wm-node').length).toBe(total)
    expect(container.querySelectorAll('.wm-node[data-highlight="true"]')).toHaveLength(2)
    expect(container.querySelectorAll('.wm-node[data-dim="true"]')).toHaveLength(total - 2)
    // 树结构未断：连线仍在
    expect(container.querySelectorAll('.wm-link').length).toBeGreaterThan(0)

    // 「全部」恢复全亮
    fireEvent.click(screen.getByTestId('map-legend-all'))
    expect(container.querySelectorAll('.wm-node[data-dim="true"]')).toHaveLength(0)
    expect(container.querySelectorAll('.wm-node[data-highlight="true"]')).toHaveLength(0)
  })

  it('★ 连线随两端：一端亮则线亮（树不被打散）', () => {
    const { container } = render(<TimerMapOverview mapText={DOC} sessionId={SID} />)
    fireEvent.click(screen.getByTestId('map-legend-problem'))
    const links = [...container.querySelectorAll('.wm-link')]
    const dimLinks = links.filter((link) => link.getAttribute('data-dim') === 'true')
    // 有连线：一部分因"至少一端命中"而保持亮 → dim 的少于全部
    expect(links.length).toBeGreaterThan(0)
    expect(dimLinks.length).toBeLessThan(links.length)
  })

  it('fail-soft：无导图 / 解析失败 → 占位（不渲染 canvas）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { unmount } = render(<TimerMapOverview mapText={null} sessionId={SID} />)
    expect(screen.getByTestId('map-overview-empty')).toBeTruthy()
    expect(screen.queryByTestId('map-overview-canvas')).toBeNull()
    unmount()

    render(<TimerMapOverview mapText={'<!--\nnote: 无标题\n-->\n'} sessionId={SID} />)
    expect(screen.getByTestId('map-overview-empty')).toBeTruthy()
    warn.mockRestore()
  })
})

/**
 * 近 N 展开 + 历史归档岛（ADR-0008 D19-a）：
 * 默认近 5（8 会话 → 5 活跃 + 归档卡 3 次）；分段切换与点归档卡均可一键全量展开。
 */
describe('TimerMapOverview 近 5 展开 + 归档岛（D19-a）', () => {
  const MANY = (() => {
    let text = ''
    for (let i = 1; i <= 8; i += 1) {
      const result = buildSessionIsland(text, {
        sessionId: `ov-archive-${String(i).padStart(2, '0')}`,
        workItemTitle: '总览归档测试工作项',
        sessionTitle: `10-${String(i).padStart(2, '0')} 10:00 会话`,
      })
      if (!result.changed) throw new Error(`fixture 构建失败：${result.reason}`)
      text = result.text
    }
    return text
  })()

  it('★ 默认近 5：8 会话 → 根岛 + 5 活跃（计数 6 个岛）+ 归档卡（共 3 次专注）', () => {
    render(<TimerMapOverview mapText={MANY} sessionId={null} />)
    expect(screen.getByTestId('timer-map-overview')).toHaveTextContent('6 个岛')
    expect(screen.getByTestId('map-archive-count')).toHaveTextContent('归档 3 次')
    const card = screen.getByTestId('wm-archive-island')
    expect(card).toHaveTextContent('早期会话 (共 3 次专注)')
    expect(card).toHaveTextContent('点击展开历史全览')
    // 分段切换：默认选中「近 5 岛」
    expect(screen.getByTestId('map-view-near')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('map-view-all')).toHaveAttribute('aria-pressed', 'false')
  })

  it('★ 「全部展开」↔「近 5 岛」往返：展开后无归档卡、计数 9 个岛；切回归档卡重现', () => {
    render(<TimerMapOverview mapText={MANY} sessionId={null} />)
    fireEvent.click(screen.getByTestId('map-view-all'))
    expect(screen.queryByTestId('wm-archive-island')).toBeNull()
    expect(screen.getByTestId('timer-map-overview')).toHaveTextContent('9 个岛')
    expect(screen.getByTestId('map-view-all')).toHaveAttribute('aria-pressed', 'true')

    fireEvent.click(screen.getByTestId('map-view-near'))
    expect(screen.getByTestId('wm-archive-island')).toBeTruthy()
    expect(screen.getByTestId('map-view-near')).toHaveAttribute('aria-pressed', 'true')
  })

  it('★ 点归档岛卡片 → 等同「全部展开」（D19-a 一键历史全览）', () => {
    render(<TimerMapOverview mapText={MANY} sessionId={null} />)
    fireEvent.click(screen.getByTestId('wm-archive-island'))
    expect(screen.queryByTestId('wm-archive-island')).toBeNull()
    expect(screen.getByTestId('map-view-all')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('timer-map-overview')).toHaveTextContent('9 个岛')
  })

  it('★ 会话岛 ≤ 5 时不出现归档卡（1 会话文档，既有形态不变）', () => {
    render(<TimerMapOverview mapText={DOC} sessionId={SID} />)
    expect(screen.queryByTestId('wm-archive-island')).toBeNull()
    expect(screen.queryByTestId('map-archive-count')).toBeNull()
    expect(screen.getByTestId('timer-map-overview')).toHaveTextContent('2 个岛')
  })
})

/**
 * 自持地标卡 + 平滑聚焦进岛（S4-3，ADR-0008 D19-c：纯自持增强）。
 *
 * 断言锚在可观察量上：岛根胶囊角标（N 项思考 + 5 类点阵点亮）、双击卡片后
 * viewBox 平滑过渡到单岛 bounds+32、非聚焦岛挂 .wm-island--dimmed、
 * 退出钮 / Esc 还原全局近 5 岛视角（viewBox 精确回位）。
 */
describe('TimerMapOverview 地标卡与聚焦交互（S4-3 / D19-c）', () => {
  const MANY = (() => {
    let text = ''
    for (let i = 1; i <= 8; i += 1) {
      const result = buildSessionIsland(text, {
        sessionId: `ov-archive-${String(i).padStart(2, '0')}`,
        workItemTitle: '总览归档测试工作项',
        sessionTitle: `10-${String(i).padStart(2, '0')} 10:00 会话`,
      })
      if (!result.changed) throw new Error(`fixture 构建失败：${result.reason}`)
      text = result.text
    }
    // 给最近会话挂 3 类思考节点（点阵应有 3 处点亮）
    const latest = 'ov-archive-08'
    text = appendThoughtNode(text, { sessionId: latest, type: 'problem', title: '甲' }).text
    text = appendThoughtNode(text, { sessionId: latest, type: 'todo', title: '乙' }).text
    text = appendThoughtNode(text, { sessionId: latest, type: 'insight', title: '丙' }).text
    return text
  })()

  const MANY_LAYOUT = readWorkMapLayout(MANY, { expandAll: false })!

  /** 首个活跃会话岛（DOM 中第一张地标卡）的聚焦 viewBox：bounds ± 32。 */
  const FIRST_CARD_ISLAND = MANY_LAYOUT.islands.find(
    (island) => !island.isArchive && island.sessionId !== null,
  )!
  const EXPECTED_FOCUS_VIEW_BOX = (() => {
    const b = FIRST_CARD_ISLAND.bounds
    return `${b.minX - 32} ${b.minY - 32} ${b.maxX - b.minX + 64} ${b.maxY - b.minY + 64}`
  })()

  /** 全览 viewBox：并集计入地标卡外框（top 28 / 侧 12，最小宽 MIN_ISLAND_CARD_W），pad = 12（渲染器同式）。 */
  const EXPECTED_ALL_VIEW_BOX = (() => {
    const visual = MANY_LAYOUT.islands.map((island) => {
      if (island.isArchive === true || island.sessionId === null) return island.bounds
      const minX = island.bounds.minX - 12
      const naturalW = island.bounds.maxX - island.bounds.minX + 24
      const w = Math.max(MIN_ISLAND_CARD_W, naturalW)
      return {
        minX,
        minY: island.bounds.minY - 28,
        maxX: minX + w,
        maxY: island.bounds.maxY + 12,
      }
    })
    const minX = Math.min(...visual.map((v) => v.minX))
    const minY = Math.min(...visual.map((v) => v.minY))
    const maxX = Math.max(...visual.map((v) => v.maxX))
    const maxY = Math.max(...visual.map((v) => v.maxY))
    return `${minX - 12} ${minY - 12} ${maxX - minX + 24} ${maxY - minY + 24}`
  })()

  const viewBoxOf = (container: HTMLElement): string | null =>
    container.querySelector('svg.wm-tree')?.getAttribute('viewBox') ?? null

  it('★ 岛根渲染地标卡与胶囊角标：「N 项思考」+ 5 类点阵（有节点的类型点亮）', () => {
    const { container } = render(<TimerMapOverview mapText={MANY} sessionId={null} />)
    const cards = container.querySelectorAll('[data-testid="wm-island-card"]')
    // 近 5：5 个活跃会话岛都有地标卡（根岛 / 归档卡不套）；DOM 序 = 岛数组序
    expect(cards).toHaveLength(5)

    // 注：kernel 每次解析重建运行时 id，跨两次 readWorkMapLayout 不能按 rootId
    // 对位 —— 用 DOM 序号（几何确定，bounds 跨解析一致）。
    const firstBadge = cards[0].querySelector('[data-testid="wm-island-badge"]')
    expect(firstBadge?.textContent).toContain('项思考')
    // 点阵恒 5 枚；空岛（仅会话根，首卡）全部未点亮
    const dots = [...(firstBadge?.querySelectorAll('[data-lit]') ?? [])]
    expect(dots).toHaveLength(5)
    expect(dots.every((dot) => dot.getAttribute('data-lit') === 'false')).toBe(true)

    // 最近会话（第 5 卡，3 类思考节点）→ 恰好 3 枚点亮，角标计数 = 3 项思考
    expect(cards[4].getAttribute('data-thought-count')).toBe('3')
    const litCount = [...cards[4].querySelectorAll('[data-lit]')].filter(
      (dot) => dot.getAttribute('data-lit') === 'true',
    ).length
    expect(litCount).toBe(3)
  })

  it('★ 双击地标卡 → 聚焦进岛：viewBox 平滑过渡到单岛 bounds+32，其余岛 dim', async () => {
    const { container } = render(<TimerMapOverview mapText={MANY} sessionId={null} />)
    const cards = () => container.querySelectorAll('[data-testid="wm-island-card"]')
    fireEvent.doubleClick(cards()[0])

    // 控制栏出现退出入口与正在查看文案
    expect(screen.getByTestId('map-focus-exit')).toHaveTextContent('← 退出聚焦')
    expect(screen.getByTestId('map-focus-label')).toHaveTextContent(
      `正在查看：${FIRST_CARD_ISLAND.tree.text}`,
    )
    // 非聚焦岛 dim（纯 CSS）：7 岛 - 聚焦 1 = 6
    await waitFor(() => {
      expect(container.querySelectorAll('.wm-island--dimmed')).toHaveLength(6)
    })
    // viewBox 最终精确落在单岛 bounds+32（rAF 插值的落点）
    await waitFor(() => {
      expect(viewBoxOf(container)).toBe(EXPECTED_FOCUS_VIEW_BOX)
    })
  })

  it('★ 退出聚焦（按钮 / Esc）→ viewBox 还原为全局近 5 岛视角', async () => {
    const { container } = render(<TimerMapOverview mapText={MANY} sessionId={null} />)
    fireEvent.doubleClick(container.querySelectorAll('[data-testid="wm-island-card"]')[0])
    await waitFor(() => expect(viewBoxOf(container)).toBe(EXPECTED_FOCUS_VIEW_BOX))

    // ① 按钮退出
    fireEvent.click(screen.getByTestId('map-focus-exit'))
    await waitFor(() => expect(viewBoxOf(container)).toBe(EXPECTED_ALL_VIEW_BOX))
    expect(screen.queryByTestId('map-focus-bar')).toBeNull()
    expect(container.querySelectorAll('.wm-island--dimmed')).toHaveLength(0)

    // ② 再聚焦 → Esc 退出
    fireEvent.doubleClick(container.querySelectorAll('[data-testid="wm-island-card"]')[0])
    await waitFor(() => expect(viewBoxOf(container)).toBe(EXPECTED_FOCUS_VIEW_BOX))
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(viewBoxOf(container)).toBe(EXPECTED_ALL_VIEW_BOX))
    expect(screen.queryByTestId('map-focus-bar')).toBeNull()
  })
})