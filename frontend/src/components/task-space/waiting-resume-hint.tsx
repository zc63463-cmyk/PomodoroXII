'use client'

import { createElement, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'

export interface WaitingResumeTarget {
  /** 服务端记录的「等待前态」状态 id —— 一键恢复的目标。 */
  statusDefinitionId: string
  /** 该状态在本空间的展示名（文案用）。 */
  name: string
}

export interface WaitingResumeHintProps {
  /** 已全部完成的上游数（文案用）。 */
  upstreamCount: number
  /**
   * 命中的恢复目标（进入 Waiting 前的状态）。
   *
   * ★ 2026-09-12（ADR-0003）：目标来自**服务端读投影的事实**
   *   （`preWaitingStatusDefinitionId`，wire 读路径才携带；本地行一律忽略），
   *   不再是设备本地记忆。null / undefined = **没有可信前态** —— 此时绝不猜：
   *   不渲染一键入口，只保留原因说明，由用户在本页「状态」中显式选择。
   */
  target?: WaitingResumeTarget | null
  /** 仅在命中目标时提供；未命中时不给一键入口（用户须自行显式选择）。 */
  onResume?: () => void
  /**
   * 退化为「让用户显式选择」时的具体原因（由调用点给出，避免文案说错原因）。
   * 文案不得暴露内部细节（id / 字段名 / 数据缺陷）。
   */
  unresolvedReason?: string
  pending?: boolean
  archived?: boolean
}

const DEFAULT_UNRESOLVED_REASON = '未能确定要恢复到的状态，请在本页「状态」中自行选择。'

/**
 * 「依赖已解除 → 建议恢复」横幅（依赖域合同 §10 / §14 验收 9：所有依赖
 * satisfied 后**提示**恢复，但绝不自动切状态）。
 *
 * ★ 与「未完成子项」提示同一种视觉语言（顶部横幅），因为它同样是"动手前的
 *   状态说明"，不是表单的一部分。
 * ★ 2026-09-12（ADR-0003）：恢复目标是**服务端记住的前态事实**（跨设备在线
 *   一致）。命中时给一键恢复（文案随目标状态名变）；未命中时退化为纯说明 ——
 *   只报告上游已完成，由用户在本页「状态」里显式选择目标。
 */
export function WaitingResumeHint({
  upstreamCount,
  target = null,
  onResume,
  unresolvedReason,
  pending = false,
  archived = false,
}: WaitingResumeHintProps): ReactNode {
  const disabled = pending || archived
  const disabledReason = pending
    ? '上一次操作仍在处理中，请稍候…'
    : archived
      ? '已归档的工作项不可修改，请先在右上角「恢复」'
      : undefined
  // 只有「命中目标」且「调用点确实给了执行入口」才渲染一键恢复。
  const resumable = target !== null && onResume !== undefined
  const targetLabel = target !== null ? target.name : null
  return createElement(
    'div',
    {
      role: 'status',
      'data-waiting-resume-hint': true,
      'data-waiting-resume-target': target !== null ? target.statusDefinitionId : 'unknown',
      className: 'flex items-center justify-between gap-3 border-b bg-emerald-50 px-4 py-2 text-sm text-emerald-900',
    },
    createElement(
      'span',
      null,
      resumable
        ? `上游依赖已全部完成（${upstreamCount} 项）—— 建议把状态恢复为「${targetLabel}」。`
        : `上游依赖已全部完成（${upstreamCount} 项）—— ${unresolvedReason ?? DEFAULT_UNRESOLVED_REASON}`,
    ),
    resumable
      ? createElement(
        Button,
        {
          type: 'button',
          variant: 'outline',
          size: 'sm',
          disabled,
          title: disabledReason,
          ...({ 'data-resume-waiting': true } as unknown as Record<string, never>),
          onClick: onResume,
        },
        `恢复为${targetLabel}`,
      )
      : null,
  )
}
