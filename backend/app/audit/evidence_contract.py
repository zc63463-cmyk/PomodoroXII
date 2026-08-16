from __future__ import annotations

import copy
import re
from collections.abc import Collection, Mapping
from datetime import datetime
from pathlib import Path, PurePosixPath
from typing import Any
from urllib.parse import urlsplit

RFC3339_PATTERN = re.compile(
    r"^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])"
    r"T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]"
    r"(?:\.[0-9]+)?(?:Z|[+-](?:[01][0-9]|2[0-3]):[0-5][0-9])$"
)
EVIDENCE_ID_PATTERN = re.compile(r"^EV-[A-Z0-9-]+$")
SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")
FINDING_ID_PATTERN = re.compile(r"^P[01]-[0-9]{2}$")

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
RUNTIME_FIELDS = {"name", "version", "platform"}
TRUST_LEVELS = {"local_snapshot", "pr_local", "trusted_push", "release_drill"}
CONFIDENCE_LEVELS = {"confirmed", "inferred", "unverified"}
RESULTS = {"passed", "failed", "not_run", "unverified"}
CERTIFICATION_TAGS = {"restore_drill", "exact_sha_ci", "image_digest"}


def parse_rfc3339(value: object, *, field: str) -> datetime:
    if not isinstance(value, str) or RFC3339_PATTERN.fullmatch(value) is None:
        raise ValueError(f"evidence {field} must be strict RFC 3339")
    try:
        parsed = datetime.fromisoformat(
            value[:-1] + "+00:00" if value.endswith("Z") else value
        )
    except ValueError as exc:
        raise ValueError(f"evidence {field} is not a real RFC 3339 instant") from exc
    if parsed.utcoffset() is None:
        raise ValueError(f"evidence {field} requires an explicit offset")
    return parsed


def _require_exact_keys(value: object, expected: set[str], *, field: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping) or set(value) != expected:
        raise ValueError(f"evidence {field} fields do not match the closed contract")
    return value


def _require_nonempty_string(value: object, *, field: str) -> str:
    if not isinstance(value, str) or not value:
        raise ValueError(f"evidence {field} must be a nonempty string")
    return value


def _require_unique_string_list(
    value: object,
    *,
    field: str,
    allowed: Collection[str] | None = None,
    nonempty: bool = False,
) -> list[str]:
    if not isinstance(value, list) or any(not isinstance(item, str) for item in value):
        raise ValueError(f"evidence {field} must be a list of strings")
    if nonempty and not value:
        raise ValueError(f"evidence {field} must not be empty")
    if len(value) != len(set(value)):
        raise ValueError(f"evidence {field} must contain unique values")
    if allowed is not None and not set(value) <= set(allowed):
        raise ValueError(f"evidence {field} contains unknown values")
    return value


def _validate_artifact_fields(record: Mapping[str, Any]) -> None:
    artifact_path = record["artifact_path"]
    artifact_sha256 = record["artifact_sha256"]
    artifact_size = record["artifact_size_bytes"]
    tags = record["certification_tags"]

    if artifact_path is None:
        if artifact_sha256 is not None or artifact_size is not None or tags:
            raise ValueError("evidence artifact fingerprint or tags require an artifact")
        return
    if not isinstance(artifact_path, str) or not artifact_path:
        raise ValueError("evidence artifact path must be a nonempty string or null")
    if artifact_path.startswith("external://"):
        parsed = urlsplit(artifact_path)
        if (
            parsed.scheme != "external"
            or parsed.netloc != "pomodoroxii-test-artifacts"
            or parsed.query
            or parsed.fragment
            or "%" in artifact_path
        ):
            raise ValueError(f"invalid external evidence artifact URI: {artifact_path}")
        _validated_relative_parts(
            parsed.path.removeprefix("/"), field="external evidence artifact path"
        )
    else:
        _validated_relative_parts(artifact_path, field="evidence artifact path")
    if not isinstance(artifact_sha256, str) or SHA256_PATTERN.fullmatch(artifact_sha256) is None:
        raise ValueError("evidence artifact SHA-256 must be lowercase hexadecimal")
    if type(artifact_size) is not int or artifact_size < 0:
        raise ValueError("evidence artifact size must be a nonnegative integer")


def _validate_record(
    raw_record: object,
    *,
    expected_subject_sha: str,
    known_modules: Collection[str],
    known_findings: Collection[str],
) -> Mapping[str, Any]:
    record = _require_exact_keys(raw_record, EVIDENCE_FIELDS, field="record")
    evidence_id = _require_nonempty_string(record["evidence_id"], field="evidence_id")
    if EVIDENCE_ID_PATTERN.fullmatch(evidence_id) is None:
        raise ValueError("evidence evidence_id has an invalid format")
    if record["subject_sha"] != expected_subject_sha:
        raise ValueError("evidence subject SHA does not match the expected subject")
    _require_nonempty_string(record["command"], field="command")
    _require_nonempty_string(record["cwd"], field="cwd")

    runtime = _require_exact_keys(record["runtime"], RUNTIME_FIELDS, field="runtime")
    for name in RUNTIME_FIELDS:
        _require_nonempty_string(runtime[name], field=f"runtime.{name}")

    started = parse_rfc3339(record["started_at"], field="started_at")
    finished = parse_rfc3339(record["finished_at"], field="finished_at")
    if started > finished:
        raise ValueError("evidence timestamps are reversed")

    result = record["result"]
    exit_code = record["exit_code"]
    if result not in RESULTS:
        raise ValueError("evidence result is not recognized")
    if result == "passed" and (type(exit_code) is not int or exit_code != 0):
        raise ValueError("evidence passed result requires exit code zero")
    if result == "failed" and (type(exit_code) is not int or exit_code == 0):
        raise ValueError("evidence failed result requires a nonzero exit code")
    if result in {"not_run", "unverified"} and exit_code is not None:
        raise ValueError("evidence non-executed result requires a null exit code")
    if record["trust_level"] not in TRUST_LEVELS:
        raise ValueError("evidence trust level is not recognized")
    if record["confidence"] not in CONFIDENCE_LEVELS:
        raise ValueError("evidence confidence is not recognized")

    _require_unique_string_list(
        record["modules"], field="modules", allowed=known_modules, nonempty=True
    )
    _require_unique_string_list(
        record["finding_ids"], field="finding_ids", allowed=known_findings
    )
    _require_unique_string_list(
        record["certification_tags"],
        field="certification_tags",
        allowed=CERTIFICATION_TAGS,
    )
    _validate_artifact_fields(record)
    return record


def _validate_findings(
    raw_findings: object,
    *,
    known_findings: Collection[str],
    known_modules: Collection[str],
    evidence_ids: Collection[str],
) -> None:
    if not isinstance(raw_findings, list):
        raise ValueError("evidence findings must be a list")
    seen: set[str] = set()
    for raw_finding in raw_findings:
        finding = _require_exact_keys(raw_finding, FINDING_FIELDS, field="finding")
        finding_id = _require_nonempty_string(finding["finding_id"], field="finding_id")
        if (
            FINDING_ID_PATTERN.fullmatch(finding_id) is None
            or finding_id not in known_findings
            or finding_id in seen
        ):
            raise ValueError("evidence finding identity is invalid or duplicated")
        seen.add(finding_id)
        if finding["severity"] != finding_id[:2]:
            raise ValueError("evidence finding severity does not match its ID")
        if finding["status"] not in {"open", "closed"}:
            raise ValueError("evidence finding status is not recognized")
        if finding["classification"] not in CONFIDENCE_LEVELS:
            raise ValueError("evidence finding classification is not recognized")
        if type(finding["release_blocker"]) is not bool:
            raise ValueError("evidence finding release_blocker must be boolean")
        _require_unique_string_list(
            finding["modules"],
            field="finding modules",
            allowed=known_modules,
            nonempty=True,
        )
        _require_unique_string_list(
            finding["evidence_ids"],
            field="finding evidence_ids",
            allowed=evidence_ids,
            nonempty=True,
        )


def validate_evidence_envelope(
    envelope: Mapping[str, Any],
    *,
    expected_subject_sha: str,
    known_modules: Collection[str],
    known_findings: Collection[str],
) -> tuple[Mapping[str, Any], ...]:
    if not re.fullmatch(r"[0-9a-f]{40}", expected_subject_sha):
        raise ValueError("evidence expected subject SHA must be full lowercase hexadecimal")
    allowed_envelope_keys = {"schema_version", "records"}
    if "findings" in envelope:
        allowed_envelope_keys.add("findings")
    if set(envelope) != allowed_envelope_keys or envelope.get("schema_version") != "1.0":
        raise ValueError("evidence envelope does not match the closed versioned contract")
    raw_records = envelope.get("records")
    if not isinstance(raw_records, list) or not raw_records:
        raise ValueError("evidence records must be a nonempty list")

    records = tuple(
        _validate_record(
            raw_record,
            expected_subject_sha=expected_subject_sha,
            known_modules=known_modules,
            known_findings=known_findings,
        )
        for raw_record in raw_records
    )
    evidence_ids = [record["evidence_id"] for record in records]
    if len(evidence_ids) != len(set(evidence_ids)):
        raise ValueError("evidence IDs must be unique")
    if "findings" in envelope:
        _validate_findings(
            envelope["findings"],
            known_findings=known_findings,
            known_modules=known_modules,
            evidence_ids=evidence_ids,
        )
    return tuple(copy.deepcopy(record) for record in records)


def _validated_relative_parts(value: str, *, field: str) -> tuple[str, ...]:
    if any(marker in value for marker in ("%", "?", "#", "\\")):
        raise ValueError(f"invalid encoded or delimited {field}: {value}")
    raw_parts = value.split("/")
    if any(part in {"", ".", ".."} for part in raw_parts):
        raise ValueError(f"invalid {field}: {value}")
    relative = PurePosixPath(value)
    if (
        relative.is_absolute()
        or not relative.parts
        or ":" in relative.parts[0]
        or any(part in {"", ".", ".."} for part in relative.parts)
    ):
        raise ValueError(f"invalid {field}: {value}")
    return relative.parts


def resolve_bundle_artifact(artifact_root: Path, artifact_path: str) -> Path:
    root = artifact_root.expanduser().resolve(strict=True)
    parts = _validated_relative_parts(artifact_path, field="evidence artifact path")
    unresolved = root.joinpath(*parts)
    probe = root
    for part in parts:
        probe = probe / part
        if probe.is_symlink():
            raise ValueError(f"evidence artifact uses a symlink: {artifact_path}")
    candidate = unresolved.resolve(strict=True)
    try:
        candidate.relative_to(root)
    except ValueError as exc:
        raise ValueError(f"evidence artifact escapes bundle: {artifact_path}") from exc
    if not candidate.is_file():
        raise ValueError(f"evidence artifact is not a regular file: {artifact_path}")
    return candidate


def resolve_external_artifact(external_root: Path, artifact_uri: str) -> Path:
    root = external_root.expanduser().resolve(strict=True)
    if not root.is_dir() or root.name != "pomodoroxii-test-artifacts":
        raise ValueError("external artifact root is not the dedicated directory")
    parsed = urlsplit(artifact_uri)
    if (
        parsed.scheme != "external"
        or parsed.netloc != "pomodoroxii-test-artifacts"
        or parsed.query
        or parsed.fragment
        or "%" in artifact_uri
    ):
        raise ValueError(f"invalid external artifact URI: {artifact_uri}")
    parts = _validated_relative_parts(
        parsed.path.removeprefix("/"), field="external artifact path"
    )
    return resolve_bundle_artifact(root, PurePosixPath(*parts).as_posix())
