from __future__ import annotations

from pathlib import Path

WORKFLOW = Path(__file__).resolve().parents[2] / ".github" / "workflows" / "ci.yml"


def test_ci_uses_external_run_root_and_produces_real_failure_artifacts() -> None:
    source = WORKFLOW.read_text(encoding="utf-8")
    assert (
        "POMODOROXII_TEST_ARTIFACTS_ROOT: "
        "${{ runner.temp }}/pomodoroxii-test-artifacts"
    ) in source
    assert "--junitxml=.test-results/junit.xml" in source
    assert ".test-results/pytest.log" in source
    assert "${{ runner.temp }}/pomodoroxii-test-artifacts/**" in source


def test_ci_uploads_on_failure_and_cleans_only_on_success() -> None:
    source = WORKFLOW.read_text(encoding="utf-8")
    upload = source.index("name: Upload test artifacts on failure")
    cleanup = source.index("name: Clean successful test artifacts")
    assert "if: failure()" in source[upload:cleanup]
    assert "if: success()" in source[cleanup:]
    assert upload < cleanup
    cleanup_body = source[cleanup:]
    assert 'rm -rf -- "$POMODOROXII_TEST_ARTIFACTS_ROOT"' in cleanup_body
    assert "rm -rf -- .test-results" in cleanup_body
    assert "rm -rf -- ${{ runner.temp }}" not in cleanup_body
