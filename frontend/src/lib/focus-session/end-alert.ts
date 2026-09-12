/**
 * 专注结束提醒（PRD P0-05 + US1 后半；施工单 2026-09-13 工单①）。
 *
 * 「该不该响、怎么响」收在这一个可测单元里：依赖注入 { notify?, beep? }，
 * jsdom 下传 mock 即可断言；默认实现走 Web Notification 与 WebAudio 合成音
 * （零素材、零新增依赖、零授权申请 —— 权限申请只在设置页的用户手势里做）。
 *
 * 红线：fail-quiet —— 任何异常（无 Notification API / 权限被拒 /
 * AudioContext 被策略拦截）只留一条 console.warn，绝不影响会话；
 * 到点只提示，不自动结束会话、不自动进入复盘、不自动切状态。
 *
 * 闩锁以 sessionId 为键：越过计划点那一刻（clockState === 'running' 且
 * remainingSeconds === 0）尝试一次，无论成败都记闩 —— 超时期间
 * remainingSeconds 恒为 0（lib/focus-session/clock.ts:40 的 Math.max），
 * 没有闩锁就会每个 tick 重复触发。
 */

export interface EndAlertDeps {
  notify?: (title: string, body: string) => void
  beep?: () => void
  warn?: (message: string) => void
}

export interface EndAlertTick {
  sessionId: string | null | undefined
  clockState: 'running' | 'paused' | 'ended' | null | undefined
  remainingSeconds: number
  plannedSeconds: number
  notificationEnabled: boolean
  soundEnabled: boolean
}

export interface EndAlert {
  check: (tick: EndAlertTick) => void
}

function defaultNotify(title: string, body: string): void {
  if (typeof window === 'undefined' || typeof window.Notification === 'undefined') {
    throw new Error('notification_api_unavailable')
  }
  // 只消费已授予的权限；permission 缺失时由设置页的手势路径补授。
  if (window.Notification.permission !== 'granted') {
    throw new Error('notification_permission_not_granted')
  }
  new window.Notification(title, { body })
}

function defaultBeep(): void {
  const AudioCtx = typeof window === 'undefined'
    ? undefined
    : window.AudioContext
      ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!AudioCtx) throw new Error('audio_api_unavailable')
  const ctx = new AudioCtx()
  const osc = ctx.createOscillator()
  const gain = ctx.createGain()
  osc.type = 'sine'
  // 三短音（高-高-更高）共 ~0.9s：合成音零素材，也避开音频文件的加载与授权问题。
  const notes: Array<[frequency: number, atSeconds: number]> = [[880, 0], [880, 0.28], [1175, 0.56]]
  for (const [frequency, at] of notes) {
    osc.frequency.setValueAtTime(frequency, ctx.currentTime + at)
    gain.gain.setValueAtTime(0.0001, ctx.currentTime + at)
    gain.gain.exponentialRampToValueAtTime(0.22, ctx.currentTime + at + 0.03)
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + at + 0.24)
  }
  osc.connect(gain)
  gain.connect(ctx.destination)
  osc.start()
  osc.stop(ctx.currentTime + 0.9)
  osc.onended = () => { void ctx.close() }
}

export function createEndAlert(deps: EndAlertDeps = {}): EndAlert {
  const alerted = new Set<string>()
  const warn = deps.warn ?? ((message: string) => { console.warn(`[end-alert] ${message}`) })
  return {
    check(tick) {
      if (!tick.sessionId || tick.clockState !== 'running' || tick.remainingSeconds !== 0) return
      if (alerted.has(tick.sessionId)) return
      // 闩锁记在「尝试」上而不是「成功」上：超时期间每 tick 都会满足触发条件，
      // 失败重试会把一次故障放大成 log 洪水；迟到的提示也没有到点提示的价值。
      alerted.add(tick.sessionId)
      const minutes = Math.max(1, Math.round(tick.plannedSeconds / 60))
      if (tick.notificationEnabled) {
        try {
          (deps.notify ?? defaultNotify)('专注结束', `本轮计划 ${minutes} 分钟已完成`)
        } catch (cause) {
          warn(`notification skipped: ${cause instanceof Error ? cause.message : String(cause)}`)
        }
      }
      if (tick.soundEnabled) {
        try {
          (deps.beep ?? defaultBeep)()
        } catch (cause) {
          warn(`sound skipped: ${cause instanceof Error ? cause.message : String(cause)}`)
        }
      }
    },
  }
}
