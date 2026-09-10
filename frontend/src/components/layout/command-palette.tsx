'use client'

/**
 * 命令面板（Ctrl+K）。
 *
 * ★ 与 F2 的关系
 *   原本这里是纯占位（"全局搜索 Coming in F2"）。现在先把**编辑器命令**接进来 ——
 *   注册表里每条命令都有 id / title，天然可被搜索调用。
 *   F2 要做的"全局搜索笔记/页面"是另一类数据源，将来在这个壳里并列展示即可。
 *
 * ★ 命令从哪来
 *   `getAllCommands()` —— 编辑器不认识具体功能，面板也不认识。
 *   装一个插件（比如表格命令组），它的命令会自动出现在这里，不用改面板代码。
 */

import { useEffect, useMemo, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { SearchIcon } from 'lucide-react'
import '@/lib/editor/commands-core'
import '@/lib/editor/commands-tables'
import { getAllCommands, runCommand, type EditorCommand } from '@/lib/editor/commands'
import { getActiveView } from '@/lib/editor/active-view'

interface CommandPaletteProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

/** 命令是否可执行的判断需要 view，所以单独抽出来。 */
function isEnabled(command: EditorCommand): boolean {
  if (!command.when) return true
  const view = getActiveView()
  if (!view) return false
  const { from, to } = view.state.selection.main
  return command.when({ view, selection: from === to ? null : { from, to } })
}

export function CommandPalette({ open, onOpenChange }: CommandPaletteProps) {
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)

  const commands = useMemo(() => getAllCommands(), [])

  const matched = useMemo(() => {
    const q = query.trim().toLowerCase()
    // 同时匹配标题与 id（`table.insertRow` 这类 id 对熟手更快）
    if (!q) return commands
    return commands.filter(
      (c) =>
        c.title.toLowerCase().includes(q) || c.id.toLowerCase().includes(q),
    )
  }, [commands, query])

  // 每次打开都重置搜索词与光标，避免残留上一次的状态
  useEffect(() => {
    if (open) {
      setQuery('')
      setCursor(0)
    }
  }, [open])

  useEffect(() => {
    setCursor(0)
  }, [query])

  const run = (command: EditorCommand) => {
    const view = getActiveView()
    if (!view) return
    const { from, to } = view.state.selection.main
    runCommand(command, { view, selection: from === to ? null : { from, to } })
    onOpenChange(false)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setCursor((c) => Math.min(c + 1, Math.max(0, matched.length - 1)))
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setCursor((c) => Math.max(c - 1, 0))
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      const target = matched[cursor]
      if (target && isEnabled(target)) run(target)
    }
  }

  const activeView = getActiveView()

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>命令面板</DialogTitle>
          <DialogDescription>
            搜索并执行编辑器命令。全局搜索笔记将在 F2 上线。
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-2">
          <SearchIcon className="size-4 shrink-0 text-muted-foreground" />
          <Input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="搜索命令…"
            aria-label="搜索命令"
          />
        </div>

        {!activeView && (
          <p className="text-xs text-muted-foreground">
            编辑器命令需要打开一篇笔记才能使用。
          </p>
        )}

        <ul className="max-h-64 overflow-y-auto">
          {matched.length === 0 && (
            <li className="px-2 py-3 text-xs text-muted-foreground">
              没有匹配的命令
            </li>
          )}
          {matched.map((command, index) => {
            const enabled = isEnabled(command)
            return (
              <li key={command.id}>
                <button
                  type="button"
                  disabled={!enabled}
                  onClick={() => run(command)}
                  onMouseEnter={() => setCursor(index)}
                  data-command-id={command.id}
                  className={
                    index === cursor
                      ? 'block w-full rounded bg-muted px-2 py-1.5 text-left text-sm'
                      : 'block w-full rounded px-2 py-1.5 text-left text-sm hover:bg-muted/60'
                  }
                >
                  <span className={enabled ? '' : 'text-muted-foreground'}>
                    {command.icon ? `${command.icon}  ` : ''}
                    {command.title}
                  </span>
                  {command.key && (
                    <span className="ml-2 text-xs text-muted-foreground">
                      {command.key}
                    </span>
                  )}
                  {!enabled && (
                    <span className="ml-2 text-xs text-muted-foreground">
                      （不可用）
                    </span>
                  )}
                </button>
              </li>
            )
          })}
        </ul>
      </DialogContent>
    </Dialog>
  )
}
