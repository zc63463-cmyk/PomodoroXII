export type FlushReason =
  | 'idle'
  | 'blur'
  | 'current-item-change'
  | 'session-end'
  | 'space-switch'
  | 'logout'
  | 'unmount'

export class NoteAutosaveController<T extends { revision: number }> {
  private timer: ReturnType<typeof setTimeout> | null = null
  private pending: T | null = null
  private inFlight: Promise<void> = Promise.resolve()

  constructor(
    private readonly write: (value: T, reason: FlushReason) => Promise<void>,
    private readonly delayMs = 800,
    private readonly onBackgroundError: (error: unknown) => void = () => undefined,
  ) {}

  schedule(value: T): void {
    this.pending = value
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      void this.flush('idle').catch(this.onBackgroundError)
    }, this.delayMs)
  }

  async flush(reason: FlushReason): Promise<void> {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    const next = this.pending
    if (!next) {
      await this.inFlight
      return
    }
    this.pending = null
    const write = this.inFlight.catch(() => undefined).then(() => this.write(next, reason))
    this.inFlight = write
    try {
      await write
    } catch (error) {
      const pendingRevision = (this.pending as T | null)?.revision
      if (pendingRevision === undefined || pendingRevision < next.revision) this.pending = next
      throw error
    }
  }

  cancel(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.pending = null
  }

  isDirty(): boolean {
    return this.pending !== null
  }
}
