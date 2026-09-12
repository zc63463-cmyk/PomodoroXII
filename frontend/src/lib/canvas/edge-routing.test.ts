import { describe, expect, it } from 'vitest'

import {
  anchorPoint,
  distributeAnchors,
  selectSides,
} from './edge-routing'

const rect = (x: number, y: number, width = 150, height = 42) => ({ x, y, width, height })

describe('selectSides（方向感知，draw.io 的核心）', () => {
  it('target 在右侧 → 出右入左', () => {
    expect(selectSides(rect(0, 0), rect(400, 0))).toEqual({
      sourceSide: 'right', targetSide: 'left',
    })
  })

  it('target 在左侧 → 出左入右（回边不再绕圈）', () => {
    expect(selectSides(rect(400, 0), rect(0, 0))).toEqual({
      sourceSide: 'left', targetSide: 'right',
    })
  })

  it('垂直位移占主导 → 走上下', () => {
    expect(selectSides(rect(0, 0), rect(10, 400))).toEqual({
      sourceSide: 'bottom', targetSide: 'top',
    })
    expect(selectSides(rect(0, 400), rect(10, 0))).toEqual({
      sourceSide: 'top', targetSide: 'bottom',
    })
  })
})

describe('anchorPoint', () => {
  it('左右侧沿高度分布，上下侧沿宽度分布', () => {
    const r = rect(100, 200, 150, 42)
    expect(anchorPoint(r, { side: 'left', fraction: 0.5 })).toEqual({ x: 100, y: 221 })
    expect(anchorPoint(r, { side: 'right', fraction: 0 })).toEqual({ x: 250, y: 200 })
    expect(anchorPoint(r, { side: 'top', fraction: 0.5 })).toEqual({ x: 175, y: 200 })
    expect(anchorPoint(r, { side: 'bottom', fraction: 1 })).toEqual({ x: 250, y: 242 })
  })

  it('clamps 越界的比例', () => {
    expect(anchorPoint(rect(0, 0, 10, 10), { side: 'left', fraction: 2 })).toEqual({ x: 0, y: 10 })
    expect(anchorPoint(rect(0, 0, 10, 10), { side: 'left', fraction: -1 })).toEqual({ x: 0, y: 0 })
  })
})

describe('distributeAnchors（同侧多边按对端位置排序均分）', () => {
  it('按对端中轴排序并均分到 (i+1)/(k+1)', () => {
    const out = distributeAnchors([
      { edgeKey: 'b', otherCenter: 300 },
      { edgeKey: 'a', otherCenter: 100 },
      { edgeKey: 'c', otherCenter: 500 },
    ])
    expect(out).toEqual({ a: 0.25, b: 0.5, c: 0.75 })
  })

  it('单条边落在中点', () => {
    expect(distributeAnchors([{ edgeKey: 'only', otherCenter: 0 }])).toEqual({ only: 0.5 })
  })
})
