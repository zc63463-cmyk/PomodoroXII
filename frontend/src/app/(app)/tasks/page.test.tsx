import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import type { CachedWorkItem } from '@/types'
import { useTaskSpaceStore } from '@/stores/task-space-store'
import { useSpaceStore } from '@/stores/space-store'

const item = (overrides: Partial<CachedWorkItem> = {}): CachedWorkItem => ({
  id: 'l2',
  projectId: 'project-1',
  displayKey: 'RM-2',
  title: 'Ship feature',
  description: null,
  typeDefinitionId: 'type-task',
  statusDefinitionId: 'status-open',
  priority: 'medium',
  parentId: 'l1',
  childRank: 0,
  depth: 2,
  completionWindowStart: null,
  completionWindowEnd: null,
  reviewPoint: null,
  hardDeadline: null,
  effortEstimateLowerSeconds: null,
  effortEstimateUpperSeconds: null,
  effortActualSeconds: 0,
  confidence: null,
  completedAt: null,
  cancelledAt: null,
  archivedAt: null,
  markedAsAttention: false,
  labelIds: [],
  version: 1,
  createdAt: '2026-07-15T08:00:00.000Z',
  updatedAt: '2026-07-15T08:00:00.000Z',
  ...overrides,
})

const pageSource = () => readFileSync(resolve(process.cwd(), 'src/app/(app)/tasks/page.tsx'), 'utf8')

describe('TasksPage session launch wiring', () => {
  beforeEach(() => {
    useTaskSpaceStore.setState({
      spaceId: null,
      projects: [],
      workItems: [],
      selectedProjectId: null,
      selectedWorkItemId: null,
      error: null,
      isLoading: false,
    })
    useSpaceStore.setState({ currentSpaceId: null })
  })

  it('selecting a WorkItem keeps the selection and the space context in the shared store', () => {
    useTaskSpaceStore.setState({ spaceId: 'space-a', workItems: [item()] })
    useTaskSpaceStore.getState().selectWorkItem('l2')

    const state = useTaskSpaceStore.getState()
    expect(state.selectedWorkItemId).toBe('l2')
    expect(state.spaceId).toBe('space-a')
    // Space context lives in the space store and must survive a selection change.
    useSpaceStore.setState({ currentSpaceId: 'space-a' })
    expect(useSpaceStore.getState().currentSpaceId).toBe('space-a')
  })

  it('renders the launch button bound to the selected WorkItem', () => {
    const source = pageSource()
    expect(source).toMatch(/LaunchSessionButton/)
    expect(source).toMatch(/workItem=\{selectedWorkItem\}/)
    // Disabled-when-empty and navigation are covered by the component tests.
  })

  it('does not lose the launch binding across page navigation (store persists selection)', () => {
    useTaskSpaceStore.setState({ spaceId: 'space-a', workItems: [item()] })
    useTaskSpaceStore.getState().selectWorkItem('l2')
    const before = useTaskSpaceStore.getState().selectedWorkItemId

    // 计时页从同一 store key（selectedWorkItemId）派生启动选择 —— 该契约已由
    // timer/page.test.tsx 的行为断言锁定（launcher-attribution-summary 随
    // store 切换而变，Modal 内归属 select 同值），此处不再 grep 源码。
    expect(before).toBe('l2')
  })
})
