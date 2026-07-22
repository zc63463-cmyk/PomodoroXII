"""Pure request builders for Folder and Note knowledge mutations."""

from __future__ import annotations

from collections.abc import Mapping

from app.mutation.types import MutationRequest


class KnowledgeCommands:
    """Build serializable caller intent without reading any authority."""

    def create_note_request(
        self,
        payload: Mapping[str, object],
        expected_version: int | None,
    ) -> MutationRequest:
        entity_id = payload.get("id")
        if not isinstance(entity_id, str) or not entity_id:
            raise ValueError("note create requires a non-empty string id")
        return MutationRequest.from_payload(
            name="knowledge.note.create",
            entity_type="note",
            entity_id=entity_id,
            payload=payload,
            expected_version=expected_version,
        )

    def update_note_content_request(
        self,
        note_id: str,
        content: str,
        expected_version: int,
    ) -> MutationRequest:
        return self._update_note_request(
            "knowledge.note.update_content",
            note_id,
            {"content": content},
            expected_version,
        )

    def update_note_metadata_request(
        self,
        note_id: str,
        patch: Mapping[str, object],
        expected_version: int,
    ) -> MutationRequest:
        return self._update_note_request(
            "knowledge.note.update_metadata",
            note_id,
            patch,
            expected_version,
        )

    def update_note_request(
        self,
        note_id: str,
        patch: Mapping[str, object],
        expected_version: int,
    ) -> MutationRequest:
        return self._update_note_request(
            "knowledge.note.update",
            note_id,
            patch,
            expected_version,
        )

    def move_note_request(
        self,
        note_id: str,
        folder_id: str | None,
        expected_version: int,
    ) -> MutationRequest:
        return self._update_note_request(
            "knowledge.note.move",
            note_id,
            {"folder_id": folder_id},
            expected_version,
        )

    def rebuild_projection_request(self, space_id: str) -> MutationRequest:
        if not isinstance(space_id, str) or not space_id:
            raise ValueError("knowledge rebuild requires a non-empty Space id")
        return MutationRequest.from_payload(
            name="knowledge.projection.rebuild",
            entity_type="note",
            entity_id=space_id,
            payload={},
            expected_version=None,
        )

    @staticmethod
    def _update_note_request(
        name: str,
        note_id: str,
        payload: Mapping[str, object],
        expected_version: int,
    ) -> MutationRequest:
        if not isinstance(note_id, str) or not note_id:
            raise ValueError("note update requires a non-empty string id")
        return MutationRequest.from_payload(
            name=name,
            entity_type="note",
            entity_id=note_id,
            payload=payload,
            expected_version=expected_version,
        )
