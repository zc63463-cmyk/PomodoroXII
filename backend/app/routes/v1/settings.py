"""REST routes for application settings (key-value store).

Settings are stored as ``{key: value}`` string pairs in the ``settings``
table.  The model is keyed by a natural string key (not a UUID) and does
not use ``SyncMixin``, so these routes bypass ``BaseService`` and query
the ORM directly.

- ``GET`` — return all settings as a ``{key: value}`` dict.
- ``PUT`` — upsert a batch of settings.  Keys in ``PROTECTED_KEYS`` are
  rejected (never written) and reported back in the response.

Routes commit; writes are flushed incrementally then committed once.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.deps import get_space_db, get_space_context
from app.models.setting import Setting
from app.services.time import utc_now_iso

router = APIRouter()

# Keys that may never be written via the API.
PROTECTED_KEYS = {"id"}


@router.get("")
async def get_settings(
    db: AsyncSession = Depends(get_space_db),
    ctx: dict = Depends(get_space_context),
):
    """Return all settings as a ``{key: value}`` mapping."""
    res = await db.execute(select(Setting))
    rows = res.scalars().all()
    return {row.key: row.value for row in rows}


@router.put("")
async def update_settings(
    data: dict[str, str],
    db: AsyncSession = Depends(get_space_db),
    ctx: dict = Depends(get_space_context),
):
    """Upsert a batch of settings, rejecting protected keys.

    Request body is a JSON object ``{key: value, ...}``.  Protected keys
    are skipped and returned in ``rejected``; all others are inserted or
    updated.
    """
    rejected: list[str] = []
    updated: dict[str, str] = {}
    now = utc_now_iso()

    for key, value in data.items():
        if key in PROTECTED_KEYS:
            rejected.append(key)
            continue
        existing = await db.get(Setting, key)
        if existing is None:
            db.add(Setting(key=key, value=str(value), updated_at=now))
        else:
            existing.value = str(value)
            existing.updated_at = now
        updated[key] = str(value)

    await db.flush()
    await db.commit()
    return {"updated": updated, "rejected": rejected}
