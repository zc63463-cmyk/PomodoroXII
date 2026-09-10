"""Asset storage service (S1: local, no sync).

★ 设计要点
- **content-addressed**：文件名 = sha256，同一内容只存一份（跨笔记、跨设备自动去重）
- **两段式**：DB 存元数据，磁盘存二进制；同步时只传元数据（S2/S3 再做二进制）
- **安全**：
  - 落盘文件名**只用服务端算出的 sha256 + 白名单扩展名**，绝不用用户传的 filename
    （否则 `../../etc/passwd` 这类路径遍历直接能写任意位置）
  - MIME 白名单 + 大小上限
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass
from pathlib import Path

# --------------------------------------------------------------------------- #
# 允许的类型与大小
# --------------------------------------------------------------------------- #

# 扩展名 -> 规范 MIME（只认扩展名白名单，不信任客户端的 Content-Type）
ALLOWED_TYPES: dict[str, str] = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".pdf": "application/pdf",
}

# 单文件上限（10MB）
MAX_SIZE = 10 * 1024 * 1024

# 只保留 [a-z0-9.-]，其余换成 _
_SAFE_EXT = re.compile(r"[^a-z0-9.]+")


class AssetRejected(Exception):
    """上传被拒绝（类型/大小不合法）。"""

    def __init__(self, reason: str, status: int = 400) -> None:
        super().__init__(reason)
        self.reason = reason
        self.status = status


@dataclass(frozen=True)
class StoredAsset:
    """落盘结果（service 层，与 ORM 解耦，便于单测）。"""

    filename: str
    mime: str
    size: int
    sha256: str
    storage_key: str


def _safe_filename(original: str) -> str:
    """原始文件名只做**展示**用，去掉控制字符与路径分隔符。"""
    name = Path(original.replace("\\", "/")).name  # 去掉目录部分
    name = _SAFE_EXT.sub("_", name.lower())
    return name[:255]


def resolve_extension(filename: str, declared_mime: str | None = None) -> str:
    """从文件名推断扩展名；未知则回退到声明的 MIME 对应的扩展名。"""
    ext = Path(filename.replace("\\", "/")).suffix.lower()
    if ext in ALLOWED_TYPES:
        return ext
    if declared_mime:
        for candidate, mime in ALLOWED_TYPES.items():
            if mime == declared_mime.lower():
                return candidate
    return ""


class AssetService:
    """保存 / 读取 space 内的二进制资源。"""

    def __init__(self, spaces_root: Path) -> None:
        self._spaces_root = Path(spaces_root)

    def space_assets_dir(self, space_id: str) -> Path:
        return self._spaces_root / space_id / "assets"

    def store(
        self,
        space_id: str,
        filename: str,
        data: bytes,
        declared_mime: str | None = None,
    ) -> StoredAsset:
        """校验 -> 算 hash -> 落盘（已存在则复用）。"""
        if not data:
            raise AssetRejected("empty file")
        if len(data) > MAX_SIZE:
            raise AssetRejected(f"file too large (max {MAX_SIZE // 1024 // 1024}MB)", 413)

        ext = resolve_extension(filename, declared_mime)
        if not ext:
            allowed = ", ".join(sorted(ALLOWED_TYPES))
            raise AssetRejected(f"unsupported file type; allowed: {allowed}", 415)

        sha = hashlib.sha256(data).hexdigest()
        # ★ 前两位分片，避免单目录文件过多
        rel = Path("assets") / sha[:2] / f"{sha}{ext}"

        target = self._spaces_root / space_id / rel
        if not target.exists():
            target.parent.mkdir(parents=True, exist_ok=True)
            # 先写临时文件再重命名：避免半截文件被读到
            tmp = target.with_suffix(target.suffix + ".part")
            tmp.write_bytes(data)
            tmp.replace(target)

        return StoredAsset(
            filename=_safe_filename(filename),
            mime=ALLOWED_TYPES[ext],
            size=len(data),
            sha256=sha,
            storage_key=rel.as_posix(),
        )

    def read(self, space_id: str, storage_key: str) -> bytes | None:
        """按 storage_key 读回内容。返回 None 表示不存在或越界。"""
        # ★ 防路径遍历：解析后必须仍在 space 的 assets 目录内
        root = (self._spaces_root / space_id).resolve()
        target = (root / storage_key).resolve()
        try:
            target.relative_to(root)
        except ValueError:
            return None
        if not target.is_file():
            return None
        return target.read_bytes()
