"""scaffold_entity.py 脚手架测试。"""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

from scripts.scaffold_entity import main


def test_scaffold_dry_run_outputs_eight_file_blocks(capsys):
    """dry-run 模式必须输出 8 个文件块标记。"""
    exit_code = main(
        [
            "--name", "goal",
            "--class-name", "Goal",
            "--table-name", "goals",
            "--route-prefix", "goals",
            "--fields", "title:string,due_date:datetime,completed:boolean",
            "--dry-run",
        ]
    )
    output = capsys.readouterr().out

    assert exit_code == 0
    expected_blocks = [
        "# --- file: app/models/goal.py ---",
        "# --- file: app/schemas/goal.py ---",
        "# --- file: app/services/goal.py ---",
        "# --- file: app/routes/v1/goals.py ---",
        "# --- file: app/registry/builtin.py (append) ---",
        "# --- file: app/routes/v1/__init__.py (append) ---",
        "# --- file: alembic/versions/XXX_add_goal.py ---",
        "# --- file: tests/test_goal_service.py ---",
    ]
    for block in expected_blocks:
        assert block in output, f"Missing block: {block}\nOutput:\n{output}"


def test_scaffold_cli_entrypoint_smoke():
    """真实 CLI 入口必须可启动并保持 help 退出码语义。"""
    script = Path(__file__).parent.parent / "scripts" / "scaffold_entity.py"

    result = subprocess.run(
        [sys.executable, str(script), "--help"],
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 0, result.stderr
    assert "Scaffold a new DB-only entity" in result.stdout


def test_scaffold_rejects_invalid_field_type(capsys):
    """无效字段类型必须返回非 0 退出码和可诊断错误。"""
    exit_code = main(
        [
            "--name", "bad",
            "--class-name", "Bad",
            "--table-name", "bads",
            "--route-prefix", "bads",
            "--fields", "title:invalid_type",
            "--dry-run",
        ]
    )
    stderr = capsys.readouterr().err

    assert exit_code != 0
    assert "invalid_type" in stderr or "Unknown field type" in stderr
