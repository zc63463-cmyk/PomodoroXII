/**
 * 节点编辑数据原语（ADR-0008 D16 · D13 步 3-2）—— 中央编辑区五个最小操作的**写侧**。
 *
 * ## 定位锚 = `cid`，**不是** kernel 的 `EditableNode.id`
 * kernel 的 `EditableNode.id` 由 `astToEditable` 每次解析 `newId()` 重新分配
 * （`packages/kernel/src/tree/treeOps.ts` 头注原文「id 不进入序列化」）。页面每次
 * 写回后 `mapText` 变化 → 重新 parse → **所有节点 id 全变**。故跨渲染的持久身份
 * 只能是**节点笔记块里的 `cid`**（协议 §6.3 既有机制，与根块 `next_cid` 联动）。
 * 本模块全部按 `cid` 定位：找到含 `cid: "<目标>"` 的笔记块 → 其标题 = 块后**第一个
 * heading 行**（协议：笔记块**归属其后的节点**）。
 *
 * ## 写入纪律（D16-b，延续 D11/D14）
 * - **文本级字符串变换**：除目标行/插入区外，其余正文**逐字节保留**
 * - **禁止** `parse → treeOps 编辑 → serializeMm 整文写回`（D11 明确否过：会把用户
 *   手写排版规范化为全量 diff）；kernel 的 `treeOps` 只作**行为参照**，不进本仓编辑路径
 * - 唯一允许触碰的"非目标"位置：`addChildNode` 分配 cid 后把**文档级根块**的
 *   `next_cid:` 那一行**定向**改成新值（只改这一行；centers 等其余排版逐字节不动）。
 *   这是 §1「从根块 next_cid 分配并写回」的落实，也是避免跨会话 cid 撞车的必要动作
 *   （`buildSessionIsland` 建岛时同样依赖该计数器）
 * - 返回形状沿用 `{ text, changed, reason? }`；fail-closed（非法输入拒绝）与
 *   fail-soft（结构找不到原样返回）分工同 `thought-nodes.ts` 头注
 *
 * ## 与「只读边界」的关系
 * 本模块**不认识会话/岛**：它只按 cid 编辑。**「只编辑当前会话岛内带 cid 的节点」**
 * 由 UI 强制 —— `work-map-tree.tsx` 只给 `cid !== null` 且属当前会话岛的节点挂
 * `data-cid` 并可点击；会话节点/根岛/其它岛/无 cid 存量节点一律不给入口（D16-a）。
 */
import {
  extractRootNoteBlock,
  extractRootTitle,
  parseNodeNoteFields,
  parseRootNote,
  renderNodeNoteBlock,
} from './mm-note'
import { isThoughtType, THOUGHT_TYPE_KEY, type ThoughtType } from './thought-types'

export interface NodeEditResult {
  /** 结果文本；未变更时**等于入参**（字节相同，调用方据此跳过写盘） */
  text: string
  changed: boolean
  /** 未变更原因（changed=false 时有值） */
  reason?: string
}

export interface RenameNodeInput {
  /** 目标节点稳定身份（笔记块里的 cid） */
  cid: string
  /** 新标题（单行；换行/制表符会被压平） */
  title: string
}

export interface AddChildNodeInput {
  /** 父节点稳定身份 */
  parentCid: string
  /** 新节点标题（单行；换行/制表符会被压平） */
  title: string
  /** 思考类型（D9 五值；缺省 = 不写 thought_type 行） */
  thoughtType?: ThoughtType
  /** 指定 cid（缺省 = 从根块 `next_cid` 分配）；`c1`…`cN` 协议形 */
  cid?: string
}

export interface SetThoughtTypeInput {
  cid: string
  /** `null` = 删除该行 */
  type: ThoughtType | null
}

export interface SetNodeCommentInput {
  cid: string
  /** `null` 或空数组 = 删除 `note:` 列表 */
  comment: string[] | null
}

const HEADING = /^(#{1,6})\s+/
const CID_FORM = /^c\d+$/

/** 标题压平：换行/制表符 → 空格（标题会进 heading 行与路径锚，不能带换行）。 */
export function normalizeNodeTitle(raw: string): string {
  return raw.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim()
}

const eolOf = (text: string): string => (text.includes('\r\n') ? '\r\n' : '\n')

interface NoteBlockHit {
  /** `<!--` 所在行号 */
  open: number
  /** 含 `-->` 的行号 */
  close: number
}

/** 找到含 `cid: "<目标>"` 的笔记块（块扫描口径与 `thought-nodes.ts` 一致）。 */
function findBlockByCid(lines: string[], cid: string): NoteBlockHit | null {
  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i].trimStart().startsWith('<!--')) continue
    const body: string[] = []
    let j = i + 1
    while (j < lines.length && !lines[j].includes('-->')) {
      body.push(lines[j])
      j += 1
    }
    if (j >= lines.length) return null // 未闭合块：交调用方 fail-soft
    // 顶部锚定（无前导空白）—— 根块 centers 里缩进的 cid 不会被误认
    if (parseNodeNoteFields(body.join('\n')).cid === cid) return { open: i, close: j }
    i = j
  }
  return null
}

/** 块后第一个 heading 行（= 该笔记块所属节点的标题）。 */
function headingAfter(lines: string[], from: number): { index: number; level: number } | null {
  for (let k = from; k < lines.length; k += 1) {
    const match = HEADING.exec(lines[k])
    if (match) return { index: k, level: match[1].length }
  }
  return null
}

/** 从 `from` 起第一个层级 ≤ maxLevel 的 heading（= 子树边界）；无则 -1。 */
function firstHeadingAtOrAbove(lines: string[], from: number, maxLevel: number): number {
  for (let k = from; k < lines.length; k += 1) {
    const match = HEADING.exec(lines[k])
    if (match && match[1].length <= maxLevel) return k
  }
  return -1
}

/**
 * 某 heading 所属"节点单元"的起始行 —— 若其前紧邻（可隔空行）一个笔记块，
 * 则该块属于这个 heading（协议：块归属其后节点），单元起点 = 块开行。
 *
 * 为什么必需：块的物理位置落在**前一个节点**的范围里（`…### 前\n\n<!--块-->\n### 后`）。
 * 若子树边界按 heading 行计算，会把后一个节点的块一起删掉/覆盖 → 静默丢 cid。
 */
function unitStart(lines: string[], headingIndex: number): number {
  let k = headingIndex - 1
  while (k >= 0 && lines[k].trim() === '') k -= 1
  if (k < 0) return headingIndex
  if (lines[k].includes('-->')) {
    for (let i = k; i >= 0; i -= 1) {
      if (lines[i].trimStart().startsWith('<!--')) return i
    }
  }
  return headingIndex
}

/** 读根块的 `next_cid`（无根块 → 1，与 mm-note 缺省一致）。 */
function readRootNextCid(text: string): number {
  const block = extractRootNoteBlock(text)
  return block === null ? 1 : parseRootNote(block.body).nextCid
}

/**
 * 只改根块里的 `next_cid:` 那一行（方案 B：定向改行，其余含 centers 排版逐字节不动）。
 * 根块缺该行时补在 `<!--` 之后。
 */
function setRootNextCid(text: string, value: number): string {
  const block = extractRootNoteBlock(text)
  if (block === null) return text
  const start = text.length - text.replace(/^\s*/, '').length
  const before = text.slice(0, start)
  const blockText = text.slice(start, block.end)
  const after = text.slice(block.end)
  const lines = blockText.split(/\r?\n/)
  const idx = lines.findIndex((line) => /^next_cid\s*:/.test(line))
  if (idx >= 0) lines[idx] = `next_cid: ${value}`
  else lines.splice(1, 0, `next_cid: ${value}`)
  return `${before}${lines.join(eolOf(text))}${after}`
}

/** 改目标块后第一个 heading 行的标题（压平换行/制表）。只动那一行。 */
export function renameNode(text: string, input: RenameNodeInput): NodeEditResult {
  try {
    const cid = input.cid.trim()
    if (cid === '') return { text, changed: false, reason: 'missing_cid' }
    const title = normalizeNodeTitle(input.title)
    if (title === '') return { text, changed: false, reason: 'empty_title' }

    const lines = text.split(/\r?\n/)
    const hit = findBlockByCid(lines, cid)
    if (hit === null) return { text, changed: false, reason: 'cid_not_found' }
    const heading = headingAfter(lines, hit.close + 1)
    if (heading === null) return { text, changed: false, reason: 'node_heading_not_found' }

    const next = [...lines]
    next[heading.index] = `${'#'.repeat(heading.level)} ${title}`
    return { text: next.join(eolOf(text)), changed: true }
  } catch (error) {
    return { text, changed: false, reason: `rename_failed:${messageOf(error)}` }
  }
}

/**
 * 在父节点**子树末尾**追加「笔记块 + 标题」（层级 = 父 + 1）。
 *
 * 写入形状：与 `appendThoughtNode` 现形状一致，**多一行 `cid`**（D16 演进）：
 * ```
 * <!--
 * thought_type: "problem"
 * cid: "c2"
 * -->
 * ### 标题
 * ```
 * cid 缺省时从根块 `next_cid` 分配，并把根块 `next_cid` 定向推进到 `max(现值, N+1)`
 * （单调、不复用；与建岛共用同一计数器）。
 */
export function addChildNode(text: string, input: AddChildNodeInput): NodeEditResult {
  try {
    const parentCid = input.parentCid.trim()
    if (parentCid === '') return { text, changed: false, reason: 'missing_cid' }
    const title = normalizeNodeTitle(input.title)
    if (title === '') return { text, changed: false, reason: 'empty_title' }
    if (input.thoughtType !== undefined && !isThoughtType(input.thoughtType)) {
      return { text, changed: false, reason: 'invalid_thought_type' }
    }
    const explicitCid = input.cid === undefined ? null : input.cid.trim()
    if (explicitCid !== null && !CID_FORM.test(explicitCid)) {
      return { text, changed: false, reason: 'invalid_cid' }
    }

    const lines = text.split(/\r?\n/)
    const hit = findBlockByCid(lines, parentCid)
    if (hit === null) return { text, changed: false, reason: 'cid_not_found' }
    const parent = headingAfter(lines, hit.close + 1)
    if (parent === null) return { text, changed: false, reason: 'node_heading_not_found' }

    // 父子树末尾：下一个层级 ≤ 父的 heading（或 EOF）；边界若带自己的笔记块，插到块之前
    const boundary = firstHeadingAtOrAbove(lines, parent.index + 1, parent.level)
    const insertAt = boundary === -1 ? lines.length : unitStart(lines, boundary)

    const head = lines.slice(0, insertAt)
    while (head.length > 0 && head[head.length - 1].trim() === '') head.pop()
    const tail = lines.slice(insertAt)
    while (tail.length > 0 && tail[0].trim() === '') tail.shift()

    const currentNext = readRootNextCid(text)
    const cid = explicitCid ?? `c${currentNext}`
    const nextCid = Math.max(currentNext, Number.parseInt(cid.slice(1), 10) + 1)

    const fields: Record<string, string | string[]> = {}
    if (input.thoughtType !== undefined) fields[THOUGHT_TYPE_KEY] = input.thoughtType
    fields.cid = cid

    const childLevel = '#'.repeat(Math.min(parent.level + 1, 6))
    const merged = [
      ...head,
      '',
      renderNodeNoteBlock(fields),
      `${childLevel} ${title}`,
      '',
      ...tail,
    ]
    let rebuilt = merged.join(eolOf(text))
    if (!rebuilt.endsWith(eolOf(text))) rebuilt += eolOf(text)

    return { text: setRootNextCid(rebuilt, nextCid), changed: true }
  } catch (error) {
    return { text, changed: false, reason: `add_child_failed:${messageOf(error)}` }
  }
}

/**
 * 删除「笔记块 + 标题行 + 整个子树」（到下一个同级/更高级标题或 EOF）。
 * 其余正文不动；**不碰 centers**（centers 条目的 cid 属岛根，本操作不涉及）。
 */
export function removeNode(text: string, input: { cid: string }): NodeEditResult {
  try {
    const cid = input.cid.trim()
    if (cid === '') return { text, changed: false, reason: 'missing_cid' }

    const lines = text.split(/\r?\n/)
    const hit = findBlockByCid(lines, cid)
    if (hit === null) return { text, changed: false, reason: 'cid_not_found' }
    const heading = headingAfter(lines, hit.close + 1)
    if (heading === null) return { text, changed: false, reason: 'node_heading_not_found' }

    const boundary = firstHeadingAtOrAbove(lines, heading.index + 1, heading.level)
    const end = boundary === -1 ? lines.length : unitStart(lines, boundary)
    const next = [...lines.slice(0, hit.open), ...lines.slice(end)]
    return { text: next.join(eolOf(text)), changed: true }
  } catch (error) {
    return { text, changed: false, reason: `remove_failed:${messageOf(error)}` }
  }
}

/** 块内改/删 `thought_type` 行（`null` = 删行）；其余键逐字节原样。 */
export function setThoughtType(text: string, input: SetThoughtTypeInput): NodeEditResult {
  try {
    const cid = input.cid.trim()
    if (cid === '') return { text, changed: false, reason: 'missing_cid' }
    if (input.type !== null && !isThoughtType(input.type)) {
      return { text, changed: false, reason: 'invalid_thought_type' }
    }

    const lines = text.split(/\r?\n/)
    const hit = findBlockByCid(lines, cid)
    if (hit === null) return { text, changed: false, reason: 'cid_not_found' }

    const bodyStart = hit.open + 1
    const body = lines.slice(bodyStart, hit.close)
    const existing = parseNodeNoteFields(body.join('\n'))[THOUGHT_TYPE_KEY]
    if (input.type === null ? existing === undefined : existing === input.type) {
      return { text, changed: false, reason: 'no_change' }
    }

    const idx = body.findIndex((line) => /^thought_type\s*:/.test(line))
    if (input.type === null) body.splice(idx, 1)
    else if (idx >= 0) body[idx] = `${THOUGHT_TYPE_KEY}: ${JSON.stringify(input.type)}`
    else body.push(`${THOUGHT_TYPE_KEY}: ${JSON.stringify(input.type)}`)

    const next = [...lines.slice(0, bodyStart), ...body, ...lines.slice(hit.close)]
    return { text: next.join(eolOf(text)), changed: true }
  } catch (error) {
    return { text, changed: false, reason: `set_type_failed:${messageOf(error)}` }
  }
}

/** 从 `note:` 列表组（`note:` 行 + 后续 `  - …` 行）解出条目。 */
function parseNoteItems(group: string[]): string[] {
  const items: string[] = []
  for (const line of group.slice(1)) {
    const match = /^\s+-\s?(.*)$/.exec(line)
    if (match) items.push(match[1].replace(/\s+$/, ''))
  }
  return items
}

const sameItems = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((item, index) => item === b[index])

/** 块内写/删 `note:` 列表（S0 样本同款 `note:\n  - …`）；其余键逐字节原样。 */
export function setNodeComment(text: string, input: SetNodeCommentInput): NodeEditResult {
  try {
    const cid = input.cid.trim()
    if (cid === '') return { text, changed: false, reason: 'missing_cid' }
    let items: string[] | null = null
    if (input.comment !== null) {
      if (!Array.isArray(input.comment)) {
        return { text, changed: false, reason: 'invalid_comment' }
      }
      const cleaned = input.comment
        .map((item) => String(item).replace(/[\r\n\t]+/g, ' ').trim())
        .filter((item) => item !== '')
      items = cleaned.length === 0 ? null : cleaned
    }

    const lines = text.split(/\r?\n/)
    const hit = findBlockByCid(lines, cid)
    if (hit === null) return { text, changed: false, reason: 'cid_not_found' }

    const bodyStart = hit.open + 1
    const body = lines.slice(bodyStart, hit.close)
    const idx = body.findIndex((line) => /^note\s*:/.test(line))
    let groupEnd = idx
    if (idx >= 0) {
      groupEnd = idx + 1
      while (groupEnd < body.length && /^\s+-/.test(body[groupEnd])) groupEnd += 1
    }

    if (items === null) {
      if (idx < 0) return { text, changed: false, reason: 'no_change' }
      body.splice(idx, groupEnd - idx) // 删行
    } else {
      const replacement = ['note:', ...items.map((item) => `  - ${item}`)]
      if (idx < 0) body.push(...replacement)
      else if (sameItems(parseNoteItems(body.slice(idx, groupEnd)), items)) {
        return { text, changed: false, reason: 'no_change' }
      } else body.splice(idx, groupEnd - idx, ...replacement)
    }

    const next = [...lines.slice(0, bodyStart), ...body, ...lines.slice(hit.close)]
    return { text: next.join(eolOf(text)), changed: true }
  } catch (error) {
    return { text, changed: false, reason: `set_comment_failed:${messageOf(error)}` }
  }
}

/**
 * 从根块 `centers` 按 `session_id` 反查会话节点（岛根）的 `cid` —— `appendThoughtNode`
 * 委托 `addChildNode` 时的父锚来源。找不到 / 该条目无 cid（存量）→ `null`（只读，不猜）。
 */
export function findCenterCidBySessionId(text: string, sessionId: string): string | null {
  const block = extractRootNoteBlock(text)
  if (block === null) return null
  const entry = parseRootNote(block.body).centers.find(
    (center) => center.session_id === sessionId,
  )
  return entry?.cid ?? null
}

/** 文档是否有 H1（协议要求有且仅有一个）—— 供写侧做结构性 fail-soft。 */
export function hasRootTitle(text: string): boolean {
  return extractRootTitle(text) !== null
}

/**
 * 编辑命令 —— 编辑区上抛、页面接线、原语执行三者的**唯一命令词汇**
 * （D13 步 3-2；`cid` 一律是节点稳定编辑键，见 D16-a）。
 */
export type MapNodeEditOp =
  | { kind: 'rename'; cid: string; title: string }
  | { kind: 'add'; cid: string; title: string }
  | { kind: 'type'; cid: string; type: ThoughtType | null }
  | { kind: 'comment'; cid: string; comment: string[] | null }
  | { kind: 'delete'; cid: string }

/** 命令 → 原语（单一映射点，避免编辑器与页面两处漂移）。 */
export function applyMapNodeEdit(text: string, op: MapNodeEditOp): NodeEditResult {
  switch (op.kind) {
    case 'rename':
      return renameNode(text, { cid: op.cid, title: op.title })
    case 'add':
      return addChildNode(text, { parentCid: op.cid, title: op.title })
    case 'type':
      return setThoughtType(text, { cid: op.cid, type: op.type })
    case 'comment':
      return setNodeComment(text, { cid: op.cid, comment: op.comment })
    case 'delete':
      return removeNode(text, { cid: op.cid })
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown'
}