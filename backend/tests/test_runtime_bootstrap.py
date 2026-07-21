from __future__ import annotations

import asyncio

import pytest


@pytest.mark.asyncio
async def test_init_meta_db_only_opens_an_already_migrated_meta(
    _isolate_env, monkeypatch: pytest.MonkeyPatch
) -> None:
    import app.db.meta_session as meta_session
    from app.db.migrations import run_migrations
    from app.settings import settings

    await asyncio.to_thread(run_migrations, "meta", settings.meta_db_path)

    def forbidden_migration(*_args, **_kwargs):
        raise AssertionError("init_meta_db must not own migration authority")

    monkeypatch.setattr(
        meta_session, "run_migrations", forbidden_migration, raising=False
    )
    await meta_session.init_meta_db()
    await meta_session.close_meta_db()


async def _register_space(space_id: str, name: str) -> None:
    from app.db.meta_session import close_meta_db, get_meta_session, init_meta_db
    from app.db.models.meta import Space
    from app.settings import settings

    await init_meta_db()
    async for session in get_meta_session():
        session.add(
            Space(
                id=space_id,
                name=name,
                db_path=str(settings.space_db_path(space_id)),
                notes_dir=str(settings.space_notes_dir(space_id)),
            )
        )
        await session.commit()
        break
    await close_meta_db()


@pytest.mark.asyncio
async def test_registered_space_is_prepared_before_runtime_ready(
    _isolate_env, space_storage_provisioner
) -> None:
    from app.runtime.bootstrap import OwnerExecutorState, bootstrap_runtime
    from app.settings import settings

    space_id = "space-a"
    root = settings.canonical_spaces_root / space_id
    settings.space_notes_dir(space_id).mkdir(parents=True)
    await space_storage_provisioner(space_id)
    await _register_space(space_id, "A")

    async with bootstrap_runtime("test") as services:
        assert services.executor.state is OwnerExecutorState.READY
        services.runtime.assert_ready()
        assert services.recovery_provider is services.runtime.recovery_provider
        assert services.mutation_uow is services.recovery_provider
        assert await services.runtime.get_registered(space_id) is not None
        assert (root / "index.db").is_file()

    assert services.executor.state is OwnerExecutorState.CLOSED


@pytest.mark.asyncio
async def test_missing_registered_space_aborts_startup(_isolate_env) -> None:
    from app.errors import SpaceStorageMissingError
    from app.runtime.bootstrap import bootstrap_runtime

    await _register_space("missing", "Missing")

    with pytest.raises(SpaceStorageMissingError):
        async with bootstrap_runtime("test"):
            pytest.fail("missing storage must not reach readiness")
