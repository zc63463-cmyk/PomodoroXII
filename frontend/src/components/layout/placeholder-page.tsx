import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'

/**
 * Placeholder page for business routes (S0-3 stub).
 *
 * Shows title and upcoming sprint label.
 * F2/F3: replace with real implementations.
 */

interface PlaceholderPageProps {
  title: string
  sprint: string
}

export function PlaceholderPage({ title, sprint }: PlaceholderPageProps) {
  return (
    <div className="flex flex-1 items-center justify-center p-8">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>{title}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-muted-foreground">Coming in {sprint}</p>
        </CardContent>
      </Card>
    </div>
  )
}
