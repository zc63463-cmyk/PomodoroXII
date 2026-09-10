import { describe, expect, it } from 'vitest'

import { resolveAssetUrl, type NoteAsset } from './asset-api'

const ASSETS: NoteAsset[] = [
  {
    id: 'a1',
    filename: 'shot.png',
    mime: 'image/png',
    size: 100,
    sha256: 'deadbeef',
    path: 'assets/de/deadbeef.png',
    url: '/api/v1/assets/a1/content',
    deduped: false,
    created_at: '2026-09-06T00:00:00.000Z',
  },
  {
    id: 'a2',
    filename: 'paper.pdf',
    mime: 'application/pdf',
    size: 200,
    sha256: 'cafe',
    path: 'assets/ca/cafe.pdf',
    url: '/api/v1/assets/a2/content',
    deduped: true,
    created_at: '2026-09-06T00:00:00.000Z',
  },
]

describe('resolveAssetUrl', () => {
  it('★ 已知路径 -> 解析出可访问 URL', () => {
    expect(resolveAssetUrl('assets/de/deadbeef.png', ASSETS)).toBe('/api/v1/assets/a1/content')
  })

  it('★ 未知路径 -> null（渲染层应降级成占位，不要显示破图）', () => {
    expect(resolveAssetUrl('assets/00/unknown.png', ASSETS)).toBeNull()
  })

  it('★ 空资产表 -> null', () => {
    expect(resolveAssetUrl('assets/de/deadbeef.png', [])).toBeNull()
  })

  it('★ 完整 URL 不会被误解析（只认相对路径）', () => {
    expect(resolveAssetUrl('https://example.com/a.png', ASSETS)).toBeNull()
  })
})
