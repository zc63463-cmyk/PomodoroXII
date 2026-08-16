"""Tests for the H2-A sync event ledger (sync_outbox service).

Verifies:
- record_sync_event appends one row per call.
- Repeated mutations produce distinct events (no dedup).
- Transaction rollback also rolls back ledger rows.
- payload with NaN is rejected (strict JSON).
- BaseService create/update/delete append events when entity_type is set.
- BaseService skips events when record_sync_events=False (sync_mode).
- flush=False defers the flush to the caller.
"""

from __future__ import annotations

import ast
import asyncio
import json
from math import nan
from pathlib import Path

import pytest
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import async_sessionmaker

from app.models.habit import Habit
from app.models.sync_outbox import SyncOutbox
from app.models.sync_state import SyncState
from app.services.base import BaseService
from app.services.sync_outbox import get_current_cursor, record_sync_event


def test_every_record_sync_event_call_chooses_visibility_explicitly():
    """Ledger callers must declare whether an event is pull-visible."""
    backend_root = Path(__file__).resolve().parents[1]
    calls: list[tuple[Path, ast.Call]] = []
    for source_path in (
        *sorted((backend_root / "app").rglob("*.py")),
        *sorted((backend_root / "tests").rglob("*.py")),
    ):
        tree = ast.parse(source_path.read_text(encoding="utf-8"))
        calls.extend(
            (source_path.relative_to(backend_root), node)
            for node in ast.walk(tree)
            if isinstance(node, ast.Call)
            and isinstance(node.func, ast.Name)
            and node.func.id == "record_sync_event"
        )

    assert calls
    for source_path, call in calls:
        visibility = [keyword.value for keyword in call.keywords if keyword.arg == "visible"]
        assert len(visibility) == 1, f"{source_path}:{call.lineno} must set visible explicitly"
        assert isinstance(visibility[0], ast.Constant) and type(visibility[0].value) is bool
        if source_path == Path("app/mutation/unit_of_work.py"):
            assert visibility[0].value is False
        elif source_path == Path("app/mutation/recovery.py"):
            assert visibility[0].value is False
        elif source_path.parts[:2] == ("app", "services"):
            assert visibility[0].value is True
        elif source_path.parts[0] == "app":
            pytest.fail(f"unowned sync ledger writer: {source_path}:{call.lineno}")

    certification = tuple(
        (source_path, call)
        for source_path, call in calls
        if source_path == Path("tests/fixtures/certification/populate_n_minus_one.py")
    )
    assert len(certification) == 2
    assert all(
        next(keyword.value.value for keyword in call.keywords if keyword.arg == "visible") is True
        for _source_path, call in certification
    )


@pytest.mark.asyncio
async def test_record_sync_event_appends_one_row(space_session):
    """A single call must produce exactly one ledger row."""
    await record_sync_event(
        space_session,
        entity_type="habit",
        entity_id="hab_test_001",
        action="create",
        payload={"title": "Test Habit"},
        visible=True,
    )
    rows = (await space_session.execute(select(SyncOutbox))).scalars().all()
    assert len(rows) == 1
    assert rows[0].entity_type == "habit"
    assert rows[0].entity_id == "hab_test_001"
    assert rows[0].action == "create"
    assert rows[0].version is None
    assert rows[0].visible is True
    assert json.loads(rows[0].payload)["title"] == "Test Habit"


@pytest.mark.asyncio
async def test_record_sync_event_keeps_repeated_mutations_as_distinct_events(space_session):
    """Two mutations on the same entity must produce two separate rows."""
    await record_sync_event(
        space_session,
        entity_type="habit",
        entity_id="hab_dup",
        action="create",
        payload={"title": "First"},
        visible=True,
    )
    await record_sync_event(
        space_session,
        entity_type="habit",
        entity_id="hab_dup",
        action="update",
        payload={"title": "Second"},
        visible=True,
    )
    rows = (
        (await space_session.execute(select(SyncOutbox).where(SyncOutbox.entity_id == "hab_dup")))
        .scalars()
        .all()
    )
    assert len(rows) == 2
    assert rows[0].action == "create"
    assert rows[1].action == "update"


@pytest.mark.asyncio
async def test_record_sync_event_rejects_nan_in_payload(space_session):
    """NaN must be rejected — it is not valid JSON."""
    with pytest.raises(ValueError, match="Out of range float"):
        await record_sync_event(
            space_session,
            entity_type="habit",
            entity_id="hab_nan",
            action="create",
            payload={"score": nan},
            visible=True,
        )


@pytest.mark.asyncio
async def test_record_sync_event_flush_false_does_not_assign_id_until_caller_flushes(
    space_session,
):
    """flush=False must defer ID assignment to the caller's flush."""
    event = await record_sync_event(
        space_session,
        entity_type="habit",
        entity_id="hab_noflush",
        action="create",
        visible=True,
        flush=False,
    )
    # Without flush, the DB has not assigned an id yet.
    assert event.id is None

    await space_session.flush()
    assert event.id is not None

    rows = (
        (
            await space_session.execute(
                select(SyncOutbox).where(SyncOutbox.entity_id == "hab_noflush")
            )
        )
        .scalars()
        .all()
    )
    assert len(rows) == 1
    assert rows[0].id is not None
    assert await get_current_cursor(space_session) == event.id


@pytest.mark.asyncio
async def test_base_service_mutations_append_create_update_delete_events(space_session):
    """BaseService CRUD must append create/update/delete events."""

    class _HabitService(BaseService):
        model = Habit
        entity_type = "habit"

    svc = _HabitService(space_session)
    obj = await svc.create({"id": "hab_crud", "title": "CRUD Test"})
    assert obj.id == "hab_crud"

    await svc.update("hab_crud", {"title": "Updated"})
    await svc.delete("hab_crud")

    rows = (
        (
            await space_session.execute(
                select(SyncOutbox)
                .where(SyncOutbox.entity_id == "hab_crud")
                .order_by(SyncOutbox.id.asc())
            )
        )
        .scalars()
        .all()
    )
    assert len(rows) == 3
    assert rows[0].action == "create"
    assert rows[1].action == "update"
    assert rows[2].action == "delete"


@pytest.mark.asyncio
async def test_base_service_skips_events_when_record_sync_events_false(space_session):
    """sync_mode (record_sync_events=False) must not write ledger events."""

    class _HabitService(BaseService):
        model = Habit
        entity_type = "habit"

    svc = _HabitService(space_session, record_sync_events=False)
    await svc.create({"id": "hab_silent", "title": "Silent"})

    rows = (
        (
            await space_session.execute(
                select(SyncOutbox).where(SyncOutbox.entity_id == "hab_silent")
            )
        )
        .scalars()
        .all()
    )
    assert len(rows) == 0


@pytest.mark.asyncio
async def test_rollback_rolls_back_ledger_rows(space_session):
    """If the surrounding transaction rolls back, ledger rows must disappear."""
    async with space_session.begin_nested() as savepoint:
        await record_sync_event(
            space_session,
            entity_type="habit",
            entity_id="hab_rb",
            action="create",
            payload={"title": "Rollback Me"},
            visible=False,
        )
        await savepoint.rollback()

    rows = (
        (await space_session.execute(select(SyncOutbox).where(SyncOutbox.entity_id == "hab_rb")))
        .scalars()
        .all()
    )
    assert len(rows) == 0
    assert await get_current_cursor(space_session) == 0
    state = await space_session.get(SyncState, 1)
    assert state is not None
    assert state.current_cursor == 0


@pytest.mark.asyncio
async def test_record_sync_event_advances_current_cursor_for_invisible_rows(space_session):
    """The allocated ledger cursor includes rows omitted from pull responses."""
    visible_event = await record_sync_event(
        space_session,
        entity_type="habit",
        entity_id="hab_visible",
        action="create",
        visible=True,
    )
    invisible_event = await record_sync_event(
        space_session,
        entity_type="habit",
        entity_id="hab_invisible",
        action="update",
        visible=False,
    )

    state = await space_session.get(SyncState, 1)
    assert visible_event.id < invisible_event.id
    assert state is not None
    assert state.current_cursor == invisible_event.id
    assert await get_current_cursor(space_session) == invisible_event.id


@pytest.mark.asyncio
async def test_missing_sync_state_fallback_preserves_allocated_cursor(space_session):
    visible_event = await record_sync_event(
        space_session,
        entity_type="habit",
        entity_id="fallback-visible",
        action="create",
        visible=True,
    )
    invisible_event = await record_sync_event(
        space_session,
        entity_type="habit",
        entity_id="fallback-invisible",
        action="update",
        visible=False,
    )
    assert visible_event.id < invisible_event.id
    await space_session.execute(delete(SyncState).where(SyncState.id == 1))
    await space_session.flush()

    assert await get_current_cursor(space_session) == invisible_event.id


@pytest.mark.asyncio
async def test_concurrent_sqlite_writers_commit_in_ledger_id_order(space_session):
    """同一 space 的多连接写事务必须串行，后提交者不能获得更小 cursor。"""
    assert space_session.bind is not None
    sessions = async_sessionmaker(space_session.bind, expire_on_commit=False)
    first = sessions()
    second = sessions()
    first_ready = asyncio.Event()
    release_first = asyncio.Event()
    commit_order: list[str] = []

    async def writer_one():
        event_row = await record_sync_event(
            first, entity_type="habit", entity_id="writer-1", action="create", visible=True
        )
        first_ready.set()
        await release_first.wait()
        await first.commit()
        commit_order.append("writer-1")
        return event_row.id

    async def writer_two():
        await first_ready.wait()
        event_row = await record_sync_event(
            second, entity_type="habit", entity_id="writer-2", action="create", visible=True
        )
        await second.commit()
        commit_order.append("writer-2")
        return event_row.id

    first_task = asyncio.create_task(writer_one())
    second_task = asyncio.create_task(writer_two())
    await first_ready.wait()
    await asyncio.sleep(0)
    release_first.set()
    first_id, second_id = await asyncio.gather(first_task, second_task)
    await first.close()
    await second.close()

    assert commit_order == ["writer-1", "writer-2"]
    assert first_id < second_id


@pytest.mark.asyncio
async def test_record_sync_event_payload_is_sorted_and_utf8_safe(space_session):
    """payload JSON must use sort_keys and ensure_ascii=False."""
    await record_sync_event(
        space_session,
        entity_type="habit",
        entity_id="hab_utf8",
        action="create",
        payload={"z": "last", "a": "first", "unicode": "你好世界"},
        visible=True,
    )
    row = (
        (await space_session.execute(select(SyncOutbox).where(SyncOutbox.entity_id == "hab_utf8")))
        .scalars()
        .first()
    )
    raw = row.payload
    assert raw.index('"a"') < raw.index('"unicode"') < raw.index('"z"')
    assert "你好世界" in raw


# --------------------------------------------------------------------------- #
# S3 Exit Gate — AST authority regression tests (Task 11 Step 3)
# --------------------------------------------------------------------------- #

import subprocess
import sys
import textwrap


def _run_authority_gate(app_root: Path) -> subprocess.CompletedProcess[str]:
    """Run check_backend_authority.py against *app_root* and capture output."""
    backend_root = Path(__file__).resolve().parents[1]
    script = backend_root / "scripts" / "check_backend_authority.py"
    result = subprocess.run(
        [sys.executable, str(script), "--app-root", str(app_root)],
        capture_output=True,
        text=True,
    )
    return result


def _make_minimal_app(app_root: Path) -> None:
    """Create the minimal directory structure the gate requires.

    Includes one safe SyncOutbox read so the gate's ``read_count > 0``
    invariant is satisfied.
    """
    routes_dir = app_root / "routes" / "v1"
    routes_dir.mkdir(parents=True, exist_ok=True)
    for route_file in (
        "notes.py",
        "folders.py",
        "quick_notes.py",
        "trash.py",
        "schedules.py",
        "habits.py",
        "reflections.py",
        "time_blocks.py",
    ):
        (routes_dir / route_file).write_text("", encoding="utf-8")
    runtime_dir = app_root / "runtime"
    runtime_dir.mkdir(parents=True, exist_ok=True)
    (runtime_dir / "space.py").write_text("class SpaceRuntimeHandle:\n    pass\n", encoding="utf-8")
    commands_dir = app_root / "commands"
    commands_dir.mkdir(parents=True, exist_ok=True)
    (commands_dir / "entity.py").write_text("class EntityCommand:\n    pass\n", encoding="utf-8")
    services_dir = app_root / "services"
    services_dir.mkdir(parents=True, exist_ok=True)
    (services_dir / "ledger.py").write_text(
        textwrap.dedent("""\
            from sqlalchemy import select
            from app.models.sync_outbox import SyncOutbox

            async def read_visible(session):
                return await session.scalars(
                    select(SyncOutbox).where(SyncOutbox.visible.is_(True))
                )
        """),
        encoding="utf-8",
    )


def test_s3_exit_ast_gate_rejects_orm_alias_and_raw_route_writes(tmp_path):
    """The gate must reject route files that use ORM write methods,
    ORM attribute assignment, raw SQL writes, and aliased insert/update/delete.

    RED: create a route with every forbidden pattern and verify the gate
    rejects it.  GREEN: an empty route passes.
    """
    app_root = tmp_path / "app"
    _make_minimal_app(app_root)

    # --- RED: write a route that violates every ORM/raw-SQL rule ---
    bad_route = app_root / "routes" / "v1" / "notes.py"
    bad_route.write_text(
        textwrap.dedent("""\
            from sqlalchemy import text
            from app.models import SyncOutbox

            async def handler(db):
                db.add(SyncOutbox())
                db.commit()
                db.flush()
                db.execute(text("UPDATE sync_outbox SET visible=1"))
                obj = SyncOutbox()
                obj.visible = True
                db.delete(SyncOutbox())
        """),
        encoding="utf-8",
    )
    result = _run_authority_gate(app_root)
    assert result.returncode != 0, "gate must reject ORM writes and raw SQL"
    stderr = result.stderr
    assert "forbidden route ORM write" in stderr, f"missing ORM write check: {stderr}"
    assert "forbidden route call" in stderr, f"missing commit/flush check: {stderr}"
    assert "direct SQL write execute" in stderr or "raw SQL write" in stderr, (
        f"missing raw SQL write check: {stderr}"
    )
    assert "forbidden route ORM attribute assignment" in stderr, (
        f"missing attribute assignment check: {stderr}"
    )

    # --- GREEN: replace with a clean route ---
    bad_route.write_text("async def handler():\n    pass\n", encoding="utf-8")
    result = _run_authority_gate(app_root)
    assert result.returncode == 0, f"clean app must pass: {result.stderr}"
    assert "AUTHORITY_GATE_OK" in result.stdout


def test_s3_exit_ast_gate_requires_visible_as_top_level_and_conjunct(tmp_path):
    """Every SyncOutbox read must have visible.is_(True) as a top-level
    AND conjunct.  Visibility under OR/NOT/IfExp or in a separate
    non-conjunct position must be rejected.

    RED: create a service file with unsafe visibility placements.
    GREEN: fix them to be top-level AND conjuncts.
    """
    app_root = tmp_path / "app"
    _make_minimal_app(app_root)

    services_dir = app_root / "services"
    services_dir.mkdir(parents=True, exist_ok=True)

    # --- RED: visibility under OR is forbidden ---
    bad_service = services_dir / "bad_sync.py"
    bad_service.write_text(
        textwrap.dedent("""\
            from sqlalchemy import or_, select
            from app.models.sync_outbox import SyncOutbox

            async def bad_read(session):
                return await session.scalars(
                    select(SyncOutbox).where(
                        or_(SyncOutbox.visible.is_(True), SyncOutbox.id > 0)
                    )
                )
        """),
        encoding="utf-8",
    )
    result = _run_authority_gate(app_root)
    assert result.returncode != 0, "gate must reject OR-nested visibility"
    assert "visibility under OR/NOT/IfExp is forbidden" in result.stderr, (
        f"missing OR/NOT check: {result.stderr}"
    )

    # --- RED: visibility is not a top-level conjunct (missing entirely) ---
    bad_service.write_text(
        textwrap.dedent("""\
            from sqlalchemy import select
            from app.models.sync_outbox import SyncOutbox

            async def bad_read(session):
                return await session.scalars(
                    select(SyncOutbox).where(SyncOutbox.id > 0)
                )
        """),
        encoding="utf-8",
    )
    result = _run_authority_gate(app_root)
    assert result.returncode != 0, "gate must reject missing visibility"
    assert "visible predicate must be a top-level AND conjunct" in result.stderr, (
        f"missing top-level conjunct check: {result.stderr}"
    )

    # --- GREEN: visible.is_(True) as a top-level AND conjunct ---
    bad_service.write_text(
        textwrap.dedent("""\
            from sqlalchemy import select
            from app.models.sync_outbox import SyncOutbox

            async def good_read(session):
                return await session.scalars(
                    select(SyncOutbox).where(
                        SyncOutbox.visible.is_(True),
                        SyncOutbox.id > 0,
                    )
                )
        """),
        encoding="utf-8",
    )
    result = _run_authority_gate(app_root)
    assert result.returncode == 0, f"clean read must pass: {result.stderr}"
    assert "AUTHORITY_GATE_OK" in result.stdout


def test_s3_exit_ast_gate_discovers_assignment_aliased_module_and_raw_sql_reads(
    tmp_path,
):
    """The gate must discover SyncOutbox reads that use assignment aliases
    (e.g. ``Box = SyncOutbox``), module-qualified references, and static
    raw SQL ``SELECT ... sync_outbox`` reads — and reject them if they
    lack a visible predicate or use raw SQL.

    RED: create files with aliased and raw SQL reads.
    GREEN: fix the aliased read to include visible, remove raw SQL.
    """
    app_root = tmp_path / "app"
    _make_minimal_app(app_root)

    services_dir = app_root / "services"
    services_dir.mkdir(parents=True, exist_ok=True)

    # --- RED: assignment alias ``Box = SyncOutbox`` without visible ---
    bad_service = services_dir / "aliased_sync.py"
    bad_service.write_text(
        textwrap.dedent("""\
            from sqlalchemy import select
            from app.models.sync_outbox import SyncOutbox

            Box = SyncOutbox

            async def aliased_read(session):
                return await session.scalars(
                    select(Box).where(Box.id > 0)
                )
        """),
        encoding="utf-8",
    )
    result = _run_authority_gate(app_root)
    assert result.returncode != 0, "gate must discover assignment-aliased reads"
    assert "visible predicate must be a top-level AND conjunct" in result.stderr, (
        f"missing alias discovery: {result.stderr}"
    )

    # --- RED: static raw SQL SELECT with sync_outbox ---
    bad_service.write_text(
        textwrap.dedent("""\
            from sqlalchemy import text

            async def raw_read(session):
                return await session.execute(text("SELECT * FROM sync_outbox"))
        """),
        encoding="utf-8",
    )
    result = _run_authority_gate(app_root)
    assert result.returncode != 0, "gate must reject raw SQL sync_outbox reads"
    assert "raw SQL SyncOutbox read is forbidden" in result.stderr, (
        f"missing raw SQL read check: {result.stderr}"
    )

    # --- GREEN: aliased read with visible predicate ---
    bad_service.write_text(
        textwrap.dedent("""\
            from sqlalchemy import select
            from app.models.sync_outbox import SyncOutbox

            Box = SyncOutbox

            async def aliased_read(session):
                return await session.scalars(
                    select(Box).where(Box.visible.is_(True))
                )
        """),
        encoding="utf-8",
    )
    result = _run_authority_gate(app_root)
    assert result.returncode == 0, f"clean aliased read must pass: {result.stderr}"
    assert "AUTHORITY_GATE_OK" in result.stdout


def test_s3_exit_ast_gate_allows_allocated_ledger_aggregates(tmp_path):
    app_root = tmp_path / "app"
    _make_minimal_app(app_root)
    aggregate_service = app_root / "services" / "ledger_stats.py"
    aggregate_service.write_text(
        """
from sqlalchemy import func, select
from app.models.sync_outbox import SyncOutbox

async def get_current_cursor(session):
    return await session.scalar(select(func.max(SyncOutbox.id)))
""",
        encoding="utf-8",
    )
    result = _run_authority_gate(app_root)
    assert result.returncode == 0, result.stderr


def test_s3_exit_ast_gate_covers_not_ifexp_dead_and_positive_controls(tmp_path):
    app_root = tmp_path / "app"
    _make_minimal_app(app_root)
    service = app_root / "services" / "matrix.py"

    red_cases = (
        (
            """
from sqlalchemy import not_, select
from app.models.sync_outbox import SyncOutbox
async def read(session):
    return await session.scalars(select(SyncOutbox).where(not_(SyncOutbox.visible.is_(True))))
""",
            "visibility under OR/NOT/IfExp is forbidden",
        ),
        (
            """
from sqlalchemy import select
from app.models.sync_outbox import SyncOutbox
async def read(session, flag):
    return await session.scalars(select(SyncOutbox).where(
        SyncOutbox.visible.is_(True) if flag else SyncOutbox.id > 0
    ))
""",
            "visibility under OR/NOT/IfExp is forbidden",
        ),
        (
            """
from sqlalchemy import select
from app.models.sync_outbox import SyncOutbox
async def read(session):
    if False:
        return await session.scalars(select(SyncOutbox).where(SyncOutbox.id > 0))
    return None
""",
            "statically dead SyncOutbox read is forbidden",
        ),
    )
    for source, message in red_cases:
        service.write_text(textwrap.dedent(source), encoding="utf-8")
        result = _run_authority_gate(app_root)
        assert result.returncode != 0
        assert message in result.stderr

    service.write_text(
        textwrap.dedent(
            """
from sqlalchemy import or_, select, text
from app.models.sync_outbox import SyncOutbox

async def safe_aggregate(session):
    return await session.execute(text("SELECT COUNT(*) FROM tasks"))

async def safe_chain(session):
    return await session.scalars(
        select(SyncOutbox)
        .where(SyncOutbox.visible.is_(True), or_(SyncOutbox.id > 0, SyncOutbox.id == 0))
        .order_by(SyncOutbox.id)
    )
"""
        ),
        encoding="utf-8",
    )
    result = _run_authority_gate(app_root)
    assert result.returncode == 0, result.stderr
