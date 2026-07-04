"""FastAPI application factory for PomodoroXII."""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from collections.abc import AsyncIterator

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.errors import register_exception_handlers
from app.logging import setup_logging
from app.middleware import RequestIdMiddleware
from app.settings import settings

logger = logging.getLogger("pomodoroxi")


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Application lifespan: initialise resources on startup, clean up on shutdown."""
    setup_logging(logging.INFO if not settings.debug else logging.DEBUG)

    logger.info("PomodoroXII API starting up (env=%s)", settings.environment)

    # --- Startup ---
    from app.db.meta_session import init_meta_db, close_meta_db
    from app.space_manager import get_space_engine_manager, dispose_space_engine_manager

    try:
        await init_meta_db()
        logger.info("Meta database initialised.")
    except Exception as exc:
        logger.critical("Failed to initialise meta database: %s", exc, exc_info=True)
        raise

    # Warm up the space engine manager singleton.
    get_space_engine_manager()

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
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.add_middleware(RequestIdMiddleware)

    register_exception_handlers(app)

    # Mount v1 API routes
    from app.routes.v1 import build_v1_router
    app.include_router(build_v1_router())

    @app.get("/api/health")
    async def health_check() -> dict:
        """Health check endpoint for orchestrators / load balancers."""
        return {"status": "ok", "version": "0.1.0"}

    return app


app = create_app()
