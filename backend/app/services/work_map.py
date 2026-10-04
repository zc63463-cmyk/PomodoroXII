"""工作导图（``.mm.md``）的存取服务。

设计依据 **ADR-0008**：

- 落点 ``<spaces_data_dir>/<space_id>/maps/<work_item_id>.mm.md``
- **后端只做字节存取，不解析导图语义** —— 解析、建岛、布局由前端持有的
  MindCanvas kernel（TypeScript）负责；Python 侧既不运行也不理解 ``.mm.md``
- 原子写（临时文件 + ``replace``），避免半截文件被读到
- 路径 fail-closed：``work_item_id`` 先过白名单字符集，解析后必须仍在 space 目录内

**不是什么**（有意不做的边界）：

- 不写数据库：导图不进 sync v2 账本（ADR-0008 D2 / D6）
- 不做版本历史、不做回收站 —— 那是 notes 域既有机制，导图不复制那套复杂度
"""
from __future__ import annotations

import re
from pathlib import Path

#: 单份导图上限。`.mm.md` 是纯文本，正常规模远小于此；给足余量同时兜住异常写入。
MAX_WORK_MAP_BYTES = 2 * 1024 * 1024

#: ``work_item_id`` 白名单：只允许字母/数字/下划线/连字符，长度 1–64。
#: 项目内 id 实际是 32 位十六进制，这里略放宽以容纳测试固定值，
#: 关键是**排除**路径分隔符与点号，使 ``../`` 一类输入在第一步就失效。
_WORK_ITEM_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


class WorkMapRejected(Exception):
    """导图写入被拒（非法 id / 超出体积上限）。"""

    def __init__(self, reason: str, status: int = 400) -> None:
        super().__init__(reason)
        self.reason = reason
        self.status = status


class WorkMapService:
    """读写 space 内的工作导图文本。"""

    def __init__(self, spaces_root: Path) -> None:
        self._spaces_root = Path(spaces_root)

    def maps_dir(self, space_id: str) -> Path:
        """该 space 的导图目录（可能尚不存在）。"""
        return self._spaces_root / space_id / "maps"

    def map_path(self, space_id: str, work_item_id: str) -> Path | None:
        """解析目标文件路径；非法 id 或解析后越界一律返回 ``None``（fail-closed）。"""
        if not _WORK_ITEM_ID_RE.match(work_item_id):
            return None
        root = (self._spaces_root / space_id).resolve()
        target = (root / "maps" / f"{work_item_id}.mm.md").resolve()
        try:
            target.relative_to(root)
        except ValueError:
            return None
        return target

    def read(self, space_id: str, work_item_id: str) -> str | None:
        """读回导图原文。

        不存在、id 非法、越界、非 UTF-8 —— 一律返回 ``None``（不抛异常）：
        调用方据此回 404，语义上等价于"这份导图还没有"。
        """
        target = self.map_path(space_id, work_item_id)
        if target is None or not target.is_file():
            return None
        try:
            return target.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            return None

    def write(self, space_id: str, work_item_id: str, text: str) -> int:
        """原子写入导图原文，返回写入字节数。"""
        target = self.map_path(space_id, work_item_id)
        if target is None:
            raise WorkMapRejected("invalid_work_item_id")
        data = text.encode("utf-8")
        if len(data) > MAX_WORK_MAP_BYTES:
            raise WorkMapRejected(
                f"work_map_too_large:max_{MAX_WORK_MAP_BYTES // 1024 // 1024}mb", 413
            )
        target.parent.mkdir(parents=True, exist_ok=True)
        # ★ 先写 .part 再 replace：读者永远看不到半截文件
        tmp = target.with_suffix(target.suffix + ".part")
        tmp.write_bytes(data)
        tmp.replace(target)
        return len(data)

    def exists(self, space_id: str, work_item_id: str) -> bool:
        target = self.map_path(space_id, work_item_id)
        return target is not None and target.is_file()
