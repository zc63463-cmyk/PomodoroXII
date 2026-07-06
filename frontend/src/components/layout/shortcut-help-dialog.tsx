'use client'

/**
 * Shortcut help dialog (S3-6 / F0 §5.6).
 *
 * Lists all keyboard shortcuts. Opened by ? (Shift+/).
 */

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { SHORTCUT_ROUTES } from '@/lib/nav-config'

interface ShortcutHelpDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

const SHORTCUT_ITEMS: ReadonlyArray<{ keys: string; action: string }> = [
  ...Object.entries(SHORTCUT_ROUTES).map(([key, route]) => ({
    keys: key,
    action: `跳转到 ${route}`,
  })),
  { keys: 'Ctrl+K', action: '全局搜索' },
  { keys: '?', action: '显示快捷键帮助' },
  { keys: 'Esc', action: '关闭对话框' },
]

export function ShortcutHelpDialog({
  open,
  onOpenChange,
}: ShortcutHelpDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>键盘快捷键</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          {SHORTCUT_ITEMS.map(({ keys, action }) => (
            <div key={keys} className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">{action}</span>
              <kbd className="rounded border bg-muted px-2 py-0.5 text-xs font-mono">
                {keys}
              </kbd>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}
