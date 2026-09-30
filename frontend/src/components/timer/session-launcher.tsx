'use client'

import { createElement, useEffect, useMemo, useRef, useState } from 'react'
import { useSettingsStore } from '@/stores/settings-store'
import { formatClockSeconds } from '@/lib/focus-session/clock'
import {
  defaultMinutesForMode,
  isBreakMode,
  modeLabel,
  presetsForMode,
  type SessionMode,
} from '@/lib/focus-session/session-mode'
import { ModeSwitcher } from './mode-switcher'
import { TimerRing } from './timer-ring'

export interface LaunchItem {
  id: string
  title: string
  displayKey?: string
  depth: number
  parentId: string | null
  childRank?: number
}

export interface LaunchSelection {
  level2WorkItemId: string
  level3WorkItemIds: string[]
  plannedSeconds: number
  /** 双体系兼容（2026-09-16）：番茄钟模式，随启动命令一起落库。 */
  sessionType: SessionMode
}

export function deriveLaunchSelection(items: LaunchItem[], selectedId: string | null) {
  const selected = items.find((item) => item.id === selectedId) ?? null
  if (!selected) return { level2Id: null, level3Ids: [] as string[], requiresLevel2: false }
  if (selected.depth === 3) return { level2Id: selected.parentId, level3Ids: [selected.id], requiresLevel2: false }
  if (selected.depth === 2) return { level2Id: selected.id, level3Ids: [] as string[], requiresLevel2: false }
  return { level2Id: null, level3Ids: [] as string[], requiresLevel2: true }
}

interface SessionLauncherProps {
  items: LaunchItem[]
  initialWorkItemId: string | null
  onStart: (selection: LaunchSelection) => Promise<void> | void
  /**
   * 准备态内联新建三级（工单③ 2026-09-14）：规格 L446/L466「可点 + 新建三级
   * （只要求标题，自动加入计划）」。实现方沿用任务页 createChild 同一入口并
   * 返回新项 id；失败必须抛出 —— 由本组件以 role="alert" 呈现原因（离线创建
   * 被禁 offline_formal_creation_forbidden 必须可见），不做离线排队。
   */
  onCreateLevel3?: (level2Id: string, title: string) => Promise<string | void>
}

export function SessionLauncher({ items, initialWorkItemId, onStart, onCreateLevel3 }: SessionLauncherProps) {
  const initial = useMemo(() => deriveLaunchSelection(items, initialWorkItemId), [items, initialWorkItemId])
  const [level2Id, setLevel2Id] = useState<string | null>(initial.level2Id)
  const [level3Ids, setLevel3Ids] = useState<string[]>(initial.level3Ids)
  // 番茄钟模式（双体系兼容 2026-09-16）。默认 work —— 旧行为逐字不变。
  const [mode, setMode] = useState<SessionMode>('work')
  // 默认时长来自设置（按模式取对应项；工单④ / P07-a / D-4 → 轨 3 模式化），
  // 不再硬编码 1500s。plannedSeconds 是一次性初值，读 getState() 即可 ——
  // 启动器挂载时设置模块早已就绪。
  const [plannedSeconds, setPlannedSeconds] = useState(
    () => defaultMinutesForMode('work', useSettingsStore.getState()) * 60,
  )
  const [starting, setStarting] = useState(false)
  useEffect(() => {
    setLevel2Id(initial.level2Id)
    setLevel3Ids(initial.level3Ids)
  }, [initial])
  // 切模式同时把时长切到该模式的设置默认值（短休/长休各有自己的分钟数）；
  // 用户随后仍可自定义输入或点预设覆盖。
  const selectMode = (next: SessionMode) => {
    setMode(next)
    setPlannedSeconds(defaultMinutesForMode(next, useSettingsStore.getState()) * 60)
    if (isBreakMode(next)) {
      // 休息不承接三级成果（服务端 break_session_has_no_plan fail-closed）：
      // 切换时清空待提交的三级勾选，避免发出必被拒的启动命令。
      setLevel3Ids([])
    }
  }
  const breakMode = isBreakMode(mode)
  const level2Items = items.filter((item) => item.depth === 2)
  const candidates = items.filter((item) => item.depth === 3 && item.parentId === level2Id)
  const frozen = new Set(initial.level3Ids)

  // ── 准备态内联新建三级（工单③ 2026-09-14）──────────────────────────────
  const [newLevel3Title, setNewLevel3Title] = useState('')
  const [createError, setCreateError] = useState<string | null>(null)
  // ★ 结构性避开「createChild 先落 store 再返回」的闭包陷阱：不读 hook 的
  //   workItems 快照，直接用 onCreateLevel3 的返回值（运行态同一约定）。
  //   这个 ref 只服务于「提交期间用户切换 L2」的错挂防护：完成时若已不在
  //   提交时的 L2 上，收下返回值但不把它加进新 L2 的计划。
  const level2IdRef = useRef<string | null>(level2Id)
  useEffect(() => {
    level2IdRef.current = level2Id
  }, [level2Id])
  const submitNewLevel3 = () => {
    const title = newLevel3Title.trim()
    if (!title || !level2Id || !onCreateLevel3) return
    const targetLevel2Id = level2Id
    void (async () => {
      setCreateError(null)
      try {
        const createdId = await onCreateLevel3(targetLevel2Id, title)
        setNewLevel3Title('')
        // 返回 id 不在当前 candidates 里也先收下 —— store 更新后清单会重算。
        if (createdId && level2IdRef.current === targetLevel2Id) {
          setLevel3Ids((current) => (current.includes(createdId) ? current : [...current, createdId]))
        }
      } catch (cause) {
        setCreateError(cause instanceof Error ? cause.message : 'Unable to create WorkItem')
      }
    })()
  }

  return createElement(
    'form',
    {
      className: 'grid gap-4',
      onSubmit: (event: React.FormEvent<HTMLFormElement>) => {
        event.preventDefault()
        if (!level2Id || starting) return
        setStarting(true)
        // 模式随启动命令落库（双体系兼容）；休息型结构上不带三级计划 ——
        // 服务端对 `break_session_has_no_plan` 是 fail-closed 的。
        const selection: LaunchSelection = {
          level2WorkItemId: level2Id,
          level3WorkItemIds: breakMode ? [] : level3Ids,
          plannedSeconds,
          sessionType: mode,
        }
        void Promise.resolve(onStart(selection))
          .finally(() => setStarting(false))
      },
    },
    // 模式切换（双体系兼容 2026-09-16）：准备态可选 5 种模式，切换即取该模式
    // 的设置默认时长；运行态不可切换（模式是创建后不可变的服务端事实）。
    createElement(ModeSwitcher, { mode, onChange: selectMode, disabled: starting }),
    createElement('div', { className: 'grid gap-2' },
      createElement('label', { htmlFor: 'level-2-attribution' }, 'Level 2 attribution'),
      createElement('select', {
        id: 'level-2-attribution',
        'aria-label': 'Level 2 attribution',
        required: true,
        value: level2Id ?? '',
        onChange: (event: React.ChangeEvent<HTMLSelectElement>) => {
          setLevel2Id(event.target.value || null)
          setLevel3Ids([])
        },
      },
      createElement('option', { value: '' }, 'Select a Level 2 WorkItem'),
      level2Items.map((item) => createElement('option', { key: item.id, value: item.id }, item.title)),
      ),
    ),
    // 休息型不承接三级成果（服务端 `break_session_has_no_plan` fail-closed）：
    // 整组换成一句说明，而不是渲染一个点了必被拒的控件。
    breakMode
      ? createElement('p', {
          className: 'text-sm text-muted-foreground',
          'data-testid': 'break-plan-note',
        }, `${modeLabel(mode)}只记录休息时长（不计入二级投入、免复盘）；归属沿用上面选中的二级工作项。`)
      : createElement('fieldset', { className: 'grid gap-2 rounded-lg border p-3', disabled: !level2Id },
      createElement('legend', null, 'Level 3 plan'),
      candidates.map((item) => createElement('label', { key: item.id, className: 'ios-row', 'data-tappable': 'true' },
        createElement('input', {
          type: 'checkbox', checked: level3Ids.includes(item.id), disabled: frozen.has(item.id),
          onChange: (event: React.ChangeEvent<HTMLInputElement>) => setLevel3Ids((current) => event.target.checked
            ? [...current, item.id]
            : current.filter((id) => id !== item.id)),
        }),
        createElement('span', null, item.title),
      )),
      // 内联新建（工单③）：与运行态同款控件（输入 + 按钮 + 成功清空 +
      // 失败 role="alert" 保留输入）。★ 刻意不做嵌套 <form>：外层就是启动
      // 会话的 form —— 嵌套表单既是无效 HTML，其 submit 冒泡还可能误触
      // 「开始专注」；改用 div + type="button" + Enter 显式提交，行为等价、
      // 冒泡风险结构性归零。
      onCreateLevel3 ? createElement('div', { className: 'grid gap-2' },
        createElement('input', {
          value: newLevel3Title,
          'aria-label': '新三级标题',
          // 与运行态逐字一致（session-workspace.tsx 内联新建控件）
          placeholder: '新建三级工作项并加入计划…',
          onChange: (event: React.ChangeEvent<HTMLInputElement>) => setNewLevel3Title(event.target.value),
          onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => {
            if (event.key !== 'Enter') return
            // 截住隐式表单提交（否则外层「开始专注」会被先触发）
            event.preventDefault()
            submitNewLevel3()
          },
        }),
        createElement('button', {
          type: 'button',
          // iOS 纯文字按钮（次要动作）
          className: 'ios-btn--plain',
          disabled: !level2Id || newLevel3Title.trim() === '',
          onClick: submitNewLevel3,
        }, '+ 新建三级'),
        createError ? createElement('p', { role: 'alert' }, createError) : null,
      ) : null,
    ),
    // 静止环预览（工单② 2026-09-14，规格 L448-452）：钟居中、下方「专注时长」
    // 小字；fraction=0 → 空弧（尚未开始，弧长不假装有进度）。数字读
    // plannedSeconds 随预设/输入实时更新，与运行态共用 formatClockSeconds。
    // 不新增可聚焦元素、不新增 aria-live —— 可访问性源仍是「计划分钟」输入。
    createElement('div', { className: 'grid justify-items-center gap-1', 'data-testid': 'launcher-ring-preview' },
      createElement(TimerRing, {
        fraction: 0, overtime: false, live: false, svgClassName: 'h-40 w-40',
        tone: breakMode ? 'break' : mode === 'work' ? 'work' : 'flexible',
      },
        createElement('div', { className: 'absolute inset-0 grid place-items-center font-mono text-4xl tabular-nums' },
          formatClockSeconds(plannedSeconds)),
      ),
      // 文案随模式：work → 「专注时长」（既有文案逐字保留）；休息型 → 「休息时长」；
      // free/countdown → 「计时时长」（不假装是专注投入）。
      createElement('p', { className: 'text-xs text-muted-foreground' },
        breakMode ? '休息时长' : mode === 'work' ? '专注时长' : '计时时长'),
    ),
    createElement('div', { className: 'grid gap-2' },
      createElement('label', { className: 'grid gap-2', htmlFor: 'planned-seconds' },
        'Planned minutes',
        createElement('input', {
          id: 'planned-seconds', type: 'number', min: 1, value: Math.round(plannedSeconds / 60),
          onChange: (event: React.ChangeEvent<HTMLInputElement>) => setPlannedSeconds(Math.max(1, Number(event.target.value) || 1) * 60),
        }),
      ),
      // 时长预设（工单④ / P07-a / D-4 → 轨 3 模式化）：按模式取——
      // work → WORK_PRESETS（25/45/60/90）；短休 5/10/15；长休 15/20/30；
      // free / countdown → FOCUS_PRESETS（45/60/90/120）。
      // 自定义输入不命中任何预设时，全部按钮呈未选中态（aria-pressed）。
      createElement('div', { role: 'group', 'aria-label': '时长预设', className: 'flex flex-wrap gap-2' },
        ...presetsForMode(mode).map((minutes) => createElement('button', {
          key: minutes,
          type: 'button',
          // iOS 胶囊 chip：选中态用 systemBlue 填充（视觉权重明显高于普通描边按钮）
          className: 'ios-chip',
          'data-on': Math.round(plannedSeconds / 60) === minutes ? 'true' : 'false',
          'aria-pressed': Math.round(plannedSeconds / 60) === minutes,
          onClick: () => setPlannedSeconds(minutes * 60),
        }, `${minutes} 分钟`)),
      ),
    ),
    // ★ 禁用原因必须可见。
    //   此前 Start 按钮只做 `disabled: !level2Id`，但界面上没有任何一行解释
    //   "为什么点不动" —— 用户会直接判定"番茄钟没开发"。
    //   实测走查（2026-09-10）确认这是最容易被误读成缺陷的交互。
    level2Items.length === 0
      ? createElement('p', {
          role: 'status',
          className: 'text-sm text-muted-foreground',
        },
        // 没有二级项 = 结构性缺失，给出去哪里补的明确指引
        '这个 Space 里还没有「二级工作项」（Level 2）。专注会话必须挂在二级项上（它的 Parent 就是一级项），所以现在无法启动。',
        createElement('br', null),
        '去「任务」页选一个一级工作项，用它的「+ 子项」建一个二级项，再回到这里。')
      : !level2Id
        ? createElement('p', {
            role: 'status',
            className: 'text-sm text-muted-foreground',
          }, '先在上方「Level 2 attribution」里选中要投入的二级工作项，Start 才会启用。')
        : null,
    createElement('button', {
      type: 'submit',
      // iOS 主按钮：systemBlue 填充 + 44px 高 + 大圆角；禁用时降透明度（iOS 惯例）
      className: 'ios-btn',
      disabled: !level2Id || starting,
      style: { width: '100%', opacity: !level2Id || starting ? 0.35 : 1 },
    }, 'Start focus session'),
  )
}
