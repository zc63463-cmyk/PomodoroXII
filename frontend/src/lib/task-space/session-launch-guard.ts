import type { CachedRelation } from '@/lib/contracts/task-space'

import { computeIsBlocked, selectOpenBlockers } from './relation-selectors'

/**
 * 会话启动判定 —— 唯一入口。
 *
 * ★ 为什么要有这个模块：此前同一规则分散在两个执行点 —— 任务页按钮拦截、
 *   ``/timer`` 完全不检查 —— 于是拦截拦不住（确认后无承接）、能启动的入口
 *   不设防。任何启动路径都必须调用这里，而不是各自拼 ``isBlocked``。
 * ★ 规则本身只有一条：二级项 + 存在未完成上游 ⇒ 需显式确认（``blocked``）。
 *   调用方拿到 ``blocked`` 后弹 BlockerAck；用户确认（或已有一次性放行）
 *   才真正启动。一级 / 三级不判定（容器与不计时项，与 ``computeIsBlocked`` 同源）。
 */
export interface SessionLaunchDecision {
  status: 'allowed' | 'blocked'
  /** 未完成上游 id（仅 blocked 时非空，用于确认弹窗列表）。 */
  openBlockerIds: string[]
}

export function evaluateSessionLaunch(input: {
  level2WorkItemId: string
  workItems: ReadonlyArray<{ id: string; depth: number }>
  relations: readonly CachedRelation[]
  statusCategoryById: Readonly<Record<string, string | undefined>>
}): SessionLaunchDecision {
  const item = input.workItems.find((candidate) => candidate.id === input.level2WorkItemId)
  const openBlockerIds = selectOpenBlockers(
    input.relations,
    input.level2WorkItemId,
    input.statusCategoryById,
  )
  // 深度未知（未水合）时按 1 处理：无法确认是二级项就不能断言阻塞 ——
  // 判定必须是"证明阻塞"，不是"没证明就不阻塞"的反面。
  const blocked = computeIsBlocked(item?.depth ?? 1, openBlockerIds.length > 0)
  return blocked
    ? { status: 'blocked', openBlockerIds }
    : { status: 'allowed', openBlockerIds: [] }
}
