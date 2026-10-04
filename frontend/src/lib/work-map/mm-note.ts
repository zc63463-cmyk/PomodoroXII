/**
 * `.mm.md` 根笔记块的最小读写（协议 §6.1 文档级块 / §6.3 `centers` 子集）。
 *
 * 为什么是「最小」而不是移植 MindCanvas kernel 的解析器：
 * 完整 `.mm.md` 解析器要处理标题栈 / 列表栈 / 笔记块归属（~400 行），而**建岛只需要
 * 文档级根块**这一处。故本模块只做根块的有界解析与规范生成，其余正文**原样保留**——
 * 天然保真，不会因重写而丢用户的排版。
 *
 * 遵循协议的「宽松读入、规范写出」：
 * - 读：容忍缩进差异、字段顺序、引号有无、数值经往返后退化为字符串
 * - 写：统一 2 空格缩进、`at` 恒加双引号、字段顺序固定
 *
 * 边界：本模块**不理解**节点树，也不解析正文；它只负责文档级块的进出。
 */

/** 一条文档级中心（岛）条目。协议字段 + 集成特化字段（后者由 MindCanvas 原样保留）。 */
export interface DocCenterEntry {
  /** 路径锚或实体锚（`node:根/子` / `@kind:id[#N]`） */
  at: string;
  /** 稳定子树身份（`c1`…）；由 `next_cid` 单调分配，永不复用 */
  cid?: string;
  /** 生长方向 */
  dir?: 'right' | 'left' | 'down' | 'up';
  x?: number;
  y?: number;
  parent_link?: 'show';
  detached?: boolean;
  /**
   * **集成特化字段**：本节所属的会话 id。
   * MindCanvas 遵循「未知字段一律保留」，故可安全写入；PomodoroXII 用它做建岛幂等判定。
   */
  session_id?: string;
  [key: string]: unknown;
}

export interface RootNoteModel {
  /** 单调计数器；下一次分配的 cid 编号 */
  nextCid: number;
  centers: DocCenterEntry[];
  /** 根块中出现但本模块不理解的其它键（edges / sections / links …）——原样保留 */
  rest: Record<string, string[]>;
}

const BLOCK_OPEN = '<!--';
const BLOCK_CLOSE = '-->';

/** 提取文件开头的文档级块（根笔记块）。找不到返回 null。 */
export function extractRootNoteBlock(text: string): { body: string; end: number } | null {
  const trimmedStart = text.length - text.replace(/^\s*/, '').length;
  if (!text.startsWith(BLOCK_OPEN, trimmedStart)) return null;
  const close = text.indexOf(BLOCK_CLOSE, trimmedStart + BLOCK_OPEN.length);
  if (close === -1) return null; // 未闭合：视为不存在，交由调用方 fail-soft
  return {
    body: text.slice(trimmedStart + BLOCK_OPEN.length, close),
    end: close + BLOCK_CLOSE.length,
  };
}

/** 解析 `centers:` 列表项。只认「`- key: value` 起始 + 后续缩进键」这一种形态。 */
function parseCenters(lines: string[]): DocCenterEntry[] {
  const out: DocCenterEntry[] = [];
  let current: DocCenterEntry | null = null;
  let inCenters = false;

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');
    if (/^centers\s*:/.test(line)) {
      inCenters = true;
      continue;
    }
    if (!inCenters) continue;
    // 退出条件：出现新的顶层键（非缩进、非空、非列表项）
    if (/^\S/.test(line) && !/^centers\s*:/.test(line)) {
      inCenters = false;
      continue;
    }

    const itemMatch = /^\s*-\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(line);
    if (itemMatch) {
      current = {} as DocCenterEntry;
      out.push(current);
      assignField(current, itemMatch[1], itemMatch[2]);
      continue;
    }
    const fieldMatch = /^\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(line);
    if (fieldMatch && current) {
      assignField(current, fieldMatch[1], fieldMatch[2]);
    }
  }
  return out;
}

/** 去掉 YAML 标量两端的引号并还原转义。 */
function unquote(token: string): string {
  const t = token.trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
    return t.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  if (t.length >= 2 && t.startsWith("'") && t.endsWith("'")) {
    return t.slice(1, -1).replace(/''/g, "'");
  }
  return t;
}

/** 数值容错：协议冻结行为下，裸标量经 `parse → serialize` 往返会退化为字符串。 */
function toNumberOrUndefined(token: string): number | undefined {
  const t = token.trim();
  if (t === '') return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
}

function assignField(entry: DocCenterEntry, key: string, rawValue: string): void {
  switch (key) {
    case 'at':
      entry.at = unquote(rawValue);
      break;
    case 'cid':
      entry.cid = unquote(rawValue);
      break;
    case 'dir': {
      const v = unquote(rawValue);
      if (v === 'right' || v === 'left' || v === 'down' || v === 'up') entry.dir = v;
      break;
    }
    case 'x': {
      const n = toNumberOrUndefined(rawValue);
      if (n !== undefined) entry.x = n;
      break;
    }
    case 'y': {
      const n = toNumberOrUndefined(rawValue);
      if (n !== undefined) entry.y = n;
      break;
    }
    case 'parent_link':
      if (unquote(rawValue) === 'show') entry.parent_link = 'show';
      break;
    case 'detached':
      if (unquote(rawValue) === 'true') entry.detached = true;
      break;
    case 'session_id':
      entry.session_id = unquote(rawValue);
      break;
    default:
      entry[key] = unquote(rawValue);
  }
}

/** 解析根块正文 → 结构化模型。 */
export function parseRootNote(body: string): RootNoteModel {
  const lines = body.split('\n');
  let nextCid = 1;
  const rest: Record<string, string[]> = {};
  let inUnknown = false;
  let unknownKey: string | null = null;

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');
    const nextMatch = /^next_cid\s*:\s*(.*)$/.exec(line);
    if (nextMatch) {
      const n = toNumberOrUndefined(nextMatch[1]);
      nextCid = n !== undefined && n >= 1 ? Math.floor(n) : 1;
      continue;
    }
    if (/^centers\s*:/.test(line)) {
      inUnknown = false;
      unknownKey = null;
      continue;
    }
    const topKey = /^([A-Za-z_][A-Za-z0-9_]*)\s*:/.exec(line);
    if (topKey) {
      unknownKey = topKey[1];
      rest[unknownKey] = rest[unknownKey] ?? [];
      inUnknown = true;
      rest[unknownKey].push(line);
      continue;
    }
    if (inUnknown && unknownKey !== null && /^\s/.test(line)) {
      rest[unknownKey].push(line);
    }
  }

  return { nextCid, centers: parseCenters(lines), rest };
}

/** 转义 YAML 双引号标量。 */
function quote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** 按协议规范格式生成根块正文。字段顺序固定：at → cid → dir → x → y → parent_link → detached → 特化字段。 */
export function renderRootNote(model: RootNoteModel): string {
  const out: string[] = [`next_cid: ${model.nextCid}`];

  if (model.centers.length > 0) {
    out.push('centers:');
    for (const entry of model.centers) {
      const known = new Set([
        'at',
        'cid',
        'dir',
        'x',
        'y',
        'parent_link',
        'detached',
        'session_id',
      ]);
      out.push(`  - at: ${quote(entry.at)}`);
      if (entry.cid !== undefined) out.push(`    cid: ${entry.cid}`);
      out.push(`    dir: ${entry.dir ?? 'right'}`);
      if (entry.x !== undefined && entry.y !== undefined) {
        out.push(`    x: ${entry.x}`);
        out.push(`    y: ${entry.y}`);
      }
      if (entry.parent_link === 'show') out.push(`    parent_link: show`);
      if (entry.detached === true) out.push(`    detached: true`);
      if (entry.session_id !== undefined) {
        out.push(`    session_id: ${quote(entry.session_id)}`);
      }
      // 未知字段原样带出（前向兼容：绝不丢弃）
      for (const [key, value] of Object.entries(entry)) {
        if (known.has(key)) continue;
        if (typeof value === 'string') out.push(`    ${key}: ${quote(value)}`);
        else if (typeof value === 'number' || typeof value === 'boolean') {
          out.push(`    ${key}: ${value}`);
        }
      }
    }
  }

  for (const lines of Object.values(model.rest)) {
    out.push(...lines);
  }

  return `${BLOCK_OPEN}\n${out.join('\n')}\n${BLOCK_CLOSE}`;
}

/** 分配下一个 cid（`next_cid` 单调递增、永不复用）。 */
export function allocateCid(model: RootNoteModel): { cid: string; nextCid: number } {
  return { cid: `c${model.nextCid}`, nextCid: model.nextCid + 1 };
}

/** 从正文中取 H1 标题（根节点文本）；没有则返回 null。 */
export function extractRootTitle(text: string): string | null {
  const match = /^#\s+(.+)$/m.exec(text);
  return match ? match[1].trim() : null;
}

/** 提取某个笔记块的正文（用于读节点自己的 `cid` / `session_id`）。 */
export function parseNodeNoteFields(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of body.split('\n')) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(rawLine.replace(/\r$/, ''));
    if (m) out[m[1]] = unquote(m[2]);
  }
  return out;
}

/** 生成一个节点前导笔记块（归属其后的节点 —— 协议规定）。 */
export function renderNodeNoteBlock(fields: Record<string, string | string[]>): string {
  const out: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (Array.isArray(value)) {
      out.push(`${key}:`);
      for (const item of value) out.push(`  - ${item}`);
    } else {
      out.push(`${key}: ${quote(value)}`);
    }
  }
  return `${BLOCK_OPEN}\n${out.join('\n')}\n${BLOCK_CLOSE}`;
}
