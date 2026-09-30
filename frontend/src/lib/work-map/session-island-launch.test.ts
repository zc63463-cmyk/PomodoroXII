import { describe, expect, it, vi } from 'vitest'

import { hasSessionIsland } from './session-island'
import {
  createLaunchSessionIslands,
  formatSessionIslandTitle,
  type LaunchSessionIslandDeps,
} from './session-island-launch'

const WORK_ITEMS = [
  { id: 'l3-a', title: '体验：卡点分析记录' },
  { id: 'l3-b', title: '探索小窗实现方式' },
]

/** 记录所有读写的假 IO；初始文本可按 workItemId 预置。 */
function fakeIo(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial))
  const reads: string[] = []
  const writes: { workItemId: string; text: string }[] = []
  const deps: LaunchSessionIslandDeps = {
    readWorkMap: vi.fn(async (id: string) => {
      reads.push(id)
      return store.has(id) ? (store.get(id) as string) : null
    }),
    writeWorkMap: vi.fn(async (id: string, text: string) => {
      writes.push({ workItemId: id, text })
      store.set(id, text)
    }),
    onWarn: vi.fn(),
  }
  return { store, reads, writes, deps }
}

const BASE_INPUT = {
  sessionId: 'sess-1',
  startedAt: new Date(2026, 8, 30, 21, 50).toISOString(),
  level3WorkItemIds: ['l3-a'],
  workItems: WORK_ITEMS,
}

describe('createLaunchSessionIslands（会话启动建岛，ADR-0008 S2 收口）', () => {
  it('尚无导图：为选中的 L3 建出新文档（H1 + 会话节点 + 岛条目）', async () => {
    const { writes, deps } = fakeIo()

    const outcome = await createLaunchSessionIslands(BASE_INPUT, deps)

    expect(outcome.created).toEqual(['l3-a'])
    expect(outcome.failed).toEqual([])
    expect(writes).toHaveLength(1)
    const text = writes[0].text
    expect(writes[0].workItemId).toBe('l3-a')
    expect(text).toContain('# 体验：卡点分析记录')
    expect(text).toContain('## 09-30 21:50 会话')
    expect(text).toContain('centers:')
    expect(text).toContain('session_id: "sess-1"')
    // 幂等判定自洽：写出的文本里带着"该会话已有岛"
    expect(hasSessionIsland(text, 'sess-1')).toBe(true)
  })

  it('已有导图：原样保留既有正文与岛，只追加本次会话岛', async () => {
    const existing = [
      '<!--',
      'next_cid: c1',
      'centers:',
      '  - at: "node:体验：卡点分析记录/09-29 10:00 会话"',
      '    cid: c1',
      '    session_id: sess-old',
      '-->',
      '# 体验：卡点分析记录',
      '',
      '<!--',
      'cid: c1',
      'note:',
      '  - 旧会话的一条结论',
      '-->',
      '## 09-29 10:00 会话',
      '',
      '### 旧计划项',
      '',
    ].join('\n')
    const { writes, deps } = fakeIo({ 'l3-a': existing })

    const outcome = await createLaunchSessionIslands(BASE_INPUT, deps)

    expect(outcome.created).toEqual(['l3-a'])
    const text = writes[0].text
    // 旧内容零丢失
    expect(text).toContain('旧会话的一条结论')
    expect(text).toContain('## 09-29 10:00 会话')
    expect(hasSessionIsland(text, 'sess-old')).toBe(true)
    // 新岛也在了
    expect(hasSessionIsland(text, 'sess-1')).toBe(true)
  })

  it('幂等：同一会话重复调用不产生第二次写（skip 原因 = session_island_exists）', async () => {
    const { writes, deps } = fakeIo()

    await createLaunchSessionIslands(BASE_INPUT, deps)
    const second = await createLaunchSessionIslands(BASE_INPUT, deps)

    expect(writes).toHaveLength(1)
    expect(second.created).toEqual([])
    expect(second.skipped).toEqual([
      { workItemId: 'l3-a', reason: 'session_island_exists' },
    ])
  })

  it('多 L3：每个被选中的 L3 各建一个岛，岛内计划项列表一致', async () => {
    const { writes, deps } = fakeIo()

    const outcome = await createLaunchSessionIslands(
      { ...BASE_INPUT, level3WorkItemIds: ['l3-a', 'l3-b'] },
      deps,
    )

    expect(outcome.created).toEqual(['l3-a', 'l3-b'])
    expect(writes.map((w) => w.workItemId)).toEqual(['l3-a', 'l3-b'])
    for (const write of writes) {
      // 本次全部计划项都作为会话节点子树写入（两张图口径一致）
      expect(write.text).toContain('### 体验：卡点分析记录')
      expect(write.text).toContain('### 探索小窗实现方式')
    }
  })

  it('未选 L3（休息接续）：不读也不写（没有绑定目标）', async () => {
    const { reads, writes, deps } = fakeIo()

    const outcome = await createLaunchSessionIslands(
      { ...BASE_INPUT, level3WorkItemIds: [] },
      deps,
    )

    expect(outcome).toEqual({ created: [], skipped: [], failed: [] })
    expect(reads).toEqual([])
    expect(writes).toEqual([])
  })

  it('查不到标题的工作项：跳过该图，绝不编造标题', async () => {
    const { writes, deps } = fakeIo()

    const outcome = await createLaunchSessionIslands(
      { ...BASE_INPUT, level3WorkItemIds: ['l3-a', 'l3-ghost'] },
      deps,
    )

    expect(outcome.created).toEqual(['l3-a'])
    expect(outcome.skipped).toEqual([
      { workItemId: 'l3-ghost', reason: 'work_item_title_missing' },
    ])
    expect(writes.map((w) => w.workItemId)).toEqual(['l3-a'])
  })

  it('读失败 fail-soft：该图记 failed、其余图照常、不抛异常', async () => {
    const { writes, deps } = fakeIo()
    deps.readWorkMap = vi.fn(async (id: string) => {
      if (id === 'l3-a') throw new Error('network down')
      return null
    })

    const outcome = await createLaunchSessionIslands(
      { ...BASE_INPUT, level3WorkItemIds: ['l3-a', 'l3-b'] },
      deps,
    )

    expect(outcome.failed).toEqual([{ workItemId: 'l3-a', reason: 'network down' }])
    expect(outcome.created).toEqual(['l3-b'])
    expect(writes.map((w) => w.workItemId)).toEqual(['l3-b'])
    expect(deps.onWarn).toHaveBeenCalledTimes(1)
  })

  it('写失败 fail-soft：记 failed、不抛异常（会话闭环不受影响）', async () => {
    const { deps } = fakeIo()
    deps.writeWorkMap = vi.fn(async () => {
      throw new Error('413 too large')
    })

    const outcome = await createLaunchSessionIslands(BASE_INPUT, deps)

    expect(outcome.failed).toEqual([{ workItemId: 'l3-a', reason: '413 too large' }])
    expect(outcome.created).toEqual([])
  })

  it('sessionId 缺失：不读不写，skip 记录原因（不抛）', async () => {
    const { reads, deps } = fakeIo()

    const outcome = await createLaunchSessionIslands(
      { ...BASE_INPUT, sessionId: '   ' },
      deps,
    )

    expect(reads).toEqual([])
    expect(outcome.skipped).toEqual([{ workItemId: '', reason: 'missing_session_id' }])
  })

  it('重复勾选同一 L3（脏输入）：去重后只写一次', async () => {
    const { writes, deps } = fakeIo()

    await createLaunchSessionIslands(
      { ...BASE_INPUT, level3WorkItemIds: ['l3-a', 'l3-a'] },
      deps,
    )

    expect(writes).toHaveLength(1)
  })
})

describe('formatSessionIslandTitle', () => {
  it('本地时间格式化为 MM-DD HH:mm 会话', () => {
    expect(formatSessionIslandTitle(new Date(2026, 8, 30, 21, 50))).toBe('09-30 21:50 会话')
    expect(formatSessionIslandTitle(new Date(2026, 0, 5, 9, 5))).toBe('01-05 09:05 会话')
  })
})
