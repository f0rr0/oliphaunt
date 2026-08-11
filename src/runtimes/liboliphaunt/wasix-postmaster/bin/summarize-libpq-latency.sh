#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
publication_tool="$root/lib/durable_publication.py"

usage() {
  cat <<'USAGE'
Usage: summarize-libpq-latency.sh --raw PATH --output PATH --target NAME
       --mode persistent|reconnect --warmup COUNT --samples COUNT
       --libpq-path PATH --libpq-sha256 SHA256 --probe-sha256 SHA256

Validates one raw CLOCK_MONOTONIC libpq latency stream and atomically writes
nearest-rank p50/p95/p99 values. Any failed, missing, duplicate, malformed, or
unexpected sample prevents summary creation.
USAGE
}

raw=""
output=""
target=""
mode=""
warmup_count=""
sample_count=""
libpq_path=""
libpq_sha256=""
probe_sha256=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --raw|--output|--target|--mode|--warmup|--samples|--libpq-path|--libpq-sha256|--probe-sha256)
      option="$1"
      shift
      [ "$#" -gt 0 ] || { printf '%s requires a value\n' "$option" >&2; exit 2; }
      case "$option" in
        --raw) [ -z "$raw" ] || { echo "--raw may only be specified once" >&2; exit 2; }; raw="$1" ;;
        --output) [ -z "$output" ] || { echo "--output may only be specified once" >&2; exit 2; }; output="$1" ;;
        --target) [ -z "$target" ] || { echo "--target may only be specified once" >&2; exit 2; }; target="$1" ;;
        --mode) [ -z "$mode" ] || { echo "--mode may only be specified once" >&2; exit 2; }; mode="$1" ;;
        --warmup) [ -z "$warmup_count" ] || { echo "--warmup may only be specified once" >&2; exit 2; }; warmup_count="$1" ;;
        --samples) [ -z "$sample_count" ] || { echo "--samples may only be specified once" >&2; exit 2; }; sample_count="$1" ;;
        --libpq-path) [ -z "$libpq_path" ] || { echo "--libpq-path may only be specified once" >&2; exit 2; }; libpq_path="$1" ;;
        --libpq-sha256) [ -z "$libpq_sha256" ] || { echo "--libpq-sha256 may only be specified once" >&2; exit 2; }; libpq_sha256="$1" ;;
        --probe-sha256) [ -z "$probe_sha256" ] || { echo "--probe-sha256 may only be specified once" >&2; exit 2; }; probe_sha256="$1" ;;
      esac
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      printf 'unknown argument: %s\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

[ -n "$raw" ] || { echo "missing required value: raw" >&2; exit 2; }
[ -n "$output" ] || { echo "missing required value: output" >&2; exit 2; }
[ -n "$target" ] || { echo "missing required value: target" >&2; exit 2; }
[ -n "$mode" ] || { echo "missing required value: mode" >&2; exit 2; }
[ -n "$warmup_count" ] || { echo "missing required value: warmup_count" >&2; exit 2; }
[ -n "$sample_count" ] || { echo "missing required value: sample_count" >&2; exit 2; }
[ -n "$libpq_path" ] || { echo "missing required value: libpq_path" >&2; exit 2; }
[ -n "$libpq_sha256" ] || { echo "missing required value: libpq_sha256" >&2; exit 2; }
[ -n "$probe_sha256" ] || { echo "missing required value: probe_sha256" >&2; exit 2; }
case "$mode" in persistent|reconnect) ;; *) echo "--mode requires persistent or reconnect" >&2; exit 2 ;; esac
[[ "$warmup_count" =~ ^(0|[1-9][0-9]*)$ ]] || { echo "--warmup requires a canonical nonnegative integer" >&2; exit 2; }
[[ "$sample_count" =~ ^[1-9][0-9]*$ ]] || { echo "--samples requires a canonical positive integer" >&2; exit 2; }
if ! python3 - "$sample_count" "$warmup_count" <<'PY'
import sys

samples, warmup = (int(value) for value in sys.argv[1:])
raise SystemExit(0 if samples <= 10_000_000 and warmup <= 10_000_000 else 1)
PY
then
  echo "sample and warmup counts may not exceed 10000000" >&2
  exit 2
fi
case "$libpq_path" in /*) ;; *) echo "--libpq-path requires an absolute path" >&2; exit 2 ;; esac
case "$libpq_sha256" in *[!0-9a-f]*|"") echo "--libpq-sha256 requires lowercase hexadecimal SHA-256" >&2; exit 2 ;; esac
case "$probe_sha256" in *[!0-9a-f]*|"") echo "--probe-sha256 requires lowercase hexadecimal SHA-256" >&2; exit 2 ;; esac
[ "${#libpq_sha256}" -eq 64 ] || { echo "--libpq-sha256 requires 64 hexadecimal characters" >&2; exit 2; }
[ "${#probe_sha256}" -eq 64 ] || { echo "--probe-sha256 requires 64 hexadecimal characters" >&2; exit 2; }
for field in "$raw" "$output" "$target" "$libpq_path"; do
  case "$field" in *$'\t'*|*$'\n'*|*$'\r'*) echo "paths and labels may not contain tabs or newlines" >&2; exit 2 ;; esac
done
if [ ! -f "$raw" ] || [ -L "$raw" ]; then
  printf 'raw evidence is not a regular non-symlink file: %s\n' "$raw" >&2
  exit 1
fi
if [ ! -f "$libpq_path" ] || [ -L "$libpq_path" ]; then
  printf 'libpq provenance is not a regular non-symlink file: %s\n' "$libpq_path" >&2
  exit 1
fi
if [ -e "$output" ] || [ -L "$output" ]; then
  printf 'refusing to replace latency summary: %s\n' "$output" >&2
  exit 2
fi
[ -d "$(dirname "$output")" ] || { printf 'summary parent directory does not exist: %s\n' "$output" >&2; exit 2; }
[ -f "$publication_tool" ] && [ ! -L "$publication_tool" ] || {
  printf 'missing regular durable-publication helper: %s\n' "$publication_tool" >&2
  exit 2
}

hash_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{ print $1 }'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{ print $1 }'
  else
    echo "no SHA-256 tool available" >&2
    return 127
  fi
}
actual_libpq_sha256="$(hash_file "$libpq_path")"
[ "$actual_libpq_sha256" = "$libpq_sha256" ] || {
  printf 'libpq SHA-256 does not match exact provenance path: %s\n' "$libpq_path" >&2
  exit 1
}

work_dir="$(mktemp -d "$(dirname "$output")/.libpq-latency-summary.XXXXXX")"
pending=""
pending_identity=""
pending_dev=""
cleanup() {
  rm -rf -- "$work_dir"
  if [ -n "$pending_dev" ]; then
    python3 "$publication_tool" remove-private-identified "$pending" \
      "$pending_dev" "$pending_ino" "$pending_size" "$pending_sha" \
      >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT HUP INT TERM
durations="$work_dir/durations"
sorted="$work_dir/sorted"
pending="$(mktemp "$(dirname "$output")/.$(basename "$output").pending.XXXXXX")"
rm -f -- "$pending"

if ! python3 - "$raw" "$durations" "$mode" "$warmup_count" \
  "$sample_count" <<'PY'
import os
from pathlib import Path
import re
import stat
import sys

raw_path = Path(sys.argv[1])
durations_path = Path(sys.argv[2])
expected_mode = sys.argv[3]
expected_counts = {"warmup": int(sys.argv[4]), "measure": int(sys.argv[5])}
expected_header = (
    "schema_version\tmode\tphase\tsample_index\tduration_ns\tstatus"
)
canonical_positive = re.compile(r"[1-9][0-9]*\Z")
max_duration_ns = 10**15
max_line_bytes = 128
max_raw_bytes = 256 + sum(expected_counts.values()) * max_line_bytes


def identity(metadata: os.stat_result) -> tuple[int, ...]:
    return (
        metadata.st_dev,
        metadata.st_ino,
        metadata.st_mode,
        metadata.st_size,
        metadata.st_mtime_ns,
        metadata.st_ctime_ns,
    )


def read_line(stream) -> str | None:
    value = stream.readline(max_line_bytes + 1)
    if value == "":
        return None
    if len(value.encode("ascii")) > max_line_bytes or not value.endswith("\n"):
        raise ValueError
    value = value[:-1]
    if "\r" in value or "\0" in value:
        raise ValueError
    return value


try:
    before = os.lstat(raw_path)
    if not stat.S_ISREG(before.st_mode) or before.st_size > max_raw_bytes:
        raise ValueError
    descriptor = os.open(
        raw_path,
        os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0),
    )
    opened = os.fstat(descriptor)
    if not stat.S_ISREG(opened.st_mode) or identity(before) != identity(opened):
        os.close(descriptor)
        raise ValueError
    after = opened
    counts = {"warmup": 0, "measure": 0}
    seen_measure = False
    with os.fdopen(descriptor, "r", encoding="ascii", errors="strict", newline="") as source:
        if read_line(source) != expected_header:
            raise ValueError
        with durations_path.open("x", encoding="ascii", newline="") as durations:
            while (line := read_line(source)) is not None:
                fields = line.split("\t")
                if (
                    len(fields) != 6
                    or fields[0] != "1"
                    or fields[1] != expected_mode
                    or fields[2] not in counts
                    or canonical_positive.fullmatch(fields[3]) is None
                    or canonical_positive.fullmatch(fields[4]) is None
                    or fields[5] != "ok"
                ):
                    raise ValueError
                phase = fields[2]
                counts[phase] += 1
                if int(fields[3]) != counts[phase]:
                    raise ValueError
                duration_ns = int(fields[4])
                if duration_ns > max_duration_ns:
                    raise ValueError
                if phase == "measure":
                    seen_measure = True
                    durations.write(f"{duration_ns:016d}\t{duration_ns}\n")
                elif seen_measure:
                    raise ValueError
            after = os.fstat(source.fileno())
    current = os.lstat(raw_path)
    if (
        counts != expected_counts
        or identity(opened) != identity(after)
        or identity(after) != identity(current)
    ):
        raise ValueError
except (OSError, UnicodeError, ValueError):
    raise SystemExit(1)
PY
then
  printf 'raw latency evidence failed validation: %s\n' "$raw" >&2
  exit 1
fi

LC_ALL=C sort "$durations" >"$sorted"
p50_index=$(( (sample_count * 50 + 99) / 100 ))
p95_index=$(( (sample_count * 95 + 99) / 100 ))
p99_index=$(( (sample_count * 99 + 99) / 100 ))
p50_ns="$(sed -n "${p50_index}p" "$sorted")"
p50_ns="${p50_ns#*$'\t'}"
p95_ns="$(sed -n "${p95_index}p" "$sorted")"
p95_ns="${p95_ns#*$'\t'}"
p99_ns="$(sed -n "${p99_index}p" "$sorted")"
p99_ns="${p99_ns#*$'\t'}"
for percentile in "$p50_ns" "$p95_ns" "$p99_ns"; do
  case "$percentile" in ""|*[!0-9]*) echo "percentile selection failed" >&2; exit 1 ;; esac
done

pending_identity="$(
python3 - "$target" "$mode" "$warmup_count" "$sample_count" \
  "$p50_ns" "$p95_ns" "$p99_ns" "$raw" "$libpq_path" \
  "$libpq_sha256" "$probe_sha256" <<'PY' |
from decimal import Decimal, localcontext
import re
import sys

(
    target,
    mode,
    warmup_count,
    sample_count,
    p50_ns,
    p95_ns,
    p99_ns,
    raw,
    libpq_path,
    libpq_sha256,
    probe_sha256,
) = sys.argv[1:]
canonical_positive = re.compile(r"[1-9][0-9]*\Z")


def milliseconds(value: str) -> str:
    if canonical_positive.fullmatch(value) is None or int(value) > 10**15:
        raise ValueError("invalid selected latency percentile")
    with localcontext() as context:
        context.prec = 40
        return format(Decimal(value) / Decimal(1_000_000), ".6f")


payload = (
    "schema_version\ttarget\tmode\tstatus\tclock\twarmup_count\t"
    "sample_count\tp50_ns\tp95_ns\tp99_ns\tp50_ms\tp95_ms\tp99_ms\t"
    "raw_tsv\tlibpq_path\tlibpq_sha256\tprobe_sha256\n"
    f"1\t{target}\t{mode}\tok\tCLOCK_MONOTONIC\t{warmup_count}\t"
    f"{sample_count}\t{p50_ns}\t{p95_ns}\t{p99_ns}\t"
    f"{milliseconds(p50_ns)}\t{milliseconds(p95_ns)}\t{milliseconds(p99_ns)}\t"
    f"{raw}\t{libpq_path}\t{libpq_sha256}\t{probe_sha256}\n"
)
sys.stdout.write(payload)
PY
  python3 "$publication_tool" write-stdin-identified "$pending"
)"
IFS=$'\t' read -r pending_dev pending_ino pending_size pending_sha \
  <<<"$pending_identity"
python3 "$publication_tool" publish-identified "$pending" "$output" \
  "$pending_dev" "$pending_ino" "$pending_size" "$pending_sha"
