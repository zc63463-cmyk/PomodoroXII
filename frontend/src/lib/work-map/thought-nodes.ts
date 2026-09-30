/**
 * 会话内「快速记录」写侧 —— 把一条思路按思考类型追加为**会话节点的子节点**
 * （ADR-0008 D13 步 2；类型键名与形状见 `thought-types.ts`）。
 *
 * ## 写入形状（协议可观察行为，测试钉住）
 * ```
 * …会话节点子树末尾…
 *
 * <!--
 * thought_type: "problem"
 * -->
 * ### token 对照：灰阶 vs 玻璃主题
 * ```
 * - 笔记块**归属其后的节点**（协议：空行插在块之前，插在之后会拆开两者）
 * - 层级 = 会话节点层级 + 1（会话节点是 `##` → 子节点 `###`）
 * - 插入点是**会话子树末尾**（下一个同级或更高级标题之前 / EOF），保持会话内时序
 * - 其余正文**逐字节保留**（本模块只做一处字符串拼接，不重排、不重写别的块）
 *
 * ## fail-soft 与 fail-closed 的分工
 * - 结构性问题（找不到会话节点 / 无 H1 / 笔记块未闭合）→ `changed:false` + reason，
 *   **绝不猜测**（宁可不写也不错写）；
 * - 输入问题（类型非法 / 空标题 / 缺 sessionId）→ 同样拒绝（fail-closed）
 * - 任何异常 → 返回原文（调用方据此提示，不阻断会话）
 */
import { extractRootTitle, parseNodeNoteFields, renderNodeNoteBlock } from './mm-note'
import { isThoughtType, THOUGHT_TYPE_KEY, type ThoughtType } from './thought-types'

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

const HEADING = /^(#{1,6})\s+/

/** 标题压平：换行/制表符 → 空格（标题会进 heading 行与路径锚，不能带换行）。 */
function normalizeTitle(raw: string): string {
  return raw.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim()
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
    const title = normalizeTitle(input.title)
    if (title === '') return { text, changed: false, reason: 'empty_title' }
    if (extractRootTitle(text) === null) {
      return { text, changed: false, reason: 'root_title_missing' }
    }

    const eol = text.includes('\r\n') ? '\r\n' : '\n'
    const lines = text.split(/\r?\n/)

    // ① 定位会话节点：带 session_id 的笔记块 → 其后的第一个标题行
    let sessionHeading = -1
    let sessionLevel = 0
    for (let i = 0; i < lines.length; i += 1) {
      if (!lines[i].trimStart().startsWith('<!--')) continue
      const bodyLines: string[] = []
      let j = i + 1
      while (j < lines.length && !lines[j].includes('-->')) {
        bodyLines.push(lines[j])
        j += 1
      }
      if (j >= lines.length) break // 未闭合块：交调用方 fail-soft
      const fields = parseNodeNoteFields(bodyLines.join('\n'))
      if (fields.session_id === sessionId) {
        for (let k = j + 1; k < lines.length; k += 1) {
          const match = HEADING.exec(lines[k])
          if (match) {
            sessionHeading = k
            sessionLevel = match[1].length
            break
          }
        }
        break
      }
      i = j
    }
    if (sessionHeading === -1) {
      return { text, changed: false, reason: 'session_node_not_found' }
    }

    // ② 会话子树末尾：下一个层级 ≤ 会话层级的标题行（或 EOF）
    let end = lines.length
    for (let k = sessionHeading + 1; k < lines.length; k += 1) {
      const match = HEADING.exec(lines[k])
      if (match && match[1].length <= sessionLevel) {
        end = k
        break
      }
    }

    // ③ 拼接：head（去尾随空行）+ 空行 + 块 + 标题 + 空行 + tail（去前导空行）
    const head = lines.slice(0, end)
    while (head.length > 0 && head[head.length - 1].trim() === '') head.pop()
    const tail = lines.slice(end)
    while (tail.length > 0 && tail[0].trim() === '') tail.shift()

    const childLevel = '#'.repeat(Math.min(sessionLevel + 1, 6))
    const merged = [
      ...head,
      '',
      renderNodeNoteBlock({ [THOUGHT_TYPE_KEY]: input.type }),
      `${childLevel} ${title}`,
      '',
      ...tail,
    ]
    let rebuilt = merged.join(eol)
    if (!rebuilt.endsWith(eol)) rebuilt += eol // 协议：末尾单个 LF

    return { text: rebuilt, changed: true }
  } catch (error) {
    return {
      text,
      changed: false,
      reason: `append_failed:${error instanceof Error ? error.message : 'unknown'}`,
    }
  }
}
