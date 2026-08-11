#!/usr/bin/env bash

set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
durable_publication="$project_root/lib/durable_publication.py"
[ -f "$durable_publication" ] && [ ! -L "$durable_publication" ] || {
  printf 'missing regular durable-publication helper: %s\n' \
    "$durable_publication" >&2
  exit 2
}

usage() {
  echo "usage: ${0##*/} CHECKPOINTS.tsv TARGET MODE ALLOWANCE OUTPUT.tsv" >&2
  exit 64
}

[ "$#" -eq 5 ] || usage
checkpoints="$1"
target="$2"
mode="$3"
allowance="$4"
output="$5"

if ! python3 - "$allowance" <<'PY'
import re
import sys

value = sys.argv[1]
valid = re.fullmatch(r"0|[1-9][0-9]*", value) is not None
raise SystemExit(0 if valid and int(value) <= (1 << 64) - 1 else 1)
PY
then
  echo "FD allowance must be a canonical nonnegative u64 integer" >&2
  exit 64
fi
[ -f "$checkpoints" ] && [ ! -L "$checkpoints" ] || {
  printf 'host FD checkpoints are not a regular non-symlink file: %s\n' "$checkpoints" >&2
  exit 1
}
[ ! -e "$output" ] && [ ! -L "$output" ] || {
  printf 'refusing to replace host FD churn summary: %s\n' "$output" >&2
  exit 2
}
[ -d "$(dirname "$output")" ] || exit 2

pending="$(mktemp "$(dirname "$output")/.host-fd-churn.XXXXXX")"
rm -f -- "$pending"
pending_identity=""
pending_dev=""
cleanup() {
  if [ -n "$pending_dev" ]; then
    python3 "$durable_publication" remove-private-identified "$pending" \
      "$pending_dev" "$pending_ino" "$pending_size" "$pending_sha" \
      >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT HUP INT TERM

set +e
pending_identity="$(
python3 - "$project_root" "$checkpoints" "$target" "$mode" "$allowance" <<'PY' |
import re
import sys
from pathlib import Path

project_root, source, wanted_target, wanted_mode, allowance_text = sys.argv[1:]
sys.path.insert(0, str(Path(project_root) / "lib"))
from durable_publication import PublicationError, stable_regular_bytes

header = (
    "target\tmode\tstage\tmonotonic_ms\ttotal_open_fds\t"
    "observed_processes\texpected_processes\tstatus"
)
summary_header = (
    "target\tmode\tbefore_open_fds\tafter_open_fds\tquiescent_open_fds\t"
    "quiescent_growth\tallowance\tstatus\n"
)
canonical = re.compile(r"0|[1-9][0-9]*\Z")
positive = re.compile(r"[1-9][0-9]*\Z")
u64_max = (1 << 64) - 1


def unsigned(value: str, *, require_positive: bool = False) -> int:
    pattern = positive if require_positive else canonical
    if pattern.fullmatch(value) is None:
        raise ValueError
    parsed = int(value)
    if parsed > u64_max:
        raise ValueError
    return parsed


try:
    data = stable_regular_bytes(Path(source))
    text = data.decode("utf-8")
    if not text.endswith("\n") or "\r" in text or "\0" in text:
        raise ValueError
    lines = text[:-1].split("\n")
    if not lines or lines[0] != header:
        raise ValueError
    selected: dict[str, int] = {}
    for line in lines[1:]:
        fields = line.split("\t")
        if len(fields) < 2 or fields[0] != wanted_target or fields[1] != wanted_mode:
            continue
        if len(fields) != 8:
            raise ValueError
        stage = fields[2]
        if stage not in {"before", "after", "quiescent"} or stage in selected:
            raise ValueError
        unsigned(fields[3])
        selected[stage] = unsigned(fields[4])
        observed = unsigned(fields[5])
        expected = unsigned(fields[6], require_positive=True)
        if observed != expected or fields[7] != "ok":
            raise ValueError
    if set(selected) != {"before", "after", "quiescent"}:
        raise ValueError
except (OSError, PublicationError, UnicodeError, ValueError):
    raise SystemExit(2)

allowance = int(allowance_text)
growth = selected["quiescent"] - selected["before"]
status = "passed" if growth <= allowance else "failed"
row = (
    f"{wanted_target}\t{wanted_mode}\t{selected['before']}\t"
    f"{selected['after']}\t{selected['quiescent']}\t{growth}\t"
    f"{allowance}\t{status}\n"
)
sys.stdout.write(summary_header + row)
raise SystemExit(0 if status == "passed" else 1)
PY
  python3 "$durable_publication" write-stdin-identified "$pending"
)"
status=$?
set -e
IFS=$'\t' read -r pending_dev pending_ino pending_size pending_sha \
  <<<"$pending_identity"
if [ "$status" -eq 2 ]; then
  echo "host FD churn checkpoints are incomplete or malformed" >&2
  exit 1
fi
if ! python3 "$durable_publication" publish-identified "$pending" "$output" \
  "$pending_dev" "$pending_ino" "$pending_size" "$pending_sha"; then
  echo "host FD churn summary publication failed" >&2
  exit 2
fi
trap - EXIT HUP INT TERM
exit "$status"
