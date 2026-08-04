import type { MetaDB, ProvisionalOperationRow } from '@/services/meta-database'
import type { PomodoroXIDB } from '@/services/database'

export type OpenSpaceDatabase = (spaceId: string) => Promise<PomodoroXIDB> | PomodoroXIDB

async function hasActivationReceipt(
  database: PomodoroXIDB,
  operation: ProvisionalOperationRow,
): Promise<boolean> {
  const rows = await database.sessionActivationApplications
    .where('operationId').equals(operation.operationId).toArray()
  return rows.some((row) => {
    const candidate = row as Record<string, unknown>
    return candidate.operationId === operation.operationId &&
      candidate.provisionalSpaceId === operation.spaceId &&
      candidate.provisionalSessionId === operation.sessionId
  })
}

export async function recoverProvisionalStarts(
  meta: MetaDB,
  openSpace: OpenSpaceDatabase,
): Promise<void> {
  const pending = await meta.provisionalOperations
    .filter((row) => row.state === 'pending' || row.state === 'activating')
    .toArray()
  for (const operation of pending) {
    const database = await openSpace(operation.spaceId)
    if (database.spaceId !== operation.spaceId) {
      throw new Error(`space_database_identity_mismatch:${operation.operationId}`)
    }
    if (operation.state === 'activating') {
      if (await hasActivationReceipt(database, operation)) continue
      throw new Error(`activation_application_recovery_error:${operation.operationId}`)
    }
    const session = await database.focusSessions.get(operation.sessionId) as {
      ownershipState?: string
    } | undefined
    if (!session) {
      await meta.provisionalOperations.delete(operation.operationId)
      continue
    }
    if (session.ownershipState !== 'local_provisional') {
      throw new Error(`provisional_operation_mismatch:${operation.operationId}`)
    }
  }
}
