import { Button } from '@/components/ui/button'

/**
 * S0-1 placeholder home (F0 §14.1 — full auth/shell routes arrive in S0-3).
 */
export default function Home() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 p-8">
      <h1 className="text-4xl font-bold tracking-tight">PomodoroXII</h1>
      <p className="text-muted-foreground text-center max-w-md">
        S0-1 scaffold ready — Dexie v16, types, and platform constants aligned with
        F0-A Platform Shell design.
      </p>
      <p className="text-xs text-muted-foreground">Next: S0-2 auth + SpaceDBManager</p>
      <Button variant="outline" disabled>
        Login (S0-3)
      </Button>
    </main>
  )
}
