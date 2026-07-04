# PomodoroXII 移植方案可行性分析与深度开发建议

> 生成时间：2026-07-01 | 基于 React 19 技术栈重构 | 源码验证 + 行业参考 + 架构评审

---

## 目录

1. [文档准确性验证](#一文档准确性验证)
2. [方案可行性评估](#二方案可行性评估)
3. [核心风险点](#三核心风险点)
4. [行业参考对比](#四行业参考对比)
5. [深度开发建议](#五深度开发建议)
6. [改进后的目标架构](#六改进后的目标架构)
7. [实施路线图](#七实施路线图)

---

## 一、文档准确性验证

对移植文档的 10 项关键声明逐一进行了源码级验证，结果如下：

| # | 声明 | 验证结果 | 说明 |
|---|------|---------|------|
| 1 | 15 个文件清单 | ✅ 属实 | 文件树完全一致 |
| 2 | 8 Mixin 组合 | ✅ 属实 | StorageBase + 7 OpsMixin |
| 3 | 三层锁 RLock→FileLock→SQLite | ✅ 属实 | 写操作三层齐全，读操作仅 RLock |
| 4 | FTS5 trigram 中文搜索 | ✅ 属实 | 含 R7 升级路径（旧库重建） |
| 5 | index.db 5 表 + FTS5 | ⚠️ 部分属实 | **遗漏 schema_meta + sync_audit_log 两表** |
| 6 | 仅依赖 3 个新包 | ✅ 属实 | filelock, nanoid, python-slugify |
| 7 | backup.py logger_config 依赖 | ✅ 属实 | 需迁移 logger_config 或替换 |
| 8 | api.py _PROJECT_ROOT 路径推导 | ✅ 属实 | 三级 parent，移植需调整 |
| 9 | 临时文件 + os.replace 原子写入 | ✅ 属实 | 实现规范，异常清理到位 |
| 10 | edit_note 自动版本备份 | ✅ 属实 | SHA-256 比对，先备份再覆盖 |

**准确率：9/10 属实，1/10 部分属实。** 文档整体质量很高，可信度优秀。

### 需修正的遗漏

文档声称 index.db 有 "5 表 + FTS5"，实际有 **7 表 + 1 FTS5 虚拟表**：

| 表 | 类型 | 文档是否提及 |
|----|------|------------|
| notes | ORM 核心 | ✅ |
| folders | ORM 核心 | ✅ |
| note_paths | ORM 核心 | ✅ |
| note_versions | ORM 核心 | ✅ |
| note_links | ORM 核心 | ✅ |
| **schema_meta** | 迁移基础设施 | ❌ 遗漏 |
| **sync_audit_log** | 同步审计 | ❌ 遗漏 |
| notes_fts | FTS5 虚拟表 | ✅ |

**影响**：移植时若只建 5 个核心表，会丢失 schema 版本管理能力和同步审计能力。`schema_meta` 是 `_run_migrations` 的依赖，缺失会导致迁移逻辑失败。

### 额外发现的耦合点

文档说 file_system "自包含"，但有 3 个隐藏耦合：

1. **logger_config 依赖**：`backup.py` 导入 `from logger_config import get_logger`，该模块在 `scripts/logger_config.py`，不在 file_system 目录内。移植时必须同迁此模块或替换为标准 logging。

2. **schema.py 的 Windows 中文路径适配**：`init_database` 专门绕开 SQLAlchemy 的 `sqlite:///{path}` URL（中文路径会失败），改用 `Base.metadata` + 内存 engine 生成 DDL 再在原生 sqlite3 连接上执行。移植时此设计已就绪，勿回退。

3. **sync_audit_log 表已在 file_system 内预埋**：说明 video4KB 设计时已考虑了 sync 集成场景，但文档未提及此表的用途和与 pomodoroxi.db 中 sync 审计的关系。

---

## 二、方案可行性评估

### 2.1 总体评价：可行，但有 3 个架构级风险需提前解决

移植方案的核心思路——**双存储共存（DB 存元数据 + .md 存正文）+ 保留 sync 引擎 + 移植 file_system 子系统**——方向正确，技术路径清晰。file_system 子系统经过验证设计成熟（8 Mixin、三层锁、FTS5、原子写入、版本备份都是生产级实现），移植成本可控。

但有 3 个架构级风险如果不提前解决，会在实施中后期变成阻塞问题：

| 风险 | 严重度 | 说明 |
|------|--------|------|
| **content 字段双重所有权** | 🔴 高 | Note.content 在 pomodoroxi.db 和 .md 文件中各存一份，谁是 source of truth？ |
| **跨库事务原子性** | 🔴 高 | 写 pomodoroxi.db 和写 .md + index.db 不在同一事务内，部分失败导致不一致 |
| **sync_pull 读 .md 性能** | 🟡 中 | pull 时每条 note 都要读 .md 文件，批量拉取时 IO 瓶颈 |

### 2.2 各模块可行性评分

| 模块 | 可行性 | 理由 |
|------|--------|------|
| file_system 移植 | ⭐⭐⭐⭐⭐ | 15 文件自包含，改动仅 3 处（logger、路径、死导入） |
| 双存储 Note 模型 | ⭐⭐⭐☆☆ | 方向正确，但 content 所有权和一致性需额外设计 |
| sync 引擎桥接 | ⭐⭐⭐☆☆ | push 桥接清晰，pull 读 .md 需批量优化 |
| convert-to-note | ⭐⭐⭐⭐☆ | 逻辑直接，QuickNote → .md + DB |
| FTS5 全文搜索 | ⭐⭐⭐⭐⭐ | 直接复用 file_system 的 search_ops，零改动 |
| 版本历史 | ⭐⭐⭐⭐⭐ | 直接复用 file_system 的 version_ops，零改动 |
| 回收站 | ⭐⭐⭐⭐☆ | file_system 有自己的 trash，需与 pomodoroxi 的 trashed_at 对齐 |
| Docker 部署 | ⭐⭐⭐⭐☆ | 需增加 data/notes volume 挂载 |

---

## 三、核心风险点深度分析

### 3.1 content 字段双重所有权（🔴 最高风险）

**问题**：文档设计 Note 模型时，`pomodoroxi.db` 的 `notes.content` 字段是 "冗余缓存"，正文以 .md 为准。但这会产生：

```
写入路径：sync push → 写 pomodoroxi.db.content + 写 .md 文件
读取路径：sync pull → 读 pomodoroxi.db 元数据 + 读 .md 正文
```

**不一致场景**：
1. 写 pomodoroxi.db 成功，写 .md 失败 → DB 有 content，文件没有
2. 写 .md 成功，写 pomodoroxi.db 失败 → 文件有正文，DB 没有元数据
3. 用户直接编辑 .md 文件 → 文件内容更新，DB content 缓存过期
4. sync pull 返回 DB.content（缓存）而非 .md（真实）→ 客户端拿到旧数据

**建议方案：明确 content 的单一所有权**

```
方案 A（推荐）：.md 文件为唯一 source of truth
  - pomodoroxi.db.notes 不存 content 字段
  - pull 时从 .md 读取正文（需批量优化）
  - content_hash 存 DB 用于快速判断是否变化
  - 优点：无双重所有权问题，数据一致
  - 缺点：pull 性能依赖文件 IO

方案 B：DB.content 为主，.md 为持久化副本
  - 所有写入先写 DB，再异步写 .md
  - pull 只读 DB，不读 .md
  - 定期一致性检查 + 修复
  - 优点：pull 性能好
  - 缺点：.md 可能短暂过期，需最终一致性容忍

方案 C（文档当前设计）：DB.content 冗余缓存
  - 写入时双写，读取时优先 .md
  - 需要明确的缓存失效策略
  - 优点：兼容性最好
  - 缺点：一致性最复杂
```

### 3.2 跨库事务原子性（🔴 高风险）

**问题**：sync push 处理 note create/update/delete 时，需要同时操作两个独立的数据库（pomodoroxi.db 和 index.db）+ 文件系统（.md 文件）。这三者不在同一事务内：

```python
# 文档当前的桥接模式（有原子性问题）
async def _handle_note_event(event, db, fs):
    if event.action == "create":
        await fs.create_note(...)    # 写 index.db + .md（独立事务）
        db.add(note)                 # 写 pomodoroxi.db（另一事务）
        # 如果 fs 成功但 db 失败 → index.db 有记录，pomodoroxi.db 没有
        # 如果 db 成功但 fs 失败 → pomodoroxi.db 有记录，.md 文件没有
```

**建议方案：Saga 模式 + 补偿操作**

```python
async def _handle_note_create(event, db, fs):
    note_id = event.entity_id
    try:
        # 1. 先写 pomodoroxi.db（可回滚）
        note = Note(id=note_id, title=title, content_hash=hash_value, ...)
        db.add(note)
        await db.flush()  # 不 commit，在 sync_push 的 SAVEPOINT 内

        # 2. 写 .md + index.db（fs 内部有原子性保证）
        await fs.create_note(note_id, title, content, folder_id)

        # 3. 成功 → commit
        await db.commit()

    except Exception as e:
        # 4. 失败 → 补偿：删除已写入的 .md 和 index.db 记录
        await db.rollback()
        try:
            await fs.delete_note_permanent(note_id)  # 物理删除，不走回收站
        except Exception:
            logger.error(f"Compensation failed for note {note_id}")
            # 记录到修复队列，一致性检查时修复
        raise
```

### 3.3 sync_pull 读 .md 性能（🟡 中风险）

**问题**：文档的 pull 设计是"对每条 note，从 .md 文件读取正文"。如果一次 pull 返回 50 条 note，就要 50 次文件 IO：

```python
# 文档当前设计（有性能问题）
for note in notes:
    content = await fs.read_note(note.id)  # 每次打开一个 .md 文件
    result.append({...})
```

**建议方案：批量读取 + content_hash 快速跳过**

```python
async def _pull_notes(db, fs, since, limit):
    notes = await db.execute(
        select(Note).where(Note.updated_at > since).limit(limit)
    )
    result = []

    # 批量获取需要读文件的 note_id 列表
    note_ids = [n.id for n in notes]

    # 批量读取 .md 正文（减少 IO 次数）
    contents = await fs.read_notes_batch(note_ids)  # 新增批量方法

    for note, content in zip(notes, contents):
        result.append({
            "id": note.id,
            "title": note.title,
            "content": content,
            "content_hash": note.content_hash,  # 客户端可跳过未变化的
            "updated_at": note.updated_at,
        })
    return result
```

**file_system 需新增方法**：

```python
# engine/note_ops.py 新增
async def read_notes_batch(self, note_ids: list[str]) -> list[str | None]:
    """批量读取多个笔记正文，减少 IO 次数"""
    def _do():
        results = {}
        with self._lock:
            with self._connect() as conn:
                placeholders = ",".join("?" * len(note_ids))
                rows = conn.execute(
                    f"SELECT note_id, current_path FROM notes WHERE note_id IN ({placeholders})",
                    note_ids
                ).fetchall()
                for row in rows:
                    path = self.root / row["current_path"]
                    if path.exists():
                        results[row["note_id"]] = path.read_text(encoding="utf-8")
                    else:
                        results[row["note_id"]] = None
        # 保持输入顺序
        return [results.get(nid) for nid in note_ids]
    return await asyncio.to_thread(_do)
```

---

## 四、行业参考对比

### 4.1 Obsidian Sync — 纯文件同步的标杆

Obsidian 的架构与 PomodoroXII 有相似之处（本地文件 + 远程同步），但设计哲学不同：

| 维度 | Obsidian Sync | PomodoroXII 文档设计 |
|------|--------------|---------------------|
| 存储模型 | 纯文件（.md + .obsidian/） | 双存储（DB + .md） |
| 同步粒度 | 文件级 | 实体级（DB row + .md） |
| 冲突解决 | Markdown: diff-match-patch 自动合并；二进制: LWW | LWW（字符串比较 updated_at） |
| 版本历史 | 远程 vault 存全版本，保留 1-12 月 | 本地 .meta/version_backups/ |
| 全文搜索 | 客户端索引 | 服务端 FTS5 |
| 加密 | E2EE (AES-256-GCM + scrypt) | 无 |

**可借鉴点**：
1. **diff-match-patch 合并**：Obsidian 对 .md 文件用差分合并而非纯 LWW，能保留多设备并发编辑的修改。PomodoroXII 可以对 note content 引入类似机制。
2. **确定性文件哈希**：Obsidian 用内容哈希做去重和变更检测，PomodoroXII 已有 content_hash 字段但未充分利用。
3. **文件级同步粒度**：Obsidian 同步的是文件变更而非 DB row，天然避免了跨库一致性问题。

### 4.2 Tolaria — Git-first 的 Markdown 知识库（12K+ Stars）

Tolaria（2026年6月 GitHub Trending）是 "Files-first / Git-first" 的桌面 markdown 知识库，设计理念值得参考：

| 设计原则 | Tolaria 做法 | PomodoroXII 可借鉴度 |
|---------|-------------|---------------------|
| Files-first | 笔记就是 .md 文件，无私有格式 | ⭐⭐⭐⭐⭐ |
| Git-first | vault 即 git 仓库，版本历史天然 | ⭐⭐⭐⭐ |
| AI-first | AGENTS.md 引导 AI 工具读 vault | ⭐⭐⭐ |
| 类型作为透镜 | YAML frontmatter 软约束 | ⭐⭐⭐ |

**关键启示**：Tolaria 证明了"纯文件优先 + 数据库索引"的模式在 10,000+ 笔记规模下可行。PomodoroXII 的双存储设计与此思路一致，方向正确。

### 4.3 对比总结

| 方案 | 存储模型 | 同步方式 | 版本管理 | 全文搜索 | 适用规模 |
|------|---------|---------|---------|---------|---------|
| Obsidian | 纯文件 | 文件级增量 | 远程全版本 | 客户端索引 | 万级笔记 |
| Tolaria | 纯文件 + git | git push | git history | 客户端索引 | 万级笔记 |
| PomodoroXII（文档） | DB + .md 双存储 | 实体级 LWW | 本地备份 | 服务端 FTS5 | 千级笔记 |
| **PomodoroXII（建议）** | **.md 优先 + DB 索引** | **实体级 + content_hash** | **本地 + git** | **服务端 FTS5** | **万级笔记** |

---

## 五、深度开发建议

### 5.1 明确 content 所有权：.md 文件为唯一 Source of Truth

**建议**：采用方案 A，从 pomodoroxi.db 的 Note 模型中移除 content 字段。

```python
# 改进后的 Note 模型
class Note(Base):
    __tablename__ = "notes"
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    title: Mapped[str] = mapped_column(String(500), default="")
    # content 字段移除 — 正文只存 .md 文件
    summary: Mapped[str] = mapped_column(String(500), default="")
    tags: Mapped[str] = mapped_column(String(4000), default="[]")
    folder_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    status: Mapped[str] = mapped_column(String(20), default="active", index=True)
    trashed_at: Mapped[str | None] = mapped_column(String(32), nullable=True, index=True)
    content_hash: Mapped[str] = mapped_column(String(64), default="")  # 变更检测
    word_count: Mapped[int] = mapped_column(Integer, default=0)  # 统计
    created_at: Mapped[str] = mapped_column(String(32), default=utc_now_iso)
    updated_at: Mapped[str] = mapped_column(String(32), default=utc_now_iso)
```

**pull 优化**：利用 content_hash 让客户端跳过未变化的正文：

```python
# 客户端请求 pull 时带上本地 content_hash
GET /api/sync/pull?since=...&content_hashes={"note_id_1": "abc123", ...}

# 服务端返回时，content_hash 匹配的 note 不返回 content
# 客户端只下载变化的正文
```

### 5.2 跨库一致性：Saga + 定期修复

**写入流程**（Saga 模式）：

```
sync push note create:
  1. [TRY] 写 pomodoroxi.db (flush, 不 commit)
  2. [TRY] 写 .md + index.db (fs.create_note)
  3. [SUCCESS] commit pomodoroxi.db
  4. [FAILURE] rollback pomodoroxi.db + 补偿删除 .md + index.db

sync push note update:
  1. [TRY] 读旧 content_hash
  2. [TRY] 写 .md (fs.edit_note — 自动版本备份)
  3. [TRY] 更新 pomodoroxi.db (content_hash, updated_at, title)
  4. [FAILURE] 回滚 .md (用版本备份恢复)
```

**定期修复**（利用 file_system 的 consistency_ops）：

```python
# 定时任务（每小时或每天）
async def consistency_check_and_repair():
    fs = await get_file_system()
    report = await fs.check_consistency()

    for issue in report.issues:
        if issue.type == "db_has_file_missing":
            # pomodoroxi.db 有记录但 .md 不存在
            # → 从 DB.content 恢复（如果有冗余缓存）
            # → 或标记为 corrupted
        elif issue.type == "file_has_db_missing":
            # .md 存在但 pomodoroxi.db 无记录
            # → 从 .md + index.db 恢复元数据
            await fs.repair()
```

### 5.3 引入 content_hash 驱动的增量同步

**当前问题**：sync pull 用 `updated_at > since` 做增量，但 updated_at 可能因无内容变化的元数据更新（如改 title）而前进，导致客户端不必要的重新下载正文。

**改进**：双游标增量 — `updated_at` + `content_hash`：

```python
# sync_pull 返回结构
{
    "notes": [
        {
            "id": "note_xxx",
            "title": "新标题",
            "content_hash": "sha256_new",
            "content": null,  # content_hash 与客户端一致时不返回正文
            "updated_at": "2026-07-01T10:00:00.000"
        },
        {
            "id": "note_yyy",
            "title": "标题",
            "content_hash": "sha256_changed",
            "content": "完整正文...",  # hash 变化才返回
            "updated_at": "2026-07-01T10:01:00.000"
        }
    ],
    "next_since": "2026-07-01T10:01:00.000"
}
```

### 5.4 移植 file_system 时补全遗漏

**必须迁移的遗漏项**：

1. **schema_meta 表**：`_run_migrations` 依赖此表做版本管理，缺失会导致迁移逻辑失败

2. **sync_audit_log 表**：与 pomodoroxi.db 的 sync 事件日志可形成互补审计

3. **logger_config 模块**：`backup.py` 的直接依赖，需迁移或替换

4. **R7 FTS5 升级路径**：`_rebuild_fts5_if_needed()` 检测旧库重建 FTS5，移植时保留

### 5.5 回收站对齐

**问题**：file_system 有自己的 trash（.trash/ 目录 + index.db is_deleted 标记），pomodoroxi 也有 trashed_at 字段。两者需对齐。

**建议**：以 file_system 的 trash 为物理实现，pomodoroxi.db 的 trashed_at 为同步标记：

```python
async def _handle_note_delete(event, db, fs):
    # 1. file_system 软删除（移到 .trash/ + index.db 标记）
    await fs.delete_note(note_id)
    # 2. pomodoroxi.db 标记 trashed_at
    note = await db.get(Note, note_id)
    note.trashed_at = utc_now_iso()
    note.status = "trashed"
    # 3. 不创建 tombstone（软删除不触发墓碑）
    # 4. 物理删除（purge）时才创建 tombstone

async def _handle_note_purge(event, db, fs):
    # 1. file_system 彻底删除
    await fs.purge(note_id)
    # 2. pomodoroxi.db 物理删除
    await db.delete(note)
    # 3. 创建 tombstone
    db.add(Tombstone(entity_type="note", entity_id=note_id, ...))
```

### 5.6 考虑 Git 作为版本历史的补充

借鉴 Tolaria 的 Git-first 理念，可以在 PomodoroXII 中增加可选的 git 集成：

```python
# 可选：data/notes/ 目录初始化为 git 仓库
# 每次 edit_note 后自动 commit
# 优点：版本历史天然，可 diff，可 branch
# 缺点：增加部署复杂度，需 git CLI

# config.py
notes_git_enabled: bool = False  # 默认关闭，高级用户可开启
notes_git_auto_commit: bool = True

# edit_note 后
if settings.notes_git_enabled:
    subprocess.run(["git", "add", "."], cwd=notes_root)
    subprocess.run(["git", "commit", "-m", f"Update note {note_id}"], cwd=notes_root)
```

这样 file_system 的 `.meta/version_backups/` 做轻量版本备份，git 做完整版本历史，两者互补。

### 5.7 API 设计建议

```python
# /api/notes — 桥接 DB + .md
GET    /api/notes              # 列表（DB 元数据，不含正文）
GET    /api/notes/{id}         # 单条（DB 元数据 + .md 正文）
POST   /api/notes              # 创建（写 .md + DB）
PATCH  /api/notes/{id}         # 更新元数据（DB only）
PUT    /api/notes/{id}/content # 更新正文（写 .md + DB content_hash）
DELETE /api/notes/{id}         # 软删除（.trash/ + DB trashed_at）

# /api/search — FTS5
GET    /api/search?q=关键词&folder_id=xxx&limit=20

# /api/trash — 回收站
GET    /api/trash              # 列出回收站
POST   /api/trash/{type}/{id}/restore  # 恢复
DELETE /api/trash/{type}/{id}  # 物理删除（创建 tombstone）

# /api/notes/{id}/versions — 版本历史
GET    /api/notes/{id}/versions        # 版本列表
GET    /api/notes/{id}/versions/{vid}  # 获取特定版本正文

# /api/convert — 转换
POST   /api/convert/quick-note/{id}    # QuickNote → Note
```

---

## 六、改进后的目标架构

```
PomodoroXII 后端
├── 业务数据层 (pomodoroxi.db — SQLAlchemy async ORM)
│   ├── tasks, sessions, habits, schedules, ...  (业务实体)
│   ├── notes (元数据 + content_hash, 无 content 字段)  ← 改进
│   ├── folders
│   ├── tombstones
│   └── sync_events (事件审计日志)  ← 新增
│
├── 文件系统子系统 (data/notes/ — .md 文件 + index.db)
│   ├── FileSystemStorage (8 Mixin 组合)
│   │   ├── .md 文件存储 (笔记正文 — 唯一 source of truth)  ← 明确
│   │   ├── index.db (7 表 + FTS5 — 完整迁移)  ← 修正
│   │   │   ├── notes, folders, note_paths, note_versions
│   │   │   ├── note_links, schema_meta, sync_audit_log  ← 补全
│   │   │   └── notes_fts (FTS5 trigram)
│   │   ├── 版本历史 (.meta/version_backups/)
│   │   ├── 回收站 (.trash/)
│   │   └── 一致性检查 + 自动备份 + 批量读取  ← 增强
│   ├── 三层锁 (RLock → FileLock → SQLite 事务)
│   └── 可选 Git 集成 (data/notes/ = git repo)  ← 新增
│
├── Sync 引擎 (LWW + Tombstone + content_hash 增量)  ← 增强
│   ├── push: Saga 模式 (TRY DB → TRY FS → COMMIT/COMPENSATE)  ← 改进
│   ├── pull: 批量读 .md + content_hash 跳过未变化  ← 改进
│   ├── convert: QuickNote → Note (写 .md + DB)
│   └── 一致性修复: 定时 check_consistency + repair  ← 新增
│
└── API 层 (FastAPI)
    ├── /api/v1/sync/* (同步端点)
    ├── /api/v1/notes/* (笔记 CRUD — 桥接 DB + .md)
    ├── /api/v1/folders/* (文件夹 CRUD)
    ├── /api/v1/search/* (FTS5 全文搜索)
    ├── /api/v1/trash/* (回收站)
    ├── /api/v1/convert/* (QuickNote → Note)
    └── /api/admin/* (备份 + 一致性修复 + 清理)
```

---

## 七、实施路线图

### Phase 1：基础移植（1 周）

| 任务 | 说明 |
|------|------|
| 创建项目骨架 | 目录结构 + config.py + database.py |
| 移植 file_system 15 文件 | 含补全 schema_meta + sync_audit_log 表 |
| 替换 logger_config | 改为标准 logging |
| 修正 _PROJECT_ROOT | 改为 config 配置项 |
| 验证 file_system 独立运行 | `python -c "from app.file_system.engine import FileSystemStorage"` |

### Phase 2：双存储核心（1-2 周）

| 任务 | 说明 |
|------|------|
| Note 模型设计 | 移除 content 字段，保留 content_hash |
| sync push 桥接 | Saga 模式 + 补偿操作 |
| sync pull 桥接 | 批量读 .md + content_hash 增量 |
| convert-to-note | QuickNote → .md + DB |
| 回收站对齐 | file_system trash ↔ pomodoroxi trashed_at |

### Phase 3：API + 搜索（1 周）

| 任务 | 说明 |
|------|------|
| REST API 路由 | notes/folders/search/trash/convert |
| FTS5 搜索端点 | 复用 search_ops，零改动 |
| 版本历史端点 | 复用 version_ops，零改动 |
| OpenAPI schema 导出 | 供前端类型生成 |

### Phase 4：可靠性加固（1 周）

| 任务 | 说明 |
|------|------|
| 一致性检查定时任务 | 复用 consistency_ops |
| 自动备份 | 复用 backup.py |
| 跨库一致性修复 | DB ↔ .md 不一致时自动修复 |
| 集成测试 | 双存储桥接 + sync + convert + 搜索 |

### Phase 5：React 19 前端重建 + file_system 高级演进（2-3 周）

> 原 Phase 5"前端移植"为迁移 pomodoroxi 前端（Vue 3.5 + Vite 6 + Pinia 3），现重写为 React 19 + Next.js 15 前端重建，参照 01 文档的 M5a / M5b / M5c 三阶段渐进式重建。file_system 高级演进（Git 集成 / diff-match-patch / E2EE）保持可选，可与前端重建并行推进。

#### Phase 5a：React 骨架 + 框架无关代码迁移（参照 01 文档 M5a，3 天）

| 任务 | 说明 |
|------|------|
| `create-next-app` + App Router | Next.js 15 + Turbopack 初始化 |
| Tailwind v4 + shadcn/ui 初始化 | `npx shadcn@latest init` + 基础组件 |
| `app/layout.tsx` + `app/providers.tsx` | 根布局（替代 App.vue）+ QueryClientProvider + 主题 |
| 框架无关代码原样迁移 | `services/` `types/` `utils/` `workers/` 直接复制（约 30% 可复用，详见下方清单） |
| Dexie v16 schema 升级 | +content_hash 索引, -_etag |
| openapi-typescript | 从后端 OpenAPI 生成 `api-generated.ts` |
| Zustand store 骨架 | 17 个 store `create()` 空壳 + 类型定义 |
| `@serwist/next` 配置 | `sw.ts` + `next.config.ts` 接入 |
| 删除 `router/` 目录 | 改用 Next.js 文件系统路由 |
| **验证** | `next dev` 启动 + 空首页渲染 + Dexie 连接 + `app/` 路由生效 |

#### Phase 5b：逐 View 迁移（参照 01 文档 M5b，4 天）

| 任务 | 说明 |
|------|------|
| `composables/` → `hooks/` | 40+ `useXxx` 改名（use-sync / use-tasks / use-notes 等），逻辑保留 |
| Pinia actions → Zustand store | 17 个 store 逻辑平移 + selector 拆分 |
| `views/*.vue` → `app/**/page.tsx` | 按页面迁移（TaskView / NoteView / StatsView / Habits 等） |
| `components/*.vue` → `*.tsx` | 保持目录结构，`.vue` → `.tsx` |
| React Hook Form + Zod | 替代 v-model 表单（`lib/validations/` 定义 schema） |
| TanStack Query v6 接入 | `useTasks` / `useNotes` 服务端状态 + 乐观更新 |
| shadcn/ui 组件落地 | button / card / dialog / form 等按需添加 |
| 适配 notes API | content 分离 + FTS5 搜索（对接 Phase 3 的 `/api/search` 端点） |
| **验证** | 各页面功能跑通 + 表单验证 + dark mode 切换 |

#### Phase 5c：清理 Vue + PWA 收尾（参照 01 文档 M5c，2 天）

| 任务 | 说明 |
|------|------|
| 删除 Vue 残留 | `App.vue` / `main.ts` / `router/` 及 vue / vue-router / pinia 依赖 |
| PWA Service Worker 注册 | `@serwist/next` 在 Next.js 下正确注册 + 离线回退页 |
| React 19 Compiler 启用 | `next.config.ts` 配置 `babel-plugin-react-compiler` |
| Zustand store selector 测试 | 17 个 store 全部补齐 selector 单测 |
| shadcn/ui dark mode 验证 | 全组件暗色模式回归 |
| E2E 测试适配 | Playwright 跑通全流程 |
| **验证** | 前端全功能跑通 + PWA 离线可用 + 无 Vue 依赖 + Compiler 生效 |

#### 框架无关代码清单（约 30% 可直接复用）

以下代码与前端框架无关，可直接从 pomodoroxi 复制到 React 项目（详见 02 文档"框架无关代码清单"）：

| 目录/文件 | 内容 | 迁移方式 |
|-----------|------|---------|
| `services/api.ts` | Axios + Cloudflare 重试逻辑 | 原样复制 |
| `services/database.ts` | Dexie.js v15 schema 定义 | 原样复制 |
| `services/export-v2.ts` | CSV/JSON 导出 | 原样复制 |
| `services/export-arrow.ts` | Apache Arrow 导出 | 原样复制 |
| `services/convert.ts` | QuickNote → Note 转换 | 原样复制 |
| `types/index.ts` | TypeScript 类型定义 | 原样复制 |
| `utils/` | format、sync、date 等工具函数 | 原样复制 |
| `workers/` | markdown worker 等 | 原样复制 |

> 注：Dexie.js 4.4 / Tailwind CSS v4 / Axios / date-fns / markdown-it / TypeScript strict 保持不变，跨框架通用。剩余 70% 组件层（`views/*.vue` → `app/**/page.tsx`、`components/*.vue` → `*.tsx`）需重写为 React，但逻辑可参照原有实现。

#### file_system 高级演进（可选，与前端重建并行）

| 任务 | 说明 |
|------|------|
| Git 集成（可选） | data/notes/ = git repo（见 5.6 节） |
| diff-match-patch 合并 | note content 冲突时差分合并（见 4.1 节 Obsidian 参考） |
| E2EE 加密 | 参考 Obsidian 的 AES-256-GCM + scrypt |

---

## 附录：验证报告摘要

### file_system 源码验证结果

- **源码位置**：`E:\Notes\测试-demo\video-collector\Video_thrans_workflow\scripts\file_system\`
- **文件数**：15 个 .py 文件（与文档一致）
- **设计成熟度**：生产级（8 Mixin、三层锁、原子写入、FTS5、版本备份、一致性检查）
- **自包含程度**：高（仅 3 个新第三方包 + 1 个内部 logger_config 依赖）
- **文档准确率**：9/10 属实，1/10 部分属实（遗漏 2 个辅助表）

### pomodoroxi sync 引擎验证结果

- **当前架构**：单一 SQLite（pomodoroxi.db），无独立 file_system 子系统
- **Note 模型**：content 字段存在（String(100000)），存储完整正文
- **sync 与 file_system 桥接**：当前不存在，移植将是架构级新增
- **主要技术难点**：content 双重所有权、跨库事务原子性、pull 读 .md 性能

### 参考项目

| 项目 | 相关性 | 关键启示 |
|------|--------|---------|
| Obsidian Sync | 高 | diff-match-patch 合并、确定性文件哈希、文件级同步 |
| Tolaria (12K+ stars) | 高 | Files-first + Git-first 可行性验证、万级笔记规模 |
| PowerSync | 中 | Bucket 分桶同步、Write Checkpoints |
| HLC | 中 | 替代纯 LWW 的时钟方案 |
