"""Non-committing Folder and Note application service."""

from __future__ import annotations

from collections.abc import Mapping

from app.commands import EntityCommand
from app.knowledge.commands import KnowledgeCommands
from app.mutation.types import BatchMutationResult, MutationResult, bounded_child_operation_id
from app.mutation.unit_of_work import MutationUnitOfWork
from app.runtime.space import SpaceRuntimeHandle


class KnowledgeStore:
    """Route all knowledge writes through one durable mutation unit of work."""

    def __init__(
        self,
        *,
        commands: KnowledgeCommands,
        entity_commands: EntityCommand,
        uow: MutationUnitOfWork,
    ) -> None:
        self.commands = commands
        self.entity_commands = entity_commands
        self.uow = uow

    async def create_folder(
        self,
        scope: SpaceRuntimeHandle,
        payload: Mapping[str, object],
        expected_version: int | None,
        operation_id: str,
    ) -> MutationResult:
        request = self.entity_commands.create(
            scope,
            "folder",
            payload,
            expected_version,
        )
        return await self.uow.execute(scope, request, operation_id)

    async def update_folder(
        self,
        scope: SpaceRuntimeHandle,
        folder_id: str,
        patch: Mapping[str, object],
        expected_version: int,
        operation_id: str,
    ) -> MutationResult:
        request = self.entity_commands.update(
            scope,
            "folder",
            folder_id,
            patch,
            expected_version,
        )
        return await self.uow.execute(scope, request, operation_id)

    async def move_folder(
        self,
        scope: SpaceRuntimeHandle,
        folder_id: str,
        parent_id: str | None,
        expected_version: int,
        operation_id: str,
    ) -> MutationResult:
        return await self.update_folder(
            scope,
            folder_id,
            {"parent_id": parent_id},
            expected_version,
            operation_id,
        )

    async def create_note(
        self,
        scope: SpaceRuntimeHandle,
        payload: Mapping[str, object],
        expected_version: int | None,
        operation_id: str,
    ) -> MutationResult:
        request = self.commands.create_note_request(payload, expected_version)
        return await self.uow.execute(scope, request, operation_id)

    async def update_note_content(
        self,
        scope: SpaceRuntimeHandle,
        note_id: str,
        content: str,
        expected_version: int,
        operation_id: str,
    ) -> MutationResult:
        request = self.commands.update_note_content_request(
            note_id,
            content,
            expected_version,
        )
        return await self.uow.execute(scope, request, operation_id)

    async def update_note_metadata(
        self,
        scope: SpaceRuntimeHandle,
        note_id: str,
        patch: Mapping[str, object],
        expected_version: int,
        operation_id: str,
    ) -> MutationResult:
        request = self.commands.update_note_metadata_request(
            note_id,
            patch,
            expected_version,
        )
        return await self.uow.execute(scope, request, operation_id)

    async def update_note(
        self,
        scope: SpaceRuntimeHandle,
        note_id: str,
        patch: Mapping[str, object],
        expected_version: int,
        operation_id: str,
    ) -> MutationResult:
        request = self.commands.update_note_request(
            note_id,
            patch,
            expected_version,
        )
        return await self.uow.execute(scope, request, operation_id)

    async def move_note(
        self,
        scope: SpaceRuntimeHandle,
        note_id: str,
        folder_id: str | None,
        expected_version: int,
        operation_id: str,
    ) -> MutationResult:
        request = self.commands.move_note_request(
            note_id,
            folder_id,
            expected_version,
        )
        return await self.uow.execute(scope, request, operation_id)

    async def purge_note(
        self,
        scope: SpaceRuntimeHandle,
        note_id: str,
        expected_version: int,
        operation_id: str,
    ) -> MutationResult:
        request = self.commands.purge_note_request(note_id, expected_version)
        return await self.uow.execute(scope, request, operation_id)

    async def purge_folder(
        self,
        scope: SpaceRuntimeHandle,
        folder_id: str,
        expected_version: int,
        operation_id: str,
    ) -> BatchMutationResult:
        """Hard-delete a folder and all its descendants (trashed or not).

        Descendants are deleted deepest-first so that child rows are removed
        before parent rows.  Each descendant becomes a separate operation in
        the batch, sharing one visibility barrier.
        """
        from app.mutation.unit_of_work import AuthorityOverlay

        # Read all folders from the authority overlay (locked snapshot)
        # to avoid TOCTOU: the snapshot is taken under the same lease
        # that will guard the batch execution.
        async with scope.session_factory() as session:
            authority = await AuthorityOverlay.from_locked_authorities(
                scope, session, self.uow.catalog,
            )

        folder_rows = authority.rows("folder")

        # Build parent->children map from authority snapshot.
        children_map: dict[str, list[str]] = {}
        for row in folder_rows:
            parent_id = row.get("parent_id")
            if parent_id is not None:
                children_map.setdefault(str(parent_id), []).append(
                    str(row["id"])
                )

        def _descendants_deepest_first(folder_id: str) -> list[str]:
            """Post-order traversal: children before parents."""
            result: list[str] = []
            for child_id in sorted(children_map.get(folder_id, [])):
                result.extend(_descendants_deepest_first(child_id))
                result.append(child_id)
            return result

        all_ids = _descendants_deepest_first(folder_id)
        all_ids.append(folder_id)

        # Build individual purge requests for each folder (deepest-first).
        requests = []
        operation_ids = []
        for idx, fid in enumerate(all_ids):
            if fid == folder_id:
                exp_ver = expected_version
            else:
                row = authority.row("folder", fid)
                exp_ver = row["version"] if row else None
            req = self.commands.purge_folder_request(
                fid,
                expected_version=exp_ver,
            )
            requests.append(req)
            operation_ids.append(
                bounded_child_operation_id(operation_id, f"{idx:04d}")
            )

        return await self.uow.execute_batch(
            scope, requests, batch_id=operation_id,
            operation_ids=operation_ids,
        )

    async def restore_note(
        self,
        scope: SpaceRuntimeHandle,
        note_id: str,
        expected_version: int,
        operation_id: str,
    ) -> MutationResult:
        request = self.commands.update_note_request(
            note_id, {"trashed_at": None}, expected_version,
        )
        return await self.uow.execute(scope, request, operation_id)

    async def restore_folder(
        self,
        scope: SpaceRuntimeHandle,
        folder_id: str,
        expected_version: int,
        operation_id: str,
    ) -> MutationResult:
        request = self.entity_commands.update(
            scope, "folder", folder_id, {"trashed_at": None}, expected_version,
        )
        return await self.uow.execute(scope, request, operation_id)

    async def restore_quick_note(
        self,
        scope: SpaceRuntimeHandle,
        quick_note_id: str,
        expected_version: int,
        operation_id: str,
    ) -> MutationResult:
        request = self.entity_commands.update(
            scope, "quick_note", quick_note_id,
            {"trashed_at": None}, expected_version,
        )
        return await self.uow.execute(scope, request, operation_id)

    async def soft_delete_folder(
        self,
        scope: SpaceRuntimeHandle,
        folder_id: str,
        expected_version: int,
        operation_id: str,
    ) -> MutationResult:
        """Cascade soft-delete a folder and all its descendants.

        Delegates to ``entity_commands.delete`` which triggers
        ``FolderDomainPolicy._compile_cascade_soft_delete`` to trash
        the folder and every non-trashed descendant in one durable
        mutation.  The mutation pipeline handles sync events and
        INDEX_REPLACE projections atomically.
        """
        request = self.entity_commands.delete(
            scope, "folder", folder_id, expected_version,
        )
        return await self.uow.execute(scope, request, operation_id)

    async def convert_quick_note(
        self,
        scope: SpaceRuntimeHandle,
        quick_note_id: str,
        expected_version: int,
        operation_id: str,
    ):
        import hashlib
        import json

        from sqlalchemy import select

        from app.models.memo_comment import MemoComment
        from app.models.quick_note import QuickNote
        from app.mutation.types import bounded_child_operation_id

        # Deterministic timestamp for idempotent retry.
        # archived_at is derived from the operation_id hash so the same
        # operation_id always produces the same request_hash.
        ts_hex = hashlib.sha256(
            f"{operation_id}\0ts".encode("ascii")
        ).hexdigest()[:12]
        ts_seconds = 1577836800 + (int(ts_hex, 16) % 946080000)
        from datetime import datetime, timezone
        archived_at = datetime.fromtimestamp(
            ts_seconds, tz=timezone.utc
        ).strftime("%Y-%m-%dT%H:%M:%S.000Z")

        # Read quick note and comments via scope.session_factory.
        async with scope.session_factory() as session:
            qn = await session.get(QuickNote, quick_note_id)
            if qn is None:
                raise ValueError(
                    f"quick note {quick_note_id} not found"
                )
            if qn.trashed_at is not None:
                from app.errors import ValidationError

                raise ValidationError(
                    f"QuickNote {quick_note_id} is in trash; restore before converting"
                )
            if qn.archived_at is not None or qn.migrated_to_note_id is not None:
                from app.errors import ConflictError

                raise ConflictError(f"QuickNote {quick_note_id} already converted")
            comments = (
                await session.execute(
                    select(MemoComment)
                    .where(MemoComment.note_id == quick_note_id)
                    .order_by(MemoComment.created_at, MemoComment.id)
                )
            ).scalars().all()

        # Deterministic note ID from operation_id.
        note_id = hashlib.sha256(
            f"{operation_id}\0note".encode("ascii")
        ).hexdigest()[:32]

        # Derive title from content.
        raw = (qn.content or "").strip()
        title = raw[:80] + ("..." if len(raw) > 80 else "")
        if not title:
            title = "(converted quick note)"
        tags = json.loads(qn.tags) if qn.tags else []

        # Build derivation map for INTENT persistence.
        # This map is embedded in the note create payload and popped by
        # the knowledge compiler so it stays in the command_json but
        # does not leak into the after_row.
        comment_mapping: dict[str, dict[str, str]] = {}
        for comment in comments:
            cid = hashlib.sha256(
                f"{operation_id}\0memo_comment\0{comment.id}".encode("ascii")
            ).hexdigest()[:32]
            cop = bounded_child_operation_id(
                operation_id, f"memo:{comment.id}",
            )
            comment_mapping[str(comment.id)] = {
                "new_id": cid,
                "child_op_id": cop,
            }

        derivation_map: dict[str, object] = {
            "note_id": note_id,
            "archived_at": archived_at,
            "comment_mapping": comment_mapping,
        }

        # Build batch requests with deterministic operation IDs.
        requests = []
        operation_ids = []

        # 1. Note create
        note_op = bounded_child_operation_id(operation_id, "note")
        requests.append(self.commands.create_note_request(
            {
                "id": note_id,
                "title": title,
                "content": qn.content or "",
                "tags": tags,
                "folder_id": qn.folder_id,
                "derivation_map": derivation_map,
            },
            expected_version=None,
        ))
        operation_ids.append(note_op)

        # 2. QuickNote CAS update (archive + link to new note)
        qn_op = bounded_child_operation_id(operation_id, "quicknote")
        requests.append(self.entity_commands.update(
            scope, "quick_note", quick_note_id,
            {
                "archived_at": archived_at,
                "migrated_to_note_id": note_id,
            },
            expected_version,
        ))
        operation_ids.append(qn_op)

        # 3. MemoComment copies with deterministic IDs
        for comment in comments:
            comment_id = hashlib.sha256(
                f"{operation_id}\0memo_comment\0{comment.id}".encode("ascii")
            ).hexdigest()[:32]
            comment_op = bounded_child_operation_id(
                operation_id, f"memo:{comment.id}",
            )
            requests.append(self.entity_commands.create(
                scope, "memo_comment",
                {
                    "id": comment_id,
                    "note_id": note_id,
                    "content": comment.content,
                },
                expected_version=None,
            ))
            operation_ids.append(comment_op)

        result = await self.uow.execute_batch(
            scope, requests, batch_id=operation_id,
            operation_ids=operation_ids,
        )
        if result.rejected:
            from app.errors import MutationRejectedError
            raise MutationRejectedError(result.rejected[0])
        return result
