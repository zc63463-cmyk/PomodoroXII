"""FastAPI application factory for PomodoroXII."""

from __future__ import annotations

import logging
import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from uuid import uuid4

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response

from app.body_size_limit import BodySizeLimitMiddleware
from app.errors import register_exception_handlers
from app.logging import close_structured_logging, setup_logging
from app.middleware import (
    RequestIdMiddleware,
    RequestMetricsMiddleware,
    SecurityHeadersMiddleware,
)
from app.ops.routes import router as ops_router
from app.ops.signals import OperationalSignals
from app.rate_limit import RateLimitMiddleware
from app.recovery.local_service import LocalRecoveryService
from app.recovery.scheduler import RecoveryScheduler
from app.schemas.common import ErrorResponse, HealthResponse
from app.settings import settings

logger = logging.getLogger("pomodoroxi")


def _probe_data_root() -> None:
    """Create + fsync + delete one probe file in the data root.

    The probe path is derived from the configured data root and never appears
    in logs or responses; any failure aborts readiness.
    """
    root = Path(settings.data_root).expanduser().resolve()
    probe = root / f".readiness_probe_{uuid4().hex}"
    fd = os.open(str(probe), os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    try:
        os.write(fd, b"readiness")
        os.fsync(fd)
    finally:
        os.close(fd)
    try:
        probe.unlink()
    except OSError:
        pass


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Application lifespan: initialise resources on startup, clean up on shutdown."""
    setup_logging(logging.INFO if not settings.debug else logging.DEBUG)

    logger.info("PomodoroXII API starting up (env=%s)", settings.environment)

    # --- Startup ---
    from app.runtime.bootstrap import bootstrap_runtime

    scheduler: RecoveryScheduler | None = None
    recovery_service: LocalRecoveryService | None = None
    try:
        async with bootstrap_runtime("fastapi") as services:
            app.state.runtime_services = services
            app.state.runtime = services.runtime
            app.state.runtime_executor = services.executor
            app.state.operational_signals = OperationalSignals()
            services.executor.gate.assert_ready()
            services.runtime.assert_ready()
            if settings.backup_enabled:
                if settings.backup_target_dir is None:
                    raise RuntimeError(
                        "POMODOROXII_BACKUP_TARGET_DIR is required when backup is enabled"
                    )
                recovery_service = LocalRecoveryService(settings.data_root)
                scheduler = RecoveryScheduler(
                    recovery_service,
                    target=settings.backup_target_dir,
                    signals=app.state.operational_signals,
                    interval_hours=settings.backup_interval_hours,
                    retention_count=settings.backup_retention_count,
                )
                # The required initial snapshot must succeed before readiness;
                # a failure aborts startup instead of logging and continuing.
                await scheduler.start()
            app.state.ready = True
            logger.info("PomodoroXII API ready.")
            yield
    except Exception as exc:
        logger.critical("Failed to initialise runtime: %s", exc, exc_info=True)
        raise
    finally:
        app.state.ready = False
        if scheduler is not None:
            # Shutdown order: cancel + await the scheduler task before closing
            # the resources it holds.
            await scheduler.close()
        if recovery_service is not None:
            await recovery_service.aclose()
        if hasattr(app.state, "runtime"):
            delattr(app.state, "runtime")
        if hasattr(app.state, "runtime_services"):
            delattr(app.state, "runtime_services")
        if hasattr(app.state, "runtime_executor"):
            delattr(app.state, "runtime_executor")
        if hasattr(app.state, "operational_signals"):
            delattr(app.state, "operational_signals")
        close_structured_logging()

    # --- Shutdown ---
    logger.info("PomodoroXII API shutting down.")


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
    app.add_middleware(RequestMetricsMiddleware)

    register_exception_handlers(app)

    # Operational endpoints (metrics etc.) with operations-token auth.
    app.include_router(ops_router)

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
    async def readiness_check(request: Request) -> Response:
        """Verify meta database, runtime, snapshot and data-root writability.

        The probe never leaks root paths, credentials or exception text: any
        failure is reported as a generic 503 with ``service_not_ready``.
        """
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

            # Runtime must be initialised and, when scheduled recovery is
            # required, a verified snapshot must already exist.
            runtime = getattr(request.app.state, "runtime", None)
            if runtime is None:
                raise RuntimeError("runtime_not_initialised")
            if settings.backup_enabled and not getattr(
                request.app.state, "ready", False
            ):
                raise RuntimeError("snapshot_not_ready")

            # Persistent data-root probe: create + fsync + delete.
            _probe_data_root()
        except Exception as exc:
            logger.error(
                "Readiness check failed (error_type=%s)",
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

    return app


app = create_app()
