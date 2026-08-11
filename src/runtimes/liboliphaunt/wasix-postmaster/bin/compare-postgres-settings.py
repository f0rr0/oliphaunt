#!/usr/bin/env python3
"""Compare the effective PostgreSQL profile of a native/WASIX pair."""

from __future__ import annotations

import csv
import io
import os
from pathlib import Path
import re
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))
from durable_publication import (  # noqa: E402
    PublicationError,
    publish as publish_no_replace,
    stable_regular_bytes,
)


REQUIRED = (
    "autovacuum_worker_slots",
    "backend_flush_after",
    "bgwriter_flush_after",
    "checkpoint_flush_after",
    "checkpoint_timeout",
    "fsync",
    "full_page_writes",
    "io_method",
    "max_connections",
    "max_wal_senders",
    "max_worker_processes",
    "max_wal_size",
    "min_wal_size",
    "shared_buffers",
    "synchronous_commit",
    "wal_segment_size",
)
HEADER = ("name", "setting", "unit", "source")
SETTING_NAME = re.compile(r"^[a-z][a-z0-9_]*$")


class EvidenceError(RuntimeError):
    pass


def load(path: Path) -> dict[str, tuple[str, str, str]]:
    try:
        raw = stable_regular_bytes(path)
        text = raw.decode("utf-8", errors="strict")
    except (OSError, PublicationError, UnicodeDecodeError) as error:
        raise EvidenceError(f"could not read stable settings input {path}: {error}") from error
    rows: dict[str, tuple[str, str, str]] = {}
    reader = csv.DictReader(io.StringIO(text, newline=""), delimiter="\t")
    if tuple(reader.fieldnames or ()) != HEADER:
        raise EvidenceError(f"settings header mismatch: {path}")
    for line_number, row in enumerate(reader, 2):
        if None in row or any(value is None for value in row.values()):
            raise EvidenceError(f"malformed settings row {line_number}: {path}")
        name = row["name"]
        if not SETTING_NAME.fullmatch(name) or name in rows:
            raise EvidenceError(f"invalid or duplicate setting at row {line_number}: {path}")
        rows[name] = (row["setting"], row["unit"], row["source"])
    if not set(REQUIRED).issubset(rows):
        raise EvidenceError(
            f"required settings missing: {path}: "
            f"missing={sorted(set(REQUIRED) - set(rows))!r} "
        )
    return rows


def main(argv: list[str]) -> int:
    if len(argv) != 4:
        print(f"usage: {argv[0]} NATIVE.tsv WASIX.tsv OUTPUT.tsv", file=sys.stderr)
        return 64
    native_path, wasix_path, output_path = map(Path, argv[1:])
    if output_path.exists() or output_path.is_symlink():
        raise EvidenceError(f"refusing to replace settings comparison: {output_path}")
    if not output_path.parent.is_dir():
        raise EvidenceError(f"settings comparison parent does not exist: {output_path.parent}")
    native = load(native_path)
    wasix = load(wasix_path)
    if set(native) != set(wasix):
        raise EvidenceError(
            "native/WASIX settings key set mismatch: "
            f"native_only={sorted(set(native) - set(wasix))!r} "
            f"wasix_only={sorted(set(wasix) - set(native))!r}"
        )
    ordered_names = (*REQUIRED, *sorted(set(native) - set(REQUIRED)))
    mismatch = False
    descriptor, pending_name = tempfile.mkstemp(prefix=".postgres-settings.", dir=output_path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="") as handle:
            writer = csv.writer(handle, delimiter="\t", lineterminator="\n")
            writer.writerow((
                "name", "native_setting", "native_unit", "native_source",
                "wasix_setting", "wasix_unit", "wasix_source", "status",
            ))
            for name in ordered_names:
                status = "matched" if native[name] == wasix[name] else "mismatched"
                mismatch |= status != "matched"
                writer.writerow((name, *native[name], *wasix[name], status))
        os.chmod(pending_name, 0o444)
        try:
            publish_no_replace(Path(pending_name), output_path)
        except (OSError, PublicationError) as error:
            raise EvidenceError(
                f"could not publish settings comparison without replacement: {error}"
            ) from error
    except BaseException:
        try:
            os.unlink(pending_name)
        except FileNotFoundError:
            pass
        raise
    return 1 if mismatch else 0


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv))
    except EvidenceError as error:
        print(f"PostgreSQL settings comparison: {error}", file=sys.stderr)
        raise SystemExit(1)
