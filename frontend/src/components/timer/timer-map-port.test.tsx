/**
 * 导图端口「当前会话岛」—— ADR-0008 D13 步 1 / D12 极简岛裁决的断言面。
 *
 * 断言锚在**可观察结构**上：
 * - 常驻态：岛轮廓 + 会话节点行（高亮 + 「当前」尾标）+ 子节点行
 * - 极简态：`data-minimal='true'` 派生，**同一 DOM**（文字仍在、行数不变 ——
 *   零布局抖动由 CSS `visibility` 保证，jsdom 不跑样式表，故钉结构等价）
 * - fail-soft：无导图 / 解析失败 / 会话不在岛上 → 占位文案，不抛
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { appendThoughtNode } from '@/lib/work-map/thought-nodes'

import { TimerMapPort } from './timer-map-port'

const SESSION_ID = 'c766be47-8725-443b-86e3-7cfee648a2f4'

/** 本项目真实产出的岛文件（2026-09-30 验收原件，与 island-view 测试同一 fixture）。 */
const ISLAND = `<!--
next_cid: 2
centers:
  - at: "node:测试次一级的workitme/09-30 19:55 会话"
    cid: c1
    dir: right
    session_id: "${SESSION_ID}"
-->
# 测试次一级的workitme

<!--
cid: "c1"
session_id: "${SESSION_ID}"
-->
## 09-30 19:55 会话

### 测试次一级的workitme
`

describe('TimerMapPort（运行态当前会话岛）', () => {
  it('常驻态：岛轮廓 + 会话节点高亮行（「当前」尾标）+ 子节点行', () => {
    render(
      <TimerMapPort mapText={ISLAND} sessionId={SESSION_ID} minimal={false} />,
    )
    const port = screen.getByTestId('timer-map-port')
    expect(port).toHaveAttribute('data-minimal', 'false')
    expect(screen.getByTestId('map-island')).toBeTruthy()

    const sessionRow = screen.getByTestId('map-session-node')
    expect(sessionRow).toHaveAttribute('data-current', 'true')
    expect(sessionRow.textContent).toContain('09-30 19:55 会话')
    expect(sessionRow.textContent).toContain('当前')

    // 岛内节点：会话节点（岛根）+ 其子节点，各一行
    expect(port.querySelectorAll('.ios-map-row')).toHaveLength(2)
    expect(port.textContent).toContain('测试次一级的workitme')
  })

  it('极简态：data-minimal 派生，同一 DOM（文字与行数不变 —— 零布局抖动的结构前提）', () => {
    const full = render(<TimerMapPort mapText={ISLAND} sessionId={SESSION_ID} minimal={false} />)
    const fullText = full.container.textContent
    const fullRows = full.container.querySelectorAll('.ios-map-row').length
    full.unmount()

    const minimal = render(<TimerMapPort mapText={ISLAND} sessionId={SESSION_ID} minimal />)
    expect(screen.getByTestId('timer-map-port')).toHaveAttribute('data-minimal', 'true')
    // 文字节点仍在 DOM（CSS visibility 隐标注；不做条件渲染 → 无重排）
    expect(minimal.container.textContent).toBe(fullText)
    expect(minimal.container.querySelectorAll('.ios-map-row').length).toBe(fullRows)
    // 当前会话节点高亮仍存在（极简岛保留项）
    expect(screen.getByTestId('map-session-node')).toHaveAttribute('data-current', 'true')
  })

  it('fail-soft：无导图（mapText=null）→ 占位文案，不渲染岛', () => {
    render(<TimerMapPort mapText={null} sessionId={SESSION_ID} minimal={false} />)
    expect(screen.getByTestId('map-port-empty')).toBeTruthy()
    expect(screen.queryByTestId('map-island')).toBeNull()
  })

  it('fail-soft：解析失败（垃圾文本）→ 占位文案且不抛', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    render(<TimerMapPort mapText={'!!! not a map !!!\n'} sessionId={SESSION_ID} minimal={false} />)
    expect(screen.getByTestId('map-port-empty')).toBeTruthy()
    warn.mockRestore()
  })

  it('会话不在岛上（sessionId 不匹配）→ 占位文案', () => {
    render(
      <TimerMapPort mapText={ISLAND} sessionId={'another-session'} minimal={false} />,
    )
    expect(screen.getByTestId('map-port-empty')).toBeTruthy()
  })
})

describe('TimerMapPort 快速记录（ADR-0008 D13 步 2）', () => {
  it('★ 类型行 5 类；点击 → 浮层输入 → 提交回调（类型 + 文本），成功后收起', async () => {
    const onQuickRecord = vi.fn().mockResolvedValue(undefined)
    render(
      <TimerMapPort mapText={ISLAND} sessionId={SESSION_ID} minimal={false} onQuickRecord={onQuickRecord} />,
    )
    const row = screen.getByTestId('map-quick')
    expect(row.querySelectorAll('button')).toHaveLength(5)
    expect(screen.queryByTestId('map-quick-pop')).toBeNull()

    fireEvent.click(screen.getByTestId('map-quick-problem'))
    expect(screen.getByTestId('map-quick-pop')).toBeTruthy()
    fireEvent.change(screen.getByTestId('map-quick-input'), { target: { value: 'token 对照' } })
    fireEvent.click(screen.getByTestId('map-quick-submit'))

    await waitFor(() => expect(onQuickRecord).toHaveBeenCalledWith('problem', 'token 对照'))
    await waitFor(() => expect(screen.queryByTestId('map-quick-pop')).toBeNull())
  })

  it('提交失败 → 卡内错误文案（不抛、浮层保留以便重试）', async () => {
    const onQuickRecord = vi.fn().mockRejectedValue(new Error('session_node_not_found'))
    render(
      <TimerMapPort mapText={ISLAND} sessionId={SESSION_ID} minimal={false} onQuickRecord={onQuickRecord} />,
    )
    fireEvent.click(screen.getByTestId('map-quick-insight'))
    fireEvent.change(screen.getByTestId('map-quick-input'), { target: { value: 'x' } })
    fireEvent.click(screen.getByTestId('map-quick-submit'))

    expect(await screen.findByTestId('map-quick-error')).toHaveTextContent('session_node_not_found')
    expect(screen.getByTestId('map-quick-pop')).toBeTruthy()
  })

  it('★ 极简态保留类型行（动作入口不是文字标注 —— D12 裁决 2）', () => {
    render(
      <TimerMapPort
        mapText={ISLAND}
        sessionId={SESSION_ID}
        minimal
        onQuickRecord={vi.fn().mockResolvedValue(undefined)}
      />,
    )
    expect(screen.getByTestId('map-quick')).toBeTruthy()
    // 按钮自带类名（不在被隐藏的 .ios-map-node-text / .ios-map-tail 集合里）
    expect(screen.getByTestId('map-quick-todo').className).toContain('ios-map-quick-btn')
  })

  it('只读端口（不传 onQuickRecord）→ 不渲染类型行', () => {
    render(<TimerMapPort mapText={ISLAND} sessionId={SESSION_ID} minimal={false} />)
    expect(screen.queryByTestId('map-quick')).toBeNull()
  })

  it('类型节点渲染形状标记与中文尾标；无类型节点不带尾标', () => {
    const appended = appendThoughtNode(ISLAND, {
      sessionId: SESSION_ID,
      type: 'problem',
      title: 'token 对照：灰阶 vs 玻璃主题',
    })
    expect(appended.changed).toBe(true)
    const { container } = render(
      <TimerMapPort mapText={appended.text} sessionId={SESSION_ID} minimal={false} />,
    )
    const shape = container.querySelector('.ios-map-shape[data-thought="problem"]')
    expect(shape).not.toBeNull()
    expect(screen.getByText('问题')).toBeTruthy()
    // 会话节点（无类型）不被误标
    expect(screen.getByTestId('map-session-node').querySelector('.ios-map-tail')?.textContent)
      .toBe('当前')
  })
})
