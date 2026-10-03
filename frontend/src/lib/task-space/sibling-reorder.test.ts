import { describe, expect, it } from 'vitest'
import { siblingReorderRank } from './sibling-reorder'

const row = (id: string, childRank: number) => ({ id, childRank })

describe('siblingReorderRank', () => {
  it('computes the before-insertion index among siblings without the dragged row', () => {
    const siblings = [row('a', 0), row('b', 1), row('c', 2)]
    // 拖 a 到 b 之前：去掉 a 后序列 [b, c]，b 位次 0。
    expect(siblingReorderRank(siblings, 'a', 'b', 'before')).toBe(0)
    // 拖 c 到 a 之前：去掉 c 后序列 [a, b]，a 位次 0。
    expect(siblingReorderRank(siblings, 'c', 'a', 'before')).toBe(0)
  })

  it('shifts the target index when the dragged row sat before it', () => {
    const siblings = [row('a', 0), row('b', 1), row('c', 2)]
    // 拖 a 到 c 之后：去掉 a 后 [b, c]，c 位次 1 → after = 2。
    expect(siblingReorderRank(siblings, 'a', 'c', 'after')).toBe(2)
    // 拖 c 到 a 之后：去掉 c 后 [a, b]，a 位次 0 → after = 1。
    expect(siblingReorderRank(siblings, 'c', 'a', 'after')).toBe(1)
  })

  it('is order-input agnostic: ranks win, id breaks ties', () => {
    // 与读侧 ORDER BY(child_rank, id) 一致：乱序输入不影响结果。
    const shuffled = [row('c', 2), row('a', 0), row('b', 1)]
    expect(siblingReorderRank(shuffled, 'c', 'a', 'before')).toBe(0)
    expect(siblingReorderRank(shuffled, 'a', 'b', 'after')).toBe(1)
    const tied = [row('b', 5), row('a', 5)]
    expect(siblingReorderRank(tied, 'a', 'b', 'before')).toBe(0)
  })

  it('works after a cross-parent move where the dragged row sits at the end', () => {
    // move 已把 dragged append 到目标父末尾：去掉它不影响 target 位次。
    const siblingsAfterMove = [row('t1', 0), row('t2', 1), row('moved', 2)]
    expect(siblingReorderRank(siblingsAfterMove, 'moved', 't1', 'before')).toBe(0)
    expect(siblingReorderRank(siblingsAfterMove, 'moved', 't1', 'after')).toBe(1)
    expect(siblingReorderRank(siblingsAfterMove, 'moved', 't2', 'after')).toBe(2)
  })

  it('falls back to append when the target is unknown or is the dragged row', () => {
    const siblings = [row('a', 0), row('b', 1)]
    expect(siblingReorderRank(siblings, 'a', 'missing', 'before')).toBe(1)
    expect(siblingReorderRank(siblings, 'a', 'a', 'after')).toBe(1)
  })
})
