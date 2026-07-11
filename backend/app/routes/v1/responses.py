"""Shared OpenAPI response definitions for v1 routes."""

from typing import Any

from app.schemas.common import ErrorResponse, RequestValidationErrorResponse

VALIDATION_ERROR_MODEL = ErrorResponse | RequestValidationErrorResponse

V1_VALIDATION_ERROR_RESPONSES: dict[int, dict[str, Any]] = {
    422: {
        "description": "Domain or request validation error",
        "model": VALIDATION_ERROR_MODEL,
    }
}

_VALIDATION_ERROR_SCHEMA = {
    "anyOf": [
        {"$ref": "#/components/schemas/ErrorResponse"},
        {"$ref": "#/components/schemas/RequestValidationErrorResponse"},
    ]
}

# FastAPI otherwise uses a route's PlainTextResponse media type for additional
# response models. These routes still return the JSON exception envelopes.
PLAIN_TEXT_VALIDATION_ERROR_RESPONSES: dict[int, dict[str, Any]] = {
    422: {
        "description": "Domain or request validation error",
        "content": {
            "application/json": {
                "schema": _VALIDATION_ERROR_SCHEMA,
            }
        },
    }
}
