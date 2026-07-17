from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

FIXTURE_ROOT = Path(__file__).resolve().parent / "fixtures" / "certification"


@pytest.mark.asyncio
async def test_n_minus_one_fixture_matches_manifest(tmp_path: Path) -> None:
    from tests.fixtures.certification.populate_n_minus_one import populate_fixture

    manifest_path = FIXTURE_ROOT / "n_minus_one_manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    receipt = await populate_fixture(tmp_path / "n-minus-one", manifest_path)

    assert (
        manifest["subject_sha"]
        == "1e4f0fc6d82ce6203f4bada0e84b518b16fcd97f"
    )
    assert receipt.space_id == manifest["space_id"]
    assert receipt.entity_counts == manifest["expected"]["entity_counts"]
    assert receipt.sync_waterline == manifest["expected"]["sync_waterline"]
    assert receipt.meta_db.is_file()
    assert receipt.space_db.is_file()
    assert receipt.index_db.is_file()
    bodies = {
        note_id: hashlib.sha256(body.encode("utf-8")).hexdigest()
        for note_id, body in receipt.note_bodies.items()
    }
    assert bodies == manifest["expected"]["note_body_sha256"]
