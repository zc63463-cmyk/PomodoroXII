"""Non-committing Folder and Note application service."""

from __future__ import annotations

from collections.abc import Mapping

from app.commands import EntityCommand
from app.knowledge.commands import KnowledgeCommands
from app.mutation.types import MutationResult
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
    ) -> MutationResult:
        request = self.commands.purge_folder_request(folder_id, expected_version)
        return await self.uow.execute(scope, request, operation_id)

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
            comments = (
                await session.execute(
                    select(MemoComment).where(
                        MemoComment.note_id == quick_note_id
                    )
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

        return await self.uow.execute_batch(
            scope, requests, batch_id=operation_id,
            operation_ids=operation_ids,
        )
