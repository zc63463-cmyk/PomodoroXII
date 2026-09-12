'use client'

import { createElement, useEffect, useMemo, useState } from 'react'
import { useSettingsStore } from '@/stores/settings-store'
import { WORK_PRESETS } from '@/utils/constants'

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
}

export function SessionLauncher({ items, initialWorkItemId, onStart }: SessionLauncherProps) {
  const initial = useMemo(() => deriveLaunchSelection(items, initialWorkItemId), [items, initialWorkItemId])
  const [level2Id, setLevel2Id] = useState<string | null>(initial.level2Id)
  const [level3Ids, setLevel3Ids] = useState<string[]>(initial.level3Ids)
  // 默认时长来自设置（pomodoroDuration，分钟；工单④ / P07-a / D-4），
  // 不再硬编码 1500s。plannedSeconds 是一次性初值，读 getState() 即可 ——
  // 启动器挂载时设置模块早已就绪。
  const [plannedSeconds, setPlannedSeconds] = useState(
    () => useSettingsStore.getState().pomodoroDuration * 60,
  )
  const [starting, setStarting] = useState(false)
  useEffect(() => {
    setLevel2Id(initial.level2Id)
    setLevel3Ids(initial.level3Ids)
  }, [initial])
  const level2Items = items.filter((item) => item.depth === 2)
  const candidates = items.filter((item) => item.depth === 3 && item.parentId === level2Id)
  const frozen = new Set(initial.level3Ids)

  return createElement(
    'form',
    {
      className: 'grid gap-4',
      onSubmit: (event: React.FormEvent<HTMLFormElement>) => {
        event.preventDefault()
        if (!level2Id || starting) return
        setStarting(true)
        void Promise.resolve(onStart({ level2WorkItemId: level2Id, level3WorkItemIds: level3Ids, plannedSeconds }))
          .finally(() => setStarting(false))
      },
    },
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
    createElement('fieldset', { className: 'grid gap-2', disabled: !level2Id },
      createElement('legend', null, 'Level 3 plan'),
      candidates.map((item) => createElement('label', { key: item.id, className: 'flex items-center gap-2' },
        createElement('input', {
          type: 'checkbox', checked: level3Ids.includes(item.id), disabled: frozen.has(item.id),
          onChange: (event: React.ChangeEvent<HTMLInputElement>) => setLevel3Ids((current) => event.target.checked
            ? [...current, item.id]
            : current.filter((id) => id !== item.id)),
        }),
        createElement('span', null, item.title),
      )),
    ),
    createElement('label', { className: 'grid gap-2', htmlFor: 'planned-seconds' },
      'Planned minutes',
      createElement('input', {
        id: 'planned-seconds', type: 'number', min: 1, value: Math.round(plannedSeconds / 60),
        onChange: (event: React.ChangeEvent<HTMLInputElement>) => setPlannedSeconds(Math.max(1, Number(event.target.value) || 1) * 60),
      }),
    ),
    // 时长预设（工单④ / P07-a / D-4）：当前唯一的会话种类是 work，故取
    // WORK_PRESETS；FOCUS_PRESETS（45/60/90/120）留给未来的自由/倒计时
    // 模式（P04 沉浸 / P07-c 声景均不在本单范围），此处刻意不消费。
    // 自定义输入不命中任何预设时，全部按钮呈未选中态（aria-pressed）。
    createElement('div', { role: 'group', 'aria-label': '时长预设', className: 'flex flex-wrap gap-2' },
      ...WORK_PRESETS.map((minutes) => createElement('button', {
        key: minutes,
        type: 'button',
        'aria-pressed': Math.round(plannedSeconds / 60) === minutes,
        onClick: () => setPlannedSeconds(minutes * 60),
      }, `${minutes} 分钟`)),
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
    createElement('button', { type: 'submit', disabled: !level2Id || starting }, 'Start focus session'),
  )
}
