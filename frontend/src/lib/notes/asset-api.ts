/**
 * Asset API —— 笔记里的图片 / PDF 等二进制资源。
 *
 * ★ S1 范围：上传 + 读取，**不参与同步**（asset 实体 sync_enabled=False）。
 *   笔记正文里存的是 `assets/xx/xxx.png` 这样的**相对路径**，
 *   渲染时再由 `resolveAssetUrl` 拼成可访问的 URL。
 *
 * ★ 为什么正文存相对路径而不是完整 URL
 *   - URL 里带 asset id -> 换后端地址/换设备就失效
 *   - 相对路径与后端目录一致，S3 做二进制同步时可以直接按路径对齐
 */

import { spaceApi } from '@/services/api'

/** 后端返回的资产信息（snake_case 已在 backend 侧统一为驼峰，这里保持一致）。 */
export interface NoteAsset {
  id: string
  filename: string
  mime: string
  size: number
  sha256: string
  /** 写进 Markdown 的相对路径，如 `assets/ab/<sha>.png` */
  path: string
  /** 可直接访问的 URL */
  url: string
  /** true 表示服务端已有相同内容，复用了已有行 */
  deduped: boolean
  created_at: string
}

/**
 * 上传一个资源。
 *
 * @throws 415 类型不在白名单 / 413 超过大小上限
 */
export async function uploadAsset(file: File): Promise<NoteAsset> {
  const form = new FormData()
  form.append('file', file)
  const res = await spaceApi.post<NoteAsset>('/assets', form, {
    // multipart 交给浏览器自己设置 Content-Type（必须带 boundary）
    headers: { 'Content-Type': 'multipart/form-data' },
  })
  return res.data
}

/**
 * 把笔记里的 `assets/...` 相对路径解析成可访问的 URL。
 *
 * 目前只有一种来源：后端 `/api/v1/assets/{id}/content`。但正文里存的是路径，
 * 没有 id —— 所以渲染时需要一张 path -> id 的映射（由调用方列举资产得到）。
 * 找不到就返回 null（渲染层应降级成占位符，不要显示破图）。
 */
export function resolveAssetUrl(
  path: string,
  assets: readonly NoteAsset[],
): string | null {
  const hit = assets.find((asset) => asset.path === path)
  return hit ? hit.url : null
}

/** 列出本空间的资源（用于建立 path -> url 映射）。 */
export async function listAssets(): Promise<NoteAsset[]> {
  const res = await spaceApi.get<{ items: NoteAsset[] }>('/assets')
  return res.data.items ?? []
}
