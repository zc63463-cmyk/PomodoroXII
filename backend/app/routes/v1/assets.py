"""S1: note assets (images / PDFs) — upload + download, local only.

★ S1 范围
- 上传：multipart -> 校验 -> 落盘 -> 元数据写 space DB
- 下载：按 asset id 读回二进制
- **不走同步协议**（asset 实体 sync_enabled=False），S2/S3 再接入

安全：
- 落盘路径由服务端按 sha256 生成，绝不使用客户端文件名
- 扩展名白名单 + 10MB 上限
- 下载时校验 storage_key 仍在 space 目录内（防路径遍历）
"""

from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.deps import get_space_context, get_space_db
from app.models.asset import Asset
from app.services.asset import AssetRejected, AssetService
from app.settings import settings

router = APIRouter()


def _service() -> AssetService:
    return AssetService(settings.spaces_data_dir)


@router.post("", status_code=201)
async def upload_asset(
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_space_db),
    ctx: dict = Depends(get_space_context),
):
    """上传一个资源，返回可写进笔记的引用信息。"""
    space_id = ctx["space_id"]
    data = await file.read()

    try:
        stored = _service().store(
            space_id,
            file.filename or "unnamed",
            data,
            declared_mime=file.content_type,
        )
    except AssetRejected as exc:
        raise HTTPException(status_code=exc.status, detail=exc.reason) from exc

    # 同 sha256 已存在 -> 直接复用，不重复建行
    existing = (
        await db.execute(
            select(Asset).where(Asset.sha256 == stored.sha256).limit(1)
        )
    ).scalar_one_or_none()
    if existing is not None:
        return _payload(existing, deduped=True)

    asset = Asset(
        filename=stored.filename,
        mime=stored.mime,
        size=stored.size,
        sha256=stored.sha256,
        storage_key=stored.storage_key,
    )
    db.add(asset)
    await db.commit()
    await db.refresh(asset)
    return _payload(asset, deduped=False)


@router.get("")
async def list_assets(
    db: AsyncSession = Depends(get_space_db),
    ctx: dict = Depends(get_space_context),
):
    """列出本 space 的资源（S1 仅本地）。"""
    rows = (await db.execute(select(Asset).order_by(Asset.created_at.desc()))).scalars().all()
    return {"items": [_payload(a) for a in rows]}


@router.get("/content")
async def get_asset_content_by_path(
    path: str = Query(..., description="storage_key, e.g. assets/ab/<sha>.png"),
    db: AsyncSession = Depends(get_space_db),
    ctx: dict = Depends(get_space_context),
):
    """按 storage_key 读回二进制。

    ★ 为什么要有这个（而不是只用 /{id}/content）
      笔记正文里存的是**相对路径**而不是 asset id —— 换设备/换后端地址都不失效。
      编辑器渲染图片时手上只有路径、没有 id，若必须先查表拿 id 就得走异步，
      decoration 会变得很别扭。这里让后端直接吃路径，前端渲染变成纯字符串拼接。

    安全：`AssetService.read` 会解析后校验目标仍在 space 目录内（防 `../`）。
    """
    space_id = ctx["space_id"]
    data = _service().read(space_id, path)
    if data is None:
        raise HTTPException(status_code=404, detail="asset content missing")

    # 从 DB 取 mime（有则用它，没有则按扩展名猜）
    asset = (
        await db.execute(select(Asset).where(Asset.storage_key == path).limit(1))
    ).scalar_one_or_none()
    mime = asset.mime if asset is not None else _guess_mime(path)

    from fastapi.responses import Response

    return Response(content=data, media_type=mime)


@router.get("/{asset_id}/content")
async def get_asset_content(
    asset_id: str,
    db: AsyncSession = Depends(get_space_db),
    ctx: dict = Depends(get_space_context),
):
    """读回资源的二进制内容。"""
    space_id = ctx["space_id"]
    asset = (
        await db.execute(select(Asset).where(Asset.id == asset_id).limit(1))
    ).scalar_one_or_none()
    if asset is None:
        raise HTTPException(status_code=404, detail="asset not found")

    data = _service().read(space_id, asset.storage_key)
    if data is None:
        raise HTTPException(status_code=404, detail="asset content missing")

    from fastapi.responses import Response

    return Response(content=data, media_type=asset.mime)


def _guess_mime(path: str) -> str:
    """按扩展名猜 MIME（DB 里查不到时的兜底）。"""
    from app.services.asset import ALLOWED_TYPES

    ext = Path(path).suffix.lower()
    return ALLOWED_TYPES.get(ext, "application/octet-stream")


def _payload(asset: Asset, *, deduped: bool = False) -> dict:
    """响应体：带上可直接粘进 Markdown 的相对路径。"""
    return {
        "id": asset.id,
        "filename": asset.filename,
        "mime": asset.mime,
        "size": asset.size,
        "sha256": asset.sha256,
        # 笔记里写这个相对路径；渲染时再拼成可访问的 URL
        "path": asset.storage_key,
        "url": f"/api/v1/assets/{asset.id}/content",
        "deduped": deduped,
        "created_at": asset.created_at,
    }
