# S5 Task 3 Windows Local Recovery Operations

PomodoroXII 的唯一正式完整恢复运维入口是：

```powershell
python -m app.ops snapshot
python -m app.ops verify
python -m app.ops restore
python -m app.ops cutover
python -m app.ops relocate
```

所有命令复用 `LocalRecoveryService` / `RecoveryCoordinator` / `DataRootRelocator`，
不在 CLI 中重新实现任何恢复算法。`backend/scripts/rehearse_recovery.py` 是同一
CLI 的薄兼容包装器（保留 `verify-snapshot` / `rehearse` 历史命令名），不构成
第二套命令语义。

## 环境准备

```powershell
cd E:\DevTemp\pomodoroxii-boundaries\s5-task3-scheduled-recovery\backend
.\\.venv\\Scripts\\python.exe -m app.ops --help
```

## 命令与退出码

| 命令 | 用途 | 成功 | DomainFailure/参数错误 | 意外错误 |
|---|---|---|---|---|
| `snapshot --target PATH --data-root PATH` | 生成并验证完整快照 | 0 | 2 | 1 |
| `verify --snapshot PATH --data-root PATH` | 只读验证既有快照 | 0 | 2 | 1 |
| `restore --snapshot PATH --output RECEIPT.json --data-root PATH` | 恢复到 staging 并写出 receipt | 0 | 2 | 1 |
| `cutover --receipt RECEIPT.json --data-root PATH --confirm-disposable-root PATH --confirm-cutover` | 发布已验证 staging | 0 | 2 | 1 |
| `relocate --data-root SRC --target-root DST --confirm-*` | 发布数据根到新目标 | 0 | 2 | 1 |

`--json` 模式只输出一行 canonical JSON：

```json
{"ok": true, "command": "snapshot", "result": {...}}
{"ok": false, "command": "snapshot", "error": {"code": "...", "message": "..."}}
```

## 破坏性命令安全约束

- `cutover` / `relocate` 先获取 process-owner 再获取 global-exclusive；live owner
  存在时稳定返回 `lease_timeout`（零 rename）。
- 无 `--force` / `--overwrite` / `--force-live-overwrite`。
- 确认失败时不会构造服务或访问数据库。
- `relocate` 必须确认 source 与 target 两个完整路径；target 必须不存在。

## 生产启动要求（RecoveryScheduler）

- 生产启动必须先完成一次完整 `snapshot + verify`，成功后才置 readiness。
- 初始快照失败中止启动（不记录 warning 后继续）。
- 成功后启动可取消、可等待退出的定时任务（默认每 24 小时）。
- 默认保留最近 30 个已验证 snapshot。
- 无法读取或无法验证的目录只记录，不自动删除。
- retention 绝不删除 backup target 以外的路径。

配置项（`app.settings.Settings`）：

```
POMODOROXII_BACKUP_ENABLED=true
POMODOROXII_BACKUP_TARGET_DIR=E:\path\to\external\backup
POMODOROXII_BACKUP_INTERVAL_HOURS=24
POMODOROXII_BACKUP_RETENTION_COUNT=30
```

- production + enabled 时必须配置外部 backup target。
- backup target 必须位于 data_root 外部；不得静默创建 active root 内的 target。
- development/test 可显式 `POMODOROXII_BACKUP_ENABLED=false`。

## 端到端示例（disposable copy）

```powershell
# 1) snapshot
python -m app.ops snapshot --target E:\tmp\snapshots --data-root E:\tmp\disposable-copy --json

# 2) verify
python -m app.ops verify --snapshot E:\tmp\snapshots\20260814T000000Z-<hash12> --data-root E:\tmp\disposable-copy --json

# 3) restore -> receipt
python -m app.ops restore --snapshot E:\tmp\snapshots\20260814T000000Z-<hash12> --output E:\tmp\staged-receipt.json --data-root E:\tmp\disposable-copy --json

# 4) cutover（确认值必须与 --data-root 完全一致）
python -m app.ops cutover --receipt E:\tmp\staged-receipt.json --data-root E:\tmp\disposable-copy --confirm-disposable-root E:\tmp\disposable-copy --confirm-cutover --json

# 5) relocate（source 与 target 两个确认）
python -m app.ops relocate --data-root E:\tmp\disposable-source --target-root E:\tmp\disposable-target --confirm-disposable-root E:\tmp\disposable-source --confirm-relocation-target E:\tmp\disposable-target --confirm-relocate --json
```

永远只对 disposable copy 执行 `cutover` / `relocate`，不要指向真实用户数据根。
