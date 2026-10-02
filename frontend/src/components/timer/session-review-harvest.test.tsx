/**
 * 复盘提炼卡片（session-review-harvest）—— 交互闭环断言（PXII-FEAT-REVIEW-HARVEST）。
 *
 * 组件**不认识数据层**（建任务 / 写笔记都由页面注入的回调负责），故这里用两个
 * spy 穷举「收集意图」这一侧：默认全选、计数同步、只交勾选项、失败可见、
 * 已升格项不可选、笔记折叠与注入、空提炼优雅收起。
 *
 * 末尾一组断言 `SessionReview` 的**挂载契约**：提炼卡片只在复盘**可写态**
 * （`draft` 已就绪）出现，只读完成态不挂载 —— 这正是白名单第 5 项
 * 「session-review.tsx 挂载提炼组件」的可观察行为。
 */
import { createElement } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { HarvestedThoughts, HarvestedTodoItem } from '@/lib/work-map/harvest-thoughts'
import { SessionReview } from './session-review'
import { SessionReviewHarvest } from './session-review-harvest'

const SESSION_ISLAND_TITLE = '10-02 19:00 会话'

const todo = (over: Partial<HarvestedTodoItem> = {}): HarvestedTodoItem => ({
  cid: 'c2',
  title: '写一节「岛的归档策略」草案',
  subIslandTitle: SESSION_ISLAND_TITLE,
  alreadyPromoted: false,
  displayKey: null,
  ...over,
})

const thoughts = (over: Partial<HarvestedThoughts> = {}): HarvestedThoughts => ({
  todos: [],
  insights: [],
  decisions: [],
  problems: [],
  reviews: [],
  ...over,
})

const promoteButton = (count: number) =>
  screen.getByRole('button', { name: `一键沉淀为任务 (${count})` })

describe('SessionReviewHarvest（复盘提炼交互）', () => {
  it('★ 空提炼优雅收起：不渲染卡片、不占位', () => {
    render(createElement(SessionReviewHarvest, { thoughts: thoughts() }))

    expect(screen.queryByTestId('review-harvest')).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('★ 待办默认全选；取消勾选后按钮计数同步，全取消则按钮禁用', () => {
    render(createElement(SessionReviewHarvest, {
      thoughts: thoughts({
        todos: [todo(), todo({ cid: 'c11', title: '补一条自动化回归' })],
      }),
    }))

    const first = screen.getByLabelText('沉淀 写一节「岛的归档策略」草案') as HTMLInputElement
    const second = screen.getByLabelText('沉淀 补一条自动化回归') as HTMLInputElement
    expect(first.checked).toBe(true)
    expect(second.checked).toBe(true)
    expect(promoteButton(2)).toBeEnabled()

    fireEvent.click(second)
    expect(promoteButton(1)).toBeEnabled()

    fireEvent.click(first)
    expect(promoteButton(0)).toBeDisabled()
  })

  it('★ 一键沉淀只把**勾选项**交给页面；成功后收敛选中并给出状态文案', async () => {
    const onPromoteTodos = vi.fn().mockResolvedValue(undefined)
    render(createElement(SessionReviewHarvest, {
      thoughts: thoughts({
        todos: [todo(), todo({ cid: 'c11', title: '补一条自动化回归' })],
      }),
      onPromoteTodos,
    }))

    fireEvent.click(screen.getByLabelText('沉淀 补一条自动化回归'))
    fireEvent.click(promoteButton(1))

    expect(onPromoteTodos).toHaveBeenCalledTimes(1)
    expect(onPromoteTodos).toHaveBeenCalledWith([
      expect.objectContaining({ cid: 'c2', title: '写一节「岛的归档策略」草案' }),
    ])
    expect(await screen.findByTestId('harvest-status')).toHaveTextContent('已沉淀 1 项为正式任务')
  })

  it('沉淀失败：原因留在卡内状态里（不吞错、不炸复盘表单）', async () => {
    const onPromoteTodos = vi.fn().mockRejectedValue(new Error('offline_formal_creation_forbidden'))
    render(createElement(SessionReviewHarvest, {
      thoughts: thoughts({ todos: [todo()] }),
      onPromoteTodos,
    }))

    fireEvent.click(promoteButton(1))

    expect(await screen.findByTestId('harvest-status'))
      .toHaveTextContent('沉淀失败：offline_formal_creation_forbidden')
  })

  it('★ 已升格项不可勾选：只作成果展示（✓ + `[PXII-102]`），且不再计入待沉淀数', () => {
    render(createElement(SessionReviewHarvest, {
      thoughts: thoughts({
        todos: [todo({
          cid: 'c8',
          title: '[PXII-102] 已升格：补 CHANGELOG',
          alreadyPromoted: true,
          displayKey: 'PXII-102',
        })],
      }),
    }))

    expect(screen.queryByRole('checkbox')).toBeNull()
    const promoted = screen.getByTestId('harvest-promoted')
    expect(promoted).toHaveTextContent('✓')
    expect(promoted).toHaveTextContent('[PXII-102]')
    expect(promoteButton(0)).toBeDisabled()
  })

  it('★ 笔记：默认折叠 → 展开可见 Markdown 预览 → 注入把整块交给页面', async () => {
    const onInjectNote = vi.fn().mockResolvedValue(undefined)
    render(createElement(SessionReviewHarvest, {
      thoughts: thoughts({ insights: ['只有洞察'] }),
      onInjectNote,
    }))

    // 折叠态：预览不在 DOM 里（面板不被长文顶开）
    expect(screen.queryByTestId('harvest-preview')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '展开预览' }))
    const preview = screen.getByTestId('harvest-preview')
    expect(preview).toHaveTextContent('### 💡 本轮专注思考提炼')
    expect(preview).toHaveTextContent('- 💡 **洞察**：只有洞察')
    expect(screen.getByRole('button', { name: '收起预览' })).toBeEnabled()

    fireEvent.click(screen.getByRole('button', { name: '注入复盘笔记' }))

    expect(onInjectNote).toHaveBeenCalledWith('### 💡 本轮专注思考提炼\n- 💡 **洞察**：只有洞察')
    expect(await screen.findByTestId('harvest-status')).toHaveTextContent('复盘笔记已注入')
  })

  it('笔记注入失败：原因可见', async () => {
    render(createElement(SessionReviewHarvest, {
      thoughts: thoughts({ decisions: ['定方案'] }),
      onInjectNote: vi.fn().mockRejectedValue(new Error('focus_session_not_found')),
    }))

    fireEvent.click(screen.getByRole('button', { name: '注入复盘笔记' }))

    expect(await screen.findByTestId('harvest-status'))
      .toHaveTextContent('注入失败：focus_session_not_found')
  })

  it('disabled：勾选框与两个动作按钮一律禁用（外部锁定时不产生半提交）', () => {
    render(createElement(SessionReviewHarvest, {
      thoughts: thoughts({ todos: [todo()], insights: ['只有洞察'] }),
      disabled: true,
    }))

    expect(screen.getByLabelText('沉淀 写一节「岛的归档策略」草案')).toBeDisabled()
    expect(promoteButton(1)).toBeDisabled()
    expect(screen.getByRole('button', { name: '注入复盘笔记' })).toBeDisabled()
  })

  it('待办与笔记可同屏共存（一次复盘既沉淀任务也注入笔记）', () => {
    render(createElement(SessionReviewHarvest, {
      thoughts: thoughts({
        todos: [todo()],
        decisions: ['确定采用纯前端 Web Audio 合成双音方案'],
        problems: ['Chrome Autoplay 策略需要在初次点击手势时预热 AudioContext'],
      }),
    }))

    expect(screen.getByTestId('review-harvest')).toBeVisible()
    expect(promoteButton(1)).toBeEnabled()
    expect(screen.getByRole('button', { name: '注入复盘笔记' })).toBeEnabled()
  })
})

describe('SessionReview 挂载契约（白名单第 5 项）', () => {
  const session = {
    sessionId: 'fs-1', focusedSeconds: 1350, validity: 'pending',
    reviewState: 'pending', clockState: 'ended', ownershipState: 'authoritative',
  }
  const draft = {
    operationId: 'review-op-1', spaceId: 'space-a', sessionId: 'fs-1', expectedVersion: 7,
    validity: 'valid', reviewState: 'completed', reviewedAt: '2026-10-02T11:00:00Z', outcomes: [],
  }
  const harvest = createElement(SessionReviewHarvest, {
    thoughts: thoughts({ todos: [todo()] }),
  })

  it('★ 可写态（draft 就绪）挂载提炼卡片', () => {
    render(createElement(SessionReview, {
      session, plans: [], envelopes: [], receipts: [], draft, readOnly: false,
      onDraftChange: vi.fn(), onSubmit: vi.fn(), onReconcile: vi.fn(), onAbandon: vi.fn(),
      harvestSlot: harvest,
    } as never))

    expect(screen.getByTestId('review-harvest')).toBeVisible()
    expect(promoteButton(1)).toBeEnabled()
  })

  it('只读完成态不挂载（提炼入口只属于待复盘的可写态）', () => {
    render(createElement(SessionReview, {
      session, plans: [], envelopes: [], receipts: [], draft: null, readOnly: true,
      onDraftChange: vi.fn(), onSubmit: vi.fn(), onReconcile: vi.fn(), onAbandon: vi.fn(),
      harvestSlot: harvest,
    } as never))

    expect(screen.queryByTestId('review-harvest')).toBeNull()
  })

  it('未注入 harvestSlot 时不渲染提炼区（默认零行为变化）', () => {
    render(createElement(SessionReview, {
      session, plans: [], envelopes: [], receipts: [], draft, readOnly: false,
      onDraftChange: vi.fn(), onSubmit: vi.fn(), onReconcile: vi.fn(), onAbandon: vi.fn(),
    } as never))

    expect(screen.queryByTestId('review-harvest')).toBeNull()
  })
})
