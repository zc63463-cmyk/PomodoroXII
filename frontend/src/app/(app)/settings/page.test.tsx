import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { fireEvent, render, screen, waitFor, act } from '@testing-library/react'
import { useSettingsStore } from '@/stores/settings-store'

const setThemeMock = vi.hoisted(() => vi.fn())

vi.mock('next-themes', () => ({
  useTheme: () => ({
    theme: useSettingsStore.getState().theme,
    resolvedTheme: 'dark',
    setTheme: setThemeMock,
  }),
}))

vi.mock('lucide-react', () => ({
  CheckIcon: () => createElement('span', { 'data-testid': 'check-icon' }),
  MonitorIcon: () => createElement('span', { 'data-testid': 'monitor-icon' }),
}))

import SettingsPage from '@/app/(app)/settings/page'

describe('SettingsPage theme selection', () => {
  beforeEach(() => {
    setThemeMock.mockClear()
    window.localStorage.clear()
    document.documentElement.className = ''
    vi.stubGlobal('matchMedia', vi.fn().mockImplementation(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })))
    useSettingsStore.setState({
      theme: 'system',
      language: 'zh-CN',
      isLoaded: false,
    })
  })

  it('renders all supported app themes from the settings entry point', async () => {
    render(createElement(SettingsPage))

    expect(await screen.findByRole('button', { name: /跟随系统/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Light/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Dark/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Midnight/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Nord/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Daylight/ })).toBeInTheDocument()
  })

  it('syncs custom theme choices to next-themes and settings store', async () => {
    render(createElement(SettingsPage))

    fireEvent.click(await screen.findByRole('button', { name: /Midnight/ }))

    await waitFor(() => {
      expect(setThemeMock).toHaveBeenCalledWith('midnight')
      expect(useSettingsStore.getState().theme).toBe('midnight')
      expect(window.localStorage.getItem('theme')).toBe('midnight')
      expect(document.documentElement).toHaveClass('midnight')
    })

    fireEvent.click(screen.getByRole('button', { name: /Nord/ }))

    await waitFor(() => {
      expect(setThemeMock).toHaveBeenCalledWith('nord')
      expect(useSettingsStore.getState().theme).toBe('nord')
      expect(window.localStorage.getItem('theme')).toBe('nord')
      expect(document.documentElement).toHaveClass('nord')
      expect(document.documentElement).not.toHaveClass('midnight')
    })

    fireEvent.click(screen.getByRole('button', { name: /Daylight/ }))

    await waitFor(() => {
      expect(setThemeMock).toHaveBeenCalledWith('daylight')
      expect(useSettingsStore.getState().theme).toBe('daylight')
      expect(window.localStorage.getItem('theme')).toBe('daylight')
      expect(document.documentElement).toHaveClass('daylight')
      expect(document.documentElement).not.toHaveClass('nord')
    })
  })

  it('links to the normal QuickNote route without enabling preview mode', async () => {
    render(createElement(SettingsPage))

    const link = await screen.findByRole('link', { name: '查看小记页' })

    expect(link).toHaveAttribute('href', '/quick-notes')
    expect(link.getAttribute('href')).not.toContain('quickNotePreview=1')
  })
})

function stubNotification(
  permission: 'granted' | 'denied' | 'default',
  requestPermission?: () => Promise<NotificationPermission>,
): void {
  const ctor = vi.fn(function NotificationStub(this: unknown) { /* jsdom 不需要真弹 */ })
  Object.defineProperty(ctor, 'permission', { value: permission })
  if (requestPermission) Object.defineProperty(ctor, 'requestPermission', { value: requestPermission })
  vi.stubGlobal('Notification', ctor)
}

describe('SettingsPage 专注提醒开关（工单①）', () => {
  beforeEach(() => {
    window.localStorage.clear()
    vi.stubGlobal('matchMedia', vi.fn().mockImplementation(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })))
    useSettingsStore.setState({ theme: 'system', language: 'zh-CN', isLoaded: false, notificationEnabled: false })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('渲染开关并如实反映 store 状态', async () => {
    const view = render(createElement(SettingsPage))
    const toggle = await screen.findByRole('checkbox', { name: '结束提醒' })
    expect(toggle).not.toBeChecked()

    act(() => { useSettingsStore.setState({ notificationEnabled: true, theme: 'system' }) })
    view.rerender(createElement(SettingsPage))
    expect(screen.getByRole('checkbox', { name: '结束提醒' })).toBeChecked()
  })

  it('权限被拒：开关回弹、store 不变、拒绝原因必须可见', async () => {
    stubNotification('denied')
    render(createElement(SettingsPage))

    fireEvent.click(screen.getByRole('checkbox', { name: '结束提醒' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('桌面通知权限已被浏览器拒绝')
    expect(screen.getByRole('checkbox', { name: '结束提醒' })).not.toBeChecked()
    expect(useSettingsStore.getState().notificationEnabled).toBe(false)
  })

  it('权限已授予：点击直接开启', async () => {
    stubNotification('granted')
    render(createElement(SettingsPage))

    fireEvent.click(screen.getByRole('checkbox', { name: '结束提醒' }))

    await waitFor(() => expect(useSettingsStore.getState().notificationEnabled).toBe(true))
  })

  it('权限未决：在手势内申请授权，授予后开启', async () => {
    const requestPermission = vi.fn().mockResolvedValue('granted')
    stubNotification('default', requestPermission)
    render(createElement(SettingsPage))

    fireEvent.click(screen.getByRole('checkbox', { name: '结束提醒' }))

    await waitFor(() => expect(requestPermission).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(useSettingsStore.getState().notificationEnabled).toBe(true))
  })

  it('权限未决但用户拒绝授权：开关回弹并说明去哪重新允许', async () => {
    stubNotification('default', vi.fn().mockResolvedValue('denied'))
    render(createElement(SettingsPage))

    fireEvent.click(screen.getByRole('checkbox', { name: '结束提醒' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('桌面通知权限被拒绝')
    expect(useSettingsStore.getState().notificationEnabled).toBe(false)
  })

  it('浏览器不支持 Notification API：说明提示音仍会响，store 保持关闭', async () => {
    render(createElement(SettingsPage))

    fireEvent.click(screen.getByRole('checkbox', { name: '结束提醒' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('此浏览器不支持桌面通知')
    expect(useSettingsStore.getState().notificationEnabled).toBe(false)
  })
})

describe('SettingsPage 提示音开关（工单②）', () => {
  beforeEach(() => {
    window.localStorage.clear()
    vi.stubGlobal('matchMedia', vi.fn().mockImplementation(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })))
    useSettingsStore.setState({ theme: 'system', language: 'zh-CN', isLoaded: false, soundEnabled: true })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('默认选中', async () => {
    render(createElement(SettingsPage))

    expect(await screen.findByRole('checkbox', { name: '提示音' })).toBeChecked()
  })

  it('点击关闭 → store 变 false 且写穿到 localStorage', async () => {
    render(createElement(SettingsPage))

    fireEvent.click(screen.getByRole('checkbox', { name: '提示音' }))

    await waitFor(() => expect(useSettingsStore.getState().soundEnabled).toBe(false))
    expect(window.localStorage.getItem('pxii_settings_soundEnabled')).toBe('false')
  })
})
