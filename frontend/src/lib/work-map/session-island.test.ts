/**
 * 会话建岛（ADR-0008 D3/D4）——移植精简版的判别测试。
 *
 * 断言锚在**协议可观察行为**上：生成的文本必须能被本项目自己的根块解析器读回，
 * 条目的 `at` / `cid` / `session_id` 必须与输入一致，且既有正文一字不动。
 */
import { describe, expect, it } from 'vitest';

import { extractRootNoteBlock, parseRootNote, parseNodeNoteFields } from './mm-note';
import { buildSessionIsland, hasSessionIsland } from './session-island';

/** 一份已有两个岛的既有导图（结构取自真实工作项的导图形态）。 */
const EXISTING_MAP = `<!--
next_cid: 3
centers:
  - at: "node:探索小窗实现方式/09-28 会话"
    cid: c1
    dir: right
    session_id: "sess-1"
  - at: "node:探索小窗实现方式/09-29 会话"
    cid: c2
    dir: right
    session_id: "sess-2"
sections:
  - id: sec_core
    title: 已落地
-->
# 探索小窗实现方式

## 技术选型

### 独立窗口 vs 内嵌面板
`;

const INPUT = {
  sessionId: 'sess-3',
  workItemTitle: '探索小窗实现方式',
  sessionTitle: '09-30 21:50 会话',
  level3Titles: ['体验：使用过程中的卡点分析记录'],
};

describe('buildSessionIsland', () => {
  it('空文本时生成一份合法文档（H1 + 根块 + 会话节点）', () => {
    const result = buildSessionIsland('', INPUT);

    expect(result.changed).toBe(true);
    expect(result.cid).toBe('c1');
    expect(result.text).toContain('# 探索小窗实现方式');
    expect(result.text).toContain('## 09-30 21:50 会话');
    expect(result.text).toContain('### 体验：使用过程中的卡点分析记录');

    // 生成物必须能被自己的解析器读回
    const block = extractRootNoteBlock(result.text);
    expect(block).not.toBeNull();
    const model = parseRootNote(block!.body);
    expect(model.nextCid).toBe(2);
    expect(model.centers).toEqual([
      {
        at: 'node:探索小窗实现方式/09-30 21:50 会话',
        cid: 'c1',
        dir: 'right',
        session_id: 'sess-3',
      },
    ]);
  });

  it('既有导图上追加：cid 续号、既有正文一字不动', () => {
    const result = buildSessionIsland(EXISTING_MAP, INPUT);

    expect(result.changed).toBe(true);
    expect(result.cid).toBe('c3');

    // 既有内容保留
    expect(result.text).toContain('## 技术选型');
    expect(result.text).toContain('### 独立窗口 vs 内嵌面板');
    expect(result.text).toContain('cid: c1');
    expect(result.text).toContain('cid: c2');
    // 既有 sections 块原样带出（未知键不丢）
    expect(result.text).toContain('sections:');
    expect(result.text).toContain('title: 已落地');

    const model = parseRootNote(extractRootNoteBlock(result.text)!.body);
    expect(model.nextCid).toBe(4);
    expect(model.centers).toHaveLength(3);
    expect(model.centers[2].session_id).toBe('sess-3');
    expect(model.centers[2].cid).toBe('c3');
  });

  it('节点自己的 cid 与 session_id 都写入了（两处同写）', () => {
    const result = buildSessionIsland(EXISTING_MAP, INPUT);
    const afterHeader = result.text.split('## 09-30 21:50 会话')[0];
    const blockStart = afterHeader.lastIndexOf('<!--');
    const block = afterHeader.slice(blockStart);
    const fields = parseNodeNoteFields(
      block.replace('<!--', '').replace('-->', ''),
    );
    expect(fields.cid).toBe('c3');
    expect(fields.session_id).toBe('sess-3');
  });

  it('同一会话重复建岛是幂等的（不产生第二个岛）', () => {
    const first = buildSessionIsland(EXISTING_MAP, INPUT);
    const second = buildSessionIsland(first.text, INPUT);

    expect(first.changed).toBe(true);
    expect(second.changed).toBe(false);
    expect(second.reason).toBe('session_island_exists');
    expect(second.text).toBe(first.text);
  });

  it('不同会话依次建岛：cid 单调递增，岛数线性增长', () => {
    const a = buildSessionIsland(EXISTING_MAP, { ...INPUT, sessionId: 'sess-3', sessionTitle: '09-30 会话' });
    const b = buildSessionIsland(a.text, { ...INPUT, sessionId: 'sess-4', sessionTitle: '10-01 会话' });

    const model = parseRootNote(extractRootNoteBlock(b.text)!.body);
    expect(model.centers.map((c) => c.cid)).toEqual(['c1', 'c2', 'c3', 'c4']);
    expect(model.centers.map((c) => c.session_id)).toEqual(['sess-1', 'sess-2', 'sess-3', 'sess-4']);
    expect(model.nextCid).toBe(5);
  });

  it('没有 H1 的正文不猜测、不改写（fail-soft）', () => {
    const broken = '## 只有二级标题\n\n- 列表项\n';
    const result = buildSessionIsland(broken, INPUT);

    expect(result.changed).toBe(false);
    expect(result.reason).toBe('root_title_missing');
    expect(result.text).toBe(broken);
  });

  it('缺少 sessionId 时拒绝建岛（幂等键不可缺）', () => {
    const result = buildSessionIsland(EXISTING_MAP, { ...INPUT, sessionId: '   ' });
    expect(result.changed).toBe(false);
    expect(result.reason).toBe('missing_session_id');
    expect(result.text).toBe(EXISTING_MAP);
  });

  it('标题含引号与冒号时 YAML 正确转义且可读回', () => {
    const result = buildSessionIsland('', {
      sessionId: 'sess-quote',
      workItemTitle: '带"引号"的标题',
      sessionTitle: '会话: 冒号 & "引号"',
    });

    expect(result.changed).toBe(true);
    const model = parseRootNote(extractRootNoteBlock(result.text)!.body);
    expect(model.centers[0].at).toBe('node:带"引号"的标题/会话: 冒号 & "引号"');
    expect(model.centers[0].session_id).toBe('sess-quote');
    // 转义后不应产生多余的结构（条目数仍为 1）
    expect(model.centers).toHaveLength(1);
  });

  it('标题中的换行被压平（标题会进 H1/H2 与路径锚）', () => {
    const result = buildSessionIsland('', {
      sessionId: 'sess-nl',
      workItemTitle: '标题\n带换行',
      sessionTitle: '会话\t带制表符',
    });
    expect(result.text).toContain('# 标题 带换行');
    expect(result.text).toContain('## 会话 带制表符');
  });

  it('显式坐标成对写入；缺省则不写坐标（交给自动布局）', () => {
    const withPos = buildSessionIsland(EXISTING_MAP, { ...INPUT, x: 900, y: 0 });
    expect(withPos.text).toContain('x: 900');
    expect(withPos.text).toContain('y: 0');

    const noPos = buildSessionIsland(EXISTING_MAP, { ...INPUT, sessionId: 'sess-nopos' });
    const model = parseRootNote(extractRootNoteBlock(noPos.text)!.body);
    expect(model.centers[2].x).toBeUndefined();
    expect(model.centers[2].y).toBeUndefined();
  });
});

describe('hasSessionIsland', () => {
  it('按 session_id 判定，且不做任何写入', () => {
    expect(hasSessionIsland(EXISTING_MAP, 'sess-1')).toBe(true);
    expect(hasSessionIsland(EXISTING_MAP, 'sess-absent')).toBe(false);
    expect(hasSessionIsland('', 'sess-1')).toBe(false);
  });
});
