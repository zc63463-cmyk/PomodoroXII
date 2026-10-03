"""Locator-bound 生命周期端点的**响应映射**判别测试（2026-10-03 真机回归）。

缺陷现象
--------
``POST /api/v1/active-session/heartbeat`` 返回 **500**，后端日志：

    pydantic_core._pydantic_core.ValidationError: 10 validation errors for
    ActiveSessionLocatorResponse
    spaceId / sessionId / operationId / state / ownerDeviceId / ownerTabId /
    ownershipEpoch / leaseExpiresAt / updatedAt   Field required
    locator  Extra inputs are not permitted

根因
----
Coordinator 返回的 view 形状是 **嵌套** 的::

    {"locator": {"space_id": ..., "session_id": ...}, "operation": {...}}

而 ``ActiveSessionLocatorResponse`` 要求 **扁平** 字段（``extra="forbid"``，
既不认嵌套 ``locator``，也不认多余的 ``operation``）。
``heartbeat`` 端点写了 ``model_validate(dict(view.value))`` —— **直接喂嵌套形状**，
于是 10 个字段全报 missing + 1 个 extra。

同文件里的 ``_flatten_session_response``（给 ``ActiveSessionResponse`` 用）
已经在做正确的事，本测试锁住的就是"heartbeat 也要走同一条解包路径"。

测试口径：不打真实 coordinator（那需要整套 UoW + DB），
直接用**真实模型**验证映射函数对**coordinator 真实返回形状**的解包结果。
"""

from __future__ import annotations

from typing import Any

import pytest

from app.routes.v1.active_session import _map_locator_response
from app.schemas.focus_session import ActiveSessionLocatorResponse

# coordinator `_locator_view(locator)` 的真实字段集（snake_case）
# 时间戳格式取自 `_canonical_utc_now`（coordinator.py:117-121）：**毫秒 3 位** + Z
LOCATOR_FIELDS: dict[str, Any] = {
    "space_id": "2c1b5b92242544668bca19d1066aceb8",
    "session_id": "c766be47-8725-443b-86e3-7cfee648a2f4",
    "operation_id": "op-1",
    "state": "active",
    "owner_device_id": "device-1",
    "owner_tab_id": "tab-1",
    "ownership_epoch": 3,
    "lease_expires_at": "2026-10-03T09:00:00.000Z",
    "updated_at": "2026-10-03T08:00:00.000Z",
}


def test_locator_response_accepts_nested_view() -> None:
    """回归：coordinator 的嵌套 ``{"locator": {...}}`` 必须能解包成扁平响应。"""
    # 这正是旧实现直接 model_validate 时喂进去的形状
    view_value = {"locator": dict(LOCATOR_FIELDS)}

    response = _map_locator_response(view_value)

    assert response.space_id == LOCATOR_FIELDS["space_id"]
    assert response.session_id == LOCATOR_FIELDS["session_id"]
    assert response.state == "active"
    assert response.ownership_epoch == 3


def test_locator_response_drops_operation_key() -> None:
    """``operation`` 明细不属于 ``ActiveSessionLocatorResponse``，必须被丢弃。

    模型是 ``extra="forbid"``：多一个键就 500。coordinator 在有 operation
    时会带上它（``coordinator.py:425-428``），这是**生产真实形状**。
    """
    view_value = {
        "locator": dict(LOCATOR_FIELDS),
        "operation": {"kind": "heartbeat", "detail": "..."},
    }

    response = _map_locator_response(view_value)

    assert response.session_id == LOCATOR_FIELDS["session_id"]


def test_locator_response_raises_on_missing_locator() -> None:
    """形状完全不符时**必须 fail-loud**，不能静默返回半个响应。"""
    with pytest.raises(Exception):
        _map_locator_response({"unexpected": True})


def test_locator_response_passes_model_roundtrip() -> None:
    """解包结果必须能通过模型的 alias 校验（camelCase 输出）。"""
    response = _map_locator_response({"locator": dict(LOCATOR_FIELDS)})
    dumped = ActiveSessionLocatorResponse.model_validate(
        response.model_dump(by_alias=True)
    )
    assert dumped.session_id == LOCATOR_FIELDS["session_id"]
