"""FastAPI application factory for PomodoroXII."""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response

from app.body_size_limit import BodySizeLimitMiddleware
from app.deps import require_master_token
from app.errors import register_exception_handlers
from app.logging import setup_logging
from app.middleware import RequestIdMiddleware, SecurityHeadersMiddleware
from app.rate_limit import RateLimitMiddleware
from app.schemas.common import ErrorResponse, HealthResponse
from app.settings import settings

logger = logging.getLogger("pomodoroxi")


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Application lifespan: initialise resources on startup, clean up on shutdown."""
    setup_logging(logging.INFO if not settings.debug else logging.DEBUG)

    logger.info("PomodoroXII API starting up (env=%s)", settings.environment)

    # --- Startup ---
    from app.db.meta_session import close_meta_db, init_meta_db
    from app.space_manager import dispose_space_engine_manager, get_space_engine_manager

    try:
        await init_meta_db()
        logger.info("Meta database initialised.")
    except Exception as exc:
        logger.critical("Failed to initialise meta database: %s", exc, exc_info=True)
        raise

    # Warm up the space engine manager singleton.
    get_space_engine_manager()

    # Startup backup: snapshot each space's DB if backup_enabled.
    if settings.backup_enabled:
        from sqlalchemy import select

        from app.db.meta_session import get_meta_session
        from app.db.models.meta import Space
        from app.file_system.backup import BackupService

        try:
            async for session in get_meta_session():
                spaces = (await session.execute(select(Space))).scalars().all()
                break
            for space in spaces:
                db_path = settings.space_db_path(space.id)
                if not db_path.exists():
                    continue
                backup_dir = settings.spaces_data_dir / space.id / ".meta" / "backups"
                BackupService.create_backup(db_path, backup_dir)
        except Exception as exc:
            logger.error("Startup backup failed: %s", exc, exc_info=True)

    logger.info("PomodoroXII API ready.")
    yield

    # --- Shutdown ---
    logger.info("PomodoroXII API shutting down.")
    await dispose_space_engine_manager()
    await close_meta_db()


def create_app() -> FastAPI:
    """Build and configure the FastAPI application."""
    app = FastAPI(
        title="PomodoroXII API",
        version="0.1.0",
        description="PomodoroXII backend API (multi-space rewrite)",
        lifespan=lifespan,
    )

    app.add_middleware(
        BodySizeLimitMiddleware,
        max_bytes=settings.request_body_max_bytes,
    )
    app.add_middleware(RateLimitMiddleware, trusted_proxies=settings.trusted_proxy_cidrs)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.add_middleware(SecurityHeadersMiddleware)
    app.add_middleware(RequestIdMiddleware)

    register_exception_handlers(app)

    # Mount v1 API routes
    from app.routes.v1 import build_v1_router
    app.include_router(build_v1_router())

    @app.get("/api/health", response_model=HealthResponse)
    async def health_check() -> dict:
        """Health check endpoint for orchestrators / load balancers."""
        return {"status": "ok", "version": "0.1.0"}

    @app.get(
        "/api/ready",
        responses={503: {"description": "Database unavailable", "model": ErrorResponse}},
    )
    async def readiness_check() -> Response:
        """Verify meta database connectivity without exposing failures."""
        from sqlalchemy import text

        from app.db.meta_session import get_meta_session_factory

        try:
            factory = get_meta_session_factory()
            async with factory() as session:
                await session.execute(text("SELECT version_num FROM alembic_version_meta LIMIT 1"))
                connection = await session.connection()
                await connection.exec_driver_sql("SAVEPOINT readiness_probe")
                try:
                    await connection.exec_driver_sql(
                        "CREATE TEMP TABLE readiness_write_probe (value INTEGER)"
                    )
                    await connection.exec_driver_sql(
                        "INSERT INTO readiness_write_probe (value) VALUES (1)"
                    )
                finally:
                    await connection.exec_driver_sql("ROLLBACK TO SAVEPOINT readiness_probe")
                    await connection.exec_driver_sql("RELEASE SAVEPOINT readiness_probe")
        except Exception as exc:
            logger.error(
                "Readiness database check failed (error_type=%s)",
                type(exc).__name__,
            )
            return JSONResponse(
                status_code=503,
                content={
                    "detail": "Service is not ready",
                    "error_type": "service_not_ready",
                },
            )
        return JSONResponse(content={"status": "ready"})

    @app.get(
        "/api/metrics",
        dependencies=[Depends(require_master_token)],
        response_class=Response,
        responses={
            200: {
                "description": "Prometheus metrics",
                "content": {"text/plain": {"schema": {"type": "string"}}},
            },
            401: {"description": "Authentication required", "model": ErrorResponse},
            403: {"description": "Master token required", "model": ErrorResponse},
        },
    )
    async def metrics() -> Response:
        """Expose minimal Prometheus metrics to authenticated operators."""
        content = "\n".join([
            "# HELP pomodoroxii_api_up API process status (1=up)",
            "# TYPE pomodoroxii_api_up gauge",
            "pomodoroxii_api_up 1",
            "",
        ])
        return Response(
            content=content,
            media_type="text/plain; version=0.0.4",
        )

    return app


app = create_app()
