import { describe, expect, it, vi } from 'vitest'
import {
  isProvisionalReviewPending,
  refreshTaskSpaceAfterReview,
  returnToTaskSpace,
  submitReviewWithCompletion,
} from './session-review-completion'

const { refreshCachedOverview } = vi.hoisted(() => ({
  refreshCachedOverview: vi.fn<() => Promise<void>>(),
}))

// 任务空间 store 是浏览器侧单例（zustand + devtools）；这些单测只需要它的
// refreshCachedOverview 入口，整体替换掉，避免把 store 及其依赖拖进用例。
vi.mock('@/stores/task-space-store', () => ({
  useTaskSpaceStore: { getState: () => ({ refreshCachedOverview }) },
}))

describe('isProvisionalReviewPending', () => {
  it('只有「本地 provisional 且仍待复盘」才是未导入分支', () => {
    expect(isProvisionalReviewPending({ ownershipState: 'local_provisional', reviewState: 'pending' })).toBe(true)
    expect(isProvisionalReviewPending({ ownershipState: 'local_provisional', reviewState: 'completed' })).toBe(false)
    expect(isProvisionalReviewPending({ ownershipState: 'authoritative', reviewState: 'pending' })).toBe(false)
  })
})

describe('submitReviewWithCompletion（复盘提交成功后的收尾）', () => {
  it('提交成功：立即刷新任务空间，并进入复盘完成态', async () => {
    const refreshTaskSpace = vi.fn().mockResolvedValue(undefined)
    const reloadAggregate = vi.fn().mockResolvedValue(undefined)
    const releaseDraft = vi.fn()
    const onError = vi.fn()
    const keepProvisionalDraft = vi.fn()

    const outcome = await submitReviewWithCompletion({
      submit: vi.fn().mockResolvedValue({ ownershipState: 'authoritative', reviewState: 'completed' }),
      keepProvisionalDraft, reloadAggregate, releaseDraft, onError,
      refreshTaskSpace, reportRefreshFailure: vi.fn(),
    })

    expect(outcome).toBe('completed')
    // ① 复盘提交成功即刷新任务空间（新投入不再等下一轮同步才可见）。
    expect(refreshTaskSpace).toHaveBeenCalledTimes(1)
    expect(reloadAggregate).toHaveBeenCalledTimes(1)
    expect(releaseDraft).toHaveBeenCalledTimes(1)
    expect(keepProvisionalDraft).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()
  })

  it('提交成功且页面不注入刷新实现时：默认调用任务空间 store 的 refreshCachedOverview', async () => {
    refreshCachedOverview.mockClear()
    refreshCachedOverview.mockResolvedValue(undefined)

    const outcome = await submitReviewWithCompletion({
      submit: vi.fn().mockResolvedValue({ ownershipState: 'authoritative', reviewState: 'completed' }),
      keepProvisionalDraft: vi.fn(),
      reloadAggregate: vi.fn().mockResolvedValue(undefined),
      releaseDraft: vi.fn(), onError: vi.fn(),
    })

    expect(outcome).toBe('completed')
    // ① 页面真实路径：提交成功后立即 refreshCachedOverview（新投入不再等同步才可见）。
    expect(refreshCachedOverview).toHaveBeenCalledTimes(1)
  })

  it('刷新任务空间失败：只记日志，复盘结果与完成态不受影响', async () => {
    const failure = new Error('dexie read boom')
    const reportRefreshFailure = vi.fn()
    const reloadAggregate = vi.fn().mockResolvedValue(undefined)
    const releaseDraft = vi.fn()
    const onError = vi.fn()

    const outcome = await submitReviewWithCompletion({
      submit: vi.fn().mockResolvedValue({ ownershipState: 'authoritative', reviewState: 'completed' }),
      keepProvisionalDraft: vi.fn(), reloadAggregate, releaseDraft, onError,
      refreshTaskSpace: vi.fn().mockRejectedValue(failure), reportRefreshFailure,
    })

    expect(outcome).toBe('completed')
    expect(reloadAggregate).toHaveBeenCalledTimes(1)
    expect(releaseDraft).toHaveBeenCalledTimes(1)
    // 「复盘已成功就是成功」：刷新失败绝不走页面的稳定错误通道。
    expect(onError).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(reportRefreshFailure).toHaveBeenCalledWith(failure))
  })

  it('本地 provisional 未导入：不刷新任务空间、不进入完成态（保留 durable 草稿）', async () => {
    refreshCachedOverview.mockClear()
    const reloadAggregate = vi.fn()
    const releaseDraft = vi.fn()
    const keepProvisionalDraft = vi.fn()
    const onError = vi.fn()

    const outcome = await submitReviewWithCompletion({
      submit: vi.fn().mockResolvedValue({ ownershipState: 'local_provisional', reviewState: 'pending' }),
      keepProvisionalDraft, reloadAggregate, releaseDraft, onError,
    })

    expect(outcome).toBe('provisional_pending')
    // 会话尚未真正落库 ⇒ 不加刷新、不加回跳（回跳入口只出现在完成态）。
    expect(refreshCachedOverview).not.toHaveBeenCalled()
    expect(reloadAggregate).not.toHaveBeenCalled()
    expect(releaseDraft).not.toHaveBeenCalled()
    expect(keepProvisionalDraft).toHaveBeenCalledTimes(1)
    expect(onError).not.toHaveBeenCalled()
  })

  it('提交失败：走稳定错误通道，不刷新、不进入完成态', async () => {
    const failure = new Error('submit boom')
    const refreshTaskSpace = vi.fn()
    const onError = vi.fn()

    const outcome = await submitReviewWithCompletion({
      submit: vi.fn().mockRejectedValue(failure),
      keepProvisionalDraft: vi.fn(), reloadAggregate: vi.fn(), releaseDraft: vi.fn(), onError,
      refreshTaskSpace, reportRefreshFailure: vi.fn(),
    })

    expect(outcome).toBe('failed')
    expect(onError).toHaveBeenCalledWith(failure)
    expect(refreshTaskSpace).not.toHaveBeenCalled()
  })
})

describe('refreshTaskSpaceAfterReview', () => {
  it('默认实现调用任务空间 store 的 refreshCachedOverview', async () => {
    refreshCachedOverview.mockResolvedValue(undefined)
    await refreshTaskSpaceAfterReview()
    expect(refreshCachedOverview).toHaveBeenCalledTimes(1)
  })

  it('刷新抛错（同步或异步）都不向调用方冒泡，只上报', async () => {
    const report = vi.fn()
    await expect(refreshTaskSpaceAfterReview(() => { throw new Error('sync boom') }, report))
      .resolves.toBeUndefined()
    await expect(refreshTaskSpaceAfterReview(() => Promise.reject(new Error('async boom')), report))
      .resolves.toBeUndefined()
    expect(report).toHaveBeenCalledTimes(2)
  })
})

describe('returnToTaskSpace', () => {
  it('有二级项：先选中该二级项再回跳任务页', () => {
    const selectWorkItem = vi.fn()
    const navigate = vi.fn()
    returnToTaskSpace({ level2WorkItemId: 'wi-l2', selectWorkItem, navigate })
    expect(selectWorkItem).toHaveBeenCalledWith('wi-l2')
    expect(navigate).toHaveBeenCalledWith('/tasks')
  })

  it('没有二级项：只回跳（不误点选中）', () => {
    const selectWorkItem = vi.fn()
    const navigate = vi.fn()
    returnToTaskSpace({ level2WorkItemId: null, selectWorkItem, navigate })
    expect(selectWorkItem).not.toHaveBeenCalled()
    expect(navigate).toHaveBeenCalledWith('/tasks')
  })
})
