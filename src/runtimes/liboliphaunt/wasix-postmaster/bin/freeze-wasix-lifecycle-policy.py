#!/usr/bin/env python3

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import os
from pathlib import Path
import re
import secrets
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))
from durable_publication import (  # noqa: E402
    PublicationError,
    publish_identified,
    remove_private,
    write_bytes,
)


def load_validator():
    path = Path(__file__).with_name("validate-wasix-lifecycle-plateau.py")
    spec = importlib.util.spec_from_file_location("wasix_lifecycle_validator", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load lifecycle validator: {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


VALIDATOR = load_validator()
COUNT_FIELDS: tuple[str, ...] = VALIDATOR.COUNT_FIELDS
OUTPUT_FIELDS: tuple[str, ...] = VALIDATOR.OUTPUT_FIELDS
CLAIM_SCOPE: str = VALIDATOR.CLAIM_SCOPE
BASELINE_ASSUMPTION: str = VALIDATOR.BASELINE_ASSUMPTION
POLICY_FIELDS: tuple[str, ...] = VALIDATOR.BASELINE_POLICY_FIELDS
U64_MAX: int = VALIDATOR.U64_MAX


class FreezeError(ValueError):
    pass


def require_sha256(row: dict[str, str], field: str) -> None:
    if not re.fullmatch(r"[0-9a-f]{64}", row[field]):
        raise FreezeError(f"exploratory result {field} is not a SHA-256")


def parse_u64(value: str, field: str) -> int:
    if not value.isascii() or not value.isdecimal():
        raise FreezeError(f"exploratory result {field} is not an unsigned integer")
    parsed = int(value)
    if parsed > U64_MAX:
        raise FreezeError(f"exploratory result {field} exceeds u64")
    return parsed


def read_exploratory_result(path: Path) -> tuple[dict[str, str], str]:
    raw = VALIDATOR.read_regular_file(path)
    if not raw.endswith(b"\n") or raw.count(b"\n") != 2:
        raise FreezeError("exploratory result must contain exactly two newline-terminated rows")
    header, record, _ = raw.decode("utf-8", errors="strict").split("\n")
    if tuple(header.split("\t")) != OUTPUT_FIELDS:
        raise FreezeError("exploratory result has an unexpected ordered schema")
    values = record.split("\t")
    if len(values) != len(OUTPUT_FIELDS):
        raise FreezeError("exploratory result row does not match its schema")
    row = dict(zip(OUTPUT_FIELDS, values, strict=True))
    for field, value in row.items():
        if any(ord(character) < 0x20 or ord(character) == 0x7F for character in value):
            raise FreezeError(f"exploratory result {field} contains a control character")

    expected = {
        "schema_version": "6",
        "target": "wasix",
        "status": "passed",
        "claim_scope": CLAIM_SCOPE,
        "baseline_assumption": BASELINE_ASSUMPTION,
        "baseline_policy_status": "exploratory-unbounded",
    }
    for field, wanted in expected.items():
        if row[field] != wanted:
            raise FreezeError(f"exploratory result {field} must be {wanted}")
    if not re.fullmatch(
        r"pg18-idle-postmaster-stabilized-exploratory-v[1-9][0-9]*",
        row["baseline_policy_id"],
    ):
        raise FreezeError("exploratory result does not name an idle-postmaster policy")
    if row["wait_kind"] not in VALIDATOR.WAIT_KINDS:
        raise FreezeError("exploratory result has an unsupported wait kind")
    for field in (
        "baseline_policy_sha256",
        "baseline_binding_sha256",
        "freeze_receipt_sha256",
        "evidence_sha256",
        "commit_ack_sha256",
    ):
        require_sha256(row, field)

    return row, hashlib.sha256(raw).hexdigest()


def revalidate_exploratory_result(
    row: dict[str, str],
    *,
    log: Path,
    freeze_receipt: Path,
    baseline_policy: Path,
    baseline_binding: Path,
) -> dict[str, int]:
    nonce = row["nonce"]
    if not VALIDATOR.NONCE_RE.fullmatch(nonce):
        raise FreezeError("exploratory result nonce is malformed")
    observer_pid = parse_u64(row["observer_pid"], "observer_pid")
    min_samples = parse_u64(row["min_samples"], "min_samples")
    min_span_ns = parse_u64(row["min_span_ns"], "min_span_ns")
    expected_interval_ms = parse_u64(
        row["expected_interval_ms"], "expected_interval_ms"
    )
    max_sample_gap_ns = parse_u64(row["max_sample_gap_ns"], "max_sample_gap_ns")
    if observer_pid == 0:
        raise FreezeError("exploratory result observer_pid must be positive")
    if min_samples < 3:
        raise FreezeError("exploratory result min_samples must be at least 3")
    if min_span_ns < 1_000_000_000:
        raise FreezeError("exploratory result min_span_ns must span at least one second")
    if min_span_ns % 1_000_000 != 0:
        raise FreezeError("exploratory result min_span_ns is not whole milliseconds")
    if expected_interval_ms == 0:
        raise FreezeError("exploratory result expected_interval_ms must be positive")
    if expected_interval_ms > U64_MAX // 3_000_000:
        raise FreezeError("exploratory result expected_interval_ms exceeds u64")
    if max_sample_gap_ns != expected_interval_ms * 3_000_000:
        raise FreezeError(
            "exploratory result max_sample_gap_ns does not match its sampling interval"
        )

    outcome = VALIDATOR.validate_lifecycle_bundle(
        log=log,
        freeze_receipt=freeze_receipt,
        baseline_policy_path=baseline_policy,
        baseline_binding_path=baseline_binding,
        target=row["target"],
        nonce=nonce,
        observer_pid=observer_pid,
        min_samples=min_samples,
        min_span_ns=min_span_ns,
        expected_interval_ms=expected_interval_ms,
        max_sample_gap_ns=max_sample_gap_ns,
    )
    if not outcome.passed:
        raise FreezeError(
            f"exploratory bundle failed revalidation: {outcome.error}"
        )
    revalidated = {field: str(outcome.row[field]) for field in OUTPUT_FIELDS}
    for field in OUTPUT_FIELDS:
        if row[field] != revalidated[field]:
            raise FreezeError(
                f"exploratory result does not match revalidated bundle field {field}"
            )

    counts: dict[str, int] = {}
    for field in COUNT_FIELDS:
        readiness_field = f"readiness_{field}"
        final_field = f"post_quiescence_{field}"
        readiness = parse_u64(revalidated[readiness_field], readiness_field)
        final = parse_u64(revalidated[final_field], final_field)
        if readiness != final:
            raise FreezeError(
                f"revalidated exploratory bundle {field} does not return to readiness"
            )
        counts[field] = readiness
    return counts


def render_policy(policy_id: str, counts: dict[str, int]) -> bytes:
    lines = ["\t".join(POLICY_FIELDS)]
    metadata = (
        "oliphaunt.wasix-postmaster.lifecycle-baseline-policy.v1",
        policy_id,
        "qualification-bounded",
        CLAIM_SCOPE,
        BASELINE_ASSUMPTION,
    )
    for field in COUNT_FIELDS:
        value = str(counts[field])
        lines.append("\t".join((*metadata, field, "exact", value, value)))
    payload = ("\n".join(lines) + "\n").encode()
    return payload


def publish_new_regular(path: Path, payload: bytes) -> None:
    path = Path(os.path.abspath(path))
    path.parent.mkdir(parents=True, exist_ok=True)
    pending = path.with_name(
        f".{path.name}.pending.{os.getpid()}.{secrets.token_hex(16)}"
    )
    pending_identity = write_bytes(pending, payload)
    try:
        parsed = VALIDATOR.parse_baseline_policy(pending)
        intended_sha256 = hashlib.sha256(payload).hexdigest()
        if parsed.sha256 != intended_sha256:
            raise FreezeError("pending lifecycle policy differs from rendered payload")
        try:
            publish_identified(pending, path, pending_identity)
        except PublicationError as error:
            raise FreezeError(str(error)) from error
    finally:
        remove_private(pending, pending_identity)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Freeze one passed exploratory lifecycle tuple into an exact qualification policy"
    )
    parser.add_argument("--exploratory-result", required=True, type=Path)
    parser.add_argument("--log", required=True, type=Path)
    parser.add_argument("--freeze-receipt", required=True, type=Path)
    parser.add_argument("--baseline-policy", required=True, type=Path)
    parser.add_argument("--baseline-binding", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--policy-id", required=True)
    args = parser.parse_args()
    if not re.fullmatch(
        r"pg18-idle-postmaster-stabilized-qualified-v[1-9][0-9]*", args.policy_id
    ):
        parser.error("--policy-id must be pg18-idle-postmaster-stabilized-qualified-vN")
    try:
        row, source_sha256 = read_exploratory_result(args.exploratory_result)
        counts = revalidate_exploratory_result(
            row,
            log=args.log,
            freeze_receipt=args.freeze_receipt,
            baseline_policy=args.baseline_policy,
            baseline_binding=args.baseline_binding,
        )
        payload = render_policy(args.policy_id, counts)
        publish_new_regular(args.output, payload)
    except (FreezeError, VALIDATOR.EvidenceError, OSError, UnicodeError) as error:
        print(f"freeze lifecycle policy: {error}", file=sys.stderr)
        return 1
    print(f"wrote exact lifecycle policy: {args.output}")
    print(f"exploratory result sha256: {source_sha256}")
    print(f"policy sha256: {hashlib.sha256(payload).hexdigest()}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
