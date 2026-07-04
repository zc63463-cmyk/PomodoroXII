# 扩展性 parity 例外表

> **目的**：记录所有 parity test 中允许的例外，避免自动化误伤特殊实体。
> **维护**：新增例外时必须在此文档登记，并在对应 test 中声明。
> **关联文档**：[14-扩展性4.5星提升规划.md](./14-扩展性4.5星提升规划.md) · [扩展性4.5星提升-实施计划-v2.md](../.trae/documents/扩展性4.5星提升-实施计划-v2.md)

## Schema 例外

| 实体 | 例外原因 | 豁免内容 |
|---|---|---|
| `session_quick_note` | Junction table | 无独立 Pydantic schema |
| `schedule_quick_note` | Junction table | 无独立 Pydantic schema |
| `task_quick_note` | Junction table | 无独立 Pydantic schema |
| `note` | FS+DB split | `content` 字段不在 ORM columns（在 FS） |
| `folder` | Cascade soft-delete | `parent_id` 自引用需 cascade 处理 |

## Sync 例外

| 实体 | 例外原因 | 豁免内容 |
|---|---|---|
| `note` | FS+DB split | push 走 `_push_note_event` → NoteService(sync_mode=True) |
| `folder` | Cascade | push update 需 `check_folder_circular_ref` hook |

## Trash 例外

| 实体 | 例外原因 | 豁免内容 |
|---|---|---|
| `folder` | Cascade | purge 时需级联删除 descendants |
| `note` | FS+DB split | delete 时需同步删除 FS .md 文件 |

## Stats 例外

| 端点 | 例外原因 | 豁免内容 |
|---|---|---|
| 无 | 所有 stats 端点必须有对应 MCP 工具 | 无豁免 |

## 维护规则

1. **新增例外**：先在此文档登记 → 在对应 parity test 的 `SCHEMA_EXCEPTIONS` / `SYNC_EXCEPTIONS` 等常量中声明 → 提交 commit 时附 `Refs: parity-exception-update`。
2. **删除例外**：当实体的特殊处理被消除（如 Note 改为 DB-only）后，从文档和 test 中同步删除例外声明。
3. **审计**：每季度 review 一次，确认例外仍然必要。如某例外已可消除，应开 issue 跟踪技术债偿还。
