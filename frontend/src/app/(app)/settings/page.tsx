'use client'

import { createElement, useEffect, useMemo, useState } from 'react'
import { CheckIcon, MonitorIcon } from 'lucide-react'
import { useTheme } from 'next-themes'
import { cn } from '@/lib/utils'
import { useSettingsStore, type SettingsTheme } from '@/stores/settings-store'
import { THEMES } from '@/utils/constants'

const THEME_OPTIONS: Array<{
  value: SettingsTheme
  label: string
  description: string
  swatches: string[]
}> = [
  {
    value: 'system',
    label: '跟随系统',
    description: '自动使用操作系统的浅色或深色偏好。',
    swatches: ['#f8fafc', '#111827', '#64748b'],
  },
  {
    value: 'light',
    label: 'Light',
    description: '干净明亮，适合白天书写和浏览。',
    swatches: ['#f8fafc', '#dbeafe', '#2563eb'],
  },
  {
    value: 'dark',
    label: 'Dark',
    description: '低亮度深色界面，适合长时间专注。',
    swatches: ['#020617', '#172033', '#7dd3fc'],
  },
  {
    value: 'midnight',
    label: 'Midnight',
    description: '更沉浸的夜间主题，强调安静和深度。',
    swatches: ['#10091f', '#31204a', '#c084fc'],
  },
  {
    value: 'nord',
    label: 'Nord',
    description: '冷静、低饱和的浅冷色工作界面。',
    swatches: ['#e5edf5', '#94a3b8', '#3b82f6'],
  },
  {
    value: 'daylight',
    label: 'Daylight',
    description: '温暖明亮，适合轻快记录与回顾。',
    swatches: ['#fff7ed', '#fed7aa', '#ea580c'],
  },
]

function applyThemeClass(theme: SettingsTheme): void {
  if (typeof document === 'undefined') return

  const root = document.documentElement
  root.classList.remove(...THEMES)

  if (theme === 'system') {
    const prefersDark = window.matchMedia?.('(prefers-color-scheme: dark)')?.matches
    root.classList.add(prefersDark ? 'dark' : 'light')
    return
  }

  root.classList.add(theme)
}

export default function SettingsPage() {
  const storedTheme = useSettingsStore((state) => state.theme)
  const updateSetting = useSettingsStore((state) => state.update)
  const { resolvedTheme, setTheme, theme } = useTheme()
  const [mounted, setMounted] = useState(false)

  useEffect(() => setMounted(true), [])

  useEffect(() => {
    if (!mounted) return
    if (useSettingsStore.getState().theme !== storedTheme) return
    if (theme !== storedTheme) setTheme(storedTheme)
    applyThemeClass(storedTheme)
  }, [mounted, setTheme, storedTheme, theme])

  const activeTheme = mounted ? storedTheme : 'system'
  const resolvedLabel = useMemo(() => {
    if (!mounted) return '读取中'
    if (storedTheme !== 'system') {
      return THEME_OPTIONS.find((item) => item.value === storedTheme)?.label
    }
    return resolvedTheme === 'light' ? '系统浅色' : '系统深色'
  }, [mounted, resolvedTheme, storedTheme])

  async function selectTheme(nextTheme: SettingsTheme) {
    await updateSetting('theme', nextTheme)
    setTheme(nextTheme)
    applyThemeClass(nextTheme)
  }

  return createElement(
    'main',
    {
      className:
        'mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8',
    },
    createElement(
      'header',
      { className: 'flex flex-col gap-2' },
      createElement(
        'p',
        {
          className:
            'text-xs font-medium tracking-[0.24em] text-muted-foreground uppercase',
        },
        'Preferences',
      ),
      createElement(
        'div',
        {
          className:
            'flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between',
        },
        createElement(
          'div',
          null,
          createElement(
            'h1',
            { className: 'text-3xl font-semibold tracking-tight text-foreground' },
            '设置',
          ),
          createElement(
            'p',
            { className: 'mt-2 max-w-2xl text-sm leading-6 text-muted-foreground' },
            '先接入全局主题选择，QuickNote 的玻璃时间流会跟随这里的主题变量切换。',
          ),
        ),
        createElement(
          'div',
          {
            className:
              'flex w-fit items-center gap-2 rounded-xl border bg-card px-3 py-2 text-sm text-muted-foreground shadow-sm',
          },
          createElement(MonitorIcon, { className: 'size-4' }),
          createElement('span', null, `当前：${resolvedLabel}`),
        ),
      ),
    ),
    createElement(
      'section',
      { className: 'rounded-2xl border bg-card p-4 shadow-sm' },
      createElement(
        'div',
        { className: 'mb-4 flex flex-col gap-1' },
        createElement('h2', { className: 'text-base font-semibold text-card-foreground' }, '主题'),
        createElement(
          'p',
          { className: 'text-sm text-muted-foreground' },
          '选择后会立即写入应用主题 class；QuickNote 的局部 token 会同步响应。',
        ),
      ),
      createElement(
        'div',
        { className: 'grid gap-3 sm:grid-cols-2 xl:grid-cols-3' },
        ...THEME_OPTIONS.map((option) => {
          const active = activeTheme === option.value

          return createElement(
            'button',
            {
              key: option.value,
              type: 'button',
              onClick: () => void selectTheme(option.value),
              className: cn(
                'group flex min-h-32 flex-col justify-between rounded-2xl border bg-background p-4 text-left shadow-sm transition hover:-translate-y-0.5 hover:border-primary/35 hover:shadow-md',
                active ? 'border-primary ring-2 ring-primary/20' : 'border-border',
              ),
              'aria-pressed': active,
            },
            createElement(
              'div',
              { className: 'flex items-start justify-between gap-3' },
              createElement(
                'div',
                null,
                createElement('h3', { className: 'text-sm font-semibold text-foreground' }, option.label),
                createElement(
                  'p',
                  { className: 'mt-1 text-sm leading-5 text-muted-foreground' },
                  option.description,
                ),
              ),
              createElement(
                'span',
                {
                  className: cn(
                    'grid size-6 shrink-0 place-items-center rounded-full border transition',
                    active
                      ? 'border-primary bg-primary text-primary-foreground'
                      : 'border-border text-transparent group-hover:text-muted-foreground',
                  ),
                },
                createElement(CheckIcon, { className: 'size-3.5' }),
              ),
            ),
            createElement(
              'div',
              { className: 'mt-4 flex items-center gap-2' },
              ...option.swatches.map((color) =>
                createElement('span', {
                  key: color,
                  className: 'size-6 rounded-full border border-border shadow-inner',
                  style: { backgroundColor: color },
                }),
              ),
            ),
          )
        }),
      ),
    ),
    createElement(
      'section',
      { className: 'rounded-2xl border bg-muted/40 p-4' },
      createElement(
        'div',
        {
          className:
            'flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between',
        },
        createElement(
          'div',
          null,
          createElement('h2', { className: 'text-base font-semibold text-foreground' }, 'QuickNote 主题联动'),
          createElement(
            'p',
            { className: 'mt-1 text-sm text-muted-foreground' },
            '小记页使用独立的 qn token，但变量挂在当前主题 class 下，后续主题系统扩展不会散落到组件里。',
          ),
        ),
        createElement(
          'a',
          {
            href: '/quick-notes',
            className:
              'inline-flex h-8 shrink-0 items-center justify-center rounded-lg border border-border bg-background px-2.5 text-sm font-medium text-foreground transition hover:bg-muted',
          },
          '查看小记页',
        ),
      ),
    ),
  )
}
