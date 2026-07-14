#!/usr/bin/env bash
set -euo pipefail

root="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "must run inside the Oliphaunt git checkout" >&2
  exit 1
}
cd "$root"

if [ -z "${OLIPHAUNT_PERF_RUN_DIR:-}" ]; then
  echo "OLIPHAUNT_PERF_RUN_DIR must point at a target/perf/native-liboliphaunt-* run directory" >&2
  exit 2
fi

args=(verify --run-dir "$OLIPHAUNT_PERF_RUN_DIR")
if [ "${OLIPHAUNT_PERF_ALLOW_DIAGNOSTIC:-0}" = "1" ]; then
  node tools/perf/matrix/native_oliphaunt_provenance.mjs "${args[@]}"
else
  node tools/perf/matrix/native_oliphaunt_provenance.mjs "${args[@]}" --require-release-evidence
fi
