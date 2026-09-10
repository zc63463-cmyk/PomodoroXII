"""S1 asset 存储：白名单、大小、去重、路径遍历防护."""

from pathlib import Path

import pytest

from app.services.asset import (
    MAX_SIZE,
    AssetRejected,
    AssetService,
    StoredAsset,
)

PNG = b"\x89PNG\r\n\x1a\n" + b"0" * 64


def _svc(tmp_path: Path) -> AssetService:
    return AssetService(tmp_path / "spaces")


def test_store_png(tmp_path: Path) -> None:
    got = _svc(tmp_path).store("sp1", "shot.png", PNG)
    assert isinstance(got, StoredAsset)
    assert got.mime == "image/png"
    assert got.size == len(PNG)
    assert got.storage_key.endswith(".png")
    assert (tmp_path / "spaces" / "sp1" / got.storage_key).is_file()


def test_content_addressed_dedup(tmp_path: Path) -> None:
    svc = _svc(tmp_path)
    a = svc.store("sp1", "a.png", PNG)
    b = svc.store("sp1", "different-name.png", PNG)
    # 同内容 -> 同 sha256 -> 同 storage_key（只存一份）
    assert a.sha256 == b.sha256
    assert a.storage_key == b.storage_key
    files = list((tmp_path / "spaces" / "sp1" / "assets").rglob("*"))
    assert len([f for f in files if f.is_file()]) == 1


def test_rejects_disallowed_type(tmp_path: Path) -> None:
    with pytest.raises(AssetRejected) as exc:
        _svc(tmp_path).store("sp1", "evil.exe", b"MZ")
    assert exc.value.status == 415


def test_rejects_oversized(tmp_path: Path) -> None:
    with pytest.raises(AssetRejected) as exc:
        _svc(tmp_path).store("sp1", "big.png", b"x" * (MAX_SIZE + 1))
    assert exc.value.status == 413


def test_rejects_empty(tmp_path: Path) -> None:
    with pytest.raises(AssetRejected):
        _svc(tmp_path).store("sp1", "empty.png", b"")


def test_filename_is_sanitised(tmp_path: Path) -> None:
    got = _svc(tmp_path).store("sp1", "../../etc/passwd.png", PNG)
    # 目录部分被剥掉，只留文件名；且落盘路径用的是 sha256，不含用户输入
    assert "/" not in got.filename
    assert ".." not in got.filename
    assert got.storage_key.startswith("assets/")


def test_read_roundtrip(tmp_path: Path) -> None:
    svc = _svc(tmp_path)
    stored = svc.store("sp1", "x.png", PNG)
    assert svc.read("sp1", stored.storage_key) == PNG


def test_read_blocks_path_traversal(tmp_path: Path) -> None:
    svc = _svc(tmp_path)
    # 在 space 外放一个文件，尝试通过 ../ 读它
    outside = tmp_path / "secret.txt"
    outside.write_text("top secret")
    assert svc.read("sp1", "../secret.txt") is None


def test_read_missing_returns_none(tmp_path: Path) -> None:
    assert _svc(tmp_path).read("sp1", "assets/aa/does-not-exist.png") is None


def test_pdf_allowed(tmp_path: Path) -> None:
    got = _svc(tmp_path).store("sp1", "paper.pdf", b"%PDF-1.4 fake")
    assert got.mime == "application/pdf"


def test_mime_falls_back_to_declared(tmp_path: Path) -> None:
    """文件名无扩展名时，回退到声明的 Content-Type。"""
    got = _svc(tmp_path).store("sp1", "noext", PNG, declared_mime="image/png")
    assert got.mime == "image/png"
