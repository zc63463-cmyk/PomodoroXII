/**
 * 思考类型（Thought Type）—— ADR-0008 D9 的落地常量（无 IO，读写两侧共用）。
 *
 * ## 协议落点：**未知笔记键**（零协议改动）
 * 依据（改动前先读）：
 * - `.mm.md` 协议 §5.2：「**未知字段一律透传**（`Note` 有 `[key: string]: unknown`），
 *   序列化时排在已知字段之后。这是前向兼容的核心机制。」
 * - 同款先例：`ai_role`（MindCanvas `docs/specs/2026-08-27-mindmap-forgejo-sync-design.md:267`
 *   「协议规定未知 note 键透传不报错」）——集成特化属性一律走未知键，**不动协议**
 * - 反向先例（不要这么做）：新增 `EditableNode.type` 会触发"未知 type 降级纪律未定义"
 *   （`2026-09-14-node-card-flip-markdown-design.md:62`），属协议面改动
 *
 * ## 键名裁决（2026-09-30，ADR-0008 D14）
 * 键名 = `thought_type`，值域 = 五个 ASCII id（与 D9 表逐字对应）。
 * 不选 `thought`：该名易被读成"思考正文"而歧义；不选 `type`：与节点三分结构的
 * `type` 概念撞名。命名风格对齐既有未知键（`ai_role` 的 `<域>_<角色>`）。
 *
 * ## 形状 + 颜色双重编码（D9 强制：色盲可辨）
 * 形状与颜色只用于**渲染层**（`timer-map-port` 与节点类型图例），不落盘 ——
 * 落盘的只有类型 id 本身（形状映射改动不需要动文件）。
 */
export const THOUGHT_TYPES = ['insight', 'problem', 'decision', 'review', 'todo'] as const

export type ThoughtType = (typeof THOUGHT_TYPES)[number]

/** 落盘的笔记键名（未知键透传，见文件头注）。 */
export const THOUGHT_TYPE_KEY = 'thought_type'

/** 中文标签（UI 用；与 D9 表的含义列一致）。 */
export const THOUGHT_TYPE_LABEL: Record<ThoughtType, string> = {
  insight: '洞察',
  problem: '问题',
  decision: '决策',
  review: '复盘',
  todo: '待办',
}

/** 类型 id 合法性（读侧对脏数据 fail-closed：非法值一律视为"无类型"）。 */
export function isThoughtType(value: unknown): value is ThoughtType {
  return typeof value === 'string' && (THOUGHT_TYPES as readonly string[]).includes(value)
}
