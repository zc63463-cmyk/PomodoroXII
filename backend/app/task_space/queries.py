"""Read-only Task Space definition and project queries."""

from __future__ import annotations

import json
from collections.abc import Mapping

from sqlalchemy import select

from app.errors import NotFoundError
from app.models.project import Project
from app.models.work_item import WorkItem
from app.models.work_item_definition import (
    Label,
    StatusDefinition,
    TypeDefinition,
    WorkItemLabel,
)
from app.models.work_item_note import WorkItemNote
from app.runtime.space import SpaceRuntimeHandle
from app.task_space.contracts import (
    TaskSpaceDefinitionsView,
    TaskSpacePage,
    TaskSpacePageQuery,
    TaskSpaceView,
)


def _row(model) -> dict[str, object]:
    return {column.name: getattr(model, column.name) for column in model.__table__.columns}


async def _project_label_ids(session, work_item_id: str) -> list[str]:
    """D5 Y: read-only label_ids projection from the junction table."""
    rows = tuple(
        (await session.execute(
            select(WorkItemLabel.label_id).where(
                WorkItemLabel.work_item_id == work_item_id
            )
        )).scalars()
    )
    return sorted(str(label_id) for label_id in rows)


def _work_item_row(model, label_ids: list[str]) -> dict[str, object]:
    row = _row(model)
    row["label_ids"] = label_ids
    return row


def _page(rows: tuple[Mapping[str, object], ...], query: TaskSpacePageQuery) -> TaskSpacePage:
    start = 0
    if query.cursor is not None:
        ids = [str(row["id"]) for row in rows]
        if query.cursor not in ids:
            raise ValueError("invalid_task_space_cursor")
        start = ids.index(query.cursor) + 1
    selected = rows[start : start + query.limit]
    has_more = start + len(selected) < len(rows)
    return TaskSpacePage(
        items=selected,
        next_cursor=str(selected[-1]["id"]) if selected and has_more else None,
    )


class DefaultTaskSpaceQueryModule:
    async def list_definitions(
        self, scope: SpaceRuntimeHandle
    ) -> TaskSpaceDefinitionsView:
        async with scope.session_factory() as session:
            statuses = tuple(
                _row(row) for row in (
                    await session.execute(
                        select(StatusDefinition).order_by(StatusDefinition.rank, StatusDefinition.id)
                    )
                ).scalars()
            )
            types = tuple(
                _row(row) for row in (
                    await session.execute(
                        select(TypeDefinition).order_by(TypeDefinition.rank, TypeDefinition.id)
                    )
                ).scalars()
            )
            labels = tuple(
                _row(row) for row in (
                    await session.execute(
                        select(Label).order_by(Label.name, Label.id)
                    )
                ).scalars()
            )
        return TaskSpaceDefinitionsView(statuses, types, labels)

    async def list_projects(
        self, scope: SpaceRuntimeHandle, query: TaskSpacePageQuery
    ) -> TaskSpacePage:
        async with scope.session_factory() as session:
            statement = select(Project).order_by(Project.rank, Project.id)
            if not bool(query.filters.get("include_archived", False)):
                statement = statement.where(Project.archived_at.is_(None))
            rows = tuple(_row(row) for row in (await session.execute(statement)).scalars())
        return _page(rows, query)

    async def get_project(
        self, scope: SpaceRuntimeHandle, project_id: str
    ) -> TaskSpaceView:
        async with scope.session_factory() as session:
            row = await session.get(Project, project_id)
        if row is None:
            raise NotFoundError("Project not found")
        return TaskSpaceView(_row(row))

    async def list_work_items(
        self, scope: SpaceRuntimeHandle, query: TaskSpacePageQuery
    ) -> TaskSpacePage:
        project_id = query.filters.get("project_id")
        rows: list[dict[str, object]] = []
        async with scope.session_factory() as session:
            statement = select(WorkItem)
            if project_id is not None:
                statement = statement.where(WorkItem.project_id == str(project_id))
            result = await session.execute(
                statement.order_by(
                    WorkItem.parent_id.isnot(None),
                    WorkItem.parent_id.asc(),
                    WorkItem.child_rank.asc(),
                    WorkItem.id.asc(),
                )
            )
            for row in result.scalars():
                rows.append(
                    _work_item_row(row, await _project_label_ids(session, str(row.id)))
                )
        return _page(tuple(rows), query)

    async def get_work_item(
        self, scope: SpaceRuntimeHandle, work_item_id: str
    ) -> TaskSpaceView:
        async with scope.session_factory() as session:
            row = await session.get(WorkItem, work_item_id)
            if row is None:
                raise NotFoundError("WorkItem not found")
            value = _work_item_row(row, await _project_label_ids(session, work_item_id))
        return TaskSpaceView(value)

    async def read_note(
        self: "DefaultTaskSpaceQueryModule",
        scope: SpaceRuntimeHandle,
        work_item_id: str,
    ) -> TaskSpaceView | None:
        async with scope.session_factory() as session:
            row = (
                await session.execute(
                    select(WorkItemNote).where(
                        WorkItemNote.work_item_id == work_item_id
                    )
                )
            ).scalar_one_or_none()
        if row is None:
            return None
        value = _row(row)
        raw = json.loads(str(value["document_json"]))
        value["document"] = raw
        value["content_version"] = raw.get(
            "contentVersion", raw.get("content_version")
        )
        value["write_supported"] = value["content_version"] == 1
        return TaskSpaceView(value)
