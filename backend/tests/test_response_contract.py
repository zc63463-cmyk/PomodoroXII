"""Response-model contracts for PR-B B3.

The tests keep the public JSON payloads unchanged while requiring OpenAPI to
describe them with precise component schemas.  Stats routes are also exercised
through a real, empty per-space database so FastAPI response validation runs.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

import pytest

pytestmark = pytest.mark.provisioned_space_storage


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
    setup = await client.post("/api/v1/auth/setup", json={"password": "test-password-123"})
    assert setup.status_code == 201
    login = await client.post("/api/v1/auth/login", json={"password": "test-password-123"})
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
    """All three stats routes expose precise, reusable response components."""

    @pytest.mark.parametrize(
        ("path", "component_name"),
        [
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

    async def test_nested_stats_components_are_precise(self, client):
        openapi = await _openapi(client)

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

        schedule = await client.post(
            "/api/v1/schedules",
            json={
                "title": "Contract schedule",
                "due_at": "2099-12-31T23:59:59Z",
            },
            headers=headers,
        )
        assert schedule.status_code == 201

        note = await client.post(
            "/api/v1/notes",
            json={"title": "Contract note", "content": "data"},
            headers=headers,
        )
        assert note.status_code == 201

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

        schedule_summary = await client.get(
            "/api/v1/stats/schedule-summary",
            params={"days": 30},
            headers=headers,
        )
        assert schedule_summary.status_code == 200
        schedule_data = schedule_summary.json()
        assert schedule_data["total"] >= 1
        assert schedule_data["pending"] >= 1
        assert schedule_data["period_days"] == 30

        note_summary = await client.get(
            "/api/v1/stats/note-summary",
            headers=headers,
        )
        assert note_summary.status_code == 200
        assert note_summary.json()["notes"] >= 1


class TestTaskSpaceResponseSchemas:
    """Task Space routes must document precise response component schemas."""

    @pytest.mark.parametrize(
        ("method", "path", "status", "component_name"),
        [
            ("post", "/api/v1/projects", "201", "TaskSpaceAcceptedResponse"),
            ("get", "/api/v1/projects", "200", "ProjectPageResponse"),
            (
                "get",
                "/api/v1/projects/{project_id}",
                "200",
                "ProjectResponse",
            ),
            (
                "get",
                "/api/v1/projects/definitions",
                "200",
                "TaskSpaceDefinitionsResponse",
            ),
            ("post", "/api/v1/work-items", "201", "TaskSpaceAcceptedResponse"),
            ("get", "/api/v1/work-items", "200", "WorkItemPageResponse"),
            (
                "get",
                "/api/v1/work-items/{work_item_id}",
                "200",
                "WorkItemResponse",
            ),
            (
                "patch",
                "/api/v1/work-items/{work_item_id}",
                "200",
                "TaskSpaceAcceptedResponse",
            ),
            (
                "put",
                "/api/v1/work-items/{work_item_id}/note",
                "200",
                "TaskSpaceAcceptedResponse",
            ),
            (
                "get",
                "/api/v1/work-items/{work_item_id}/note",
                "200",
                "WorkItemNoteResponse",
            ),
        ],
    )
    async def test_task_space_responses_reference_components(
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
