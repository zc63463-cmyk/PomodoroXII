import { useTaskSpaceStore } from '@/stores/task-space-store'

/**
 * ★ 2026-09-11 复盘闭环收尾（补两个断点）：
 *   ① 复盘提交成功后不刷任务空间 —— 服务端把「投入」物化后经 sync pull 写进
 *      本地表，但 store 里的 workItems 还是提交前的快照，新投入要等下一轮同步
 *      才可见；这里在提交成功后立刻重读本地缓存。
 *   ② 复盘完成态没有出口 —— 会话已终态、面板只读，用户只能靠浏览器后退离开；
 *      这里给出「返回任务空间」所需的动作（选中本会话挂的二级项 + 回任务页）。
 *
 * 把「提交成功之后做什么」从页面里抽出来，是为了让决策与副作用边界能被单测
 * 直接钉住（page 级测试要拖整个 Dexie / 会话协调器，成本过高）。
 *
 * 语义约束（不得改动）：复盘提交成功就是成功 —— 刷新任务空间与回跳都只是收尾
 * 动作，任何一个失败都不得回写成复盘失败，也不得改动提交的 durable/幂等语义。
 */

export interface SessionReviewSubmitResult {
  ownershipState: string
  reviewState: string
}

/**
 * 本地 provisional 会话尚未被 S4 导入时，复盘只能停在本地：durable 草稿与
 * 控制器必须原样保留（导入后还能继续提交）。此分支**不刷新任务空间、不回跳**
 * —— 会话尚未真正落库，回跳会让人误以为投入已经进库。
 */
export function isProvisionalReviewPending(result: SessionReviewSubmitResult): boolean {
  return result.ownershipState === 'local_provisional' && result.reviewState === 'pending'
}

const defaultRefreshTaskSpace = (): Promise<void> => (
  useTaskSpaceStore.getState().refreshCachedOverview()
)

const reportRefreshFailure = (error: unknown): void => {
  // 只记录，不弹错：复盘已成功，刷新只是让新投入更早可见。
  console.error('[timer] 复盘完成后刷新任务空间失败（不影响复盘结果）：', error)
}

/**
 * 复盘提交成功后**立即**重读任务空间（语义同同步周期末的 refreshCachedOverview）。
 *
 * 返回的 Promise 永不 reject：调用方可以放心 `void`，刷新异常（同步 throw 或
 * 异步 reject）只走日志上报，绝不影响复盘结果。
 */
export function refreshTaskSpaceAfterReview(
  refresh: () => Promise<void> | void = defaultRefreshTaskSpace,
  report: (error: unknown) => void = reportRefreshFailure,
): Promise<void> {
  try {
    return Promise.resolve(refresh()).then(() => undefined, (error) => { report(error) })
  } catch (error) {
    report(error)
    return Promise.resolve()
  }
}

/**
 * 复盘完成态的回跳：先选中该会话挂的二级项（与 BlockerAck 取消时同一写法：
 * 选中上游 + router.push('/tasks')），再回任务页；没有二级项就只回跳。
 */
export function returnToTaskSpace(input: {
  level2WorkItemId: string | null
  selectWorkItem: (workItemId: string) => void
  navigate: (href: string) => void
}): void {
  if (input.level2WorkItemId) input.selectWorkItem(input.level2WorkItemId)
  input.navigate('/tasks')
}

export type ReviewCompletionOutcome = 'completed' | 'provisional_pending' | 'failed'

export interface ReviewCompletionDeps {
  /** 提交本身：草稿落库 + focusRepository.submitReview。 */
  submit: () => Promise<SessionReviewSubmitResult>
  /** provisional 未导入：保留 durable 草稿（页面 resync reviewDraft）。 */
  keepProvisionalDraft: () => void
  /** 完成态：重读本地聚合（进入只读面板）。 */
  reloadAggregate: () => Promise<void>
  /** 完成态：释放草稿控制器。 */
  releaseDraft: () => void
  /** 提交失败：稳定错误通道（页面 resolveTimerError）。 */
  onError: (cause: unknown) => void
  refreshTaskSpace?: () => Promise<void> | void
  reportRefreshFailure?: (error: unknown) => void
}

/**
 * 「提交复盘 → 成功收尾」的唯一入口：提交成功且已真正导入时，立即触发任务空间
 * 刷新，然后进入完成态；provisional 未导入则原样保留草稿并直接返回。
 */
export async function submitReviewWithCompletion(
  deps: ReviewCompletionDeps,
): Promise<ReviewCompletionOutcome> {
  try {
    const result = await deps.submit()
    if (isProvisionalReviewPending(result)) {
      // ⚠ 会话尚未真正落库：不加刷新、不加回跳（回跳入口只出现在完成态）。
      deps.keepProvisionalDraft()
      return 'provisional_pending'
    }
    // ① 提交成功后立即刷新（fire-and-forget）：失败只记日志，绝不影响复盘结果。
    void refreshTaskSpaceAfterReview(deps.refreshTaskSpace, deps.reportRefreshFailure)
    await deps.reloadAggregate()
    deps.releaseDraft()
    return 'completed'
  } catch (cause) {
    deps.onError(cause)
    return 'failed'
  }
}
