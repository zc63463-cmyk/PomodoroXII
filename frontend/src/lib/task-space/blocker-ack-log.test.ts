import { beforeEach, describe, expect, it } from 'vitest'

import { clearBlockerAcks, readBlockerAcks, recordBlockerAck } from './blocker-ack-log'

describe('blocker-ack-log', () => {
  beforeEach(() => {
    clearBlockerAcks()
  })

  it('appends entries with a timestamp and the source entry point', () => {
    recordBlockerAck({ workItemId: 'l2', blockerIds: ['up1', 'up2'], source: 'tasks' })
    recordBlockerAck({ workItemId: 'l3', blockerIds: ['up9'], source: 'timer' })
    const entries = readBlockerAcks()
    expect(entries).toHaveLength(2)
    expect(entries[0]).toMatchObject({ workItemId: 'l2', blockerIds: ['up1', 'up2'], source: 'tasks' })
    expect(entries[1]).toMatchObject({ workItemId: 'l3', source: 'timer' })
    expect(Number.isNaN(Date.parse(entries[0].at))).toBe(false)
  })

  it('preserves an explicitly supplied timestamp', () => {
    recordBlockerAck({
      workItemId: 'l2', blockerIds: [], source: 'tasks', at: '2026-09-11T00:00:00.000Z',
    })
    expect(readBlockerAcks()[0]?.at).toBe('2026-09-11T00:00:00.000Z')
  })

  it('caps the log at the newest 200 entries', () => {
    for (let index = 0; index < 205; index += 1) {
      recordBlockerAck({ workItemId: `wi-${index}`, blockerIds: [], source: 'tasks' })
    }
    const entries = readBlockerAcks()
    expect(entries).toHaveLength(200)
    // 最旧的 5 条被裁掉，保留窗口是连续的。
    expect(entries[0]?.workItemId).toBe('wi-5')
    expect(entries[199]?.workItemId).toBe('wi-204')
  })

  it('degrades to an empty list on corrupted storage', () => {
    window.localStorage.setItem('pxii.blockerAcks.v1', '{not json')
    expect(readBlockerAcks()).toEqual([])
    window.localStorage.setItem('pxii.blockerAcks.v1', JSON.stringify([{ workItemId: 42 }]))
    expect(readBlockerAcks()).toEqual([])
  })
})
