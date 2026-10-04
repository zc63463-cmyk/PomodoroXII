/**
 * 快速记录写侧（appendThoughtNode）—— 协议可观察行为断言（ADR-0008 D13 步 2）。
 *
 * 断言锚在**写入形状**上（笔记块归属其后的节点、层级 = 会话 + 1、落在会话子树末尾、
 * 其余正文逐字节保留、fail 语义），并含一条**写读闭环**（append → readWorkMapView）。
 */
import { describe, expect, it } from 'vitest'

import { findSessionIsland, readWorkMapView } from './island-view'
import { appendThoughtNode } from './thought-nodes'

const SID = 'c766be47-8725-443b-86e3-7cfee648a2f4'

/** 本项目真实产出的岛文件（与 island-view 测试同一 fixture）。 */
const ISLAND = `<!--
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

/**
 * D16 演进后的期望根块：新节点带 `cid` 行，且根块 `next_cid` 被**定向推进**（2 → 3）
 * —— 与建岛共用同一计数器，避免跨会话 cid 撞车（见 node-edits.ts 头注）。
 * §2「唯一允许的断言变化 = 追加形状多了 cid 行」在此**显式放宽**（已授权）：
 * 例1 的 `toBe` 因此同时多出 cid 行与 next_cid 两处。
 */
const ROOT_AFTER_ONE_APPEND = ISLAND.trimEnd().replace('next_cid: 2', 'next_cid: 3')

describe('appendThoughtNode（快速记录写侧）', () => {
  it('★ 写入形状：笔记块（thought_type + cid）在前、子标题在后，落在会话子树末尾；其余正文逐字节保留', () => {
    const result = appendThoughtNode(ISLAND, {
      sessionId: SID,
      type: 'problem',
      title: 'token 对照：灰阶 vs 玻璃主题',
    })
    expect(result.changed).toBe(true)
    expect(result.text).toBe(
      `${ROOT_AFTER_ONE_APPEND}\n\n<!--\nthought_type: "problem"\ncid: "c2"\n-->\n### token 对照：灰阶 vs 玻璃主题\n`,
    )
  })

  it('多次追加保持时序（新节点总在最后）', () => {
    const first = appendThoughtNode(ISLAND, { sessionId: SID, type: 'insight', title: '第一' })
    const second = appendThoughtNode(first.text, { sessionId: SID, type: 'todo', title: '第二' })
    expect(second.changed).toBe(true)
    expect(second.text.indexOf('### 第一')).toBeLessThan(second.text.indexOf('### 第二'))
    // 只追加不重写：第一次的块原样在位（D16：块内多出 cid 行）
    expect(second.text).toContain('<!--\nthought_type: "insight"\ncid: "c2"\n-->\n### 第一')
  })

  it('标题压平：换行/制表符 → 空格（标题不能把 heading 行撑破）', () => {
    const result = appendThoughtNode(ISLAND, {
      sessionId: SID,
      type: 'decision',
      title: '  导图\n不随沉浸渐隐\t改为极简岛  ',
    })
    expect(result.text).toContain('### 导图 不随沉浸渐隐 改为极简岛')
  })

  it('fail-closed：类型非法 / 空标题 / 缺 sessionId → 原样返回 + reason', () => {
    const bad = appendThoughtNode(ISLAND, {
      sessionId: SID,
      // @ts-expect-error 故意传入非法类型（运行期守卫）
      type: 'unknown_type',
      title: 'x',
    })
    expect(bad.changed).toBe(false)
    expect(bad.reason).toBe('invalid_thought_type')
    expect(bad.text).toBe(ISLAND)

    const empty = appendThoughtNode(ISLAND, { sessionId: SID, type: 'insight', title: '   ' })
    expect(empty.reason).toBe('empty_title')

    const noSession = appendThoughtNode(ISLAND, { sessionId: '  ', type: 'insight', title: 'x' })
    expect(noSession.reason).toBe('missing_session_id')
  })

  it('fail-soft：找不到会话节点 / 无 H1 → 原样返回，绝不猜测改别处', () => {
    const missing = appendThoughtNode(ISLAND, {
      sessionId: 'not-a-session',
      type: 'insight',
      title: 'x',
    })
    expect(missing.changed).toBe(false)
    expect(missing.reason).toBe('session_node_not_found')
    expect(missing.text).toBe(ISLAND)

    const noRoot = appendThoughtNode('<!--\nnote: 无 H1\n-->\n', {
      sessionId: SID,
      type: 'insight',
      title: 'x',
    })
    expect(noRoot.changed).toBe(false)
    expect(noRoot.text).toBe('<!--\nnote: 无 H1\n-->\n')
  })

  it('★ 写读闭环：append 后经 readWorkMapView 读回，节点带 thoughtType 与文本', () => {
    const appended = appendThoughtNode(ISLAND, {
      sessionId: SID,
      type: 'todo',
      title: '写一节"岛的归档策略"草案',
    })
    const view = readWorkMapView(appended.text)
    expect(view).not.toBeNull()
    if (view === null) return
    const island = findSessionIsland(view, SID)
    expect(island).not.toBeNull()
    const node = island?.nodes.find((item) => item.text === '写一节"岛的归档策略"草案')
    expect(node?.thoughtType).toBe('todo')
    // 会话/根块不受影响
    expect(view.diagnostics).toEqual([])
    expect(island?.nodes[0]?.text).toBe('09-30 19:55 会话')
  })

  it('非法类型值不落盘（写侧已拒；读侧对脏数据也 fail-closed → null）', () => {
    const dirty = ISLAND.replace(
      '### 测试次一级的workitme',
      '<!--\nthought_type: "bogus"\n-->\n### 测试次一级的workitme',
    )
    const view = readWorkMapView(dirty)
    const island = view === null ? null : findSessionIsland(view, SID)
    const node = island?.nodes.find((item) => item.text === '测试次一级的workitme')
    expect(node?.thoughtType).toBeNull()
  })
})
