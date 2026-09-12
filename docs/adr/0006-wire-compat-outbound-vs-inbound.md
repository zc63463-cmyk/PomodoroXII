# Wire 兼容：入站严格、出站携带（外部 Agent / 客户端接入须知）

**状态**：已接受（2026-09-12）

对接同步 API 的外部客户端只需要记住一句话，本文给出它的成因、闸门清单、
服务端自持字段登记表、错误码表与升级自愈路径。全部论断带 `file:line` 锚点
（锚点为 2026-09-12 主干实况）。

## 规则一句话

**入站严格、出站携带**：客户端上行（push）的字段集合受精确校验，少一个字段或
多一个字段都可能被拒；服务端下行（pull / full / 同步事件）是模型驱动全列投影，
客户端**必须容忍未知字段**，不得以严格 schema 拒收。

成因有二：

1. **服务端不做字段级 wire 版本协商**：`/api/v1/sync/v2/*` 各端点
   （push `backend/app/routes/v1/sync.py:179`、pull `:191`、recover `:208`、
   ack `:232`，子路由挂载前缀见 `backend/app/routes/v1/__init__.py:18` 与 `:73`）
   不携带任何 schema/字段版本参数；兼容性完全由「入站严格 + 出站携带 +
   cursor 失效自愈」（见文末）承担。
2. **精确后像闸门是双向拒绝**：work_item 同步重放要求上行载荷与
   `WORK_ITEM_SYNC_FIELDS - {"id"}` **集合精确相等**，`missing` 与 `extra`
   都进拒绝明细 —— `backend/app/task_space/compiler.py:1067-1074`。

## 两类入站闸门

### 1. 精确后像（少一个 / 多一个字段都拒）

- **work_item**：`backend/app/task_space/compiler.py:1061-1074`
  （`_full_work_item_sync_candidate`；期望集合来自
  `WORK_ITEM_SYNC_FIELDS`，`backend/app/task_space/compiler.py:203-211`）。
  wire 形态：rejection code `work_item_structure_changed`（409，
  `backend/app/errors.py:139`），闸门原因挂在
  `details.reason = "full_post_image_required"`、字段明细在
  `details.missing` / `details.extra`（包装点
  `backend/app/task_space/compiler.py:1030-1037`；对外断言样例
  `backend/tests/test_task_space_waiting_prior_state.py:262-264`）。
- **note**：`backend/app/task_space/compiler.py:1630-1642`
  （`_sync_note_document`；create 用 `NOTE_SYNC_FIELDS` 全集
  `compiler.py:1619-1621`，update 去掉 `id`，同样精确相等）。
  wire 形态：`invalid_note_document`（422，`backend/app/errors.py:120`；
  异常类 `backend/app/task_space/document.py:19`），原因同样在 details。

### 2. 通用白名单（只拒未知字段，已知字段数量不校验）

- **目录实体（含 relation 等全部 sync 实体）**：
  `backend/app/mutation/unit_of_work.py:569-576`
  （`_require_payload_fields`：`set(payload) - set(spec.field_names)` 非空即拒；
  `field_names` 定义见 `backend/app/registry/entities.py:118`）。
  wire 形态：`payload_field_not_allowed`（422，`backend/app/errors.py:149-151`）。
- **focus_session 同步更新路径**：`backend/app/focus_session/policy.py:2407-2411`
  （同样的白名单差集，`details.reason = "unknown_fields"`）。
  wire 形态：`work_item_structure_changed`（409，`backend/app/errors.py:139`）。

## 服务端自持字段登记表（客户端不得上行）

| 字段 | 归属 | 入站拒绝方式 |
|---|---|---|
| `work_item.pre_waiting_status_definition_id` | ADR-0003；唯一写入者 = 进入 Waiting 的那次迁移编译（`backend/app/task_space/compiler.py:216`，注释 `:213-215` 与 `:1158`） | 不在 `WORK_ITEM_SYNC_FIELDS`（`compiler.py:203-211`）⇒ 携带即精确后像 `extra` 拒绝：409 `work_item_structure_changed` / `details.reason=full_post_image_required`（`compiler.py:1067-1074`） |
| `work_item.display_key` / `effort_actual_seconds` / `created_at` | `WORK_ITEM_IMMUTABLE_FIELDS`（`compiler.py:242-244`） | 同步重放中发生语义变更 ⇒ `server_managed_field_changed`（409；`compiler.py:1122-1126`，spec `backend/app/errors.py:154-157`） |
| `relation.resolution` / `relation.resolved_at` | ADR-0004；唯一写入者 = `ResolveDependency` 命令 | 入站守卫在编译前置层：`backend/app/commands/entity.py:660-668` + `_require_relation_resolution_untouched`（`:688-699`，对当前权威行做**变更检测**——后像回显当前值不算改），抛出点 `:719` ⇒ `server_managed_field_changed`（409） |
| `work_item.label_ids` | 虚拟投影（无 DB 列），junction 表是服务端投影源（`compiler.py:239-241`） | **不在拒绝之列**：它在精确后像集合内（`compiler.py:203-211`），出站事件必带（见下）；入站变更语义由 labels 家族命令承担（`compiler.py:1141-1150` 家族路由 + `:1151-1154` 单家族约束） |

## 出站形态（客户端必须容忍未知字段）

- 下行是**模型驱动全列**：`backend/app/services/serializers.py:21`
  （`{c.name: getattr(obj, c.name) for c in obj.__table__.columns}`）。
  - pull：按实体分组返回全列行 —— `backend/app/services/sync.py:556-578`
    （入口 `def pull` `:501`）；note 额外注入 `content`/`content_missing`
    （`sync.py:579-585`，正文在文件系统不在 ORM 行）。
  - full：`backend/app/services/sync.py:896-902`（入口 `def full` `:816`）。
  - push 应用后的出站同步事件：`backend/app/services/sync.py:259`
    （`event_payload = serialize_entity(obj)`，位于 `_record_applied_event` `:247`）。
- 事件 payload 字段集 == `spec.field_names`（行形状校验，
  `backend/app/mutation/unit_of_work.py:965-986`）：note 带 legacy `content`
  （`:967-968`），work_item 另加虚拟投影 `label_ids`（`:969-971`）。
- ⇒ 服务端加列（如 ADR-0003 的 `pre_waiting_status_definition_id`）会**直接出现**
  在下行 payload 里。外部客户端的入站 schema 必须是「开放模型 + 白名单取用」，
  而不是「封闭模型 + 未知即错」。

## 错误码表

| 码 | HTTP | 语义 | 产出点 |
|---|---|---|---|
| `work_item_structure_changed`（`details.reason=full_post_image_required`） | 409 | work_item 精确后像 missing/extra | `compiler.py:1071-1074`，包装 `:1030-1037`，spec `errors.py:139` |
| `invalid_note_document`（`details.reason=full_post_image_required`） | 422 | note 精确后像 missing/extra | `compiler.py:1638-1642`，`document.py:19`，spec `errors.py:120` |
| `server_managed_field_changed` | 409 | 服务端自持列被客户端变更 | `compiler.py:1125`、`entity.py:719`，spec `errors.py:154-157` |
| `payload_field_not_allowed` | 422 | 未知字段（目录白名单）/ 非法 `relation_type` 纵深防御 | `unit_of_work.py:573`、`compiler.py:847`、`:939`，spec `errors.py:149-151` |
| `unowned_field_changed`（经包装） | 409 | 语义变更落在无主字段；wire 形态同 `work_item_structure_changed`，原因在 `details.reason` | `compiler.py:1138`，包装 `:1030-1037` |
| `cursor_expired` | 409 | 游标失效（目录变化 / retention 裁剪 / 篡改），`details.recovery_action="full_recovery"` | `errors.py:436-441`；`backend/app/sync/cursor.py:187`、`backend/app/sync/clients.py:111`、`backend/app/sync/snapshot.py:292` |

**Canonical error body**：需要请求头
`Accept: application/vnd.pomodoroxii.error+json;version=2`
（常量 `backend/app/errors.py:22`；协商判定 `_canonical_requested`
`errors.py:506-508`，无 Accept 时返回 legacy `{"detail": ...}` 形态
`errors.py:520-531`）。无论是否 canonical，响应都带
`X-PomodoroXII-Error-Code` 头（`errors.py:512-517`），可作为兜底识别通道。

## 迁移影响提示（2026-09-12 实测过）

任何目录级变更（加 FieldSpec / 改 registry / 改保留策略）都会让既有 sync cursor
**一次性失效**（`catalog_hash` 是 cursor 字段，
`backend/app/sync/cursor.py:25`、`:52`）→ 客户端收到
`409 cursor_expired`（`details.recovery_action="full_recovery"`，`cursor.py:187`）→
唯一出路是自愈三步：`GET /api/v1/sync/v2/recover`（`routes/v1/sync.py:208`）→
`POST /api/v1/sync/v2/ack`（`:232`）→ `GET /api/v1/sync/v2/pull`（`:191`）；
服务端恢复编排在 `backend/app/sync/protocol.py:364`（`_recover`）。

前端参考实现：`frontend/src/lib/sync/engine.ts:45-55`（`isCursorExpiredRejection`
按 409 + code/recovery_action 识别）、`:386-389`（cursor_expired 是**设计内的自愈条件**
——「实测：B′ 加 FieldSpec 后的第一次 pull」）、`:406-411`（持久化
`requiresFullRecovery=true` 并在同一周期内以当前 client 立即重试一次）。
**外部客户端必须实现这条自愈，否则服务端任何目录级升级后都会卡死在同步循环。**
