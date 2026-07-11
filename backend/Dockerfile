# syntax=docker/dockerfile:1
# Stage 1: builder
FROM ghcr.io/astral-sh/uv:python3.13-trixie-slim AS builder

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy

WORKDIR /app

COPY pyproject.toml uv.lock ./

RUN uv sync --frozen --no-dev

COPY app/ ./app/
COPY alembic/ ./alembic/
COPY alembic_meta/ ./alembic_meta/
COPY alembic_space/ ./alembic_space/
COPY alembic.ini ./

# Stage 2: runtime
FROM ghcr.io/astral-sh/uv:python3.13-trixie-slim AS runtime

RUN groupadd -g 1000 app && \
    useradd -u 1000 -g app -m -s /bin/sh app

WORKDIR /app

COPY --from=builder --chown=app:app /app/.venv ./.venv
COPY --from=builder --chown=app:app /app/app ./app
COPY --from=builder --chown=app:app /app/alembic ./alembic
COPY --from=builder --chown=app:app /app/alembic_meta ./alembic_meta
COPY --from=builder --chown=app:app /app/alembic_space ./alembic_space
COPY --from=builder --chown=app:app /app/alembic.ini ./alembic.ini

RUN mkdir -p /app/data && chown app:app /app/data

USER app

ENV PATH="/app/.venv/bin:$PATH" \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

VOLUME ["/app/data"]

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
