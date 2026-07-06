import { Button } from "@/components/ui/button";

export default function Home() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 p-8">
      <h1 className="text-4xl font-bold tracking-tight">PomodoroXII</h1>
      <p className="text-muted-foreground">前端脚手架已就绪</p>
      <Button>开始</Button>
    </main>
  );
}
