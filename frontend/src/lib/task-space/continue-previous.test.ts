/**
 * 「继续上次」三栏分桶的判别测试。
 *
 * 断言锚在**已确认的三条规则**上：按工作项判定 / 7 天窗按日界分层 / 同一项只出现在最贴近的一层。
 * 所有用例固定 `now`，不依赖真实时钟。
 */
import { describe, expect, it } from 'vitest';

import {
  aggregateEntries,
  bucketContinuePrevious,
  isExcluded,
  type ContinuePreviousEntry,
  type WorkItemRef,
} from './continue-previous';

/** 固定"现在"：2026-09-30 15:00 本地时间。 */
const NOW = new Date(2026, 8, 30, 15, 0, 0); // 月份 0-based → 8 = 9 月
const BOUNDARY = 4; // 日界凌晨 4 点

const iso = (y: number, m: number, d: number, h: number, min = 0): string =>
  new Date(y, m - 1, d, h, min, 0).toISOString();

const w = (id: string, extra: Partial<WorkItemRef> = {}): WorkItemRef => ({ id, ...extra });

const entry = (workItemId: string, lastSessionAt: string, sessionCount = 1): ContinuePreviousEntry => ({
  workItemId,
  lastSessionAt,
  sessionCount,
  focusedSeconds: 1500,
});

describe('isExcluded', () => {
  it('不存在 / 已完成 / 已取消 / 终态类目 一律排除', () => {
    expect(isExcluded(undefined, {})).toBe(true);
    expect(isExcluded(w('a', { completedAt: iso(2026, 9, 30, 10) }), {})).toBe(true);
    expect(isExcluded(w('a', { cancelledAt: iso(2026, 9, 30, 10) }), {})).toBe(true);
    expect(isExcluded(w('a', { statusDefinitionId: 's1' }), { s1: 'completed' })).toBe(true);
    expect(isExcluded(w('a', { statusDefinitionId: 's2' }), { s2: 'in_progress' })).toBe(false);
  });
});

describe('bucketContinuePrevious', () => {
  it('按日界分三层：今日 / 昨日 / 2–7 天', () => {
    const items = [w('a'), w('b'), w('c')];
    const result = bucketContinuePrevious(
      [entry('a', iso(2026, 9, 30, 9)), entry('b', iso(2026, 9, 29, 21)), entry('c', iso(2026, 9, 28, 16))],
      items,
      {},
      { dayBoundaryHour: BOUNDARY, now: NOW },
    );
    expect(result.today.map((e) => e.workItemId)).toEqual(['a']);
    expect(result.yesterday.map((e) => e.workItemId)).toEqual(['b']);
    expect(result.withinWeek.map((e) => e.workItemId)).toEqual(['c']);
  });

  it('7 天窗之外丢弃', () => {
    const result = bucketContinuePrevious(
      [entry('old', iso(2026, 9, 20, 10))],
      [w('old')],
      {},
      { dayBoundaryHour: BOUNDARY, now: NOW },
    );
    expect(result.today).toEqual([]);
    expect(result.yesterday).toEqual([]);
    expect(result.withinWeek).toEqual([]);
  });

  it('同一工作项只出现在最贴近的一层（不会重复）', () => {
    const result = bucketContinuePrevious(
      [entry('a', iso(2026, 9, 30, 9))],
      [w('a')],
      {},
      { dayBoundaryHour: BOUNDARY, now: NOW },
    );
    const all = [...result.today, ...result.yesterday, ...result.withinWeek].map((e) => e.workItemId);
    expect(all).toEqual(['a']);
  });

  it('今日 / 昨日按最近会话时间倒序', () => {
    const result = bucketContinuePrevious(
      [entry('early', iso(2026, 9, 30, 8, 5)), entry('late', iso(2026, 9, 30, 9, 12))],
      [w('early'), w('late')],
      {},
      { dayBoundaryHour: BOUNDARY, now: NOW },
    );
    expect(result.today.map((e) => e.workItemId)).toEqual(['late', 'early']);
  });

  it('七天内堆积按优先级排布（高 > 中 > 低 > 未设），同档按时间倒序', () => {
    const result = bucketContinuePrevious(
      [
        entry('none', iso(2026, 9, 27, 10)),
        entry('low', iso(2026, 9, 28, 10)),
        entry('high', iso(2026, 9, 26, 10)),
        entry('mid', iso(2026, 9, 26, 14)),
      ],
      [
        w('none', { priority: null }),
        w('low', { priority: 'low' }),
        w('high', { priority: 'high' }),
        w('mid', { priority: 'medium' }),
      ],
      {},
      { dayBoundaryHour: BOUNDARY, now: NOW },
    );
    expect(result.withinWeek.map((e) => e.workItemId)).toEqual(['high', 'mid', 'low', 'none']);
  });

  it('终态工作项从三层中一致排除', () => {
    const result = bucketContinuePrevious(
      [entry('done', iso(2026, 9, 30, 9)), entry('live', iso(2026, 9, 30, 8))],
      [w('done', { statusDefinitionId: 's1' }), w('live')],
      { s1: 'completed' },
      { dayBoundaryHour: BOUNDARY, now: NOW },
    );
    expect(result.today.map((e) => e.workItemId)).toEqual(['live']);
  });

  it('每层按时长上限截断', () => {
    // 用 8–12 点：均晚于日界 4 点，确保落在"今日"层
    const entries = [8, 9, 10, 11, 12].map((n) => entry(`t${n}`, iso(2026, 9, 30, n)));
    const result = bucketContinuePrevious(
      entries,
      entries.map((e) => w(e.workItemId)),
      {},
      { dayBoundaryHour: BOUNDARY, now: NOW, maxToday: 2 },
    );
    expect(result.today).toHaveLength(2);
    // 倒序 → 取最新的两条
    expect(result.today.map((e) => e.workItemId)).toEqual(['t12', 't11']);
  });

  it('空输入返回三个空层（不抛错）', () => {
    const result = bucketContinuePrevious([], [], {}, { dayBoundaryHour: BOUNDARY, now: NOW });
    expect(result).toEqual({ today: [], yesterday: [], withinWeek: [] });
  });
});

describe('aggregateEntries（会话聚合）', () => {
  it('同一工作项多次会话：取最近时间、累加次数与专注秒数', () => {
    const contexts = [
      { sessionId: 's1', level2WorkItemId: 'w1' },
      { sessionId: 's2', level2WorkItemId: 'w1' },
      { sessionId: 's3', level2WorkItemId: 'w2' },
    ];
    const sessions = [
      { id: 's1', startedAt: iso(2026, 9, 29, 21), focusedSeconds: 3000 },
      { id: 's2', startedAt: iso(2026, 9, 30, 9), focusedSeconds: 1500 },
      { id: 's3', startedAt: iso(2026, 9, 28, 16), focusedSeconds: 1500 },
    ];
    const result = aggregateEntries(contexts, sessions);
    const w1 = result.find((e) => e.workItemId === 'w1')!;
    expect(w1.sessionCount).toBe(2);
    expect(w1.focusedSeconds).toBe(4500);
    expect(w1.lastSessionAt).toBe(iso(2026, 9, 30, 9));
  });

  it('缺少会话行 / 缺少 level2 / 非法时间 一律跳过', () => {
    const contexts = [
      { sessionId: 'missing', level2WorkItemId: 'w1' },
      { sessionId: 's2' }, // 无 level2
      { sessionId: 's3', level2WorkItemId: 'w3' },
    ];
    const sessions = [
      { id: 's2', startedAt: iso(2026, 9, 30, 9) },
      { id: 's3', startedAt: '' },
    ];
    expect(aggregateEntries(contexts, sessions)).toEqual([]);
  });
});
