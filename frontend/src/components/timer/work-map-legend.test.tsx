/**
 * 类型图例（WorkMapLegend）—— ADR-0008 D9 双编码 / D17。
 *
 * 断言锚在可观察量上：5 类 + 「全部」、计数取自 islands、形状与树**同源**
 * （同一批 `.wm-shape--*` 类）、点击上抛 `onSelect(type | null)`、aria-pressed 反映选中。
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { readWorkMapLayout } from '@/lib/work-map/island-layout'
import { addChildNode } from '@/lib/work-map/node-edits'
import { THOUGHT_TYPES } from '@/lib/work-map/thought-types'

import { WorkMapLegend } from './work-map-legend'

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

/** 两个 problem + 一个 todo（其余类型 0）—— 图例计数与筛选断言用。 */
const DOC = (() => {
  let text = addChildNode(BASE, { parentCid: 'c1', title: '甲', thoughtType: 'problem' }).text
  text = addChildNode(text, { parentCid: 'c1', title: '乙', thoughtType: 'problem' }).text
  return addChildNode(text, { parentCid: 'c1', title: '丙', thoughtType: 'todo' }).text
})()

const islands = readWorkMapLayout(DOC)?.islands ?? []

describe('WorkMapLegend（类型图例）', () => {
  it('★ 5 类 + 「全部」；计数取自 islands（前序扫 thoughtType）', () => {
    render(<WorkMapLegend islands={islands} />)
    expect(screen.getByTestId('map-legend')).toBeTruthy()
    expect(screen.getByTestId('map-legend-problem')).toHaveTextContent('问题')
    expect(screen.getByTestId('map-legend-problem')).toHaveTextContent('2')
    expect(screen.getByTestId('map-legend-todo')).toHaveTextContent('1')
    expect(screen.getByTestId('map-legend-insight')).toHaveTextContent('0')
    expect(screen.getByTestId('map-legend-decision')).toHaveTextContent('0')
    expect(screen.getByTestId('map-legend-review')).toHaveTextContent('0')
    expect(screen.getByTestId('map-legend-all')).toHaveTextContent('全部')
    expect(screen.getByTestId('map-legend-all')).toHaveTextContent('3')
  })

  it('★ 形状与树**同源**：每个 chip 内是同一批 `.wm-shape--<type>` 类', () => {
    const { container } = render(<WorkMapLegend islands={islands} />)
    for (const type of THOUGHT_TYPES) {
      expect(
        container.querySelector(`[data-testid="map-legend-${type}"] .wm-shape--${type}`),
      ).not.toBeNull()
    }
  })

  it('★ 点击上抛 onSelect（单选一类 / 「全部」= null）；aria-pressed 反映选中', () => {
    const onSelect = vi.fn()
    const { rerender } = render(
      <WorkMapLegend islands={islands} selected={null} onSelect={onSelect} />,
    )
    expect(screen.getByTestId('map-legend-all')).toHaveAttribute('aria-pressed', 'true')

    fireEvent.click(screen.getByTestId('map-legend-problem'))
    expect(onSelect).toHaveBeenCalledWith('problem')

    fireEvent.click(screen.getByTestId('map-legend-all'))
    expect(onSelect).toHaveBeenCalledWith(null)

    rerender(<WorkMapLegend islands={islands} selected="todo" onSelect={onSelect} />)
    expect(screen.getByTestId('map-legend-todo')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByTestId('map-legend-problem')).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByTestId('map-legend-all')).toHaveAttribute('aria-pressed', 'false')
  })

  it('空 islands → 全 0（不崩）', () => {
    render(<WorkMapLegend islands={[]} />)
    for (const type of THOUGHT_TYPES) {
      expect(screen.getByTestId(`map-legend-${type}`)).toHaveTextContent('0')
    }
    expect(screen.getByTestId('map-legend-all')).toHaveTextContent('0')
  })
})