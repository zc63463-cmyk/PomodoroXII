"""Tests for Note model constraints (P3.4: status CheckConstraint)."""
from __future__ import annotations

import pytest
from sqlalchemy.exc import IntegrityError

from tests.test_note_workspace_atomicity import (  # noqa: F401
    knowledge_fixture,
    uow_fixture,
)


@pytest.mark.asyncio
async def test_note_valid_status_active_accepted(space_session):
    """A note with status='active' should insert cleanly."""
    from app.models.note import Note

    note = Note(id="note-active", title="Active", status="active")
    space_session.add(note)
    await space_session.flush()
    row = await space_session.get(Note, "note-active")
    assert row.status == "active"


@pytest.mark.asyncio
async def test_note_valid_status_archived_accepted(space_session):
    """A note with status='archived' should insert cleanly."""
    from app.models.note import Note

    note = Note(id="note-archived", title="Archived", status="archived")
    space_session.add(note)
    await space_session.flush()
    row = await space_session.get(Note, "note-archived")
    assert row.status == "archived"


@pytest.mark.asyncio
async def test_note_invalid_status_raises_integrity_error(space_session):
    """Inserting a note with an invalid status should raise IntegrityError.

    P3.4 adds a CheckConstraint on notes.status restricting values to
    'active' or 'archived'. Any other value must be rejected by the DB.
    """
    from app.models.note import Note

    bad = Note(id="note-bad-status", title="Bad", status="invalid_status")
    space_session.add(bad)
    with pytest.raises(IntegrityError):
        await space_session.flush()
    # Roll back the failed SAVEPOINT so the session stays usable.
    await space_session.rollback()


# --------------------------------------------------------------------------- #
# ★ 2026-09-11 note.status 枚举值域：三方一致回归
#   原因：wire schema 只限长度、编译器（含 sync post-image）不校验值域，越界值
#   （如「草稿」）会穿过前后端校验、撞 DB CHECK 以不可读的 500 收场。这里锁定
#   「任何入口都 fail-closed，且在 DB CHECK 之前」：常量 ↔ CHECK 文本逐字一致、
#   wire schema 同源、编译器与 sync post-image 稳定领域码、合法两值全通过。
# --------------------------------------------------------------------------- #


def test_note_status_domain_matches_db_check_text() -> None:
    """共享值域常量必须与 notes 的 DB CHECK 文本逐字一致。

    常量是 wire schema / 编译器的单一事实来源，DB CHECK 是最后兜底；两者一旦
    漂移就会出现「新值前端放行、编译器放行、DB 拒绝」的第三态。约束名会被命名
    约定改写（ck_notes_check_note_status），所以按 SQL 文本断言。
    """
    from sqlalchemy import CheckConstraint

    from app.models.note import Note
    from app.schemas.note import NOTE_STATUS_VALUES

    check_texts = {
        str(constraint.sqltext)
        for constraint in Note.__table__.constraints
        if isinstance(constraint, CheckConstraint)
    }
    # 分隔符 ", " 属于既有 CHECK 文本的一部分，一并逐字锁定。
    status_sql = ", ".join(f"'{value}'" for value in NOTE_STATUS_VALUES)
    assert f"status IN ({status_sql})" in check_texts


def test_note_status_wire_schemas_use_the_shared_domain() -> None:
    """创建/更新/响应模型的值域必须来自同一常量（JSON Schema 的 enum 即证据）。"""
    from app.schemas.note import (
        NOTE_STATUS_VALUES,
        NoteBase,
        NoteCreate,
        NoteMetadataUpdate,
        NoteResponse,
    )

    for model in (NoteBase, NoteCreate, NoteMetadataUpdate, NoteResponse):
        property_schema = model.model_json_schema()["properties"]["status"]
        branches = property_schema.get("anyOf", [property_schema])
        enum_branch = next(branch for branch in branches if "enum" in branch)
        assert tuple(enum_branch["enum"]) == NOTE_STATUS_VALUES, model.__name__


@pytest.mark.asyncio
async def test_online_compiler_rejects_out_of_domain_note_status(
    knowledge_fixture,
) -> None:
    """编译器层纵深防御：直接调用者也不能把越界值写进 DB。

    REST 侧 wire schema 已 422 拦下；稳定领域错误码 + ``reason``（invalid_status），
    而且必须零副作用 —— 绝不留到 DB CHECK 抛 500。显式 null 一并拒绝：
    status 是 NOT NULL 列，null 会撞 NOT NULL 而不是 CHECK。
    """
    from app.errors import MutationRejectedError
    from app.models.note import Note
    from app.schemas.note import NOTE_STATUS_VALUES

    for index, dirty in enumerate(("草稿", "archived2", None)):
        entity_id = f"dirty-status-note-{index}"
        with pytest.raises(MutationRejectedError) as raised:
            await knowledge_fixture.store.create_note(
                knowledge_fixture.scope,
                {
                    "id": entity_id,
                    "title": "脏值",
                    "content": "x",
                    "status": dirty,
                },
                expected_version=None,
                operation_id=f"{entity_id}-create",
            )
        rejection = raised.value.rejection
        assert rejection.code == "payload_field_not_allowed"
        assert rejection.details["field"] == "status"
        assert rejection.details["reason"] == "invalid_status"
        assert tuple(rejection.details["allowed"]) == NOTE_STATUS_VALUES
        # 被拒后零副作用：DB 里没有该行。
        async with knowledge_fixture.sessions() as session:
            assert await session.get(Note, entity_id) is None

    # 合法两值必须全部通过（存储值 = 规范值，不做转换）。
    for status in NOTE_STATUS_VALUES:
        result = await knowledge_fixture.store.create_note(
            knowledge_fixture.scope,
            {
                "id": f"status-{status}",
                "title": f"合法 {status}",
                "content": "x",
                "status": status,
            },
            expected_version=None,
            operation_id=f"status-{status}-create",
        )
        assert result.value["status"] == status


@pytest.mark.asyncio
async def test_sync_post_image_rejects_out_of_domain_note_status(
    knowledge_fixture,
) -> None:
    """sync 推送的 note post-image 与 REST 共用同一值域校验面。

    ``SyncCommandMapper`` 把 ``entity.create`` 别名到 ``knowledge.note.create``，
    payload 完全由客户端自造（不经过任何 Pydantic 模型）；越界值必须给出稳定的
    领域错误码，而不是撞 DB CHECK。
    """
    from app.commands.entity import EntityCommand
    from app.errors import MutationRejectedError
    from app.registry import CATALOG
    from app.sync.commands import SyncCommandMapper
    from app.sync.contracts import SyncEventInput

    mapper = SyncCommandMapper(CATALOG, EntityCommand(CATALOG))

    def _sync_create(entity_id: str, status: object):
        return mapper.to_request(
            knowledge_fixture.scope,
            SyncEventInput(
                entity_type="note",
                entity_id=entity_id,
                action="create",
                payload={
                    "id": entity_id,
                    "title": "同步脏值",
                    "content": "body",
                    "tags": [],
                    "status": status,
                },
                expected_version=None,
                client_updated_at="2026-09-11T10:00:00.000Z",
                operation_id=f"sync-{entity_id}",
            ),
        )

    dirty = _sync_create("sync-dirty-status", "草稿")
    # 前提守卫：sync 层确实发通用名（别名落在 KnowledgeDomainPolicy 上）。
    assert dirty.name == "entity.create"
    assert dirty.entity_type == "note"

    with pytest.raises(MutationRejectedError) as raised:
        await knowledge_fixture.store.uow.execute(
            knowledge_fixture.scope, dirty, "sync-dirty-status-op"
        )
    rejection = raised.value.rejection
    assert rejection.code == "payload_field_not_allowed"
    assert rejection.details["field"] == "status"
    assert rejection.details["reason"] == "invalid_status"

    # 合法值经同一 sync 通道仍然落库（不回归既有 active/archived 行为）。
    clean = _sync_create("sync-clean-status", "archived")
    result = await knowledge_fixture.store.uow.execute(
        knowledge_fixture.scope, clean, "sync-clean-status-op"
    )
    assert dict(result.value)["status"] == "archived"
