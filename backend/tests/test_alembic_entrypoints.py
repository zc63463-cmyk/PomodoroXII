from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

import pytest

BACKEND = Path(__file__).resolve().parents[1]


def isolated_ini(tmp_path: Path) -> Path:
    legacy = tmp_path / "legacy"
    shutil.copytree(BACKEND / "alembic", legacy)
    ini = tmp_path / "alembic.ini"
    ini.write_text(
        "\n".join(
            (
                "[alembic]",
                f"script_location = {legacy.as_posix()}",
                f"sqlalchemy.url = sqlite+aiosqlite:///{(tmp_path / 'legacy.db').as_posix()}",
                "revision_environment = true",
                "[alembic:meta]",
                f"script_location = {(BACKEND / 'alembic_meta').as_posix()}",
                f"sqlalchemy.url = sqlite+aiosqlite:///{(tmp_path / 'meta.db').as_posix()}",
                "version_table = alembic_version_meta",
                "[alembic:space]",
                f"script_location = {(BACKEND / 'alembic_space').as_posix()}",
                f"sqlalchemy.url = sqlite+aiosqlite:///{(tmp_path / 'space.db').as_posix()}",
                "version_table = alembic_version_space",
                "[loggers]",
                "keys = root,sqlalchemy,alembic",
                "[handlers]",
                "keys = console",
                "[formatters]",
                "keys = generic",
                "[logger_root]",
                "level = WARN",
                "handlers = console",
                "qualname =",
                "[logger_sqlalchemy]",
                "level = WARN",
                "handlers =",
                "qualname = sqlalchemy.engine",
                "[logger_alembic]",
                "level = INFO",
                "handlers =",
                "qualname = alembic",
                "[handler_console]",
                "class = StreamHandler",
                "args = (sys.stderr,)",
                "level = NOTSET",
                "formatter = generic",
                "[formatter_generic]",
                "format = %(levelname)-5.5s [%(name)s] %(message)s",
                "datefmt = %H:%M:%S",
            )
        )
        + "\n",
        encoding="utf-8",
    )
    return ini


@pytest.mark.parametrize(
    "arguments",
    (("upgrade", "head"), ("revision", "-m", "blocked", "--rev-id", "blocked")),
)
def test_default_alembic_environment_fails_with_named_instructions(
    tmp_path: Path,
    arguments: tuple[str, ...],
) -> None:
    ini = isolated_ini(tmp_path)
    result = subprocess.run(
        [sys.executable, "-m", "alembic", "-c", str(ini), *arguments],
        cwd=BACKEND,
        text=True,
        capture_output=True,
        check=False,
    )
    assert result.returncode != 0
    output = result.stdout + result.stderr
    assert "alembic -n alembic:meta upgrade head" in output
    assert "alembic -n alembic:space upgrade head" in output
    assert not (tmp_path / "legacy.db").exists()


@pytest.mark.parametrize("environment", ["meta", "space"])
def test_named_alembic_environment_still_reaches_head(
    tmp_path: Path,
    environment: str,
) -> None:
    ini = isolated_ini(tmp_path)
    result = subprocess.run(
        [
            sys.executable,
            "-m",
            "alembic",
            "-c",
            str(ini),
            "-n",
            f"alembic:{environment}",
            "upgrade",
            "head",
        ],
        cwd=BACKEND,
        text=True,
        capture_output=True,
        check=False,
    )
    assert result.returncode == 0, result.stdout + result.stderr
