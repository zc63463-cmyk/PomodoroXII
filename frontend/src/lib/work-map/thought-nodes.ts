/**
 * 会话内「快速记录」写侧 —— 把一条思路按思考类型追加为**会话节点的子节点**
 * （ADR-0008 D13 步 2；类型键名与形状见 `thought-types.ts`）。
 *
 * ## 本函数是 `node-edits.addChildNode` 的**薄委托**（ADR-0008 D16-a）
 * 父锚的定位机制由「块扫描找 `session_id`」演进为「centers 按 `session_id` 反查
 * cid → `addChildNode` 按 cid 定位」—— **cid 才是跨渲染的持久编辑键**。
 * 写入形状与 fail 语义逐字保持；唯一演进：新节点**带 `cid` 行**，且根块
 * `next_cid` 被定向推进（新节点身份来自该计数器，与建岛共用）。
 *
 * ## 写入形状（协议可观察行为，测试钉住）
 * ```
 * …会话节点子树末尾…
 *
 * <!--
 * thought_type: "problem"
 * cid: "c2"
 * -->
 * ### token 对照：灰阶 vs 玻璃主题
 * ```
 * - 笔记块**归属其后的节点**（协议：空行插在块之前，插在之后会拆开两者）
 * - 层级 = 会话节点层级 + 1（会话节点是 `##` → 子节点 `###`）
 * - 插入点是**会话子树末尾**（下一个同级或更高级标题之前 / EOF），保持会话内时序
 * - 其余正文**逐字节保留**（本模块只做一处字符串拼接 + 根块 `next_cid` 定向改行）
 *
 * ## fail-soft 与 fail-closed 的分工
 * - 结构性问题（找不到会话节点 / 无 H1 / 笔记块未闭合）→ `changed:false` + reason，
 *   **绝不猜测**（宁可不写也不错写）；centers 条目缺 cid（存量岛）同样只读
 * - 输入问题（类型非法 / 空标题 / 缺 sessionId）→ 同样拒绝（fail-closed）
 * - 任何异常 → 返回原文（调用方据此提示，不阻断会话）
 */
import {
  addChildNode,
  findCenterCidBySessionId,
  hasRootTitle,
  normalizeNodeTitle,
} from './node-edits'
import { isThoughtType, type ThoughtType } from './thought-types'

export interface AppendThoughtInput {
  /** 本次会话 id（用于定位会话节点） */
  sessionId: string
  /** 思考类型（D9 五值） */
  type: ThoughtType
  /** 节点标题（单行；换行/制表符会被压平） */
  title: string
}

export interface AppendThoughtResult {
  /** 结果文本；未变更时等于入参 */
  text: string
  changed: boolean
  /** 未变更原因（changed=false 时有值） */
  reason?: string
}

/**
 * 把一条思路追加为会话节点的子节点。
 *
 * @param text 现有 `.mm.md` 原文
 */
export function appendThoughtNode(
  text: string,
  input: AppendThoughtInput,
): AppendThoughtResult {
  try {
    const sessionId = input.sessionId.trim()
    if (sessionId === '') return { text, changed: false, reason: 'missing_session_id' }
    if (!isThoughtType(input.type)) {
      return { text, changed: false, reason: 'invalid_thought_type' }
    }
    const title = normalizeNodeTitle(input.title)
    if (title === '') return { text, changed: false, reason: 'empty_title' }
    if (!hasRootTitle(text)) {
      return { text, changed: false, reason: 'root_title_missing' }
    }

    // 父锚 = 会话节点（岛根）：其 cid 由 centers 条目按 session_id 反查
    //（D16-a：会话节点只读，但它的子树末尾是快速记录的写入点）。
    const parentCid = findCenterCidBySessionId(text, sessionId)
    if (parentCid === null) {
      return { text, changed: false, reason: 'session_node_not_found' }
    }

    return addChildNode(text, { parentCid, title, thoughtType: input.type })
  } catch (error) {
    return {
      text,
      changed: false,
      reason: `append_failed:${error instanceof Error ? error.message : 'unknown'}`,
    }
  }
}