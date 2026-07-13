import { describe, expect, it } from 'vitest'
import { SYNC_PULL_KEYS } from './types'
import {
  SnapshotRecoveryError,
  SyncProtocolError,
  parseSyncAckResponse,
  parseSyncClientRegistrationResponse,
  parseSyncFullResponse,
  parseSyncPullResponse,
} from './protocol'

const emptyEntities = Object.fromEntries(SYNC_PULL_KEYS.map((key) => [key, []]))

function legacyPage() {
  return {
    ...emptyEntities,
    server_time: '2026-07-13T12:00:00.000Z',
    has_more: false,
    tombstones_has_more: false,
    next_since: '2026-07-13T12:00:00.000Z',
    next_since_id: 'task-1',
    next_tombstone_since_id: 'tombstone-1',
    tombstones: [],
  }
}

function v2PullPage() {
  return {
    ...legacyPage(),
    next_since: '',
    next_since_id: '',
    next_tombstone_since_id: '',
    cursor_version: 2,
    next_cursor: 11,
  }
}

function materializedFullPage() {
  return {
    ...legacyPage(),
    next_since: '',
    next_since_id: '',
    next_tombstone_since_id: '',
    cursor_version: 2,
    next_cursor: 20,
    snapshot_token: 'snapshot-20',
    snapshot_offset: 0,
    is_full: true,
  }
}

const legacyContext = {
  requestCursor: null,
  since: '2026-07-12T00:00:00.000Z',
  sinceId: '',
  tombstoneSinceId: '',
} as const

const materializedContext = {
  protocol: null,
  snapshotToken: null,
  expectedSnapshotOffset: 0,
  snapshotCursor: null,
  recoveryRequired: false,
} as const

describe('sync protocol parsers', () => {
  it('接受合法 registration、ACK、legacy pull 与 materialized full', () => {
    expect(parseSyncClientRegistrationResponse({
      client_id: 'client-1', display_name: null, ack_cursor: 4,
      lease_expires_at: '2026-08-01T00:00:00.000Z', snapshot_required: false,
    }, 'client-1').ack_cursor).toBe(4)
    expect(parseSyncAckResponse({
      ack_cursor: 4, retention_floor: 2, current_cursor: 5,
      lease_expires_at: '2026-08-01T00:00:00.000Z',
    }, 4).ack_cursor).toBe(4)
    expect(parseSyncPullResponse(legacyPage(), legacyContext).cursor_version).toBeUndefined()
    expect(parseSyncPullResponse(v2PullPage(), { ...legacyContext, requestCursor: 10 }).next_cursor).toBe(11)
    expect(parseSyncFullResponse(materializedFullPage(), materializedContext).is_full).toBe(true)
  })

  it('拒绝缺实体 key、实体缺 id/updated_at 与未知 tombstone', () => {
    const missingKey = { ...legacyPage() } as Record<string, unknown>
    delete missingKey.tasks
    expect(() => parseSyncPullResponse(missingKey, legacyContext)).toThrow(SyncProtocolError)
    expect(() => parseSyncPullResponse({ ...legacyPage(), tasks: [{ updated_at: '2026-01-01T00:00:00Z' }] }, legacyContext)).toThrow(SyncProtocolError)
    expect(() => parseSyncPullResponse({ ...legacyPage(), tasks: [{ id: 't1', updated_at: 'bad' }] }, legacyContext)).toThrow(SyncProtocolError)
    expect(() => parseSyncPullResponse({
      ...legacyPage(),
      tombstones: [{ entity_type: 'unknown', entity_id: 'x', deleted_at: '2026-01-01T00:00:00Z' }],
    }, legacyContext)).toThrow(SyncProtocolError)
  })

  it('拒绝非 boolean flags、v2 cursor 不推进及 v2 snapshot 字段', () => {
    expect(() => parseSyncPullResponse({ ...legacyPage(), has_more: 0 }, legacyContext)).toThrow(SyncProtocolError)
    expect(() => parseSyncPullResponse({ ...v2PullPage(), next_cursor: 10, has_more: true }, {
      ...legacyContext, requestCursor: 10,
    })).toThrow(SyncProtocolError)
    expect(() => parseSyncPullResponse({ ...v2PullPage(), snapshot_token: 'forbidden' }, {
      ...legacyContext, requestCursor: 10,
    })).toThrow(SyncProtocolError)
  })

  it('拒绝 materialized full 缺 token、continuation 或 proof', () => {
    expect(() => parseSyncFullResponse({ ...materializedFullPage(), snapshot_token: undefined }, materializedContext)).toThrow(SnapshotRecoveryError)
    expect(() => parseSyncFullResponse({
      ...materializedFullPage(), has_more: true, snapshot_offset: 1,
    }, materializedContext)).toThrow(SnapshotRecoveryError)
    expect(() => parseSyncFullResponse({
      ...materializedFullPage(), recovery_proof: undefined,
    }, { ...materializedContext, recoveryRequired: true })).toThrow(SnapshotRecoveryError)
  })

  it('拒绝畸形 registration 与 ACK，包括无效 ISO timestamp 和 ACK cursor 不匹配', () => {
    expect(() => parseSyncClientRegistrationResponse({
      client_id: 'other', display_name: null, ack_cursor: 0,
      lease_expires_at: 'not-a-date', snapshot_required: false,
    }, 'client-1')).toThrow(SyncProtocolError)
    expect(() => parseSyncAckResponse({
      ack_cursor: 5, retention_floor: 0, current_cursor: 5,
      lease_expires_at: 'not-a-date',
    }, 4)).toThrow(SyncProtocolError)
  })

  it('拒绝终页 cursor 倒退、续页 terminal offset 原地不动及缺 tombstones', () => {
    expect(() => parseSyncPullResponse({ ...v2PullPage(), next_cursor: 9 }, {
      ...legacyContext, requestCursor: 10,
    })).toThrow(SyncProtocolError)
    expect(() => parseSyncFullResponse({
      ...materializedFullPage(), snapshot_token: 'snapshot-20', snapshot_offset: 1,
    }, {
      ...materializedContext,
      protocol: 'materialized',
      snapshotToken: 'snapshot-20',
      expectedSnapshotOffset: 1,
      snapshotCursor: 20,
    })).toThrow(SnapshotRecoveryError)
    const missingTombstones = { ...legacyPage() } as Record<string, unknown>
    delete missingTombstones.tombstones
    expect(() => parseSyncPullResponse(missingTombstones, legacyContext)).toThrow(SyncProtocolError)
  })

  it('拒绝缺少实体组真实领域字段的行，即使携带未知字段', () => {
    expect(() => parseSyncPullResponse({
      ...legacyPage(),
      tasks: [{
        id: 't1', updated_at: '2026-01-01T00:00:00Z', version: 1, unexpected: true,
      }],
    }, legacyContext)).toThrow(SyncProtocolError)
  })

  it('严格校验 legacy continuation 与 full 模式互斥', () => {
    expect(() => parseSyncPullResponse({ ...legacyPage(), has_more: true }, {
      ...legacyContext,
      since: '2026-07-13T12:00:00.000Z',
      sinceId: 'task-1',
      tombstoneSinceId: 'tombstone-1',
    })).toThrow(SyncProtocolError)
    expect(() => parseSyncPullResponse({
      ...legacyPage(),
      next_since: '2026-07-11T00:00:00.000Z',
    }, legacyContext)).toThrow(SyncProtocolError)
    expect(() => parseSyncFullResponse({ ...legacyPage(), is_full: false }, materializedContext)).toThrow(SyncProtocolError)
    expect(() => parseSyncFullResponse({ ...materializedFullPage(), recovery_proof: 'unexpected' }, materializedContext)).toThrow(SnapshotRecoveryError)
  })

  const timestamp = '2026-07-13T12:00:00.000Z'
  const common = (id: string) => ({ id, created_at: timestamp, updated_at: timestamp, version: 1 })
  const entityFixtures = {
    tasks: {
      ...common('legacy-task-1'), title: 'Task', description: '', status: 'todo', priority: 'medium',
      tags: ['sync'], plan: '', completion: '', due_date: null, estimated_pomodoros: 1,
      actual_pomodoros: 0, archived_at: null,
    },
    sessions: {
      ...common('legacy-session-1'), task_id: null, type: 'work', duration: 1500, completed: true,
      plan: '', completion: '', started_at: timestamp, ended_at: timestamp, mood: 'good', note: '',
      attention_score: 80, flow_state_detected: true, flow_state_confidence: 0.8,
      interruption_count: 0, total_interruption_duration: 0, avg_recovery_time: null,
      pause_count: 0, total_pause_duration: 0, cognitive_mark_summary: '{"focus":2}',
    },
    notes: {
      ...common('legacy-note-1'), title: 'Note', content_hash: '', word_count: 2, summary: '',
      tags: ['sync'], category: null, folder_id: null, status: 'active', trashed_at: null,
      content: 'body', content_missing: false,
    },
    folders: {
      ...common('legacy-folder-1'), name: 'Folder', parent_id: null, icon: null, color: null,
      sort_order: 0, is_system: false, trashed_at: null,
    },
    quickNotes: {
      ...common('legacy-quick-1'), content: 'Quick', mood: 'normal', tags: ['sync'], pinned: false,
      archived_at: null, archive_file_path: null, folder_id: null, trashed_at: null,
      migrated_to_note_id: null, session_id: null,
    },
    reflections: {
      ...common('legacy-reflection-1'), date: '2026-07-13', content: 'Review', mood: 'great',
      related_task_ids: '["legacy-task-1"]', tags: ['sync'],
      sections: '[{"id":"s1","type":"text","title":"T","content":"C","order":0}]',
      is_structured: true, auto_linked_session_ids: '["legacy-session-1"]',
    },
    habits: {
      ...common('legacy-habit-1'), title: 'Habit', description: '', color: '#7F77DD', icon: 'H',
      target_count: 1, rest_day_protection: true, rest_days: '[0,6]', sort_order: 0, archived: false,
    },
    habitCheckIns: {
      ...common('legacy-check-in-1'), habit_id: 'legacy-habit-1', date: '2026-07-13', count: 1, note: '',
    },
    schedules: {
      ...common('legacy-schedule-1'), title: 'Schedule', due_at: timestamp, completed_at: null,
      priority: 'medium', color: '#3b82f6', all_day: false, start_time: '09:00', end_time: '10:00',
    },
    timeBlocks: {
      ...common('legacy-block-1'), task_id: null, title: 'Block', date: '2026-07-13',
      start_time: '09:00', end_time: '10:00', planned_duration: 3600, actual_duration: 0,
      block_type: 'work', status: 'planned', sort_order: 0,
    },
    memoComments: {
      ...common('legacy-comment-1'), note_id: 'legacy-quick-1', content: 'Comment',
    },
    sessionQuickNotes: {
      ...common('legacy-session-link-1'), session_id: 'legacy-session-1', quick_note_id: 'legacy-quick-1',
    },
    scheduleQuickNotes: {
      ...common('legacy-schedule-link-1'), schedule_id: 'legacy-schedule-1', quick_note_id: 'legacy-quick-1',
    },
    taskQuickNotes: {
      ...common('legacy-task-link-1'), task_id: 'legacy-task-1', quick_note_id: 'legacy-quick-1',
    },
  } as const

  const malformedFixtures: Record<keyof typeof entityFixtures, Record<string, unknown>> = {
    tasks: { ...entityFixtures.tasks, status: 'invalid' },
    sessions: { ...entityFixtures.sessions, completed: 'yes' },
    notes: { ...entityFixtures.notes, content_missing: true, content: 'contradiction' },
    folders: { ...entityFixtures.folders, sort_order: 0.5 },
    quickNotes: { ...entityFixtures.quickNotes, pinned: 'false' },
    reflections: { ...entityFixtures.reflections, date: '2026-99-99' },
    habits: { ...entityFixtures.habits, rest_days: '["monday"]' },
    habitCheckIns: { ...entityFixtures.habitCheckIns, count: 1.5 },
    schedules: { ...entityFixtures.schedules, priority: 'urgent' },
    timeBlocks: { ...entityFixtures.timeBlocks, block_type: 'meeting' },
    memoComments: { ...entityFixtures.memoComments, version: 1.5 },
    sessionQuickNotes: { ...entityFixtures.sessionQuickNotes, quick_note_id: 42 },
    scheduleQuickNotes: { ...entityFixtures.scheduleQuickNotes, quick_note_id: 42 },
    taskQuickNotes: { ...entityFixtures.taskQuickNotes, quick_note_id: 42 },
  }

  it.each(Object.entries(entityFixtures))('接受 %s 服务端 wire fixture 并规范化为 merge input', (key, fixture) => {
    const parsed = parseSyncPullResponse({ ...legacyPage(), [key]: [fixture] }, legacyContext)
    expect(parsed[key as keyof typeof entityFixtures]).toHaveLength(1)
  })

  it.each(Object.entries(malformedFixtures))('拒绝 %s 的关键畸形字段', (key, fixture) => {
    expect(() => parseSyncPullResponse({ ...legacyPage(), [key]: [fixture] }, legacyContext)).toThrow(SyncProtocolError)
  })

  it('Pull 与 Full 复用同一实体规则', () => {
    const malformed = { ...entityFixtures.tasks, status: 'invalid' }
    expect(() => parseSyncPullResponse({ ...legacyPage(), tasks: [malformed] }, legacyContext)).toThrow(SyncProtocolError)
    expect(() => parseSyncFullResponse({ ...materializedFullPage(), tasks: [malformed] }, materializedContext)).toThrow(SnapshotRecoveryError)
  })

  it('未知实体与 entity_type/payload 语义错配均 fail-closed', () => {
    expect(() => parseSyncPullResponse({ ...legacyPage(), widgets: [] }, legacyContext)).toThrow(SyncProtocolError)
    expect(() => parseSyncPullResponse({
      ...legacyPage(),
      tasks: [{ ...entityFixtures.notes, entity_type: 'note' }],
    }, legacyContext)).toThrow(SyncProtocolError)
  })

  it('Note content_missing 仅允许空正文，完整正文保持合法', () => {
    expect(parseSyncPullResponse({
      ...legacyPage(),
      notes: [{ ...entityFixtures.notes, content: '', content_missing: true }],
    }, legacyContext).notes).toHaveLength(1)
    expect(() => parseSyncPullResponse({
      ...legacyPage(),
      notes: [{ ...entityFixtures.notes, content: 'body', content_missing: true }],
    }, legacyContext)).toThrow(SyncProtocolError)
  })

  it('删除仅通过严格 tombstone envelope 表示，不放宽 upsert payload', () => {
    expect(parseSyncPullResponse({
      ...legacyPage(),
      tombstones: [{ entity_type: 'task', entity_id: 'legacy-task-1', deleted_at: timestamp }],
    }, legacyContext).tombstones).toHaveLength(1)
    expect(() => parseSyncPullResponse({
      ...legacyPage(),
      tombstones: [{
        entity_type: 'task', entity_id: 'legacy-task-1', deleted_at: timestamp, payload: {},
      }],
    }, legacyContext)).toThrow(SyncProtocolError)
  })

  it('接受后端真实允许的独立 nullable 时间与 ISO TimeBlock，并拒绝非 wire 时间', () => {
    expect(parseSyncPullResponse({
      ...legacyPage(),
      schedules: [{ ...entityFixtures.schedules, start_time: '09:00', end_time: null }],
    }, legacyContext).schedules).toHaveLength(1)
    expect(parseSyncPullResponse({
      ...legacyPage(),
      timeBlocks: [{
        ...entityFixtures.timeBlocks,
        start_time: '2026-07-13T09:00:00.000Z',
        end_time: '2026-07-13T10:00:00.000Z',
      }],
    }, legacyContext).timeBlocks).toHaveLength(1)
    expect(() => parseSyncPullResponse({
      ...legacyPage(),
      timeBlocks: [{ ...entityFixtures.timeBlocks, start_time: 'tomorrow morning' }],
    }, legacyContext)).toThrow(SyncProtocolError)
  })

  it('保留合法 cognitive_mark_summary 字符串，规范化兼容的数值对象 JSON', () => {
    const plain = parseSyncPullResponse({
      ...legacyPage(),
      sessions: [{ ...entityFixtures.sessions, cognitive_mark_summary: 'deep focus' }],
    }, legacyContext)
    expect((plain.sessions as Array<Record<string, unknown>>)[0]?.cognitive_mark_summary).toBe('deep focus')
    const structured = parseSyncPullResponse({ ...legacyPage(), sessions: [entityFixtures.sessions] }, legacyContext)
    expect((structured.sessions as Array<Record<string, unknown>>)[0]?.cognitive_mark_summary).toEqual({ focus: 2 })
  })

  it('materialized Full 禁止 content_missing 占位 Note，增量 Pull 仍允许安全占位', () => {
    const missingContentNote = { ...entityFixtures.notes, content: '', content_missing: true }
    expect(parseSyncPullResponse({
      ...v2PullPage(), notes: [missingContentNote],
    }, { ...legacyContext, requestCursor: 10 }).notes).toHaveLength(1)
    expect(() => parseSyncFullResponse({
      ...materializedFullPage(), notes: [missingContentNote],
    }, materializedContext)).toThrow(SnapshotRecoveryError)
  })
})
