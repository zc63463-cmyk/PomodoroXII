'use client'

/**
 * Space switcher dropdown (F0 §5.3).
 *
 * Lists all spaces, highlights current, triggers selectSpace on click.
 * Uses base-ui DropdownMenuTrigger with render prop pattern.
 */

import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { useSpaceStore, selectCurrentSpace } from '@/stores/space-store'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu'
import { Button } from '@/components/ui/button'
import { CheckIcon, ChevronDownIcon, PlusIcon } from 'lucide-react'

export function SpaceSwitcher() {
  const router = useRouter()
  const spaces = useSpaceStore((s) => s.spaces)
  const currentSpace = useSpaceStore(selectCurrentSpace)
  const selectSpace = useSpaceStore((s) => s.selectSpace)
  const isLoading = useSpaceStore((s) => s.isLoading)

  const handleSelect = async (spaceId: string) => {
    try {
      await selectSpace(spaceId)
    } catch (e) {
      toast.error('切换空间失败', { description: (e as Error).message })
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="ghost" size="sm" disabled={isLoading} />}
      >
        <span className="max-w-[120px] truncate">
          {currentSpace ? currentSpace.name : '选择空间'}
        </span>
        <ChevronDownIcon className="size-3.5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-48">
        {spaces.map((space) => {
          const isCurrent = space.id === currentSpace?.id
          return (
            <DropdownMenuItem
              key={space.id}
              onClick={() => handleSelect(space.id)}
            >
              <span className="flex-1 truncate">{space.name}</span>
              {isCurrent ? <CheckIcon className="size-3.5" /> : null}
            </DropdownMenuItem>
          )
        })}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => router.push('/select-space')}>
          <PlusIcon className="size-3.5" />
          <span>创建空间</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
