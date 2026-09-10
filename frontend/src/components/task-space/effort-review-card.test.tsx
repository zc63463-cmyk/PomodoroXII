import { createElement } from 'react'
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { CachedWorkItem } from '@/types'
import {
  EffortReviewCard,
  EFFORT_WARNING_RATIO,
  formatDuration,
  resolveEffortReview,
} from './effort-review-card'

const item = (overrides: Partial<CachedWorkItem> = {}): CachedWorkItem => ({
  id: 'l2',
  projectId: 'project-1',
  displayKey: 'RM-2',
  title: 'Level 2',
  description: null,
  typeDefinitionId: 'type-task',
  statusDefinitionId: 'status-open',
  priority: null,
  parentId: 'l1',
  childRank: 0,
  depth: 2,
  completionWindowStart: null,
  completionWindowEnd: null,
  reviewPoint: null,
  hardDeadline: null,
  effortEstimateLowerSeconds: null,
  effortEstimateUpperSeconds: null,
  effortActualSeconds: 0,
  confidence: null,
  completedAt: null,
  cancelledAt: null,
  archivedAt: null,
  markedAsAttention: false,
  labelIds: [],
  version: 1,
  createdAt: '2026-07-15T08:00:00.000Z',
  updatedAt: '2026-07-15T08:00:00.000Z',
  ...overrides,
})

describe('formatDuration', () => {
  it('renders compact Chinese durations', () => {
    expect(formatDuration(0)).toBe('0秒')
    expect(formatDuration(45)).toBe('45秒')
    expect(formatDuration(90)).toBe('2分钟')
    expect(formatDuration(3600)).toBe('1小时')
    expect(formatDuration(5400)).toBe('1小时30分钟')
  })
})

describe('resolveEffortReview', () => {
  it('reports unset when no upper estimate exists', () => {
    const review = resolveEffortReview(item({ effortActualSeconds: 4800 }))
    expect(review.status).toBe('unset')
    expect(review.percent).toBe(0)
  })

  it('reports normal below 80% of the upper estimate', () => {
    const review = resolveEffortReview(item({
      effortActualSeconds: 3600,
      effortEstimateUpperSeconds: 7200,
    }))
    expect(review.status).toBe('normal')
    expect(review.percent).toBe(50)
    expect(review.overflowSeconds).toBe(0)
  })

  it('reports warning from 80% up to the upper estimate', () => {
    const upper = 7200
    const review = resolveEffortReview(item({
      effortActualSeconds: Math.ceil(upper * EFFORT_WARNING_RATIO),
      effortEstimateUpperSeconds: upper,
    }))
    expect(review.status).toBe('warning')
    expect(review.percent).toBeGreaterThanOrEqual(80)
  })

  it('reports exceeded past the upper estimate and clamps the bar', () => {
    const review = resolveEffortReview(item({
      effortActualSeconds: 9000,
      effortEstimateUpperSeconds: 7200,
    }))
    expect(review.status).toBe('exceeded')
    expect(review.percent).toBe(100)
    expect(review.overflowSeconds).toBe(1800)
  })
})

describe('EffortReviewCard', () => {
  it('greys the bar and explains a missing estimate', () => {
    render(createElement(EffortReviewCard, {
      workItem: item({ effortActualSeconds: 4800 }),
      highlighted: true,
    }))
    expect(screen.getByText('已专注 1小时20分钟')).toBeInTheDocument()
    expect(screen.getByText('未设置预估时间')).toBeInTheDocument()
    const card = document.querySelector('[data-effort-status]')
    expect(card?.getAttribute('data-effort-status')).toBe('unset')
  })

  it('highlights level-2 items and shows the warning copy near the cap', () => {
    render(createElement(EffortReviewCard, {
      workItem: item({
        effortActualSeconds: 6000,
        effortEstimateUpperSeconds: 7200,
        confidence: 'medium',
      }),
      highlighted: true,
    }))
    expect(document.querySelector('[data-effort-status="warning"]')).not.toBeNull()
    expect(screen.getByText('投入即将达到预估上限')).toBeInTheDocument()
    expect(screen.getByText('预估置信度：中')).toBeInTheDocument()
  })

  it('marks an overrun in the destructive colour', () => {
    render(createElement(EffortReviewCard, {
      workItem: item({
        effortActualSeconds: 7800,
        effortEstimateUpperSeconds: 7200,
      }),
      highlighted: true,
    }))
    expect(document.querySelector('[data-effort-status="exceeded"]')).not.toBeNull()
    expect(screen.getByText('已超出上限 +10分钟')).toBeInTheDocument()
    const bar = document.querySelector('[data-effort-bar]') as HTMLElement | null
    expect(bar?.style.width).toBe('100%')
  })

  it('renders muted for level-3 items', () => {
    render(createElement(EffortReviewCard, {
      workItem: item({ depth: 3, effortActualSeconds: 3600, effortEstimateUpperSeconds: 7200 }),
      highlighted: false,
    }))
    expect(screen.getByText('投入（参考）')).toBeInTheDocument()
  })
})
