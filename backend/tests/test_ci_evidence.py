from __future__ import annotations

import re
from pathlib import Path
from xml.etree import ElementTree

import pytest
import yaml

ROOT = Path(__file__).resolve().parents[2]
WORKFLOW_PATH = ROOT / ".github" / "workflows" / "ci.yml"


def _workflow() -> dict[str, object]:
    loaded = yaml.load(WORKFLOW_PATH.read_text(encoding="utf-8"), Loader=yaml.BaseLoader)
    assert isinstance(loaded, dict)
    return loaded


def _test_job() -> dict[str, object]:
    jobs = _workflow()["jobs"]
    assert isinstance(jobs, dict)
    job = jobs["test"]
    assert isinstance(job, dict)
    return job


def _steps() -> list[dict[str, object]]:
    steps = _test_job()["steps"]
    assert isinstance(steps, list)
    assert all(isinstance(step, dict) for step in steps)
    return steps


def _step(name: str) -> dict[str, object]:
    matches = [step for step in _steps() if step.get("name") == name]
    assert len(matches) == 1
    return matches[0]


def test_ci_uses_one_run_scoped_artifact_tree() -> None:
    prepare = _step("Prepare run-scoped artifact directories")
    script = str(prepare["run"])

    assert (
        'Join-Path $env:RUNNER_TEMP "pomodoroxii-ci/$env:GITHUB_RUN_ID-'
        '$env:GITHUB_RUN_ATTEMPT"'
    ) in script
    assert '"POMODOROXII_CI_RUN_ROOT=$root"' in script
    assert '"POMODOROXII_CI_RESULTS_DIR=$results"' in script
    assert '"POMODOROXII_TEST_ARTIFACTS_ROOT=$artifacts"' in script
    assert '"POMODOROXII_STRUCTURED_LOG_PATH=$structuredLog"' in script
    assert "Add-Content -LiteralPath $env:GITHUB_ENV" in script


def test_ci_runs_backend_tests_with_junit_coverage_and_jsonl() -> None:
    prepare = _step("Prepare run-scoped artifact directories")
    run = _step("Run backend tests with evidence")
    prepare_script = str(prepare["run"])
    run_script = str(run["run"])

    assert "New-Item -ItemType Directory -Force -Path $results, $artifacts" in prepare_script
    assert "& uv run pytest @pytestArgs" in run_script
    assert "--junitxml=$env:POMODOROXII_CI_RESULTS_DIR/junit.xml" in run_script
    assert "--cov=app" in run_script
    assert "--cov-branch" in run_script
    assert "--cov-report=xml:$env:POMODOROXII_CI_RESULTS_DIR/coverage.xml" in run_script
    assert '2>&1 | Tee-Object -FilePath "$env:POMODOROXII_CI_RESULTS_DIR/pytest.log"' in run_script


def test_ci_verifies_results_from_the_exported_environment_variable() -> None:
    verify = _step("Verify backend test evidence")
    assert verify["shell"] == "pwsh"
    verify_script = str(verify["run"])
    assert verify_script == (
        'uv run python scripts/ci/verify_test_artifacts.py '
        '"$env:POMODOROXII_CI_RESULTS_DIR"'
    )
    assert '"$POMODOROXII_CI_RESULTS_DIR"' not in verify_script


def test_ci_retains_results_always_and_sandboxes_only_on_failure() -> None:
    results = _step("Upload backend test evidence")
    failed = _step("Upload failed test sandboxes")

    assert results["if"] == "always()"
    assert results["uses"].startswith("actions/upload-artifact@")
    results_with = results["with"]
    assert isinstance(results_with, dict)
    assert results_with["name"] == (
        "backend-test-evidence-${{ github.run_id }}-${{ github.run_attempt }}"
    )
    assert results_with["path"] == (
        "${{ runner.temp }}/pomodoroxii-ci/${{ github.run_id }}-"
        "${{ github.run_attempt }}/results"
    )
    assert results_with["if-no-files-found"] == "error"

    assert failed["if"] == "failure()"
    assert failed["uses"].startswith("actions/upload-artifact@")
    failed_with = failed["with"]
    assert isinstance(failed_with, dict)
    assert failed_with["name"] == (
        "backend-failed-sandboxes-${{ github.run_id }}-${{ github.run_attempt }}"
    )
    assert failed_with["path"] == (
        "${{ runner.temp }}/pomodoroxii-ci/${{ github.run_id }}-"
        "${{ github.run_attempt }}/pomodoroxii-test-artifacts"
    )
    assert failed_with["if-no-files-found"] == "warn"
    assert "pomodoroxii-test-artifacts" not in str(results_with["path"])


def test_ci_actions_are_pinned_to_full_commit_shas() -> None:
    action_refs = [str(step["uses"]) for step in _steps() if "uses" in step]
    assert action_refs
    for action_ref in action_refs:
        assert re.fullmatch(r"[^@\s]+@[0-9a-f]{40}", action_ref), action_ref


def test_ci_lite_excludes_supply_chain_and_native_matrix_work() -> None:
    source = WORKFLOW_PATH.read_text(encoding="utf-8")
    jobs = _workflow()["jobs"]
    assert isinstance(jobs, dict)

    assert set(jobs) == {"test"}
    assert "docker/" not in source
    assert "pxii-vfs-wheels" not in source
    assert "sbom" not in source.lower()
    assert "provenance" not in source.lower()


def _write_valid_artifacts(results_dir: Path) -> None:
    results_dir.mkdir()
    (results_dir / "junit.xml").write_text(
        '<testsuites tests="1"><testsuite name="ci" tests="1"/></testsuites>',
        encoding="utf-8",
    )
    (results_dir / "coverage.xml").write_text(
        '<coverage line-rate="1" branch-rate="1" version="test"/>',
        encoding="utf-8",
    )
    (results_dir / "backend.jsonl").write_text(
        '{"ts":"2026-08-15T00:00:00","level":"INFO",'
        '"logger":"pomodoroxii.ci","msg":"test"}\n',
        encoding="utf-8",
    )
    (results_dir / "pytest.log").write_text("1 passed\n", encoding="utf-8")


def test_ci_artifact_verifier_accepts_complete_real_formats(tmp_path: Path) -> None:
    from scripts.ci.verify_test_artifacts import verify_test_artifacts

    results_dir = tmp_path / "results"
    _write_valid_artifacts(results_dir)

    verify_test_artifacts(results_dir)


@pytest.mark.parametrize(
    ("artifact", "content"),
    [
        ("junit.xml", ""),
        ("junit.xml", "<not-junit />"),
        ("coverage.xml", "<not-coverage />"),
        ("backend.jsonl", "not-json\n"),
        ("backend.jsonl", '{"level":"INFO"}\n'),
        ("pytest.log", ""),
    ],
)
def test_ci_artifact_verifier_fails_closed(
    tmp_path: Path, artifact: str, content: str
) -> None:
    from scripts.ci.verify_test_artifacts import verify_test_artifacts

    results_dir = tmp_path / "results"
    _write_valid_artifacts(results_dir)
    (results_dir / artifact).write_text(content, encoding="utf-8")

    with pytest.raises((ValueError, ElementTree.ParseError)):
        verify_test_artifacts(results_dir)
