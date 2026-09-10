"""Read-only Task Space definition and project queries."""

from __future__ import annotations

import json
from collections.abc import Iterable, Mapping

from sqlalchemy import select

from app.errors import NotFoundError
from app.models.project import Project
from app.models.relation import Relation
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


# -- Derived dependency state (依赖域合同 §13) -------------------------------- #
#
# ★★ 派生状态绝不落库、也绝不进入 workItem 的规范行/同步载荷：
#    ``tests/test_task_space_tree.py`` 断言「查询行 == 同步 post-image 字段集」，
#    往规范行里塞派生字段会把它们一并推进同步协议（违反"派生状态不持久化"红线）。
#    所以这里只提供**纯函数**，由独立的投影端点暴露，前端用同一算法从
#    同步到的 relation 行本地重算（孤儿边容错也顺带在同一处处理）。

BLOCKING_RELATION_TYPES = frozenset({"depends_on", "blocks"})
TERMINAL_STATUS_CATEGORIES = frozenset({"completed", "cancelled"})


def derive_blocked_by_dependency(
    relations: Iterable[Mapping[str, object]],
    status_category_by_work_item: Mapping[str, str | None],
) -> dict[str, bool]:
    """Pure AND-semantics blocking map: ``{blocked_item_id: is_blocked}``.

    D16 (多上游 AND 语义): an item is blocked while **any** upstream blocker
    is still open.  Only ``depends_on`` / ``blocks`` edges block; an upstream
    that reached ``completed``/``cancelled`` stops blocking.

    Missing endpoints (``status_category_by_work_item`` has no entry) are
    treated as OPEN — a relation edge whose work item has not hydrated yet
    must never silently unblock something.
    """
    blocked: dict[str, bool] = {}
    for row in relations:
        if str(row["relation_type"]) not in BLOCKING_RELATION_TYPES:
            continue
        upstream_id = str(row["to_work_item_id"])
        category = status_category_by_work_item.get(upstream_id)
        if category in TERMINAL_STATUS_CATEGORIES:
            continue
        blocked[str(row["from_work_item_id"])] = True
    return blocked


def _depth_of(work_item_id: str, parent_by_id: Mapping[str, object]) -> int:
    """Depth from the authoritative parent chain (1-based, capped at 3)."""
    depth = 1
    cursor = parent_by_id.get(work_item_id)
    visited = {work_item_id}
    while cursor is not None:
        cursor_id = str(cursor)
        if cursor_id in visited or cursor_id not in parent_by_id:
            break
        visited.add(cursor_id)
        depth += 1
        cursor = parent_by_id.get(cursor_id)
    return depth


def compute_is_blocked(depth: int, blocked_by_dependency: bool) -> bool:
    """Aggregate the dependency signal into the single ``isBlocked`` flag.

    Only level-2 items are review units (level-1 are containers, level-3 do
    not accumulate focus time), so the aggregate flag is defined there.
    Additional system block bits would be OR-ed in here; the dependency
    signal is the only one in the first release.
    """
    return depth == 2 and blocked_by_dependency


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

    # -- Dependency domain ------------------------------------------------ #

    async def list_relations(
        self, scope: SpaceRuntimeHandle, work_item_id: str | None
    ) -> tuple[dict[str, object], ...]:
        """Every edge of this Space touching ``work_item_id`` (or all of them).

        Cross-Space edges cannot exist: the session is bound to one Space's
        database, so there is nothing to filter out — but the invariant is
        asserted by the compiler, which resolves both endpoints from the same
        authoritative overlay.
        """
        async with scope.session_factory() as session:
            statement = select(Relation).order_by(Relation.created_at, Relation.id)
            if work_item_id is not None:
                statement = statement.where(
                    (Relation.from_work_item_id == work_item_id)
                    | (Relation.to_work_item_id == work_item_id)
                )
            return tuple(_row(row) for row in (await session.execute(statement)).scalars())

    async def blocked_map(
        self, scope: SpaceRuntimeHandle, project_id: str | None
    ) -> dict[str, dict[str, bool]]:
        """Derived ``{work_item_id: {blockedByDependency, isBlocked}}``.

        Pure projection for the tree UI.  Never persisted, never synced — the
        client recomputes the same map from its local rows.
        """
        async with scope.session_factory() as session:
            relations = tuple(
                _row(row) for row in (
                    await session.execute(select(Relation))
                ).scalars()
            )
            statement = select(WorkItem)
            if project_id is not None:
                statement = statement.where(WorkItem.project_id == str(project_id))
            items = tuple(
                _row(row) for row in (await session.execute(statement)).scalars()
            )
            statuses = {
                str(row.id): row.category
                for row in (
                    await session.execute(select(StatusDefinition))
                ).scalars()
            }

        category_by_id = {
            str(item["id"]): statuses.get(str(item["status_definition_id"]))
            for item in items
        }
        blocked = derive_blocked_by_dependency(relations, category_by_id)
        # ``depth`` is derived, not a column: walk the authoritative parent
        # chain (same rule as routes/v1/work_items.py::_work_item_depths).
        parent_by_id = {str(item["id"]): item["parent_id"] for item in items}
        return {
            str(item["id"]): {
                "blockedByDependency": blocked.get(str(item["id"]), False),
                "isBlocked": compute_is_blocked(
                    _depth_of(str(item["id"]), parent_by_id),
                    blocked.get(str(item["id"]), False),
                ),
            }
            for item in items
        }

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
