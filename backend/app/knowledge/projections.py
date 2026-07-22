"""Deterministic Markdown, index, and FTS projection builders."""

from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping
from dataclasses import replace

from app.commands.entity import folder_index_target, serialize_folder_index_row
from app.file_system.engine.base import _make_filename
from app.file_system.frontmatter import extract_frontmatter, wrap_with_frontmatter
from app.mutation.types import (
    ContainedProjectionActionField,
    MutationCommand,
    MutationRequest,
    MutationRuleViolation,
    ProjectionActionTag,
    ProjectionPlan,
)
from app.mutation.unit_of_work import (
    MutationCompileContext,
    compile_catalog_entity_command,
)


def _json_blob(value: object) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=True,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("ascii")


def _tags(value: object) -> list[str]:
    if isinstance(value, str):
        try:
            parsed = json.loads(value or "[]")
        except json.JSONDecodeError as exc:
            raise ValueError("note tags are not valid JSON") from exc
    else:
        parsed = value
    if not isinstance(parsed, (list, tuple)) or not all(isinstance(item, str) for item in parsed):
        raise ValueError("note tags must be a list of strings")
    return list(parsed)


def note_path(note_id: str, title: str, folder_id: object) -> str:
    filename = _make_filename(note_id, title)
    return f"notes/{filename}" if folder_id is None else f"notes/{folder_id}/{filename}"


class KnowledgeProjectionBuilder:
    """Build equal, ordered projection tuples for one Note mutation."""

    def build_note(
        self,
        *,
        before_row: Mapping[str, object] | None,
        after_row: Mapping[str, object] | None,
        before_path: str | None,
        before_markdown: bytes | None,
        body: str | None,
        before_index: bytes | None | object = ...,
        before_fts: bytes | None | object = ...,
    ) -> tuple[ProjectionPlan, ...]:
        if after_row is None:
            if before_row is None or before_path is None or before_markdown is None:
                raise ValueError("note delete projection requires a complete before image")
            return (
                ProjectionPlan(
                    ProjectionActionTag.PATH_REMOVE,
                    None,
                    ContainedProjectionActionField(before_path),
                    0,
                    before_markdown,
                    None,
                ),
                ProjectionPlan(
                    ProjectionActionTag.INDEX_REPLACE,
                    None,
                    ContainedProjectionActionField(f"index/notes/note_id/{before_row['id']}"),
                    1,
                    self._note_index_blob(before_row, before_path),
                    None,
                ),
                ProjectionPlan(
                    ProjectionActionTag.FTS_REPLACE,
                    None,
                    ContainedProjectionActionField(f"fts/{before_row['id']}"),
                    2,
                    self._fts_blob(before_row, self._body(before_markdown)),
                    None,
                ),
            )

        if body is None:
            if before_markdown is None:
                raise ValueError("note projection requires body or authoritative Markdown")
            body = self._body(before_markdown)
        after_path = note_path(
            str(after_row["id"]), str(after_row["title"]), after_row.get("folder_id")
        )
        after_markdown = self._markdown(after_row, body)
        after_index = self._note_index_blob(after_row, after_path)
        after_fts = self._fts_blob(after_row, body)
        projections: list[ProjectionPlan] = []
        ordinal = 0
        if before_row is not None and before_path is not None and before_markdown is not None:
            if before_path != after_path:
                projections.append(
                    ProjectionPlan(
                        ProjectionActionTag.PATH_RENAME,
                        ContainedProjectionActionField(before_path),
                        ContainedProjectionActionField(after_path),
                        ordinal,
                        before_markdown,
                        before_markdown,
                    )
                )
                ordinal += 1
            if before_markdown != after_markdown:
                projections.append(
                    ProjectionPlan(
                        ProjectionActionTag.MARKDOWN_WRITE,
                        None,
                        ContainedProjectionActionField(after_path),
                        ordinal,
                        before_markdown,
                        after_markdown,
                    )
                )
                ordinal += 1
            if before_index is ...:
                before_index = self._note_index_blob(before_row, before_path)
            if before_fts is ...:
                before_fts = self._fts_blob(before_row, self._body(before_markdown))
        else:
            before_index = None
            before_fts = None
            projections.append(
                ProjectionPlan(
                    ProjectionActionTag.MARKDOWN_WRITE,
                    None,
                    ContainedProjectionActionField(after_path),
                    ordinal,
                    None,
                    after_markdown,
                )
            )
            ordinal += 1
        projections.append(
            ProjectionPlan(
                ProjectionActionTag.INDEX_REPLACE,
                None,
                ContainedProjectionActionField(f"index/notes/note_id/{after_row['id']}"),
                ordinal,
                before_index,
                after_index,
            )
        )
        ordinal += 1
        projections.append(
            ProjectionPlan(
                ProjectionActionTag.FTS_REPLACE,
                None,
                ContainedProjectionActionField(f"fts/{after_row['id']}"),
                ordinal,
                before_fts,
                after_fts,
            )
        )
        return tuple(projections)

    @staticmethod
    def build_folder(
        row: Mapping[str, object],
        before: bytes | None,
        ordinal: int,
    ) -> ProjectionPlan:
        identity = str(row["id"])
        return ProjectionPlan(
            ProjectionActionTag.INDEX_REPLACE,
            None,
            folder_index_target(identity),
            ordinal,
            before,
            serialize_folder_index_row(row),
        )

    @staticmethod
    def _body(markdown: bytes) -> str:
        try:
            _meta, body = extract_frontmatter(markdown.decode("utf-8"))
        except UnicodeDecodeError as exc:
            raise ValueError("authoritative Markdown is not UTF-8") from exc
        return body

    @staticmethod
    def _markdown(row: Mapping[str, object], body: str) -> bytes:
        body_hash = hashlib.sha256(body.encode("utf-8")).hexdigest()
        metadata = {
            "id": row["id"],
            "title": row["title"],
            "tags": _tags(row.get("tags", "[]")),
            "folder_id": row.get("folder_id"),
            "content_hash": f"sha256:{body_hash}",
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
        }
        return wrap_with_frontmatter(metadata, body).encode("utf-8")

    @staticmethod
    def _note_index_blob(row: Mapping[str, object], path: str) -> bytes:
        return _json_blob(
            {
                "row": {
                    "category": row.get("category"),
                    "content_hash": row.get("content_hash", ""),
                    "created_at": row["created_at"],
                    "current_path": path,
                    "folder_id": row.get("folder_id"),
                    "is_deleted": row.get("trashed_at") is not None,
                    "level": row.get("level", "L1"),
                    "note_id": row["id"],
                    "status": row.get("status", "active"),
                    "summary": row.get("summary", ""),
                    "tags": row.get("tags", "[]"),
                    "title": row["title"],
                    "trashed_at": row.get("trashed_at"),
                    "updated_at": row["updated_at"],
                    "word_count": row.get("word_count", 0),
                }
            }
        )

    @staticmethod
    def _fts_blob(row: Mapping[str, object], body: str) -> bytes:
        return _json_blob({"content": body, "title": str(row["title"])})


class KnowledgeDomainPolicy:
    """Compile Note requests through the shared entity compiler and projections."""

    def __init__(self, builder: KnowledgeProjectionBuilder | None = None) -> None:
        self.builder = builder or KnowledgeProjectionBuilder()

    @property
    def entity_types(self) -> frozenset[str]:
        return frozenset({"note"})

    async def compile(
        self, context: MutationCompileContext, request: MutationRequest
    ) -> MutationCommand:
        if request.name == "knowledge.projection.rebuild":
            return self._compile_rebuild(context, request)
        if request.name not in {
            "knowledge.note.create",
            "knowledge.note.update",
            "knowledge.note.update_content",
            "knowledge.note.update_metadata",
            "knowledge.note.move",
        }:
            raise ValueError(f"unsupported knowledge mutation request: {request.name}")
        payload = dict(request.payload)
        content = payload.pop("content", None)
        creating = request.name == "knowledge.note.create"
        if creating and not isinstance(content, str):
            raise ValueError("note create content must be a string")
        if content is not None and not isinstance(content, str):
            raise ValueError("note content must be a string")
        if "tags" in payload:
            payload["tags"] = json.dumps(
                _tags(payload["tags"]),
                ensure_ascii=True,
                separators=(",", ":"),
            )
        if content is not None:
            payload["content_hash"] = hashlib.sha256(content.encode("utf-8")).hexdigest()
            payload["word_count"] = len(content.split())
        folder_id = payload.get("folder_id")
        if folder_id is not None:
            folder = context.authority.row("folder", folder_id)
            if folder is None or folder.get("trashed_at") is not None:
                raise MutationRuleViolation(
                    "relation_endpoint_missing",
                    {"entityType": "folder", "entityId": folder_id},
                )
        entity_request = MutationRequest.from_payload(
            name="entity.create" if creating else "entity.update",
            entity_type="note",
            entity_id=request.entity_id,
            payload=payload,
            expected_version=request.expected_version,
            client_updated_at=request.client_updated_at,
        )
        base = await compile_catalog_entity_command(context, entity_request)
        plan = base.db_plans[0]
        before_path = context.authority.note_path(request.entity_id)
        before_markdown = None if before_path is None else context.authority.markdown(before_path)
        projections = self.builder.build_note(
            before_row=plan.before_row,
            after_row=plan.after_row,
            before_path=before_path,
            before_markdown=before_markdown,
            body=content,
        )
        return context.command(
            request=request,
            db_plans=base.db_plans,
            sync_events=base.sync_events,
            value=base.result_value,
            projections=projections,
            resolution=base.resolution,
        )

    def _compile_rebuild(
        self, context: MutationCompileContext, request: MutationRequest
    ) -> MutationCommand:
        prepared_notes: list[
            tuple[Mapping[str, object], str, bytes, str, bytes | None, bytes | None]
        ] = []
        invalid_note_ids: list[str] = []
        for row in context.authority.rows("note"):
            note_id = str(row["id"])
            canonical_path = note_path(note_id, str(row["title"]), row.get("folder_id"))
            indexed_path = context.authority.note_path(note_id)
            source_path = indexed_path or canonical_path
            markdown = context.authority.markdown(source_path)
            if markdown is None and source_path != canonical_path:
                source_path = canonical_path
                markdown = context.authority.markdown(source_path)
            if markdown is None:
                invalid_note_ids.append(note_id)
                continue
            body = self.builder._body(markdown)
            if hashlib.sha256(body.encode("utf-8")).hexdigest() != row.get("content_hash"):
                invalid_note_ids.append(note_id)
                continue
            prepared_notes.append(
                (
                    row,
                    source_path,
                    markdown,
                    body,
                    context.authority.derived_projection(
                        ProjectionActionTag.INDEX_REPLACE,
                        f"index/notes/note_id/{note_id}",
                    ),
                    context.authority.derived_projection(
                        ProjectionActionTag.FTS_REPLACE,
                        f"fts/{note_id}",
                    ),
                )
            )
        if invalid_note_ids:
            raise MutationRuleViolation(
                "version_conflict",
                {
                    "noteIds": tuple(sorted(invalid_note_ids)),
                    "reason": "body_hash_mismatch",
                },
            )

        projections: list[ProjectionPlan] = []
        for row in context.authority.rows("folder"):
            target = folder_index_target(str(row["id"]))
            projections.append(
                self.builder.build_folder(
                    row,
                    context.authority.derived_projection(
                        ProjectionActionTag.INDEX_REPLACE, str(target)
                    ),
                    len(projections),
                )
            )
        for row, source_path, markdown, body, before_index, before_fts in prepared_notes:
            built = self.builder.build_note(
                before_row=row,
                after_row=row,
                before_path=source_path,
                before_markdown=markdown,
                body=body,
                before_index=before_index,
                before_fts=before_fts,
            )
            offset = len(projections)
            projections.extend(
                replace(projection, ordinal=offset + projection.ordinal) for projection in built
            )
        return context.command(
            request=request,
            db_plans=(),
            sync_events=(),
            value={
                "rebuiltFolders": len(context.authority.rows("folder")),
                "rebuiltNotes": len(prepared_notes),
            },
            projections=projections,
        )
