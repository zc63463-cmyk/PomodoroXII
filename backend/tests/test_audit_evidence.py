from __future__ import annotations

import copy
import hashlib
import importlib.util
import inspect
import json
import os
import sys
import tomllib
from decimal import Decimal
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


def load_verifier():
    path = Path(__file__).resolve().parents[1] / "scripts" / "verify_95plus_baseline.py"
    spec = importlib.util.spec_from_file_location("verify_95plus_baseline", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def test_baseline_subject_modules_findings_and_scores_are_locked() -> None:
    baseline = load_json("baseline.json")
    assert (
        baseline["audited_subject_sha"]
        == "d20f200a95c25c25b1572da1781fde55560cdce0"
    )
    assert (
        baseline["saved_remote_sha"]
        == "1e4f0fc6d82ce6203f4bada0e84b518b16fcd97f"
    )
    assert set(baseline["modules"]) == MODULE_IDS
    assert {item["finding_id"] for item in baseline["findings"]} == {
        *(f"P0-{index:02d}" for index in range(1, 8)),
        *(f"P1-{index:02d}" for index in range(1, 14)),
    }
    assert {item["classification"] for item in baseline["findings"]} <= {
        "confirmed",
        "inferred",
        "unverified",
    }
    verifier = load_verifier()
    module_scores = [
        verifier.score_module(worksheet["dimensions"])
        for worksheet in baseline["modules"].values()
    ]
    raw = verifier.score_backend(module_scores)
    assert raw == Decimal(
        "75.88888888888888888888888889"
    )
    assert verifier.effective_cap(baseline["findings"], baseline["evidence"], set()) == 69


@pytest.mark.skipif(
    not os.environ.get("POMODOROXII_TEST_ARTIFACTS_ROOT"),
    reason="external S0 evidence root is not configured",
)
def test_baseline_external_artifacts_verify_when_configured() -> None:
    verifier = load_verifier()
    summary = verifier.verify_baseline(AUDIT_ROOT)

    assert summary.raw_backend_composite == Decimal(
        "75.88888888888888888888888889"
    )
    assert summary.claimable_score == Decimal("69")


def test_verifier_rejects_any_score_policy_contract_drift() -> None:
    verifier = load_verifier()
    policy = load_json("score-policy.json")
    mutations = []

    unexpected = copy.deepcopy(policy)
    unexpected["unexpected"] = True
    mutations.append(unexpected)

    formula = copy.deepcopy(policy)
    formula["formula"]["backend_composite"] = "maximum(module_composite)"
    mutations.append(formula)

    threshold = copy.deepcopy(policy)
    threshold["thresholds"]["backend_composite_minimum"] = 0.0
    mutations.append(threshold)

    cap = copy.deepcopy(policy)
    cap["hard_caps"]["data_loss_authorization_path_escape_or_unrecoverable_p0"] = 99
    mutations.append(cap)

    for candidate in mutations:
        with pytest.raises(ValueError, match="score policy contract"):
            verifier._validate_policy(candidate)


def test_verifier_rejects_candidate_defined_finding_identity() -> None:
    verifier = load_verifier()
    baseline = load_json("baseline.json")
    findings = copy.deepcopy(baseline["findings"])
    findings[6]["finding_id"] = "P0-08"

    with pytest.raises(ValueError, match="finding identity"):
        verifier._validate_finding_ids(findings)


def test_verifier_rejects_retained_debt_contract_drift() -> None:
    verifier = load_verifier()
    baseline = load_json("baseline.json")
    debt = copy.deepcopy(baseline["retained_artifact_debt"])

    verifier._validate_retained_artifact_debt(debt)

    for key, value in (
        ("handling", "delete"),
        ("size_bytes", 0),
        ("path", "backend/tests/other"),
    ):
        candidate = copy.deepcopy(debt)
        candidate[0][key] = value
        with pytest.raises(ValueError, match="retained artifact debt"):
            verifier._validate_retained_artifact_debt(candidate)

    candidate = copy.deepcopy(debt)
    candidate[0]["unexpected"] = True
    with pytest.raises(ValueError, match="retained artifact debt"):
        verifier._validate_retained_artifact_debt(candidate)


def test_every_module_and_finding_points_to_known_evidence() -> None:
    baseline = load_json("baseline.json")
    known = {item["evidence_id"] for item in baseline["evidence"]}
    assert known == EXPECTED_BASELINE_EVIDENCE_IDS
    for module in baseline["modules"].values():
        assert set(module["evidence_ids"]) <= known
        assert module["evidence_ids"]
    for finding in baseline["findings"]:
        assert set(finding["evidence_ids"]) <= known
        assert finding["evidence_ids"]


def test_baseline_provenance_never_branches_on_evidence_id() -> None:
    verifier = load_verifier()
    source = inspect.getsource(verifier.verify_baseline)
    assert 'startswith("EV-SOURCE-")' not in source
    assert "_contained_repository_path" not in source


def test_verifier_checks_artifact_size_in_addition_to_sha256() -> None:
    verifier = load_verifier()
    record = {
        "evidence_id": "EV-SIZE-CHECK",
        "artifact_size_bytes": 4,
        "artifact_sha256": "0" * 64,
    }
    with pytest.raises(ValueError, match="artifact size mismatch"):
        verifier._require_fingerprint(
            record,
            actual_size=5,
            actual_hash="0" * 64,
        )


@pytest.mark.parametrize("invalid", [True, "20", 19.9])
def test_score_dimensions_require_exact_non_boolean_integers(invalid: object) -> None:
    verifier = load_verifier()
    dimensions = {name: 20 for name in verifier.DIMENSIONS}
    dimensions["verification"] = invalid
    with pytest.raises(ValueError, match="non-Boolean integers"):
        verifier.score_module(dimensions)


def test_local_and_pr_evidence_cannot_lift_certification_cap() -> None:
    verifier = load_verifier()
    low_trust = [
        {
            "evidence_id": f"EV-LOW-{index}",
            "result": "passed",
            "confidence": "confirmed",
            "trust_level": trust,
            "certification_tags": [tag],
            "artifact_path": f"low-{index}.json",
            "artifact_sha256": "a" * 64,
            "artifact_size_bytes": 1,
        }
        for index, (trust, tag) in enumerate(
            [
                ("local_snapshot", "restore_drill"),
                ("pr_local", "exact_sha_ci"),
                ("pr_local", "image_digest"),
            ]
        )
    ]
    low_ids = {item["evidence_id"] for item in low_trust}
    assert verifier.effective_cap([], low_trust, low_ids) == 94

    trusted = [
        {
            "evidence_id": "EV-TRUSTED-CI",
            "result": "passed",
            "confidence": "confirmed",
            "trust_level": "trusted_push",
            "certification_tags": ["exact_sha_ci", "image_digest"],
            "artifact_path": "trusted-ci.json",
            "artifact_sha256": "b" * 64,
            "artifact_size_bytes": 1,
        },
        {
            "evidence_id": "EV-TRUSTED-DRILL",
            "result": "passed",
            "confidence": "confirmed",
            "trust_level": "release_drill",
            "certification_tags": ["restore_drill"],
            "artifact_path": "trusted-drill.json",
            "artifact_sha256": "c" * 64,
            "artifact_size_bytes": 1,
        },
    ]
    trusted_ids = {item["evidence_id"] for item in trusted}
    assert verifier.effective_cap([], trusted, trusted_ids) is None
    assert verifier.effective_cap([], trusted, {"EV-TRUSTED-CI"}) == 94


def test_certification_tags_without_a_verified_artifact_cannot_lift_cap() -> None:
    verifier = load_verifier()
    record = {
        "evidence_id": "EV-UNBACKED-DRILL",
        "result": "passed",
        "confidence": "confirmed",
        "trust_level": "release_drill",
        "certification_tags": ["restore_drill", "exact_sha_ci", "image_digest"],
        "artifact_path": None,
        "artifact_sha256": None,
        "artifact_size_bytes": None,
    }
    assert verifier.effective_cap([], [record], set()) == 94


def test_development_dependencies_include_pytest_cov_6_or_newer() -> None:
    pyproject = tomllib.loads(
        (Path(__file__).resolve().parents[1] / "pyproject.toml").read_text(
            encoding="utf-8"
        )
    )
    dev = pyproject["project"]["optional-dependencies"]["dev"]
    assert "pytest-cov>=6.0" in dev
