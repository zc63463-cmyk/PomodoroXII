from __future__ import annotations

import os
import re
from pathlib import Path

import pytest

from app.tools.export_openapi import (
    DEFAULT_OUTPUT,
    check_openapi,
    main,
    render_openapi,
    write_openapi,
)


@pytest.fixture(scope="module")
def rendered() -> str:
    return render_openapi()


def test_committed_openapi_artifact_is_current() -> None:
    assert check_openapi(DEFAULT_OUTPUT)


def test_openapi_drift_workflows_share_main_develop_branch_matrix() -> None:
    root = Path(__file__).resolve().parents[2]
    expected = {"main", "develop"}

    for workflow_name in ("ci.yml", "frontend-ci.yml"):
        workflow = (root / ".github" / "workflows" / workflow_name).read_text(
            encoding="utf-8"
        )
        for event in ("push", "pull_request"):
            match = re.search(
                rf"(?ms)^  {event}:\n(?:    .+\n)*?    branches: \[([^]]+)\]",
                workflow,
            )
            assert match is not None, f"{workflow_name} missing {event} branches"
            branches = {branch.strip() for branch in match.group(1).split(",")}
            assert branches == expected


def test_render_does_not_mutate_parent_environment(monkeypatch) -> None:
    monkeypatch.setenv("POMODOROXII_ENVIRONMENT", "production")
    monkeypatch.setenv("POMODOROXII_DATABASE_URL", "sqlite+aiosqlite:///parent.db")

    assert render_openapi().startswith('{\n  "openapi":')
    assert os.environ["POMODOROXII_ENVIRONMENT"] == "production"
    assert os.environ["POMODOROXII_DATABASE_URL"] == "sqlite+aiosqlite:///parent.db"


@pytest.mark.parametrize(
    "mutate",
    [
        lambda text: text.replace('"openapi":', '"drift": true,\n  "openapi":', 1),
        lambda text: text.replace("\n", "\r\n"),
        lambda text: text.removesuffix("\n"),
    ],
    ids=("content-drift", "crlf", "missing-final-newline"),
)
def test_check_rejects_noncanonical_artifacts(
    tmp_path: Path, rendered: str, mutate
) -> None:
    output = tmp_path / "openapi.json"
    output.write_bytes(mutate(rendered).encode("utf-8"))

    assert not check_openapi(output)
    assert main(["check", "--output", str(output)]) == 1


def test_write_restores_canonical_artifact(tmp_path: Path, rendered: str) -> None:
    output = tmp_path / "openapi.json"
    output.write_bytes(b"drift\r\n")

    write_openapi(output)

    assert output.read_bytes() == rendered.encode("utf-8")
    assert check_openapi(output)
    assert main(["check", "--output", str(output)]) == 0
