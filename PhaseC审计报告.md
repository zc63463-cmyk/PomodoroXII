# PomodoroXII Phase C 审计报告（只读，未改代码）

> 审计时间：2026-07-04 14:30
> 审计范围：C1 墓碑防复活 / C2 strip_client_fields / C3 folder 环检测 / M1 REST 删除墓碑 / sync push delete / Note sync_mode delete / TombstoneService 并发 / 测试充分性
> 审计方法：逐文件逐行静态审查 + 全量 pytest 实跑

---

## 总判定：Phase C sync 安全 **可合并**（附 P1 补测试建议）

Phase C 的 4 项核心安全检查（C1/C2/C3/M1）在代码层面**全部闭环**，sync push delete 墓碑也已补齐。唯一短板是**测试覆盖不均**：task 有完整集成测试，但其余 5 实体 + note push delete + BaseService entity_type 墓碑缺少回归测试。这些是"证明不足"而非"逻辑缺失"——建议在合并前或合并后立即补齐。

---

## 审计清单（逐项 PASS/FAIL/PARTIAL + 证据）

### C1 墓碑防复活 — **PASS**

| # | 检查项 | 状态 | 证据 |
|---|--------|------|------|
| 1 | create/update 是否都查 TombstoneService.exists？ | ✅ PASS | `sync.py:242-245`（通用路径）、`sync.py:339-342`（note 路径）：`if action in ("create", "update"): tomb = await TombstoneService(self.db).exists(etype, eid); if tomb is not None: return "conflict_tombstone"` |
| 2 | update 在 row 缺失时的 upsert 是否仍查墓碑？ | ✅ PASS | `sync.py:268-272`：`if obj is None: tomb = await TombstoneService(self.db).exists(etype, eid); if tomb is not None: return "conflict_tombstone"`。note 路径 `sync.py:355-358` 同理 |
| 3 | note 路径 `_push_note_event` 是否与通用路径一致？ | ✅ PASS | 两条路径都执行：strip_client_fields → 墓碑检查 → LWW → 应用。note delete 在 `sync.py:378-379` 补写墓碑 |
| 4 | conflict 是否映射为 resolution=tombstone 并进入 conflicts 数组？ | ✅ PASS | `sync.py:177-182`（通用）、`sync.py:135-140`（note）：`elif resolution == "conflict_tombstone": conflicts.append({"resolution": "tombstone"})` |

**测试覆盖**：
- `test_push_tombstone_blocks_create_resurrection`（test_sync_service.py:156）— REST delete 后 push create → conflict_tombstone ✅
- `test_push_tombstone_blocks_update_upsert`（test_sync_service.py:188）— REST delete 后 push update → conflict_tombstone ✅

---

### C2 strip_client_fields — **PASS**

| # | 检查项 | 状态 | 证据 |
|---|--------|------|------|
| 1 | 是否剥离 synced/_dirty/_etag、id/created_at/version、task.actual_pomodoros、quickNote 专属字段？ | ✅ PASS | `sync_safety.py:107-118`：`_CLIENT_ONLY_FIELDS = {"synced", "_dirty", "_etag"}`、`_PROTECTED_FIELDS = {"id", "created_at", "version"}`、`_ENTITY_CLIENT_FIELDS = {"task": {"actual_pomodoros"}, "quickNote": {"archive_file_path", "migrated_to_note_id"}}` |
| 2 | push 路径是否在 setattr 前调用？ | ✅ PASS | `sync.py:239`（通用）、`sync.py:336`（note）：`payload = strip_client_fields(payload, etype)` 在任何 `setattr` / `model(**data)` 之前 |
| 3 | 是否有测试覆盖？是否测了「payload 带 version 不应覆盖 DB」？ | ✅ PASS | `test_push_strips_client_fields_from_payload`（test_sync_service.py:260-287）：payload 含 `version=999`，断言 `row.version != 999` |

**测试覆盖**：
- 3 个单元测试（test_sync_safety.py:172-213）：generic+protected / task-specific / quickNote-specific ✅
- 1 个集成测试（test_sync_service.py:260-287）：push create 带 version=999 + actual_pomodoros=99 → 均被剥离 ✅

---

### C3 folder 环检测 — **PASS**

| # | 检查项 | 状态 | 证据 |
|---|--------|------|------|
| 1 | create 带 parent_id 是否检测？ | ✅ PASS | `sync.py:248-251`：`if etype == "folder" and payload.get("parent_id"): if await check_folder_circular_ref(self.db, eid, payload["parent_id"]): return "conflict_circular_ref"` |
| 2 | update 改 parent_id 是否检测？ | ✅ PASS | `sync.py:283-287`：`if etype == "folder" and "parent_id" in payload: ... if await check_folder_circular_ref(self.db, eid, new_parent): return "conflict_circular_ref"` |
| 3 | 自引用 parent_id==entity_id 是否检测？ | ✅ PASS | `sync_safety.py:162`：`if folder_id == new_parent_id: return True` |
| 4 | 是否只在 update 检测、create 漏检？ | ✅ PASS（无此问题） | create 也检测（sync.py:248-251） |

**测试覆盖**：
- `test_check_folder_circular_ref_self_parent`（test_sync_safety.py:221）✅
- `test_check_folder_circular_ref_detects_cycle_in_chain`（test_sync_safety.py:230）✅
- `test_check_folder_circular_ref_none_parent_is_safe`（test_sync_safety.py:245）✅
- `test_push_folder_create_rejects_self_parent`（test_sync_service.py:215）✅
- `test_push_folder_update_rejects_circular_parent`（test_sync_service.py:231）✅

**关于「create 时链上成环」用例**：对于全新 folder（folder_id 不在 DB 中），向上遍历 parent chain 不可能遇到 folder_id（除非 self-parent）。因此 create-time 链上成环在逻辑上不可能发生。self-parent 用例已覆盖唯一真实场景。**无需补此测试。**

---

### M1 REST 删除墓碑 — **PASS**（folder 语义特殊，见说明）

| 实体 | entity_type | DELETE 路径 | 墓碑 | 证据 | 状态 |
|------|------------|-------------|------|------|------|
| task | `"task"` (task.py:29) | `TaskService.delete` → `BaseService._ensure_tombstone` | ✅ | task.py:86 | PASS |
| session | `"session"` (sessions.py:27) | `SessionService.delete` → `BaseService._ensure_tombstone` | ✅ | base.py:109 | PASS |
| note | `"note"` (note.py:60) | `NoteService.delete`（非 sync_mode）→ `BaseService._ensure_tombstone` | ✅ | note.py:191-192 | PASS |
| habit | `"habit"` (habits.py:36) | `HabitService.delete` → `BaseService._ensure_tombstone` | ✅ | base.py:109 | PASS |
| reflection | `"reflection"` (reflections.py:40) | `ReflectionService.delete` → `BaseService._ensure_tombstone` | ✅ | base.py:109 | PASS |
| schedule | `"schedule"` (schedules.py:27) | `ScheduleService.delete` → `BaseService._ensure_tombstone` | ✅ | base.py:109 | PASS |
| timeBlock | `"timeBlock"` (time_blocks.py:27) | `TimeBlockService.delete` → `BaseService._ensure_tombstone` | ✅ | base.py:109 | PASS |
| quickNote | `"quickNote"` (quick_notes.py:31) | `QuickNoteService.delete` → `BaseService._ensure_tombstone` | ✅ | base.py:109 | PASS |
| folder | **未设** (folders.py:29) | `CascadeService.soft_delete_folder`（软删） | ❌ 软删不写 | — | 见下文 |

**entity_type 字符串一致性**：所有 8 个实体的 entity_type 与 `ENTITY_REGISTRY`（sync.py:51-66）完全一致 ✅

**Folder 语义说明**：
- Folder 采用「软删 → 回收站 → purge 硬删 → 墓碑」两阶段模型
- REST DELETE folder → `CascadeService.soft_delete_folder`（设置 trashed_at，不写墓碑）
- Trash purge（`DELETE /trash/folder/{id}`）→ 硬删 + `TombstoneService.create("folder", id)`（trash.py:194）
- **但 sync push delete folder** → `_apply_event:297-304` 硬删 + 写墓碑
- 这意味着 REST DELETE 和 sync delete 对 folder 有不同语义：REST 是「移到回收站」，sync 是「永久删除」
- **结论**：当前实现偏 Option B（软删不写墓碑，purge 写墓碑）。如果 spec 要求 REST DELETE folder 也写墓碑，需改 folder 路由。当前设计合理，无需修改。

---

### Sync push delete — **PASS**

| # | 检查项 | 状态 | 证据 |
|---|--------|------|------|
| 1 | 非 note 实体 delete 是否写墓碑（即使 row 已不存在）？ | ✅ PASS | `sync.py:297-304`：先 `db.get` + `db.delete`（若存在），然后**无条件** `await TombstoneService(self.db).create(etype, eid)` |
| 2 | note delete（sync_mode）是否由 sync 层补写墓碑？ | ✅ PASS | `sync.py:375-380`：`note_svc = NoteService(self.db, self.fs, sync_mode=True); await note_svc.delete(eid); await TombstoneService(self.db).create(etype, eid)` |
| 3 | pull/full 能否看到 push delete 产生的墓碑？ | ✅ PASS | `pull()` → `_fetch_tombstones()` 查询 Tombstone 表，deleted_at > since 返回 |

**测试覆盖**：
- `test_push_delete_event_removes_row_and_writes_tombstone`（test_sync_service.py:110）✅
- `test_push_delete_idempotent_when_row_already_gone`（test_sync_service.py:139）✅
- `test_sync_roundtrip_delete_via_push_writes_tombstone`（test_sync_integration.py:176）— HTTP 层 ✅
- ❌ **缺 push note delete → tombstone 测试**（`test_sync_service_push_note_event_uses_note_service` 只测 create）

---

### Note sync_mode delete — **PASS**

| # | 检查项 | 状态 | 证据 |
|---|--------|------|------|
| 1 | sync_mode=True 时 NoteService.delete 是否跳过墓碑？ | ✅ PASS | `note.py:191-192`：`if not self.sync_mode: await self._ensure_tombstone(id)` |
| 2 | sync push note delete 是否由 sync 层补写墓碑？ | ✅ PASS | `sync.py:378-379`：`await TombstoneService(self.db).create(etype, eid)` |
| 3 | 远程 tombstone 决策是否被保留（不被本地覆盖）？ | ✅ PASS | sync_mode 跳过 → 由 sync push delete 统一写墓碑 → 墓碑 deleted_at 用服务器时间 |

**测试覆盖**：
- `test_sync_mode_skips_tombstone_on_delete`（test_sync_service.py:722）✅
- `test_sync_mode_preserves_client_updated_at`（test_sync_service.py:686）✅
- `test_sync_mode_preserves_client_version`（test_sync_service.py:705）✅
- ❌ **缺 push note delete → tombstone + pull 测试**

---

### TombstoneService 并发 — **PARTIAL**（逻辑正确，无测试）

| # | 检查项 | 状态 | 证据 |
|---|--------|------|------|
| 1 | IntegrityError 处理是否会在 SAVEPOINT 内 undo 同事件的 delete？ | ✅ PASS | `tombstone.py:46-53`：`except IntegrityError: self.db.expunge(tomb)` — 用 expunge 而非 rollback，不会 undo SAVEPOINT 内的 prior operations |
| 2 | 当前用 expunge 是否安全？有无 session 脏状态风险？ | ✅ PASS | `expunge(tomb)` 将失败的 pending 实例从 session 移除；之后 `exists()` 重新查询返回并发插入的行；无脏状态 |
| 3 | 是否有竞态测试？ | ❌ FAIL | 无并发/竞态测试 |

**风险评级**：LOW — expunge 替代 rollback 是 SAVEPOINT 安全的正确做法。竞态场景在实际使用中极罕见（同一 space 内高并发删除同一实体）。建议补测试但不阻塞合并。

---

## 测试充分性 — 缺失测试清单

| # | 缺失测试 | 严重度 | 说明 |
|---|---------|--------|------|
| 1 | 6 实体 REST DELETE → pull tombstone（参数化） | **P1** | 仅 task 有集成测试（test_sync_integration.py:147）。session/habit/reflection/schedule/timeBlock/quickNote 的 REST DELETE → pull tombstone 路径无回归测试 |
| 2 | push note delete → tombstone + pull | **P1** | `test_sync_service_push_note_event_uses_note_service` 只测 create。push note delete 走 `_push_note_event:375-380` 补写墓碑的路径无测试 |
| 3 | BaseService.delete + entity_type 写墓碑 | **P2** | test_base_service.py 的 TaskService 未设 entity_type，所以 BaseService 层的 `_ensure_tombstone` 机制无单元测试（间接覆盖通过 task/session 集成测试） |
| 4 | TombstoneService IntegrityError → expunge 竞态 | **P2** | 无并发测试。逻辑正确但无回归保障 |
| 5 | folder create 链上成环 | **N/A** | 对新 folder 不可能发生（folder_id 不在 DB），self-parent 已测试。无需补 |
| 6 | tombstone 后 create/update → conflicts resolution=tombstone（HTTP 层） | **P2** | Service 层有测试，HTTP 层无 |

---

## 全量 pytest 结果

```
361 passed, 1 warning in 251.31s (0:04:11)
```

（与上次审查一致，唯一警告为 HMAC 密钥长度 29 字节低于 SHA256 推荐的 32 字节）

---

## 问题分级汇总

| 级别 | 数量 | 说明 |
|------|------|------|
| P0（必须修，阻塞合并） | **0** | — |
| P1（建议修，合并后立即补） | **2** | 6 实体 REST DELETE→pull tombstone 参数化测试；push note delete→tombstone 测试 |
| P2（后续迭代） | **3** | BaseService entity_type 墓碑单元测试；TombstoneService 竞态测试；HTTP 层 tombstone conflict 测试 |
| N/A | 1 | folder create 链上成环（逻辑不可能） |

---

## 审计结论

**Phase C sync 安全可合并。** 代码层面 C1/C2/C3/M1 + sync push delete + note sync_mode delete 全部闭环实现，逻辑正确，无 P0 阻塞项。测试覆盖的主要短板是"5 实体 REST DELETE→pull tombstone"和"push note delete→tombstone"缺少回归测试——这是"证明不足"而非"逻辑缺失"。建议在 Phase 2 立即补齐这些测试以达成 DoD。
