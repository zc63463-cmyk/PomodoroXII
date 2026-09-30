"""工作导图（``.mm.md``）读写端点 —— ADR-0008 的 S2 落地。

**职责边界**：本路由只做字节搬运。解析、建岛、布局由**前端持有的 MindCanvas
kernel（TypeScript）**完成并在前端调用本端点保存；后端不理解导图语义。

安全与纪律：

- 需要 space token（与 notes / assets 同级的 space-scoped 资源）
- 写入前校验工作项真实存在（fail-closed，防任意 id 落盘）
- 路径校验与原子写由 ``WorkMapService`` 负责（防 ``../``、防半截文件）
- 导图**不进 sync v2 账本**（ADR-0008 D2 / D6），故本路由不产生同步事件
"""
from __future__ import annotations

from fastapi import APIRouter, Body, Depends, HTTPException
from fastapi.responses import PlainTextResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.deps import get_space_context, get_space_db
from app.models.work_item import WorkItem
from app.services.work_map import WorkMapRejected, WorkMapService
from app.settings import settings

router = APIRouter()


def _service() -> WorkMapService:
    return WorkMapService(settings.spaces_data_dir)


@router.get("/{work_item_id}", response_class=PlainTextResponse)
async def get_work_map(
    work_item_id: str,
    ctx: dict = Depends(get_space_context),
) -> str:
    """读取工作导图原文；不存在返回 404（语义 = 这份导图还没有）。"""
    text = _service().read(ctx["space_id"], work_item_id)
    if text is None:
        raise HTTPException(status_code=404, detail="work map not found")
    return text


@router.put("/{work_item_id}")
async def put_work_map(
    work_item_id: str,
    body: str = Body(..., media_type="text/plain"),
    db: AsyncSession = Depends(get_space_db),
    ctx: dict = Depends(get_space_context),
) -> dict[str, object]:
    """保存工作导图原文（整份覆盖，原子写）。

    前端每次建岛后回写整份 ``.mm.md``；后端不做 diff、不解析。
    """
    space_id = str(ctx["space_id"])
    # fail-closed：只允许给真实存在的工作项建图
    exists = (
        await db.execute(select(WorkItem.id).where(WorkItem.id == work_item_id))
    ).scalar_one_or_none()
    if exists is None:
        raise HTTPException(status_code=404, detail="work item not found")

    try:
        written = _service().write(space_id, work_item_id, body)
    except WorkMapRejected as exc:
        raise HTTPException(status_code=exc.status, detail=exc.reason) from exc

    return {"work_item_id": work_item_id, "bytes": written}
