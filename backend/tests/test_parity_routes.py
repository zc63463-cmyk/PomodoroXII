"""Parity gate: REGISTRY vs routes/v1/__init__.py include list.

确保 route_enabled=True 的实体在 build_v1_router() 中有对应 include_router。
当前用源代码字符串检查作为轻量级 gate；Phase 2 引入 route_enabled 后可收紧。
"""
from __future__ import annotations

import inspect

from app.routes.v1 import build_v1_router


def test_build_v1_router_includes_all_expected_modules():
    """build_v1_router 必须包含 16 个 sub-routers（3 meta + 13 space）。"""
    source = inspect.getsource(build_v1_router)
    include_count = source.count("router.include_router(")
    assert include_count == 16, (
        f"Expected 16 include_router calls, got {include_count}"
    )


def test_expected_route_prefixes_present():
    """16 个关键路由前缀必须存在。"""
    source = inspect.getsource(build_v1_router)
    expected_prefixes = [
        'prefix="/tasks"',
        'prefix="/sessions"',
        'prefix="/notes"',
        'prefix="/folders"',
        'prefix="/quick-notes"',
        'prefix="/reflections"',
        'prefix="/habits"',
        'prefix="/schedules"',
        'prefix="/time-blocks"',
        'prefix="/trash"',
        'prefix="/stats"',
        'prefix="/settings"',
        'prefix="/sync"',
        'prefix="/auth"',
        'prefix="/spaces"',
        'prefix="/meta"',
    ]
    missing = [p for p in expected_prefixes if p not in source]
    assert not missing, f"Missing route prefixes: {missing}"
