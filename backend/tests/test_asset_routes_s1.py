"""S1 asset 路由：上传/列出/下载（本机，不进同步协议）."""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.db.base import Base
from app.deps import get_space_context, get_space_db
from app.models.asset import Asset  # noqa: F401  确保表被建出来
from app.routes.v1.assets import router as assets_router

PNG = b"\x89PNG\r\n\x1a\n" + b"0" * 64
SPACE_ID = "sp-assets-test"


@pytest.fixture()
async def client(tmp_path, monkeypatch):
    """真实内存 SQLite + 临时 assets 目录。"""
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    Session = async_sessionmaker(engine, expire_on_commit=False)

    # 把上传目录指到 tmp_path，避免测试污染真实 data/
    import app.routes.v1.assets as assets_route

    monkeypatch.setattr(
        assets_route, "_service", lambda: assets_route.AssetService(tmp_path / "spaces")
    )

    app = FastAPI()
    app.include_router(assets_router, prefix="/api/v1/assets")
    app.dependency_overrides[get_space_db] = lambda: Session()
    app.dependency_overrides[get_space_context] = lambda: {"space_id": SPACE_ID, "user_id": "u1"}

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac

    await engine.dispose()


@pytest.mark.asyncio
async def test_upload_returns_path(client: AsyncClient) -> None:
    resp = await client.post(
        "/api/v1/assets", files={"file": ("shot.png", PNG, "image/png")}
    )
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["mime"] == "image/png"
    assert body["size"] == len(PNG)
    assert body["path"].startswith("assets/")
    assert body["url"] == f"/api/v1/assets/{body['id']}/content"


@pytest.mark.asyncio
async def test_rejects_disallowed_type(client: AsyncClient) -> None:
    resp = await client.post(
        "/api/v1/assets", files={"file": ("x.exe", b"MZ", "application/octet-stream")}
    )
    assert resp.status_code == 415


@pytest.mark.asyncio
async def test_download_roundtrip(client: AsyncClient) -> None:
    up = await client.post(
        "/api/v1/assets", files={"file": ("shot.png", PNG, "image/png")}
    )
    asset_id = up.json()["id"]
    got = await client.get(f"/api/v1/assets/{asset_id}/content")
    assert got.status_code == 200
    assert got.content == PNG
    assert got.headers["content-type"].startswith("image/png")


@pytest.mark.asyncio
async def test_list_assets(client: AsyncClient) -> None:
    await client.post("/api/v1/assets", files={"file": ("a.png", PNG, "image/png")})
    await client.post("/api/v1/assets", files={"file": ("b.pdf", b"%PDF-1.4", "application/pdf")})
    body = (await client.get("/api/v1/assets")).json()
    assert len(body["items"]) == 2


@pytest.mark.asyncio
async def test_same_content_is_deduped(client: AsyncClient) -> None:
    """同一份内容上传两次，只建一行（sha256 命中）。"""
    first = await client.post(
        "/api/v1/assets", files={"file": ("a.png", PNG, "image/png")}
    )
    second = await client.post(
        "/api/v1/assets", files={"file": ("copy.png", PNG, "image/png")}
    )
    assert second.json()["id"] == first.json()["id"]
    assert second.json()["deduped"] is True


@pytest.mark.asyncio
async def test_missing_asset_404(client: AsyncClient) -> None:
    assert (await client.get("/api/v1/assets/nope/content")).status_code == 404


@pytest.mark.asyncio
async def test_download_by_path(client: AsyncClient) -> None:
    """★ 编辑器渲染只能拿到 path（不是 id），必须支持按 path 下载。"""
    up = await client.post(
        "/api/v1/assets", files={"file": ("shot.png", PNG, "image/png")}
    )
    path = up.json()["path"]
    got = await client.get("/api/v1/assets/content", params={"path": path})
    assert got.status_code == 200
    assert got.content == PNG
    assert got.headers["content-type"].startswith("image/png")


@pytest.mark.asyncio
async def test_download_by_path_blocks_traversal(client: AsyncClient) -> None:
    got = await client.get(
        "/api/v1/assets/content", params={"path": "../../../etc/passwd"}
    )
    assert got.status_code == 404


@pytest.mark.asyncio
async def test_download_by_path_missing(client: AsyncClient) -> None:
    got = await client.get(
        "/api/v1/assets/content", params={"path": "assets/00/nope.png"}
    )
    assert got.status_code == 404
