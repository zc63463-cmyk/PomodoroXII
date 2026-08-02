"""Read-only consistency verification for knowledge projections."""

from __future__ import annotations

import asyncio
import hashlib
import json
import sqlite3
import uuid
from contextlib import closing
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import TYPE_CHECKING

from app.errors import MutationRejectedError
from app.file_system.frontmatter import extract_frontmatter
from app.knowledge.commands import KnowledgeCommands
from app.knowledge.projections import note_path
from app.registry import CATALOG
from app.runtime.space import SpaceRuntimeHandle

if TYPE_CHECKING:
    from app.mutation.unit_of_work import MutationUnitOfWork


@dataclass(frozen=True, slots=True)
class SpaceDataView:
    """Paths required to inspect one Space without opening runtime writers."""

    space_id: str
    db_path: Path
    notes_dir: Path
    index_db: Path
    catalog_hash: str


@dataclass(frozen=True, slots=True)
class ConsistencyIssue:
    """One deterministic authority/projection disagreement."""

    code: str
    entity_type: str | None = None
    entity_id: str | None = None
    field: str | None = None
    expected: str | None = None
    actual: str | None = None


@dataclass(frozen=True, slots=True)
class ConsistencyReport:
    """Immutable result of a read-only consistency scan."""

    valid: bool
    issues: tuple[ConsistencyIssue, ...]


@dataclass(frozen=True, slots=True)
class RebuildResult:
    """Outcome of one journaled, projection-only rebuild operation."""

    operation_id: str
    applied: bool
    rebuilt_folders: int
    rebuilt_notes: int
    failed_note_ids: tuple[str, ...]


class KnowledgeConsistencyChecker:
    """Compare Space DB authority with Markdown, index, and FTS projections."""

    def __init__(self, *, uow: MutationUnitOfWork | None = None) -> None:
        self._uow = uow

    async def verify(self, view: SpaceDataView) -> ConsistencyReport:
        return await asyncio.to_thread(self._verify_read_only, view)

    async def rebuild(self, handle: SpaceRuntimeHandle) -> RebuildResult:
        if self._uow is None:
            raise RuntimeError("knowledge rebuild requires a MutationUnitOfWork")
        operation_id = f"knowledge-rebuild-{uuid.uuid4().hex}"
        request = KnowledgeCommands().rebuild_projection_request(handle.scope.space_id)
        try:
            result = await self._uow.execute(handle, request, operation_id)
        except MutationRejectedError as exc:
            if (
                exc.rejection.code != "version_conflict"
                or exc.rejection.details.get("reason") != "body_hash_mismatch"
            ):
                raise
            failed = exc.rejection.details.get("noteIds", ())
            return RebuildResult(
                operation_id,
                False,
                0,
                0,
                tuple(str(note_id) for note_id in failed),
            )
        return RebuildResult(
            operation_id,
            True,
            int(result.value["rebuiltFolders"]),
            int(result.value["rebuiltNotes"]),
            (),
        )

    def _verify_read_only(self, view: SpaceDataView) -> ConsistencyReport:
        self._require_existing_paths(view)
        issues: list[ConsistencyIssue] = []
        if view.catalog_hash != CATALOG.hash:
            issues.append(
                ConsistencyIssue(
                    "catalog_hash_mismatch",
                    field="catalog_hash",
                    expected=CATALOG.hash,
                    actual=view.catalog_hash,
                )
            )

        with (
            closing(self._connect_read_only(view.db_path)) as space_db,
            closing(self._connect_read_only(view.index_db)) as index_db,
        ):
            folders = self._rows_by_id(space_db, "folders", "id")
            notes = self._rows_by_id(space_db, "notes", "id")
            indexed_folders = self._rows_by_id(index_db, "folders", "id")
            indexed_notes = self._rows_by_id(index_db, "notes", "note_id")
            dirty_batches = tuple(
                space_db.execute(
                    "SELECT batch_id, state FROM mutation_batches "
                    "WHERE state NOT IN ('FINALIZED', 'ABORTED', 'COMPENSATED') "
                    "ORDER BY batch_id"
                )
            )
            fts = {
                row["note_id"]: row
                for row in index_db.execute(
                    "SELECT notes.note_id, notes_fts.title, notes_fts.content "
                    "FROM notes_fts JOIN notes ON notes_fts.rowid = notes.rowid"
                )
            }

        for batch in dirty_batches:
            issues.append(
                ConsistencyIssue(
                    "journal_not_clean",
                    "mutation_batch",
                    str(batch["batch_id"]),
                    "state",
                    actual=self._display(batch["state"]),
                )
            )
        self._compare_entity_sets("folder", folders, indexed_folders, issues)
        for folder_id, row in folders.items():
            indexed = indexed_folders.get(folder_id)
            if indexed is not None:
                self._compare_fields(
                    "folder",
                    folder_id,
                    row,
                    indexed,
                    (
                        "id",
                        "name",
                        "parent_id",
                        "icon",
                        "color",
                        "sort_order",
                        "is_system",
                        "trashed_at",
                        "created_at",
                        "updated_at",
                    ),
                    issues,
                )

        self._compare_entity_sets("note", notes, indexed_notes, issues)
        for note_id, row in notes.items():
            indexed = indexed_notes.get(note_id)
            expected_path = note_path(note_id, str(row["title"]), row["folder_id"])
            if indexed is not None:
                expected_index = {
                    "note_id": note_id,
                    "title": row["title"],
                    "current_path": expected_path,
                    "content_hash": row["content_hash"],
                    "folder_id": row["folder_id"],
                    "level": "L1",
                    "status": row["status"],
                    "tags": row["tags"],
                    "word_count": row["word_count"],
                    "is_deleted": row["trashed_at"] is not None,
                    "summary": row["summary"],
                    "category": row["category"],
                    "trashed_at": row["trashed_at"],
                    "created_at": row["created_at"],
                    "updated_at": row["updated_at"],
                }
                self._compare_fields(
                    "note",
                    note_id,
                    expected_index,
                    indexed,
                    tuple(expected_index),
                    issues,
                )
            body = self._verify_markdown(view, note_id, row, expected_path, issues)
            indexed_fts = fts.get(note_id)
            if indexed_fts is None:
                issues.append(ConsistencyIssue("fts_missing", "note", note_id))
            elif body is not None:
                self._compare_value(
                    "fts_mismatch",
                    "note",
                    note_id,
                    "title",
                    row["title"],
                    indexed_fts["title"],
                    issues,
                )
                self._compare_value(
                    "fts_mismatch",
                    "note",
                    note_id,
                    "content",
                    body,
                    indexed_fts["content"],
                    issues,
                )

        expected_markdown = {
            note_path(note_id, str(row["title"]), row["folder_id"])
            for note_id, row in notes.items()
        }
        notes_root = view.notes_dir / "notes"
        actual_markdown = {
            path.relative_to(view.notes_dir).as_posix()
            for path in notes_root.rglob("*.md")
            if path.is_file()
        }
        for current_path in sorted(actual_markdown - expected_markdown):
            issues.append(ConsistencyIssue("markdown_extra", "note", actual=current_path))
        for note_id in sorted(set(fts) - set(notes)):
            issues.append(ConsistencyIssue("fts_extra", "note", note_id))
        ordered = tuple(
            sorted(
                issues,
                key=lambda item: (
                    item.code,
                    item.entity_type or "",
                    item.entity_id or "",
                    item.field or "",
                ),
            )
        )
        return ConsistencyReport(not ordered, ordered)

    @staticmethod
    def _require_existing_paths(view: SpaceDataView) -> None:
        for path in (view.db_path, view.notes_dir, view.index_db):
            if not path.exists():
                raise FileNotFoundError(path)
        if not view.db_path.is_file():
            raise FileNotFoundError(view.db_path)
        if not view.notes_dir.is_dir():
            raise FileNotFoundError(view.notes_dir)
        if not view.index_db.is_file():
            raise FileNotFoundError(view.index_db)

    @staticmethod
    def _connect_read_only(path: Path) -> sqlite3.Connection:
        connection = sqlite3.connect(f"{path.resolve().as_uri()}?mode=ro", uri=True)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA query_only=ON")
        return connection

    @staticmethod
    def _rows_by_id(
        connection: sqlite3.Connection, table: str, primary_key: str
    ) -> dict[str, sqlite3.Row]:
        return {
            str(row[primary_key]): row for row in connection.execute(f'SELECT * FROM "{table}"')
        }

    @staticmethod
    def _compare_entity_sets(
        entity_type: str,
        authority: dict[str, sqlite3.Row],
        projection: dict[str, sqlite3.Row],
        issues: list[ConsistencyIssue],
    ) -> None:
        for entity_id in sorted(set(authority) - set(projection)):
            issues.append(ConsistencyIssue("index_row_missing", entity_type, entity_id))
        for entity_id in sorted(set(projection) - set(authority)):
            issues.append(ConsistencyIssue("index_row_extra", entity_type, entity_id))

    def _verify_markdown(
        self,
        view: SpaceDataView,
        note_id: str,
        row: sqlite3.Row,
        current_path: str,
        issues: list[ConsistencyIssue],
    ) -> str | None:
        relative = PurePosixPath(current_path)
        if relative.is_absolute() or ".." in relative.parts:
            issues.append(
                ConsistencyIssue("markdown_path_invalid", "note", note_id, actual=current_path)
            )
            return None
        markdown_path = view.notes_dir.joinpath(*relative.parts)
        if not markdown_path.is_file():
            issues.append(
                ConsistencyIssue("markdown_missing", "note", note_id, actual=current_path)
            )
            return None
        try:
            raw = markdown_path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            issues.append(ConsistencyIssue("markdown_not_utf8", "note", note_id))
            return None
        metadata, body = extract_frontmatter(raw)
        if metadata is None:
            issues.append(ConsistencyIssue("frontmatter_missing", "note", note_id))
        else:
            try:
                tags = json.loads(row["tags"] or "[]")
            except json.JSONDecodeError:
                tags = None
                issues.append(ConsistencyIssue("authority_tags_invalid", "note", note_id))
            expected = {
                "id": note_id,
                "title": row["title"],
                "tags": tags,
                "folder_id": row["folder_id"],
                "content_hash": f"sha256:{row['content_hash']}",
                "created_at": row["created_at"],
                "updated_at": row["updated_at"],
            }
            if set(metadata) != set(expected):
                issues.append(
                    ConsistencyIssue(
                        "frontmatter_keys_mismatch",
                        "note",
                        note_id,
                        expected=self._display(sorted(expected)),
                        actual=self._display(sorted(metadata)),
                    )
                )
            self._compare_fields(
                "note",
                note_id,
                expected,
                metadata,
                tuple(expected),
                issues,
                code="frontmatter_mismatch",
            )
        digest = hashlib.sha256(body.encode("utf-8")).hexdigest()
        self._compare_value(
            "body_hash_mismatch",
            "note",
            note_id,
            "content_hash",
            row["content_hash"],
            digest,
            issues,
        )
        return body

    def _compare_fields(
        self,
        entity_type: str,
        entity_id: str,
        expected: sqlite3.Row | dict[str, object],
        actual: sqlite3.Row | dict[str, object],
        fields: tuple[str, ...],
        issues: list[ConsistencyIssue],
        *,
        code: str = "index_field_mismatch",
    ) -> None:
        for field in fields:
            self._compare_value(
                code,
                entity_type,
                entity_id,
                field,
                expected[field],
                actual[field],
                issues,
            )

    @staticmethod
    def _compare_value(
        code: str,
        entity_type: str,
        entity_id: str,
        field: str,
        expected: object,
        actual: object,
        issues: list[ConsistencyIssue],
    ) -> None:
        if expected != actual and not (isinstance(expected, bool) and int(expected) == actual):
            issues.append(
                ConsistencyIssue(
                    code,
                    entity_type,
                    entity_id,
                    field,
                    KnowledgeConsistencyChecker._display(expected),
                    KnowledgeConsistencyChecker._display(actual),
                )
            )

    @staticmethod
    def _display(value: object) -> str:
        return json.dumps(value, ensure_ascii=True, sort_keys=True)
