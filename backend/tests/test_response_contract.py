"""Response-model contracts for PR-B B3.

The tests keep the public JSON payloads unchanged while requiring OpenAPI to
describe them with precise component schemas.  Stats routes are also exercised
through a real, empty per-space database so FastAPI response validation runs.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

import pytest


def _response_schema(
    openapi: Mapping[str, Any],
    method: str,
    path: str,
    status: str = "200",
) -> dict[str, Any]:
    return openapi["paths"][path][method]["responses"][status]["content"][
        "application/json"
    ]["schema"]


def _component(openapi: Mapping[str, Any], name: str) -> dict[str, Any]:
    return openapi["components"]["schemas"][name]


def _assert_component_ref(schema: Mapping[str, Any], name: str) -> None:
    assert schema == {"$ref": f"#/components/schemas/{name}"}


def _assert_object_fields(
    component: Mapping[str, Any],
    expected_types: Mapping[str, str],
) -> None:
    assert component.get("type") == "object"
    properties = component.get("properties", {})
    assert set(properties) == set(expected_types)
    assert set(component.get("required", [])) == set(expected_types)
    for field, expected_type in expected_types.items():
        assert properties[field].get("type") == expected_type


async def _openapi(client) -> dict[str, Any]:
    response = await client.get("/openapi.json")
    assert response.status_code == 200
    return response.json()


async def _empty_space_headers(client) -> dict[str, str]:
    setup = await client.post("/api/v1/auth/setup", json={"password": "test123"})
    assert setup.status_code == 201
    login = await client.post("/api/v1/auth/login", json={"password": "test123"})
    assert login.status_code == 200
    master_headers = {
        "Authorization": f"Bearer {login.json()['access_token']}"
    }
    created = await client.post(
        "/api/v1/spaces",
        json={"name": "Empty Stats Space"},
        headers=master_headers,
    )
    assert created.status_code == 201
    token = await client.post(
        f"/api/v1/spaces/{created.json()['id']}/token",
        headers=master_headers,
    )
    assert token.status_code == 200
    return {"Authorization": f"Bearer {token.json()['space_token']}"}


class TestCoreResponseSchemas:
    """Auth, Space, settings, and health expose concrete response schemas."""

    @pytest.mark.parametrize(
        ("method", "path", "status", "component_name"),
        [
            ("post", "/api/v1/auth/setup", "201", "AuthSetupResponse"),
            ("post", "/api/v1/auth/login", "200", "AuthLoginResponse"),
            ("get", "/api/v1/auth/verify", "200", "AuthVerifyResponse"),
            ("post", "/api/v1/spaces", "201", "SpaceResponse"),
            ("get", "/api/v1/spaces/{space_id}", "200", "SpaceResponse"),
            (
                "post",
                "/api/v1/spaces/{space_id}/token",
                "200",
                "SpaceTokenResponse",
            ),
            ("get", "/api/v1/settings", "200", "SettingsResponse"),
            ("put", "/api/v1/settings", "200", "SettingsUpdateResponse"),
            ("get", "/api/health", "200", "HealthResponse"),
        ],
    )
    async def test_object_responses_reference_components(
        self,
        client,
        method: str,
        path: str,
        status: str,
        component_name: str,
    ):
        openapi = await _openapi(client)
        _assert_component_ref(
            _response_schema(openapi, method, path, status), component_name
        )

    async def test_space_list_is_a_bare_typed_array(self, client):
        openapi = await _openapi(client)
        schema = _response_schema(openapi, "get", "/api/v1/spaces")
        assert schema.get("type") == "array"
        _assert_component_ref(schema.get("items", {}), "SpaceResponse")
        assert "properties" not in schema

    async def test_core_components_have_exact_field_types(self, client):
        openapi = await _openapi(client)
        expected = {
            "AuthSetupResponse": {"message": "string"},
            "AuthLoginResponse": {
                "access_token": "string",
                "token_type": "string",
            },
            "AuthVerifyResponse": {
                "valid": "boolean",
                "user_id": "string",
                "type": "string",
            },
            "SpaceResponse": {
                "id": "string",
                "name": "string",
                "db_path": "string",
                "notes_dir": "string",
                "is_default": "boolean",
                "created_at": "string",
                "updated_at": "string",
            },
            "SpaceTokenResponse": {
                "space_token": "string",
                "token_type": "string",
            },
            "HealthResponse": {"status": "string", "version": "string"},
        }
        for name, fields in expected.items():
            _assert_object_fields(_component(openapi, name), fields)

    async def test_settings_components_are_typed_maps(self, client):
        openapi = await _openapi(client)

        settings = _component(openapi, "SettingsResponse")
        assert settings.get("type") == "object"
        assert settings.get("additionalProperties") == {"type": "string"}

        update = _component(openapi, "SettingsUpdateResponse")
        assert set(update.get("required", [])) == {"updated", "rejected"}
        properties = update.get("properties", {})
        assert properties["updated"] == {
            "additionalProperties": {"type": "string"},
            "type": "object",
            "title": "Updated",
        }
        assert properties["rejected"].get("type") == "array"
        assert properties["rejected"].get("items") == {"type": "string"}


class TestStatsResponseSchemas:
    """All seven stats routes expose precise, reusable response components."""

    @pytest.mark.parametrize(
        ("path", "component_name"),
        [
            ("/api/v1/stats/overview", "StatsOverviewResponse"),
            ("/api/v1/stats/focus-trend", "FocusTrendResponse"),
            ("/api/v1/stats/task-distribution", "TaskDistributionResponse"),
            ("/api/v1/stats/daily-detail", "DailyDetailResponse"),
            ("/api/v1/stats/habit-summary", "HabitSummaryResponse"),
            ("/api/v1/stats/schedule-summary", "ScheduleSummaryResponse"),
            ("/api/v1/stats/note-summary", "NoteSummaryResponse"),
        ],
    )
    async def test_stats_responses_reference_components(
        self,
        client,
        path: str,
        component_name: str,
    ):
        openapi = await _openapi(client)
        _assert_component_ref(_response_schema(openapi, "get", path), component_name)

    async def test_overview_keeps_dynamic_typed_period_keys(self, client):
        openapi = await _openapi(client)
        overview = _component(openapi, "StatsOverviewResponse")
        assert overview.get("type") == "object"
        assert overview.get("additionalProperties") == {
            "$ref": "#/components/schemas/CountDuration"
        }
        assert "properties" not in overview
        _assert_object_fields(
            _component(openapi, "CountDuration"),
            {"count": "integer", "duration": "integer"},
        )

    async def test_nested_stats_components_are_precise(self, client):
        openapi = await _openapi(client)

        _assert_object_fields(
            _component(openapi, "FocusTrendPoint"),
            {"date": "string", "count": "integer", "duration": "integer"},
        )
        trend = _component(openapi, "FocusTrendResponse")
        assert set(trend.get("required", [])) == {"data"}
        assert trend["properties"]["data"].get("type") == "array"
        _assert_component_ref(
            trend["properties"]["data"].get("items", {}), "FocusTrendPoint"
        )

        distribution = _component(openapi, "TaskDistributionResponse")
        assert set(distribution.get("required", [])) == {
            "by_status",
            "by_priority",
        }
        for field in ("by_status", "by_priority"):
            assert distribution["properties"][field].get("type") == "object"
            assert distribution["properties"][field].get("additionalProperties") == {
                "type": "integer"
            }

        _assert_object_fields(
            _component(openapi, "DailyDetailResponse"),
            {"date": "string", "count": "integer", "duration": "integer"},
        )
        _assert_object_fields(
            _component(openapi, "HabitSummaryItem"),
            {
                "habit_id": "string",
                "title": "string",
                "total_check_ins": "integer",
                "check_in_days": "integer",
                "current_streak": "integer",
                "completion_rate": "number",
            },
        )
        habit_summary = _component(openapi, "HabitSummaryResponse")
        assert set(habit_summary.get("required", [])) == {"habits", "period_days"}
        assert habit_summary["properties"]["period_days"].get("type") == "integer"
        assert habit_summary["properties"]["habits"].get("type") == "array"
        _assert_component_ref(
            habit_summary["properties"]["habits"].get("items", {}),
            "HabitSummaryItem",
        )

        _assert_object_fields(
            _component(openapi, "ScheduleSummaryResponse"),
            {
                "total": "integer",
                "completed": "integer",
                "pending": "integer",
                "overdue": "integer",
                "period_days": "integer",
                "completion_rate": "number",
            },
        )
        _assert_object_fields(
            _component(openapi, "NoteSummaryResponse"),
            {
                "notes": "integer",
                "folders": "integer",
                "trashed_notes": "integer",
                "trashed_folders": "integer",
            },
        )


class TestEmptySpaceStatsResponses:
    """A real empty space satisfies response validation for every stats route."""

    async def test_all_stats_routes_validate_documented_empty_shapes(self, client):
        headers = await _empty_space_headers(client)

        overview = await client.get(
            "/api/v1/stats/overview",
            params={"periods": "custom-window"},
            headers=headers,
        )
        assert overview.status_code == 200
        assert overview.json() == {
            "custom-window": {"count": 0, "duration": 0}
        }

        trend = await client.get(
            "/api/v1/stats/focus-trend", params={"days": 7}, headers=headers
        )
        assert trend.status_code == 200
        trend_body = trend.json()
        assert set(trend_body) == {"data"}
        assert len(trend_body["data"]) == 7
        assert all(
            set(point) == {"date", "count", "duration"}
            and isinstance(point["date"], str)
            and point["count"] == 0
            and point["duration"] == 0
            for point in trend_body["data"]
        )

        distribution = await client.get(
            "/api/v1/stats/task-distribution", headers=headers
        )
        assert distribution.status_code == 200
        assert distribution.json() == {"by_status": {}, "by_priority": {}}

        daily = await client.get(
            "/api/v1/stats/daily-detail",
            params={"date": "2026-07-01"},
            headers=headers,
        )
        assert daily.status_code == 200
        assert daily.json() == {"date": "2026-07-01", "count": 0, "duration": 0}

        habit = await client.get(
            "/api/v1/stats/habit-summary", params={"days": 30}, headers=headers
        )
        assert habit.status_code == 200
        assert habit.json() == {"habits": [], "period_days": 30}

        schedule = await client.get(
            "/api/v1/stats/schedule-summary", params={"days": 30}, headers=headers
        )
        assert schedule.status_code == 200
        assert schedule.json() == {
            "total": 0,
            "completed": 0,
            "pending": 0,
            "overdue": 0,
            "completion_rate": 0.0,
            "period_days": 30,
        }

        notes = await client.get("/api/v1/stats/note-summary", headers=headers)
        assert notes.status_code == 200
        assert notes.json() == {
            "notes": 0,
            "folders": 0,
            "trashed_notes": 0,
            "trashed_folders": 0,
        }


class TestPopulatedSpaceStatsResponses:
    """Populated SQL aggregates satisfy their nested response models."""

    async def test_nested_stats_routes_validate_populated_shapes(self, client):
        from app.services.time import utc_now

        headers = await _empty_space_headers(client)
        today = utc_now().date().isoformat()

        task = await client.post(
            "/api/v1/tasks",
            json={
                "title": "Contract task",
                "status": "in_progress",
                "priority": "high",
            },
            headers=headers,
        )
        assert task.status_code == 201

        habit = await client.post(
            "/api/v1/habits",
            json={"title": "Contract habit"},
            headers=headers,
        )
        assert habit.status_code == 201
        habit_id = habit.json()["id"]

        check_in = await client.post(
            f"/api/v1/habits/{habit_id}/check-ins",
            json={"habit_id": habit_id, "date": today},
            headers=headers,
        )
        assert check_in.status_code == 201

        session = await client.post(
            "/api/v1/sessions",
            json={
                "type": "work",
                "duration": 25,
                "completed": True,
                "started_at": f"{today}T10:00:00Z",
            },
            headers=headers,
        )
        assert session.status_code == 201

        distribution = await client.get(
            "/api/v1/stats/task-distribution",
            headers=headers,
        )
        assert distribution.status_code == 200
        assert distribution.json() == {
            "by_status": {"in_progress": 1},
            "by_priority": {"high": 1},
        }

        habit_summary = await client.get(
            "/api/v1/stats/habit-summary",
            params={"days": 30},
            headers=headers,
        )
        assert habit_summary.status_code == 200
        assert habit_summary.json() == {
            "habits": [
                {
                    "habit_id": habit_id,
                    "title": "Contract habit",
                    "total_check_ins": 1,
                    "check_in_days": 1,
                    "current_streak": 1,
                    "completion_rate": 0.0333,
                }
            ],
            "period_days": 30,
        }

        focus_trend = await client.get(
            "/api/v1/stats/focus-trend",
            params={"days": 7},
            headers=headers,
        )
        assert focus_trend.status_code == 200
        focus_body = focus_trend.json()
        assert set(focus_body) == {"data"}
        assert len(focus_body["data"]) == 7
        assert all(
            set(point) == {"date", "count", "duration"}
            and isinstance(point["date"], str)
            and isinstance(point["count"], int)
            and isinstance(point["duration"], int)
            for point in focus_body["data"]
        )
        assert next(
            point for point in focus_body["data"] if point["date"] == today
        ) == {"date": today, "count": 1, "duration": 25}
