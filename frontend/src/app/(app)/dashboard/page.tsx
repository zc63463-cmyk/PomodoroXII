'use client'

import { useSpaceStore, selectCurrentSpace } from '@/stores/space-store'
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'

export default function DashboardPage() {
  const currentSpace = useSpaceStore(selectCurrentSpace)

  return (
    <div className="flex flex-1 items-center justify-center p-8">
      <Card className="w-full max-w-lg">
        <CardHeader>
          <CardTitle>仪表盘</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground">
            当前空间：{currentSpace ? currentSpace.name : '未选择'}
          </p>
          <p className="mt-2 text-sm text-muted-foreground">
            概览功能 Coming in F2
          </p>
        </CardContent>
      </Card>
    </div>
  )
}
