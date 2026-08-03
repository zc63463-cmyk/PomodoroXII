from __future__ import annotations

import hashlib
import inspect
import json
import sqlite3
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path
from types import SimpleNamespace
from typing import TYPE_CHECKING, Any

import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import async_sessionmaker

import app.mutation.types as mutation_types
from app.errors import IdempotencyConflictError, SpaceRecoveryRequiredError
from app.file_system.engine.base import FileSystemProjectionExecutor, StorageBase
from app.file_system.interfaces import ProjectionAuthoritySnapshot
from app.models.mutation import MutationBatch, MutationOperation, MutationStep
from app.models.note import Note
from app.models.project import Project
from app.models.quick_note import QuickNote
from app.models.schedule import Schedule
from app.models.sync_outbox import SyncOutbox
from app.models.sync_state import SyncState
from app.models.work_item import WorkItem
from app.mutation.journal import MutationJournal
from app.mutation.recovery import MutationRecovery
from app.mutation.staging import StageStore
from app.mutation.types import (
    DbMutationPlan,
    MutationCommand,
    MutationRequest,
    MutationState,
    StepState,
    SyncEventPlan,
    bounded_child_operation_id,
)
from app.mutation.unit_of_work import (
    AuthorityOverlay,
    BatchCompilation,
    DbMutationInterpreter,
    MutationCompiler,
    MutationUnitOfWork,
    compile_catalog_entity_command,
)
from app.registry import CATALOG
from app.runtime.contained_io import BoundDirectoryHandle, BoundStageDirectory
from app.runtime.leases import LeaseMode, RuntimeLeaseCoordinator

if TYPE_CHECKING:
    from app.knowledge.store import KnowledgeStore


def test_knowledge_commands_preserve_note_body_as_canonical_intent() -> None:
    from app.knowledge.commands import KnowledgeCommands

    commands = KnowledgeCommands()
    request = commands.create_note_request(
        {
            "id": "n-knowledge",
            "title": "Paper",
            "folder_id": None,
            "content": "Body term",
        },
        expected_version=None,
    )

    assert request.name == "knowledge.note.create"
    assert request.entity_type == "note"
    assert request.entity_id == "n-knowledge"
    assert request.payload["content"] == "Body term"


def test_frontmatter_serialization_has_canonical_order_and_lf() -> None:
    from app.file_system.frontmatter import serialize_frontmatter

    encoded = serialize_frontmatter(
        {
            "updated_at": "2026-07-22T00:00:01.000Z",
            "folder_id": "f1",
            "tags": ["research"],
            "id": "n1",
            "created_at": "2026-07-22T00:00:00.000Z",
            "title": "Paper",
            "content_hash": "sha256:body",
        }
    )

    assert encoded == (
        "---\n"
        "id: n1\n"
        "title: Paper\n"
        "tags: [research]\n"
        "folder_id: f1\n"
        "content_hash: sha256:body\n"
        "created_at: 2026-07-22T00:00:00.000Z\n"
        "updated_at: 2026-07-22T00:00:01.000Z\n"
        "---\n"
    )
    assert "\r" not in encoded


def test_projection_rebuild_requires_one_projection_per_authority_row() -> None:
    from app.knowledge.commands import KnowledgeCommands
    from app.mutation.unit_of_work import _validate_compiled_command

    request = KnowledgeCommands().rebuild_projection_request("space-test")
    command = MutationCommand.from_effects(
        request=request,
        db_plans=(),
        projections=(),
        sync_events=(),
        result_value={"rebuiltFolders": 1, "rebuiltNotes": 0},
    )
    authority = AuthorityOverlay(
        CATALOG,
        {("folder", "f-required"): {"id": "f-required"}},
    )

    with pytest.raises(
        SpaceRecoveryRequiredError,
        match="complete locked authority",
    ):
        _validate_compiled_command(command, CATALOG, authority=authority)


@pytest.mark.asyncio
async def test_consistency_verify_requires_existing_paths_without_creating(
    tmp_path,
) -> None:
    from app.knowledge.consistency import KnowledgeConsistencyChecker, SpaceDataView

    view = SpaceDataView(
        space_id="missing",
        db_path=tmp_path / "missing-space.db",
        notes_dir=tmp_path / "missing-notes",
        index_db=tmp_path / "missing-index.db",
        catalog_hash=CATALOG.hash,
    )

    with pytest.raises(FileNotFoundError):
        await KnowledgeConsistencyChecker().verify(view)

    assert not view.db_path.exists()
    assert not view.notes_dir.exists()
    assert not view.index_db.exists()


def test_note_create_projection_set_is_deterministic_and_complete() -> None:
    from app.knowledge.projections import KnowledgeProjectionBuilder

    row = {
        "id": "n1",
        "title": "Paper",
        "content_hash": hashlib.sha256(b"Body term").hexdigest(),
        "word_count": 2,
        "summary": "",
        "tags": '["research"]',
        "category": None,
        "folder_id": "f1",
        "status": "active",
        "trashed_at": None,
        "created_at": "2026-07-22T00:00:00.000Z",
        "updated_at": "2026-07-22T00:00:00.000Z",
        "version": 1,
    }
    builder = KnowledgeProjectionBuilder()

    first = builder.build_note(
        before_row=None,
        after_row=row,
        before_path=None,
        before_markdown=None,
        body="Body term",
    )
    second = builder.build_note(
        before_row=None,
        after_row=row,
        before_path=None,
        before_markdown=None,
        body="Body term",
    )

    assert first == second
    assert [projection.ordinal for projection in first] == [0, 1, 2]
    assert [projection.tag.value for projection in first] == [
        "markdown_write",
        "index_replace",
        "fts_replace",
    ]
    assert str(first[0].target) == "notes/f1/n1-paper.md"
    assert b"tags: [research]" in first[0].after


@pytest.mark.asyncio
async def test_knowledge_note_create_compiles_db_markdown_index_fts_and_sync(
    uow_fixture,
) -> None:
    from app.knowledge.commands import KnowledgeCommands
    from app.knowledge.projections import KnowledgeDomainPolicy

    request = KnowledgeCommands().create_note_request(
        {
            "id": "n-compiled",
            "title": "Compiled",
            "folder_id": None,
            "tags": ["atomic"],
            "content": "authoritative body",
        },
        expected_version=None,
    )
    compiler = MutationCompiler(CATALOG, [KnowledgeDomainPolicy()])
    item = mutation_types.PreparedBatchItem(
        0,
        "knowledge-create",
        request.request_hash,
        request,
        None,
    )

    async with uow_fixture.sessions() as session:
        compiled = await compiler.compile_batch(uow_fixture.scope, (item,), session)

    command = compiled.commands[0]
    after = command.db_plans[0].after_row
    assert after is not None
    assert after["content_hash"] == hashlib.sha256(b"authoritative body").hexdigest()
    assert after["tags"] == '["atomic"]'
    assert [projection.tag.value for projection in command.projections] == [
        "markdown_write",
        "index_replace",
        "fts_replace",
    ]
    assert command.sync_events[0].payload["content"] == "authoritative body"


@pytest.mark.asyncio
async def test_folder_create_is_visible_to_note_create_in_same_compilation(
    uow_fixture,
) -> None:
    from app.commands import EntityCommand, FolderDomainPolicy
    from app.knowledge.commands import KnowledgeCommands
    from app.knowledge.projections import KnowledgeDomainPolicy

    folder = EntityCommand(CATALOG).create(
        uow_fixture.scope,
        "folder",
        {"id": "f-batch", "name": "Research"},
        expected_version=None,
    )
    note = KnowledgeCommands().create_note_request(
        {
            "id": "n-batch",
            "title": "Paper",
            "folder_id": "f-batch",
            "content": "Batch body",
        },
        expected_version=None,
    )
    compiler = MutationCompiler(
        CATALOG,
        [FolderDomainPolicy(), KnowledgeDomainPolicy()],
    )
    items = tuple(
        mutation_types.PreparedBatchItem(
            index,
            f"knowledge-batch-{index}",
            request.request_hash,
            request,
            None,
        )
        for index, request in enumerate((folder, note))
    )

    async with uow_fixture.sessions() as session:
        compiled = await compiler.compile_batch(uow_fixture.scope, items, session)

    assert compiled.rejected == ()
    assert [command.request.entity_type for command in compiled.commands] == [
        "folder",
        "note",
    ]


@pytest.mark.asyncio
async def test_note_metadata_update_compiles_rename_frontmatter_index_and_fts(
    uow_fixture,
) -> None:
    from app.commands import EntityCommand, FolderDomainPolicy
    from app.knowledge.commands import KnowledgeCommands
    from app.knowledge.projections import KnowledgeDomainPolicy
    from app.mutation.unit_of_work import _validate_compiled_command

    commands = KnowledgeCommands()
    folder = EntityCommand(CATALOG).create(
        uow_fixture.scope,
        "folder",
        {"id": "f2", "name": "Destination"},
        expected_version=None,
    )
    create = commands.create_note_request(
        {
            "id": "n-meta",
            "title": "Old",
            "folder_id": None,
            "content": "Body term",
        },
        expected_version=None,
    )
    update = commands.update_note_metadata_request(
        "n-meta",
        {"title": "New", "folder_id": "f2", "tags": ["tag"]},
        expected_version=1,
    )
    compiler = MutationCompiler(
        CATALOG,
        [FolderDomainPolicy(), KnowledgeDomainPolicy()],
    )
    items = tuple(
        mutation_types.PreparedBatchItem(
            index,
            f"knowledge-meta-{index}",
            request.request_hash,
            request,
            None,
        )
        for index, request in enumerate((folder, create, update))
    )

    async with uow_fixture.sessions() as session:
        compiled = await compiler.compile_batch(uow_fixture.scope, items, session)

    update_command = compiled.commands[2]
    assert update_command.result_value["version"] == 2
    assert [projection.tag.value for projection in update_command.projections] == [
        "path_rename",
        "markdown_write",
        "index_replace",
        "fts_replace",
    ]
    assert update_command.sync_events[0].payload["content"] == "Body term"
    markdown = next(
        projection.after
        for projection in update_command.projections
        if projection.tag.value == "markdown_write"
    )
    assert markdown is not None
    assert b"title: New" in markdown
    assert b"folder_id: f2" in markdown
    assert b"tags: [tag]" in markdown
    _validate_compiled_command(update_command.persisted(), CATALOG)


def test_filesystem_projection_executor_has_no_second_note_version_writer() -> None:
    """Note version backups must be explicit persisted projections only."""
    from pathlib import Path

    source = (
        Path(__file__).resolve().parents[1]
        / "app"
        / "file_system"
        / "engine"
        / "base.py"
    ).read_text(encoding="utf-8")
    assert "_record_projection_note_version" not in source
    assert "record_projection_versions" not in source


@pytest.mark.asyncio
async def test_persisted_folder_cascade_binds_each_note_projection(
    knowledge_fixture,
) -> None:
    """Persisted recovery binds path projections per Note, not by global tag."""
    from app.mutation.unit_of_work import _validate_compiled_command

    kf = knowledge_fixture
    await kf.store.create_folder(
        kf.scope,
        {"id": "f-multi-note", "name": "Multi Note"},
        expected_version=None,
        operation_id="create-multi-note-folder",
    )
    for note_id in ("n-multi-a", "n-multi-b"):
        await kf.store.create_note(
            kf.scope,
            {
                "id": note_id,
                "title": note_id,
                "folder_id": "f-multi-note",
                "content": f"body-{note_id}",
            },
            expected_version=None,
            operation_id=f"create-{note_id}",
        )

    request = kf.store.entity_commands.delete(
        kf.scope, "folder", "f-multi-note", expected_version=1
    )
    item = mutation_types.PreparedBatchItem(
        0, "compile-multi-note-cascade", request.request_hash, request, None
    )
    async with kf.sessions() as session:
        compilation = await kf.store.uow.compiler.compile_batch(
            kf.scope, (item,), session
        )

    assert compilation.rejected == ()
    assert len(compilation.commands) == 1
    _validate_compiled_command(compilation.commands[0].persisted(), CATALOG)


@pytest.mark.asyncio
async def test_note_content_update_rewrites_body_index_fts_and_sync(uow_fixture) -> None:
    from app.knowledge.commands import KnowledgeCommands
    from app.knowledge.projections import KnowledgeDomainPolicy

    commands = KnowledgeCommands()
    requests = (
        commands.create_note_request(
            {"id": "n-content", "title": "Paper", "content": "Old body"},
            expected_version=None,
        ),
        commands.update_note_content_request(
            "n-content", "New body term", expected_version=1
        ),
    )
    compiler = MutationCompiler(CATALOG, [KnowledgeDomainPolicy()])
    items = tuple(
        mutation_types.PreparedBatchItem(
            index, f"knowledge-content-{index}", request.request_hash, request, None
        )
        for index, request in enumerate(requests)
    )

    async with uow_fixture.sessions() as session:
        compiled = await compiler.compile_batch(uow_fixture.scope, items, session)

    command = compiled.commands[1]
    assert [projection.tag.value for projection in command.projections] == [
        "markdown_write",
        "index_replace",
        "markdown_write",
        "index_replace",
        "fts_replace",
    ]
    version_id = f"v_{requests[1].request_hash[:12]}"
    assert [str(projection.target) for projection in command.projections[:2]] == [
        f".meta/version_backups/{version_id}.md",
        f"index/note_versions/version_id/{version_id}",
    ]
    assert command.projections[0].after is not None
    assert b"Old body" in command.projections[0].after
    assert command.result_value["version"] == 2
    assert command.result_value["content_hash"] == hashlib.sha256(
        b"New body term"
    ).hexdigest()
    assert command.sync_events[0].payload["content"] == "New body term"


@pytest.mark.asyncio
async def test_note_combined_update_renames_and_rewrites_authorities(uow_fixture) -> None:
    from app.file_system.frontmatter import extract_frontmatter
    from app.knowledge.commands import KnowledgeCommands
    from app.knowledge.projections import KnowledgeDomainPolicy

    commands = KnowledgeCommands()
    requests = (
        commands.create_note_request(
            {"id": "n-combined", "title": "Old", "content": "Old body"},
            expected_version=None,
        ),
        commands.update_note_request(
            "n-combined",
            {"title": "New", "tags": ["combined"], "content": "Combined body"},
            expected_version=1,
        ),
    )
    compiler = MutationCompiler(CATALOG, [KnowledgeDomainPolicy()])
    items = tuple(
        mutation_types.PreparedBatchItem(
            index, f"knowledge-combined-{index}", request.request_hash, request, None
        )
        for index, request in enumerate(requests)
    )

    async with uow_fixture.sessions() as session:
        compiled = await compiler.compile_batch(uow_fixture.scope, items, session)

    command = compiled.commands[1]
    assert [projection.tag.value for projection in command.projections] == [
        "path_rename",
        "markdown_write",
        "index_replace",
        "fts_replace",
    ]
    markdown = next(
        projection.after
        for projection in command.projections
        if projection.tag.value == "markdown_write"
    )
    assert markdown is not None
    metadata, body = extract_frontmatter(markdown.decode("utf-8"))
    assert metadata is not None
    assert metadata["title"] == "New"
    assert metadata["tags"] == ["combined"]
    assert body == "Combined body"


@pytest.mark.asyncio
@pytest.mark.parametrize("folder_state", ["missing", "trashed"])
async def test_note_create_rejects_inactive_folder(uow_fixture, folder_state) -> None:
    from app.commands import EntityCommand, FolderDomainPolicy
    from app.knowledge.commands import KnowledgeCommands
    from app.knowledge.projections import KnowledgeDomainPolicy

    requests = []
    if folder_state == "trashed":
        requests.append(
            EntityCommand(CATALOG).create(
                uow_fixture.scope,
                "folder",
                {
                    "id": "f-inactive",
                    "name": "Inactive",
                    "trashed_at": "2026-07-22T00:00:00.000Z",
                },
                expected_version=None,
            )
        )
    requests.append(
        KnowledgeCommands().create_note_request(
            {
                "id": f"n-{folder_state}",
                "title": "Rejected",
                "folder_id": "f-inactive",
                "content": "Body",
            },
            expected_version=None,
        )
    )
    compiler = MutationCompiler(
        CATALOG, [FolderDomainPolicy(), KnowledgeDomainPolicy()]
    )
    items = tuple(
        mutation_types.PreparedBatchItem(
            index, f"inactive-folder-{index}", request.request_hash, request, None
        )
        for index, request in enumerate(requests)
    )

    async with uow_fixture.sessions() as session:
        compiled = await compiler.compile_batch(uow_fixture.scope, items, session)

    assert [rejection.code for rejection in compiled.rejected] == [
        "relation_endpoint_missing"
    ]


@pytest.mark.asyncio
async def test_folder_rename_and_move_keep_descendant_note_path_stable(
    uow_fixture,
) -> None:
    from app.commands import EntityCommand, FolderDomainPolicy
    from app.knowledge.commands import KnowledgeCommands
    from app.knowledge.projections import KnowledgeDomainPolicy

    entities = EntityCommand(CATALOG)
    requests = (
        entities.create(
            uow_fixture.scope,
            "folder",
            {"id": "f-root-a", "name": "Root A"},
            expected_version=None,
        ),
        entities.create(
            uow_fixture.scope,
            "folder",
            {"id": "f-root-b", "name": "Root B"},
            expected_version=None,
        ),
        entities.create(
            uow_fixture.scope,
            "folder",
            {"id": "f-child", "name": "Child", "parent_id": "f-root-a"},
            expected_version=None,
        ),
        KnowledgeCommands().create_note_request(
            {
                "id": "n-descendant",
                "title": "Stable",
                "folder_id": "f-child",
                "content": "Body",
            },
            expected_version=None,
        ),
        entities.update(
            uow_fixture.scope,
            "folder",
            "f-child",
            {"name": "Renamed", "parent_id": "f-root-b"},
            expected_version=1,
        ),
    )
    compiler = MutationCompiler(
        CATALOG, [FolderDomainPolicy(), KnowledgeDomainPolicy()]
    )
    items = tuple(
        mutation_types.PreparedBatchItem(
            index, f"folder-stable-{index}", request.request_hash, request, None
        )
        for index, request in enumerate(requests)
    )

    async with uow_fixture.sessions() as session:
        compiled = await compiler.compile_batch(uow_fixture.scope, items, session)

    note_command = compiled.commands[3]
    assert str(note_command.projections[0].target) == (
        "notes/f-child/n-descendant-stable.md"
    )
    folder_update = compiled.commands[4]
    assert [(projection.tag.value, str(projection.target)) for projection in folder_update.projections] == [
        ("index_replace", "index/folders/id/f-child")
    ]


@pytest.mark.asyncio
async def test_knowledge_store_projects_folder_and_note_through_one_uow(
    uow_fixture,
    tmp_path,
) -> None:
    from app.commands import EntityCommand, FolderDomainPolicy, RelationDomainPolicy
    from app.file_system.api import get_file_system
    from app.file_system.frontmatter import extract_frontmatter
    from app.knowledge.commands import KnowledgeCommands
    from app.knowledge.projections import KnowledgeDomainPolicy
    from app.knowledge.store import KnowledgeStore
    from tests.test_mutation_recovery import _Lease as RecoveryLease

    file_system = await get_file_system(
        root_dir=tmp_path / "knowledge-files",
        index_db=tmp_path / "knowledge-index.db",
    )
    stage_store = StageStore(_stage_authority(tmp_path / "knowledge-stages"))
    scope = _Scope(uow_fixture.sessions, uow_fixture.receipt)
    scope.file_system = file_system
    scope.mutation_stages = stage_store
    scope.global_lease = RecoveryLease(LeaseMode.SHARED, "global")
    scope.space_lease = RecoveryLease(LeaseMode.EXCLUSIVE, "space-test")

    @asynccontextmanager
    async def exclusive_space_resources(purpose: str, timeout_seconds: int):
        assert purpose == "mutation"
        assert timeout_seconds == 5
        yield scope.space_lease

    scope.exclusive_space_resources = exclusive_space_resources
    executor = FileSystemProjectionExecutor()
    compiler = MutationCompiler(
        CATALOG,
        [FolderDomainPolicy(), RelationDomainPolicy(), KnowledgeDomainPolicy()],
    )
    interpreter = DbMutationInterpreter(CATALOG)
    uow = MutationUnitOfWork(
        catalog=CATALOG,
        compiler=compiler,
        interpreter=interpreter,
        projection_executor=executor,
        recovery_gate=MutationRecovery(
            catalog=CATALOG,
            interpreter=interpreter,
            projection_executor=executor,
        ),
        journal_factory=MutationJournal,
    )
    store = KnowledgeStore(
        commands=KnowledgeCommands(),
        entity_commands=EntityCommand(CATALOG),
        uow=uow,
    )
    try:
        folder = await store.create_folder(
            scope,
            {"id": "f-store", "name": "Research"},
            expected_version=None,
            operation_id="folder-store",
        )
        note = await store.create_note(
            scope,
            {
                "id": "n-store",
                "title": "Paper",
                "folder_id": "f-store",
                "tags": ["atomic"],
                "content": "Stored body term",
            },
            expected_version=None,
            operation_id="note-store",
        )

        assert folder.value["id"] == "f-store"
        assert note.value["folder_id"] == "f-store"
        assert await file_system.read_note("n-store") == "Stored body term"
        snapshot = await file_system.snapshot_projection_authority()
        assert "index/folders/id/f-store" in snapshot.index
        assert "index/notes/note_id/n-store" in snapshot.index
        assert "fts/n-store" in snapshot.fts

        updated = await store.update_note_metadata(
            scope,
            "n-store",
            {"title": "Revised", "tags": ["atomic", "updated"]},
            expected_version=1,
            operation_id="note-store-meta",
        )

        assert updated.value["version"] == 2
        assert await file_system.read_note("n-store") == "Stored body term"
        updated_snapshot = await file_system.snapshot_projection_authority()
        assert "notes/f-store/n-store-paper.md" not in updated_snapshot.markdown
        raw = updated_snapshot.markdown["notes/f-store/n-store-revised.md"].decode()
        metadata, body = extract_frontmatter(raw)
        assert metadata is not None
        assert metadata["title"] == "Revised"
        assert metadata["tags"] == ["atomic", "updated"]
        assert body == "Stored body term"
        search = await file_system.search("Stored body term")
        assert [(item.note_id, item.title) for item in search] == [
            ("n-store", "Revised")
        ]

        from app.knowledge.consistency import KnowledgeConsistencyChecker, SpaceDataView

        database_path = uow_fixture.sessions.kw["bind"].url.database
        assert database_path is not None
        report = await KnowledgeConsistencyChecker().verify(
            SpaceDataView(
                space_id="space-test",
                db_path=Path(database_path),
                notes_dir=tmp_path / "knowledge-files",
                index_db=tmp_path / "knowledge-index.db",
                catalog_hash=CATALOG.hash,
            )
        )
        assert report.valid, report.issues

        with sqlite3.connect(database_path) as connection:
            connection.execute(
                "UPDATE mutation_batches SET state = 'FAILED_MANUAL' "
                "WHERE batch_id = 'folder-store'"
            )
            connection.commit()
        dirty_journal = await KnowledgeConsistencyChecker().verify(
            SpaceDataView(
                space_id="space-test",
                db_path=Path(database_path),
                notes_dir=tmp_path / "knowledge-files",
                index_db=tmp_path / "knowledge-index.db",
                catalog_hash=CATALOG.hash,
            )
        )
        assert [
            (issue.code, issue.entity_id, issue.actual)
            for issue in dirty_journal.issues
        ] == [("journal_not_clean", "folder-store", '"FAILED_MANUAL"')]
        with sqlite3.connect(database_path) as connection:
            connection.execute(
                "UPDATE mutation_batches SET state = 'FINALIZED' "
                "WHERE batch_id = 'folder-store'"
            )
            connection.commit()

        orphan = tmp_path / "knowledge-files" / "notes" / "orphan.md"
        orphan.write_text("unowned projection", encoding="utf-8")
        damaged = await KnowledgeConsistencyChecker().verify(
            SpaceDataView(
                space_id="space-test",
                db_path=Path(database_path),
                notes_dir=tmp_path / "knowledge-files",
                index_db=tmp_path / "knowledge-index.db",
                catalog_hash=CATALOG.hash,
            )
        )
        assert not damaged.valid
        assert [(issue.code, issue.actual) for issue in damaged.issues] == [
            ("markdown_extra", "notes/orphan.md")
        ]
        assert orphan.read_text(encoding="utf-8") == "unowned projection"
        orphan.unlink()

        index_path = tmp_path / "knowledge-index.db"
        with sqlite3.connect(index_path) as connection:
            connection.execute(
                "UPDATE notes_fts SET content = 'stale projection' WHERE rowid = "
                "(SELECT rowid FROM notes WHERE note_id = 'n-store')"
            )
            connection.commit()
        rebuilt = await KnowledgeConsistencyChecker(uow=uow).rebuild(scope)
        assert rebuilt.applied
        assert rebuilt.rebuilt_folders == 1
        assert rebuilt.rebuilt_notes == 1
        assert rebuilt.failed_note_ids == ()
        converged = await KnowledgeConsistencyChecker().verify(
            SpaceDataView(
                space_id="space-test",
                db_path=Path(database_path),
                notes_dir=tmp_path / "knowledge-files",
                index_db=index_path,
                catalog_hash=CATALOG.hash,
            )
        )
        assert converged.valid, converged.issues

        note_path = tmp_path / "knowledge-files" / "notes" / "f-store" / "n-store-revised.md"
        canonical_markdown = note_path.read_text(encoding="utf-8")
        note_path.write_text(
            canonical_markdown.replace(
                "\n---\n\nStored body term",
                "\nextra: derived\n---\n\nStored body term",
                1,
            ),
            encoding="utf-8",
            newline="\n",
        )
        noncanonical = await KnowledgeConsistencyChecker().verify(
            SpaceDataView(
                space_id="space-test",
                db_path=Path(database_path),
                notes_dir=tmp_path / "knowledge-files",
                index_db=index_path,
                catalog_hash=CATALOG.hash,
            )
        )
        assert [issue.code for issue in noncanonical.issues] == [
            "frontmatter_keys_mismatch"
        ]
        canonicalized = await KnowledgeConsistencyChecker(uow=uow).rebuild(scope)
        assert canonicalized.applied
        assert note_path.read_text(encoding="utf-8") == canonical_markdown

        corrupted = note_path.read_text(encoding="utf-8").replace(
            "Stored body term", "corrupted body"
        )
        note_path.write_text(corrupted, encoding="utf-8", newline="\n")
        rejected = await KnowledgeConsistencyChecker(uow=uow).rebuild(scope)
        assert not rejected.applied
        assert rejected.failed_note_ids == ("n-store",)
        assert "corrupted body" in note_path.read_text(encoding="utf-8")
    finally:
        stage_store.close()
        await file_system.close()


@pytest.mark.asyncio
async def test_note_purge_removes_orm_markdown_index_fts_and_emits_delete_event(
    uow_fixture, tmp_path,
) -> None:
    from sqlalchemy import select

    from app.commands import EntityCommand, FolderDomainPolicy, RelationDomainPolicy
    from app.file_system.api import get_file_system
    from app.knowledge.commands import KnowledgeCommands
    from app.knowledge.projections import KnowledgeDomainPolicy
    from app.knowledge.store import KnowledgeStore
    from app.models.note import Note
    from app.models.sync_outbox import SyncOutbox
    from app.mutation.types import MutationState
    from tests.test_mutation_recovery import _Lease as RecoveryLease

    file_system = await get_file_system(
        root_dir=tmp_path / "purge-files",
        index_db=tmp_path / "purge-index.db",
    )
    stage_store = StageStore(_stage_authority(tmp_path / "purge-stages"))
    scope = _Scope(uow_fixture.sessions, uow_fixture.receipt)
    scope.file_system = file_system
    scope.mutation_stages = stage_store
    scope.global_lease = RecoveryLease(LeaseMode.SHARED, "global")
    scope.space_lease = RecoveryLease(LeaseMode.EXCLUSIVE, "space-test")

    @asynccontextmanager
    async def exclusive_space_resources(purpose, timeout_seconds):
        yield scope.space_lease

    scope.exclusive_space_resources = exclusive_space_resources

    executor = FileSystemProjectionExecutor()
    compiler = MutationCompiler(
        CATALOG,
        [FolderDomainPolicy(), RelationDomainPolicy(), KnowledgeDomainPolicy()],
    )
    interpreter = DbMutationInterpreter(CATALOG)
    uow = MutationUnitOfWork(
        catalog=CATALOG,
        compiler=compiler,
        interpreter=interpreter,
        projection_executor=executor,
        recovery_gate=MutationRecovery(
            catalog=CATALOG,
            interpreter=interpreter,
            projection_executor=executor,
        ),
        journal_factory=MutationJournal,
    )
    store = KnowledgeStore(
        commands=KnowledgeCommands(),
        entity_commands=EntityCommand(CATALOG),
        uow=uow,
    )

    try:
        await store.create_note(
            scope,
            {"id": "n-purge", "title": "Purge", "content": "body to purge"},
            expected_version=None,
            operation_id="create-n-purge",
        )
        await store.update_note(
            scope,
            "n-purge",
            {"trashed_at": "2026-01-01T00:00:00+00:00"},
            expected_version=1,
            operation_id="trash-n-purge",
        )

        result = await store.purge_note(
            scope,
            "n-purge",
            expected_version=2,
            operation_id="purge-n-purge",
        )

        assert result.state is MutationState.FINALIZED

        async with uow_fixture.sessions() as session:
            note = await session.get(Note, "n-purge")
            assert note is None, "ORM Note row should be deleted"

            delete_events = (
                await session.execute(
                    select(SyncOutbox).where(
                        SyncOutbox.entity_type == "note",
                        SyncOutbox.entity_id == "n-purge",
                        SyncOutbox.action == "delete",
                        SyncOutbox.visible.is_(True),
                    )
                )
            ).scalars().all()
            assert len(delete_events) == 1, "exactly one visible delete event"

        snapshot = await file_system.snapshot_projection_authority()
        assert all(
            "n-purge" not in key for key in snapshot.markdown
        ), "markdown removed"
        assert all(
            "n-purge" not in key for key in snapshot.index
        ), "index removed"
        assert all(
            "n-purge" not in key for key in snapshot.fts
        ), "fts removed"
    finally:
        stage_store.close()
        await file_system.close()


@pytest.mark.asyncio
async def test_folder_purge_deletes_all_descendants_deepest_first(
    uow_fixture, tmp_path,
) -> None:
    """Folder purge hard-deletes the folder and all descendants (including
    trashed ones) in a single atomic batch.  Descendants are processed
    deepest-first so no partial state is observable."""
    from sqlalchemy import select

    from app.commands import EntityCommand, FolderDomainPolicy, RelationDomainPolicy
    from app.file_system.api import get_file_system
    from app.knowledge.commands import KnowledgeCommands
    from app.knowledge.projections import KnowledgeDomainPolicy
    from app.knowledge.store import KnowledgeStore
    from app.models.folder import Folder
    from app.models.sync_outbox import SyncOutbox
    from app.mutation.types import MutationState
    from tests.test_mutation_recovery import _Lease as RecoveryLease

    file_system = await get_file_system(
        root_dir=tmp_path / "folder-purge-files",
        index_db=tmp_path / "folder-purge-index.db",
    )
    stage_store = StageStore(_stage_authority(tmp_path / "folder-purge-stages"))
    scope = _Scope(uow_fixture.sessions, uow_fixture.receipt)
    scope.file_system = file_system
    scope.mutation_stages = stage_store
    scope.global_lease = RecoveryLease(LeaseMode.SHARED, "global")
    scope.space_lease = RecoveryLease(LeaseMode.EXCLUSIVE, "space-test")

    @asynccontextmanager
    async def exclusive_space_resources(purpose, timeout_seconds):
        yield scope.space_lease

    scope.exclusive_space_resources = exclusive_space_resources

    executor = FileSystemProjectionExecutor()
    compiler = MutationCompiler(
        CATALOG,
        [FolderDomainPolicy(), RelationDomainPolicy(), KnowledgeDomainPolicy()],
    )
    interpreter = DbMutationInterpreter(CATALOG)
    uow = MutationUnitOfWork(
        catalog=CATALOG,
        compiler=compiler,
        interpreter=interpreter,
        projection_executor=executor,
        recovery_gate=MutationRecovery(
            catalog=CATALOG,
            interpreter=interpreter,
            projection_executor=executor,
        ),
        journal_factory=MutationJournal,
    )
    store = KnowledgeStore(
        commands=KnowledgeCommands(),
        entity_commands=EntityCommand(CATALOG),
        uow=uow,
    )

    try:
        # Create tree: root -> child1 -> grandchild1, root -> child2
        await store.create_folder(
            scope,
            {"id": "root", "name": "Root", "parent_id": None},
            expected_version=None,
            operation_id="create-root",
        )
        await store.create_folder(
            scope,
            {"id": "child1", "name": "Child1", "parent_id": "root"},
            expected_version=None,
            operation_id="create-child1",
        )
        await store.create_folder(
            scope,
            {"id": "grandchild1", "name": "GC1", "parent_id": "child1"},
            expected_version=None,
            operation_id="create-gc1",
        )
        await store.create_folder(
            scope,
            {"id": "child2", "name": "Child2", "parent_id": "root"},
            expected_version=None,
            operation_id="create-child2",
        )

        # Trash the root (cascade soft-deletes all descendants)
        await store.update_folder(
            scope,
            "root",
            {"trashed_at": "2026-01-01T00:00:00+00:00"},
            expected_version=1,
            operation_id="trash-root",
        )

        # Purge the root folder — should hard-delete all 4 folders
        result = await store.purge_folder(
            scope,
            "root",
            expected_version=2,
            operation_id="purge-root",
        )

        assert all(r.state is MutationState.FINALIZED for r in result.applied)

        # All 4 folders should be gone from ORM
        async with uow_fixture.sessions() as session:
            for fid in ("root", "child1", "grandchild1", "child2"):
                folder = await session.get(Folder, fid)
                assert folder is None, f"folder {fid} should be deleted"

            # 4 visible delete events
            delete_events = (
                await session.execute(
                    select(SyncOutbox).where(
                        SyncOutbox.entity_type == "folder",
                        SyncOutbox.entity_id.in_(
                            ("root", "child1", "grandchild1", "child2")
                        ),
                        SyncOutbox.action == "delete",
                        SyncOutbox.visible.is_(True),
                    )
                )
            ).scalars().all()
            assert len(delete_events) == 4, (
                f"expected 4 visible delete events, got {len(delete_events)}"
            )

        # All folder index entries removed
        snapshot = await file_system.snapshot_projection_authority()
        for fid in ("root", "child1", "grandchild1", "child2"):
            assert all(
                fid not in key for key in snapshot.index
            ), f"folder index for {fid} should be removed"
    finally:
        stage_store.close()
        await file_system.close()


@pytest.mark.asyncio
async def test_restore_note_clears_trashed_at_through_uow(
    uow_fixture, tmp_path,
) -> None:
    """Note restore must go through UoW, produce an update event, and
    rebuild projections so the note is visible again."""
    from sqlalchemy import select

    from app.commands import EntityCommand, FolderDomainPolicy, RelationDomainPolicy
    from app.file_system.api import get_file_system
    from app.knowledge.commands import KnowledgeCommands
    from app.knowledge.projections import KnowledgeDomainPolicy
    from app.knowledge.store import KnowledgeStore
    from app.models.note import Note
    from app.models.sync_outbox import SyncOutbox
    from app.mutation.types import MutationState
    from tests.test_mutation_recovery import _Lease as RecoveryLease

    file_system = await get_file_system(
        root_dir=tmp_path / "restore-note-files",
        index_db=tmp_path / "restore-note-index.db",
    )
    stage_store = StageStore(_stage_authority(tmp_path / "restore-note-stages"))
    scope = _Scope(uow_fixture.sessions, uow_fixture.receipt)
    scope.file_system = file_system
    scope.mutation_stages = stage_store
    scope.global_lease = RecoveryLease(LeaseMode.SHARED, "global")
    scope.space_lease = RecoveryLease(LeaseMode.EXCLUSIVE, "space-test")

    @asynccontextmanager
    async def exclusive_space_resources(purpose, timeout_seconds):
        yield scope.space_lease

    scope.exclusive_space_resources = exclusive_space_resources

    executor = FileSystemProjectionExecutor()
    compiler = MutationCompiler(
        CATALOG,
        [FolderDomainPolicy(), RelationDomainPolicy(), KnowledgeDomainPolicy()],
    )
    interpreter = DbMutationInterpreter(CATALOG)
    uow = MutationUnitOfWork(
        catalog=CATALOG,
        compiler=compiler,
        interpreter=interpreter,
        projection_executor=executor,
        recovery_gate=MutationRecovery(
            catalog=CATALOG,
            interpreter=interpreter,
            projection_executor=executor,
        ),
        journal_factory=MutationJournal,
    )
    store = KnowledgeStore(
        commands=KnowledgeCommands(),
        entity_commands=EntityCommand(CATALOG),
        uow=uow,
    )

    try:
        await store.create_note(
            scope,
            {"id": "n-restore", "title": "Restore", "content": "body"},
            expected_version=None,
            operation_id="create-n-restore",
        )
        await store.update_note(
            scope,
            "n-restore",
            {"trashed_at": "2026-01-01T00:00:00+00:00"},
            expected_version=1,
            operation_id="trash-n-restore",
        )

        result = await store.restore_note(
            scope,
            "n-restore",
            expected_version=2,
            operation_id="restore-n-restore",
        )

        assert result.state is MutationState.FINALIZED

        async with uow_fixture.sessions() as session:
            note = await session.get(Note, "n-restore")
            assert note is not None
            assert note.trashed_at is None, "trashed_at should be cleared"

            update_events = (
                await session.execute(
                    select(SyncOutbox).where(
                        SyncOutbox.entity_type == "note",
                        SyncOutbox.entity_id == "n-restore",
                        SyncOutbox.action == "update",
                        SyncOutbox.visible.is_(True),
                    )
                )
            ).scalars().all()
            # At least one update event from restore (there may be more from trash)
            assert len(update_events) >= 1, "restore should emit a visible update event"
    finally:
        stage_store.close()
        await file_system.close()


@pytest.mark.asyncio
async def test_restore_folder_clears_trashed_at_through_uow(
    uow_fixture, tmp_path,
) -> None:
    """Folder restore must go through UoW and produce an update event."""
    from sqlalchemy import select

    from app.commands import EntityCommand, FolderDomainPolicy, RelationDomainPolicy
    from app.file_system.api import get_file_system
    from app.knowledge.commands import KnowledgeCommands
    from app.knowledge.projections import KnowledgeDomainPolicy
    from app.knowledge.store import KnowledgeStore
    from app.models.folder import Folder
    from app.models.sync_outbox import SyncOutbox
    from app.mutation.types import MutationState
    from tests.test_mutation_recovery import _Lease as RecoveryLease

    file_system = await get_file_system(
        root_dir=tmp_path / "restore-folder-files",
        index_db=tmp_path / "restore-folder-index.db",
    )
    stage_store = StageStore(_stage_authority(tmp_path / "restore-folder-stages"))
    scope = _Scope(uow_fixture.sessions, uow_fixture.receipt)
    scope.file_system = file_system
    scope.mutation_stages = stage_store
    scope.global_lease = RecoveryLease(LeaseMode.SHARED, "global")
    scope.space_lease = RecoveryLease(LeaseMode.EXCLUSIVE, "space-test")

    @asynccontextmanager
    async def exclusive_space_resources(purpose, timeout_seconds):
        yield scope.space_lease

    scope.exclusive_space_resources = exclusive_space_resources

    executor = FileSystemProjectionExecutor()
    compiler = MutationCompiler(
        CATALOG,
        [FolderDomainPolicy(), RelationDomainPolicy(), KnowledgeDomainPolicy()],
    )
    interpreter = DbMutationInterpreter(CATALOG)
    uow = MutationUnitOfWork(
        catalog=CATALOG,
        compiler=compiler,
        interpreter=interpreter,
        projection_executor=executor,
        recovery_gate=MutationRecovery(
            catalog=CATALOG,
            interpreter=interpreter,
            projection_executor=executor,
        ),
        journal_factory=MutationJournal,
    )
    store = KnowledgeStore(
        commands=KnowledgeCommands(),
        entity_commands=EntityCommand(CATALOG),
        uow=uow,
    )

    try:
        await store.create_folder(
            scope,
            {"id": "f-restore", "name": "Folder", "parent_id": None},
            expected_version=None,
            operation_id="create-f-restore",
        )
        await store.update_folder(
            scope,
            "f-restore",
            {"trashed_at": "2026-01-01T00:00:00+00:00"},
            expected_version=1,
            operation_id="trash-f-restore",
        )

        result = await store.restore_folder(
            scope,
            "f-restore",
            expected_version=2,
            operation_id="restore-f-restore",
        )

        assert result.state is MutationState.FINALIZED

        async with uow_fixture.sessions() as session:
            folder = await session.get(Folder, "f-restore")
            assert folder is not None
            assert folder.trashed_at is None, "trashed_at should be cleared"

            update_events = (
                await session.execute(
                    select(SyncOutbox).where(
                        SyncOutbox.entity_type == "folder",
                        SyncOutbox.entity_id == "f-restore",
                        SyncOutbox.action == "update",
                        SyncOutbox.visible.is_(True),
                    )
                )
            ).scalars().all()
            assert len(update_events) >= 1, "restore should emit a visible update event"
    finally:
        stage_store.close()
        await file_system.close()


@pytest.mark.asyncio
async def test_restore_quick_note_clears_trashed_at_through_uow(
    uow_fixture, tmp_path,
) -> None:
    """QuickNote restore must go through UoW and produce an update event."""
    from sqlalchemy import select

    from app.commands import EntityCommand, FolderDomainPolicy, RelationDomainPolicy
    from app.file_system.api import get_file_system
    from app.knowledge.commands import KnowledgeCommands
    from app.knowledge.projections import KnowledgeDomainPolicy
    from app.knowledge.store import KnowledgeStore
    from app.models.quick_note import QuickNote
    from app.models.sync_outbox import SyncOutbox
    from app.mutation.types import MutationState
    from tests.test_mutation_recovery import _Lease as RecoveryLease

    file_system = await get_file_system(
        root_dir=tmp_path / "restore-qn-files",
        index_db=tmp_path / "restore-qn-index.db",
    )
    stage_store = StageStore(_stage_authority(tmp_path / "restore-qn-stages"))
    scope = _Scope(uow_fixture.sessions, uow_fixture.receipt)
    scope.file_system = file_system
    scope.mutation_stages = stage_store
    scope.global_lease = RecoveryLease(LeaseMode.SHARED, "global")
    scope.space_lease = RecoveryLease(LeaseMode.EXCLUSIVE, "space-test")

    @asynccontextmanager
    async def exclusive_space_resources(purpose, timeout_seconds):
        yield scope.space_lease

    scope.exclusive_space_resources = exclusive_space_resources

    executor = FileSystemProjectionExecutor()
    compiler = MutationCompiler(
        CATALOG,
        [FolderDomainPolicy(), RelationDomainPolicy(), KnowledgeDomainPolicy()],
    )
    interpreter = DbMutationInterpreter(CATALOG)
    uow = MutationUnitOfWork(
        catalog=CATALOG,
        compiler=compiler,
        interpreter=interpreter,
        projection_executor=executor,
        recovery_gate=MutationRecovery(
            catalog=CATALOG,
            interpreter=interpreter,
            projection_executor=executor,
        ),
        journal_factory=MutationJournal,
    )
    store = KnowledgeStore(
        commands=KnowledgeCommands(),
        entity_commands=EntityCommand(CATALOG),
        uow=uow,
    )

    try:
        # Create a QuickNote through entity_commands
        create_req = store.entity_commands.create(
            scope, "quick_note",
            {"id": "qn-restore", "content": "quick note content"},
            expected_version=None,
        )
        await store.uow.execute(scope, create_req, "create-qn-restore")

        # Trash the QuickNote
        trash_req = store.entity_commands.update(
            scope, "quick_note", "qn-restore",
            {"trashed_at": "2026-01-01T00:00:00+00:00"},
            expected_version=1,
        )
        await store.uow.execute(scope, trash_req, "trash-qn-restore")

        # Restore
        result = await store.restore_quick_note(
            scope,
            "qn-restore",
            expected_version=2,
            operation_id="restore-qn-restore",
        )

        assert result.state is MutationState.FINALIZED

        async with uow_fixture.sessions() as session:
            qn = await session.get(QuickNote, "qn-restore")
            assert qn is not None
            assert qn.trashed_at is None, "trashed_at should be cleared"

            update_events = (
                await session.execute(
                    select(SyncOutbox).where(
                        SyncOutbox.entity_type == "quickNote",
                        SyncOutbox.entity_id == "qn-restore",
                        SyncOutbox.action == "update",
                        SyncOutbox.visible.is_(True),
                    )
                )
            ).scalars().all()
            assert len(update_events) >= 1, "restore should emit a visible update event"
    finally:
        stage_store.close()
        await file_system.close()


@pytest.mark.asyncio
async def test_quick_note_conversion_is_atomic_batch_with_deterministic_ids(
    uow_fixture, tmp_path,
) -> None:
    """QuickNote conversion must be an atomic batch:
    - Note create
    - QuickNote CAS update (archive + link)
    - MemoComment copies with deterministic IDs
    - Retry with same operation_id returns same result (idempotent)
    """
    import hashlib

    from sqlalchemy import select

    from app.commands import EntityCommand, FolderDomainPolicy, RelationDomainPolicy
    from app.file_system.api import get_file_system
    from app.knowledge.commands import KnowledgeCommands
    from app.knowledge.projections import KnowledgeDomainPolicy
    from app.knowledge.store import KnowledgeStore
    from app.models.memo_comment import MemoComment
    from app.models.note import Note
    from app.models.quick_note import QuickNote
    from app.mutation.types import MutationState
    from tests.test_mutation_recovery import _Lease as RecoveryLease

    file_system = await get_file_system(
        root_dir=tmp_path / "convert-qn-files",
        index_db=tmp_path / "convert-qn-index.db",
    )
    stage_store = StageStore(_stage_authority(tmp_path / "convert-qn-stages"))
    scope = _Scope(uow_fixture.sessions, uow_fixture.receipt)
    scope.file_system = file_system
    scope.mutation_stages = stage_store
    scope.global_lease = RecoveryLease(LeaseMode.SHARED, "global")
    scope.space_lease = RecoveryLease(LeaseMode.EXCLUSIVE, "space-test")

    @asynccontextmanager
    async def exclusive_space_resources(purpose, timeout_seconds):
        yield scope.space_lease

    scope.exclusive_space_resources = exclusive_space_resources

    executor = FileSystemProjectionExecutor()
    compiler = MutationCompiler(
        CATALOG,
        [FolderDomainPolicy(), RelationDomainPolicy(), KnowledgeDomainPolicy()],
    )
    interpreter = DbMutationInterpreter(CATALOG)
    uow = MutationUnitOfWork(
        catalog=CATALOG,
        compiler=compiler,
        interpreter=interpreter,
        projection_executor=executor,
        recovery_gate=MutationRecovery(
            catalog=CATALOG,
            interpreter=interpreter,
            projection_executor=executor,
        ),
        journal_factory=MutationJournal,
    )
    store = KnowledgeStore(
        commands=KnowledgeCommands(),
        entity_commands=EntityCommand(CATALOG),
        uow=uow,
    )

    try:
        # Create a QuickNote with content and tags
        create_qn_req = store.entity_commands.create(
            scope, "quick_note",
            {
                "id": "qn-convert",
                "content": "Convert me to a note",
                "tags": '["test"]',
            },
            expected_version=None,
        )
        await store.uow.execute(scope, create_qn_req, "create-qn-convert")

        # Create 2 MemoComments on the quick note
        for cid, ctext in (("src-c1", "First comment"), ("src-c2", "Second comment")):
            create_comment_req = store.entity_commands.create(
                scope, "memo_comment",
                {"id": cid, "note_id": "qn-convert", "content": ctext},
                expected_version=None,
            )
            await store.uow.execute(
                scope, create_comment_req, f"create-comment-{cid}",
            )

        # Convert the QuickNote to a Note
        first = await store.convert_quick_note(
            scope,
            "qn-convert",
            expected_version=1,
            operation_id="convert-qn-convert",
        )

        # Determine deterministic note ID
        expected_note_id = hashlib.sha256(
            "convert-qn-convert\0note".encode("ascii")
        ).hexdigest()[:32]

        # Verify Note was created
        async with uow_fixture.sessions() as session:
            note = await session.get(Note, expected_note_id)
            assert note is not None, "converted Note should exist"
            assert note.title, "note should have a title derived from content"

            # Verify QuickNote was archived
            qn = await session.get(QuickNote, "qn-convert")
            assert qn is not None
            assert qn.archived_at is not None, "quick note should be archived"
            assert qn.migrated_to_note_id == expected_note_id

            # Verify MemoComments were copied with deterministic IDs
            expected_c1 = hashlib.sha256(
                "convert-qn-convert\0memo_comment\0src-c1".encode("ascii")
            ).hexdigest()[:32]
            expected_c2 = hashlib.sha256(
                "convert-qn-convert\0memo_comment\0src-c2".encode("ascii")
            ).hexdigest()[:32]

            copied_comments = (
                await session.execute(
                    select(MemoComment).where(
                        MemoComment.note_id == expected_note_id
                    )
                )
            ).scalars().all()
            assert len(copied_comments) == 2, (
                f"expected 2 copied comments, got {len(copied_comments)}"
            )
            copied_ids = {c.id for c in copied_comments}
            assert expected_c1 in copied_ids, "first comment should have deterministic ID"
            assert expected_c2 in copied_ids, "second comment should have deterministic ID"

        # Retry with same operation_id — should be idempotent
        second = await store.convert_quick_note(
            scope,
            "qn-convert",
            expected_version=1,
            operation_id="convert-qn-convert",
        )

        # Same batch_id → same result (idempotent)
        assert second.batch_id == first.batch_id

        # Verify no duplicate Notes or comments
        async with uow_fixture.sessions() as session:
            notes_with_id = (
                await session.execute(
                    select(Note).where(Note.id == expected_note_id)
                )
            ).scalars().all()
            assert len(notes_with_id) == 1, "no duplicate Note from retry"

            all_copied = (
                await session.execute(
                    select(MemoComment).where(
                        MemoComment.note_id == expected_note_id
                    )
                )
            ).scalars().all()
            assert len(all_copied) == 2, "no duplicate comments from retry"
    finally:
        stage_store.close()
        await file_system.close()


def _projection_api():
    names = (
        "ContainedProjectionActionField",
        "MaterializedProjectionAction",
        "ProjectionActionTag",
        "ProjectionPlan",
    )
    missing = tuple(name for name in names if not hasattr(mutation_types, name))
    assert missing == (), f"missing closed projection API: {missing}"
    return tuple(getattr(mutation_types, name) for name in names)


def _projection_plan(
    tag: str,
    target: str,
    ordinal: int,
    before: bytes | None,
    after: bytes | None,
    *,
    source: str | None = None,
):
    field_type, _, tag_type, plan_type = _projection_api()
    return plan_type(
        tag_type(tag),
        None if source is None else field_type(source),
        field_type(target),
        ordinal,
        before,
        after,
    )


def _materialized_action(
    tag: str,
    target: str,
    ordinal: int,
    blob: bytes | None,
    *,
    source: str | None = None,
):
    field_type, action_type, tag_type, _ = _projection_api()
    return action_type(
        tag_type(tag),
        None if source is None else field_type(source),
        field_type(target),
        ordinal,
        blob,
    )


def _stage_authority(path) -> BoundStageDirectory:
    path.mkdir()
    parent = BoundDirectoryHandle._create(path.parent)
    try:
        return BoundStageDirectory._from_parent_handle(parent, path.name)
    finally:
        parent._close()


@dataclass
class _FenceReceipt:
    current: bool = True

    def assert_current(self) -> None:
        if not self.current:
            raise RuntimeError("stale fence")


class _Lease:
    def __init__(self, receipt: _FenceReceipt) -> None:
        self._receipt = receipt
        # staging._require_space_exclusive reads lease.mode to verify
        # the lease is shared or exclusive.
        from app.runtime.leases import LeaseMode
        self.mode = LeaseMode.SHARED

    def assert_active_owner(self, *, mode=None, scope=None) -> None:
        assert scope == "space-test"

    def fence_receipt(self, _space_id: str) -> _FenceReceipt:
        return self._receipt


class _StageStore:
    def __init__(self) -> None:
        self.published: dict[str, tuple[object, ...]] = {}
        self.materialize_calls: list[tuple[str, str]] = []

    async def publish(self, operation_id, plans, *, lease, space_id):
        from app.mutation.staging import StageManifest

        assert lease.fence_receipt(space_id).current
        self.published[operation_id] = tuple(plans)
        return StageManifest(operation_id, operation_id, (), "0" * 64)

    async def materialize(self, operation_id, descriptors, *, image, receipt):
        self.materialize_calls.append((operation_id, image))
        receipt.assert_current()
        return tuple(descriptors)

    async def materialize_side(
        self, operation_id, descriptors, *, image, ordinals, receipt
    ):
        self.materialize_calls.append((operation_id, image))
        receipt.assert_current()
        return tuple(descriptors[ordinal] for ordinal in ordinals)


class _Scope:
    def __init__(self, sessions, receipt: _FenceReceipt) -> None:
        self.session_factory = sessions
        self.scope = SimpleNamespace(space_id="space-test")
        self.mutation_stages = _StageStore()
        self.file_system = self
        self.projection_snapshot = ProjectionAuthoritySnapshot({}, {}, {})
        self._receipt = receipt

    async def snapshot_projection_authority(self) -> ProjectionAuthoritySnapshot:
        return self.projection_snapshot

    @asynccontextmanager
    async def exclusive_space_resources(self, purpose: str, timeout_seconds: float):
        assert (purpose, timeout_seconds) == ("mutation", 5)
        yield _Lease(self._receipt)


class _Catalog:
    def get(self, entity_type: str):
        return SimpleNamespace(sync_enabled=True, effective_sync_entity_type=f"wire-{entity_type}")


class _Compiler:
    def __init__(self) -> None:
        self.calls = 0
        self.projections: tuple[object, ...] = ()

    async def compile_batch(self, scope, items, session) -> BatchCompilation:
        self.calls += 1
        commands = []
        operation_ids = []
        for item in items:
            if item.request is None:
                continue
            request = item.request
            commands.append(
                MutationCommand.from_effects(
                    request=request,
                    db_plans=(),
                    projections=tuple(self.projections),
                    sync_events=(
                        SyncEventPlan(
                            entity_type=request.entity_type,
                            entity_id=request.entity_id,
                            action="create",
                            payload={"id": request.entity_id},
                            version=1,
                            created_at="2026-07-20T00:00:00Z",
                        ),
                    ),
                    result_value={"id": request.entity_id},
                )
            )
            operation_ids.append(item.operation_id)
        return BatchCompilation(tuple(operation_ids), tuple(commands), ())


class _Interpreter:
    async def apply(self, session, plans):
        assert plans == ()
        return ()


class _ProjectionExecutor:
    def __init__(self) -> None:
        self.calls = 0

    async def apply_forward(
        self, scope, operation_id, command, receipt, *, ordinals=None
    ) -> None:
        receipt.assert_current()
        self.calls += 1

    async def restore_before(
        self, scope, operation_id, command, receipt, *, ordinals=None
    ) -> None:
        receipt.assert_current()


class _CleanGate:
    async def require_clean_under_lease(self, scope, lease, journal) -> None:
        if not await journal.is_clean():
            raise SpaceRecoveryRequiredError()


class _DirtyGate:
    async def require_clean_under_lease(self, scope, lease, journal) -> None:
        raise SpaceRecoveryRequiredError()


@pytest.fixture
def uow_fixture(space_session):
    assert space_session.bind is not None
    sessions = async_sessionmaker(space_session.bind, expire_on_commit=False)
    receipt = _FenceReceipt()
    compiler = _Compiler()
    executor = _ProjectionExecutor()
    uow = MutationUnitOfWork(
        catalog=_Catalog(),
        compiler=compiler,
        interpreter=_Interpreter(),
        projection_executor=executor,
        recovery_gate=_CleanGate(),
        journal_factory=MutationJournal,
    )
    return SimpleNamespace(
        sessions=sessions,
        scope=_Scope(sessions, receipt),
        compiler=compiler,
        executor=executor,
        receipt=receipt,
        uow=uow,
    )


@dataclass
class KnowledgeFixture:
    """Self-contained fixture for knowledge lifecycle tests.

    Wraps a real KnowledgeStore with production compiler, interpreter,
    projection executor, and recovery gate — not mocks.
    """
    scope: Any
    store: "KnowledgeStore"
    sessions: Any  # async_sessionmaker
    file_system: Any
    stage_store: Any
    tmp_path: Path

    async def create_and_trash_note(
        self, note_id: str, title: str = "Test", versions: int = 1
    ) -> int:
        """Create a note, update content N times, then trash it.
        Returns the expected_version for purge."""
        await self.store.create_note(
            self.scope,
            {"id": note_id, "title": title, "content": f"v1-{title}", "tags": []},
            expected_version=None,
            operation_id=f"create-{note_id}",
        )
        for i in range(2, versions + 2):
            await self.store.update_note_content(
                self.scope, note_id, f"v{i}-{title}",
                expected_version=i - 1,
                operation_id=f"update-{note_id}-{i}",
            )
        final_version = versions + 1
        await self.store.update_note(
            self.scope, note_id,
            {"trashed_at": "2026-01-01T00:00:00+00:00"},
            expected_version=final_version,
            operation_id=f"trash-{note_id}",
        )
        return final_version + 1

    async def assert_note_absent_everywhere(self, note_id: str) -> None:
        """Assert note is gone from ORM, markdown, index, FTS."""
        async with self.sessions() as session:
            note = await session.get(Note, note_id)
            assert note is None, f"Note {note_id} still in ORM"

        snapshot = await self.file_system.snapshot_projection_authority()
        for key in snapshot.markdown:
            assert note_id not in str(key), f"Note {note_id} still in markdown: {key}"
        for key in snapshot.index:
            assert note_id not in str(key), f"Note {note_id} still in index: {key}"
        for key in snapshot.fts:
            assert note_id not in str(key), f"Note {note_id} still in FTS: {key}"

    async def assert_single_tombstone_and_visible_delete(
        self, entity_type: str, entity_id: str
    ) -> None:
        """Assert exactly 1 tombstone and 1 visible delete event."""
        from app.models.tombstone import Tombstone

        async with self.sessions() as session:
            tombstones = (
                await session.execute(
                    select(Tombstone).where(
                        Tombstone.entity_type == entity_type,
                        Tombstone.entity_id == entity_id,
                    )
                )
            ).scalars().all()
            assert len(tombstones) == 1, (
                f"expected 1 tombstone for {entity_type}/{entity_id}, "
                f"got {len(tombstones)}"
            )

            visible_deletes = (
                await session.execute(
                    select(SyncOutbox).where(
                        SyncOutbox.entity_type == entity_type,
                        SyncOutbox.entity_id == entity_id,
                        SyncOutbox.action == "delete",
                        SyncOutbox.visible.is_(True),
                    )
                )
            ).scalars().all()
            assert len(visible_deletes) == 1, (
                f"expected 1 visible delete for {entity_type}/{entity_id}, "
                f"got {len(visible_deletes)}"
            )

    async def visible_batch_events(self, batch_id: str) -> list:
        """Return all visible sync events for a batch."""
        async with self.sessions() as session:
            return list((
                await session.execute(
                    select(SyncOutbox).where(
                        SyncOutbox.batch_id == batch_id,
                        SyncOutbox.visible.is_(True),
                    )
                )
            ).scalars().all())

    async def all_batch_events(self, batch_id: str) -> list:
        """Return ALL sync events (visible + invisible) for a batch."""
        async with self.sessions() as session:
            return list((
                await session.execute(
                    select(SyncOutbox).where(
                        SyncOutbox.batch_id == batch_id,
                    )
                )
            ).scalars().all())


@pytest.fixture
async def knowledge_fixture(uow_fixture, tmp_path):
    """Real KnowledgeStore with file system, stage store, and UoW."""
    from app.commands import EntityCommand, FolderDomainPolicy, RelationDomainPolicy
    from app.file_system.api import get_file_system
    from app.knowledge.commands import KnowledgeCommands
    from app.knowledge.projections import KnowledgeDomainPolicy
    from app.knowledge.store import KnowledgeStore
    from tests.test_mutation_recovery import _Lease as RecoveryLease

    file_system = await get_file_system(
        root_dir=tmp_path / "kf-files",
        index_db=tmp_path / "kf-index.db",
    )
    stage_store = StageStore(_stage_authority(tmp_path / "kf-stages"))
    scope = _Scope(uow_fixture.sessions, uow_fixture.receipt)
    scope.file_system = file_system
    scope.mutation_stages = stage_store
    scope.global_lease = RecoveryLease(LeaseMode.SHARED, "global")
    scope.space_lease = RecoveryLease(LeaseMode.EXCLUSIVE, "space-test")

    @asynccontextmanager
    async def exclusive_space_resources(purpose, timeout_seconds):
        yield scope.space_lease

    scope.exclusive_space_resources = exclusive_space_resources

    executor = FileSystemProjectionExecutor()
    compiler = MutationCompiler(
        CATALOG,
        [FolderDomainPolicy(), RelationDomainPolicy(), KnowledgeDomainPolicy()],
    )
    interpreter = DbMutationInterpreter(CATALOG)
    uow = MutationUnitOfWork(
        catalog=CATALOG,
        compiler=compiler,
        interpreter=interpreter,
        projection_executor=executor,
        recovery_gate=MutationRecovery(
            catalog=CATALOG,
            interpreter=interpreter,
            projection_executor=executor,
        ),
        journal_factory=MutationJournal,
    )
    store = KnowledgeStore(
        commands=KnowledgeCommands(),
        entity_commands=EntityCommand(CATALOG),
        uow=uow,
    )

    fixture = KnowledgeFixture(
        scope=scope, store=store, sessions=uow_fixture.sessions,
        file_system=file_system, stage_store=stage_store, tmp_path=tmp_path,
    )

    try:
        yield fixture
    finally:
        stage_store.close()
        await file_system.close()


def _request(entity_id: str, body: str = "body") -> MutationRequest:
    return MutationRequest.from_payload(
        name="note.create",
        entity_type="note",
        entity_id=entity_id,
        payload={"body": body, "id": entity_id},
        expected_version=None,
    )


async def _compile_production_batch(uow_fixture, requests, policies=()):
    compiler = MutationCompiler(CATALOG, policies)
    items = tuple(
        mutation_types.PreparedBatchItem(
            index, f"overlay-op-{index}", request.request_hash, request, None
        )
        for index, request in enumerate(requests)
    )
    async with uow_fixture.sessions() as session:
        return await compiler.compile_batch(uow_fixture.scope, items, session)


def _with_projection(base, *, projections):
    return MutationCommand.from_effects(
        request=base.request,
        db_plans=base.db_plans,
        projections=projections,
        sync_events=base.sync_events,
        result_value=base.result_value,
        resolution=base.resolution,
    )


def _canonical_projection_blob(value) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=True,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("ascii")


def _note_index_blob(row, path: str) -> bytes:
    return _canonical_projection_blob(
        {
            "row": {
                "category": row["category"],
                "content_hash": row["content_hash"],
                "created_at": row["created_at"],
                "current_path": path,
                "folder_id": row["folder_id"],
                "is_deleted": False,
                "level": "L1",
                "note_id": row["id"],
                "status": row["status"],
                "summary": row["summary"],
                "tags": row["tags"],
                "title": row["title"],
                "trashed_at": row["trashed_at"],
                "updated_at": row["updated_at"],
                "word_count": row["word_count"],
            }
        }
    )


def _folder_index_blob(row) -> bytes:
    return _canonical_projection_blob(
        {
            "row": {
                key: row[key]
                for key in (
                    "color",
                    "created_at",
                    "icon",
                    "id",
                    "is_system",
                    "name",
                    "parent_id",
                    "sort_order",
                    "trashed_at",
                    "updated_at",
                )
            }
        }
    )


def _fts_blob(row, body: bytes) -> bytes:
    return _canonical_projection_blob(
        {"content": body.decode("utf-8"), "title": row["title"]}
    )


def _note_create_projections(base, body: bytes, *, path: str | None = None):
    row = base.db_plans[0].after_row
    assert row is not None
    target = path or f"notes/{row['id']}.md"
    return (
        _projection_plan("markdown_write", target, 0, None, body),
        _projection_plan(
            "index_replace",
            f"index/notes/note_id/{row['id']}",
            1,
            None,
            _note_index_blob(row, target),
        ),
        _projection_plan(
            "fts_replace",
            f"fts/{row['id']}",
            2,
            None,
            _fts_blob(row, body),
        ),
    )


@pytest.mark.asyncio
async def test_authority_overlay_reads_locked_rows_and_applies_after_images(uow_fixture) -> None:
    async with uow_fixture.sessions.begin() as session:
        session.add(
            Schedule(
                id="overlay-schedule",
                title="before",
                due_at="2026-07-21T00:00:00Z",
                created_at="2026-07-20T00:00:00Z",
                updated_at="2026-07-20T00:00:00Z",
                version=1,
            )
        )

    request = MutationRequest.from_payload(
        name="entity.update",
        entity_type="schedule",
        entity_id="overlay-schedule",
        payload={"title": "after"},
        expected_version=1,
    )
    async with uow_fixture.sessions() as session:
        overlay = await AuthorityOverlay.from_locked_authorities(
            uow_fixture.scope, session, CATALOG
        )
    before = overlay.row("schedule", "overlay-schedule")
    assert before is not None and before["title"] == "before"

    after = dict(before)
    after.update(title="after", version=2)
    command = MutationCommand.from_effects(
        request=request,
        db_plans=(
            DbMutationPlan(
                table="schedules",
                primary_key={"id": "overlay-schedule"},
                operation="update",
                expected_version=1,
                before_row=before,
                after_row=after,
            ),
        ),
        projections=(),
        sync_events=(),
        result_value=after,
    )
    overlay.apply(command)

    assert overlay.row("schedule", "overlay-schedule") == after


def test_authority_overlay_rejects_inconsistent_commands_before_state_change() -> None:
    current = {
        "id": "overlay-existing",
        "title": "before",
        "due_at": "2026-07-21T00:00:00Z",
        "completed_at": None,
        "priority": "medium",
        "color": "#3b82f6",
        "all_day": False,
        "start_time": None,
        "end_time": None,
        "created_at": "2026-07-20T00:00:00Z",
        "updated_at": "2026-07-20T00:00:00Z",
        "version": 1,
    }
    missing = {**current, "id": "overlay-missing"}
    updated_missing = {
        **missing,
        "title": "after",
        "updated_at": "2026-07-20T00:00:01Z",
        "version": 2,
    }
    request = MutationRequest.from_payload(
        name="overlay.probe",
        entity_type="schedule",
        entity_id="overlay-existing",
        payload={},
        expected_version=None,
    )
    cases = (
        MutationCommand.from_effects(
            request=request,
            db_plans=(
                DbMutationPlan(
                    "schedules",
                    {"id": "overlay-existing"},
                    "insert",
                    None,
                    None,
                    current,
                ),
            ),
            projections=(),
            sync_events=(),
            result_value=current,
        ),
        MutationCommand.from_effects(
            request=request,
            db_plans=(
                DbMutationPlan(
                    "schedules",
                    {"id": "overlay-missing"},
                    "update",
                    1,
                    missing,
                    updated_missing,
                ),
            ),
            projections=(),
            sync_events=(),
            result_value=updated_missing,
        ),
        MutationCommand.from_effects(
            request=request,
            db_plans=(
                DbMutationPlan(
                    "schedules",
                    {"id": "overlay-missing"},
                    "delete",
                    1,
                    missing,
                    None,
                ),
            ),
            projections=(),
            sync_events=(),
            result_value={"id": "overlay-missing"},
        ),
        MutationCommand.from_effects(
            request=request,
            db_plans=(),
            projections=(
                _projection_plan(
                    "path_rename",
                    "notes/missing-target.md",
                    0,
                    b"missing-body",
                    b"missing-body",
                    source="notes/missing-source.md",
                ),
            ),
            sync_events=(),
            result_value={"id": "overlay-existing"},
        ),
    )

    for command in cases:
        overlay = AuthorityOverlay(
            CATALOG, {("schedule", "overlay-existing"): current}
        )
        with pytest.raises(SpaceRecoveryRequiredError):
            overlay.apply(command)
        assert overlay.row("schedule", "overlay-existing") == current

    new_row = {**current, "id": "overlay-new"}
    insert_with_cas = MutationCommand.from_effects(
        request=request,
        db_plans=(
            DbMutationPlan(
                "schedules",
                {"id": "overlay-new"},
                "insert",
                1,
                None,
                new_row,
            ),
        ),
        projections=(),
        sync_events=(),
        result_value=new_row,
    )
    with pytest.raises(SpaceRecoveryRequiredError):
        AuthorityOverlay(CATALOG, {}).apply(insert_with_cas)


@pytest.mark.asyncio
async def test_batch_overlay_exposes_folder_create_to_note_child(uow_fixture) -> None:
    class FolderChildPolicy:
        entity_types = frozenset({"folder", "note"})

        async def compile(self, context, request):
            if request.entity_type == "note" and request.name == "entity.create":
                folder_id = request.payload.get("folder_id")
                assert isinstance(folder_id, str)
                assert context.authority.row("folder", folder_id) is not None
            base = await compile_catalog_entity_command(context, request)
            if request.entity_type == "folder":
                row = base.db_plans[0].after_row
                assert row is not None
                projection = _projection_plan(
                    "index_replace",
                    f"index/folders/id/{request.entity_id}",
                    0,
                    None,
                    _folder_index_blob(row),
                )
            else:
                return _with_projection(
                    base, projections=_note_create_projections(base, b"")
                )
            return _with_projection(base, projections=(projection,))

    compilation = await _compile_production_batch(
        uow_fixture,
        (
            MutationRequest.from_payload(
                name="entity.create",
                entity_type="folder",
                entity_id="folder-child-parent",
                payload={"name": "Parent"},
                expected_version=None,
            ),
            MutationRequest.from_payload(
                name="entity.create",
                entity_type="note",
                entity_id="note-child",
                payload={
                    "title": "Child",
                    "content_hash": hashlib.sha256(b"").hexdigest(),
                    "folder_id": "folder-child-parent",
                },
                expected_version=None,
            ),
        ),
        policies=(FolderChildPolicy(),),
    )

    assert compilation.rejected == ()
    assert compilation.operation_ids == ("overlay-op-0", "overlay-op-1")
    assert compilation.commands[1].db_plans[0].after_row["folder_id"] == (
        "folder-child-parent"
    )


@pytest.mark.asyncio
async def test_batch_overlay_exposes_quick_note_create_to_schedule_junction_child(
    uow_fixture,
) -> None:
    class NoteJunctionPolicy:
        entity_types = frozenset({"quick_note", "schedule_quick_note"})

        async def compile(self, context, request):
            if request.entity_type == "schedule_quick_note":
                quick_note_id = request.payload.get("quick_note_id")
                assert context.authority.row("quick_note", quick_note_id) is not None
            return await compile_catalog_entity_command(context, request)

    compilation = await _compile_production_batch(
        uow_fixture,
        (
            MutationRequest.from_payload(
                name="entity.create",
                entity_type="quick_note",
                entity_id="junction-note-parent",
                payload={"content": "Parent"},
                expected_version=None,
            ),
            MutationRequest.from_payload(
                name="entity.create",
                entity_type="schedule_quick_note",
                entity_id="schedule-note-link",
                payload={
                    "schedule_id": "schedule-parent",
                    "quick_note_id": "junction-note-parent",
                },
                expected_version=None,
            ),
        ),
        policies=(NoteJunctionPolicy(),),
    )

    assert compilation.rejected == ()
    assert compilation.commands[1].db_plans[0].after_row["quick_note_id"] == (
        "junction-note-parent"
    )


@pytest.mark.asyncio
async def test_batch_overlay_carries_consecutive_note_body_updates(uow_fixture) -> None:
    existing = Note(
        id="body-note",
        title="Body",
        content_hash=hashlib.sha256(b"original").hexdigest(),
        word_count=1,
        summary="",
        tags="[]",
        category=None,
        folder_id=None,
        status="active",
        trashed_at=None,
        created_at="2026-07-20T00:00:00Z",
        updated_at="2026-07-20T00:00:00Z",
        version=1,
    )
    async with uow_fixture.sessions.begin() as session:
        session.add(existing)
    note_fields = CATALOG.get("note").field_names
    existing_row = {field: getattr(existing, field) for field in note_fields}
    target = "notes/body-note.md"
    uow_fixture.scope.projection_snapshot = ProjectionAuthoritySnapshot(
        {target: b"original"},
        {"index/notes/note_id/body-note": _note_index_blob(existing_row, target)},
        {"fts/body-note": _fts_blob(existing_row, b"original")},
    )

    class BodyPolicy:
        entity_types = frozenset({"note"})

        async def compile(self, context, request):
            base = await compile_catalog_entity_command(context, request)
            target = "notes/body-note.md"
            before = context.authority.markdown(target)
            assert before is not None
            body = b"first" if request.expected_version == 1 else b"second"
            assert before == (b"original" if request.expected_version == 1 else b"first")
            _, _, tag_type, plan_type = _projection_api()
            row = base.db_plans[0].after_row
            assert row is not None
            index_target = f"index/notes/note_id/{request.entity_id}"
            fts_target = f"fts/{request.entity_id}"
            projections = (
                plan_type(
                    tag_type.MARKDOWN_WRITE,
                    None,
                    mutation_types.ContainedProjectionActionField(target),
                    0,
                    before,
                    body,
                ),
                plan_type(
                    tag_type.INDEX_REPLACE,
                    None,
                    mutation_types.ContainedProjectionActionField(index_target),
                    1,
                    context.authority.derived_projection(
                        tag_type.INDEX_REPLACE, index_target
                    ),
                    _note_index_blob(row, target),
                ),
                plan_type(
                    tag_type.FTS_REPLACE,
                    None,
                    mutation_types.ContainedProjectionActionField(fts_target),
                    2,
                    context.authority.derived_projection(
                        tag_type.FTS_REPLACE, fts_target
                    ),
                    _fts_blob(row, body),
                ),
            )
            return _with_projection(base, projections=projections)

    compilation = await _compile_production_batch(
        uow_fixture,
        (
            MutationRequest.from_payload(
                name="entity.update",
                entity_type="note",
                entity_id="body-note",
                payload={"content_hash": hashlib.sha256(b"first").hexdigest()},
                expected_version=1,
            ),
            MutationRequest.from_payload(
                name="entity.update",
                entity_type="note",
                entity_id="body-note",
                payload={"content_hash": hashlib.sha256(b"second").hexdigest()},
                expected_version=2,
            ),
        ),
        policies=(BodyPolicy(),),
    )

    assert compilation.rejected == ()
    assert compilation.commands[1].projections[0].before == b"first"
    async with uow_fixture.sessions() as session:
        stored = await session.get(Note, "body-note")
    assert stored is not None
    assert stored.content_hash == hashlib.sha256(b"original").hexdigest()


@pytest.mark.asyncio
async def test_batch_overlay_carries_move_target_into_metadata_update(uow_fixture) -> None:
    existing = Note(
        id="move-note",
        title="Original",
        content_hash=hashlib.sha256(b"body").hexdigest(),
        word_count=1,
        summary="",
        tags="[]",
        category=None,
        folder_id="folder-one",
        status="active",
        trashed_at=None,
        created_at="2026-07-20T00:00:00Z",
        updated_at="2026-07-20T00:00:00Z",
        version=1,
    )
    async with uow_fixture.sessions.begin() as session:
        session.add(existing)
    note_fields = CATALOG.get("note").field_names
    existing_row = {field: getattr(existing, field) for field in note_fields}
    target = "notes/folder-one/move-note-Original.md"
    uow_fixture.scope.projection_snapshot = ProjectionAuthoritySnapshot(
        {target: b"body"},
        {"index/notes/note_id/move-note": _note_index_blob(existing_row, target)},
        {"fts/move-note": _fts_blob(existing_row, b"body")},
    )

    class MoveMetadataPolicy:
        entity_types = frozenset({"note"})

        async def compile(self, context, request):
            base = await compile_catalog_entity_command(context, request)
            current = context.authority.row("note", request.entity_id)
            assert current is not None
            source = (
                f"notes/{current['folder_id']}/{request.entity_id}-{current['title']}.md"
            )
            target_folder = request.payload.get("folder_id", current["folder_id"])
            target_title = request.payload.get("title", current["title"])
            target = f"notes/{target_folder}/{request.entity_id}-{target_title}.md"
            assert context.authority.markdown(source) == b"body"
            _, _, tag_type, plan_type = _projection_api()
            row = base.db_plans[0].after_row
            assert row is not None
            index_target = f"index/notes/note_id/{request.entity_id}"
            projections = [
                plan_type(
                    tag_type.PATH_RENAME,
                    mutation_types.ContainedProjectionActionField(source),
                    mutation_types.ContainedProjectionActionField(target),
                    0,
                    b"body",
                    b"body",
                ),
                plan_type(
                    tag_type.INDEX_REPLACE,
                    None,
                    mutation_types.ContainedProjectionActionField(index_target),
                    1,
                    context.authority.derived_projection(
                        tag_type.INDEX_REPLACE, index_target
                    ),
                    _note_index_blob(row, target),
                ),
            ]
            if request.payload.get("title") is not None:
                fts_target = f"fts/{request.entity_id}"
                projections.append(
                    plan_type(
                        tag_type.FTS_REPLACE,
                        None,
                        mutation_types.ContainedProjectionActionField(fts_target),
                        2,
                        context.authority.derived_projection(
                            tag_type.FTS_REPLACE, fts_target
                        ),
                        _fts_blob(row, b"body"),
                    )
                )
            return _with_projection(
                base,
                projections=tuple(projections),
            )

    compilation = await _compile_production_batch(
        uow_fixture,
        (
            MutationRequest.from_payload(
                name="entity.update",
                entity_type="note",
                entity_id="move-note",
                payload={"folder_id": "folder-two"},
                expected_version=1,
            ),
            MutationRequest.from_payload(
                name="entity.update",
                entity_type="note",
                entity_id="move-note",
                payload={"title": "Renamed"},
                expected_version=2,
            ),
        ),
        policies=(MoveMetadataPolicy(),),
    )

    assert compilation.rejected == ()
    second = compilation.commands[1].projections[0]
    assert str(second.source) == "notes/folder-two/move-note-Original.md"
    assert str(second.target) == "notes/folder-two/move-note-Renamed.md"


@pytest.mark.asyncio
async def test_batch_overlay_carries_quick_note_conversion_children(uow_fixture) -> None:
    async with uow_fixture.sessions.begin() as session:
        session.add(
            QuickNote(
                id="conversion-quick-note",
                content="captured",
                mood=None,
                tags="[]",
                pinned=False,
                archived_at=None,
                archive_file_path=None,
                folder_id=None,
                trashed_at=None,
                migrated_to_note_id=None,
                created_at="2026-07-20T00:00:00Z",
                updated_at="2026-07-20T00:00:00Z",
                version=1,
            )
        )

    class ConversionPolicy:
        entity_types = frozenset({"note", "memo_comment"})

        async def compile(self, context, request):
            if request.entity_type == "note" and request.name == "entity.create":
                assert context.authority.row("quick_note", "conversion-quick-note") is not None
            if request.entity_type == "memo_comment" and request.name == "entity.create":
                note_id = request.payload.get("note_id")
                assert context.authority.row("note", note_id) is not None
                quick_note = context.authority.row("quick_note", "conversion-quick-note")
                assert quick_note is not None
                assert quick_note["migrated_to_note_id"] == "converted-note"
            base = await compile_catalog_entity_command(context, request)
            if request.entity_type == "note":
                return _with_projection(
                    base,
                    projections=_note_create_projections(base, b"captured"),
                )
            return base

    compilation = await _compile_production_batch(
        uow_fixture,
        (
            MutationRequest.from_payload(
                name="entity.create",
                entity_type="note",
                entity_id="converted-note",
                payload={
                    "title": "Converted",
                    "content_hash": hashlib.sha256(b"captured").hexdigest(),
                },
                expected_version=None,
            ),
            MutationRequest.from_payload(
                name="entity.update",
                entity_type="quick_note",
                entity_id="conversion-quick-note",
                payload={
                    "archived_at": "2026-07-20T00:00:01Z",
                    "migrated_to_note_id": "converted-note",
                },
                expected_version=1,
            ),
            MutationRequest.from_payload(
                name="entity.create",
                entity_type="memo_comment",
                entity_id="converted-comment",
                payload={"note_id": "converted-note", "content": "copied"},
                expected_version=None,
            ),
        ),
        policies=(ConversionPolicy(),),
    )

    assert compilation.rejected == ()
    assert compilation.commands[2].db_plans[0].after_row["note_id"] == "converted-note"


@pytest.mark.asyncio
async def test_catalog_compiler_and_interpreter_execute_unregistered_entity_policy(
    uow_fixture,
) -> None:
    async with uow_fixture.sessions.begin() as session:
        session.add(
            Schedule(
                id="generic-schedule",
                title="before",
                due_at="2026-07-21T00:00:00Z",
                created_at="2026-07-20T00:00:00Z",
                updated_at="2026-07-20T00:00:00Z",
                version=1,
            )
        )
    request = MutationRequest.from_payload(
        name="entity.update",
        entity_type="schedule",
        entity_id="generic-schedule",
        payload={"title": "after"},
        expected_version=1,
    )
    item = mutation_types.PreparedBatchItem(
        0, "generic-operation", request.request_hash, request, None
    )

    async with uow_fixture.sessions() as session:
        compilation = await MutationCompiler(CATALOG).compile_batch(
            uow_fixture.scope, (item,), session
        )

    assert compilation.rejected == ()
    assert compilation.operation_ids == ("generic-operation",)
    assert compilation.commands[0].db_plans[0].after_row["title"] == "after"

    uow = MutationUnitOfWork(
        catalog=CATALOG,
        compiler=MutationCompiler(CATALOG),
        interpreter=DbMutationInterpreter(CATALOG),
        projection_executor=FileSystemProjectionExecutor(),
        recovery_gate=_CleanGate(),
        journal_factory=MutationJournal,
    )
    result = await uow.execute(uow_fixture.scope, request, "generic-execution")
    async with uow_fixture.sessions() as session:
        stored = await session.get(Schedule, "generic-schedule")

    assert result.state is MutationState.FINALIZED
    assert stored is not None and stored.title == "after" and stored.version == 2


@pytest.mark.asyncio
async def test_timestamp_lww_remote_win_executes_against_authoritative_version(
    uow_fixture,
) -> None:
    async with uow_fixture.sessions.begin() as session:
        session.add(
            Schedule(
                id="remote-win-schedule",
                title="local",
                due_at="2026-07-21T00:00:00Z",
                created_at="2026-07-20T00:00:00Z",
                updated_at="2026-07-20T00:00:03Z",
                version=3,
            )
        )
    request = MutationRequest.from_payload(
        name="entity.update",
        entity_type="schedule",
        entity_id="remote-win-schedule",
        payload={"title": "remote"},
        expected_version=2,
        client_updated_at="2026-07-20T00:00:03.1Z",
    )
    uow = MutationUnitOfWork(
        catalog=CATALOG,
        compiler=MutationCompiler(CATALOG),
        interpreter=DbMutationInterpreter(CATALOG),
        projection_executor=FileSystemProjectionExecutor(),
        recovery_gate=_CleanGate(),
        journal_factory=MutationJournal,
    )

    result = await uow.execute(uow_fixture.scope, request, "remote-win-operation")
    async with uow_fixture.sessions() as session:
        stored = await session.get(Schedule, "remote-win-schedule")

    assert result.resolution == "remote"
    assert stored is not None and stored.title == "remote" and stored.version == 4


@pytest.mark.asyncio
async def test_timestamp_lww_remote_delete_executes_against_authoritative_version(
    uow_fixture,
) -> None:
    async with uow_fixture.sessions.begin() as session:
        session.add(
            Schedule(
                id="remote-delete-schedule",
                title="local",
                due_at="2026-07-21T00:00:00Z",
                created_at="2026-07-20T00:00:00Z",
                updated_at="2026-07-20T00:00:02Z",
                version=3,
            )
        )
    request = MutationRequest.from_payload(
        name="entity.delete",
        entity_type="schedule",
        entity_id="remote-delete-schedule",
        payload={},
        expected_version=2,
        client_updated_at="2026-07-20T00:00:03Z",
    )
    uow = MutationUnitOfWork(
        catalog=CATALOG,
        compiler=MutationCompiler(CATALOG),
        interpreter=DbMutationInterpreter(CATALOG),
        projection_executor=FileSystemProjectionExecutor(),
        recovery_gate=_CleanGate(),
        journal_factory=MutationJournal,
    )

    result = await uow.execute(uow_fixture.scope, request, "remote-delete-operation")
    async with uow_fixture.sessions() as session:
        stored = await session.get(Schedule, "remote-delete-schedule")

    assert result.resolution == "remote"
    assert stored is None


@pytest.mark.asyncio
async def test_strict_cas_rejects_update_without_expected_version(uow_fixture) -> None:
    async with uow_fixture.sessions.begin() as session:
        session.add_all(
            (
                Project(
                    id="strict-cas-project",
                    key="SC",
                    name="Strict CAS",
                    default_status_definition_id="sys-status-not-started",
                    default_type_definition_id="sys-type-work-item",
                    created_at="2026-07-20T00:00:00Z",
                    updated_at="2026-07-20T00:00:00Z",
                    version=1,
                ),
                WorkItem(
                    id="strict-cas-work-item",
                    project_id="strict-cas-project",
                    display_key="SC-1",
                    title="before",
                    type_definition_id="sys-type-work-item",
                    status_definition_id="sys-status-not-started",
                    created_at="2026-07-20T00:00:00Z",
                    updated_at="2026-07-20T00:00:00Z",
                    version=1,
                ),
            )
        )
    request = MutationRequest.from_payload(
        name="entity.update",
        entity_type="work_item",
        entity_id="strict-cas-work-item",
        payload={"title": "after"},
        expected_version=None,
    )
    item = mutation_types.PreparedBatchItem(
        0, "strict-cas-operation", request.request_hash, request, None
    )

    async with uow_fixture.sessions() as session:
        compilation = await MutationCompiler(CATALOG).compile_batch(
            uow_fixture.scope, (item,), session
        )

    assert compilation.commands == ()
    assert tuple(item.code for item in compilation.rejected) == ("version_conflict",)


@pytest.mark.asyncio
async def test_production_compiler_injects_closed_plan_factories(uow_fixture) -> None:
    class FactoryPolicy:
        entity_types = frozenset({"schedule"})

        async def compile(self, context, request):
            schedule_model = context.catalog.model_for("schedule")
            before = schedule_model(
                id=request.entity_id,
                title="before",
                due_at="2026-07-21T00:00:00Z",
                completed_at=None,
                priority="medium",
                color="#3b82f6",
                all_day=False,
                start_time=None,
                end_time=None,
                created_at="2026-07-20T00:00:00Z",
                updated_at="2026-07-20T00:00:00Z",
                version=1,
            )
            after = schedule_model(
                id=request.entity_id,
                title="after",
                due_at="2026-07-21T00:00:00Z",
                completed_at=None,
                priority="medium",
                color="#3b82f6",
                all_day=False,
                start_time=None,
                end_time=None,
                created_at="2026-07-20T00:00:00Z",
                updated_at="2026-07-20T00:00:01Z",
                version=2,
            )
            moved = schedule_model(
                id="factory-schedule-moved",
                title="after",
                due_at="2026-07-21T00:00:00Z",
                completed_at=None,
                priority="medium",
                color="#3b82f6",
                all_day=False,
                start_time=None,
                end_time=None,
                created_at="2026-07-20T00:00:00Z",
                updated_at="2026-07-20T00:00:01Z",
                version=2,
            )
            db_insert = context.db.insert(before)
            db_update = context.db.update(before, after)
            db_delete = context.db.delete(after)
            sync_create = context.sync.create(before)
            sync_update = context.sync.update(after)
            sync_delete = context.sync.delete(
                after, deleted_at="2026-07-20T00:00:02Z"
            )
            assert db_insert.table == "schedules" and db_insert.operation == "insert"
            assert db_update.expected_version == 1
            assert db_delete.expected_version == 2
            assert sync_create.entity_type == "schedule" and sync_create.version == 1
            assert sync_update.entity_type == "schedule" and sync_update.version == 2
            assert sync_delete.action == "delete" and sync_delete.version == 3
            with pytest.raises(ValueError, match="primary key"):
                context.db.update(before, moved)
            return context.command(
                request=request,
                db_plans=(db_insert,),
                sync_events=(sync_create,),
                value={"id": request.entity_id},
            )

    request = MutationRequest.from_payload(
        name="factory.probe",
        entity_type="schedule",
        entity_id="factory-schedule",
        payload={},
        expected_version=None,
    )
    item = mutation_types.PreparedBatchItem(
        0, "factory-operation", request.request_hash, request, None
    )
    async with uow_fixture.sessions() as session:
        compiled = await MutationCompiler(CATALOG, (FactoryPolicy(),)).compile_batch(
            uow_fixture.scope, (item,), session
        )

    assert compiled.operation_ids == ("factory-operation",)
    assert compiled.commands[0].db_plans[0].after_row["title"] == "before"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("entity_type", "payload"),
    (
        ("note", {"title": "Unsafe", "content_hash": "body"}),
        ("folder", {"name": "Unsafe"}),
    ),
)
async def test_production_compiler_requires_policy_for_projection_backed_entity(
    uow_fixture, entity_type, payload
) -> None:
    request = MutationRequest.from_payload(
        name="entity.create",
        entity_type=entity_type,
        entity_id=f"unsafe-{entity_type}",
        payload=payload,
        expected_version=None,
    )
    item = mutation_types.PreparedBatchItem(
        0, f"unsafe-{entity_type}-operation", request.request_hash, request, None
    )

    async with uow_fixture.sessions() as session:
        with pytest.raises(
            SpaceRecoveryRequiredError, match="projection-backed entity"
        ):
            await MutationCompiler(CATALOG).compile_batch(
                uow_fixture.scope, (item,), session
            )


@pytest.mark.asyncio
async def test_production_compiler_rejects_incomplete_registered_policy(
    uow_fixture,
) -> None:
    class IncompleteNotePolicy:
        entity_types = frozenset({"note"})

        async def compile(self, context, request):
            return await compile_catalog_entity_command(context, request)

    class MissingSyncPolicy:
        entity_types = frozenset({"schedule"})

        async def compile(self, context, request):
            base = await compile_catalog_entity_command(context, request)
            return context.command(
                request=request,
                db_plans=base.db_plans,
                sync_events=(),
                value=base.result_value,
            )

    class CrossEntityPolicy:
        entity_types = frozenset({"note"})

        async def compile(self, context, request):
            schedule_request = MutationRequest.from_payload(
                name="entity.create",
                entity_type="schedule",
                entity_id="cross-entity-schedule",
                payload={
                    "title": "cross",
                    "due_at": "2026-07-21T00:00:00Z",
                },
                expected_version=None,
            )
            schedule_command = await compile_catalog_entity_command(
                context, schedule_request
            )
            return context.command(
                request=request,
                db_plans=schedule_command.db_plans,
                projections=(
                    _projection_plan(
                        "markdown_write",
                        "notes/cross-entity-note.md",
                        0,
                        None,
                        b"cross",
                    ),
                ),
                sync_events=schedule_command.sync_events,
                value={"id": request.entity_id},
            )

    class DivergentSyncPolicy:
        entity_types = frozenset({"schedule"})

        async def compile(self, context, request):
            base = await compile_catalog_entity_command(context, request)
            event = base.sync_events[0]
            payload = {**event.payload, "title": "different-ledger-title"}
            divergent = SyncEventPlan(
                event.entity_type,
                event.entity_id,
                event.action,
                payload,
                event.version,
                event.created_at,
            )
            return context.command(
                request=request,
                db_plans=base.db_plans,
                sync_events=(divergent,),
                value=base.result_value,
            )

    class WrongTargetNotePolicy:
        entity_types = frozenset({"note"})

        async def compile(self, context, request):
            base = await compile_catalog_entity_command(context, request)
            projections = list(_note_create_projections(base, b"wrong target"))
            projections[0] = _projection_plan(
                "markdown_write",
                "notes/another-note.md",
                0,
                None,
                b"wrong target",
            )
            return _with_projection(base, projections=tuple(projections))

    cases = (
        (
            IncompleteNotePolicy(),
            MutationRequest.from_payload(
                name="entity.create",
                entity_type="note",
                entity_id="incomplete-note",
                payload={"title": "Incomplete"},
                expected_version=None,
            ),
            "complete bound projections",
        ),
        (
            MissingSyncPolicy(),
            MutationRequest.from_payload(
                name="entity.create",
                entity_type="schedule",
                entity_id="missing-sync-schedule",
                payload={
                    "title": "Missing sync",
                    "due_at": "2026-07-21T00:00:00Z",
                },
                expected_version=None,
            ),
            "sync event is missing",
        ),
        (
            CrossEntityPolicy(),
            MutationRequest.from_payload(
                name="entity.create",
                entity_type="note",
                entity_id="cross-entity-note",
                payload={"title": "Cross"},
                expected_version=None,
            ),
            "request entity",
        ),
        (
            DivergentSyncPolicy(),
            MutationRequest.from_payload(
                name="entity.create",
                entity_type="schedule",
                entity_id="divergent-sync-schedule",
                payload={
                    "title": "Database title",
                    "due_at": "2026-07-21T00:00:00Z",
                },
                expected_version=None,
            ),
            "after image",
        ),
        (
            WrongTargetNotePolicy(),
            MutationRequest.from_payload(
                name="entity.create",
                entity_type="note",
                entity_id="wrong-target-note",
                payload={
                    "content_hash": hashlib.sha256(b"wrong target").hexdigest(),
                    "title": "Wrong target",
                },
                expected_version=None,
            ),
            "authoritative Markdown after-body",
        ),
    )
    for index, (policy, request, message) in enumerate(cases):
        item = mutation_types.PreparedBatchItem(
            0, f"incomplete-policy-{index}", request.request_hash, request, None
        )
        async with uow_fixture.sessions() as session:
            with pytest.raises(SpaceRecoveryRequiredError, match=message):
                await MutationCompiler(CATALOG, (policy,)).compile_batch(
                    uow_fixture.scope, (item,), session
                )


@pytest.mark.asyncio
async def test_production_compiler_accepts_event_only_multi_effect_command(
    uow_fixture,
) -> None:
    class EventOnlyPolicy:
        entity_types = frozenset({"schedule"})

        async def compile(self, context, request):
            base = await compile_catalog_entity_command(context, request)
            first = base.sync_events[0]
            second_payload = {**first.payload, "id": "event-only-second"}
            second = SyncEventPlan(
                first.entity_type,
                "event-only-second",
                first.action,
                second_payload,
                first.version,
                first.created_at,
            )
            return context.command(
                request=request,
                db_plans=(),
                sync_events=(first, second),
                value={"event_ids": (first.entity_id, second.entity_id)},
            )

    request = MutationRequest.from_payload(
        name="entity.create",
        entity_type="schedule",
        entity_id="event-only-first",
        payload={
            "title": "event-only",
            "due_at": "2026-07-21T00:00:00Z",
        },
        expected_version=None,
    )
    item = mutation_types.PreparedBatchItem(
        0, "event-only-operation", request.request_hash, request, None
    )

    async with uow_fixture.sessions() as session:
        compilation = await MutationCompiler(
            CATALOG, (EventOnlyPolicy(),)
        ).compile_batch(uow_fixture.scope, (item,), session)

    assert compilation.operation_ids == ("event-only-operation",)
    assert compilation.commands[0].db_plans == ()
    assert tuple(
        event.entity_id for event in compilation.commands[0].sync_events
    ) == ("event-only-first", "event-only-second")


@pytest.mark.asyncio
async def test_note_projection_rejects_prefix_collision_with_authoritative_path(
    uow_fixture,
) -> None:
    def note(note_id: str, title: str, content: bytes) -> Note:
        return Note(
            id=note_id,
            title=title,
            content_hash=hashlib.sha256(content).hexdigest(),
            word_count=1,
            summary="",
            tags="[]",
            category=None,
            folder_id=None,
            status="active",
            trashed_at=None,
            created_at="2026-07-20T00:00:00Z",
            updated_at="2026-07-20T00:00:00Z",
            version=1,
        )

    first = note("n1", "Title", b"first body")
    second = note("n1-other", "Title", b"second body")
    async with uow_fixture.sessions.begin() as session:
        session.add_all((first, second))

    note_fields = CATALOG.get("note").field_names
    first_row = {field: getattr(first, field) for field in note_fields}
    second_row = {field: getattr(second, field) for field in note_fields}
    first_path = "notes/n1-title.md"
    colliding_path = "notes/n1-other-title.md"
    first_index = _note_index_blob(first_row, first_path)
    second_index = _note_index_blob(second_row, colliding_path)
    first_fts = _fts_blob(first_row, b"first body")
    second_fts = _fts_blob(second_row, b"second body")
    uow_fixture.scope.projection_snapshot = ProjectionAuthoritySnapshot(
        {
            first_path: b"first body",
            colliding_path: b"second body",
        },
        {
            "index/notes/note_id/n1": first_index,
            "index/notes/note_id/n1-other": second_index,
        },
        {
            "fts/n1": first_fts,
            "fts/n1-other": second_fts,
        },
    )

    class CollidingDeletePolicy:
        entity_types = frozenset({"note"})

        async def compile(self, context, request):
            base = await compile_catalog_entity_command(context, request)
            return _with_projection(
                base,
                projections=(
                    _projection_plan(
                        "path_remove",
                        colliding_path,
                        0,
                        b"second body",
                        None,
                    ),
                    _projection_plan(
                        "index_replace",
                        "index/notes/note_id/n1",
                        1,
                        first_index,
                        None,
                    ),
                    _projection_plan(
                        "fts_replace",
                        "fts/n1",
                        2,
                        first_fts,
                        None,
                    ),
                ),
            )

    request = MutationRequest.from_payload(
        name="entity.delete",
        entity_type="note",
        entity_id="n1",
        payload={},
        expected_version=1,
    )
    item = mutation_types.PreparedBatchItem(
        0, "note-prefix-collision", request.request_hash, request, None
    )

    async with uow_fixture.sessions() as session:
        with pytest.raises(
            SpaceRecoveryRequiredError, match="complete bound projections"
        ):
            await MutationCompiler(
                CATALOG, (CollidingDeletePolicy(),)
            ).compile_batch(uow_fixture.scope, (item,), session)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("index_field", "index_value"),
    (("title", "Divergent"), ("level", "L9")),
)
async def test_note_projection_rejects_index_row_divergent_from_db_after_image(
    uow_fixture, index_field, index_value
) -> None:
    body = b"authoritative body"

    class DivergentIndexPolicy:
        entity_types = frozenset({"note"})

        async def compile(self, context, request):
            base = await compile_catalog_entity_command(context, request)
            row = base.db_plans[0].after_row
            assert row is not None
            projections = list(_note_create_projections(base, body))
            index_payload = json.loads(
                _note_index_blob(row, f"notes/{request.entity_id}.md")
            )
            index_payload["row"][index_field] = index_value
            projections[1] = _projection_plan(
                "index_replace",
                f"index/notes/note_id/{request.entity_id}",
                1,
                None,
                _canonical_projection_blob(index_payload),
            )
            return _with_projection(base, projections=tuple(projections))

    request = MutationRequest.from_payload(
        name="entity.create",
        entity_type="note",
        entity_id="divergent-index-note",
        payload={
            "content_hash": hashlib.sha256(body).hexdigest(),
            "title": "Authoritative",
        },
        expected_version=None,
    )
    item = mutation_types.PreparedBatchItem(
        0, "divergent-index-operation", request.request_hash, request, None
    )

    async with uow_fixture.sessions() as session:
        with pytest.raises(
            SpaceRecoveryRequiredError, match="index row.*database image"
        ):
            await MutationCompiler(
                CATALOG, (DivergentIndexPolicy(),)
            ).compile_batch(uow_fixture.scope, (item,), session)


@pytest.mark.asyncio
async def test_business_receipt_preserves_null_insert_before_and_delete_after(
    uow_fixture,
) -> None:
    uow = MutationUnitOfWork(
        catalog=CATALOG,
        compiler=MutationCompiler(CATALOG),
        interpreter=DbMutationInterpreter(CATALOG),
        projection_executor=uow_fixture.executor,
        recovery_gate=_CleanGate(),
        journal_factory=MutationJournal,
    )
    created = MutationRequest.from_payload(
        name="entity.create",
        entity_type="schedule",
        entity_id="receipt-image-schedule",
        payload={
            "title": "created",
            "due_at": "2026-07-21T00:00:00Z",
        },
        expected_version=None,
    )
    deleted = MutationRequest.from_payload(
        name="entity.delete",
        entity_type="schedule",
        entity_id="receipt-image-schedule",
        payload={},
        expected_version=1,
    )

    await uow.execute_batch(
        uow_fixture.scope,
        (created, deleted),
        "receipt-image-batch",
        operation_ids=("receipt-image-create", "receipt-image-delete"),
    )

    async with uow_fixture.sessions() as session:
        create_operation = await session.get(
            MutationOperation, "receipt-image-create"
        )
        delete_operation = await session.get(
            MutationOperation, "receipt-image-delete"
        )
    assert create_operation is not None
    assert delete_operation is not None
    assert json.loads(create_operation.db_before_json) == [None]
    assert json.loads(create_operation.db_after_json)[0]["id"] == "receipt-image-schedule"
    assert json.loads(delete_operation.db_before_json)[0]["id"] == "receipt-image-schedule"
    assert json.loads(delete_operation.db_after_json) == [None]


def test_interpreter_decode_rejects_effects_outside_compiled_catalog() -> None:
    request = MutationRequest.from_payload(
        name="decode.probe",
        entity_type="schedule",
        entity_id="decode-schedule",
        payload={},
        expected_version=None,
    )
    complete_schedule = {
        "id": "decode-schedule",
        "title": "decode",
        "due_at": "2026-07-21T00:00:00Z",
        "completed_at": None,
        "priority": "medium",
        "color": "#3b82f6",
        "all_day": False,
        "start_time": None,
        "end_time": None,
        "created_at": "2026-07-20T00:00:00Z",
        "updated_at": "2026-07-20T00:00:00Z",
        "version": 1,
    }
    note_request = MutationRequest.from_payload(
        name="entity.create",
        entity_type="note",
        entity_id="decode-note",
        payload={"title": "Decode note"},
        expected_version=None,
    )
    commands = (
        MutationCommand.from_effects(
            request=request,
            db_plans=(
                DbMutationPlan(
                    "unknown_table",
                    {"id": "decode-schedule"},
                    "insert",
                    None,
                    None,
                    {"id": "decode-schedule"},
                ),
            ),
            projections=(),
            sync_events=(),
            result_value={"id": "decode-schedule"},
        ),
        MutationCommand.from_effects(
            request=note_request,
            db_plans=(
                DbMutationPlan(
                    "schedules",
                    {"id": "decode-schedule"},
                    "insert",
                    None,
                    None,
                    complete_schedule,
                ),
            ),
            projections=(),
            sync_events=(
                SyncEventPlan(
                    "schedule",
                    "decode-schedule",
                    "create",
                    complete_schedule,
                    1,
                    "2026-07-20T00:00:00Z",
                ),
            ),
            result_value={"id": "decode-note"},
        ),
        MutationCommand.from_effects(
            request=request,
            db_plans=(
                DbMutationPlan(
                    "schedules",
                    {"id": "decode-schedule"},
                    "insert",
                    None,
                    None,
                    complete_schedule,
                ),
            ),
            projections=(),
            sync_events=(
                SyncEventPlan(
                    "schedule",
                    "decode-schedule",
                    "create",
                    {**complete_schedule, "title": "different ledger title"},
                    1,
                    "2026-07-20T00:00:00Z",
                ),
            ),
            result_value={"id": "decode-schedule"},
        ),
        MutationCommand.from_effects(
            request=request,
            db_plans=(),
            projections=(),
            sync_events=(
                SyncEventPlan(
                    "unknown_entity",
                    "decode-schedule",
                    "create",
                    {"id": "decode-schedule"},
                    1,
                    "2026-07-20T00:00:00Z",
                ),
            ),
            result_value={"id": "decode-schedule"},
        ),
        MutationCommand.from_effects(
            request=request,
            db_plans=(
                DbMutationPlan(
                    "schedules",
                    {"id": "decode-schedule"},
                    "insert",
                    None,
                    complete_schedule,
                    complete_schedule,
                ),
            ),
            projections=(),
            sync_events=(),
            result_value={"id": "decode-schedule"},
        ),
        MutationCommand.from_effects(
            request=request,
            db_plans=(),
            projections=(),
            sync_events=(
                SyncEventPlan(
                    "schedule",
                    "decode-schedule",
                    "create",
                    {"id": "decode-schedule"},
                    1,
                    "2026-07-20T00:00:00Z",
                ),
            ),
            result_value={"id": "decode-schedule"},
        ),
    )
    interpreter = DbMutationInterpreter(CATALOG)

    for command in commands:
        encoded = mutation_types.persisted_command_bytes(command.persisted()).decode(
            "utf-8"
        )
        with pytest.raises(SpaceRecoveryRequiredError):
            interpreter.decode_command(encoded)


@pytest.mark.asyncio
async def test_production_compiler_persists_aliases_through_invisible_and_visible_ledger(
    uow_fixture, monkeypatch
) -> None:
    internal_names = ("quick_note", "time_block", "schedule_quick_note")
    payloads = (
        {"content": "alias"},
        {
            "date": "2026-07-20",
            "start_time": "09:00",
            "end_time": "10:00",
        },
        {"schedule_id": "schedule-alias", "quick_note_id": "alias-0"},
    )

    visibility_snapshots: list[tuple[tuple[str, bool], ...]] = []
    original_finalize = MutationJournal.finalize_batch

    async def observed_finalize(journal, batch_id):
        async with uow_fixture.sessions() as session:
            before = tuple(
                (
                    row.entity_type,
                    row.visible,
                )
                for row in tuple(
                    await session.scalars(
                        select(SyncOutbox)
                        .where(SyncOutbox.batch_id == batch_id)
                        .order_by(SyncOutbox.id)
                    )
                )
            )
        visibility_snapshots.append(before)
        result = await original_finalize(journal, batch_id)
        async with uow_fixture.sessions() as session:
            after = tuple(
                (row.entity_type, row.visible)
                for row in tuple(
                    await session.scalars(
                        select(SyncOutbox)
                        .where(SyncOutbox.batch_id == batch_id)
                        .order_by(SyncOutbox.id)
                    )
                )
            )
        visibility_snapshots.append(after)
        return result

    monkeypatch.setattr(MutationJournal, "finalize_batch", observed_finalize)
    requests = tuple(
        MutationRequest.from_payload(
            name="entity.create",
            entity_type=entity_type,
            entity_id=f"alias-{index}",
            payload=payloads[index],
            expected_version=None,
        )
        for index, entity_type in enumerate(internal_names)
    )
    uow = MutationUnitOfWork(
        catalog=CATALOG,
        compiler=MutationCompiler(CATALOG),
        interpreter=DbMutationInterpreter(CATALOG),
        projection_executor=FileSystemProjectionExecutor(),
        recovery_gate=_CleanGate(),
        journal_factory=MutationJournal,
    )

    result = await uow.execute_batch(
        uow_fixture.scope,
        requests,
        "alias-batch",
        operation_ids=("alias-op-0", "alias-op-1", "alias-op-2"),
    )

    async with uow_fixture.sessions() as session:
        operations = tuple(
            await session.scalars(
                select(MutationOperation)
                .where(MutationOperation.batch_id == "alias-batch")
                .order_by(MutationOperation.sequence)
            )
        )
    persisted_internal = tuple(
        DbMutationInterpreter(CATALOG).decode_command(row.command_json).sync_events[0].entity_type
        for row in operations
    )
    wire_names = tuple(CATALOG.get(name).effective_sync_entity_type for name in internal_names)
    assert result.rejected == ()
    assert persisted_internal == internal_names
    assert visibility_snapshots == [
        tuple((name, False) for name in wire_names),
        tuple((name, True) for name in wire_names),
    ]


@pytest.mark.asyncio
async def test_execute_finalizes_once_and_makes_ledger_visible_at_final_boundary(uow_fixture) -> None:
    uow_fixture.compiler.projections = (
        _projection_plan("markdown_write", "notes/n1.md", 0, None, b"body"),
    )
    first = await uow_fixture.uow.execute(uow_fixture.scope, _request("n1"), "op-n1")
    writes = uow_fixture.executor.calls
    second = await uow_fixture.uow.execute(uow_fixture.scope, _request("n1"), "op-n1")

    assert first.state is MutationState.FINALIZED
    assert second == first
    assert uow_fixture.executor.calls == writes == 1
    async with uow_fixture.sessions() as session:
        event = await session.scalar(select(SyncOutbox).where(SyncOutbox.operation_id == "op-n1"))
        step = await session.scalar(
            select(MutationStep).where(MutationStep.operation_id == "op-n1")
        )
        state = await session.get(SyncState, 1)
    assert event is not None and event.visible is True and event.entity_type == "wire-note"
    assert step is not None and StepState(step.state) is StepState.APPLIED
    assert step.applied_hash == step.after_hash
    assert state is not None and state.current_cursor == event.id


@pytest.mark.asyncio
async def test_internal_hashed_child_ids_persist_parent_suffix_mapping(
    uow_fixture,
) -> None:
    batch_id = "b" * 128
    result = await uow_fixture.uow.execute_batch(
        uow_fixture.scope,
        (_request("derived-1"), _request("derived-2")),
        batch_id,
    )
    expected = {
        bounded_child_operation_id(batch_id, "0000"): {
            "parent_id": batch_id,
            "suffix": "0000",
        },
        bounded_child_operation_id(batch_id, "0001"): {
            "parent_id": batch_id,
            "suffix": "0001",
        },
    }
    async with uow_fixture.sessions() as session:
        batch = await session.get(MutationBatch, batch_id)

    assert tuple(item.operation_id for item in result.applied) == tuple(expected)
    assert result.operation_id_derivations == expected
    assert batch is not None
    assert json.loads(batch.result_json)["operation_id_derivations"] == expected
    retry = await uow_fixture.uow.execute_batch(
        uow_fixture.scope,
        (_request("derived-1"), _request("derived-2")),
        batch_id,
    )
    assert retry == result
    assert "operation_id_derivations" not in inspect.signature(
        MutationUnitOfWork.execute_prepared_batch
    ).parameters


@pytest.mark.asyncio
async def test_execute_orders_every_durable_boundary_before_visibility(
    uow_fixture, monkeypatch
) -> None:
    observed: list[str] = []
    uow_fixture.compiler.projections = _all_projection_plans()

    original_create_intent = MutationJournal.create_batch_intent
    original_mark_staged = MutationJournal.mark_staged
    original_mark_finalizing = MutationJournal.mark_finalizing
    original_transition = MutationJournal.transition
    original_finalize = MutationJournal.finalize_batch
    original_commit_business = MutationUnitOfWork._commit_business
    original_publish = uow_fixture.scope.mutation_stages.publish
    original_apply_forward = uow_fixture.executor.apply_forward

    async def create_intent(journal, *args, **kwargs):
        result = await original_create_intent(journal, *args, **kwargs)
        observed.append("INTENT-committed")
        return result

    async def publish(*args, **kwargs):
        result = await original_publish(*args, **kwargs)
        observed.append("stage-published")
        return result

    async def mark_staged(journal, *args, **kwargs):
        result = await original_mark_staged(journal, *args, **kwargs)
        observed.append("STAGED-committed")
        return result

    async def commit_business(uow, *args, **kwargs):
        result = await original_commit_business(uow, *args, **kwargs)
        observed.append("business-and-DB_COMMITTED-committed")
        return result

    async def mark_finalizing(journal, *args, **kwargs):
        result = await original_mark_finalizing(journal, *args, **kwargs)
        observed.append("FINALIZING-committed")
        return result

    async def apply_forward(
        scope, operation_id, command, receipt, *, ordinals=None
    ):
        result = await original_apply_forward(
            scope,
            operation_id,
            command,
            receipt,
            ordinals=ordinals,
        )
        selected = (
            tuple(range(len(command.projections)))
            if ordinals is None
            else tuple(ordinals)
        )
        observed.extend(
            f"projection:{command.projections[ordinal].tag.value}"
            for ordinal in selected
        )
        return result

    async def transition(journal, operation_id, target):
        result = await original_transition(journal, operation_id, target)
        if target is MutationState.FORWARD_APPLIED:
            observed.append("FORWARD_APPLIED-committed")
        return result

    async def finalize(journal, *args, **kwargs):
        result = await original_finalize(journal, *args, **kwargs)
        observed.append("FINALIZED-and-ledger-visible-committed")
        return result

    monkeypatch.setattr(MutationJournal, "create_batch_intent", create_intent)
    monkeypatch.setattr(uow_fixture.scope.mutation_stages, "publish", publish)
    monkeypatch.setattr(MutationJournal, "mark_staged", mark_staged)
    monkeypatch.setattr(MutationUnitOfWork, "_commit_business", commit_business)
    monkeypatch.setattr(MutationJournal, "mark_finalizing", mark_finalizing)
    monkeypatch.setattr(uow_fixture.executor, "apply_forward", apply_forward)
    monkeypatch.setattr(MutationJournal, "transition", transition)
    monkeypatch.setattr(MutationJournal, "finalize_batch", finalize)

    result = await uow_fixture.uow.execute(
        uow_fixture.scope, _request("ordered"), "ordered-operation"
    )

    assert result.state is MutationState.FINALIZED
    assert observed == [
        "INTENT-committed",
        "stage-published",
        "STAGED-committed",
        "business-and-DB_COMMITTED-committed",
        "FINALIZING-committed",
        "projection:markdown_write",
        "projection:path_rename",
        "projection:path_remove",
        "projection:index_replace",
        "projection:fts_replace",
        "FORWARD_APPLIED-committed",
        "FINALIZED-and-ledger-visible-committed",
    ]


@pytest.mark.asyncio
async def test_operation_binding_conflict_happens_before_compilation(uow_fixture) -> None:
    await uow_fixture.uow.execute_batch(
        uow_fixture.scope, (_request("n1"),), "batch-a", operation_ids=("shared-op",)
    )
    compiler_calls = uow_fixture.compiler.calls
    with pytest.raises(IdempotencyConflictError):
        await uow_fixture.uow.execute_batch(
            uow_fixture.scope, (_request("n1", "different"),), "batch-b", operation_ids=("shared-op",)
        )
    assert uow_fixture.compiler.calls == compiler_calls
    async with uow_fixture.sessions() as session:
        assert await session.get(MutationBatch, "batch-b") is None


@pytest.mark.asyncio
async def test_dirty_recovery_gate_raises_canonical_error_before_batch_read(uow_fixture) -> None:
    uow = MutationUnitOfWork(
        catalog=_Catalog(),
        compiler=uow_fixture.compiler,
        interpreter=_Interpreter(),
        projection_executor=uow_fixture.executor,
        recovery_gate=_DirtyGate(),
        journal_factory=MutationJournal,
    )
    with pytest.raises(SpaceRecoveryRequiredError) as captured:
        await uow.execute(uow_fixture.scope, _request("n1"), "op-dirty")
    assert captured.value.code == "space_recovery_required"
    assert uow_fixture.compiler.calls == 0
    async with uow_fixture.sessions() as session:
        assert await session.scalar(select(func.count()).select_from(MutationBatch)) == 0


@pytest.mark.asyncio
async def test_projection_executor_asserts_fence_immediately_before_each_destructive_action() -> None:
    class _Executor(FileSystemProjectionExecutor):
        def __init__(self) -> None:
            self.observed: list[str] = []

        def _apply_markdown_write(self, scope, action, receipt) -> None:
            self.observed.append("markdown_write")

        def _apply_path_rename(self, scope, action, receipt) -> None:
            self.observed.append("path_rename")

        def _apply_path_remove(self, scope, action, receipt) -> None:
            self.observed.append("path_remove")

        def _apply_index_replace(self, scope, action, receipt) -> None:
            self.observed.append("index_replace")

        def _apply_fts_replace(self, scope, action, receipt) -> None:
            self.observed.append("fts_replace")

    executor = _Executor()
    receipt = _FenceReceipt(current=False)
    actions = (
        _materialized_action("markdown_write", "notes/n.md", 0, b"body"),
        _materialized_action(
            "path_rename",
            "notes/new.md",
            1,
            None,
            source="notes/old.md",
        ),
        _materialized_action("path_remove", "notes/deleted.md", 2, None),
        _materialized_action("index_replace", "rows/n.json", 3, b"index"),
        _materialized_action("fts_replace", "fts/n.json", 4, b"fts"),
    )
    for action in actions:
        with pytest.raises(RuntimeError, match="stale fence"):
            executor._apply_one_contained_action(object(), action, receipt)
        assert executor.observed == []


class _RecordingProjectionExecutor(FileSystemProjectionExecutor):
    def __init__(self) -> None:
        self.actions: list[tuple[str, str, bytes | None]] = []

    def _record(self, action) -> None:
        self.actions.append((action.tag.value, str(action.target), action.blob))

    def _apply_markdown_write(self, scope, action, receipt) -> None:
        self._record(action)

    def _apply_path_rename(self, scope, action, receipt) -> None:
        self._record(action)

    def _apply_path_remove(self, scope, action, receipt) -> None:
        self._record(action)

    def _apply_index_replace(self, scope, action, receipt) -> None:
        self._record(action)

    def _apply_fts_replace(self, scope, action, receipt) -> None:
        self._record(action)


def _all_projection_plans() -> tuple[object, ...]:
    return (
        _projection_plan("markdown_write", "notes/n.md", 0, None, b"body"),
        _projection_plan(
            "path_rename",
            "notes/new.md",
            1,
            b"body",
            b"body",
            source="notes/old.md",
        ),
        _projection_plan("path_remove", "notes/deleted.md", 2, b"deleted", None),
        _projection_plan("index_replace", "rows/n.json", 3, None, b"index"),
        _projection_plan("fts_replace", "fts/n.json", 4, b"old-fts", b"fts"),
    )


def test_storage_base_owns_all_contained_projection_primitives() -> None:
    for name in (
        "_apply_projection_markdown_write",
        "_apply_projection_path_rename",
        "_apply_projection_path_remove",
        "_apply_projection_index_replace",
        "_apply_projection_fts_replace",
    ):
        assert callable(getattr(StorageBase, name, None)), name


@pytest.mark.asyncio
async def test_production_projection_executor_applies_all_tags_through_contained_authorities(
    tmp_path,
) -> None:
    from app.file_system.api import open_contained_file_system
    from app.runtime.contained_io import open_bound_space
    from app.runtime.scope import _walk_existing_ancestors

    root = tmp_path / "contained-space"
    notes = root / "notes"
    notes.mkdir(parents=True)
    (root / "space.db").touch()
    (root / "index.db").touch()
    paths = SimpleNamespace(
        space_root=root.parent,
        db_path=root / "space.db",
        notes_dir=notes,
        index_db=root / "index.db",
    )
    opens = open_bound_space(paths, _walk_existing_ancestors(paths))
    file_system = await open_contained_file_system(opens)
    stages = StageStore(opens.take_mutation_stage_authority())
    coordinator = RuntimeLeaseCoordinator(tmp_path / ".runtime-production-projection")
    global_lease = await coordinator.acquire_global(LeaseMode.SHARED, "test", 2)
    space_lease = await coordinator.acquire_spaces(
        ["space-production"], LeaseMode.EXCLUSIVE, "projection", 2
    )
    try:
        await file_system.create_note(
            title="Original",
            content="old body",
            external_id="n-production",
        )
        def canonical(value):
            return json.dumps(
                value, ensure_ascii=True, sort_keys=True, separators=(",", ":")
            ).encode("ascii")
        folder_row = {
            "color": None,
            "created_at": "2026-07-20T00:00:00Z",
            "icon": "folder",
            "id": "f-production",
            "is_system": False,
            "name": "Projected",
            "parent_id": None,
            "sort_order": 0,
            "trashed_at": None,
            "updated_at": "2026-07-20T00:00:00Z",
        }
        plans = (
            _projection_plan(
                "markdown_write", "notes/projected.md", 0, None, b"projected body"
            ),
            _projection_plan(
                "path_rename",
                "notes/renamed.md",
                1,
                b"projected body",
                b"projected body",
                source="notes/projected.md",
            ),
            _projection_plan(
                "path_remove", "notes/renamed.md", 2, b"projected body", None
            ),
            _projection_plan(
                "index_replace",
                "index/folders/id/f-production",
                3,
                None,
                canonical({"row": folder_row}),
            ),
            _projection_plan(
                "fts_replace",
                "fts/n-production",
                4,
                (await file_system.snapshot_projection_authority()).fts[
                    "fts/n-production"
                ],
                canonical({"content": "fresh searchable term", "title": "Original"}),
            ),
        )
        scope = SimpleNamespace(
            mutation_stages=stages,
            file_system=file_system,
        )
        command = MutationCommand.from_effects(
            request=_request("n-production"),
            db_plans=(),
            projections=plans,
            sync_events=(),
            result_value={"id": "n-production"},
        )
        manifest = await stages.publish(
            "production-projection",
            plans,
            lease=space_lease,
            space_id="space-production",
        )
        assert tuple(step.descriptor for step in manifest.steps) == command.persisted().projections

        receipt = space_lease.fence_receipt("space-production")
        await FileSystemProjectionExecutor().apply_forward(
            scope, "production-projection", command.persisted(), receipt
        )

        folder = await file_system.get_folder("f-production")
        search = await file_system.search("fresh searchable term")
        assert folder.name == "Projected"
        assert [item.note_id for item in search] == ["n-production"]
        assert file_system._file_exists("notes/projected.md") is False
        assert file_system._file_exists("notes/renamed.md") is False
    finally:
        stages.close()
        await file_system.close()
        await space_lease.release()
        await global_lease.release()


@pytest.mark.asyncio
async def test_production_note_policy_executes_db_markdown_index_fts_and_ledger(
    uow_fixture, tmp_path
) -> None:
    from app.file_system.api import open_contained_file_system
    from app.runtime.contained_io import open_bound_space
    from app.runtime.scope import _walk_existing_ancestors

    root = tmp_path / "production-note-uow"
    notes = root / "notes"
    notes.mkdir(parents=True)
    (root / "space.db").touch()
    (root / "index.db").touch()
    paths = SimpleNamespace(
        space_root=root.parent,
        db_path=root / "space.db",
        notes_dir=notes,
        index_db=root / "index.db",
    )
    opens = open_bound_space(paths, _walk_existing_ancestors(paths))
    file_system = await open_contained_file_system(opens)
    stages = StageStore(opens.take_mutation_stage_authority())
    coordinator = RuntimeLeaseCoordinator(tmp_path / ".runtime-production-note-uow")
    global_lease = await coordinator.acquire_global(LeaseMode.SHARED, "test", 2)
    space_id = "space-production-note-uow"
    space_lease = await coordinator.acquire_spaces(
        [space_id], LeaseMode.EXCLUSIVE, "mutation", 2
    )

    class RuntimeScope:
        session_factory = uow_fixture.sessions
        scope = SimpleNamespace(space_id=space_id)
        mutation_stages = stages

        def __init__(self) -> None:
            self.file_system = file_system

        @asynccontextmanager
        async def exclusive_space_resources(self, purpose, timeout_seconds):
            assert (purpose, timeout_seconds) == ("mutation", 5)
            yield space_lease

    body = b"compiled body"
    note_id = "n-compiled-production"

    class NotePolicy:
        entity_types = frozenset({"note"})

        async def compile(self, context, request):
            base = await compile_catalog_entity_command(context, request)
            return _with_projection(
                base,
                projections=_note_create_projections(
                    base,
                    body,
                    path=f"notes/{note_id}-compiled.md",
                ),
            )

    request = MutationRequest.from_payload(
        name="entity.create",
        entity_type="note",
        entity_id=note_id,
        payload={
            "content_hash": hashlib.sha256(body).hexdigest(),
            "title": "Compiled",
            "word_count": 2,
        },
        expected_version=None,
    )
    uow = MutationUnitOfWork(
        catalog=CATALOG,
        compiler=MutationCompiler(CATALOG, (NotePolicy(),)),
        interpreter=DbMutationInterpreter(CATALOG),
        projection_executor=FileSystemProjectionExecutor(),
        recovery_gate=_CleanGate(),
        journal_factory=MutationJournal,
    )
    try:
        result = await uow.execute(RuntimeScope(), request, "production-note-operation")
        async with uow_fixture.sessions() as session:
            stored = await session.get(Note, note_id)
            event = await session.scalar(
                select(SyncOutbox).where(
                    SyncOutbox.operation_id == "production-note-operation"
                )
            )

        assert result.state is MutationState.FINALIZED
        assert stored is not None and stored.content_hash == hashlib.sha256(body).hexdigest()
        assert await file_system.read_note(note_id) == body.decode("utf-8")
        assert [item.note_id for item in await file_system.search("compiled body")] == [
            note_id
        ]
        assert event is not None and event.visible is True
        assert json.loads(event.payload) == {
            **{field: getattr(stored, field) for field in CATALOG.get("note").field_names},
            "content": body.decode("utf-8"),
        }
    finally:
        stages.close()
        await file_system.close()
        await space_lease.release()
        await global_lease.release()
        await opens.close_all()


@pytest.mark.asyncio
async def test_authority_overlay_loads_existing_index_and_fts_authority(
    uow_fixture, tmp_path
) -> None:
    from app.file_system.api import open_contained_file_system
    from app.runtime.contained_io import open_bound_space
    from app.runtime.scope import _walk_existing_ancestors

    root = tmp_path / "overlay-contained-space"
    notes = root / "notes"
    notes.mkdir(parents=True)
    (root / "space.db").touch()
    (root / "index.db").touch()
    paths = SimpleNamespace(
        space_root=root.parent,
        db_path=root / "space.db",
        notes_dir=notes,
        index_db=root / "index.db",
    )
    opens = open_bound_space(paths, _walk_existing_ancestors(paths))
    file_system = await open_contained_file_system(opens)
    try:
        await file_system.create_folder(
            "Existing", external_id="f-existing"
        )
        await file_system.create_note(
            title="Existing note",
            content="existing searchable body",
            folder_id="f-existing",
            external_id="n-existing",
        )
        scope = SimpleNamespace(file_system=file_system)
        async with uow_fixture.sessions() as session:
            overlay = await AuthorityOverlay.from_locked_authorities(
                scope, session, CATALOG
            )
        tag_type = _projection_api()[2]

        index_blob = overlay.derived_projection(
            tag_type.INDEX_REPLACE, "index/folders/id/f-existing"
        )
        fts_blob = overlay.derived_projection(
            tag_type.FTS_REPLACE, "fts/n-existing"
        )
        assert index_blob is not None
        assert json.loads(index_blob)["row"]["name"] == "Existing"
        assert fts_blob is not None
        assert json.loads(fts_blob) == {
            "content": "existing searchable body",
            "title": "Existing note",
        }
    finally:
        await file_system.close()
        await opens.close_all()


@pytest.mark.asyncio
async def test_fts_projection_rechecks_fence_between_delete_and_insert(
    tmp_path, monkeypatch
) -> None:
    from app.file_system.api import open_contained_file_system
    from app.runtime.contained_io import open_bound_space
    from app.runtime.scope import _walk_existing_ancestors

    class StaleAfterFirstWrite:
        def __init__(self) -> None:
            self.checks = 0

        def assert_current(self) -> None:
            self.checks += 1
            if self.checks == 2:
                raise RuntimeError("stale between FTS writes")

    root = tmp_path / "fts-fence-space"
    notes = root / "notes"
    notes.mkdir(parents=True)
    (root / "space.db").touch()
    (root / "index.db").touch()
    paths = SimpleNamespace(
        space_root=root.parent,
        db_path=root / "space.db",
        notes_dir=notes,
        index_db=root / "index.db",
    )
    opens = open_bound_space(paths, _walk_existing_ancestors(paths))
    file_system = await open_contained_file_system(opens)
    try:
        await file_system.create_note(
            title="Fence",
            content="original searchable phrase",
            external_id="n-fence",
        )
        action = _materialized_action(
            "fts_replace",
            "fts/n-fence",
            0,
            json.dumps(
                {"content": "replacement phrase", "title": "Fence"},
                ensure_ascii=True,
                sort_keys=True,
                separators=(",", ":"),
            ).encode("ascii"),
        )
        receipt = StaleAfterFirstWrite()
        executed_sql: list[str] = []
        original_connect = file_system._connect

        class RecordingConnection:
            def __init__(self, connection) -> None:
                self.connection = connection

            def execute(self, statement, *args, **kwargs):
                executed_sql.append(statement)
                return self.connection.execute(statement, *args, **kwargs)

            def commit(self) -> None:
                self.connection.commit()

        from contextlib import contextmanager

        @contextmanager
        def recording_connect():
            with original_connect() as connection:
                yield RecordingConnection(connection)

        monkeypatch.setattr(file_system, "_connect", recording_connect)

        with pytest.raises(RuntimeError, match="stale between FTS writes"):
            file_system._apply_projection_fts_replace(action, receipt)

        assert receipt.checks == 2
        assert not any(
            statement.lstrip().startswith("INSERT INTO notes_fts")
            for statement in executed_sql
        )
        assert [item.note_id for item in await file_system.search("original searchable phrase")] == [
            "n-fence"
        ]
        assert await file_system.search("replacement phrase") == []
    finally:
        await file_system.close()
        await opens.close_all()


@pytest.mark.asyncio
async def test_uow_nonempty_projection_stages_materialize_all_closed_tags(
    uow_fixture, tmp_path
) -> None:
    stage_store = StageStore(_stage_authority(tmp_path / "stages"))
    uow_fixture.scope.mutation_stages = stage_store
    uow_fixture.compiler.projections = _all_projection_plans()
    executor = _RecordingProjectionExecutor()
    uow = MutationUnitOfWork(
        catalog=_Catalog(),
        compiler=uow_fixture.compiler,
        interpreter=_Interpreter(),
        projection_executor=executor,
        recovery_gate=_CleanGate(),
        journal_factory=MutationJournal,
    )
    try:
        result = await uow.execute(uow_fixture.scope, _request("n-projected"), "op-projected")

        assert result.state is MutationState.FINALIZED
        assert executor.actions == [
            ("markdown_write", "notes/n.md", b"body"),
            ("path_rename", "notes/new.md", b"body"),
            ("path_remove", "notes/deleted.md", None),
            ("index_replace", "rows/n.json", b"index"),
            ("fts_replace", "fts/n.json", b"fts"),
        ]
    finally:
        stage_store.close()


@pytest.mark.asyncio
async def test_stale_projection_fence_performs_zero_actions(
    uow_fixture, tmp_path
) -> None:
    class _StalingStageStore(StageStore):
        async def materialize_side(
            self, operation_id, descriptors, *, image, ordinals, receipt
        ):
            actions = await super().materialize_side(
                operation_id,
                descriptors,
                image=image,
                ordinals=ordinals,
                receipt=receipt,
            )
            receipt.current = False
            return actions

    stage_store = _StalingStageStore(_stage_authority(tmp_path / "stale-stages"))
    uow_fixture.scope.mutation_stages = stage_store
    uow_fixture.compiler.projections = _all_projection_plans()
    executor = _RecordingProjectionExecutor()
    uow = MutationUnitOfWork(
        catalog=_Catalog(),
        compiler=uow_fixture.compiler,
        interpreter=_Interpreter(),
        projection_executor=executor,
        recovery_gate=_CleanGate(),
        journal_factory=MutationJournal,
    )
    try:
        with pytest.raises(RuntimeError, match="stale fence"):
            await uow.execute(uow_fixture.scope, _request("n-stale"), "op-stale")

        assert executor.actions == []
        async with uow_fixture.sessions() as session:
            visible = await session.scalar(
                select(func.count())
                .select_from(SyncOutbox)
                .where(SyncOutbox.operation_id == "op-stale", SyncOutbox.visible.is_(True))
            )
        assert visible == 0
    finally:
        stage_store.close()

@pytest.mark.asyncio
async def test_note_purge_cascades_to_versions_paths_and_links(
    uow_fixture, tmp_path,
) -> None:
    """Note purge must delete the ORM row and produce exactly one visible
    delete event.  Child table cascade-delete (note_versions, note_paths,
    note_links) is handled defensively in the INDEX_REPLACE handler for
    the file system's SQLite index DB."""
    from sqlalchemy import select

    from app.commands import EntityCommand, FolderDomainPolicy, RelationDomainPolicy
    from app.file_system.api import get_file_system
    from app.knowledge.commands import KnowledgeCommands
    from app.knowledge.projections import KnowledgeDomainPolicy
    from app.knowledge.store import KnowledgeStore
    from app.models.note import Note
    from app.models.sync_outbox import SyncOutbox
    from app.mutation.types import MutationState
    from tests.test_mutation_recovery import _Lease as RecoveryLease

    file_system = await get_file_system(
        root_dir=tmp_path / "cascade-files",
        index_db=tmp_path / "cascade-index.db",
    )
    stage_store = StageStore(_stage_authority(tmp_path / "cascade-stages"))
    scope = _Scope(uow_fixture.sessions, uow_fixture.receipt)
    scope.file_system = file_system
    scope.mutation_stages = stage_store
    scope.global_lease = RecoveryLease(LeaseMode.SHARED, "global")
    scope.space_lease = RecoveryLease(LeaseMode.EXCLUSIVE, "space-test")

    @asynccontextmanager
    async def exclusive_space_resources(purpose, timeout_seconds):
        yield scope.space_lease

    scope.exclusive_space_resources = exclusive_space_resources

    executor = FileSystemProjectionExecutor()
    compiler = MutationCompiler(
        CATALOG,
        [FolderDomainPolicy(), RelationDomainPolicy(), KnowledgeDomainPolicy()],
    )
    interpreter = DbMutationInterpreter(CATALOG)
    uow = MutationUnitOfWork(
        catalog=CATALOG,
        compiler=compiler,
        interpreter=interpreter,
        projection_executor=executor,
        recovery_gate=MutationRecovery(
            catalog=CATALOG,
            interpreter=interpreter,
            projection_executor=executor,
        ),
        journal_factory=MutationJournal,
    )
    store = KnowledgeStore(
        commands=KnowledgeCommands(),
        entity_commands=EntityCommand(CATALOG),
        uow=uow,
    )

    try:
        # Create a note with content
        await store.create_note(
            scope,
            {"id": "n-cascade", "title": "Cascade", "content": "v1 body"},
            expected_version=None,
            operation_id="create-n-cascade",
        )
        # Update content to create a version-like change
        await store.update_note(
            scope,
            "n-cascade",
            {"content": "v2 body"},
            expected_version=1,
            operation_id="update-n-cascade",
        )
        # Trash it
        await store.update_note(
            scope,
            "n-cascade",
            {"trashed_at": "2026-01-01T00:00:00+00:00"},
            expected_version=2,
            operation_id="trash-n-cascade",
        )

        # Purge
        result = await store.purge_note(
            scope,
            "n-cascade",
            expected_version=3,
            operation_id="purge-n-cascade",
        )
        assert result.state is MutationState.FINALIZED

        # Verify ORM row deleted
        async with uow_fixture.sessions() as session:
            note = await session.get(Note, "n-cascade")
            assert note is None, "ORM Note row should be deleted"

            # Verify only one delete event
            all_delete = (
                await session.execute(
                    select(SyncOutbox).where(
                        SyncOutbox.entity_type == "note",
                        SyncOutbox.entity_id == "n-cascade",
                        SyncOutbox.action == "delete",
                    )
                )
            ).scalars().all()
            assert len(all_delete) == 1, "exactly one delete event total"
            assert all_delete[0].visible is True, "delete event should be visible"
    finally:
        stage_store.close()
        await file_system.close()


@pytest.mark.asyncio
async def test_note_purge_retry_is_idempotent(
    uow_fixture, tmp_path,
) -> None:
    """Retrying note purge with the same operation_id must not produce
    duplicate delete events or resurrection."""
    from sqlalchemy import func, select

    from app.commands import EntityCommand, FolderDomainPolicy, RelationDomainPolicy
    from app.file_system.api import get_file_system
    from app.knowledge.commands import KnowledgeCommands
    from app.knowledge.projections import KnowledgeDomainPolicy
    from app.knowledge.store import KnowledgeStore
    from app.models.note import Note
    from app.models.sync_outbox import SyncOutbox
    from app.mutation.types import MutationState
    from tests.test_mutation_recovery import _Lease as RecoveryLease

    file_system = await get_file_system(
        root_dir=tmp_path / "retry-files",
        index_db=tmp_path / "retry-index.db",
    )
    stage_store = StageStore(_stage_authority(tmp_path / "retry-stages"))
    scope = _Scope(uow_fixture.sessions, uow_fixture.receipt)
    scope.file_system = file_system
    scope.mutation_stages = stage_store
    scope.global_lease = RecoveryLease(LeaseMode.SHARED, "global")
    scope.space_lease = RecoveryLease(LeaseMode.EXCLUSIVE, "space-test")

    @asynccontextmanager
    async def exclusive_space_resources(purpose, timeout_seconds):
        yield scope.space_lease

    scope.exclusive_space_resources = exclusive_space_resources

    executor = FileSystemProjectionExecutor()
    compiler = MutationCompiler(
        CATALOG,
        [FolderDomainPolicy(), RelationDomainPolicy(), KnowledgeDomainPolicy()],
    )
    interpreter = DbMutationInterpreter(CATALOG)
    uow = MutationUnitOfWork(
        catalog=CATALOG,
        compiler=compiler,
        interpreter=interpreter,
        projection_executor=executor,
        recovery_gate=MutationRecovery(
            catalog=CATALOG,
            interpreter=interpreter,
            projection_executor=executor,
        ),
        journal_factory=MutationJournal,
    )
    store = KnowledgeStore(
        commands=KnowledgeCommands(),
        entity_commands=EntityCommand(CATALOG),
        uow=uow,
    )

    try:
        await store.create_note(
            scope,
            {"id": "n-retry", "title": "Retry", "content": "body"},
            expected_version=None,
            operation_id="create-n-retry",
        )
        await store.update_note(
            scope,
            "n-retry",
            {"trashed_at": "2026-01-01T00:00:00+00:00"},
            expected_version=1,
            operation_id="trash-n-retry",
        )

        # First purge
        first = await store.purge_note(
            scope, "n-retry", expected_version=2,
            operation_id="purge-n-retry",
        )
        assert first.state is MutationState.FINALIZED

        # Retry with same operation_id — should be idempotent
        second = await store.purge_note(
            scope, "n-retry", expected_version=2,
            operation_id="purge-n-retry",
        )
        assert second.state is MutationState.FINALIZED

        # No duplicate delete events
        async with uow_fixture.sessions() as session:
            count = await session.scalar(
                select(func.count())
                .select_from(SyncOutbox)
                .where(
                    SyncOutbox.entity_type == "note",
                    SyncOutbox.entity_id == "n-retry",
                    SyncOutbox.action == "delete",
                )
            )
            assert count == 1, f"expected 1 delete event, got {count}"

            # Note still doesn't exist
            note = await session.get(Note, "n-retry")
            assert note is None, "Note should not be resurrected by retry"
    finally:
        stage_store.close()
        await file_system.close()


@pytest.mark.asyncio
async def test_folder_purge_multi_layer_tree_and_retry(
    uow_fixture, tmp_path,
) -> None:
    """Folder purge on a 3-level tree: root -> child -> grandchild -> great.
    All must be deleted deepest-first in one batch.  Retry after success
    is NOT idempotent (tree is gone), so we only verify the first call
    succeeds and the tree is fully deleted."""
    from sqlalchemy import select

    from app.commands import EntityCommand, FolderDomainPolicy, RelationDomainPolicy
    from app.file_system.api import get_file_system
    from app.knowledge.commands import KnowledgeCommands
    from app.knowledge.projections import KnowledgeDomainPolicy
    from app.knowledge.store import KnowledgeStore
    from app.models.folder import Folder
    from app.models.sync_outbox import SyncOutbox
    from app.mutation.types import MutationState
    from tests.test_mutation_recovery import _Lease as RecoveryLease

    file_system = await get_file_system(
        root_dir=tmp_path / "multi-files",
        index_db=tmp_path / "multi-index.db",
    )
    stage_store = StageStore(_stage_authority(tmp_path / "multi-stages"))
    scope = _Scope(uow_fixture.sessions, uow_fixture.receipt)
    scope.file_system = file_system
    scope.mutation_stages = stage_store
    scope.global_lease = RecoveryLease(LeaseMode.SHARED, "global")
    scope.space_lease = RecoveryLease(LeaseMode.EXCLUSIVE, "space-test")

    @asynccontextmanager
    async def exclusive_space_resources(purpose, timeout_seconds):
        yield scope.space_lease

    scope.exclusive_space_resources = exclusive_space_resources

    executor = FileSystemProjectionExecutor()
    compiler = MutationCompiler(
        CATALOG,
        [FolderDomainPolicy(), RelationDomainPolicy(), KnowledgeDomainPolicy()],
    )
    interpreter = DbMutationInterpreter(CATALOG)
    uow = MutationUnitOfWork(
        catalog=CATALOG,
        compiler=compiler,
        interpreter=interpreter,
        projection_executor=executor,
        recovery_gate=MutationRecovery(
            catalog=CATALOG,
            interpreter=interpreter,
            projection_executor=executor,
        ),
        journal_factory=MutationJournal,
    )
    store = KnowledgeStore(
        commands=KnowledgeCommands(),
        entity_commands=EntityCommand(CATALOG),
        uow=uow,
    )

    try:
        # Create 4-level tree: L0 -> L1 -> L2 -> L3
        for fid, pid in (
            ("f0", None), ("f1", "f0"), ("f2", "f1"), ("f3", "f2"),
        ):
            await store.create_folder(
                scope,
                {"id": fid, "name": f"Folder-{fid}", "parent_id": pid},
                expected_version=None,
                operation_id=f"create-{fid}",
            )

        # Trash the root (cascade soft-deletes all descendants)
        await store.update_folder(
            scope, "f0",
            {"trashed_at": "2026-01-01T00:00:00+00:00"},
            expected_version=1,
            operation_id="trash-f0",
        )

        # Purge — should hard-delete all 4 folders in one batch
        result = await store.purge_folder(
            scope, "f0", expected_version=2,
            operation_id="purge-f0",
        )
        assert all(r.state is MutationState.FINALIZED for r in result.applied)

        # All 4 folders deleted
        async with uow_fixture.sessions() as session:
            for fid in ("f0", "f1", "f2", "f3"):
                folder = await session.get(Folder, fid)
                assert folder is None, f"folder {fid} should be deleted"

            # 4 visible delete events (one per folder)
            delete_events = (
                await session.execute(
                    select(SyncOutbox).where(
                        SyncOutbox.entity_type == "folder",
                        SyncOutbox.entity_id.in_(("f0", "f1", "f2", "f3")),
                        SyncOutbox.action == "delete",
                        SyncOutbox.visible.is_(True),
                    )
                )
            ).scalars().all()
            assert len(delete_events) == 4, (
                f"expected 4 visible delete events, got {len(delete_events)}"
            )

        # All folder index entries removed
        snapshot = await file_system.snapshot_projection_authority()
        for fid in ("f0", "f1", "f2", "f3"):
            assert all(
                fid not in key for key in snapshot.index
            ), f"folder index for {fid} should be removed"

        # NOTE: Folder purge retry after success is NOT idempotent because
        # the descendant tree changes (all folders deleted).  Crash recovery
        # is handled by the UoW's recovery mechanism, not by re-calling
        # purge_folder.
    finally:
        stage_store.close()
        await file_system.close()


@pytest.mark.asyncio
async def test_quick_note_conversion_zero_comments(
    uow_fixture, tmp_path,
) -> None:
    """QuickNote conversion with zero MemoComments must still create the
    Note and archive the QuickNote successfully."""
    import hashlib

    from sqlalchemy import select

    from app.commands import EntityCommand, FolderDomainPolicy, RelationDomainPolicy
    from app.file_system.api import get_file_system
    from app.knowledge.commands import KnowledgeCommands
    from app.knowledge.projections import KnowledgeDomainPolicy
    from app.knowledge.store import KnowledgeStore
    from app.models.memo_comment import MemoComment
    from app.models.note import Note
    from app.models.quick_note import QuickNote
    from app.mutation.types import MutationState
    from tests.test_mutation_recovery import _Lease as RecoveryLease

    file_system = await get_file_system(
        root_dir=tmp_path / "zero-files",
        index_db=tmp_path / "zero-index.db",
    )
    stage_store = StageStore(_stage_authority(tmp_path / "zero-stages"))
    scope = _Scope(uow_fixture.sessions, uow_fixture.receipt)
    scope.file_system = file_system
    scope.mutation_stages = stage_store
    scope.global_lease = RecoveryLease(LeaseMode.SHARED, "global")
    scope.space_lease = RecoveryLease(LeaseMode.EXCLUSIVE, "space-test")

    @asynccontextmanager
    async def exclusive_space_resources(purpose, timeout_seconds):
        yield scope.space_lease

    scope.exclusive_space_resources = exclusive_space_resources

    executor = FileSystemProjectionExecutor()
    compiler = MutationCompiler(
        CATALOG,
        [FolderDomainPolicy(), RelationDomainPolicy(), KnowledgeDomainPolicy()],
    )
    interpreter = DbMutationInterpreter(CATALOG)
    uow = MutationUnitOfWork(
        catalog=CATALOG,
        compiler=compiler,
        interpreter=interpreter,
        projection_executor=executor,
        recovery_gate=MutationRecovery(
            catalog=CATALOG,
            interpreter=interpreter,
            projection_executor=executor,
        ),
        journal_factory=MutationJournal,
    )
    store = KnowledgeStore(
        commands=KnowledgeCommands(),
        entity_commands=EntityCommand(CATALOG),
        uow=uow,
    )

    try:
        # Create a QuickNote with no comments
        create_qn_req = store.entity_commands.create(
            scope, "quick_note",
            {"id": "qn-zero", "content": "No comments here", "tags": "[]"},
            expected_version=None,
        )
        await store.uow.execute(scope, create_qn_req, "create-qn-zero")

        # Convert
        result = await store.convert_quick_note(
            scope, "qn-zero", expected_version=1,
            operation_id="convert-qn-zero",
        )
        assert all(r.state is MutationState.FINALIZED for r in result.applied)

        expected_note_id = hashlib.sha256(
            "convert-qn-zero\0note".encode("ascii")
        ).hexdigest()[:32]

        async with uow_fixture.sessions() as session:
            # Note created
            note = await session.get(Note, expected_note_id)
            assert note is not None, "converted Note should exist"

            # QuickNote archived
            qn = await session.get(QuickNote, "qn-zero")
            assert qn is not None
            assert qn.archived_at is not None
            assert qn.migrated_to_note_id == expected_note_id

            # Zero copied comments
            comments = (
                await session.execute(
                    select(MemoComment).where(
                        MemoComment.note_id == expected_note_id
                    )
                )
            ).scalars().all()
            assert len(comments) == 0, "should have zero comments"
    finally:
        stage_store.close()
        await file_system.close()


@pytest.mark.asyncio
async def test_quick_note_conversion_one_comment(
    uow_fixture, tmp_path,
) -> None:
    """QuickNote conversion with exactly one MemoComment."""
    import hashlib

    from sqlalchemy import select

    from app.commands import EntityCommand, FolderDomainPolicy, RelationDomainPolicy
    from app.file_system.api import get_file_system
    from app.knowledge.commands import KnowledgeCommands
    from app.knowledge.projections import KnowledgeDomainPolicy
    from app.knowledge.store import KnowledgeStore
    from app.models.memo_comment import MemoComment
    from app.models.note import Note
    from app.mutation.types import MutationState
    from tests.test_mutation_recovery import _Lease as RecoveryLease

    file_system = await get_file_system(
        root_dir=tmp_path / "one-files",
        index_db=tmp_path / "one-index.db",
    )
    stage_store = StageStore(_stage_authority(tmp_path / "one-stages"))
    scope = _Scope(uow_fixture.sessions, uow_fixture.receipt)
    scope.file_system = file_system
    scope.mutation_stages = stage_store
    scope.global_lease = RecoveryLease(LeaseMode.SHARED, "global")
    scope.space_lease = RecoveryLease(LeaseMode.EXCLUSIVE, "space-test")

    @asynccontextmanager
    async def exclusive_space_resources(purpose, timeout_seconds):
        yield scope.space_lease

    scope.exclusive_space_resources = exclusive_space_resources

    executor = FileSystemProjectionExecutor()
    compiler = MutationCompiler(
        CATALOG,
        [FolderDomainPolicy(), RelationDomainPolicy(), KnowledgeDomainPolicy()],
    )
    interpreter = DbMutationInterpreter(CATALOG)
    uow = MutationUnitOfWork(
        catalog=CATALOG,
        compiler=compiler,
        interpreter=interpreter,
        projection_executor=executor,
        recovery_gate=MutationRecovery(
            catalog=CATALOG,
            interpreter=interpreter,
            projection_executor=executor,
        ),
        journal_factory=MutationJournal,
    )
    store = KnowledgeStore(
        commands=KnowledgeCommands(),
        entity_commands=EntityCommand(CATALOG),
        uow=uow,
    )

    try:
        # Create QuickNote + 1 comment
        create_qn_req = store.entity_commands.create(
            scope, "quick_note",
            {"id": "qn-one", "content": "One comment", "tags": "[]"},
            expected_version=None,
        )
        await store.uow.execute(scope, create_qn_req, "create-qn-one")

        create_c_req = store.entity_commands.create(
            scope, "memo_comment",
            {"id": "src-c1", "note_id": "qn-one", "content": "Only comment"},
            expected_version=None,
        )
        await store.uow.execute(scope, create_c_req, "create-c1")

        # Convert
        result = await store.convert_quick_note(
            scope, "qn-one", expected_version=1,
            operation_id="convert-qn-one",
        )
        assert all(r.state is MutationState.FINALIZED for r in result.applied)

        expected_note_id = hashlib.sha256(
            "convert-qn-one\0note".encode("ascii")
        ).hexdigest()[:32]
        expected_c1 = hashlib.sha256(
            "convert-qn-one\0memo_comment\0src-c1".encode("ascii")
        ).hexdigest()[:32]

        async with uow_fixture.sessions() as session:
            note = await session.get(Note, expected_note_id)
            assert note is not None

            comments = (
                await session.execute(
                    select(MemoComment).where(
                        MemoComment.note_id == expected_note_id
                    )
                )
            ).scalars().all()
            assert len(comments) == 1, "should have exactly 1 comment"
            assert comments[0].id == expected_c1, "comment should have deterministic ID"
    finally:
        stage_store.close()
        await file_system.close()


@pytest.mark.asyncio
async def test_quick_note_conversion_retry_full_equality(
    uow_fixture, tmp_path,
) -> None:
    """Retrying conversion with the same operation_id must return the
    same batch_id and produce no duplicate entities."""
    import hashlib

    from sqlalchemy import func, select

    from app.commands import EntityCommand, FolderDomainPolicy, RelationDomainPolicy
    from app.file_system.api import get_file_system
    from app.knowledge.commands import KnowledgeCommands
    from app.knowledge.projections import KnowledgeDomainPolicy
    from app.knowledge.store import KnowledgeStore
    from app.models.memo_comment import MemoComment
    from app.models.note import Note
    from app.mutation.types import MutationState
    from tests.test_mutation_recovery import _Lease as RecoveryLease

    file_system = await get_file_system(
        root_dir=tmp_path / "retry-eq-files",
        index_db=tmp_path / "retry-eq-index.db",
    )
    stage_store = StageStore(_stage_authority(tmp_path / "retry-eq-stages"))
    scope = _Scope(uow_fixture.sessions, uow_fixture.receipt)
    scope.file_system = file_system
    scope.mutation_stages = stage_store
    scope.global_lease = RecoveryLease(LeaseMode.SHARED, "global")
    scope.space_lease = RecoveryLease(LeaseMode.EXCLUSIVE, "space-test")

    @asynccontextmanager
    async def exclusive_space_resources(purpose, timeout_seconds):
        yield scope.space_lease

    scope.exclusive_space_resources = exclusive_space_resources

    executor = FileSystemProjectionExecutor()
    compiler = MutationCompiler(
        CATALOG,
        [FolderDomainPolicy(), RelationDomainPolicy(), KnowledgeDomainPolicy()],
    )
    interpreter = DbMutationInterpreter(CATALOG)
    uow = MutationUnitOfWork(
        catalog=CATALOG,
        compiler=compiler,
        interpreter=interpreter,
        projection_executor=executor,
        recovery_gate=MutationRecovery(
            catalog=CATALOG,
            interpreter=interpreter,
            projection_executor=executor,
        ),
        journal_factory=MutationJournal,
    )
    store = KnowledgeStore(
        commands=KnowledgeCommands(),
        entity_commands=EntityCommand(CATALOG),
        uow=uow,
    )

    try:
        # Create QuickNote + 2 comments
        create_qn_req = store.entity_commands.create(
            scope, "quick_note",
            {"id": "qn-retry", "content": "Retry me", "tags": "[]"},
            expected_version=None,
        )
        await store.uow.execute(scope, create_qn_req, "create-qn-retry")

        for cid, ctext in (("src-a", "Comment A"), ("src-b", "Comment B")):
            req = store.entity_commands.create(
                scope, "memo_comment",
                {"id": cid, "note_id": "qn-retry", "content": ctext},
                expected_version=None,
            )
            await store.uow.execute(scope, req, f"create-{cid}")

        # First conversion
        first = await store.convert_quick_note(
            scope, "qn-retry", expected_version=1,
            operation_id="convert-qn-retry",
        )
        assert all(r.state is MutationState.FINALIZED for r in first.applied)

        # Retry with same operation_id
        second = await store.convert_quick_note(
            scope, "qn-retry", expected_version=1,
            operation_id="convert-qn-retry",
        )
        assert all(r.state is MutationState.FINALIZED for r in second.applied)
        assert second.batch_id == first.batch_id, "same batch_id on retry"

        # No duplicates
        expected_note_id = hashlib.sha256(
            "convert-qn-retry\0note".encode("ascii")
        ).hexdigest()[:32]

        async with uow_fixture.sessions() as session:
            note_count = await session.scalar(
                select(func.count()).select_from(Note).where(
                    Note.id == expected_note_id
                )
            )
            assert note_count == 1, "no duplicate Note from retry"

            comment_count = await session.scalar(
                select(func.count()).select_from(MemoComment).where(
                    MemoComment.note_id == expected_note_id
                )
            )
            assert comment_count == 2, "no duplicate comments from retry"
    finally:
        stage_store.close()
        await file_system.close()


@pytest.mark.asyncio
async def test_quick_note_conversion_visible_batch_events(
    uow_fixture, tmp_path,
) -> None:
    """All sync events from conversion (Note create, QuickNote update,
    MemoComment creates) must be visible only after the batch finalizes."""
    from sqlalchemy import select

    from app.commands import EntityCommand, FolderDomainPolicy, RelationDomainPolicy
    from app.file_system.api import get_file_system
    from app.knowledge.commands import KnowledgeCommands
    from app.knowledge.projections import KnowledgeDomainPolicy
    from app.knowledge.store import KnowledgeStore
    from app.models.sync_outbox import SyncOutbox
    from app.mutation.types import MutationState
    from tests.test_mutation_recovery import _Lease as RecoveryLease

    file_system = await get_file_system(
        root_dir=tmp_path / "vis-files",
        index_db=tmp_path / "vis-index.db",
    )
    stage_store = StageStore(_stage_authority(tmp_path / "vis-stages"))
    scope = _Scope(uow_fixture.sessions, uow_fixture.receipt)
    scope.file_system = file_system
    scope.mutation_stages = stage_store
    scope.global_lease = RecoveryLease(LeaseMode.SHARED, "global")
    scope.space_lease = RecoveryLease(LeaseMode.EXCLUSIVE, "space-test")

    @asynccontextmanager
    async def exclusive_space_resources(purpose, timeout_seconds):
        yield scope.space_lease

    scope.exclusive_space_resources = exclusive_space_resources

    executor = FileSystemProjectionExecutor()
    compiler = MutationCompiler(
        CATALOG,
        [FolderDomainPolicy(), RelationDomainPolicy(), KnowledgeDomainPolicy()],
    )
    interpreter = DbMutationInterpreter(CATALOG)
    uow = MutationUnitOfWork(
        catalog=CATALOG,
        compiler=compiler,
        interpreter=interpreter,
        projection_executor=executor,
        recovery_gate=MutationRecovery(
            catalog=CATALOG,
            interpreter=interpreter,
            projection_executor=executor,
        ),
        journal_factory=MutationJournal,
    )
    store = KnowledgeStore(
        commands=KnowledgeCommands(),
        entity_commands=EntityCommand(CATALOG),
        uow=uow,
    )

    try:
        # Create QuickNote + 1 comment
        create_qn_req = store.entity_commands.create(
            scope, "quick_note",
            {"id": "qn-vis", "content": "Visible events", "tags": "[]"},
            expected_version=None,
        )
        await store.uow.execute(scope, create_qn_req, "create-qn-vis")

        create_c_req = store.entity_commands.create(
            scope, "memo_comment",
            {"id": "src-vis", "note_id": "qn-vis", "content": "Vis comment"},
            expected_version=None,
        )
        await store.uow.execute(scope, create_c_req, "create-src-vis")

        # Convert
        result = await store.convert_quick_note(
            scope, "qn-vis", expected_version=1,
            operation_id="convert-qn-vis",
        )
        assert all(r.state is MutationState.FINALIZED for r in result.applied)

        # After finalization, all batch events should be visible
        async with uow_fixture.sessions() as session:
            batch_events = (
                await session.execute(
                    select(SyncOutbox).where(
                        SyncOutbox.batch_id == "convert-qn-vis"
                    )
                )
            ).scalars().all()

            # Should have events for: Note create, QuickNote update, MemoComment create
            # (at least 3 events from the batch)
            assert len(batch_events) >= 3, (
                f"expected at least 3 batch events, got {len(batch_events)}"
            )

            # All must be visible
            for event in batch_events:
                assert event.visible is True, (
                    f"event {event.entity_type}/{event.entity_id} "
                    f"should be visible after batch finalize"
                )
    finally:
        stage_store.close()
        await file_system.close()


@pytest.mark.asyncio
async def test_purge_creates_tombstone_via_commit_business(
    knowledge_fixture,
) -> None:
    """Purge must create exactly one tombstone in the space database,
    processed atomically within _commit_business alongside sync_events."""
    from app.models.tombstone import Tombstone

    kf = knowledge_fixture
    note_id = "n-tomb"
    purge_version = await kf.create_and_trash_note(note_id, title="Tomb", versions=1)

    result = await kf.store.purge_note(
        kf.scope, note_id, expected_version=purge_version,
        operation_id="purge-tomb",
    )
    assert result.state is MutationState.FINALIZED

    async with kf.sessions() as session:
        tombstones = (
            await session.execute(
                select(Tombstone).where(
                    Tombstone.entity_type == "note",
                    Tombstone.entity_id == note_id,
                )
            )
        ).scalars().all()
        assert len(tombstones) == 1, f"expected 1 tombstone, got {len(tombstones)}"
        assert tombstones[0].deleted_at is not None



@pytest.mark.asyncio
async def test_note_purge_full_before_image_manifest(
    knowledge_fixture,
) -> None:
    """Purge must remove ORM row, markdown, index, FTS, and create
    exactly one tombstone + one visible delete event."""
    kf = knowledge_fixture
    note_id = "n-manifest"
    purge_version = await kf.create_and_trash_note(
        note_id, title="Manifest", versions=3,
    )

    result = await kf.store.purge_note(
        kf.scope, note_id, expected_version=purge_version,
        operation_id="purge-manifest",
    )
    assert result.state is MutationState.FINALIZED

    await kf.assert_note_absent_everywhere(note_id)
    await kf.assert_single_tombstone_and_visible_delete("note", note_id)


@pytest.mark.asyncio
async def test_purge_cleans_old_tombstone_and_creates_new(
    knowledge_fixture,
) -> None:
    """Purge must delete any pre-existing tombstone and create a fresh one."""
    from app.models.tombstone import Tombstone

    kf = knowledge_fixture
    note_id = "n-old-tomb"
    purge_version = await kf.create_and_trash_note(note_id, title="OldTomb")

    # Manually insert a stale tombstone.
    async with kf.sessions() as session:
        session.add(Tombstone(
            entity_type="note", entity_id=note_id,
            deleted_at="2020-01-01T00:00:00.000Z",
        ))
        await session.commit()

    result = await kf.store.purge_note(
        kf.scope, note_id, expected_version=purge_version,
        operation_id="purge-old-tomb",
    )
    assert result.state is MutationState.FINALIZED

    async with kf.sessions() as session:
        tombstones = (
            await session.execute(
                select(Tombstone).where(
                    Tombstone.entity_type == "note",
                    Tombstone.entity_id == note_id,
                )
            )
        ).scalars().all()
        assert len(tombstones) == 1, f"expected 1 tombstone, got {len(tombstones)}"
        assert tombstones[0].deleted_at != "2020-01-01T00:00:00.000Z", \
            "stale tombstone was not replaced"


@pytest.mark.asyncio
async def test_purge_compensation_restores_orm_and_deletes_tombstone(
    knowledge_fixture,
) -> None:
    """When forward projection fails, compensation must restore the ORM
    row and delete the tombstone created by _commit_business."""
    from app.models.tombstone import Tombstone

    kf = knowledge_fixture
    note_id = "n-compensate"
    purge_version = await kf.create_and_trash_note(note_id, title="Compensate")

    # Inject a failing executor that raises on apply_forward but
    # allows restore_before to succeed (inherits from parent).
    class _FailingForwardExecutor(FileSystemProjectionExecutor):
        async def apply_forward(self, scope, operation_id, command, receipt, *, ordinals=None):
            raise RuntimeError("injected forward failure")

    failing = _FailingForwardExecutor()
    kf.store.uow.projection_executor = failing
    kf.store.uow.recovery_gate.projection_executor = failing

    # Purge will fail during _finalize_forward.
    with pytest.raises(RuntimeError, match="injected forward failure"):
        await kf.store.purge_note(
            kf.scope, note_id, expected_version=purge_version,
            operation_id="purge-compensate",
        )

    # Batch is in FINALIZING state. Trigger recovery -> compensation.
    recovery_result = await kf.store.uow.recovery_gate.recover_under_lease(
        kf.scope, kf.scope.space_lease,
    )
    assert "purge-compensate" in recovery_result.compensated, (
        f"expected compensation, got {recovery_result}"
    )

    # ORM row should be restored.
    async with kf.sessions() as session:
        note = await session.get(Note, note_id)
        assert note is not None, "Note ORM row was not restored by compensation"
        assert note.trashed_at is not None, "Note should still be trashed after restore"

        tombstones = (
            await session.execute(
                select(Tombstone).where(
                    Tombstone.entity_type == "note",
                    Tombstone.entity_id == note_id,
                )
            )
        ).scalars().all()
        assert len(tombstones) == 0, (
            f"expected 0 tombstones after compensation, got {len(tombstones)}"
        )



@pytest.mark.asyncio
async def test_folder_purge_per_child_orm_projection_event_tombstone(
    knowledge_fixture,
) -> None:
    """Folder purge must delete each descendant deepest-first, with
    per-child ORM deletion, visible delete event, and tombstone."""
    from app.models.folder import Folder

    kf = knowledge_fixture
    # Create root -> child -> grandchild
    root_id = "f-root"
    child_id = "f-child"
    grand_id = "f-grand"

    await kf.store.create_folder(
        kf.scope, {"id": root_id, "name": "Root"},
        expected_version=None, operation_id="create-root",
    )
    await kf.store.create_folder(
        kf.scope, {"id": child_id, "name": "Child", "parent_id": root_id},
        expected_version=None, operation_id="create-child",
    )
    await kf.store.create_folder(
        kf.scope, {"id": grand_id, "name": "Grand", "parent_id": child_id},
        expected_version=None, operation_id="create-grand",
    )

    result = await kf.store.purge_folder(
        kf.scope, root_id, expected_version=1,
        operation_id="purge-folder-tree",
    )
    assert len(result.applied) == 3, f"expected 3 applied, got {len(result.applied)}"
    for r in result.applied:
        assert r.state is MutationState.FINALIZED

    # All three folders deleted from ORM.
    async with kf.sessions() as session:
        for fid in (root_id, child_id, grand_id):
            folder = await session.get(Folder, fid)
            assert folder is None, f"Folder {fid} still in ORM"

    # Each folder has a tombstone and visible delete event.
    for fid in (root_id, child_id, grand_id):
        await kf.assert_single_tombstone_and_visible_delete("folder", fid)


@pytest.mark.asyncio
async def test_folder_purge_multi_layer_tree_all_deleted(
    knowledge_fixture,
) -> None:
    """4-folder tree: root -> a -> b -> c. Purge root, verify all gone."""
    from app.models.folder import Folder

    kf = knowledge_fixture
    ids = ["f-mt-root", "f-mt-a", "f-mt-b", "f-mt-c"]
    await kf.store.create_folder(
        kf.scope, {"id": ids[0], "name": "Root"},
        expected_version=None, operation_id="mt-create-root",
    )
    for i in range(1, 4):
        await kf.store.create_folder(
            kf.scope, {"id": ids[i], "name": f"L{i}", "parent_id": ids[i-1]},
            expected_version=None, operation_id=f"mt-create-{i}",
        )

    result = await kf.store.purge_folder(
        kf.scope, ids[0], expected_version=1,
        operation_id="mt-purge",
    )
    assert len(result.applied) == 4
    for r in result.applied:
        assert r.state is MutationState.FINALIZED

    async with kf.sessions() as session:
        for fid in ids:
            assert await session.get(Folder, fid) is None, f"{fid} still exists"
    for fid in ids:
        await kf.assert_single_tombstone_and_visible_delete("folder", fid)


@pytest.mark.asyncio
async def test_folder_purge_mid_batch_failure_compensates_all(
    knowledge_fixture,
) -> None:
    """If forward projection fails mid-batch, compensation must restore
    ALL folders — proving all-old-or-all-new semantics."""
    from app.models.folder import Folder

    kf = knowledge_fixture
    ids = ["f-fail-root", "f-fail-child", "f-fail-grand"]
    await kf.store.create_folder(
        kf.scope, {"id": ids[0], "name": "Root"},
        expected_version=None, operation_id="fail-create-root",
    )
    await kf.store.create_folder(
        kf.scope, {"id": ids[1], "name": "Child", "parent_id": ids[0]},
        expected_version=None, operation_id="fail-create-child",
    )
    await kf.store.create_folder(
        kf.scope, {"id": ids[2], "name": "Grand", "parent_id": ids[1]},
        expected_version=None, operation_id="fail-create-grand",
    )

    class _FailingForwardExecutor(FileSystemProjectionExecutor):
        async def apply_forward(self, scope, operation_id, command, receipt, *, ordinals=None):
            raise RuntimeError("injected mid-batch failure")

    failing = _FailingForwardExecutor()
    kf.store.uow.projection_executor = failing
    kf.store.uow.recovery_gate.projection_executor = failing

    with pytest.raises(RuntimeError, match="injected mid-batch failure"):
        await kf.store.purge_folder(
            kf.scope, ids[0], expected_version=1,
            operation_id="fail-purge",
        )

    recovery_result = await kf.store.uow.recovery_gate.recover_under_lease(
        kf.scope, kf.scope.space_lease,
    )
    assert "fail-purge" in recovery_result.compensated

    # ALL folders restored — all-old-or-all-new.
    async with kf.sessions() as session:
        for fid in ids:
            folder = await session.get(Folder, fid)
            assert folder is not None, f"Folder {fid} was not restored"


@pytest.mark.asyncio
async def test_folder_purge_retry_after_failure_succeeds(
    knowledge_fixture,
) -> None:
    """After a failed+compensated purge, a retry with a new operation_id
    must succeed — proving all-new semantics."""
    from app.models.folder import Folder

    kf = knowledge_fixture
    root_id = "f-retry-root"
    child_id = "f-retry-child"
    await kf.store.create_folder(
        kf.scope, {"id": root_id, "name": "Root"},
        expected_version=None, operation_id="retry-create-root",
    )
    await kf.store.create_folder(
        kf.scope, {"id": child_id, "name": "Child", "parent_id": root_id},
        expected_version=None, operation_id="retry-create-child",
    )

    # First attempt fails.
    class _FailingForwardExecutor(FileSystemProjectionExecutor):
        async def apply_forward(self, scope, operation_id, command, receipt, *, ordinals=None):
            raise RuntimeError("first attempt fails")

    failing = _FailingForwardExecutor()
    kf.store.uow.projection_executor = failing
    kf.store.uow.recovery_gate.projection_executor = failing

    with pytest.raises(RuntimeError):
        await kf.store.purge_folder(
            kf.scope, root_id, expected_version=1,
            operation_id="retry-purge-1",
        )
    await kf.store.uow.recovery_gate.recover_under_lease(
        kf.scope, kf.scope.space_lease,
    )

    # Restore working executor.
    kf.store.uow.projection_executor = FileSystemProjectionExecutor()
    kf.store.uow.recovery_gate.projection_executor = kf.store.uow.projection_executor

    # Retry with new operation_id.
    result = await kf.store.purge_folder(
        kf.scope, root_id, expected_version=1,
        operation_id="retry-purge-2",
    )
    assert len(result.applied) == 2
    for r in result.applied:
        assert r.state is MutationState.FINALIZED

    async with kf.sessions() as session:
        assert await session.get(Folder, root_id) is None
        assert await session.get(Folder, child_id) is None



@pytest.mark.asyncio
async def test_conversion_derived_mapping_persisted_in_intent(
    knowledge_fixture,
) -> None:
    """Conversion must persist derivation_map (note_id, archived_at,
    comment_mapping) in the INTENT command JSON."""
    import json as _json

    from app.models.memo_comment import MemoComment
    from app.models.mutation import MutationOperation
    from app.models.quick_note import QuickNote

    kf = knowledge_fixture
    # Create a quick note with 2 comments.
    async with kf.sessions() as session:
        qn = QuickNote(content="convert me", tags="[]")
        session.add(qn)
        await session.flush()
        qn_id = qn.id
        c1 = MemoComment(note_id=qn_id, content="comment 1")
        c2 = MemoComment(note_id=qn_id, content="comment 2")
        session.add_all([c1, c2])
        await session.commit()
        await session.refresh(c1)
        await session.refresh(c2)
        c1_id, c2_id = c1.id, c2.id

    result = await kf.store.convert_quick_note(
        kf.scope, qn_id, expected_version=1,
        operation_id="convert-intent-test",
    )
    assert len(result.applied) > 0
    for r in result.applied:
        assert r.state is MutationState.FINALIZED

    # Check that derivation_map is in at least one operation's command_json.
    async with kf.sessions() as session:
        ops = (
            await session.execute(
                select(MutationOperation).where(
                    MutationOperation.batch_id == "convert-intent-test"
                )
            )
        ).scalars().all()
        found_derivation = False
        for op in ops:
            cmd = _json.loads(op.command_json)
            payload = cmd.get("request", {}).get("payload", {})
            if "derivation_map" in payload:
                found_derivation = True
                dm = payload["derivation_map"]
                assert "note_id" in dm
                assert "archived_at" in dm
                assert "comment_mapping" in dm
                assert str(c1_id) in dm["comment_mapping"]
                assert str(c2_id) in dm["comment_mapping"]
        assert found_derivation, "derivation_map not found in any operation command_json"


@pytest.mark.asyncio
async def test_conversion_zero_comments_succeeds(
    knowledge_fixture,
) -> None:
    """Conversion with 0 comments must succeed with empty comment_mapping."""
    from app.models.quick_note import QuickNote

    kf = knowledge_fixture
    async with kf.sessions() as session:
        qn = QuickNote(content="no comments", tags="[]")
        session.add(qn)
        await session.commit()
        qn_id = qn.id

    result = await kf.store.convert_quick_note(
        kf.scope, qn_id, expected_version=1,
        operation_id="convert-zero-comments",
    )
    assert len(result.applied) > 0
    for r in result.applied:
        assert r.state is MutationState.FINALIZED


@pytest.mark.asyncio
async def test_conversion_cas_rejects_wrong_version(
    knowledge_fixture,
) -> None:
    """Conversion with wrong expected_version must be rejected."""
    from app.models.quick_note import QuickNote

    kf = knowledge_fixture
    async with kf.sessions() as session:
        qn = QuickNote(content="cas test", tags="[]")
        session.add(qn)
        await session.commit()
        qn_id = qn.id

    with pytest.raises(Exception):
        await kf.store.convert_quick_note(
            kf.scope, qn_id, expected_version=99,
            operation_id="convert-cas-reject",
        )


@pytest.mark.asyncio
async def test_conversion_retry_after_failure_does_not_duplicate(
    knowledge_fixture,
) -> None:
    """After a failed+compensated conversion, retry with same operation_id
    must not create duplicate notes."""
    from app.models.note import Note
    from app.models.quick_note import QuickNote

    kf = knowledge_fixture
    async with kf.sessions() as session:
        qn = QuickNote(content="retry test", tags="[]")
        session.add(qn)
        await session.commit()
        qn_id = qn.id

    # First attempt fails.
    class _FailingForwardExecutor(FileSystemProjectionExecutor):
        async def apply_forward(self, scope, operation_id, command, receipt, *, ordinals=None):
            raise RuntimeError("conversion first attempt fails")

    failing = _FailingForwardExecutor()
    kf.store.uow.projection_executor = failing
    kf.store.uow.recovery_gate.projection_executor = failing

    with pytest.raises(RuntimeError):
        await kf.store.convert_quick_note(
            kf.scope, qn_id, expected_version=1,
            operation_id="convert-retry",
        )
    await kf.store.uow.recovery_gate.recover_under_lease(
        kf.scope, kf.scope.space_lease,
    )

    # Restore working executor and retry with same operation_id.
    kf.store.uow.projection_executor = FileSystemProjectionExecutor()
    kf.store.uow.recovery_gate.projection_executor = kf.store.uow.projection_executor

    result = await kf.store.convert_quick_note(
        kf.scope, qn_id, expected_version=1,
        operation_id="convert-retry-2",
    )
    assert len(result.applied) > 0
    for r in result.applied:
        assert r.state is MutationState.FINALIZED

    # Exactly 1 note created.
    async with kf.sessions() as session:
        notes = (
            await session.execute(select(Note))
        ).scalars().all()
        assert len(notes) == 1, f"expected 1 note, got {len(notes)}"


@pytest.mark.asyncio
async def test_conversion_child_finalize_failure_compensates(
    knowledge_fixture,
) -> None:
    """If a child operation fails during finalize, compensation must
    reverse all changes — no note should exist."""
    from app.models.note import Note
    from app.models.quick_note import QuickNote

    kf = knowledge_fixture
    async with kf.sessions() as session:
        qn = QuickNote(content="child fail test", tags="[]")
        session.add(qn)
        await session.commit()
        qn_id = qn.id

    class _FailingForwardExecutor(FileSystemProjectionExecutor):
        async def apply_forward(self, scope, operation_id, command, receipt, *, ordinals=None):
            raise RuntimeError("child finalize failure")

    failing = _FailingForwardExecutor()
    kf.store.uow.projection_executor = failing
    kf.store.uow.recovery_gate.projection_executor = failing

    with pytest.raises(RuntimeError):
        await kf.store.convert_quick_note(
            kf.scope, qn_id, expected_version=1,
            operation_id="convert-child-fail",
        )
    await kf.store.uow.recovery_gate.recover_under_lease(
        kf.scope, kf.scope.space_lease,
    )

    async with kf.sessions() as session:
        notes = (
            await session.execute(select(Note))
        ).scalars().all()
        assert len(notes) == 0, f"expected 0 notes after compensation, got {len(notes)}"


@pytest.mark.asyncio
async def test_conversion_comment_order_stability(
    knowledge_fixture,
) -> None:
    """Comment query order changes must not change request hash,
    mapping, or receipt."""
    import json as _json

    from app.models.memo_comment import MemoComment
    from app.models.mutation import MutationOperation
    from app.models.quick_note import QuickNote

    kf = knowledge_fixture
    async with kf.sessions() as session:
        qn = QuickNote(content="order test", tags="[]")
        session.add(qn)
        await session.flush()
        qn_id = qn.id
        # Insert comments in reverse chronological order.
        c2 = MemoComment(note_id=qn_id, content="second")
        c1 = MemoComment(note_id=qn_id, content="first")
        session.add_all([c2, c1])
        await session.commit()
        await session.refresh(c1)
        await session.refresh(c2)

    result = await kf.store.convert_quick_note(
        kf.scope, qn_id, expected_version=1,
        operation_id="convert-order-stable",
    )
    assert len(result.applied) > 0
    for r in result.applied:
        assert r.state is MutationState.FINALIZED

    # Verify derivation_map has deterministic mapping.
    async with kf.sessions() as session:
        ops = (
            await session.execute(
                select(MutationOperation).where(
                    MutationOperation.batch_id == "convert-order-stable"
                )
            )
        ).scalars().all()
        for op in ops:
            cmd = _json.loads(op.command_json)
            payload = cmd.get("payload", {})
            if "derivation_map" in payload:
                dm = payload["derivation_map"]
                # Comment IDs are mapped deterministically by source comment ID.
                for src_id, mapping in dm["comment_mapping"].items():
                    expected_cid = hashlib.sha256(
                        f"convert-order-stable\0memo_comment\0{src_id}".encode("ascii")
                    ).hexdigest()[:32]
                    assert mapping["new_id"] == expected_cid, (
                        f"comment {src_id} mapping is not deterministic"
                    )
