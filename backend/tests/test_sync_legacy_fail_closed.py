from __future__ import annotations

import pytest


async def _seed_tasks(space_session, count: int) -> None:
    from app.models.task import Task

    for index in range(1, count + 1):
        space_session.add(
            Task(
                id=f"task-{index}",
                title=f"Task {index}",
                status="todo",
                priority="medium",
                tags="[]",
                updated_at="2026-07-04T10:00:00.000Z",
            )
        )
    await space_session.flush()


async def _seed_cross_entity_page(space_session) -> None:
    from app.models.quick_note import QuickNote

    await _seed_tasks(space_session, 3)
    space_session.add(
        QuickNote(
            id="quick-newer",
            content="Newer entity",
            tags="[]",
            updated_at="2026-07-04T12:00:00.000Z",
        )
    )
    await space_session.flush()


@pytest.mark.asyncio
async def test_legacy_cross_entity_truncation_raises_upgrade_error(
    space_session,
) -> None:
    from sqlalchemy import func, select

    from app.errors import CursorUpgradeRequiredError
    from app.models.sync_audit_log import SyncAuditLog
    from app.services.sync import SyncService

    await _seed_cross_entity_page(space_session)
    with pytest.raises(CursorUpgradeRequiredError) as raised:
        await SyncService(space_session, fs=None).pull(since="", limit=2)
    assert raised.value.to_domain_record("req-sync").code == (
        "cursor_upgrade_required"
    )
    assert raised.value.details == {"truncated_groups": ("tasks",)}
    audit_count = await space_session.scalar(select(func.count(SyncAuditLog.id)))
    assert audit_count == 0


@pytest.mark.asyncio
async def test_legacy_tombstone_truncation_raises_upgrade_error(
    space_session,
) -> None:
    from app.errors import CursorUpgradeRequiredError
    from app.models.tombstone import Tombstone
    from app.services.sync import SyncService

    for index in range(1, 4):
        space_session.add(
            Tombstone(
                entity_type="task",
                entity_id=f"deleted-{index}",
                deleted_at="2026-07-04T10:00:00.000Z",
            )
        )
    await space_session.flush()
    with pytest.raises(CursorUpgradeRequiredError) as raised:
        await SyncService(space_session, fs=None).pull(since="", limit=2)
    assert raised.value.details == {"truncated_groups": ("tombstones",)}


@pytest.mark.asyncio
async def test_legacy_untruncated_page_remains_compatible(space_session) -> None:
    from app.services.sync import SyncService

    await _seed_tasks(space_session, 2)
    page = await SyncService(space_session, fs=None).pull(since="", limit=2)
    assert [item["id"] for item in page["tasks"]] == ["task-1", "task-2"]
    assert page["has_more"] is False


@pytest.mark.asyncio
async def test_cursor_v2_remains_available_for_same_dataset(space_session) -> None:
    from app.services.sync import SyncService
    from app.services.sync_outbox import record_sync_event

    for index in range(1, 4):
        await record_sync_event(
            space_session,
            entity_type="task",
            entity_id=f"task-{index}",
            action="create",
            payload={"id": f"task-{index}", "title": f"Task {index}"},
        )
    page = await SyncService(space_session, fs=None).pull(cursor=0, limit=2)
    assert page["cursor_version"] == 2
    assert page["has_more"] is True


@pytest.mark.asyncio
async def test_rest_legacy_pull_returns_canonical_upgrade_error(
    space_session,
) -> None:
    from fastapi import FastAPI
    from httpx import ASGITransport, AsyncClient

    from app.deps import get_file_system, get_space_context, get_space_db
    from app.errors import register_exception_handlers
    from app.routes.v1.sync import router
    from app.services.sync_outbox import record_sync_event

    await _seed_tasks(space_session, 3)
    for index in range(1, 4):
        await record_sync_event(
            space_session,
            entity_type="task",
            entity_id=f"task-{index}",
            action="create",
            payload={"id": f"task-{index}", "title": f"Task {index}"},
        )

    async def database_override():
        yield space_session

    app = FastAPI()
    register_exception_handlers(app)
    app.include_router(router, prefix="/api/v1/sync")
    app.dependency_overrides[get_space_db] = database_override
    app.dependency_overrides[get_file_system] = lambda: None
    app.dependency_overrides[get_space_context] = lambda: {"space_id": "spc_test"}

    async with AsyncClient(
        transport=ASGITransport(app=app),
        base_url="http://test",
    ) as client:
        legacy = await client.get(
            "/api/v1/sync/pull?limit=2",
            headers={
                "Accept": "application/vnd.pomodoroxii.error+json;version=2",
                "X-Request-ID": "req-legacy-cursor",
            },
        )
        v2 = await client.get("/api/v1/sync/pull?cursor=0&limit=2")

    assert legacy.status_code == 409
    assert legacy.json() == {
        "code": "cursor_upgrade_required",
        "message": "Legacy sync cursor cannot safely advance",
        "retryable": False,
        "request_id": "req-legacy-cursor",
        "details": {"truncated_groups": ["tasks"]},
    }

    assert v2.status_code == 200
    assert v2.json()["cursor_version"] == 2
    assert v2.json()["has_more"] is True
