/**
 * 专注结束提醒（PRD P0-05 + US1 后半；施工单 2026-09-13 工单①）。
 *
 * 「该不该响、怎么响」收在这一个可测单元里：依赖注入 { notify?, beep? }，
 * jsdom 下传 mock 即可断言；默认实现走 Web Notification 与 WebAudio 合成音
 * （零素材、零新增依赖 —— 权限申请只在用户手势里做）。
 *
 * 红线：fail-quiet —— 任何异常（无 Notification API / 权限被拒 /
 * AudioContext 被策略拦截）只留一条 console.warn，绝不影响会话；
 * 到点只提示，不自动结束会话、不自动进入复盘、不自动切状态。
 *
 * 闩锁以 sessionId 为键：越过计划点那一刻（clockState === 'running' 且
 * remainingSeconds === 0）尝试一次，无论成败都记闩 —— 超时期间
 * remainingSeconds 恒为 0（lib/focus-session/clock.ts:40 的 Math.max），
 * 没有闩锁就会每个 tick 重复触发。
 *
 * ## PXII-FEAT-TIMER-CHIME（2026-10-02）：柔和钟声 + Autoplay 解锁
 * 1. **音色**：三声数字蜂鸣（880/880/1175，听感冰冷）→ 双音谐波钟声
 *    （D5+A5 与 D6+A6 两对正弦叠加，指数包络自然衰减）。仍是**纯算力合成**，
 *    零外部 `.mp3` / `.wav` —— 不会因资源 404 而哑火。
 * 2. **Autoplay**：现代浏览器把「非用户手势期间创建的 AudioContext」置为
 *    `suspended`，到点（后台标签页）时静默不响。故引入 `sharedAudioContext`
 *    单例 + `ensureAudioContextReady()`：在「开始 / 暂停 / 继续 / 结束」这些
 *    **用户手势的同步栈**里预热 `resume()`，到点复用的已是 running 上下文。
 *    这也是 `defaultBeep` 不再 `ctx.close()` 的原因 —— 单例跨多次提醒复用。
 * 3. 预热失败一律 fail-quiet（返回 `null` / 静默返回），绝不因音频问题阻断会话。
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
  /**
   * 番茄钟模式（双体系兼容 2026-09-16，可选）：只影响**文案** ——
   * 休息型到点说「休息结束」，投入型（缺省）保持既有「专注结束」逐字不变。
   */
  mode?: 'work' | 'short_break' | 'long_break' | 'free' | 'countdown' | null
}

export interface EndAlert {
  check: (tick: EndAlertTick) => void
}

function defaultNotify(title: string, body: string): void {
  if (typeof window === 'undefined' || typeof window.Notification === 'undefined') {
    throw new Error('notification_api_unavailable')
  }
  // 只消费已授予的权限；permission 缺失时由用户手势路径补授。
  if (window.Notification.permission !== 'granted') {
    throw new Error('notification_permission_not_granted')
  }
  new window.Notification(title, { body })
}

/** 取 Web Audio 构造器（Safari 旧版走 webkit 前缀）；不可用返回 undefined。 */
function resolveAudioContextCtor(): typeof AudioContext | undefined {
  if (typeof window === 'undefined') return undefined
  return window.AudioContext
    ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
}

/**
 * 全局单例 AudioContext —— 让「手势预热」与「到点播放」用**同一个**上下文。
 * 每次新建再 `close()` 的旧写法在后台标签页会拿到 suspended 上下文而静默不响。
 */
let sharedAudioContext: AudioContext | null = null

/**
 * 用户手势预热（PXII-FEAT-TIMER-CHIME）：创建/复用单例并解锁 `suspended`。
 *
 * 调用点必须在**真实用户手势的同步栈**里（点击「开始专注」「暂停」「继续」），
 * 否则浏览器仍会把上下文按 Autoplay 策略挂起。
 *
 * @returns 可用的 AudioContext；无 Web Audio API 时 `null`（fail-quiet，不抛）
 */
export function ensureAudioContextReady(): AudioContext | null {
  try {
    const AudioCtx = resolveAudioContextCtor()
    if (!AudioCtx) return null
    if (!sharedAudioContext) {
      sharedAudioContext = new AudioCtx()
    }
    if (sharedAudioContext.state === 'suspended') {
      void sharedAudioContext.resume().catch(() => undefined)
    }
    return sharedAudioContext
  } catch {
    // 构造/resume 抛错（极端环境）→ 退化为"无音频"，绝不阻断会话
    return null
  }
}

/** 单音对（基频 + 泛音）的参数：频率、起始偏移、衰减时长、峰值增益。 */
interface BellTone {
  base: number
  overtone: number
  at: number
  duration: number
  peak: number
}

/**
 * 仿 iOS 柔和双音钟声 —— 两对谐波 + 指数包络（零素材）。
 *
 * 每对 = 两个正弦振荡器（基频 + 五度/八度泛音）汇入同一 GainNode；
 * `exponentialRampToValueAtTime(0.0001, …)` 把波形收到近零再停振，
 * 消除硬截断造成的爆破咔哒声（Click Artifact）。
 */
export function playGentleBell(ctx: AudioContext): void {
  const now = ctx.currentTime
  const tones: readonly BellTone[] = [
    // 声 1：温和双音（D5 + A5），快启音 + 自然延音
    { base: 587.33, overtone: 880.0, at: 0, duration: 0.65, peak: 0.22 },
    // 声 2：明亮上行（D6 + A6），清脆收尾
    { base: 1174.66, overtone: 1760.0, at: 0.28, duration: 0.95, peak: 0.2 },
  ]

  for (const tone of tones) {
    const startAt = now + tone.at
    const endAt = startAt + tone.duration

    const osc1 = ctx.createOscillator()
    const osc2 = ctx.createOscillator()
    const gain = ctx.createGain()

    osc1.type = 'sine'
    osc1.frequency.setValueAtTime(tone.base, startAt)
    osc2.type = 'sine'
    osc2.frequency.setValueAtTime(tone.overtone, startAt)

    // 起点不能取 0（指数斜坡不允许 0）：先用 0.0001 起步，再斜坡到峰值。
    gain.gain.setValueAtTime(0.0001, startAt)
    gain.gain.exponentialRampToValueAtTime(tone.peak, startAt + 0.005)
    gain.gain.exponentialRampToValueAtTime(0.0001, endAt)

    osc1.connect(gain)
    osc2.connect(gain)
    gain.connect(ctx.destination)

    osc1.start(startAt)
    osc2.start(startAt)
    osc1.stop(endAt)
    osc2.stop(endAt)
  }
}

function defaultBeep(): void {
  const ctx = ensureAudioContextReady()
  if (!ctx) throw new Error('audio_api_unavailable')
  // ★ 刻意**不** close：单例要留给下一次到点与「试听提示音」复用。
  playGentleBell(ctx)
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
      // 文案按模式分流：休息型说「休息结束 / 本轮休息 N 分钟已完成」；
      // 其余（含缺省）保持既有「专注结束」逐字不变。
      const breakSession = tick.mode === 'short_break' || tick.mode === 'long_break'
      const title = breakSession ? '休息结束' : '专注结束'
      const body = breakSession
        ? `本轮休息 ${minutes} 分钟已完成`
        : `本轮计划 ${minutes} 分钟已完成`
      if (tick.notificationEnabled) {
        try {
          (deps.notify ?? defaultNotify)(title, body)
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
