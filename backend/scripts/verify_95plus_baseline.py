from __future__ import annotations

import hashlib
import json
import os
import subprocess
from collections.abc import Collection, Mapping
from dataclasses import dataclass
from decimal import Decimal
from pathlib import Path, PurePosixPath
from typing import Any

from app.audit.evidence_contract import (
    parse_rfc3339,
    resolve_external_artifact,
    validate_evidence_envelope,
)

AUDITED_SHA = "d20f200a95c25c25b1572da1781fde55560cdce0"
REMOTE_SHA = "1e4f0fc6d82ce6203f4bada0e84b518b16fcd97f"
DIMENSIONS = (
    "completeness",
    "integrity",
    "verification",
    "operability",
    "maintainability",
)
EXPECTED_MODULES = (
    "runtime_auth",
    "migration_space_lifecycle",
    "registry_meta",
    "entity_commands",
    "sync_push",
    "sync_pull_recovery",
    "notes_fs",
    "deploy_operations",
    "mcp",
)
EXPECTED_FINDING_IDS = (
    *(f"P0-{index:02d}" for index in range(1, 8)),
    *(f"P1-{index:02d}" for index in range(1, 14)),
)
EXPECTED_POLICY = {
    "schema_version": "1.0",
    "modules": list(EXPECTED_MODULES),
    "dimensions": {
        name: {"minimum": 0, "maximum": 20} for name in DIMENSIONS
    },
    "formula": {
        "maturity": "(completeness+integrity)/40*100",
        "health": "(verification+operability+maintainability)/60*100",
        "module_composite": (
            "0.4*((completeness+integrity)/40*100)+"
            "0.6*((verification+operability+maintainability)/60*100)"
        ),
        "backend_composite": "arithmetic_mean(module_composite)",
    },
    "thresholds": {
        "backend_composite_minimum": 95.0,
        "module_composite_minimum": 90.0,
        "p0_maximum": 0,
        "release_blocker_maximum": 0,
        "critical_xfail_maximum": 0,
    },
    "hard_caps": {
        "data_loss_authorization_path_escape_or_unrecoverable_p0": 69,
        "release_blocker_or_missing_rollback": 89,
        "missing_restore_drill_exact_sha_ci_or_digest_evidence": 94,
    },
}
RETAINED_DEBT_FIELDS = {"path", "size_bytes", "observed_at", "handling"}
EXPECTED_RETAINED_DEBT = {
    "path": "backend/tests/pytest-of-20564",
    "size_bytes": 815109,
    "handling": "preserve",
}
CERTIFICATION_TRUST = {
    "restore_drill": {"release_drill"},
    "exact_sha_ci": {"trusted_push", "release_drill"},
    "image_digest": {"trusted_push", "release_drill"},
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
BASELINE_FIELDS = {
    "schema_version",
    "audited_subject_sha",
    "saved_remote_sha",
    "modules",
    "findings",
    "evidence",
    "retained_artifact_debt",
}
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


@dataclass(frozen=True, slots=True)
class VerificationSummary:
    raw_backend_composite: Decimal
    claimable_score: Decimal
    module_scores: Mapping[str, Decimal]


def _load(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def _file_fingerprint(path: Path) -> tuple[int, str]:
    digest = hashlib.sha256()
    size = 0
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
            size += len(chunk)
    return size, digest.hexdigest()


def _git_blob_fingerprint(
    repository_root: Path,
    subject_sha: str,
    value: str,
) -> tuple[int, str]:
    relative = PurePosixPath(value)
    if relative.is_absolute() or not relative.parts or ".." in relative.parts:
        raise ValueError(f"invalid Git artifact path: {value}")
    completed = subprocess.run(
        ["git", "show", f"{subject_sha}:{relative.as_posix()}"],
        cwd=repository_root,
        check=False,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    if completed.returncode != 0:
        raise ValueError(f"Git artifact is absent from audited subject: {value}")
    return len(completed.stdout), hashlib.sha256(completed.stdout).hexdigest()


def _require_fingerprint(
    record: Mapping[str, Any],
    actual_size: int,
    actual_hash: str,
) -> None:
    if actual_size != record["artifact_size_bytes"]:
        raise ValueError(f"artifact size mismatch: {record['evidence_id']}")
    if actual_hash != record["artifact_sha256"]:
        raise ValueError(f"artifact hash mismatch: {record['evidence_id']}")


def _configured_external_root() -> Path:
    configured = os.environ.get("POMODOROXII_TEST_ARTIFACTS_ROOT")
    if not configured:
        raise ValueError("POMODOROXII_TEST_ARTIFACTS_ROOT is required")
    root = Path(configured).expanduser().resolve(strict=True)
    if not root.is_dir() or root.name != "pomodoroxii-test-artifacts":
        raise ValueError("external artifact root must be the configured dedicated directory")
    return root


def _validate_policy(raw_policy: object) -> None:
    if raw_policy != EXPECTED_POLICY:
        raise ValueError("score policy contract changed")


def _validate_finding_ids(raw_findings: object) -> list[str]:
    if not isinstance(raw_findings, list):
        raise ValueError("baseline finding identity set changed")
    finding_ids = [
        item.get("finding_id") if isinstance(item, Mapping) else None
        for item in raw_findings
    ]
    if finding_ids != list(EXPECTED_FINDING_IDS):
        raise ValueError("baseline finding identity set changed")
    return finding_ids


def _validate_retained_artifact_debt(raw_debt: object) -> None:
    if not isinstance(raw_debt, list) or len(raw_debt) != 1:
        raise ValueError("retained artifact debt contract changed")
    debt = raw_debt[0]
    if not isinstance(debt, Mapping) or set(debt) != RETAINED_DEBT_FIELDS:
        raise ValueError("retained artifact debt contract changed")
    for field, expected in EXPECTED_RETAINED_DEBT.items():
        value = debt[field]
        if field == "size_bytes" and type(value) is not int:
            raise ValueError("retained artifact debt contract changed")
        if value != expected:
            raise ValueError("retained artifact debt contract changed")
    try:
        parse_rfc3339(debt["observed_at"], field="retained_artifact_debt.observed_at")
    except ValueError as exc:
        raise ValueError("retained artifact debt contract changed") from exc


def score_module(dimensions: Mapping[str, int]) -> Decimal:
    if set(dimensions) != set(DIMENSIONS):
        raise ValueError("module dimensions do not match score policy")
    values = [dimensions[name] for name in DIMENSIONS]
    if any(type(value) is not int or not 0 <= value <= 20 for value in values):
        raise ValueError("module dimensions must be non-Boolean integers within 0..20")
    maturity = Decimal(values[0] + values[1]) / Decimal(40) * Decimal(100)
    health = Decimal(sum(values[2:])) / Decimal(60) * Decimal(100)
    return Decimal("0.4") * maturity + Decimal("0.6") * health


def score_backend(module_scores: list[Decimal]) -> Decimal:
    if len(module_scores) != 9:
        raise ValueError("backend score requires exactly nine modules")
    return sum(module_scores, Decimal(0)) / Decimal(9)


def effective_cap(
    findings: list[dict[str, Any]],
    evidence: list[dict[str, Any]],
    verified_artifact_ids: Collection[str],
) -> int | None:
    if any(
        item["severity"] == "P0" and item["status"] == "open" for item in findings
    ):
        return 69
    if any(
        item.get("release_blocker") is True and item["status"] == "open"
        for item in findings
    ):
        return 89
    for item in evidence:
        if set(item.get("certification_tags", [])) - set(CERTIFICATION_TRUST):
            raise ValueError("unknown certification tag")
    required = {"restore_drill", "exact_sha_ci", "image_digest"}
    proven = {
        tag
        for item in evidence
        if (
            item["evidence_id"] in verified_artifact_ids
            and item["artifact_path"] is not None
            and item["artifact_sha256"] is not None
            and type(item["artifact_size_bytes"]) is int
            and item["artifact_size_bytes"] >= 0
            and item["result"] == "passed"
            and item["confidence"] == "confirmed"
        )
        for tag in item.get("certification_tags", [])
        if item["trust_level"] in CERTIFICATION_TRUST[tag]
    }
    return None if required <= proven else 94


def verify_baseline(audit_root: Path) -> VerificationSummary:
    baseline = _load(audit_root / "baseline.json")
    policy = _load(audit_root / "score-policy.json")
    _validate_policy(policy)
    if set(baseline) != BASELINE_FIELDS or baseline["schema_version"] != "1.0":
        raise ValueError("invalid baseline top-level schema")
    if baseline["audited_subject_sha"] != AUDITED_SHA:
        raise ValueError("audited subject SHA changed")
    if baseline["saved_remote_sha"] != REMOTE_SHA:
        raise ValueError("saved remote SHA changed")
    if list(baseline["modules"]) != list(EXPECTED_MODULES):
        raise ValueError("module order or identity changed")
    evidence_ids = [item["evidence_id"] for item in baseline["evidence"]]
    if len(evidence_ids) != len(set(evidence_ids)):
        raise ValueError("duplicate evidence_id")
    if set(evidence_ids) != EXPECTED_BASELINE_EVIDENCE_IDS:
        raise ValueError("baseline evidence ID set changed")
    known = set(evidence_ids)
    module_scores: dict[str, Decimal] = {}
    for module_id, worksheet in baseline["modules"].items():
        if not worksheet["evidence_ids"] or not set(worksheet["evidence_ids"]) <= known:
            raise ValueError(f"invalid module evidence: {module_id}")
        score = score_module(worksheet["dimensions"])
        if score != Decimal(str(worksheet["composite"])):
            raise ValueError(f"stored composite drift: {module_id}")
        module_scores[module_id] = score
    _validate_finding_ids(baseline["findings"])
    _validate_retained_artifact_debt(baseline["retained_artifact_debt"])
    records = validate_evidence_envelope(
        {
            "schema_version": "1.0",
            "records": baseline["evidence"],
            "findings": baseline["findings"],
        },
        expected_subject_sha=AUDITED_SHA,
        known_modules=set(EXPECTED_MODULES),
        known_findings=set(EXPECTED_FINDING_IDS),
    )
    for finding in baseline["findings"]:
        if set(finding) != FINDING_FIELDS:
            raise ValueError(f"invalid finding fields: {finding['finding_id']}")
        if finding["classification"] not in {"confirmed", "inferred", "unverified"}:
            raise ValueError(f"invalid classification: {finding['finding_id']}")
        if not finding["evidence_ids"] or not set(finding["evidence_ids"]) <= known:
            raise ValueError(f"invalid finding evidence: {finding['finding_id']}")
    repository_root = audit_root.parents[2].resolve()
    external_root: Path | None = None
    verified_artifact_ids: set[str] = set()
    for record in records:
        artifact = record["artifact_path"]
        expected_hash = record["artifact_sha256"]
        expected_size = record["artifact_size_bytes"]
        if artifact is None:
            if expected_hash is not None or expected_size is not None:
                raise ValueError(f"fingerprint without artifact: {record['evidence_id']}")
            continue
        if (
            expected_hash is None
            or not isinstance(expected_size, int)
            or isinstance(expected_size, bool)
            or expected_size < 0
        ):
            raise ValueError(f"artifact without valid fingerprint: {record['evidence_id']}")
        if artifact.startswith("external://"):
            external_root = external_root or _configured_external_root()
            actual_size, actual_hash = _file_fingerprint(
                resolve_external_artifact(external_root, artifact)
            )
        else:
            actual_size, actual_hash = _git_blob_fingerprint(
                repository_root,
                AUDITED_SHA,
                artifact,
            )
        _require_fingerprint(record, actual_size, actual_hash)
        verified_artifact_ids.add(record["evidence_id"])
    raw = score_backend(list(module_scores.values()))
    cap = effective_cap(
        baseline["findings"],
        list(records),
        verified_artifact_ids,
    )
    claimable = raw if cap is None else min(raw, Decimal(cap))
    return VerificationSummary(raw, claimable, module_scores)


def main() -> int:
    root = Path(__file__).resolve().parents[1] / "audit" / "95plus"
    summary = verify_baseline(root)
    print(
        "VERIFY_OK "
        f"raw={summary.raw_backend_composite.quantize(Decimal('0.1'))} "
        f"claimable={summary.claimable_score} modules={len(summary.module_scores)}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
