import { PomodoroXIDB } from '@/services/database'
import { dexieDbNameForSpace, PXII_SPACE_SWITCHED_EVENT } from '@/lib/platform'

type SpaceSwitchListener = (spaceId: string) => void

export interface BeforeSpaceSwitchContext {
  fromSpaceId: string
  toSpaceId: string | null
  database: PomodoroXIDB
}

type BeforeSpaceSwitchListener = (
  context: BeforeSpaceSwitchContext,
) => Promise<void> | void

class SpaceDBManager {
  private currentDB: PomodoroXIDB | null = null
  private _currentSpaceId: string | null = null
  private listeners: Set<SpaceSwitchListener> = new Set()
  private beforeSwitchListeners: Set<BeforeSpaceSwitchListener> = new Set()
  private transitionQueue: Promise<void> = Promise.resolve()

  switchTo(
    spaceId: string,
    options: { dispatchEvent?: boolean } = {},
  ): Promise<void> {
    return this.enqueueTransition(async () => {
      const previousDB = this.currentDB
      if (previousDB && this._currentSpaceId) {
        const context: BeforeSpaceSwitchContext = {
          fromSpaceId: this._currentSpaceId,
          toSpaceId: spaceId,
          database: previousDB,
        }
        await this.runBeforeSwitchListeners(context)
      }

      const nextDB = new PomodoroXIDB(dexieDbNameForSpace(spaceId))
      await nextDB.open()
      previousDB?.close()
      this.currentDB = nextDB
      this._currentSpaceId = spaceId
      this.listeners.forEach((fn) => fn(spaceId))
      if (options.dispatchEvent !== false && typeof window !== 'undefined') {
        window.dispatchEvent(
          new CustomEvent(PXII_SPACE_SWITCHED_EVENT, {
            detail: { spaceId },
          }),
        )
      }
    })
  }

  flushBeforeClose(): Promise<void> {
    return this.enqueueTransition(async () => {
      if (!this.currentDB || !this._currentSpaceId) return
      const context: BeforeSpaceSwitchContext = {
        fromSpaceId: this._currentSpaceId,
        toSpaceId: null,
        database: this.currentDB,
      }
      await this.runBeforeSwitchListeners(context)
    })
  }

  private enqueueTransition(transition: () => Promise<void>): Promise<void> {
    const queued = this.transitionQueue.then(transition, transition)
    this.transitionQueue = queued.catch(() => undefined)
    return queued
  }

  private async runBeforeSwitchListeners(
    context: BeforeSpaceSwitchContext,
  ): Promise<void> {
    await Promise.allSettled(
      Array.from(this.beforeSwitchListeners, (listener) =>
        Promise.resolve().then(() => listener(context)),
      ),
    )
  }

  close(): void {
    if (this.currentDB) {
      this.currentDB.close()
      this.currentDB = null
      this._currentSpaceId = null
    }
  }

  get current(): PomodoroXIDB {
    if (!this.currentDB) {
      throw new Error(
        'SpaceDBManager: No space selected. Call switchTo(spaceId) first.',
      )
    }
    return this.currentDB
  }

  get currentSpaceId(): string | null {
    return this._currentSpaceId
  }

  get hasSpace(): boolean {
    return this.currentDB !== null
  }

  onSwitch(listener: SpaceSwitchListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  onBeforeSwitch(listener: BeforeSpaceSwitchListener): () => void {
    this.beforeSwitchListeners.add(listener)
    return () => {
      this.beforeSwitchListeners.delete(listener)
    }
  }

  get proxy(): PomodoroXIDB {
    return new Proxy({} as PomodoroXIDB, {
      get: (_target, prop: string) => {
        const db = this.current
        const value = (db as unknown as Record<string, unknown>)[prop]
        return typeof value === 'function'
          ? (value as (...args: unknown[]) => unknown).bind(db)
          : value
      },
    })
  }
}

const spaceDBManager = new SpaceDBManager()

export const db = spaceDBManager.proxy as PomodoroXIDB
export { spaceDBManager }
export type { SpaceDBManager }
