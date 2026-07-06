'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { useSpaceStore } from '@/stores/space-store'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { PlusIcon } from 'lucide-react'

export default function SelectSpacePage() {
  const router = useRouter()
  const spaces = useSpaceStore((s) => s.spaces)
  const loadSpaces = useSpaceStore((s) => s.loadSpaces)
  const createSpace = useSpaceStore((s) => s.createSpace)
  const selectSpace = useSpaceStore((s) => s.selectSpace)
  const isLoading = useSpaceStore((s) => s.isLoading)
  const error = useSpaceStore((s) => s.error)

  const [createDialogOpen, setCreateDialogOpen] = useState(false)
  const [newSpaceName, setNewSpaceName] = useState('')

  useEffect(() => {
    loadSpaces().catch(() => {
      // Error already set in store (error field)
    })
  }, [loadSpaces])

  const handleSelect = async (spaceId: string) => {
    try {
      await selectSpace(spaceId)
      router.replace('/dashboard')
    } catch (e) {
      toast.error('选择空间失败', { description: (e as Error).message })
    }
  }

  const handleCreate = async () => {
    const name = newSpaceName.trim()
    if (!name) return
    try {
      const space = await createSpace(name)
      await selectSpace(space.id)
      setCreateDialogOpen(false)
      setNewSpaceName('')
      router.replace('/dashboard')
    } catch (e) {
      toast.error('创建空间失败', { description: (e as Error).message })
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <Card className="w-full max-w-lg">
        <CardHeader>
          <CardTitle>选择空间</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {error ? (
            <p className="text-sm text-destructive">{error}</p>
          ) : null}

          {isLoading && spaces.length === 0 ? (
            <p className="text-sm text-muted-foreground">加载中…</p>
          ) : null}

          <div className="flex flex-col gap-2">
            {spaces.map((space) => (
              <Button
                key={space.id}
                variant="outline"
                className="justify-start"
                onClick={() => handleSelect(space.id)}
                disabled={isLoading}
              >
                {space.name}
              </Button>
            ))}
          </div>

          {spaces.length === 0 && !isLoading ? (
            <p className="text-sm text-muted-foreground">
              还没有空间，创建第一个吧
            </p>
          ) : null}

          <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
            <DialogTrigger render={<Button variant="default" />}>
              <PlusIcon className="size-4" />
              创建空间
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>创建新空间</DialogTitle>
              </DialogHeader>
              <div className="flex flex-col gap-4">
                <div className="flex flex-col gap-2">
                  <Label htmlFor="spaceName">空间名称</Label>
                  <Input
                    id="spaceName"
                    value={newSpaceName}
                    onChange={(e) => setNewSpaceName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleCreate()
                    }}
                  />
                </div>
                <Button onClick={handleCreate} disabled={!newSpaceName.trim()}>
                  创建
                </Button>
              </div>
            </DialogContent>
          </Dialog>
        </CardContent>
      </Card>
    </div>
  )
}
