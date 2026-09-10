'use client'

import { createElement, type ReactNode } from 'react'
import type { CachedWorkItem } from '@/types'

/**
 * Lightweight effort review (v1.2 §6.1).
 *
 * Compares the focus time actually spent on a work item against its declared
 * estimate range.  Level-2 items are the review unit: level-1 items are
 * containers and level-3 items do not accumulate focus time themselves, so
 * the card is only *highlighted* at depth 2 and rendered muted otherwise.
 */

export type EffortReviewStatus = 'unset' | 'normal' | 'warning' | 'exceeded'

/** Fraction of the upper estimate at which the bar turns amber. */
export const EFFORT_WARNING_RATIO = 0.8

export interface EffortReviewState {
  status: EffortReviewStatus
  /** Bar width; already clamped to 0..100. */
  percent: number
  actualSeconds: number
  lowerSeconds: number | null
  upperSeconds: number | null
  /** Seconds spent beyond the upper estimate (0 unless exceeded). */
  overflowSeconds: number
}

const CONFIDENCE_LABELS: Record<string, string> = {
  low: '低',
  medium: '中',
  high: '高',
}

/** Format a second count as a compact Chinese duration (90 -> "2分钟"). */
export function formatDuration(seconds: number): string {
  const safe = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0
  if (safe < 60) return `${safe}秒`
  const totalMinutes = Math.round(safe / 60)
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  if (hours === 0) return `${minutes}分钟`
  if (minutes === 0) return `${hours}小时`
  return `${hours}小时${minutes}分钟`
}

export function resolveEffortReview(workItem: Pick<
  CachedWorkItem,
  'effortActualSeconds' | 'effortEstimateLowerSeconds' | 'effortEstimateUpperSeconds'
>): EffortReviewState {
  const actualSeconds = Math.max(0, workItem.effortActualSeconds ?? 0)
  const upperSeconds = workItem.effortEstimateUpperSeconds ?? null
  const lowerSeconds = workItem.effortEstimateLowerSeconds ?? null

  if (upperSeconds === null || upperSeconds <= 0) {
    return {
      status: 'unset', percent: 0, actualSeconds, lowerSeconds, upperSeconds,
      overflowSeconds: 0,
    }
  }

  const raw = (actualSeconds / upperSeconds) * 100
  const percent = Math.max(0, Math.min(100, raw))
  const overflowSeconds = actualSeconds > upperSeconds ? actualSeconds - upperSeconds : 0
  const status: EffortReviewStatus = overflowSeconds > 0
    ? 'exceeded'
    : actualSeconds >= upperSeconds * EFFORT_WARNING_RATIO
      ? 'warning'
      : 'normal'
  return { status, percent, actualSeconds, lowerSeconds, upperSeconds, overflowSeconds }
}

const BAR_CLASS: Record<EffortReviewStatus, string> = {
  unset: 'bg-muted-foreground/30',
  normal: 'bg-emerald-500',
  warning: 'bg-amber-500',
  exceeded: 'bg-destructive',
}

const TEXT_CLASS: Record<EffortReviewStatus, string> = {
  unset: 'text-muted-foreground',
  normal: 'text-emerald-600',
  warning: 'text-amber-600',
  exceeded: 'text-destructive',
}

function summary(review: EffortReviewState): string {
  const spent = `已专注 ${formatDuration(review.actualSeconds)}`
  if (review.status === 'unset') return spent
  return `${spent} / 预估 ${formatDuration(review.upperSeconds ?? 0)}`
}

function advice(review: EffortReviewState): string {
  if (review.status === 'unset') return '未设置预估时间'
  if (review.status === 'exceeded') return `已超出上限 +${formatDuration(review.overflowSeconds)}`
  if (review.status === 'warning') return '投入即将达到预估上限'
  return ''
}

export interface EffortReviewCardProps {
  workItem: CachedWorkItem
  /** depth === 2: the review unit.  Deeper items render muted. */
  highlighted?: boolean
}

export function EffortReviewCard({ workItem, highlighted = false }: EffortReviewCardProps): ReactNode {
  const review = resolveEffortReview(workItem)
  const confidence = workItem.confidence ? CONFIDENCE_LABELS[workItem.confidence] : null
  const hint = advice(review)

  return createElement(
    'section',
    {
      'aria-label': 'Effort review',
      'data-effort-status': review.status,
      className: highlighted
        ? 'grid gap-2 rounded-md border bg-muted/30 p-3'
        : 'grid gap-2 rounded-md p-3',
    },
    createElement(
      'div',
      { className: 'flex items-baseline justify-between gap-3 text-sm' },
      createElement(
        'span',
        { className: highlighted ? 'font-medium' : 'font-medium text-muted-foreground' },
        highlighted ? '投入复核' : '投入（参考）',
      ),
      createElement(
        'span',
        { className: `text-xs ${TEXT_CLASS[review.status]}`, 'data-effort-summary': true },
        summary(review),
      ),
    ),
    createElement(
      'div',
      { className: 'h-2 w-full overflow-hidden rounded-full bg-secondary' },
      createElement('div', {
        className: `h-full transition-all ${BAR_CLASS[review.status]}`,
        style: { width: `${review.percent}%` },
        'data-effort-bar': true,
      }),
    ),
    createElement(
      'div',
      { className: 'flex items-baseline justify-between gap-3 text-xs' },
      createElement(
        'span',
        { className: hint ? TEXT_CLASS[review.status] : 'text-muted-foreground', 'data-effort-hint': true },
        hint || (review.upperSeconds === null ? '' : `${Math.round(review.percent)}%`),
      ),
      confidence
        ? createElement('span', { className: 'text-muted-foreground' }, `预估置信度：${confidence}`)
        : null,
    ),
  )
}
