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
