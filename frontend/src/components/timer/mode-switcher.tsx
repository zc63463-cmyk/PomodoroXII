'use client'

import { createElement } from 'react'
import {
  modeLabel,
  SESSION_MODES,
  type SessionMode,
} from '@/lib/focus-session/session-mode'

interface ModeSwitcherProps {
  mode: SessionMode
  onChange: (mode: SessionMode) => void
  /** 允许切换的模式（默认全 5 个：work / short_break / long_break / free / countdown）。 */
  modes?: readonly SessionMode[]
  disabled?: boolean
}

/**
 * 模式切换（双体系兼容 2026-09-16）。
 *
 * 设计基线：规格 L454「[时长预设] [模式切换]」+ PRD US1「选专注/短休/长休模式」。
 * 纯展示 + 单选语义：选中态用 `aria-pressed`（与时长预设同款），不引入新状态。
 * 切换动作由调用方决定（准备态改默认时长、运行态不可切换 —— 模式是创建后
 * 不可变的服务端事实）。
 */
export function ModeSwitcher({
  mode,
  onChange,
  modes = SESSION_MODES,
  disabled = false,
}: ModeSwitcherProps) {
  return createElement(
    'div',
    { role: 'group', 'aria-label': '模式切换', className: 'flex flex-wrap gap-2' },
    ...modes.map((item) => createElement(
      'button',
      {
        key: item,
        type: 'button',
        'aria-pressed': item === mode,
        'data-testid': `mode-${item}`,
        disabled,
        onClick: () => onChange(item),
        // iOS 胶囊 chip（与「本次时长」的时长预设同一视觉语言）：
        // 选中态由 --ios-blue 填充，未选中态是浅填充 —— 与番茄钟页其它选择项一致。
        className: 'ios-chip',
        'data-on': item === mode ? 'true' : 'false',
        style: disabled ? { pointerEvents: 'none', opacity: 0.5 } : undefined,
      },
      modeLabel(item),
    )),
  )
}
