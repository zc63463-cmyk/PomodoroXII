/**
 * Business stores reset tests (F0 §7.3.3–7.3.19).
 *
 * Each store's reset() must restore initial state.
 * Uses setState to mutate, then verifies reset restores defaults.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { useAppStore } from '@/stores/app-store'
import { useTimerStore } from '@/stores/timer-store'
import { useSessionStore } from '@/stores/session-store'
import { useTaskStore } from '@/stores/task-store'
import { useNoteStore } from '@/stores/note-store'
import { useQuickNoteStore } from '@/stores/quick-note-store'
import { useFolderStore } from '@/stores/folder-store'
import { useHabitStore } from '@/stores/habit-store'
import { useScheduleStore } from '@/stores/schedule-store'
import { useTimeBlockStore } from '@/stores/time-block-store'
import { useReflectionStore } from '@/stores/reflection-store'
import { useStatsStore } from '@/stores/stats-store'
import { useSearchStore } from '@/stores/search-store'
import { useTrashStore } from '@/stores/trash-store'
import { useSyncStore } from '@/stores/sync-store'
import { useSettingsStore } from '@/stores/settings-store'

describe('business stores reset', () => {
  beforeEach(() => {
    // Reset all stores before each test to ensure isolation
    useAppStore.getState().reset()
    useTimerStore.getState().reset()
    useSessionStore.getState().reset()
    useTaskStore.getState().reset()
    useNoteStore.getState().reset()
    useQuickNoteStore.getState().reset()
    useFolderStore.getState().reset()
    useHabitStore.getState().reset()
    useScheduleStore.getState().reset()
    useTimeBlockStore.getState().reset()
    useReflectionStore.getState().reset()
    useStatsStore.getState().reset()
    useSearchStore.getState().reset()
    useTrashStore.getState().reset()
    useSyncStore.getState().reset()
    useSettingsStore.getState().reset()
  })

  it('app-store reset restores isOnline', () => {
    useAppStore.setState({ isOnline: false })
    useAppStore.getState().reset()
    expect(useAppStore.getState().isOnline).toBe(true)
  })

  it('timer-store reset restores mode, status, duration, remaining, activeSessionId', () => {
    useTimerStore.setState({
      mode: 'countdown',
      status: 'running',
      duration: 300,
      remaining: 120,
      activeSessionId: 'sess-1',
    })
    useTimerStore.getState().reset()
    expect(useTimerStore.getState().mode).toBe('pomodoro')
    expect(useTimerStore.getState().status).toBe('idle')
    expect(useTimerStore.getState().duration).toBe(1500)
    expect(useTimerStore.getState().remaining).toBe(1500)
    expect(useTimerStore.getState().activeSessionId).toBeNull()
  })

  it('session-store reset restores sessions, isLoading, error', () => {
    useSessionStore.setState({
      sessions: [{ id: 's1' } as never],
      isLoading: true,
      error: 'test',
    })
    useSessionStore.getState().reset()
    expect(useSessionStore.getState().sessions).toEqual([])
    expect(useSessionStore.getState().isLoading).toBe(false)
    expect(useSessionStore.getState().error).toBeNull()
  })

  it('task-store reset restores tasks, tags, taskTags, taskRelations, isLoading, error', () => {
    useTaskStore.setState({
      tasks: [{ id: 't1' } as never],
      tags: [{ id: 'g1' } as never],
      taskTags: [{ id: 'tt1' } as never],
      taskRelations: [{ id: 'tr1' } as never],
      isLoading: true,
      error: 'test',
    })
    useTaskStore.getState().reset()
    expect(useTaskStore.getState().tasks).toEqual([])
    expect(useTaskStore.getState().tags).toEqual([])
    expect(useTaskStore.getState().taskTags).toEqual([])
    expect(useTaskStore.getState().taskRelations).toEqual([])
    expect(useTaskStore.getState().isLoading).toBe(false)
    expect(useTaskStore.getState().error).toBeNull()
  })

  it('note-store reset restores notes, comments, currentNoteId, isLoading, error', () => {
    useNoteStore.setState({
      notes: [{ id: 'n1' } as never],
      comments: [{ id: 'c1' } as never],
      currentNoteId: 'n1',
      isLoading: true,
      error: 'test',
    })
    useNoteStore.getState().reset()
    expect(useNoteStore.getState().notes).toEqual([])
    expect(useNoteStore.getState().comments).toEqual([])
    expect(useNoteStore.getState().currentNoteId).toBeNull()
    expect(useNoteStore.getState().isLoading).toBe(false)
    expect(useNoteStore.getState().error).toBeNull()
  })

  it('quick-note-store reset restores quickNotes, isLoading, error', () => {
    useQuickNoteStore.setState({
      quickNotes: [{ id: 'q1' } as never],
      isLoading: true,
      error: 'test',
    })
    useQuickNoteStore.getState().reset()
    expect(useQuickNoteStore.getState().quickNotes).toEqual([])
    expect(useQuickNoteStore.getState().isLoading).toBe(false)
    expect(useQuickNoteStore.getState().error).toBeNull()
  })

  it('folder-store reset restores folders, noteCounts, isLoading', () => {
    useFolderStore.setState({
      folders: [{ id: 'f1' } as never],
      noteCounts: { f1: 5 },
      isLoading: true,
    })
    useFolderStore.getState().reset()
    expect(useFolderStore.getState().folders).toEqual([])
    expect(useFolderStore.getState().noteCounts).toEqual({})
    expect(useFolderStore.getState().isLoading).toBe(false)
  })

  it('habit-store reset restores habits, checkIns, isLoading', () => {
    useHabitStore.setState({
      habits: [{ id: 'h1' } as never],
      checkIns: [{ id: 'ci1' } as never],
      isLoading: true,
    })
    useHabitStore.getState().reset()
    expect(useHabitStore.getState().habits).toEqual([])
    expect(useHabitStore.getState().checkIns).toEqual([])
    expect(useHabitStore.getState().isLoading).toBe(false)
  })

  it('schedule-store reset restores schedules, isLoading', () => {
    useScheduleStore.setState({
      schedules: [{ id: 'sc1' } as never],
      isLoading: true,
    })
    useScheduleStore.getState().reset()
    expect(useScheduleStore.getState().schedules).toEqual([])
    expect(useScheduleStore.getState().isLoading).toBe(false)
  })

  it('time-block-store reset restores timeBlocks, isLoading', () => {
    useTimeBlockStore.setState({
      timeBlocks: [{ id: 'tb1' } as never],
      isLoading: true,
    })
    useTimeBlockStore.getState().reset()
    expect(useTimeBlockStore.getState().timeBlocks).toEqual([])
    expect(useTimeBlockStore.getState().isLoading).toBe(false)
  })

  it('reflection-store reset restores reflections, templates, isLoading', () => {
    useReflectionStore.setState({
      reflections: [{ id: 'r1' } as never],
      templates: [{ id: 'tpl1' } as never],
      isLoading: true,
    })
    useReflectionStore.getState().reset()
    expect(useReflectionStore.getState().reflections).toEqual([])
    expect(useReflectionStore.getState().templates).toEqual([])
    expect(useReflectionStore.getState().isLoading).toBe(false)
  })

  it('stats-store reset restores overview, focusTrend, taskDistribution, isLoading', () => {
    useStatsStore.setState({
      overview: { totalSessions: 10 } as never,
      focusTrend: [{ date: '2026-01-01' } as never],
      taskDistribution: [{ status: 'done', count: 5 } as never],
      isLoading: true,
    })
    useStatsStore.getState().reset()
    expect(useStatsStore.getState().overview).toBeNull()
    expect(useStatsStore.getState().focusTrend).toEqual([])
    expect(useStatsStore.getState().taskDistribution).toEqual([])
    expect(useStatsStore.getState().isLoading).toBe(false)
  })

  it('search-store reset restores query, results, isSearching, searchScope', () => {
    useSearchStore.setState({
      query: 'test',
      results: [{ id: 'r1' } as never],
      isSearching: true,
      searchScope: 'tasks',
    })
    useSearchStore.getState().reset()
    expect(useSearchStore.getState().query).toBe('')
    expect(useSearchStore.getState().results).toEqual([])
    expect(useSearchStore.getState().isSearching).toBe(false)
    expect(useSearchStore.getState().searchScope).toBe('all')
  })

  it('trash-store reset restores trashedNotes, trashedQuickNotes, trashedFolders, isLoading', () => {
    useTrashStore.setState({
      trashedNotes: [{ id: 'n1' } as never],
      trashedQuickNotes: [{ id: 'q1' } as never],
      trashedFolders: [{ id: 'f1' } as never],
      isLoading: true,
    })
    useTrashStore.getState().reset()
    expect(useTrashStore.getState().trashedNotes).toEqual([])
    expect(useTrashStore.getState().trashedQuickNotes).toEqual([])
    expect(useTrashStore.getState().trashedFolders).toEqual([])
    expect(useTrashStore.getState().isLoading).toBe(false)
  })

  it('sync-store reset restores status, lastSyncedAt, pendingCount, error, conflicts', () => {
    useSyncStore.setState({
      status: 'error',
      lastSyncedAt: '2026-01-01',
      pendingCount: 5,
      error: 'test',
      conflicts: [{ index: 0 } as never],
    })
    useSyncStore.getState().reset()
    expect(useSyncStore.getState().status).toBe('idle')
    expect(useSyncStore.getState().lastSyncedAt).toBeNull()
    expect(useSyncStore.getState().pendingCount).toBe(0)
    expect(useSyncStore.getState().error).toBeNull()
    expect(useSyncStore.getState().conflicts).toEqual([])
  })

  it('settings-store reset restores space-level fields but preserves theme and language (F0 R7-2)', () => {
    // Set non-default theme and language before reset
    useSettingsStore.setState({
      pomodoroDuration: 50,
      shortBreakDuration: 10,
      longBreakDuration: 30,
      longBreakInterval: 6,
      autoStartBreaks: true,
      autoStartPomodoros: true,
      soundEnabled: false,
      theme: 'dark',
      language: 'en',
      isLoaded: true,
    })
    useSettingsStore.getState().reset()
    // Space-level fields reset
    expect(useSettingsStore.getState().pomodoroDuration).toBe(25)
    expect(useSettingsStore.getState().shortBreakDuration).toBe(5)
    expect(useSettingsStore.getState().longBreakDuration).toBe(15)
    expect(useSettingsStore.getState().longBreakInterval).toBe(4)
    expect(useSettingsStore.getState().autoStartBreaks).toBe(false)
    expect(useSettingsStore.getState().autoStartPomodoros).toBe(false)
    expect(useSettingsStore.getState().soundEnabled).toBe(true)
    expect(useSettingsStore.getState().isLoaded).toBe(false)
    // Global fields preserved (F0 R7-2)
    expect(useSettingsStore.getState().theme).toBe('dark')
    expect(useSettingsStore.getState().language).toBe('en')
  })
})
