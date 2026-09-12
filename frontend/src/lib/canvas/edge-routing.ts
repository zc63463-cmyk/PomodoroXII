/**
 * 依赖画布的连线路由 —— 借鉴 draw.io（mxGraph）的三个核心设计：
 *
 * 1. **方向感知的出边/入边**（mxGraph 的 exitX/exitY/entryX/entryY 本质）：
 *    连接点永远取在节点**朝向对端的那一侧**，由两节点中心的相对位置决定，
 *    而不是像 React Flow 默认那样「就近挑桩」—— 后者在回边场景会产生
 *    绕行一圈的丑陋路径（首版被诟病的根因）。
 *
 * 2. **同侧多边的锚点分布**：多条边共用同一侧时，按对端位置排序后把锚点
 *    均分到该侧边长上（0..1 比例），避免全部挤在中点互相重叠。
 *
 * 3. **正交 + 圆角**：路径交给 React Flow 官方 ``getSmoothStepPath``，
 *    它按给定方位生成带圆角的正交折线 —— 我们只负责算对端点与方位。
 *
 * 全部纯函数，可独立快照测试。
 */

export type EdgeSide = 'left' | 'right' | 'top' | 'bottom'

export interface RoutingRect {
  x: number
  y: number
  width: number
  height: number
}

/** 某侧边长上的锚点比例（0..1）。左右侧沿高度分布，上下侧沿宽度分布。 */
export interface SideAnchor {
  side: EdgeSide
  fraction: number
}

export interface SidePair {
  sourceSide: EdgeSide
  targetSide: EdgeSide
}

export function centerOf(rect: RoutingRect): { x: number; y: number } {
  return {
    x: rect.x + rect.width / 2,
    y: rect.y + rect.height / 2,
  }
}

/**
 * 依据两节点中心的相对位置选择出边侧/入边侧：
 * 水平位移占主导 → 出 Right / 入 Left（或反向）；垂直占主导 → 上下。
 */
export function selectSides(source: RoutingRect, target: RoutingRect): SidePair {
  const from = centerOf(source)
  const to = centerOf(target)
  const dx = to.x - from.x
  const dy = to.y - from.y
  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0
      ? { sourceSide: 'right', targetSide: 'left' }
      : { sourceSide: 'left', targetSide: 'right' }
  }
  return dy >= 0
    ? { sourceSide: 'bottom', targetSide: 'top' }
    : { sourceSide: 'top', targetSide: 'bottom' }
}

/** 锚点比例 → 画布坐标。 */
export function anchorPoint(
  rect: RoutingRect,
  anchor: SideAnchor,
): { x: number; y: number } {
  const fraction = Math.min(1, Math.max(0, anchor.fraction))
  switch (anchor.side) {
    case 'left':
      return { x: rect.x, y: rect.y + rect.height * fraction }
    case 'right':
      return { x: rect.x + rect.width, y: rect.y + rect.height * fraction }
    case 'top':
      return { x: rect.x + rect.width * fraction, y: rect.y }
    case 'bottom':
      return { x: rect.x + rect.width * fraction, y: rect.y + rect.height }
  }
}

/**
 * 同侧多边的锚点比例分配：按对端中轴位置排序后均分。
 *
 * @param entries 每条边携带「对端中轴坐标」（左右侧按对端 y，上下侧按对端 x）
 * @returns edgeKey → 锚点比例
 */
export function distributeAnchors(
  entries: ReadonlyArray<{ edgeKey: string; otherCenter: number }>,
): Record<string, number> {
  const ordered = [...entries].sort((left, right) => left.otherCenter - right.otherCenter)
  const out: Record<string, number> = {}
  ordered.forEach((entry, index) => {
    out[entry.edgeKey] = ordered.length === 0 ? 0.5 : (index + 1) / (ordered.length + 1)
  })
  return out
}

// ---- 避障（draw.io 正交路由的简化版：只处理水平主干的通道平移） ----------

export interface ChannelObstacle {
  x: number
  y: number
  width: number
  height: number
}

const CORRIDOR_PAD = 12
const CORRIDOR_THICKNESS = 8

function horizontalChannelBlocked(
  x1: number,
  x2: number,
  y: number,
  obstacles: readonly ChannelObstacle[],
): boolean {
  const minX = Math.min(x1, x2) + 2
  const maxX = Math.max(x1, x2) - 2
  for (const obstacle of obstacles) {
    if (obstacle.x + obstacle.width <= minX || obstacle.x >= maxX) continue
    if (y >= obstacle.y - CORRIDOR_THICKNESS / 2 && y <= obstacle.y + obstacle.height + CORRIDOR_THICKNESS / 2) {
      return true
    }
  }
  return false
}

/**
 * 水平主干通道避障：源右缘与目标左缘之间的水平中线若穿过中间节点，
 * 把通道平移到最近的空隙（障碍上缘/下缘），候选按离原中线距离排序。
 * 无可用空隙时返回原中线（退化，不崩溃）。
 */
export function findHorizontalChannelY(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  obstacles: readonly ChannelObstacle[],
): number {
  const base = (y1 + y2) / 2
  const minX = Math.min(x1, x2)
  const maxX = Math.max(x1, x2)
  const candidates: number[] = [base]
  for (const obstacle of obstacles) {
    if (obstacle.x + obstacle.width <= minX || obstacle.x >= maxX) continue
    candidates.push(obstacle.y - CORRIDOR_PAD, obstacle.y + obstacle.height + CORRIDOR_PAD)
  }
  const ordered = [...new Set(candidates)].sort(
    (left, right) => Math.abs(left - base) - Math.abs(right - base),
  )
  for (const candidate of ordered) {
    if (!horizontalChannelBlocked(x1, x2, candidate, obstacles)) return candidate
  }
  return base
}

/** 水平正交通道路径（带圆角）—— 仅在需要通道偏移时使用，否则走官方 getSmoothStepPath。 */
export function orthogonalChannelPath(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  channelX: number,
): string {
  const radius = Math.min(8, Math.max(2, Math.abs(y2 - y1) / 2))
  const dir1 = Math.sign(channelX - x1) || 1
  const dir2 = Math.sign(x2 - channelX) || 1
  const cx1 = channelX - dir1 * radius
  const cx2 = channelX + dir2 * radius
  const sy1 = y1 + Math.sign(y2 - y1 || 1) * radius
  const sy2 = y2 - Math.sign(y2 - y1 || 1) * radius
  return `M ${x1} ${y1} L ${cx1} ${y1} Q ${channelX} ${y1} ${channelX} ${sy1}`
    + ` L ${channelX} ${sy2} Q ${channelX} ${y2} ${cx2} ${y2} L ${x2} ${y2}`
}
