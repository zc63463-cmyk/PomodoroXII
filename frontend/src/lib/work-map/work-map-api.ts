/**
 * 工作导图（`.mm.md`）端点客户端 —— ADR-0008 S2 收口。
 *
 * ## 端点契约（backend/app/routes/v1/work_maps.py，space token）
 * ```
 * GET /api/v1/work-maps/{workItemId}   200 原文 / 404「这份导图还没有」
 * PUT /api/v1/work-maps/{workItemId}   整份覆盖（text/plain，临时文件 + 原子替换）
 * ```
 *
 * ## 照 ADR-0008 抄写的契约要点（改动前先读）
 * - 后端只做**字节搬运**，不解析导图语义（D2）；解析/建岛/布局全在前端
 * - **404 不是错误**，是「尚无导图」的正常状态 → 本客户端归一为 `null`，
 *   由调用方决定是否给新文档建岛（session-island 的 `buildFreshDocument`）
 * - **不进 sync v2 账本**（D2 / D6）：这里只是一次文件读写，不产生同步事件，
 *   也不应被当作"同步失败"重试
 * - 体积上限 2MB（服务端 413）；非法 work_item_id 服务端 400 —— 都是
 *   调用方传错，直接抛给调用方处理（建岛方会 fail-soft 兜住）
 *
 * ## 为什么原文不做任何转换
 * `.mm.md` 是纯文本事实源，用户的排版就是内容本身。任何 JSON 化/规范化
 * 都会把它变成"第二份事实"——读写两端都保持**原字节往返**。
 */
import axios from 'axios'

import { spaceApi } from '@/services/api'

/**
 * 读回导图原文。
 *
 * @returns 原文；这份导图尚不存在（404）时返回 `null`。
 *          其余错误（网络/401/403/413…）原样抛出 —— fail-soft 由调用方决定。
 */
export async function readWorkMap(workItemId: string): Promise<string | null> {
  try {
    const res = await spaceApi.get<string>(
      `/work-maps/${encodeURIComponent(workItemId)}`,
      { responseType: 'text' },
    )
    return typeof res.data === 'string' ? res.data : String(res.data ?? '')
  } catch (error) {
    if (axios.isAxiosError(error) && error.response?.status === 404) return null
    throw error
  }
}

/**
 * 整份覆盖保存导图原文（服务端原子写）。
 *
 * @returns 服务端回执的写入字节数（仅信息性，调用方通常不需要）。
 */
export async function writeWorkMap(
  workItemId: string,
  text: string,
): Promise<number> {
  const res = await spaceApi.put<{ work_item_id: string; bytes: number }>(
    `/work-maps/${encodeURIComponent(workItemId)}`,
    text,
    // 显式 text/plain：端点 Body 以 text/plain 接收，且避免 axios 把
    // 字符串当 JSON 序列化（双引号包裹会破坏导图原文）。
    { headers: { 'Content-Type': 'text/plain' } },
  )
  return typeof res.data?.bytes === 'number' ? res.data.bytes : 0
}
