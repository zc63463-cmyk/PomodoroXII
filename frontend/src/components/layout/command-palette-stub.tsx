'use client'

import { useEffect, useId, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { ArrowRightIcon, NotebookIcon, PlusIcon, SearchIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

interface CommandPaletteStubProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

const COMMANDS = [
  {
    id: 'open-notes',
    label: '打开笔记',
    description: '进入速记工作台',
    keywords: '笔记 速记 notes quick notes',
    Icon: NotebookIcon,
  },
  {
    id: 'new-quick-note',
    label: '新建小记',
    description: '立即开始记录',
    keywords: '新建 创建 小记 速记 compose',
    Icon: PlusIcon,
  },
] as const

export function CommandPaletteStub({
  open,
  onOpenChange,
}: CommandPaletteStubProps) {
  const router = useRouter()
  const listboxId = useId()
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const filteredCommands = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase()
    if (!normalizedQuery) return COMMANDS
    return COMMANDS.filter((command) =>
      `${command.label} ${command.description} ${command.keywords}`
        .toLowerCase()
        .includes(normalizedQuery),
    )
  }, [query])

  useEffect(() => {
    if (!open) return
    setQuery('')
    setActiveIndex(0)
  }, [open])

  useEffect(() => {
    setActiveIndex((index) => Math.min(index, Math.max(filteredCommands.length - 1, 0)))
  }, [filteredCommands.length])

  function runCommand(command: (typeof COMMANDS)[number]) {
    onOpenChange(false)
    router.push(
      command.id === 'new-quick-note'
        ? `/notes?compose=${Date.now()}`
        : '/notes',
    )
  }

  function handleSearchKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown' && filteredCommands.length > 0) {
      event.preventDefault()
      setActiveIndex((index) => (index + 1) % filteredCommands.length)
      return
    }
    if (event.key === 'ArrowUp' && filteredCommands.length > 0) {
      event.preventDefault()
      setActiveIndex((index) => (index - 1 + filteredCommands.length) % filteredCommands.length)
      return
    }
    if (event.key === 'Enter') {
      const command = filteredCommands[activeIndex]
      if (!command) return
      event.preventDefault()
      runCommand(command)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-3 sm:max-w-md">
        <DialogHeader>
          <DialogTitle>命令</DialogTitle>
          <DialogDescription className="sr-only">搜索并执行应用命令</DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2 rounded-md border px-3">
          <SearchIcon className="size-4 shrink-0 text-muted-foreground" />
          <Input
            autoFocus
            role="combobox"
            aria-label="搜索命令"
            aria-controls={listboxId}
            aria-expanded={filteredCommands.length > 0}
            aria-activedescendant={
              filteredCommands[activeIndex]
                ? `${listboxId}-${filteredCommands[activeIndex].id}`
                : undefined
            }
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={handleSearchKeyDown}
            placeholder="搜索命令"
            className="border-0 px-0 shadow-none focus-visible:ring-0"
          />
        </div>
        <div id={listboxId} role="listbox" aria-label="可用命令" className="grid gap-1">
          {filteredCommands.map((command, index) => (
            <button
              key={command.id}
              id={`${listboxId}-${command.id}`}
              type="button"
              role="option"
              aria-selected={index === activeIndex}
              onMouseMove={() => setActiveIndex(index)}
              onClick={() => runCommand(command)}
              className={cn(
                'flex min-h-11 w-full items-center gap-3 rounded-md px-3 py-2 text-left outline-none',
                index === activeIndex
                  ? 'bg-accent text-accent-foreground'
                  : 'hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring',
              )}
            >
              <command.Icon className="size-4 shrink-0" />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium">{command.label}</span>
                <span className="block text-xs text-muted-foreground">{command.description}</span>
              </span>
              <ArrowRightIcon className="size-4 shrink-0 text-muted-foreground" />
            </button>
          ))}
          {filteredCommands.length === 0 ? (
            <p role="status" className="px-3 py-5 text-center text-sm text-muted-foreground">
              没有匹配的命令
            </p>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  )
}
