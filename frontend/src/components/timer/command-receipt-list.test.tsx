import { createElement } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { CommandReceiptList } from './command-receipt-list'

const envelope = (commandId: string, replaySafe: boolean) => ({
  commandId, targetTransition: 'complete', replaySafe,
})
const receipt = (commandId: string, state: string, attempt = 1) => ({
  commandId, attempt, state, errorCode: null, detail: null,
  recordedAt: '2026-07-15T09:00:00Z',
})

describe('CommandReceiptList', () => {
  it('requires querying an unknown result before offering replay', async () => {
    const reconcile = vi.fn()
    const abandon = vi.fn()
    render(createElement(CommandReceiptList, {
      envelopes: [envelope('cmd-safe', true), envelope('cmd-unsafe', false)],
      receipts: [receipt('cmd-safe', 'unknown'), receipt('cmd-unsafe', 'unknown')],
      onReconcile: reconcile, onAbandon: abandon,
    }))

    expect(screen.queryByRole('button', { name: 'Retry cmd-safe' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Retry cmd-unsafe' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Query cmd-unsafe' }))
    fireEvent.click(screen.getByRole('button', { name: 'Query cmd-safe' }))
    // ★ 确定性（F2）：按钮是 reconcile 之后的**重渲染产物**，必须与 mock 断言同等到齐 ——
    //   只 await「mock 被调」会让紧随的 getByRole 在高负载下抢在 React 调度之前抛"找不到"。
    await waitFor(() => {
      expect(reconcile).toHaveBeenCalledWith('cmd-safe', false)
      expect(screen.getByRole('button', { name: 'Retry cmd-safe' })).toBeVisible()
    })
    fireEvent.click(screen.getByRole('button', { name: 'Retry cmd-safe' }))
    fireEvent.click(screen.getByRole('button', { name: 'Abandon cmd-unsafe' }))
    expect(reconcile).toHaveBeenNthCalledWith(1, 'cmd-unsafe', false)
    expect(reconcile).toHaveBeenNthCalledWith(2, 'cmd-safe', false)
    expect(reconcile).toHaveBeenNthCalledWith(3, 'cmd-safe', true)
    expect(abandon).toHaveBeenCalledWith('cmd-unsafe')
  })

  it('queries pending and unknown before allowing abandonment', async () => {
    const reconcile = vi.fn()
    const abandon = vi.fn()
    render(createElement(CommandReceiptList, {
      envelopes: [envelope('cmd-pending', false), envelope('cmd-abandoned', false)],
      receipts: [receipt('cmd-pending', 'pending'), receipt('cmd-abandoned', 'abandoned')],
      onReconcile: reconcile, onAbandon: abandon,
    }))
    expect(screen.getByText('Pending')).toBeVisible()
    expect(screen.getByText('Abandoned')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Query cmd-pending' })).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Abandon cmd-pending' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Abandon cmd-abandoned' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Query cmd-pending' }))
    // ★ 同型（F2）：按钮断言并入同一 waitFor
    await waitFor(() => {
      expect(reconcile).toHaveBeenCalledWith('cmd-pending', false)
      expect(screen.getByRole('button', { name: 'Abandon cmd-pending' })).toBeVisible()
    })
    fireEvent.click(screen.getByRole('button', { name: 'Abandon cmd-pending' }))
    expect(abandon).toHaveBeenCalledWith('cmd-pending')
  })

  it('does not unlock replay when the original-result query fails', async () => {
    const reconcile = vi.fn().mockRejectedValueOnce(new Error('transport lost'))
    render(createElement(CommandReceiptList, {
      envelopes: [envelope('cmd-safe', true)],
      receipts: [receipt('cmd-safe', 'unknown')],
      onReconcile: reconcile, onAbandon: vi.fn(),
    }))

    fireEvent.click(screen.getByRole('button', { name: 'Query cmd-safe' }))
    // ★ 同型（F2）：反例也收敛进同一 waitFor —— 等"查询已发生"这个前提成立后再断言未解锁
    await waitFor(() => {
      expect(reconcile).toHaveBeenCalledWith('cmd-safe', false)
      expect(screen.queryByRole('button', { name: 'Retry cmd-safe' })).toBeNull()
      expect(screen.queryByRole('button', { name: 'Abandon cmd-safe' })).toBeNull()
    })
  })
})
