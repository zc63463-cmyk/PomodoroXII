import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
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
