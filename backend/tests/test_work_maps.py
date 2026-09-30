"""工作导图（``.mm.md``）存取 —— ADR-0008 S2 验收。

覆盖三层关注点：

1. **service 层**：路径 fail-closed（``../`` 一类在第一步即失效）、原子写不留残件、
   体积上限、非 UTF-8 容忍、space 隔离、中文往返。
2. **路由层**：认证边界、工作项存在性校验（fail-closed）、端到端 PUT → GET 往返。
3. **边界声明**：后端**不解析**导图语义 —— 本测试只搬运字节，不对 ``.mm`` 结构做断言
   （解析/建岛由前端 MindCanvas kernel 负责）。
"""
from __future__ import annotations

from pathlib import Path

import pytest

from app.mutation.types import canonical_payload_hash
from app.services.work_map import MAX_WORK_MAP_BYTES, WorkMapRejected, WorkMapService

pytestmark = pytest.mark.provisioned_space_storage

#: 一份真实的「会话岛」导图（含 centers 与节点 cid），用于验证字节级无损往返。
SAMPLE_MAP = """<!--
next_cid: c2
centers:
  - at: "node:探索小窗实现方式/09-30 会话"
    cid: c1
    dir: right
    x: 900
    y: 0
-->
# 探索小窗实现方式

<!--
cid: c1
note:
  - 先确认灰阶与玻璃主题的令牌差异
-->
## 09-30 会话

### 端口位置：运行态网格

### 待确认
"""


# ── service 层 ────────────────────────────────────────────────────────────


def test_write_then_read_roundtrip(tmp_path: Path) -> None:
    svc = WorkMapService(tmp_path)
    written = svc.write("space-a", "wi-1", SAMPLE_MAP)
    assert written == len(SAMPLE_MAP.encode("utf-8"))
    assert svc.read("space-a", "wi-1") == SAMPLE_MAP
    assert svc.exists("space-a", "wi-1") is True


def test_read_missing_returns_none(tmp_path: Path) -> None:
    assert WorkMapService(tmp_path).read("space-a", "wi-absent") is None
    assert WorkMapService(tmp_path).exists("space-a", "wi-absent") is False


def test_atomic_write_leaves_no_part_file(tmp_path: Path) -> None:
    svc = WorkMapService(tmp_path)
    svc.write("space-a", "wi-1", SAMPLE_MAP)
    svc.write("space-a", "wi-1", SAMPLE_MAP + "\n")
    assert list((tmp_path / "space-a" / "maps").glob("*.part")) == []


@pytest.mark.parametrize(
    "bad_id",
    ["../evil", "a/b", "..", "", "x" * 65, "wi.1", "wi 1", "\u0000wi", "..\\evil"],
)
def test_invalid_work_item_id_is_rejected(tmp_path: Path, bad_id: str) -> None:
    """非法 id 必须在**解析前**就被白名单挡住（不依赖 subsequent 的 containment 兜底）。"""
    svc = WorkMapService(tmp_path)
    assert svc.map_path("space-a", bad_id) is None
    assert svc.read("space-a", bad_id) is None
    with pytest.raises(WorkMapRejected):
        svc.write("space-a", bad_id, SAMPLE_MAP)


def test_oversize_write_rejected(tmp_path: Path) -> None:
    svc = WorkMapService(tmp_path)
    with pytest.raises(WorkMapRejected) as exc:
        svc.write("space-a", "wi-1", "x" * (MAX_WORK_MAP_BYTES + 1))
    assert exc.value.status == 413
    # 拒绝时不得留下半成品
    assert list((tmp_path / "space-a" / "maps").glob("*.part")) == []


def test_non_utf8_file_reads_as_none(tmp_path: Path) -> None:
    maps = tmp_path / "space-a" / "maps"
    maps.mkdir(parents=True)
    (maps / "wi-1.mm.md").write_bytes(b"\xff\xfe\x00bad")
    assert WorkMapService(tmp_path).read("space-a", "wi-1") is None


def test_spaces_are_isolated(tmp_path: Path) -> None:
    svc = WorkMapService(tmp_path)
    svc.write("space-a", "wi-1", "A")
    assert svc.read("space-b", "wi-1") is None


def test_cjk_content_survives_roundtrip(tmp_path: Path) -> None:
    svc = WorkMapService(tmp_path)
    text = "# 中文标题\n\n- 洞察：岛即会话\n- 问题：令牌不对齐\n"
    svc.write("space-a", "wi-1", text)
    assert svc.read("space-a", "wi-1") == text


# ── 路由层 ────────────────────────────────────────────────────────────────


async def _master_headers(client) -> dict[str, str]:
    resp = await client.post(
        "/api/v1/auth/setup", json={"password": "test-password-123"}
    )
    assert resp.status_code in (200, 201), resp.text
    resp = await client.post(
        "/api/v1/auth/login", json={"password": "test-password-123"}
    )
    assert resp.status_code == 200, resp.text
    return {"Authorization": f"Bearer {resp.json()['access_token']}"}


async def _space(client, master_headers: dict[str, str], name: str) -> dict:
    resp = await client.post(
        "/api/v1/spaces", json={"name": name}, headers=master_headers
    )
    assert resp.status_code == 201, resp.text
    space = resp.json()
    resp = await client.post(
        f"/api/v1/spaces/{space['id']}/token", headers=master_headers
    )
    assert resp.status_code == 200, resp.text
    return {
        "id": space["id"],
        "headers": {"Authorization": f"Bearer {resp.json()['space_token']}"},
    }


async def _work_item(client, space_headers: dict[str, str], space_id: str) -> str:
    resp = await client.post(
        "/api/v1/projects",
        json={
            "commandId": "op-proj-maps",
            "spaceId": space_id,
            "payloadHash": canonical_payload_hash(
                {"key": "MAP", "name": "Map Project", "description": None}
            ),
            "key": "MAP",
            "name": "Map Project",
        },
        headers=space_headers,
    )
    assert resp.status_code in (200, 201), resp.text
    project = resp.json()
    project_id = (
        project.get("entityId") or project.get("entity_id") or project.get("id")
    )

    payload = {
        "title": "探索小窗实现方式",
        "description": None,
        "parent_id": None,
        "type_definition_id": None,
        "status_definition_id": None,
        "priority": None,
    }
    resp = await client.post(
        "/api/v1/work-items",
        json={
            "commandId": "op-wi-maps",
            "spaceId": space_id,
            "payloadHash": canonical_payload_hash(payload),
            "projectId": project_id,
            "title": payload["title"],
            "parentId": None,
            "typeDefinitionId": None,
            "statusDefinitionId": None,
            "priority": None,
        },
        headers=space_headers,
    )
    assert resp.status_code in (200, 201), resp.text
    data = resp.json()
    return data.get("entityId") or data.get("entity_id") or data.get("id")


async def test_requires_authentication(client) -> None:
    resp = await client.get("/api/v1/work-maps/wi-1")
    assert resp.status_code in (401, 403), resp.text


async def test_put_unknown_work_item_is_404(client) -> None:
    """fail-closed：拒绝为不存在的工作项建图（防任意 id 落盘）。"""
    master = await _master_headers(client)
    space = await _space(client, master, "maps-unknown")
    resp = await client.put(
        "/api/v1/work-maps/wi-does-not-exist",
        content=SAMPLE_MAP.encode("utf-8"),
        headers={**space["headers"], "Content-Type": "text/plain"},
    )
    assert resp.status_code == 404, resp.text


async def test_http_roundtrip_for_real_work_item(client) -> None:
    """端到端 PUT → GET 往返（S2 验收的核心用例）。

    ★ 本用例同时是「GET 路由句柄所有权」的回归钉（2026-09-30 实测踩过）：
    GET 一度只依赖 get_space_context，请求打开的 AuthorizedSpaceScope 无人
    aclose → 运行时执行器闸门永不排空 → 本用例"测试通过但 teardown 挂死"。
    修复 = 路由补 ``Depends(get_space_runtime_handle)``（见 work_maps.py）。
    若该依赖被移除，本用例将以"PASSED 后卡死"的形态复现。
    """
    master = await _master_headers(client)
    space = await _space(client, master, "maps-roundtrip")
    wi_id = await _work_item(client, space["headers"], space["id"])

    # 尚未建图 → 404（语义 = 这份导图还没有）
    resp = await client.get(f"/api/v1/work-maps/{wi_id}", headers=space["headers"])
    assert resp.status_code == 404, resp.text

    # 写入
    resp = await client.put(
        f"/api/v1/work-maps/{wi_id}",
        content=SAMPLE_MAP.encode("utf-8"),
        headers={**space["headers"], "Content-Type": "text/plain"},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json() == {
        "work_item_id": wi_id,
        "bytes": len(SAMPLE_MAP.encode("utf-8")),
    }

    # 读回逐字节一致
    resp = await client.get(f"/api/v1/work-maps/{wi_id}", headers=space["headers"])
    assert resp.status_code == 200, resp.text
    assert resp.text == SAMPLE_MAP


async def test_put_rejects_traversal_id(client) -> None:
    """越界 id 在路由层即被拒（404/400），且不产生任何文件。"""
    master = await _master_headers(client)
    space = await _space(client, master, "maps-traversal")
    resp = await client.put(
        "/api/v1/work-maps/..%2Fevil",
        content=b"x",
        headers={**space["headers"], "Content-Type": "text/plain"},
    )
    assert resp.status_code in (400, 404), resp.text
