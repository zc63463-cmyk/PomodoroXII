import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as reflectionRepository from '@/lib/reflections/reflection-repository'
import * as mapProvider from '@/lib/reflections/daily-map-provider'
import {
  DEFAULT_DAY_BOUNDARY,
  emptyDailyEvidence,
  type DailyEvidenceSnapshot,
} from '@/lib/reflections/daily-evidence'
import type { DailyMapProjection } from '@/lib/reflections/daily-map'
import { buildSessionIsland } from '@/lib/work-map/session-island'
import { useReflectionStore } from '@/stores/reflection-store'
import type { CachedReflection } from '@/types'
import { ReflectionsView } from './reflections-view'

/** 空导图投影（Phase 1 形态：只有会话事实，没有导图）。 */
const EMPTY_MAP: DailyMapProjection = { primary: null, slices: [], hanging: [], level2Count: 0 }

/** 含一个会话岛的 `.mm.md`（用真实的建岛原语造，形状与生产一致）。 */
const TWO_SESSION_DOC = buildSessionIsland('', {
  sessionId: 's1',
  workItemTitle: '导图高度自适应',
  sessionTitle: '10-03 14:00 会话',
  level3Titles: ['修复内层穿透'],
}).text

function reflection(overrides: Partial<CachedReflection> = {}): CachedReflection {
  const now = '2026-09-02T00:00:00.000Z'
  return {
    id: 'r1',
    date: '2026-09-02',
    content: '',
    mood: null,
    tags: [],
    created_at: now,
    updated_at: now,
    content_hash: undefined,
    deletion_state: 'active',
    version: 1,
    _dirty: false,
    ...overrides,
  }
}

/** 一个"有事实"的抽屉快照（1 会话 / 45m / 1 条 L2 投入）。 */
function dailyEvidenceFixture(dateKey: string): DailyEvidenceSnapshot {
  return {
    ...emptyDailyEvidence(dateKey),
    totalFocusedSeconds: 2700,
    sessionCount: 1,
    validCount: 1,
    sessions: [
      {
        sessionId: 's1',
        startedLabel: '14:00',
        endedLabel: '14:45',
        focusedSeconds: 2700,
        level2WorkItemId: 'L2-a',
        titleSnapshot: '导图高度自适应',
        validity: 'valid',
        interrupted: false,
      },
    ],
    byLevel2: [
      { level2WorkItemId: 'L2-a', titleSnapshot: '导图高度自适应', focusedSeconds: 2700, sessionCount: 1 },
    ],
    isEmpty: false,
  }
}

describe('ReflectionsView', () => {
  beforeEach(() => {
    useReflectionStore.getState().reset()
    vi.restoreAllMocks()
    vi.spyOn(reflectionRepository, 'listSyncedReflections').mockResolvedValue([])
    vi.spyOn(reflectionRepository, 'updateReflection').mockImplementation(
      async (id, patch) => reflection({ id, ...patch }),
    )
    vi.spyOn(reflectionRepository, 'deleteReflection').mockResolvedValue(undefined)
    vi.spyOn(reflectionRepository, 'createReflection').mockImplementation(
      async (input) => reflection({ id: input.id, date: input.date }),
    )
  })

  afterEach(cleanup)

  it('空列表时给出引导文案', async () => {
    render(<ReflectionsView />)

    await waitFor(() => {
      expect(screen.getByText(/还没有反思/)).toBeTruthy()
    })
    expect(screen.getByText(/选择一篇反思/)).toBeTruthy()
  })

  it('按月份分组渲染', async () => {
    vi.spyOn(reflectionRepository, 'listSyncedReflections').mockResolvedValue([
      reflection({ id: 'a', date: '2026-08-15' }),
      reflection({ id: 'b', date: '2026-09-10' }),
    ])

    render(<ReflectionsView />)

    await waitFor(() => screen.getByText('2026-09'))
    expect(screen.getByText('2026-08')).toBeTruthy()
  })

  it('选中后载入编辑器并可保存正文', async () => {
    vi.spyOn(reflectionRepository, 'listSyncedReflections').mockResolvedValue([
      reflection({ id: 'a', date: '2026-09-10', content: '旧内容' }),
    ])
    const update = vi.spyOn(reflectionRepository, 'updateReflection').mockImplementation(
      async (id, patch) => reflection({ id, ...patch }),
    )

    render(<ReflectionsView />)
    await waitFor(() => screen.getByText('2026-09-10'))

    fireEvent.click(screen.getByText('2026-09-10'))

    await waitFor(() => {
      const editor = screen.getByPlaceholderText(/写下今天的反思/) as HTMLTextAreaElement
      expect(editor.value).toBe('旧内容')
    })

    const editor = screen.getByPlaceholderText(/写下今天的反思/) as HTMLTextAreaElement
    fireEvent.change(editor, { target: { value: '新内容' } })
    fireEvent.click(screen.getByText('保存'))

    await waitFor(() => {
      expect(update).toHaveBeenCalledWith('a', { content: '新内容' })
    })
  })

  it('切换心情直接落库', async () => {
    vi.spyOn(reflectionRepository, 'listSyncedReflections').mockResolvedValue([
      reflection({ id: 'a', date: '2026-09-10' }),
    ])
    const update = vi.spyOn(reflectionRepository, 'updateReflection').mockImplementation(
      async (id, patch) => reflection({ id, ...patch }),
    )

    render(<ReflectionsView />)
    await waitFor(() => screen.getByText('2026-09-10'))
    fireEvent.click(screen.getByText('2026-09-10'))

    await waitFor(() => screen.getByLabelText('心情'))
    fireEvent.change(screen.getByLabelText('心情'), { target: { value: 'good' } })

    await waitFor(() => {
      expect(update).toHaveBeenCalledWith('a', { mood: 'good' })
    })
  })

  it('删除调用 deleteReflection 并清空选中', async () => {
    vi.spyOn(reflectionRepository, 'listSyncedReflections').mockResolvedValue([
      reflection({ id: 'a', date: '2026-09-10' }),
    ])
    const del = vi.spyOn(reflectionRepository, 'deleteReflection').mockResolvedValue(undefined)

    render(<ReflectionsView />)
    await waitFor(() => screen.getByText('2026-09-10'))
    fireEvent.click(screen.getByText('2026-09-10'))
    await waitFor(() => screen.getByText('删除'))

    fireEvent.click(screen.getByText('删除'))

    await waitFor(() => {
      expect(del).toHaveBeenCalledWith('a')
    })
  })

  // --------------------------------------------------------------------- //
  // 今日事实抽屉接线（Phase 1）
  // --------------------------------------------------------------------- //

  describe('今日事实抽屉接线', () => {
    // 2026-10-03 行为修正：原实现 isEmpty → 抽屉整体消失，与「功能不存在」同形，
    // 用户分不出「今天没记录」和「改了没生效」。改为**始终在位** + 中性说明。
    it('无当日事实时抽屉仍在并说明原因（区分「没记录」与「不存在」）', async () => {
      vi.spyOn(reflectionRepository, 'listSyncedReflections').mockResolvedValue([
        reflection({ id: 'a', date: '2026-09-10' }),
      ])
      vi.spyOn(mapProvider, 'readDailyMapBundle').mockResolvedValue({
        evidence: emptyDailyEvidence('2026-09-10'),
        map: EMPTY_MAP,
      })

      render(<ReflectionsView />)
      await waitFor(() => screen.getByText('2026-09-10'))
      fireEvent.click(screen.getAllByText('2026-09-10')[0] as HTMLElement)

      await waitFor(() => {
        expect(screen.getByTestId('daily-evidence-drawer')).toBeTruthy()
      })
      expect(screen.getByTestId('daily-evidence-empty')).toBeTruthy()
      // 没有事实就没有可注入的内容 → 不给按钮
      expect(screen.queryByTestId('daily-evidence-inject')).toBeNull()
    })

    it('有事实时抽屉出现，且日期跟随选中的反思而不是永远今天', async () => {
      vi.spyOn(reflectionRepository, 'listSyncedReflections').mockResolvedValue([
        reflection({ id: 'a', date: '2026-09-10' }),
      ])
      const read = vi.spyOn(mapProvider, 'readDailyMapBundle').mockResolvedValue({
        evidence: dailyEvidenceFixture('2026-09-10'),
        map: EMPTY_MAP,
      })

      render(<ReflectionsView />)
      await waitFor(() => screen.getByText('2026-09-10'))
      fireEvent.click(screen.getAllByText('2026-09-10')[0] as HTMLElement)

      await waitFor(() => {
        expect(screen.getByTestId('daily-evidence-drawer')).toBeTruthy()
      })
      // 关键：读的是选中那天的日期（否则抽屉与正文对不上）
      expect(read).toHaveBeenCalledWith('2026-09-10', DEFAULT_DAY_BOUNDARY)
    })

    it('一键注入是「追加」且同步草稿基线（不覆盖已写内容）', async () => {
      vi.spyOn(reflectionRepository, 'listSyncedReflections').mockResolvedValue([
        reflection({ id: 'a', date: '2026-09-10', content: '我先写的一段。' }),
      ])
      const update = vi.spyOn(reflectionRepository, 'updateReflection').mockImplementation(
        async (id, patch) => reflection({ id, ...patch }),
      )
      vi.spyOn(mapProvider, 'readDailyMapBundle').mockResolvedValue({
        evidence: dailyEvidenceFixture('2026-09-10'),
        map: EMPTY_MAP,
      })

      render(<ReflectionsView />)
      await waitFor(() => screen.getByText('2026-09-10'))
      fireEvent.click(screen.getAllByText('2026-09-10')[0] as HTMLElement)

      const editor = await waitFor(() =>
        screen.getByPlaceholderText(/写下今天的反思/) as HTMLTextAreaElement,
      )
      await waitFor(() => expect(editor.value).toBe('我先写的一段。'))
      await waitFor(() => screen.getByTestId('daily-evidence-inject'))

      fireEvent.click(screen.getByTestId('daily-evidence-inject'))

      // 写库的内容 = 旧内容 + 空行 + 事实块（追加，不是替换）
      await waitFor(() => {
        expect(update).toHaveBeenCalledTimes(1)
      })
      const [, patch] = update.mock.calls[0] as [string, { content: string }]
      expect(patch.content.startsWith('我先写的一段。')).toBe(true)
      expect(patch.content).toContain('## 今日事实（系统预填）')

      // ★ 草稿基线必须同步 —— 否则用户下次点「保存」会用旧 draft 抹掉注入内容
      await waitFor(() => {
        const next = screen.getByPlaceholderText(/写下今天的反思/) as HTMLTextAreaElement
        expect(next.value).toContain('## 今日事实（系统预填）')
      })

      // 紧接着点保存，写出的必须是含注入内容的新草稿（而不是被抹掉的旧值）
      fireEvent.click(screen.getByText('保存'))
      await waitFor(() => {
        const lastCall = update.mock.calls.at(-1) as [string, { content: string }]
        expect(lastCall[1].content).toContain('## 今日事实（系统预填）')
      })
    })

    it('未选中任何反思时不提供注入入口', async () => {
      vi.spyOn(reflectionRepository, 'listSyncedReflections').mockResolvedValue([
        reflection({ id: 'a', date: '2026-09-10' }),
      ])
      vi.spyOn(mapProvider, 'readDailyMapBundle').mockResolvedValue({
        evidence: dailyEvidenceFixture('2026-09-10'),
        map: EMPTY_MAP,
      })

      render(<ReflectionsView />)
      await waitFor(() => screen.getByText('2026-09-10'))
      // 未点选 → 正文区是引导文案，抽屉的注入按钮应不可用
      await waitFor(() => {
        const button = screen.getByTestId('daily-evidence-inject') as HTMLButtonElement
        expect(button.disabled).toBe(true)
      })
    })

    it('读事实抛错不影响反思页可用（fail-soft）', async () => {
      vi.spyOn(reflectionRepository, 'listSyncedReflections').mockResolvedValue([
        reflection({ id: 'a', date: '2026-09-10', content: '正文仍在' }),
      ])
      vi.spyOn(mapProvider, 'readDailyMapBundle').mockRejectedValue(new Error('db not open'))

      render(<ReflectionsView />)
      await waitFor(() => screen.getByText('2026-09-10'))
      fireEvent.click(screen.getAllByText('2026-09-10')[0] as HTMLElement)

      // 反思页本身照常工作
      const editor = await waitFor(() =>
        screen.getByPlaceholderText(/写下今天的反思/) as HTMLTextAreaElement,
      )
      expect(editor.value).toBe('正文仍在')
    })

    // ----------------------------------------------------------------- //
    // Phase 2：导图侧
    // ----------------------------------------------------------------- //

    it('有导图时渲染今日岛总览并高亮当天会话岛', async () => {
      vi.spyOn(reflectionRepository, 'listSyncedReflections').mockResolvedValue([
        reflection({ id: 'a', date: '2026-09-10' }),
      ])
      const { container } = render(<ReflectionsView />)
      await waitFor(() => screen.getByText('2026-09-10'))
      vi.spyOn(mapProvider, 'readDailyMapBundle').mockResolvedValue({
        evidence: dailyEvidenceFixture('2026-09-10'),
        map: {
          primary: {
            workItemId: 'L3-a',
            title: '导图高度自适应',
            mapText: TWO_SESSION_DOC,
            level2WorkItemId: 'L2-a',
            sessionIds: ['s1'],
          },
          slices: [],
          hanging: [],
          level2Count: 1,
        },
      })
      fireEvent.click(screen.getAllByText('2026-09-10')[0] as HTMLElement)

      await waitFor(() => expect(screen.getByTestId('daily-map-section')).toBeTruthy())
      // 复用 TimerMapOverview：真实组件的 testid 出现 = 零新增渲染代码
      await waitFor(() => expect(screen.getByTestId('timer-map-overview')).toBeTruthy())
      expect(container.querySelectorAll('.wm-island-card--current').length).toBeGreaterThan(0)
    })

    it('跨多个 L2 时显式说明「仅呈现 1 / N」（不假装支持多图）', async () => {
      vi.spyOn(reflectionRepository, 'listSyncedReflections').mockResolvedValue([
        reflection({ id: 'a', date: '2026-09-10' }),
      ])
      render(<ReflectionsView />)
      await waitFor(() => screen.getByText('2026-09-10'))
      vi.spyOn(mapProvider, 'readDailyMapBundle').mockResolvedValue({
        evidence: dailyEvidenceFixture('2026-09-10'),
        map: {
          primary: {
            workItemId: 'L3-a',
            title: '甲',
            mapText: TWO_SESSION_DOC,
            level2WorkItemId: 'L2-a',
            sessionIds: ['s1'],
          },
          slices: [],
          hanging: [],
          level2Count: 2,
        },
      })
      fireEvent.click(screen.getAllByText('2026-09-10')[0] as HTMLElement)

      await waitFor(() => expect(screen.getByText(/仅呈现 1 \/ 2 个工作项/)).toBeTruthy())
    })

    it('导图侧悬挂项进入注入内容，且已升格的不再出现', async () => {
      const update = vi.spyOn(reflectionRepository, 'updateReflection').mockImplementation(
        async (id, patch) => reflection({ id, ...patch }),
      )
      vi.spyOn(reflectionRepository, 'listSyncedReflections').mockResolvedValue([
        reflection({ id: 'a', date: '2026-09-10' }),
      ])
      render(<ReflectionsView />)
      await waitFor(() => screen.getByText('2026-09-10'))
      vi.spyOn(mapProvider, 'readDailyMapBundle').mockResolvedValue({
        evidence: dailyEvidenceFixture('2026-09-10'),
        map: {
          primary: null,
          slices: [],
          hanging: [
            { cid: 'c1', title: '针对 Safari 17 测试', thoughtType: 'todo', sessionId: 's1' },
            { cid: 'c2', title: '[PXII-102] 已升格', thoughtType: 'todo', sessionId: 's1' },
          ],
          level2Count: 1,
        },
      })
      fireEvent.click(screen.getAllByText('2026-09-10')[0] as HTMLElement)
      await waitFor(() => screen.getByTestId('daily-hanging'))

      // 界面上只看到未升格的那条
      expect(screen.getByText(/针对 Safari 17 测试/)).toBeTruthy()
      expect(screen.queryByText(/已升格/)).toBeNull()

      fireEvent.click(screen.getByTestId('daily-evidence-inject'))
      await waitFor(() => expect(update).toHaveBeenCalled())
      const call = update.mock.calls[0] as [string, { content: string }]
      expect(call[1].content).toContain('针对 Safari 17 测试')
      expect(call[1].content).not.toContain('已升格')
    })

    it('无导图时抽屉仍在（只是少一段，事实照样可用）', async () => {
      vi.spyOn(reflectionRepository, 'listSyncedReflections').mockResolvedValue([
        reflection({ id: 'a', date: '2026-09-10' }),
      ])
      render(<ReflectionsView />)
      await waitFor(() => screen.getByText('2026-09-10'))
      vi.spyOn(mapProvider, 'readDailyMapBundle').mockResolvedValue({
        evidence: dailyEvidenceFixture('2026-09-10'),
        map: EMPTY_MAP,
      })
      fireEvent.click(screen.getAllByText('2026-09-10')[0] as HTMLElement)

      await waitFor(() => expect(screen.getByTestId('daily-evidence-drawer')).toBeTruthy())
      expect(screen.queryByTestId('daily-map-section')).toBeNull()
    })
  })
})
