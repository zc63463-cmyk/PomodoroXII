# Tombstone 隔离 + MCP WIP 合入 + 后续处理计划

## 1. Summary

main 基线未包含 MCP WIP（67d78c9/14330be），且工作树有范围外 tombstone 毫秒精度改动。本计划分 3 步：隔离 tombstone → 合入 MCP WIP → 后续单独处理 tombstone。

---

## 2. Current State Analysis

- `origin/main` = `a8b367a`，**不含** 67d78c9/14330be
- `codex/mcp-wip` = `14330be`（已推送到 origin，PR #1 在 GitHub 上未真正合并）
- 工作树脏数据：`backend/app/services/tombstone.py` + `backend/tests/test_tombstone_service.py`（deleted_at 毫秒精度改动，范围外）
- 4 个本地分支待推送：mcp-http-lifespan / mcp-lint-cleanup / mcp-spec-centralize / deploy-baseline

---

## 3. Proposed Changes

### 步骤 1：隔离 tombstone 改动

```bash
git stash push -m "wip: tombstone deleted_at millisecond precision" -- backend/app/services/tombstone.py backend/tests/test_tombstone_service.py
git status --short --branch
```

确认工作树只剩 `.trae` 未跟踪文档。

### 步骤 2：合入 MCP WIP 到 main

优先走 GitHub PR（网络允许的话）。如果网络不通，本地 merge：

```bash
git checkout main
git pull --ff-only origin main
git merge --no-ff codex/mcp-wip -m "merge: MCP WIP compatibility and coverage"
```

验证：
```bash
cd backend
.venv\Scripts\python.exe -m pytest tests/test_mcp_server.py tests/test_parity_stats_mcp.py tests/test_stat_spec.py -q --tb=short -p no:cacheprovider
uv run ruff check app tests
```

如果通过：
```bash
git push origin main
```

### 步骤 3：后续 tombstone 单独分支

MCP WIP 合入 main 后：
```bash
git checkout main
git pull --ff-only origin main
git checkout -b codex/sync-tombstone-ms
git stash pop
```

验证：
```bash
cd backend
.venv\Scripts\python.exe -m pytest tests/test_tombstone_service.py tests/test_sync_cursor_pagination.py -q --tb=short -p no:cacheprovider
.venv\Scripts\python.exe -m pytest tests/ -q --tb=short --maxfail=10 -p no:cacheprovider
```

如果通过：
```bash
git commit -am "fix(sync): use millisecond precision for tombstone timestamps"
```

---

## 4. Assumptions & Decisions

1. tombstone 改动是真实 correctness 修复，不丢弃
2. MCP WIP 优先走 PR，网络不通才本地 merge + push
3. tombstone 单独分支 `codex/sync-tombstone-ms`，不混入 MCP 线
4. 4 个后续分支（http-lifespan/lint/spec/deploy）等 MCP WIP 合入后再逐个处理

---

## 5. Verification Steps

- [ ] `git status` 工作树干净（stash 后）
- [ ] `origin/main` 包含 67d78c9/14330be（合入后）
- [ ] MCP 测试 + parity gate 通过
- [ ] ruff 全绿
- [ ] tombstone 分支测试通过
