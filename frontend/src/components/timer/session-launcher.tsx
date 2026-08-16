'use client'

import { createElement, useEffect, useMemo, useState } from 'react'

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
  const [plannedSeconds, setPlannedSeconds] = useState(1500)
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
        if (!level2Id) return
        void onStart({ level2WorkItemId: level2Id, level3WorkItemIds: level3Ids, plannedSeconds })
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
    createElement('button', { type: 'submit', disabled: !level2Id }, 'Start focus session'),
  )
}
