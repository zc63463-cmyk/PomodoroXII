# PomodoroXII Backend Deployment Guide

This guide covers running the PomodoroXII backend in production using Docker and GitHub Container Registry (GHCR).

## Prerequisites

- Docker Engine 24.0+ with Docker Compose (v2)
- A Linux/macOS/Windows host with at least 512 MB RAM
- A strong `POMODOROXII_SECRET_KEY` (see below)

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `POMODOROXII_SECRET_KEY` | Yes | — | Cryptographic key for JWT tokens. Must be at least 32 bytes. |
| `POMODOROXII_ENVIRONMENT` | No | `production` | Set to `production` for public deployments. |
| `POMODOROXII_SPACES_DATA_DIR` | Yes | `/app/data/spaces` | Directory where per-space SQLite databases live. Must be persistent. |
| `POMODOROXII_DATABASE_URL` | No | auto | Optional override for the meta database URL. |
| `POMODOROXII_LOG_LEVEL` | No | `INFO` | Log level: `DEBUG`, `INFO`, `WARNING`, `ERROR`. |

## Generate a Secret Key

Use a strong random source:

```bash
python -c "import secrets; print(secrets.token_urlsafe(48))"
```

Save the output in a `.env` file next to `docker-compose.yml`:

```bash
POMODOROXII_SECRET_KEY="your-generated-secret-key"
```

## Start the Service

```bash
cd backend
docker compose up -d
```

Verify it is healthy:

```bash
curl -fsS http://localhost:8000/api/health
```

You should see a JSON response with status `ok`.

## First-Time Initialization

The container auto-initializes the meta database on first start. No manual migration step is required.

## Upgrade to a New Image

```bash
cd backend
docker compose pull
docker compose up -d
```

## Data Directory and Backups

All state is stored in `./data` (relative to `docker-compose.yml`):

- `data/spaces/` — per-space SQLite databases
- `data/meta.db` — registry of spaces and meta settings

**Back up regularly** before upgrades:

```bash
tar czf pomodoroxii-backup-$(date +%Y%m%d-%H%M%S).tar.gz ./data
```

## Health Endpoint

- `GET /api/health` — returns `{"status": "ok"}` when the service is alive.

## MCP Server (optional)

You can also run the MCP server as a separate container or command. For stdio mode:

```bash
docker run --rm -i ghcr.io/zc63463-cmyk/pomodoroxii-backend:latest python -m app.mcp.server
```

For HTTP mode:

```bash
docker run --rm -p 9000:9000 ghcr.io/zc63463-cmyk/pomodoroxii-backend:latest python -m app.mcp.server --transport http --port 9000
```

## Security Notes

- Keep the secret key private and out of version control.
- Use a reverse proxy (nginx, Caddy, Cloudflare Tunnel) for TLS in production.
- The container does **not** expose TLS directly.
- Set `POMODOROXII_ENVIRONMENT=production` to enable production-level defaults.

## Troubleshooting

**Health check fails after start**
- Check logs: `docker compose logs -f`
- Ensure `POMODOROXII_SECRET_KEY` is set and at least 32 bytes long.
- Verify port `8000` is not already in use.

**Data is lost after restart**
- Confirm the `data` volume is mounted as a host directory, not an anonymous volume.
