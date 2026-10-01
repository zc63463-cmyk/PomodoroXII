/**
 * 导图编辑区**键位映射**（PXII-FEAT-KEYMAP-FLOW）—— 纯函数、无状态、无 IO。
 *
 * ## 为什么单独成模块（不写进组件）
 * 键位表是**可被单测穷举的规则集**：一条键 → 一个动作，与 React 生命周期无关。
 * 放进 `timer-map-editor.tsx` 会变成"在 JSX 里散落的 if"，既测不穷也易漂移。
 * 本模块与 MindCanvas 原生 `packages/react/src/edit/keys.ts` **同构**（同一条
 * 判定次序：修饰键优先于裸键、裸键要求无任何修饰），差异只在**动作词汇**——
 * 本项目是会话岛的五个编辑原语（D16）+ 五类思考类型直切（D9），不含文件级
 * 命令（保存/打开/撤销由页面与浏览器各司其职，见 ADR-0008 D16-a 的职责边界）。
 *
 * ## 架构红线：**输入态互斥防穿透**（本模块的第一职责）
 * 打字中的 `1` 必须是字符、`Tab` 必须是焦点移动、`Backspace` 必须是删字符 ——
 * 若这些键穿透到导图动作，用户每打一个数字都会改节点类型（数据损坏级事故）。
 * 判据落在**事件目标**上（`isTextEntryTarget`），而不是"某个 state 标志位"：
 * 标志位会因浮层关闭路径多而漏置位，事件目标是浏览器给出的**事实**。
 * 调用方（组件）另有一层保险：浮层打开时输入框 `autoFocus`，焦点天然不在画布。
 *
 * ## 为什么数字键要 `hasSelectedNode`
 * 无选中节点时按 `1` 没有任何"接收者"——直切类型必须有一个目标节点。
 * 此时把键**让给浏览器**（不匹配、不 preventDefault），比"匹配后静默忽略"更干净：
 * 前者不会吞掉用户可能依赖的原生行为。
 */
import type { ThoughtType } from './thought-types'

export type EditorKeyAction =
  | { type: 'add-child' } // Tab: 新建子节点
  | { type: 'add-sibling' } // Enter: 新建同级节点
  | { type: 'rename' } // F2: 改名
  | { type: 'delete' } // Delete / Backspace: 删除
  | { type: 'comment' } // Shift+Enter: 编辑注释
  | { type: 'promote' } // Shift+P: 升格为任务（PXII-FEAT-TASK-SPACE-P0）
  | { type: 'cancel' } // Escape: 取消选中或关闭浮层
  | { type: 'set-type'; thoughtType: ThoughtType } // 1~5: 直切思考类型
  | { type: 'navigate'; dir: 'up' | 'down' | 'left' | 'right' } // 方向键导航

/**
 * 数字键 → 思考类型。顺序 = `THOUGHT_TYPES` 的展示顺序（D9 五类），
 * 因此「1~5」与快速记录行、类型 chip 行**从左到右同序** —— 键位可被肉眼推出来。
 */
const DIGIT_TO_THOUGHT_TYPE: Readonly<Record<string, ThoughtType>> = {
  '1': 'insight',
  '2': 'problem',
  '3': 'decision',
  '4': 'review',
  '5': 'todo',
}

/**
 * 事件目标是否为**文本输入面**（input / textarea / select / contentEditable）。
 *
 * 覆盖 contentEditable：`.mm.md` 编辑器（CodeMirror）与将来的富文本节点都属此类，
 * 漏掉它等于给"在文档里打字"开一条穿透通道。
 */
export function isTextEntryTarget(target: EventTarget | null): boolean {
  if (target === null || !(target instanceof HTMLElement)) return false
  const tag = target.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  // 显式比较：jsdom 下该属性可能为 undefined（非布尔），直接返回会让"非输入面"
  // 得到 undefined —— 声明是 boolean，就不该漏出第三态
  return target.isContentEditable === true
}

/**
 * 键盘事件 → 动作（无匹配 → `null`）。判定次序即优先级：
 *
 * 1. **输入态互斥**：焦点在输入面 → 一律 `null`（红线，见文件头注）
 * 2. **组合键让位**：`Ctrl/Cmd/Alt` 组合 → `null`（浏览器/系统快捷键优先）
 * 3. **Shift 类**：仅 `Shift+Enter`（注释）与 `Shift+P`（升格，需选中节点）放行，
 *    其余 Shift 组合让位（`Shift+方向键` = 文本选区，不能抢）
 * 4. **数字键 1~5**：仅在有选中节点时直切类型
 * 5. **裸键**：节点编辑与方向导航
 *
 * @param hasSelectedNode 当前是否有可编辑节点处于选中态（数字键的接收者）
 */
export function matchEditorKey(
  e: KeyboardEvent,
  hasSelectedNode: boolean,
): EditorKeyAction | null {
  // 1. 输入态互斥防穿透（红线）
  if (isTextEntryTarget(e.target)) return null
  // 2. 组合键：本表不含任何 Ctrl/Cmd/Alt 组合
  if (e.ctrlKey || e.metaKey || e.altKey) return null
  // 3. Shift 类：注释（Shift+Enter）与升格（Shift+P，需选中节点——同数字键的
  //    "接收者"纪律，无选中让给浏览器）；其余 Shift 组合一律让位
  if (e.shiftKey) {
    if (e.key === 'Enter') return { type: 'comment' }
    // 真实键盘 Shift+P 的 e.key 是大写 'P'；大写锁定叠加时会是 'p'，一并接受
    if ((e.key === 'P' || e.key === 'p') && hasSelectedNode) return { type: 'promote' }
    return null
  }
  // 4. 数字键 1~5 直切思考类型（无选中 → 让给浏览器）
  if (hasSelectedNode) {
    const thoughtType = DIGIT_TO_THOUGHT_TYPE[e.key]
    if (thoughtType !== undefined) return { type: 'set-type', thoughtType }
  }
  // 5. 裸键：节点编辑 + 导航
  switch (e.key) {
    case 'Tab':
      return { type: 'add-child' }
    case 'Enter':
      return { type: 'add-sibling' }
    case 'F2':
      return { type: 'rename' }
    case 'Delete':
    case 'Backspace':
      return { type: 'delete' }
    case 'Escape':
      return { type: 'cancel' }
    case 'ArrowUp':
      return { type: 'navigate', dir: 'up' }
    case 'ArrowDown':
      return { type: 'navigate', dir: 'down' }
    case 'ArrowLeft':
      return { type: 'navigate', dir: 'left' }
    case 'ArrowRight':
      return { type: 'navigate', dir: 'right' }
    default:
      return null
  }
}

/**
 * 键位提示（编辑区提示行渲染用）—— **键位表与提示文案同源**，
 * 避免"改了键位忘改提示"（MindCanvas 原生 `EDITOR_KEY_BINDINGS` 同款用途）。
 */
export const EDITOR_KEY_HINTS: ReadonlyArray<{ keys: string; label: string }> = [
  { keys: 'Tab', label: '加子' },
  { keys: 'Enter', label: '同级' },
  { keys: 'F2', label: '改名' },
  { keys: 'Del', label: '删除' },
  { keys: 'Shift+Enter', label: '注释' },
  { keys: '⇧P', label: '升格为任务' },
  { keys: '1-5', label: '类型' },
  { keys: '↑↓←→', label: '导航' },
]
