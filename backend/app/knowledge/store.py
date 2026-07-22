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
