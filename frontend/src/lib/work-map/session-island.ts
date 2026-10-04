/**
 * 会话建岛（ADR-0008 D3 / D4）——把一次会话追加成 `.mm.md` 上的一个岛。
 *
 * 语义（严格 1:1）：
 * - 一次会话 = 一个岛；岛根是**新建的会话节点**（不升格工作项本身——
 *   一个节点只能有一个 `cid`，多次会话会冲突）
 * - 岛需要在 `.mm.md` 中**两处同写**：文档根块的 `centers` 条目 + 会话节点自己的 `note.cid`
 *   （S0 实测：缺任一处即 `dangling`）
 *
 * 幂等：以 `session_id`（集成特化字段）为键 —— 同一会话重复调用不产生第二个岛。
 *
 * 失败策略（ADR-0008 不变量 4）：**任何异常都 fail-soft**，返回原文并带 `reason`；
 * 导图是辅助能力，绝不能反向阻断会话闭环。
 */
import {
  allocateCid,
  extractRootNoteBlock,
  extractRootTitle,
  parseRootNote,
  renderNodeNoteBlock,
  renderRootNote,
  type DocCenterEntry,
} from './mm-note';
import {
  addChildNode,
  findBlockByCid,
  findCenterCidBySessionId,
  firstHeadingAtOrAbove,
  headingAfter,
} from './node-edits';

export interface BuildSessionIslandInput {
  /** 会话 id（幂等键，写入 centers 条目的 `session_id`） */
  sessionId: string;
  /** 工作项标题：新建文档时作为 H1，也是路径锚的第一段 */
  workItemTitle: string;
  /** 会话节点标题，如 `09-30 21:50 会话` */
  sessionTitle: string;
  /** 三级计划项标题，作为会话节点的子节点写入（可选） */
  level3Titles?: readonly string[];
  /** 岛的生长方向（缺省 right） */
  dir?: 'right' | 'left' | 'down' | 'up';
  /** 岛根世界坐标（缺省不写 —— 交给 MindCanvas 自动排开） */
  x?: number;
  y?: number;
}

export interface BuildSessionIslandResult {
  /** 结果文本；失败或无需变更时等于入参 */
  text: string;
  /** 是否产生了变更 */
  changed: boolean;
  /** 本次分配的 cid（仅 changed 时有值） */
  cid?: string;
  /** 未变更的原因（仅 changed=false 时有值） */
  reason?: string;
}

const SESSION_TITLE_FALLBACK = '会话';

/** 归一化标题：去掉换行/制表符（标题会进 H1/H2 与路径锚，不能带换行）。 */
function normalizeTitle(raw: string, fallback: string): string {
  const flat = raw.replace(/[\r\n\t]+/g, ' ').trim();
  return flat === '' ? fallback : flat;
}

/** 生成一份只含根节点与会话节点的新文档。 */
function buildFreshDocument(input: BuildSessionIslandInput): string {
  const rootTitle = normalizeTitle(input.workItemTitle, '工作项');
  const rootBlock = renderRootNote({ nextCid: 1, centers: [], rest: {} });
  return `${rootBlock}\n# ${rootTitle}\n`;
}

/**
 * 把一次会话追加为该工作项导图上的一个岛。
 *
 * @param text 现有 `.mm.md` 原文（可为空字符串 = 尚无导图）
 */
export function buildSessionIsland(
  text: string,
  input: BuildSessionIslandInput,
): BuildSessionIslandResult {
  try {
    const sessionId = input.sessionId.trim();
    if (sessionId === '') {
      return { text, changed: false, reason: 'missing_session_id' };
    }
    const sessionTitle = normalizeTitle(
      input.sessionTitle,
      SESSION_TITLE_FALLBACK,
    );

    const original = text;
    const working = text.trim().length === 0 ? buildFreshDocument(input) : text;

    const rootTitle = extractRootTitle(working);
    if (rootTitle === null) {
      // 没有 H1 的正文不满足协议（协议要求有且仅有一个 H1）——不猜测、不改写
      return { text: original, changed: false, reason: 'root_title_missing' };
    }

    const block = extractRootNoteBlock(working);
    const model = block === null
      ? { nextCid: 1, centers: [] as DocCenterEntry[], rest: {} }
      : parseRootNote(block.body);

    // 幂等：同一会话已建岛 → 不再变更
    if (model.centers.some((c) => c.session_id === sessionId)) {
      return { text: original, changed: false, reason: 'session_island_exists' };
    }

    const { cid, nextCid } = allocateCid(model);
    const at = `node:${rootTitle}/${sessionTitle}`;

    const entry: DocCenterEntry = { at, cid, session_id: sessionId };
    if (input.dir !== undefined) entry.dir = input.dir;
    if (input.x !== undefined && input.y !== undefined) {
      entry.x = input.x;
      entry.y = input.y;
    }
    model.centers = [...model.centers, entry];
    model.nextCid = nextCid;

    // 重新拼装：根块（重写）+ 根块之后的正文（原样）+ 新会话节点（追加）
    const bodyAfterBlock = block === null
      ? `\n${working.replace(/^\s+/, '')}`
      : working.slice(block.end);
    const nodeFields: Record<string, string | string[]> = { cid, session_id: sessionId };
    const nodeBlock = renderNodeNoteBlock(nodeFields);

    const level3 = (input.level3Titles ?? [])
      .map((t) => normalizeTitle(t, ''))
      .filter((t) => t !== '');

    const sessionSection = [
      nodeBlock,
      `## ${sessionTitle}`,
      ...level3.map((t) => `\n### ${t}`),
    ].join('\n');

    const rebuilt = `${renderRootNote(model)}${bodyAfterBlock.replace(/\s*$/, '')}\n\n${sessionSection}\n`;

    return { text: rebuilt, changed: true, cid };
  } catch (error) {
    // fail-soft：绝不把导图失败升级成会话失败
    return {
      text,
      changed: false,
      reason: `build_failed:${error instanceof Error ? error.message : 'unknown'}`,
    };
  }
}

/** 该会话是否已建有岛（只读判定，不做任何写入）。 */
export function hasSessionIsland(text: string, sessionId: string): boolean {
  const block = extractRootNoteBlock(text);
  if (block === null) return false;
  const model = parseRootNote(block.body);
  return model.centers.some((c) => c.session_id === sessionId);
}

export interface SyncPlanItemsInput {
  sessionId: string;
  planTitles: readonly string[];
}

export interface SyncPlanItemsResult {
  text: string;
  changed: boolean;
  addedTitles: string[];
}

/**
 * 同步会话计划项到当前会话岛下（方案 A：保证当前会话的所有计划项均作为一级子分支存在）。
 *
 * 如果 `planTitles` 中的某个项在当前会话节点下尚未存在，则以 `addChildNode` 方式追加为 `### <标题>`。
 */
export function syncPlanItemsToSessionIsland(
  text: string,
  input: SyncPlanItemsInput,
): SyncPlanItemsResult {
  const sessionId = input.sessionId.trim();
  if (sessionId === '' || input.planTitles.length === 0) {
    return { text, changed: false, addedTitles: [] };
  }
  const centerCid = findCenterCidBySessionId(text, sessionId);
  if (centerCid === null) {
    return { text, changed: false, addedTitles: [] };
  }

  const lines = text.split(/\r?\n/);
  const hit = findBlockByCid(lines, centerCid);
  if (hit === null) return { text, changed: false, addedTitles: [] };
  const sessionHeading = headingAfter(lines, hit.close + 1);
  if (sessionHeading === null) return { text, changed: false, addedTitles: [] };

  // 收集当前会话节点下的直接一级子标题（level === sessionHeading.level + 1）
  const boundary = firstHeadingAtOrAbove(lines, sessionHeading.index + 1, sessionHeading.level);
  const endLine = boundary === -1 ? lines.length : boundary;
  const childLevel = sessionHeading.level + 1;
  const existingChildTitles = new Set<string>();

  for (let i = sessionHeading.index + 1; i < endLine; i += 1) {
    const line = lines[i].trim();
    const match = line.match(/^#{1,6}\s+(.+)$/);
    if (match) {
      const level = line.indexOf(' ');
      if (level === childLevel) {
        existingChildTitles.add(normalizeTitle(match[1], ''));
      }
    }
  }

  let currentText = text;
  let changed = false;
  const addedTitles: string[] = [];

  for (const rawTitle of input.planTitles) {
    const title = normalizeTitle(rawTitle, '');
    if (title === '' || existingChildTitles.has(title)) continue;

    // 追加到会话节点下（作为没有 thought_type 的正式计划项节点）
    const res = addChildNode(currentText, {
      parentCid: centerCid,
      title,
    });
    if (res.changed) {
      currentText = res.text;
      changed = true;
      addedTitles.push(title);
      existingChildTitles.add(title);
    }
  }

  return { text: currentText, changed, addedTitles };
}
