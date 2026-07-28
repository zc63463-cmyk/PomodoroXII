"""TS1 Task Space test fixture: frozen clock, command/query adapters."""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

from app.commands.entity import EntityCommand
from app.mutation.types import canonical_payload_hash
from app.task_space.contracts import (
    SYSTEM_STATUS_IDS,
    CreateProject,
    CreateWorkItem,
    MutateWorkItem,
    NoteCommandKind,
    WorkItemNoteCommand,
)
from app.task_space.module import DefaultTaskSpaceCommandModule
from app.task_space.queries import DefaultTaskSpaceQueryModule


@dataclass
class FrozenClock:
    current: datetime = datetime(2026, 1, 1, tzinfo=timezone.utc)

    def now_iso_ms(self) -> str:
        return self.current.isoformat(timespec="milliseconds").replace("+00:00", "Z")

    def tick(self, milliseconds: int = 1) -> str:
        self.current += timedelta(milliseconds=milliseconds)
        return self.now_iso_ms()


@dataclass
class TaskSpaceFixture:
    mutation: object
    clock: FrozenClock
    module: DefaultTaskSpaceCommandModule
    queries: DefaultTaskSpaceQueryModule
    entity_commands: EntityCommand

    @property
    def scope(self):
        return self.mutation.scope

    @property
    def uow(self):
        return self.mutation.uow

    @property
    def catalog(self):
        return self.mutation.catalog

    @property
    def space_id(self) -> str:
        return str(self.scope.scope.space_id)

    def overlay_snapshot(self):
        return self.mutation.overlay_snapshot()

    async def visible_events(self, **filters):
        return await self.mutation.visible_events(**filters)

    def inject_fault(self, name: str) -> None:
        self.mutation.inject_fault(name)

    async def restart(self) -> None:
        restarted = await self.mutation.restart()
        if restarted is not None:
            self.mutation = restarted
        self.module = DefaultTaskSpaceCommandModule(self.mutation.uow)
        self.entity_commands = EntityCommand(self.mutation.catalog)

    async def recover(self) -> None:
        await self.mutation.recover()

    async def create_project(
        self,
        *,
        command_id: str,
        key: str,
        name: str | None = None,
        description: str | None = None,
    ):
        payload = {
            "key": key,
            "name": name or f"Project {key.strip()}",
            "description": description,
        }
        return await self.module.execute(
            self.scope,
            CreateProject(
                command_id=command_id,
                space_id=self.space_id,
                payload_hash=canonical_payload_hash(payload),
                payload=payload,
            ),
        )

    def create_work_item_command(
        self,
        *,
        command_id: str,
        project_id: str,
        title: str,
        parent_id: str | None = None,
        description: str | None = None,
        type_definition_id: str | None = None,
        status_definition_id: str | None = None,
        priority: str | None = None,
    ) -> CreateWorkItem:
        business = {
            "title": title,
            "description": description,
            "parent_id": parent_id,
            "type_definition_id": type_definition_id,
            "status_definition_id": status_definition_id,
            "priority": priority,
        }
        return CreateWorkItem(
            command_id=command_id,
            space_id=self.space_id,
            project_id=project_id,
            payload_hash=canonical_payload_hash(business),
            **business,
        )

    async def create_work_item(
        self,
        project_id: str,
        title: str,
        parent_id: str | None,
        command_id: str,
        **overrides,
    ):
        command = self.create_work_item_command(
            command_id=command_id,
            project_id=project_id,
            title=title,
            parent_id=parent_id,
            **overrides,
        )
        return await self.module.execute(self.scope, command)

    async def read_project(self, project_id: str) -> dict[str, object]:
        return dict((await self.queries.get_project(self.scope, project_id)).value)

    async def read_work_item(self, work_item_id: str) -> dict[str, object]:
        return dict((await self.queries.get_work_item(self.scope, work_item_id)).value)

    async def update_work_item(
        self, command_id: str, work_item_id: str, expected_version: int, patch: dict
    ):
        business = {"patch": patch}
        command = MutateWorkItem(
            command_id=command_id,
            space_id=self.space_id,
            work_item_id=work_item_id,
            expected_version=expected_version,
            payload_hash=canonical_payload_hash(business),
            payload={"operation": "update", **business},
        )
        return await self.module.execute(self.scope, command)

    async def move(
        self,
        work_item_id: str,
        project_id: str,
        new_parent_id: str | None,
        command_id: str,
        *,
        child_rank: int = 0,
    ):
        current = await self.read_work_item(work_item_id)
        business = {"new_parent_id": new_parent_id, "child_rank": child_rank}
        command = MutateWorkItem(
            command_id=command_id,
            space_id=self.space_id,
            work_item_id=work_item_id,
            expected_version=int(current["version"]),
            payload_hash=canonical_payload_hash(business),
            payload={"operation": "move", "project_id": project_id, **business},
        )
        return await self.module.execute(self.scope, command)

    async def transition_work_item(
        self,
        command_id: str,
        work_item_id: str,
        expected_version: int,
        status_definition_id: str,
    ):
        business = {"status_definition_id": status_definition_id}
        command = MutateWorkItem(
            command_id=command_id,
            space_id=self.space_id,
            work_item_id=work_item_id,
            expected_version=expected_version,
            payload_hash=canonical_payload_hash(business),
            payload={"operation": "transition", **business},
        )
        return await self.module.execute(self.scope, command)

    def status_id(self, category: str) -> str:
        return SYSTEM_STATUS_IDS[category]

    def _seed_key(self, prefix: str) -> str:
        return f"S{hashlib.sha256(prefix.encode()).hexdigest()[:5]}".upper()

    async def seed_level2(self, prefix: str) -> dict[str, object]:
        project = await self.create_project(
            command_id=f"{prefix}-project", key=self._seed_key(prefix)
        )
        root = await self.create_work_item(
            project.value["id"], "Root", None, f"{prefix}-root"
        )
        child = await self.create_work_item(
            project.value["id"], "Level 2", root.value["id"], f"{prefix}-level2"
        )
        return dict(child.value)

    async def seed_level3(self, prefix: str) -> dict[str, object]:
        level2 = await self.seed_level2(prefix)
        child = await self.create_work_item(
            str(level2["project_id"]),
            "Level 3",
            str(level2["id"]),
            f"{prefix}-level3",
        )
        return dict(child.value)

    async def seed_out_of_order_tree(self):
        project = await self.create_project(
            command_id="page-project", key=self._seed_key("page-project")
        )
        root_b = await self.create_work_item(
            project.value["id"], "Root B", None, "page-root-b"
        )
        root_a = await self.create_work_item(
            project.value["id"], "Root A", None, "page-root-a"
        )
        child = await self.create_work_item(
            project.value["id"], "Child", root_a.value["id"], "page-child"
        )
        rows = [dict(result.value) for result in (root_b, root_a, child)]
        ordered = sorted(
            rows,
            key=lambda row: (
                row["parent_id"] is not None,
                str(row["parent_id"] or ""),
                int(row["child_rank"]),
                str(row["id"]),
            ),
        )
        return SimpleNamespace(
            project_id=project.value["id"],
            ids_in_parent_child_rank_id_order=tuple(row["id"] for row in ordered),
        )

    def _note_command(
        self,
        kind: NoteCommandKind,
        command_id: str,
        work_item_id: str,
        expected_version: int | None,
        payload: dict[str, object],
    ) -> WorkItemNoteCommand:
        business = {
            key: value
            for key, value in payload.items()
            if key != "expected_source_work_item_version"
        }
        return WorkItemNoteCommand(
            kind=kind,
            command_id=command_id,
            space_id=self.space_id,
            work_item_id=work_item_id,
            expected_version=expected_version,
            payload_hash=canonical_payload_hash(business),
            payload=payload,
        )

    async def replace_document(
        self, command_id: str, work_item_id: str, expected_version, document
    ):
        raw = (
            document.model_dump(by_alias=True, mode="json", exclude_none=True)
            if hasattr(document, "model_dump")
            else document
        )
        command = self._note_command(
            NoteCommandKind.REPLACE_DOCUMENT,
            command_id,
            work_item_id,
            expected_version,
            {"document": raw},
        )
        return await self.module.execute(self.scope, command)

    async def append_blocks(
        self, command_id: str, work_item_id: str, expected_version: int, blocks
    ):
        command = self._note_command(
            NoteCommandKind.APPEND_BLOCKS,
            command_id,
            work_item_id,
            expected_version,
            {"blocks": list(blocks)},
        )
        return await self.module.execute(self.scope, command)

    async def toggle_checklist_item(
        self,
        command_id: str,
        work_item_id: str,
        expected_version: int,
        item_id: str,
        checked: bool,
        *,
        block_id: str = "c1",
    ):
        payload = {"block_id": block_id, "item_id": item_id, "checked": checked}
        command = self._note_command(
            NoteCommandKind.TOGGLE_CHECKLIST_ITEM,
            command_id,
            work_item_id,
            expected_version,
            payload,
        )
        return await self.module.execute(self.scope, command)

    async def seed_note(self, prefix: str) -> dict[str, object]:
        owner = await self.seed_level3(prefix)
        result = await self.replace_document(
            f"{prefix}-note",
            str(owner["id"]),
            None,
            {
                "contentVersion": 1,
                "blocks": [
                    {"blockId": "seed", "type": "paragraph", "text": "Seed"}
                ],
            },
        )
        return dict(result.value)

    def replace_command(self, note: dict, command_id: str, text: str):
        return self._note_command(
            NoteCommandKind.REPLACE_DOCUMENT,
            command_id,
            str(note["work_item_id"]),
            int(note["version"]),
            {
                "document": {
                    "contentVersion": 1,
                    "blocks": [
                        {"blockId": "replace", "type": "paragraph", "text": text}
                    ],
                }
            },
        )

    def sync_event(
        self,
        *,
        entity_type: str,
        entity_id: str,
        action: str,
        payload: dict[str, object],
        expected_version: int | None,
        client_updated_at: str | None = None,
    ):
        return SimpleNamespace(
            entity_type=entity_type,
            entity_id=entity_id,
            action=action,
            payload=payload,
            expected_version=expected_version,
            client_updated_at=client_updated_at or self.clock.tick(),
        )
