import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useSettingsStore } from './settings-store'

describe('settings-store notificationEnabled（工单①）', () => {
  beforeEach(() => {
    window.localStorage.clear()
    useSettingsStore.setState({ notificationEnabled: true })
  })

  it('默认开启', () => {
    expect(useSettingsStore.getState().notificationEnabled).toBe(true)
  })

  it('update 写入状态并持久化到 localStorage', async () => {
    await useSettingsStore.getState().update('notificationEnabled', false)

    expect(useSettingsStore.getState().notificationEnabled).toBe(false)
    expect(window.localStorage.getItem('pxii_settings_notificationEnabled')).toBe('false')
  })

  it('load() 能把持久化的值读回（陷阱回归：写而不读 = 刷新即丢）', async () => {
    window.localStorage.setItem('pxii_settings_notificationEnabled', 'false')

    await useSettingsStore.getState().load()

    expect(useSettingsStore.getState().notificationEnabled).toBe(false)
  })

  it('load() 遇脏数据退回默认值而不是崩', async () => {
    window.localStorage.setItem('pxii_settings_notificationEnabled', '"yes"')

    await useSettingsStore.getState().load()

    expect(useSettingsStore.getState().notificationEnabled).toBe(true)
  })

  it('reset() 回到默认开启', async () => {
    await useSettingsStore.getState().update('notificationEnabled', false)

    useSettingsStore.getState().reset()

    expect(useSettingsStore.getState().notificationEnabled).toBe(true)
  })

  it('初始状态就读回 localStorage —— 不依赖 load()（全应用目前无 load() 调用点）', async () => {
    window.localStorage.setItem('pxii_settings_notificationEnabled', 'false')

    vi.resetModules()
    const fresh = await import('./settings-store')

    expect(fresh.useSettingsStore.getState().notificationEnabled).toBe(false)
  })
})

describe('settings-store 全键读回（工单③）', () => {
  /** 每键：localStorage 种子 → 期望从 store 读回的值。 */
  const PERSISTED_SETTINGS: Array<{ storageKey: string; raw: string; stateKey: string; expected: unknown }> = [
    // ★ theme 是唯一的**裸串**键（next-themes 与本 store 双写，皆裸串，不是 JSON）。
    //   此处 raw 必须是 'midnight'，绝不能写成 '"midnight"'。
    { storageKey: 'theme', raw: 'midnight', stateKey: 'theme', expected: 'midnight' },
    { storageKey: 'pxii_settings_pomodoroDuration', raw: '50', stateKey: 'pomodoroDuration', expected: 50 },
    { storageKey: 'pxii_settings_shortBreakDuration', raw: '10', stateKey: 'shortBreakDuration', expected: 10 },
    { storageKey: 'pxii_settings_longBreakDuration', raw: '30', stateKey: 'longBreakDuration', expected: 30 },
    { storageKey: 'pxii_settings_longBreakInterval', raw: '6', stateKey: 'longBreakInterval', expected: 6 },
    { storageKey: 'pxii_settings_autoStartBreaks', raw: 'true', stateKey: 'autoStartBreaks', expected: true },
    { storageKey: 'pxii_settings_autoStartPomodoros', raw: 'true', stateKey: 'autoStartPomodoros', expected: true },
    { storageKey: 'pxii_settings_soundEnabled', raw: 'false', stateKey: 'soundEnabled', expected: false },
    { storageKey: 'pxii_settings_notificationEnabled', raw: 'false', stateKey: 'notificationEnabled', expected: false },
    { storageKey: 'pxii_settings_dayBoundaryHour', raw: '3', stateKey: 'dayBoundaryHour', expected: 3 },
    { storageKey: 'pxii_settings_language', raw: '"en"', stateKey: 'language', expected: 'en' },
  ]

  function seedAll(): void {
    for (const item of PERSISTED_SETTINGS) window.localStorage.setItem(item.storageKey, item.raw)
  }

  beforeEach(() => {
    window.localStorage.clear()
  })

  it('load() 逐键读回：种子全部键 → load() → 每键与种子相等（含 soundEnabled）', async () => {
    seedAll()

    await useSettingsStore.getState().load()

    const state = useSettingsStore.getState() as unknown as Record<string, unknown>
    for (const item of PERSISTED_SETTINGS) {
      expect(state[item.stateKey]).toBe(item.expected)
    }
  })

  it('初始状态就全键读回 —— 不依赖 load()（fresh import，工单③核心断言）', async () => {
    seedAll()

    vi.resetModules()
    const fresh = await import('./settings-store')

    const state = fresh.useSettingsStore.getState() as unknown as Record<string, unknown>
    for (const item of PERSISTED_SETTINGS) {
      expect(state[item.stateKey]).toBe(item.expected)
    }
  })

  it('theme 裸串读回：种子裸值 midnight，不得回落 system（若走 JSON.parse 会 SyntaxError → system）', async () => {
    // 回归（工单③）：getInitialTheme 一旦走 JSON.parse，本用例必然失败。
    window.localStorage.setItem('theme', 'midnight')

    await useSettingsStore.getState().load()

    expect(useSettingsStore.getState().theme).toBe('midnight')
  })

  it('theme 裸串脏值：不在枚举内 → 回落 system（仍不崩）', async () => {
    window.localStorage.setItem('theme', 'neon')

    await useSettingsStore.getState().load()

    expect(useSettingsStore.getState().theme).toBe('system')
  })

  it('脏数据退回默认值而不是崩（数值键给字符串 / 布尔键给数字 / 语言不在枚举内）', async () => {
    window.localStorage.setItem('pxii_settings_pomodoroDuration', '"abc"')
    window.localStorage.setItem('pxii_settings_longBreakInterval', 'null')
    window.localStorage.setItem('pxii_settings_autoStartBreaks', '1')
    window.localStorage.setItem('pxii_settings_soundEnabled', '0')
    window.localStorage.setItem('pxii_settings_language', '"fr"')

    await useSettingsStore.getState().load()

    const state = useSettingsStore.getState()
    expect(state.pomodoroDuration).toBe(25)
    expect(state.longBreakInterval).toBe(4)
    expect(state.autoStartBreaks).toBe(false)
    expect(state.soundEnabled).toBe(true)
    expect(state.language).toBe('zh-CN')
  })

  it('数值键越界被 clamp 到防呆区间', async () => {
    window.localStorage.setItem('pxii_settings_pomodoroDuration', '5000')
    window.localStorage.setItem('pxii_settings_longBreakInterval', '0')

    await useSettingsStore.getState().load()

    expect(useSettingsStore.getState().pomodoroDuration).toBe(1440)
    expect(useSettingsStore.getState().longBreakInterval).toBe(1)
  })
})
