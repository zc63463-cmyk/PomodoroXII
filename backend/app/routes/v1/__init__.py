"""V1 API router aggregation.

Builds the v1 API router by mounting every sub-router under
``/api/v1`` with an appropriate prefix and tag group.  Sub-routers are
imported lazily inside ``build_v1_router`` so that model / schema modules
are only loaded when the application actually wires up routes.
"""
from __future__ import annotations

from fastapi import APIRouter

from app.routes.v1.responses import V1_VALIDATION_ERROR_RESPONSES


def build_v1_router() -> APIRouter:
    """Build the v1 API router with all sub-routers."""
    router = APIRouter(
        prefix="/api/v1",
        responses=V1_VALIDATION_ERROR_RESPONSES,
    )

    # Sub-routers (alphabetically sorted; mounted in groups below).
    from app.routes.v1.active_session import router as active_session_router
    from app.routes.v1.auth import router as auth_router
    from app.routes.v1.folders import router as folders_router
    from app.routes.v1.habits import router as habits_router
    from app.routes.v1.meta import router as meta_router
    from app.routes.v1.notes import router as notes_router
    from app.routes.v1.projects import router as projects_router
    from app.routes.v1.quick_notes import router as quick_notes_router
    from app.routes.v1.reflections import router as reflections_router
    from app.routes.v1.schedules import router as schedules_router
    from app.routes.v1.settings import router as settings_router
    from app.routes.v1.spaces import router as spaces_router
    from app.routes.v1.stats import router as stats_router
    from app.routes.v1.sync import router as sync_router
    from app.routes.v1.time_blocks import router as time_blocks_router
    from app.routes.v1.trash import router as trash_router
    from app.routes.v1.work_item_notes import router as work_item_notes_router
    from app.routes.v1.work_items import router as work_items_router

    # Meta-layer (master token required).
    router.include_router(auth_router, prefix="/auth", tags=["auth"])
    router.include_router(spaces_router, prefix="/spaces", tags=["spaces"])
    router.include_router(meta_router, prefix="/meta", tags=["meta"])

    # Space-scoped entities (space token required).
    router.include_router(notes_router, prefix="/notes", tags=["notes"])
    router.include_router(folders_router, prefix="/folders", tags=["folders"])
    router.include_router(
        quick_notes_router, prefix="/quick-notes", tags=["quick-notes"]
    )
    router.include_router(
        reflections_router, prefix="/reflections", tags=["reflections"]
    )
    router.include_router(habits_router, prefix="/habits", tags=["habits"])
    router.include_router(schedules_router, prefix="/schedules", tags=["schedules"])
    router.include_router(
        time_blocks_router, prefix="/time-blocks", tags=["time-blocks"]
    )
    router.include_router(trash_router, prefix="/trash", tags=["trash"])
    router.include_router(stats_router, prefix="/stats", tags=["stats"])
    router.include_router(settings_router, prefix="/settings", tags=["settings"])
    router.include_router(sync_router, prefix="/sync", tags=["sync"])

    # Task Space contract routers (space token required).
    router.include_router(projects_router, prefix="/projects", tags=["projects"])
    router.include_router(work_items_router, prefix="/work-items", tags=["work-items"])
    router.include_router(
        work_item_notes_router, prefix="/work-items", tags=["work-item-notes"]
    )

    # Global ActiveSession coordination (master token required).
    router.include_router(
        active_session_router, prefix="/active-session", tags=["active-session"]
    )

    return router
