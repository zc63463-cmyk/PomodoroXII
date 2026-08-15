from __future__ import annotations

from pathlib import Path

WORKFLOW = Path(__file__).resolve().parents[2] / ".github" / "workflows" / "ci.yml"


def test_ci_uses_external_run_root_and_produces_real_failure_artifacts() -> None:
    source = WORKFLOW.read_text(encoding="utf-8")
    assert (
        '"POMODOROXII_TEST_ARTIFACTS_ROOT=$artifacts" '
        "| Add-Content -LiteralPath $env:GITHUB_ENV"
    ) in source
    assert "--junitxml=$env:POMODOROXII_CI_RESULTS_DIR/junit.xml" in source
    assert "--cov-report=xml:$env:POMODOROXII_CI_RESULTS_DIR/coverage.xml" in source
    assert "$env:POMODOROXII_CI_RESULTS_DIR/pytest.log" in source
    assert (
        "path: ${{ runner.temp }}/pomodoroxii-ci/${{ github.run_id }}-"
        "${{ github.run_attempt }}/pomodoroxii-test-artifacts"
    ) in source


def test_ci_uploads_on_failure_and_cleans_only_on_success() -> None:
    source = WORKFLOW.read_text(encoding="utf-8")
    results_upload = source.index("name: Upload backend test evidence")
    failed_upload = source.index("name: Upload failed test sandboxes")
    cleanup = source.index("name: Clean successful run artifacts")
    assert "if: always()" in source[results_upload:failed_upload]
    assert "if: failure()" in source[failed_upload:cleanup]
    assert "if: success()" in source[cleanup:]
    assert results_upload < failed_upload < cleanup
    cleanup_body = source[cleanup:]
    assert "Remove-Item -LiteralPath $env:POMODOROXII_CI_RUN_ROOT" in cleanup_body
    assert "Remove-Item -LiteralPath $env:RUNNER_TEMP" not in cleanup_body
