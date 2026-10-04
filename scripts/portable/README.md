# scripts/portable — 便携硬盘开发工具链

本目录承载「把整个项目放进移动硬盘、在两台电脑之间来回切换开发」所需的脚本。
设计原则：**仓库自包含**——代码、设计稿、运行数据、Python/Node 工具链全部随硬盘走，
换一台电脑只需要跑一次 `bootstrap.ps1`（改盘符/换路径同理）。

## 四个脚本

| 脚本 | 何时跑 | 干什么 |
|---|---|---|
| `export-to-drive.ps1` | **在源电脑**（插上硬盘） | robocopy 整棵工作树（含 `.git`、设计稿、`data\`、`node_modules`）到硬盘； 在目标目录下生成 `.portable\`（uv.exe / 便携 CPython / 便携 Node / wheel 缓存 / git bundle / `requirements.lock.txt`）；并离线验证缓存可用 |
| `bootstrap.ps1` | **每台电脑首次 / 换盘符后** | 幂等修复：改写 `backend\.env` 的路径三件套；修复 `.venv`（`pyvenv.cfg home` + scikit-build editable 映射的绝对路径重锚）；挂便携 Node；`git worktree prune`；清过期 PID 文件 |
| `doctor.ps1` | bootstrap 之后、感觉不对时 | 只读体检：路径/env/venv/editable 映射/Node/node_modules/数据/迁移头闸门/端口/git/密钥卫生，逐项 PASS/WARN/FAIL，FAIL 时退出码 1 |
| `start-dev.ps1` | 日常启停 | 先挂便携环境变量，再调用 `scripts\dev-local.ps1`（后端 8100 / 前端 3010） |

## 快速命令（在仓库根目录执行）

```powershell
# 源电脑：导出到移动硬盘（盘符按实际改，如 F:\）
#   默认落到 F:\Dev\PomodoroXII（盘根只留一个开发项目容器；-DestParent 可改名，空串=盘根直放）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\portable\export-to-drive.ps1 -DriveRoot F:\

# 目标电脑（或换盘符后）：修复环境 → 体检 → 启动
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\portable\bootstrap.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\portable\doctor.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\portable\start-dev.ps1 start
```

## 设计要点（排障时先读）

- **venv 不重建、直接搬运**：`.venv` 里的 `Scripts\python.exe` 是 45KB 的转发器，
  它靠 `pyvenv.cfg` 的 `home` 找基础解释器 → 我们把 uv 托管的 CPython 一起带上，
  bootstrap 把 `home` 改指 `.portable\uv-python\...` 即可。
- **editable 映射要重锚**：`Lib\site-packages\_pomodoroxii_backend_editable.{pth,py}`
  里烤进了安装时的**绝对路径**（scikit-build-core 的 editable 机制），
  bootstrap 用 `.portable\PREV_ROOT.txt` 记录的上一个根路径做字符串替换。
  漏做这一步的症状是 `import app` 直接失败。
- **node_modules 随行**：同平台（Windows x64）直接复制可用；`.next` 已排除（会自动重建）。
  真出问题时的兜底：`bootstrap.ps1 -RepairNode`（= `npm ci`，需要网络）。
- **离线优先**：`.portable\uv-cache` 在导出时已预热并用 `--offline` 验证过。
  无网环境的兜底重建顺序：bootstrap 先试 offline，失败再联网；
  `-Offline` 开关可强制禁网。
- **git 历史**：`.git` 完整随盘；另在 `.portable\backups\` 放了一份 `git bundle --all` 快照。
  其它 worktree 的目录不在仓库内（只有分支引用在），到新机器后
  `git worktree prune` + 需要时 `git worktree add` 即可。
- **不要提交 `.portable`**：已在 `.gitignore` 排除（含二进制与缓存，机器/盘符相关）。
