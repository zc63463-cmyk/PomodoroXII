"""Real MutationUnitOfWork integration for the ActiveSession coordinator.

Drives ``activate_provisional`` through the real writer path: children execute
through a *real* ``MutationUnitOfWork`` (real compiler + interpreter +
journal + recovery gate over real SQLite Space databases), envelopes/receipts
land in the real Space DBs, and the recovery authority reads back the same
data through its full ``inspect_read_only`` entry.

This mirrors the ``test_mutation_recovery`` fixture pattern (real UoW
components + real SQLite + minimal lease/stage scaffolding) instead of the
full runtime bootstrap, which is not viable in this sandboxed environment.
"""

from __future__ import annotations

import json
import shutil
import sqlite3
from contextlib import asynccontextmanager
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
from sqlalchemy.ext.asyncio import AsyncEngine

from app.auth.authority import Principal
from app.db.migrations import run_migrations
from app.db.session import create_engine, create_session_factory
from app.focus_session.contracts import ActiveSessionCommand
from app.focus_session.coordinator import (
    ActiveSessionCoordinationError,
    ProductionActiveSessionCoordinator,
)
from app.focus_session.query import FocusSessionQuery
from app.mutation.types import canonical_payload_hash

NOW = "2026-07-15T08:00:00.000Z"


def _clock() -> str:
    return NOW


def _master_principal() -> Principal:
    return Principal(subject="master-1", token_type="master", epoch=0, expires_at=None)


def _pair_payload(active: tuple[str, str], candidate: tuple[str, str]) -> dict[str, object]:
    return {
        "pair": {
            "active": {"space_id": active[0], "session_id": active[1]},
            "candidate": {"space_id": candidate[0], "session_id": candidate[1]},
        },
        "cached_at": "2026-07-15T07:59:00.000Z",
        "cached_ownership_epoch": 1,
        "owner_device_id": "device-1",
        "owner_tab_id": "tab-1",
        "snapshot": {
            "session": {
                "session_revision": 1,
                "started_at": "2026-07-15T07:59:00.000Z",
                "planned_seconds": 1500,
                "gross_seconds": 60,
                "paused_seconds": 0,
                "break_seconds": 0,
                "focused_seconds": 60,
                "validity": "pending",
                "review_state": "not_required",
                "ownership_state": "local_provisional",
                "session_note": "",
            },
            "context": {
                "project_id": "project-1",
                "project_title_snapshot": "Project",
                "level2_work_item_id": "wi-l2",
                "level2_title_snapshot": "WorkItem",
                "level2_status_definition_id_snapshot": "complete",
                "level2_version_snapshot": 1,
                "linked_at": "2026-07-15T07:59:00.000Z",
                "link_method": "explicit",
            },
            "plan": [],
        },
        "expected_work_item_versions": {"wi-l2": 1},
    }


def _activate_command(op: str) -> ActiveSessionCommand:
    payload = _pair_payload(("space-a", "fs-1"), ("space-b", "fs-2"))
    return ActiveSessionCommand(
        command_id=op,
        space_id="space-a",
        session_id="fs-1",
        ownership_epoch=None,
        payload_hash=canonical_payload_hash(payload),
        payload=payload,
    )


def _structure_snapshot() -> str:
    return json.dumps(
        {
            "project": {"id": "project-1", "name": "Project"},
            "level2": {
                "id": "wi-l2", "title": "WorkItem", "parent_id": None,
                "status_definition_id": "complete", "version": 1,
                "effort_estimate_lower_seconds": None,
                "effort_estimate_upper_seconds": None,
            },
            "plan": {},
        },
        sort_keys=True,
        separators=(",", ":"),
    )


def _seed_focus_session(db_path: str, session_id: str) -> None:
    with sqlite3.connect(db_path) as conn:
        conn.execute(
            "INSERT OR IGNORE INTO focus_sessions "
            "(id, session_revision, started_at, planned_seconds, gross_seconds, "
            "paused_seconds, break_seconds, focused_seconds, validity, review_state, "
            "ownership_state, session_note, version, created_at, updated_at) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                session_id, 1, NOW, 1500, 0, 0, 0, 0,
                "pending", "not_required", "activation_conflict", "", 1, NOW, NOW,
            ),
        )
        conn.execute(
            "INSERT OR IGNORE INTO session_task_contexts "
            "(id, session_id, project_id, level2_work_item_id, title_snapshot, "
            "structure_snapshot, linked_at, link_method, version, created_at, updated_at) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            (
                f"ctx-{session_id}", session_id, "project-1", "wi-l2",
                "WorkItem", _structure_snapshot(), NOW, "manual", 1, NOW, NOW,
            ),
        )
        conn.execute(
            "INSERT OR IGNORE INTO session_attribution_revisions "
            "(id, session_id, revision, project_id, level2_work_item_id, reason, "
            "corrected_from_revision, effective, version, created_at, updated_at) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            (
                f"attr-{session_id}-1", session_id, 1, "project-1", "wi-l2",
                None, None, 1, 1, NOW, NOW,
            ),
        )
        conn.commit()


def _stage_authority(path: Path):
    from app.runtime.contained_io import BoundDirectoryHandle, BoundStageDirectory

    path.mkdir(parents=True, exist_ok=True)
    parent = BoundDirectoryHandle._create(path.parent)
    try:
        return BoundStageDirectory._from_parent_handle(parent, path.name)
    finally:
        parent._close()


class _DiskProjection:
    """Small restartable projection authority (mirrors test_mutation_recovery)."""

    def __init__(self, root: Path) -> None:
        self.root = root
        self.root.mkdir(parents=True, exist_ok=True)
        self.state_path = self.root / "state.json"
        if not self.state_path.exists():
            self._save({"markdown": {}, "index": {}, "fts": {}})

    def _load(self) -> dict[str, dict[str, str]]:
        return json.loads(self.state_path.read_text(encoding="utf-8"))

    def _save(self, value: dict[str, dict[str, str]]) -> None:
        self.state_path.write_text(
            json.dumps(value, sort_keys=True, separators=(",", ":")),
            encoding="utf-8",
        )

    def _bucket(self, target: str) -> str:
        return (
            "markdown"
            if target.startswith("notes/")
            else ("index" if target.startswith("index/") else "fts")
        )

    def _apply(self, action, receipt) -> None:
        receipt.assert_current()
        state = self._load()
        tag = action.tag.value
        target = str(action.target)
        if tag == "path_rename":
            source = str(action.source)
            source_bucket = self._bucket(source)
            target_bucket = self._bucket(target)
            value = state[source_bucket].pop(source, None)
            if value is None:
                value = state[target_bucket].get(target)
            if value is not None:
                state[target_bucket][target] = value
        elif tag == "path_remove":
            state[self._bucket(target)].pop(target, None)
        else:
            bucket = self._bucket(target)
            if action.blob is None:
                state[bucket].pop(target, None)
            else:
                state[bucket][target] = action.blob.hex()
        self._save(state)

    def _apply_projection_markdown_write(self, action, receipt) -> None:
        self._apply(action, receipt)

    def _apply_projection_path_rename(self, action, receipt) -> None:
        self._apply(action, receipt)

    def _apply_projection_path_remove(self, action, receipt) -> None:
        self._apply(action, receipt)

    def _apply_projection_index_replace(self, action, receipt) -> None:
        self._apply(action, receipt)

    def _apply_projection_fts_replace(self, action, receipt) -> None:
        self._apply(action, receipt)

    async def snapshot_projection_authority(self) -> Any:
        from app.file_system.interfaces import ProjectionAuthoritySnapshot

        state = self._load()
        return ProjectionAuthoritySnapshot(
            {key: bytes.fromhex(value) for key, value in state["markdown"].items()},
            {key: bytes.fromhex(value) for key, value in state["index"].items()},
            {key: bytes.fromhex(value) for key, value in state["fts"].items()},
        )


class _Lease:
    def __init__(self, mode: Any, scope: str) -> None:
        self.mode = mode
        self.scope = scope
        self.owner_task = None

    def assert_active_owner(self, *, mode=None, scope=None, **_kwargs) -> None:
        import asyncio

        current = asyncio.current_task()
        if self.owner_task is None:
            self.owner_task = current
        if self.owner_task is not current:
            raise RuntimeError("lease owner Task changed")
        if mode is not None and mode is not self.mode:
            raise RuntimeError("lease mode changed")
        if scope is not None and scope != self.scope:
            raise RuntimeError("lease scope changed")

    def fence_receipt(self, scope: str) -> Any:
        self.assert_active_owner(scope=scope)
        return _Receipt()


class _Receipt:
    def assert_current(self) -> None:
        return None


def _real_uow():
    """A fully real MutationUnitOfWork composition (mirrors bootstrap)."""
    from app.deps import build_mutation_compiler
    from app.file_system.engine.base import FileSystemProjectionExecutor
    from app.mutation.journal import MutationJournal
    from app.mutation.recovery import MutationRecovery
    from app.mutation.unit_of_work import DbMutationInterpreter, MutationUnitOfWork
    from app.registry import CATALOG

    interpreter = DbMutationInterpreter(CATALOG)
    projection_executor = FileSystemProjectionExecutor()
    recovery = MutationRecovery(
        catalog=CATALOG,
        interpreter=interpreter,
        projection_executor=projection_executor,
    )
    return MutationUnitOfWork(
        catalog=CATALOG,
        compiler=build_mutation_compiler(CATALOG),
        interpreter=interpreter,
        projection_executor=projection_executor,
        recovery_gate=recovery,
        journal_factory=MutationJournal,
    )


def _real_handle(db_path: str, space_id: str, root: Path) -> SimpleNamespace:
    from app.mutation.staging import StageStore
    from app.runtime.leases import LeaseMode

    engine = create_engine(f"sqlite+aiosqlite:///{db_path}")
    sessions = create_session_factory(engine)
    stage_store = StageStore(_stage_authority(root / f"stages-{space_id}"))
    global_lease = _Lease(LeaseMode.SHARED, "global")
    space_lease = _Lease(LeaseMode.EXCLUSIVE, space_id)

    @asynccontextmanager
    async def exclusive_space_resources(purpose: str, timeout_seconds: int):
        assert (purpose, timeout_seconds) == ("mutation", 5)
        yield space_lease

    handle = SimpleNamespace(
        scope=SimpleNamespace(space_id=space_id),
        file_system=_DiskProjection(root / f"projection-{space_id}"),
        mutation_stages=stage_store,
        session_factory=sessions,
        global_lease=global_lease,
        space_lease=space_lease,
        _runtime=None,
        _engine=engine,
        _stages=stage_store,
        exclusive_space_resources=exclusive_space_resources,
    )
    return handle


async def _close_handle(handle: SimpleNamespace) -> None:
    getattr(handle, "_stages").close()
    await getattr(handle, "_engine").dispose()




@pytest.fixture(scope="session")
def uow_template(tmp_path_factory: pytest.TempPathFactory) -> dict[str, Path]:
    root = tmp_path_factory.mktemp("uow-template")
    meta = root / "meta.db"
    space_a = root / "space-a.db"
    space_b = root / "space-b.db"
    run_migrations("meta", meta)
    run_migrations("space", space_a)
    run_migrations("space", space_b)
    return {"meta": meta, "space-a": space_a, "space-b": space_b}


@pytest.fixture
def uow_env(tmp_path: Path, uow_template: dict[str, Path]) -> dict[str, Path]:
    paths: dict[str, Path] = {}
    for key, source in uow_template.items():
        target = tmp_path / f"{key}.db"
        shutil.copy2(source, target)
        paths[key] = target
    return paths

@pytest.mark.asyncio
async def test_activate_provisional_via_real_uow(
    tmp_path: Path, uow_env: dict[str, Path]
) -> None:
    meta = uow_env["meta"]
    space_a = uow_env["space-a"]
    space_b = uow_env["space-b"]

    _seed_focus_session(str(space_a), "fs-1")
    _seed_focus_session(str(space_b), "fs-2")

    engine = create_engine(f"sqlite+aiosqlite:///{meta}")
    meta_factory = create_session_factory(engine)
    uow = _real_uow()
    handle_a = _real_handle(str(space_a), "space-a", tmp_path)
    handle_b = _real_handle(str(space_b), "space-b", tmp_path)
    handles = {"space-a": handle_a, "space-b": handle_b}

    async def space_handle_provider(space_id: str) -> Any:
        return handles[space_id]

    coordinator = ProductionActiveSessionCoordinator(
        meta_session_factory=meta_factory,
        uow=uow,
        space_handle_provider=space_handle_provider,
        session_query=FocusSessionQuery(),
        clock=_clock,
    )

    op = "op-conflict"
    await coordinator.activate_provisional(_master_principal(), _activate_command(op))

    # 1) phase advanced only after both children terminal-success
    from sqlalchemy import select

    from app.db.models.meta import ActiveSessionOperation

    async with meta_factory() as session:
        operation = await session.get(ActiveSessionOperation, op)
        assert operation is not None
        assert operation.phase == "awaiting_resolution"

    # 2) real envelopes + receipts landed in the real Space DBs
    from app.models.session_command import SessionCommandEnvelope, SessionCommandReceipt

    for space_id, session_id in (("space-a", "fs-1"), ("space-b", "fs-2")):
        async with handles[space_id].session_factory() as session:
            envelopes = (
                await session.execute(
                    select(SessionCommandEnvelope).where(
                        SessionCommandEnvelope.session_id == session_id
                    )
                )
            ).scalars().all()
            assert len(envelopes) == 1, space_id
            receipt = await session.get(SessionCommandReceipt, envelopes[0].command_id)
            assert receipt is not None and receipt.state == "succeeded"

    # 3) the shared authority reads the SAME data via the full entry
    from app.focus_session.recovery_authority import (
        CLASSIFICATION_AWAITING_RESOLUTION,
        ActiveSessionCoordinationInspector,
    )
    from app.knowledge.consistency import SpaceDataView

    inspector = ActiveSessionCoordinationInspector()
    meta_view = SimpleNamespace(db_path=str(meta))
    space_views = {
        "space-a": SpaceDataView(
            "space-a", space_a, tmp_path / "notes-a", tmp_path / "index-a.db", "0" * 64
        ),
        "space-b": SpaceDataView(
            "space-b", space_b, tmp_path / "notes-b", tmp_path / "index-b.db", "0" * 64
        ),
    }
    decision = await inspector.inspect_read_only(meta_view, space_views=space_views)
    assert decision.classification == CLASSIFICATION_AWAITING_RESOLUTION
    assert decision.child_outcomes and all(
        outcome.terminal_success for outcome in decision.child_outcomes
    )

    # 4) cleanup every handle
    await _close_handle(handle_a)
    await _close_handle(handle_b)
    await engine.dispose()


@pytest.mark.asyncio
async def test_activate_child_failure_keeps_claimed_via_real_uow(
    tmp_path: Path, uow_env: dict[str, Path]
) -> None:
    """A missing candidate Session makes the real UoW child fail; the Meta
    operation stays ``claimed`` with the intent preserved."""
    meta = uow_env["meta"]
    space_a = uow_env["space-a"]
    space_b = uow_env["space-b"]

    # Only the active Session exists; the candidate child (real policy
    # compile) is rejected because its Session row is missing.
    _seed_focus_session(str(space_a), "fs-1")

    engine = create_engine(f"sqlite+aiosqlite:///{meta}")
    meta_factory = create_session_factory(engine)
    uow = _real_uow()
    handle_a = _real_handle(str(space_a), "space-a", tmp_path)
    handle_b = _real_handle(str(space_b), "space-b", tmp_path)
    handles = {"space-a": handle_a, "space-b": handle_b}

    async def space_handle_provider(space_id: str) -> Any:
        return handles[space_id]

    coordinator = ProductionActiveSessionCoordinator(
        meta_session_factory=meta_factory,
        uow=uow,
        space_handle_provider=space_handle_provider,
        session_query=FocusSessionQuery(),
        clock=_clock,
    )

    with pytest.raises(ActiveSessionCoordinationError):
        await coordinator.activate_provisional(
            _master_principal(), _activate_command("op-fail")
        )

    from app.db.models.meta import ActiveSessionOperation

    async with meta_factory() as session:
        operation = await session.get(ActiveSessionOperation, "op-fail")
        assert operation is not None
        assert operation.phase == "claimed"
        assert "children" in operation.intent_json

    await _close_handle(handle_a)
    await _close_handle(handle_b)
    await engine.dispose()
