'use client'

/**
 * Command palette stub (S3-6 / F0 §5.6).
 *
 * Placeholder dialog for Ctrl+K global search.
 * Full implementation coming in F2.
 */

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { SearchIcon } from 'lucide-react'

interface CommandPaletteStubProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function CommandPaletteStub({
  open,
  onOpenChange,
}: CommandPaletteStubProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>全局搜索</DialogTitle>
          <DialogDescription>Coming in F2</DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2">
          <SearchIcon className="size-4 text-muted-foreground" />
          <Input placeholder="搜索功能将在 F2 上线…" disabled />
        </div>
      </DialogContent>
    </Dialog>
  )
}
