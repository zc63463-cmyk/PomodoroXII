import { createElement } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
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
  it('offers query for every unknown and retry only for replay-safe envelopes', () => {
    const reconcile = vi.fn()
    const abandon = vi.fn()
    render(createElement(CommandReceiptList, {
      envelopes: [envelope('cmd-safe', true), envelope('cmd-unsafe', false)],
      receipts: [receipt('cmd-safe', 'unknown'), receipt('cmd-unsafe', 'unknown')],
      onReconcile: reconcile, onAbandon: abandon,
    }))

    expect(screen.getByRole('button', { name: 'Retry cmd-safe' })).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Retry cmd-unsafe' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Query cmd-unsafe' }))
    fireEvent.click(screen.getByRole('button', { name: 'Retry cmd-safe' }))
    fireEvent.click(screen.getByRole('button', { name: 'Abandon cmd-unsafe' }))
    expect(reconcile).toHaveBeenNthCalledWith(1, 'cmd-unsafe', false)
    expect(reconcile).toHaveBeenNthCalledWith(2, 'cmd-safe', true)
    expect(abandon).toHaveBeenCalledWith('cmd-unsafe')
  })

  it('keeps pending visible and gives abandoned receipts no further action', () => {
    render(createElement(CommandReceiptList, {
      envelopes: [envelope('cmd-pending', false), envelope('cmd-abandoned', false)],
      receipts: [receipt('cmd-pending', 'pending'), receipt('cmd-abandoned', 'abandoned')],
      onReconcile: vi.fn(), onAbandon: vi.fn(),
    }))
    expect(screen.getByText('Pending')).toBeVisible()
    expect(screen.getByText('Abandoned')).toBeVisible()
    expect(screen.getByRole('button', { name: 'Abandon cmd-pending' })).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Abandon cmd-abandoned' })).toBeNull()
  })
})
