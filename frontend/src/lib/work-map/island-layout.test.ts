/**
 * 工作导图几何层（island-layout）—— ADR-0008 D15 步 3-1。
 *
 * 断言锚在**几何可观察量**上：节点盒不重叠、子节点在父的右侧（`dir: right` 数据语义）、
 * 连线数与可见边数一致、会话节点与类型节点可辨识、fail-soft。
 */
import { describe, expect, it, vi } from 'vitest'

import { appendThoughtNode } from './thought-nodes'
import { applyMapNodeEdit, setNodeComment } from './node-edits'
import {
  DESC_LINE_H,
  DESC_MAX_VISIBLE_LINES,
  DESC_PAD_BOTTOM,
  DESC_PAD_TOP,
  ISLAND_TITLE_FONT_SIZE,
  NODE_H_BASE,
  NODE_MIN_W,
  NODE_MAX_W,
  SESSION_HUB_SIZE,
  descBlockGeometry,
  findSessionIslandLayout,
  fitIslandTitleToWidth,
  measureWorkMapNode,
  readWorkMapLayout,
  subIslandVisualBounds,
  WORK_MAP_DEFAULT_ACTIVE_LIMIT,
} from './island-layout'
import { readWorkMapView } from './island-view'
import { buildSessionIsland } from './session-island'
import { astToEditable, parseMm } from '@mindcanvas/kernel'

const SID = 'c766be47-8725-443b-86e3-7cfee648a2f4'

/** 真实产出的岛文件（+ 两个类型节点，模拟快速记录后的形态）。 */
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

const WITH_THOUGHTS = appendThoughtNode(
  appendThoughtNode(BASE, { sessionId: SID, type: 'problem', title: 'token 对照：灰阶 vs 玻璃主题' }).text,
  { sessionId: SID, type: 'todo', title: '写一节"岛的归档策略"草案' },
).text

describe('readWorkMapLayout（几何层）', () => {
  it('★ 岛与节点：根岛 + 会话岛；会话岛含会话根、L3 子节点与两个类型节点', () => {
    const layout = readWorkMapLayout(WITH_THOUGHTS)
    expect(layout).not.toBeNull()
    if (layout === null) return
    expect(layout.islands).toHaveLength(2)

    const island = findSessionIslandLayout(layout, SID)
    expect(island).not.toBeNull()
    if (island === null) return
    expect(island.sourceKind).toBe('promoted')
    expect(island.tree.sessionNode).toBe(true)
    expect(island.nodes.map((node) => node.text)).toEqual([
      '09-30 19:55 会话',
      '测试次一级的workitme',
      'token 对照：灰阶 vs 玻璃主题',
      '写一节"岛的归档策略"草案',
    ])
    expect(island.nodes.map((node) => node.thoughtType)).toEqual([
      null, null, 'problem', 'todo',
    ])
  })

  it('★ 数据语义 dir: right 落到几何：子节点在父的**右侧**、深度递增、盒有效', () => {
    const layout = readWorkMapLayout(WITH_THOUGHTS)
    const island = layout === null ? null : findSessionIslandLayout(layout, SID)
    if (island === null) throw new Error('fixture 解析失败')

    const root = island.tree
    expect(root.depth).toBe(0)
    for (const child of root.children) {
      expect(child.depth).toBe(1)
      expect(child.box.x).toBeGreaterThan(root.box.x) // 右侧生长（dir: right）
      expect(child.box.w).toBeGreaterThanOrEqual(NODE_MIN_W)
      expect(child.box.h).toBeGreaterThan(0)
    }
    // 同级不重叠（纵向排开）
    const ys = root.children.map((child) => child.box.y).sort((a, b) => a - b)
    for (let i = 1; i < ys.length; i += 1) {
      expect(ys[i]).toBeGreaterThan(ys[i - 1])
    }
    expect(island.bounds.maxX).toBeGreaterThan(island.bounds.minX)
    expect(island.bounds.maxY).toBeGreaterThan(island.bounds.minY)
  })

  it('连线：条数 = 岛内可见边数（4 节点 → 3 条），path 非空且两端都在岛内', () => {
    const layout = readWorkMapLayout(WITH_THOUGHTS)
    const island = layout === null ? null : findSessionIslandLayout(layout, SID)
    if (island === null) throw new Error('fixture 解析失败')
    expect(island.links).toHaveLength(3)
    const ids = new Set(island.nodes.map((node) => node.id))
    for (const link of island.links) {
      expect(ids.has(link.fromId)).toBe(true)
      expect(ids.has(link.toId)).toBe(true)
      expect(link.path.length).toBeGreaterThan(0)
    }
  })

  it('度量自持：全角更宽、夹在 [NODE_MIN_W, NODE_MAX_W]、非文本节点不崩', () => {
    const narrow = astToEditable(parseMm('# 根\n\n## a\n')!.root!)!
    const wide = astToEditable(parseMm('# 根\n\n## 很长很长很长很长很长很长很长很长很长很长很长很长的标题\n')!.root!)!
    const narrowChild = narrow.children[0]
    const wideChild = wide.children[0]
    expect(measureWorkMapNode(narrowChild, 1).w).toBeLessThan(measureWorkMapNode(wideChild, 1).w)
    expect(measureWorkMapNode(wideChild, 1).w).toBeLessThanOrEqual(NODE_MAX_W)
    expect(measureWorkMapNode(narrowChild, 1).w).toBeGreaterThanOrEqual(NODE_MIN_W)
  })

  it('fail-soft：空文本 / 无根文档 → null（只记 warn，不抛）', () => {
    expect(readWorkMapLayout('')).toBeNull()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    expect(readWorkMapLayout('<!--\nnote: 无标题\n-->\n')).toBeNull()
    warn.mockRestore()
  })

  it('★ 稳定编辑键 cid：可编辑节点带 cid，存量无 cid 节点为 null（只读；D16-a）', () => {
    const layout = readWorkMapLayout(WITH_THOUGHTS)
    const island = layout === null ? null : findSessionIslandLayout(layout, SID)
    if (island === null) throw new Error('fixture 解析失败')
    // 会话节点 c1；存量 L3 标题行无块 → null；两个快速记录节点 c2 / c3
    expect(island.nodes.map((node) => node.cid)).toEqual(['c1', null, 'c2', 'c3'])
  })

  it('★ 注释 comment：从块内 note 列表读出；无注释节点为 null', () => {
    const withComment = setNodeComment(WITH_THOUGHTS, {
      cid: 'c2',
      comment: ['先确认上游', 'blocked 不能进 post-image'],
    }).text
    const layout = readWorkMapLayout(withComment)
    const island = layout === null ? null : findSessionIslandLayout(layout, SID)
    if (island === null) throw new Error('fixture 解析失败')
    expect(
      island.nodes.find((node) => node.text === 'token 对照：灰阶 vs 玻璃主题')?.comment,
    ).toEqual(['先确认上游', 'blocked 不能进 post-image'])
    expect(
      island.nodes.find((node) => node.text === '写一节"岛的归档策略"草案')?.comment,
    ).toBeNull()
  })

  it('脏值容忍：cid 缺失 / note 非字符串列表 → null（读侧 fail-closed）', () => {
    const dirty = WITH_THOUGHTS.replace(
      '<!--\nthought_type: "problem"\ncid: "c2"\n-->',
      '<!--\nthought_type: "problem"\nnote: 只是标量\n-->',
    )
    const layout = readWorkMapLayout(dirty)
    const island = layout === null ? null : findSessionIslandLayout(layout, SID)
    if (island === null) throw new Error('fixture 解析失败')
    const node = island.nodes.find((item) => item.text === 'token 对照：灰阶 vs 玻璃主题')
    expect(node?.cid).toBeNull()
    expect(node?.comment).toBeNull()
  })
})

/**
 * 会话发端枢纽（Anchor Hub，PXII-FEAT-SESSION-HUB，2026-10-02）—— **几何不变量**。
 *
 * 断言锚：会话岛根盒 = `SESSION_HUB_SIZE` 方盒（不再按标题宽度 clampWidth 撑到 ~150px）、
 * 子节点因岛根变窄而**向左紧凑平移**、连线端点仍精确贴合新盒缘（`islandLinks` 按
 * 平移后世界坐标重建）、非会话节点度量逐位不变（回归面）。
 */
describe('会话发端枢纽：会话岛根紧凑度量（PXII-FEAT-SESSION-HUB）', () => {
  const hubIsland = (text: string) => {
    const layout = readWorkMapLayout(text)
    if (layout === null) throw new Error('fixture 解析失败')
    const island = findSessionIslandLayout(layout, SID)
    if (island === null) throw new Error('会话岛缺失')
    return island
  }

  it('★ SESSION_HUB_SIZE = 28：会话岛根盒恒为 28×28（不随标题长度变化）', () => {
    expect(SESSION_HUB_SIZE).toBe(28)
    const island = hubIsland(WITH_THOUGHTS)
    expect(island.tree.sessionNode).toBe(true)
    expect(island.tree.box.w).toBe(SESSION_HUB_SIZE)
    expect(island.tree.box.h).toBe(SESSION_HUB_SIZE)
    // 收拢前后对比：会话标题 `09-30 19:55 会话` 按普通节点度量会撑到 ~127px
    const editable = astToEditable(parseMm(WITH_THOUGHTS)!.root!)!
    expect(measureWorkMapNode(editable.children[0]!, 1).w).toBeGreaterThan(SESSION_HUB_SIZE)
  })

  it('★ 度量直调：depth 0 + session_id → 28×28；depth 0 无 session_id → 原 clampWidth 逻辑', () => {
    const editable = astToEditable(parseMm(WITH_THOUGHTS)!.root!)!
    const sessionNode = editable.children[0]!
    expect(measureWorkMapNode(sessionNode, 0)).toEqual({ w: 28, h: 28 })
    // 非会话岛根（文档根 = H1 标题）不受影响：仍按文本估算夹在 [NODE_MIN_W, NODE_MAX_W]
    const rootNode = editable
    expect(measureWorkMapNode(rootNode, 0).w).toBeGreaterThanOrEqual(NODE_MIN_W)
    // 同一会话节点若被放在 depth 1（非岛根），不享受枢纽度量（判据含 depth === 0）
    expect(measureWorkMapNode(sessionNode, 1).w).toBeGreaterThan(28)
  })

  it('★ 子节点向左紧凑平移：岛根右缘 + H_GAP(64) = 首列子节点左缘（kernel 排布口径）', () => {
    const island = hubIsland(WITH_THOUGHTS)
    const root = island.tree
    // 所有一级子节点共享同一列（dir: right 的 xEdge 由岛根盒决定）
    const childXs = new Set(root.children.map((child) => child.box.x))
    expect(childXs.size).toBe(1)
    const childX = root.children[0]!.box.x
    expect(childX).toBeGreaterThan(root.box.x + root.box.w) // 仍在右侧生长
    // 收拢前岛根宽 ~127px，收拢后 28px → 子列左移约 99px（只断言方向与间距合理性）
    expect(childX - (root.box.x + root.box.w)).toBeGreaterThanOrEqual(64)
  })

  it('★ 连线两端精确对应：每条线起点 = 岛根右缘中点（hub 边缘），终点 = 子节点左缘中点', () => {
    const island = hubIsland(WITH_THOUGHTS)
    const root = island.tree
    const byId = new Map(island.nodes.map((node) => [node.id, node]))
    // 只查岛根 → 一级子节点的连线（其余边是子节点之间的）
    const rootLinks = island.links.filter((link) => link.fromId === root.id)
    expect(rootLinks).toHaveLength(root.children.length)
    for (const link of rootLinks) {
      const child = byId.get(link.toId)!
      const nums = link.path.match(/-?\d+(?:\.\d+)?/g)!.map(Number)
      // path = `M sx sy C c1x c1y, c2x c2y, ex ey`
      const [sx, sy] = nums
      const [ex, ey] = nums.slice(6, 8)
      expect(sx).toBe(root.box.x + root.box.w) // 起点贴 hub 右缘
      expect(sy).toBe(root.box.y + root.box.h / 2) // 垂直居中于 hub
      expect(ex).toBe(child.box.x) // 终点贴子节点左缘
      expect(ey).toBe(child.box.y + child.box.h / 2)
    }
  })

  it('★ 非会话节点度量逐位不变（回归面）：L1 根岛节点与 L3 子节点仍走 clampWidth', () => {
    const island = hubIsland(WITH_THOUGHTS)
    const stock = island.nodes.find((node) => node.text === '测试次一级的workitme')!
    expect(stock.sessionNode).toBe(false)
    expect(stock.box.w).toBeGreaterThan(SESSION_HUB_SIZE)
    expect(stock.box.w).toBeGreaterThanOrEqual(NODE_MIN_W)
    expect(stock.box.w).toBeLessThanOrEqual(NODE_MAX_W)
  })

  it('★ 脏 session_id（非字符串）不享受枢纽度量（与渲染层 sessionNode 判据同源）', () => {
    const editable = astToEditable(parseMm(WITH_THOUGHTS)!.root!)!
    const sessionNode = editable.children[0]!
    // 直接构造脏值（内核把标量一律读成字符串，故只能在这一层模拟真正的脏 note）
    for (const dirty of [12345, null, ['a', 'b'], { nested: true }] as unknown[]) {
      ;(sessionNode.note as Record<string, unknown>).session_id = dirty
      // 度量与 toTreeNode 同判据（typeof string && !== ''）→ 脏值按普通节点度量
      expect(measureWorkMapNode(sessionNode, 0).w).toBeGreaterThan(SESSION_HUB_SIZE)
    }
    // 良构字符串 → 枢纽（对照组）
    ;(sessionNode.note as Record<string, unknown>).session_id = SID
    expect(measureWorkMapNode(sessionNode, 0)).toEqual({ w: 28, h: 28 })
  })

  it('★ fitIslandTitleToWidth：短标题原样、超长截断补 `…`、宽度不足返回空串', () => {
    const short = '09-30 19:55 会话'
    expect(fitIslandTitleToWidth(short, 400)).toBe(short)
    const long = '这是一个特别特别特别特别特别特别长的会话标题需要被截断处理'
    const fitted = fitIslandTitleToWidth(long, 80)
    expect(fitted.endsWith('…')).toBe(true)
    expect(fitted.length).toBeLessThan(long.length)
    // 空标题 / 零宽 → 原样返回空串（渲染层用「（无标题会话）」占位）
    expect(fitIslandTitleToWidth('', 80)).toBe('')
    expect(fitIslandTitleToWidth(short, 0)).toBe('')
    // 字号是**显式参数**（与渲染层 fontSize 同源），换档位可得到不同截断结果
    expect(fitIslandTitleToWidth(long, 80, ISLAND_TITLE_FONT_SIZE)).toBe(fitted)
  })
})

/**
 * 幕布描述块（PXII-FEAT-DESC-BLOCK，2026-10-01）—— **几何不变量**。
 *
 * 断言锚：`measureWorkMapNode` 的高度公式、`layoutIslands` 产出的 `nodes[].box`
 * 真的持有该高度、以及**兄弟节点不重叠**（描述撑高后仍按 `V_GAP` 堆叠）。
 * 度量不预留 = 描述文字画出盒外压住邻居，是本次修复的核心回归面。
 */
describe('幕布描述块：动态节点高度与宽度（PXII-FEAT-DESC-BLOCK）', () => {
  /** 三个同级可编辑节点（c2/c3/c4），用于验证撑高后的兄弟堆叠。 */
  const SIBLINGS = `<!--
next_cid: 4
centers:
  - at: "node:描述测试/10-01 20:00 会话"
    cid: c1
    dir: right
    session_id: "${SID}"
-->
# 描述测试

<!--
cid: "c1"
session_id: "${SID}"
-->
## 10-01 20:00 会话

<!--
cid: "c2"
-->
### 甲

<!--
cid: "c3"
-->
### 乙

<!--
cid: "c4"
-->
### 丙
`

  const nodeOf = (text: string, cid: string) => {
    const layout = readWorkMapLayout(text)
    const island = layout === null ? null : findSessionIslandLayout(layout, SID)
    if (island === null) throw new Error('fixture 解析失败')
    const node = island.nodes.find((item) => item.cid === cid)
    if (node === undefined) throw new Error(`节点 ${cid} 不存在`)
    return { node, island }
  }

  it('★ 无注释节点高度恒为 NODE_H_BASE（28px）', () => {
    const editable = astToEditable(parseMm(SIBLINGS)!.root!)!
    // 直接度量（kernel MeasureFn 口径）：无 note → 基础高度
    const measured = measureWorkMapNode(editable.children[0]!.children[0]!, 1)
    expect(measured.h).toBe(NODE_H_BASE)
    expect(measured.h).toBe(28)
    // 布局产出同口径
    const { node } = nodeOf(SIBLINGS, 'c2')
    expect(node.box.h).toBe(28)
    expect(node.comment).toBeNull()
  })

  it('★ 2 行注释 → 盒高显著增大（≥ 46px）且等于公式值', () => {
    const text = setNodeComment(SIBLINGS, { cid: 'c2', comment: ['第一行注释', '第二行注释'] }).text
    const { node } = nodeOf(text, 'c2')
    // 公式：28 + 4 + 2 × 14 + 4 = 64
    expect(node.box.h).toBe(28 + 4 + 2 * 14 + 4)
    expect(node.box.h).toBeGreaterThanOrEqual(46)
    // 兄弟节点高度不变（撑高只作用于带注释的那个）
    expect(nodeOf(text, 'c3').node.box.h).toBe(28)
  })

  it('★ 行数上限：超过 DESC_MAX_VISIBLE_LINES 的注释不再撑高（全文走 tooltip）', () => {
    const five = setNodeComment(SIBLINGS, {
      cid: 'c2',
      comment: ['一', '二', '三', '四', '五'],
    }).text
    const three = setNodeComment(SIBLINGS, { cid: 'c2', comment: ['一', '二', '三'] }).text
    // 5 行与 3 行同高：可见行数封顶在 3
    expect(nodeOf(five, 'c2').node.box.h).toBe(nodeOf(three, 'c2').node.box.h)
    expect(nodeOf(five, 'c2').node.box.h).toBe(28 + 4 + 3 * 14 + 4)
    // 注释内容本身不截断（读侧保真：5 行原样在树里，只是渲染层只画 3 行）
    expect(nodeOf(five, 'c2').node.comment).toHaveLength(5)
  })

  it('★ 长文本注释 → 盒宽在 [NODE_MIN_W, NODE_MAX_W] 内合理扩宽', () => {
    const longLine = '这是一条特别特别特别特别特别特别特别特别特别长的注释行用来测试宽度扩展行为'
    const text = setNodeComment(SIBLINGS, { cid: 'c2', comment: [longLine] }).text
    const wide = nodeOf(text, 'c2').node.box.w
    const narrow = nodeOf(SIBLINGS, 'c2').node.box.w
    expect(wide).toBeGreaterThan(narrow) // 描述比标题长 → 横向撑开
    expect(wide).toBeLessThanOrEqual(NODE_MAX_W) // 但夹在 MAX_W
    expect(wide).toBeGreaterThanOrEqual(NODE_MIN_W)
    // 描述比标题短时不影响宽度（取二者较大者）
    const short = setNodeComment(SIBLINGS, { cid: 'c2', comment: ['短'] }).text
    expect(nodeOf(short, 'c2').node.box.w).toBe(narrow)
  })

  it('★ 兄弟不重叠（几何不变量）：撑高后仍按 V_GAP 堆叠，无盒交叠', () => {
    let text = setNodeComment(SIBLINGS, {
      cid: 'c2',
      comment: ['第一行注释', '第二行注释', '第三行注释'],
    }).text
    text = setNodeComment(text, { cid: 'c3', comment: ['乙的注释'] }).text
    const { island } = nodeOf(text, 'c2')
    const siblings = island.nodes
      .filter((item) => item.cid !== null && ['c2', 'c3', 'c4'].includes(item.cid))
      .sort((a, b) => a.box.y - b.box.y)
    expect(siblings).toHaveLength(3)
    for (let i = 0; i + 1 < siblings.length; i += 1) {
      const above = siblings[i]!
      const below = siblings[i + 1]!
      // 上盒底 ≤ 下盒顶（同一 x 列上严格不相交）
      expect(below.box.y).toBeGreaterThanOrEqual(above.box.y + above.box.h)
    }
  })

  it('★ 清空注释后提交 → 盒高收缩回 28px（内容驱动，不是一次性标记）', () => {
    const withComment = setNodeComment(SIBLINGS, {
      cid: 'c2',
      comment: ['一行', '两行'],
    }).text
    expect(nodeOf(withComment, 'c2').node.box.h).toBeGreaterThan(28)

    const cleared = applyMapNodeEdit(withComment, { kind: 'comment', cid: 'c2', comment: null }).text
    const { node } = nodeOf(cleared, 'c2')
    expect(node.comment).toBeNull()
    expect(node.box.h).toBe(28)
    // 清空只动目标块的 note 组：其余正文逐字节保留（D16-b）
    expect(cleared).toContain('### 甲')
    expect(cleared).toContain('cid: "c3"')
  })

  it('★ descBlockGeometry：度量与渲染同源（高度 / 可见行数 / 竖线端点一致）', () => {
    const geo = descBlockGeometry(['a', 'b'], 64)
    expect(geo).not.toBeNull()
    expect(geo!.height).toBe(64) // 与 measureWorkMapNode 的公式逐位相同
    expect(geo!.lineCount).toBe(2)
    expect(geo!.barTop).toBe(NODE_H_BASE + DESC_PAD_TOP)
    expect(geo!.barBottom).toBe(64 - DESC_PAD_BOTTOM)
    // 基线逐行递增 DESC_LINE_H（行距恒定，不随层级差分）
    expect(geo!.baselineOf(1) - geo!.baselineOf(0)).toBe(DESC_LINE_H)
    // 无描述 → null（渲染层据此不画竖线）
    expect(descBlockGeometry(null, 28)).toBeNull()
    expect(descBlockGeometry([], 28)).toBeNull()
  })
})

/**
 * 近 N 展开 + 历史归档岛（ADR-0008 D19-a，2026-10-01）。
 *
 * 断言锚在**切片可观察量**上：默认正好 5 个会话岛 + 1 个归档岛（archivedCount === 15）、
 * 展开的是**最新** 5 个、expandAll 时 20 岛全量、归档岛在展开岛左侧、
 * **零副作用**（红线：`.mm.md` 原文逐字节不变，历史 centers 与节点全部保留）。
 */
describe('近 N 展开 + 历史归档岛（D19-a：纯视图层投影切片）', () => {
  const TOTAL = 20
  const ALL_SIDS = Array.from(
    { length: TOTAL },
    (_, i) => `s4-archive-${String(i + 1).padStart(2, '0')}`,
  )

  /** 20 个会话岛（用真实建岛写入器逐次追加；每岛 = 会话根 + 1 个 L3 子节点）。 */
  const MANY = (() => {
    let text = ''
    for (let i = 0; i < TOTAL; i += 1) {
      const result = buildSessionIsland(text, {
        sessionId: ALL_SIDS[i],
        workItemTitle: '归档切片测试工作项',
        sessionTitle: `10-${String(i + 1).padStart(2, '0')} 10:00 会话`,
        level3Titles: [`任务 ${i + 1}`],
      })
      if (!result.changed) throw new Error(`fixture 构建失败：${result.reason}`)
      text = result.text
    }
    return text
  })()

  it('★ 默认（近 5）：正好 5 个会话岛 + 1 个归档岛（archivedCount === 15），展开的是最新 5 个', () => {
    expect(WORK_MAP_DEFAULT_ACTIVE_LIMIT).toBe(5)
    const layout = readWorkMapLayout(MANY)
    expect(layout).not.toBeNull()
    if (layout === null) return

    const sessionIslands = layout.islands.filter(
      (island) => !island.isArchive && island.sessionId !== null,
    )
    const archive = layout.islands.find((island) => island.isArchive === true)

    // 根岛 1 + 活跃会话岛 5 + 归档岛 1
    expect(layout.islands).toHaveLength(7)
    expect(sessionIslands).toHaveLength(5)
    // 收进展开视图的是**文档时序最新**的 5 个会话
    expect(sessionIslands.map((island) => island.sessionId)).toEqual(ALL_SIDS.slice(-5))
    expect(archive?.archivedCount).toBe(15)
    expect(archive?.sessionId).toBeNull()
    expect(archive?.sourceKind).toBe('archive')
    // 归档岛 = 一张收拢卡片：历史节点不展开（只有卡自身）
    expect(archive?.nodes).toHaveLength(1)
    expect(archive?.links).toHaveLength(0)
    // 活跃岛内容完整（会话根 + 任务）
    for (const island of sessionIslands) expect(island.nodes).toHaveLength(2)
  })

  it('★ expandAll: true → 20 个独立会话岛、无归档岛', () => {
    const layout = readWorkMapLayout(MANY, { expandAll: true })
    expect(layout).not.toBeNull()
    if (layout === null) return
    const sessionIslands = layout.islands.filter((island) => island.sessionId !== null)
    expect(sessionIslands).toHaveLength(20)
    expect(sessionIslands.map((island) => island.sessionId)).toEqual(ALL_SIDS)
    expect(layout.islands.some((island) => island.isArchive === true)).toBe(false)
  })

  it('★ activeLimit 可调：activeLimit 3 → 3 个活跃岛 + archivedCount 17', () => {
    const layout = readWorkMapLayout(MANY, { activeLimit: 3 })
    expect(layout).not.toBeNull()
    if (layout === null) return
    const sessionIslands = layout.islands.filter(
      (island) => !island.isArchive && island.sessionId !== null,
    )
    expect(sessionIslands).toHaveLength(3)
    expect(sessionIslands.map((island) => island.sessionId)).toEqual(ALL_SIDS.slice(-3))
    const archive = layout.islands.find((island) => island.isArchive === true)
    expect(archive?.archivedCount).toBe(17)
  })

  it('★ 会话岛 ≤ activeLimit 时不产生归档岛（1 会话文档）', () => {
    const layout = readWorkMapLayout(WITH_THOUGHTS)
    expect(layout?.islands.some((island) => island.isArchive === true)).toBe(false)
  })

  it('★ 归档岛排布在全部展开岛（含根岛）的左侧且无重叠', () => {
    const layout = readWorkMapLayout(MANY)
    if (layout === null) throw new Error('fixture 解析失败')
    const archive = layout.islands.find((island) => island.isArchive === true)
    if (archive === undefined) throw new Error('归档岛缺失')
    const leftmostOfExpanded = Math.min(
      ...layout.islands.filter((island) => !island.isArchive).map((island) => island.bounds.minX),
    )
    expect(archive.bounds.maxX).toBeLessThan(leftmostOfExpanded)
  })

  it('★ 零副作用（红线）：原文逐字节不变、20 个 centers 条目与 session_id 全部保留、结构层仍读出 21 个岛', () => {
    const before = MANY
    readWorkMapLayout(before)
    readWorkMapLayout(before, { expandAll: true })
    // 字符串不可变，这里断言的是"读侧没有借输出通道回写"的语义承诺
    expect(MANY).toBe(before)
    // 每个会话的 session_id 恰好两处同写（centers 条目 + 节点笔记块）原样保留
    for (const sid of ALL_SIDS) {
      expect(before.match(new RegExp(`session_id: "${sid}"`, 'g'))).toHaveLength(2)
    }
    // 根块 centers 条目 20 条原样保留
    expect(before.match(/^  - at: /gm)).toHaveLength(20)
    // 结构层（island-view，不切片）仍看到根岛 + 20 会话岛 —— 事实源未被改写
    const view = readWorkMapView(before)
    expect(view?.islands).toHaveLength(21)
  })
})

describe('嵌套子岛（MapSubIsland）', () => {
  it('★ 会话岛自动聚合 L3 任务子岛（每个一级子节点为一个子岛，含其全部后代节点）', () => {
    const fixture = `<!--
centers:
  - at: "node:根/会话"
    cid: c1
    session_id: "${SID}"
-->
# 根

<!--
cid: "c1"
session_id: "${SID}"
-->
## 会话

### L3任务一

#### 思考A

#### 思考B

### L3任务二
`
    const layout = readWorkMapLayout(fixture)
    const island = layout === null ? null : findSessionIslandLayout(layout, SID)
    expect(island).not.toBeNull()
    expect(island?.subIslands).toBeDefined()
    expect(island?.subIslands).toHaveLength(2)

    const sub1 = island!.subIslands![0]
    expect(sub1.title).toBe('L3任务一')
    expect(sub1.nodes).toHaveLength(3)
    expect(sub1.nodes.map((n) => n.text)).toEqual(['L3任务一', '思考A', '思考B'])

    const sub2 = island!.subIslands![1]
    expect(sub2.title).toBe('L3任务二')
    expect(sub2.nodes).toHaveLength(1)
    expect(sub2.nodes.map((n) => n.text)).toEqual(['L3任务二'])

    // 包围盒严格包围子树全部节点
    expect(sub1.bounds.minX).toBeLessThanOrEqual(sub1.rootNode.box.x)
    expect(sub1.bounds.maxX).toBeGreaterThanOrEqual(sub1.rootNode.box.x + sub1.rootNode.box.w)

    // 视觉包围盒按安全 padding 扩展
    const visual = subIslandVisualBounds(sub1)
    expect(visual.minX).toBe(sub1.bounds.minX - 10)
    expect(visual.minY).toBe(sub1.bounds.minY - 18)
    expect(visual.maxX).toBe(sub1.bounds.maxX + 12)
    expect(visual.maxY).toBe(sub1.bounds.maxY + 10)

    // 聚焦态包围盒按更大安全内边距扩展（预留顶栏地标标题与底部返回胶囊）
    const focusedVisual = subIslandVisualBounds(sub1, true)
    expect(focusedVisual.minX).toBe(sub1.bounds.minX - 14)
    expect(focusedVisual.minY).toBe(sub1.bounds.minY - 30)
    expect(focusedVisual.maxX).toBe(sub1.bounds.maxX + 16)
    expect(focusedVisual.maxY).toBe(sub1.bounds.maxY + 30)
  })
})
