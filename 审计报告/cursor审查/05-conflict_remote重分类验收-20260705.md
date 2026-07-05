# conflict_remote 重分类验收报告

> **审查时间：** 2026-07-05 下午  
> **分支：** `codex/sync-conflict-remote-reclassify`  
> **Commit：** `5e4dfb4` — `fix(sync): move conflict_remote from conflicts to applied`  
> **基线：** `main` @ `77e890d`（PR #9 docs 已合并）  
> **规划依据：** `PhaseC-sync-repair-dispatch.md` §P1-1  
> **审查结论：** ✅ **通过验收，建议合并**

---

## TL;DR

将 LWW 远端胜出（`conflict_remote`）从 `conflicts` 移至 `applied`（附 `resolution="remote"`），使 `conflicts` 仅表示**被拒绝**的远端事件。Note 与通用 entity 双路径一致，3 文件改动，sync 专项 80 passed / 全量 558 passed。

---

## 一、问题背景（P1-1）

旧行为：`conflict_remote` 同时进入 `conflicts` 与 `applied`（或仅 conflicts），与 schema 注释「successfully applied」矛盾。客户端若在 `conflicts` 中查找 `remote` 并清除重试队列，可能误判已成功应用的事件。

---

## 二、API 契约变化

| 场景 | 之前 | 现在 |
|------|------|------|
| LWW 远端胜出 | `conflicts[]` 含 `resolution: "remote"` | `applied[]` 含 `resolution: "remote"` |
| 干净成功 (`ok`) | `applied[]` 无 resolution | 不变 |
| 本地拒绝 (`conflict_local`) | `conflicts[]` | 不变 |
| 墓碑拒绝 (`conflict_tombstone`) | `conflicts[]` | 不变 |
| 循环引用 (`conflict_circular_ref`) | `conflicts[]` | 不变 |

**Breaking change：** 客户端不得在 `conflicts` 中查找 `remote`；应检查 `applied[*].resolution == "remote"`。

---

## 三、实现核验

### 3.1 Service（`backend/app/services/sync.py`）

Note 路径与通用 entity 路径对称：

```python
if resolution in ("ok", "conflict_remote"):
    applied_item = {"entity_type": ..., "entity_id": ..., "action": ...}
    if resolution == "conflict_remote":
        applied_item["resolution"] = "remote"
    applied.append(applied_item)
```

`conflict_local` / `conflict_tombstone` / `conflict_circular_ref` 仅进 `conflicts`，不进 `applied`。

### 3.2 Schema（`backend/app/schemas/sync.py`）

| 类型 | 变更 |
|------|------|
| `SyncAppliedItem` | 新增 `resolution: str \| None = None` |
| `SyncConflictItem` | 注释移除 `"remote"`，仅 local/tombstone/circular_ref |

### 3.3 改动范围

```
backend/app/services/sync.py        +44/-37
backend/app/schemas/sync.py         +8/-2
backend/tests/test_sync_service.py  +30/-14
```

未纳入：`uv.lock`、`.codebase-memory/`、计划文档。

---

## 四、测试验证

| 命令 | 结果 |
|------|------|
| sync 专项（service/routes/integration/safety） | **80 passed** |
| 全量 `pytest tests/` | **558 passed** |
| `ruff check app tests` | passed |

### 核心测试

`test_push_conflict_remote_in_applied`：

- 本地 `updated_at=10:00`，推送 `client_updated_at=12:00` → LWW remote
- `applied` 含 `resolution="remote"`
- `conflicts` 不含 `remote`

与既有 P1-1 测试矩阵互补：

- `test_push_conflict_tombstone_not_in_applied`
- `test_push_conflict_circular_ref_not_in_applied`

### 非阻塞 follow-up

- 可增加 **Note 路径** `conflict_remote` 回归测试（逻辑与 task 相同）

---

## 五、验收清单

| 项 | 结果 |
|----|------|
| 范围仅 sync push 契约 | ✅ |
| Note + 通用 entity 一致 | ✅ |
| Schema 与运行时对齐 | ✅ |
| Breaking change 文档化 | ✅ |
| 未碰 MCP/deploy/前端 | ✅ |
| Cursor 独立复测 | ✅ 80 passed |

---

## 六、客户端迁移指南

```javascript
// 旧（废弃）
const remoteWins = response.conflicts.filter(c => c.resolution === "remote");

// 新
const remoteWins = response.applied.filter(a => a.resolution === "remote");
```

`conflicts` 现仅含客户端应重试或保留本地状态的事件。

---

## 七、Phase C 进度

```
P0-2 cursor 毫秒 + 排序        ✅
P0-2 since_id 复合游标         ✅ PR #7
P0-2 同 ts 多页 hotfix         ✅ PR #8
P1-1 conflict_remote 重分类    ✅ 本 PR（待合并）
Tombstone since_id 分页        ⏳ follow-up
────────────────────────────────────
Phase C Sync 引擎              ≈ 99.5%（合并后）
```

---

## 八、裁定

| 维度 | 判定 |
|------|------|
| 正确性 | ✅ |
| 测试 | ✅ |
| 范围 | ✅ |
| **合并建议** | ✅ **同意合并** |

---

*Cursor Agent · 2026-07-05*
