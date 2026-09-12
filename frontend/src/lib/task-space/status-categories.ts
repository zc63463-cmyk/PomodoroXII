import type { TaskSpaceDefinitions } from '@/lib/contracts/task-space'

/**
 * ``workItemId → status category`` 查表（Space 作用域定义，绝不硬编码）。
 *
 * ★ 依赖域的一切派生（blocked / waiting 恢复建议 / 会话启动判定）都要用它，
 *   而且**任务页与计时页必须用同一份** —— 否则同一条规则会在两处漂移，
 *   这正是 /timer 曾经漏掉 blocked 判定的结构性原因。
 */
export function deriveStatusCategoryById(
  definitions: TaskSpaceDefinitions | null | undefined,
  workItems: ReadonlyArray<{ id: string; statusDefinitionId: string }>,
): Record<string, string | undefined> {
  const categoryByStatusId = new Map<string, string | undefined>()
  for (const status of definitions?.statuses ?? []) {
    const record = status as Record<string, unknown>
    categoryByStatusId.set(
      String(record.id),
      typeof record.category === 'string' ? record.category : undefined,
    )
  }
  const result: Record<string, string | undefined> = {}
  for (const item of workItems) {
    result[item.id] = categoryByStatusId.get(item.statusDefinitionId)
  }
  return result
}
