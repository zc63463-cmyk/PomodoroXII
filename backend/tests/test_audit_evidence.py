from __future__ import annotations

import copy
import hashlib
import json
from pathlib import Path

import pytest

AUDITED_SHA = "d20f200a95c25c25b1572da1781fde55560cdce0"
EXPECTED_BASELINE_EVIDENCE_IDS = {
    "EV-SOURCE-RUNTIME-AUTH",
    "EV-SOURCE-MIGRATION",
    "EV-SOURCE-REGISTRY",
    "EV-SOURCE-ENTITY",
    "EV-SOURCE-SYNC",
    "EV-SOURCE-NOTES",
    "EV-SOURCE-DELIVERY",
    "EV-SOURCE-MCP",
    "EV-COLLECT",
    "EV-RUFF",
    "EV-FOCUSED-AUTH",
    "EV-FOCUSED-SYNC",
    "EV-FOCUSED-MIGRATION",
    "EV-GITHUB-CI",
}

AUDIT_ROOT = Path(__file__).resolve().parents[1] / "audit" / "95plus"
MODULE_IDS = {
    "runtime_auth",
    "migration_space_lifecycle",
    "registry_meta",
    "entity_commands",
    "sync_push",
    "sync_pull_recovery",
    "notes_fs",
    "deploy_operations",
    "mcp",
}
EVIDENCE_FIELDS = {
    "evidence_id",
    "subject_sha",
    "command",
    "cwd",
    "runtime",
    "started_at",
    "finished_at",
    "exit_code",
    "result",
    "artifact_path",
    "artifact_sha256",
    "artifact_size_bytes",
    "trust_level",
    "confidence",
    "modules",
    "finding_ids",
    "certification_tags",
}
FINDING_FIELDS = {
    "finding_id",
    "severity",
    "status",
    "classification",
    "release_blocker",
    "modules",
    "evidence_ids",
}


def load_json(name: str) -> dict:
    return json.loads((AUDIT_ROOT / name).read_text(encoding="utf-8"))


def load_evidence_contract():
    from app.audit import evidence_contract

    return evidence_contract


def valid_envelope(tmp_path: Path) -> dict:
    artifact = tmp_path / "artifact.json"
    artifact.write_text("{}", encoding="utf-8")
    return {
        "schema_version": "1.0",
        "records": [
            {
                "evidence_id": "EV-VALID",
                "subject_sha": AUDITED_SHA,
                "command": "python -m pytest -q",
                "cwd": "backend",
                "runtime": {
                    "name": "python",
                    "version": "3.13.5",
                    "platform": "test",
                },
                "started_at": "2026-07-14T00:00:00+00:00",
                "finished_at": "2026-07-14T00:00:01+00:00",
                "exit_code": 0,
                "result": "passed",
                "artifact_path": "artifact.json",
                "artifact_sha256": hashlib.sha256(b"{}").hexdigest(),
                "artifact_size_bytes": 2,
                "trust_level": "local_snapshot",
                "confidence": "confirmed",
                "modules": ["runtime_auth"],
                "finding_ids": ["P0-01"],
                "certification_tags": [],
            }
        ],
    }


def test_evidence_schema_is_closed_and_requires_the_locked_record_fields() -> None:
    schema = load_json("evidence.schema.json")
    record = schema["$defs"]["evidence_record"]
    finding = schema["$defs"]["finding_record"]
    assert schema["$schema"] == "https://json-schema.org/draft/2020-12/schema"
    assert schema["additionalProperties"] is False
    assert record["additionalProperties"] is False
    assert set(record["required"]) == EVIDENCE_FIELDS
    assert set(record["properties"]) == EVIDENCE_FIELDS
    assert record["properties"]["trust_level"]["enum"] == [
        "local_snapshot",
        "pr_local",
        "trusted_push",
        "release_drill",
    ]
    assert record["properties"]["artifact_size_bytes"] == {
        "type": ["integer", "null"],
        "minimum": 0,
    }
    certification_rule = record["allOf"][0]
    assert certification_rule["if"]["properties"]["certification_tags"] == {
        "minItems": 1
    }
    assert set(certification_rule["then"]["properties"]) == {
        "artifact_path",
        "artifact_sha256",
        "artifact_size_bytes",
    }
    assert finding["additionalProperties"] is False
    assert set(finding["required"]) == FINDING_FIELDS
    assert set(finding["properties"]) == FINDING_FIELDS


def test_score_policy_locks_modules_dimensions_formula_thresholds_and_caps() -> None:
    policy = load_json("score-policy.json")
    assert set(policy["modules"]) == MODULE_IDS
    assert policy["dimensions"] == {
        "completeness": {"minimum": 0, "maximum": 20},
        "integrity": {"minimum": 0, "maximum": 20},
        "verification": {"minimum": 0, "maximum": 20},
        "operability": {"minimum": 0, "maximum": 20},
        "maintainability": {"minimum": 0, "maximum": 20},
    }
    assert policy["formula"]["module_composite"] == (
        "0.4*((completeness+integrity)/40*100)+"
        "0.6*((verification+operability+maintainability)/60*100)"
    )
    assert policy["thresholds"] == {
        "backend_composite_minimum": 95.0,
        "module_composite_minimum": 90.0,
        "p0_maximum": 0,
        "release_blocker_maximum": 0,
        "critical_xfail_maximum": 0,
    }
    assert policy["hard_caps"] == {
        "data_loss_authorization_path_escape_or_unrecoverable_p0": 69,
        "release_blocker_or_missing_rollback": 89,
        "missing_restore_drill_exact_sha_ci_or_digest_evidence": 94,
    }


def test_closed_semantic_validator_rejects_each_tampered_field(
    tmp_path: Path,
) -> None:
    contract = load_evidence_contract()
    valid = valid_envelope(tmp_path)
    tamper_cases = {
        "top-level extra": lambda value: value.update({"extra": True}),
        "wrong schema version": lambda value: value.update({"schema_version": "2.0"}),
        "duplicate evidence id": lambda value: value["records"].append(
            value["records"][0]
        ),
        "invalid evidence id": lambda value: value["records"][0].update(
            evidence_id="bad"
        ),
        "empty command": lambda value: value["records"][0].update(command=""),
        "empty cwd": lambda value: value["records"][0].update(cwd=""),
        "runtime extra": lambda value: value["records"][0]["runtime"].update(
            extra="x"
        ),
        "timestamp without offset": lambda value: value["records"][0].update(
            started_at="2026-07-14T00:00:00"
        ),
        "timestamp with a space separator": lambda value: value["records"][0].update(
            started_at="2026-07-14 00:00:00+00:00"
        ),
        "timestamp with offset seconds": lambda value: value["records"][0].update(
            started_at="2026-07-14T00:00:00+00:00:01"
        ),
        "invalid calendar date": lambda value: value["records"][0].update(
            started_at="2026-02-30T00:00:00Z"
        ),
        "time reversal": lambda value: value["records"][0].update(
            finished_at="2026-07-13T23:59:59+00:00"
        ),
        "passed nonzero": lambda value: value["records"][0].update(exit_code=1),
        "failed zero": lambda value: value["records"][0].update(result="failed"),
        "not-run integer exit": lambda value: value["records"][0].update(
            result="not_run"
        ),
        "unverified integer exit": lambda value: value["records"][0].update(
            result="unverified"
        ),
        "boolean exit": lambda value: value["records"][0].update(exit_code=False),
        "empty runtime name": lambda value: value["records"][0]["runtime"].update(
            name=""
        ),
        "invalid confidence": lambda value: value["records"][0].update(
            confidence="likely"
        ),
        "unknown module": lambda value: value["records"][0].update(
            modules=["unknown"]
        ),
        "duplicate module": lambda value: value["records"][0].update(
            modules=["runtime_auth", "runtime_auth"]
        ),
        "unknown finding": lambda value: value["records"][0].update(
            finding_ids=["P0-99"]
        ),
        "duplicate tag": lambda value: value["records"][0].update(
            certification_tags=["exact_sha_ci", "exact_sha_ci"]
        ),
        "absolute artifact": lambda value: value["records"][0].update(
            artifact_path="/tmp/out.json"
        ),
        "drive artifact": lambda value: value["records"][0].update(
            artifact_path="C:/out.json"
        ),
        "parent artifact": lambda value: value["records"][0].update(
            artifact_path="../out.json"
        ),
        "backslash artifact": lambda value: value["records"][0].update(
            artifact_path="logs\\out.json"
        ),
        "encoded slash artifact": lambda value: value["records"][0].update(
            artifact_path="logs%2Fout.json"
        ),
        "encoded backslash artifact": lambda value: value["records"][0].update(
            artifact_path="logs%5Cout.json"
        ),
        "double-encoded separator artifact": lambda value: value["records"][0].update(
            artifact_path="logs%252Fout.json"
        ),
        "artifact query": lambda value: value["records"][0].update(
            artifact_path="artifact.json?download=1"
        ),
        "artifact fragment": lambda value: value["records"][0].update(
            artifact_path="artifact.json#sha"
        ),
        "wrong external authority": lambda value: value["records"][0].update(
            artifact_path="external://other/out.json"
        ),
        "tag without artifact": lambda value: value["records"][0].update(
            artifact_path=None,
            artifact_sha256=None,
            artifact_size_bytes=None,
            certification_tags=["exact_sha_ci"],
        ),
    }
    for name, tamper in tamper_cases.items():
        candidate = copy.deepcopy(valid)
        tamper(candidate)
        with pytest.raises(ValueError, match="evidence"):
            contract.validate_evidence_envelope(
                candidate,
                expected_subject_sha=AUDITED_SHA,
                known_modules=MODULE_IDS,
                known_findings={"P0-01"},
            )


def test_bundle_resolver_rejects_symlink_escape(tmp_path: Path) -> None:
    contract = load_evidence_contract()
    root = tmp_path / "bundle"
    outside = tmp_path / "outside.json"
    root.mkdir()
    outside.write_text("{}", encoding="utf-8")
    link = root / "linked.json"
    try:
        link.symlink_to(outside)
    except OSError:
        pytest.skip("host cannot create test symlinks")
    with pytest.raises(ValueError, match="symlink|escapes"):
        contract.resolve_bundle_artifact(root, "linked.json")


@pytest.mark.parametrize(
    "uri",
    [
        "external://pomodoroxii-test-artifacts/run-a/out%2Flog.json",
        "external://pomodoroxii-test-artifacts/run-a/out%5Clog.json",
        "external://pomodoroxii-test-artifacts/run-a/out%252Flog.json",
        "external://pomodoroxii-test-artifacts/run-a/log.json?download=1",
        "external://pomodoroxii-test-artifacts/run-a/log.json#sha",
    ],
)
def test_external_resolver_rejects_encoded_or_delimited_paths(
    tmp_path: Path,
    uri: str,
) -> None:
    contract = load_evidence_contract()
    root = tmp_path / "pomodoroxii-test-artifacts"
    root.mkdir()
    with pytest.raises(ValueError, match="external|encoded|delimited"):
        contract.resolve_external_artifact(root, uri)


@pytest.mark.parametrize("artifact_path", ["logs//out.json", "logs/./out.json"])
def test_semantic_validator_rejects_empty_or_dot_artifact_segments(
    tmp_path: Path,
    artifact_path: str,
) -> None:
    contract = load_evidence_contract()
    candidate = valid_envelope(tmp_path)
    candidate["records"][0]["artifact_path"] = artifact_path

    with pytest.raises(ValueError, match="evidence artifact"):
        contract.validate_evidence_envelope(
            candidate,
            expected_subject_sha=AUDITED_SHA,
            known_modules=MODULE_IDS,
            known_findings={"P0-01"},
        )
