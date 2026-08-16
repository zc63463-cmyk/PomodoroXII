export type DraftFlushReason =
  | 'blur'
  | 'current-item-change'
  | 'before-append'
  | 'append-failed'
  | 'append-committed'
  | 'before-submit'
  | 'space-switch'
  | 'logout'
  | 'unmount'

export interface CriticalDraftDatabase {
  readonly name: string
}

export interface CriticalDraftController {
  readonly database: CriticalDraftDatabase
  flush(reason: DraftFlushReason): Promise<void>
}

export interface CriticalDraftRegistry<T extends CriticalDraftController = CriticalDraftController> {
  register(controller: T): () => void
  flushDatabase(database: CriticalDraftDatabase, reason: DraftFlushReason): Promise<void>
}

export function createCriticalDraftRegistry<T extends CriticalDraftController>(): CriticalDraftRegistry<T> {
  const controllers = new Set<T>()
  return {
    register(controller) {
      controllers.add(controller)
      return () => controllers.delete(controller)
    },
    async flushDatabase(database, reason) {
      const matching = [...controllers].filter((controller) => controller.database.name === database.name)
      for (const controller of matching) await controller.flush(reason)
    },
  }
}

export const criticalDraftRegistry = createCriticalDraftRegistry()
