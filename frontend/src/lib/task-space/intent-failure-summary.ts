/**
 * ★ 2026-09-11 intent 队列失败哲学 = 一次性 + 可见（方案 A，决策记录见
 *   lib/direct-command-intents.ts 的 classifyIntentFailure 注释）。
 *
 * 失败的 intent 是**永久终态**（resume 只扫 prepared/in_flight），旧文案
 * 「请刷新页面重试」对它们无效 —— 刷新不会让它们复活。这里把失败的操作类型
 * （handler_error:<kind>）或服务端拒绝码翻译成可读提示，引导用户在原位置
 * 重新执行：绝大多数 intent 的输入仍留在表单草稿里，重新执行会生成新 intent
 * （submit_review 的草稿持久化在 sessionReviewDrafts）。
 */

/** intent kind → 中文动作名。新增 kind 必须同步补（缺省回退「一项操作」）。 */
const INTENT_KIND_LABELS: Record<string, string> = {
  create_project: '新建项目',
  create_work_item: '新建工作项',
  update_work_item: '编辑工作项',
  move_work_item: '移动工作项',
  transition_work_item: '切换状态',
  trash_work_item: '删除工作项',
  restore_work_item: '恢复工作项',
  create_relation: '添加依赖',
  remove_relation: '解除依赖',
  // ★ 2026-09-12（D2 / ADR-0004）：解除确认（「需要解决」区块的按钮）。
  resolve_relation: '确认依赖解除',
  add_work_item_labels: '添加标签',
  remove_work_item_labels: '移除标签',
  create_label: '新建标签',
  update_label: '编辑标签',
  archive_label: '归档标签',
  submit_review: '提交复盘',
}

/** 服务端规范化拒绝码 → 中文原因；未列出的码回退到通用文案（绝不透出英文码）。 */
const CANONICAL_CODE_LABELS: Record<string, string> = {
  version_conflict: '版本冲突',
  not_found: '目标不存在',
  project_key_conflict: '项目标识冲突',
  idempotency_conflict: '重复提交',
  validation_error: '内容校验未通过',
  payload_field_not_allowed: '内容校验未通过',
}

const HANDLER_ERROR_PREFIX = 'handler_error:'
const GENERIC_LABEL = '同步被拒绝'
const GENERIC_KIND_LABEL = '一项操作'

/** 单个失败码 → 中文标签（去重由 summarizeIntentFailures 负责）。 */
export function intentFailureLabel(code: string): string {
  if (code.startsWith(HANDLER_ERROR_PREFIX)) {
    const kind = code.slice(HANDLER_ERROR_PREFIX.length)
    return INTENT_KIND_LABELS[kind] ?? GENERIC_KIND_LABEL
  }
  return CANONICAL_CODE_LABELS[code] ?? GENERIC_LABEL
}

/**
 * 把 failed 列表翻译成一条可读提示；无失败返回 null。
 * 示例：`有 2 项操作未能提交（提交复盘、移动工作项），请重新执行对应操作。`
 */
export function summarizeIntentFailures(
  failed: ReadonlyArray<{ code: string }>,
): string | null {
  if (failed.length === 0) return null
  const labels = [...new Set(failed.map((entry) => intentFailureLabel(entry.code)))]
  return `有 ${failed.length} 项操作未能提交（${labels.join('、')}），请重新执行对应操作。`
}
