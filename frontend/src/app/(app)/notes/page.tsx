import { QuickNotesView } from '@/components/quick-notes/quick-notes-view'

interface NotesPageProps {
  searchParams: Promise<{ compose?: string | string[] }>
}

export default async function NotesPage({ searchParams }: NotesPageProps) {
  const { compose } = await searchParams
  const composeRequestKey = Array.isArray(compose) ? compose[0] : compose

  return <QuickNotesView composeRequestKey={composeRequestKey} />
}
