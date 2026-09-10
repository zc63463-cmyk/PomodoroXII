/**
 * Note list virtualization —— 固定高度列表的可视区间计算。
 *
 * ★ 为什么不引库（react-window / react-virtuoso / @tanstack/react-virtual）
 *   本列表是**定高单行**结构（标题 + 摘要两行，truncate 保证不换行），
 *   虚拟化退化成一次除法——引一个库带来的依赖、体积与 API 约束，
 *   远超这 20 行代码的收益。真出现变高项（比如以后要塞标签、封面）时再评估。
 *
 * ★ 为什么不无条件虚拟化
 *   虚拟化会牺牲三样东西：浏览器原生 Ctrl+F 查找、屏幕阅读器的完整列表语义、
 *   以及"打印/导出"时的完整性。笔记量小的时候这三样比几十毫秒更值钱。
 *   所以由调用方在**超过阈值时**才启用，小列表走原路。
 */

/**
 * 单个列表项的高度（px）。
 *
 * 由 NoteListItem 的结构推算：py-2（8+8）+ 标题 text-sm/leading-5（20）
 * + 摘要 text-xs/leading-4（16）= 52。
 * ★ 组件侧会用同样的常量显式设置行高，两者必须一致，否则会出现跳动。
 */
export const NOTE_ITEM_HEIGHT = 52

/** 上下各多渲染几项，避免快速滚动时出现空白。 */
export const DEFAULT_OVERSCAN = 4

/** 可视区间。end 不含（与 slice 一致）。 */
export interface VisibleRange {
  start: number
  end: number
}

/**
 * 计算应该渲染哪一段。
 *
 * @param scrollTop 容器滚动位置
 * @param viewportHeight 容器可视高度。**为 0 时返回全区间** ——
 *   首帧还没测量到高度（以及 jsdom 下恒为 0）时，全量渲染是唯一安全的选择，
 *   渲染 0 项会让列表直接空白。
 * @param total 总条数
 */
export function computeVisibleRange(
  scrollTop: number,
  viewportHeight: number,
  total: number,
  itemHeight: number = NOTE_ITEM_HEIGHT,
  overscan: number = DEFAULT_OVERSCAN,
): VisibleRange {
  if (itemHeight <= 0 || total <= 0) return { start: 0, end: 0 }
  // 视口高度未知 → 全量。宁可慢也不能空。
  if (viewportHeight <= 0) return { start: 0, end: total }

  const safeScrollTop = Math.max(0, scrollTop)
  const first = Math.floor(safeScrollTop / itemHeight)
  const last = Math.ceil((safeScrollTop + viewportHeight) / itemHeight)

  const safeOverscan = Math.max(0, overscan)
  const end = Math.min(total, last + safeOverscan)
  // ★ start 也要夹住：只夹 end 的话，scrollTop 超过总高度时（弹性滚动、
  //   程序设置 scrollTop 都可能）start 会算出远大于 end 的值，
  //   slice(start, end) 返回空数组 —— 列表直接空白。
  const start = Math.min(Math.max(0, first - safeOverscan), Math.max(0, total - 1))
  return { start, end: Math.max(start, end) }
}

/** 列表总高度，用于撑起滚动条。 */
export function totalListHeight(total: number, itemHeight: number = NOTE_ITEM_HEIGHT): number {
  return Math.max(0, total) * itemHeight
}
