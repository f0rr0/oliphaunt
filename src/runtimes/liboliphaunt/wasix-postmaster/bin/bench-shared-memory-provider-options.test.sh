#!/usr/bin/env bash

set -euo pipefail

# The lifecycle registry is extracted and sourced below, so ShellCheck cannot
# statically see either the FRESH_ROOT consumer or the sourced array assignment.

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
bench="$root/bin/bench-wasix-concurrent-query-suite.sh"
helper="$root/lib/shared_memory_provider.py"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/oliphaunt-bench-shm-provider.XXXXXX")"
trap 'rm -rf -- "$tmp"' EXIT

expect_usage_failure() {
  local label="$1"
  shift
  set +e
  "$bench" "$@" >"$tmp/$label.log" 2>&1
  local status=$?
  set -e
  if [ "$status" -ne 2 ]; then
    printf '%s: expected usage exit 2, got %s\n' "$label" "$status" >&2
    sed -n '1,100p' "$tmp/$label.log" >&2
    exit 1
  fi
}

help_output="$("$bench" --help)"
grep -Fq -- '--shared-memory-provider ID' <<<"$help_output"
grep -Fq 'portable-file-v1.' <<<"$help_output"
expect_usage_failure missing-value --shared-memory-provider
expect_usage_failure unknown-provider --shared-memory-provider almost-tmpfs
grep -Fq 'requires portable-file-v1 or linux-tmpfs-v1' \
  "$tmp/unknown-provider.log"
expect_usage_failure duplicate-provider \
  --shared-memory-provider portable-file-v1 \
  --shared-memory-provider portable-file-v1
expect_usage_failure native-only-provider \
  --target native --shared-memory-provider portable-file-v1
grep -Fq 'requires the wasix target' "$tmp/native-only-provider.log"

grep -Fxq 'shared_memory_provider=portable-file-v1' "$bench"
if grep -Eq 'WASIX_SHARED_MEMORY_PROVIDER|OLIPHAUNT_WASIX_SHARED_MEMORY_PROVIDER' \
  "$bench"; then
  echo 'shared-memory provider gained an ambient activation surface' >&2
  exit 1
fi
grep -Fq 'capture-objects' "$bench"
grep -Fq 'assert-empty' "$bench"
grep -Fq 'register_external_shared_memory_provider' "$bench"
grep -Fq 'release_external_shared_memory_providers exit-drain' "$bench"

tmpfs_available=0
if [ "$(uname -s)" = Linux ] && [ -d /dev/shm ] && [ -w /dev/shm ]; then
  set +e
  python3 - "$helper" 2>"$tmp/tmpfs-probe.log" <<'PY'
import importlib.util
from pathlib import Path
import sys

helper = Path(sys.argv[1]).resolve()
sys.path.insert(0, str(helper.parent))
spec = importlib.util.spec_from_file_location("provider", helper)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
raise SystemExit(
    0
    if module._filesystem_evidence(Path("/dev/shm"))["filesystem_type"] == "tmpfs"
    else 3
)
PY
  tmpfs_probe_status=$?
  set -e
  case "$tmpfs_probe_status" in
    0) tmpfs_available=1 ;;
    3) ;;
    *)
      echo 'shared-memory provider tmpfs probe failed unexpectedly' >&2
      sed -n '1,100p' "$tmp/tmpfs-probe.log" >&2
      exit 1
      ;;
  esac
fi

if [ "$tmpfs_available" -eq 1 ]; then
  mkdir -p "$tmp/report"
  evidence="$tmp/report/provider.json"
  prepare_identity="$(
    python3 "$helper" prepare --provider linux-tmpfs-v1 \
      --evidence "$evidence" --measurement-id bench-exit-test --target wasix \
      --output-format path-sha256-tsv
  )"
  IFS=$'\t' read -r provider_root evidence_sha256 prepare_extra \
    <<<"$prepare_identity"
  [ -n "$provider_root" ]
  [ -z "$prepare_extra" ]
  [[ "$evidence_sha256" =~ ^[0-9a-f]{64}$ ]]
  [ "$evidence_sha256" = "$(sha256sum "$evidence" | awk '{ print $1 }')" ]
  cleanup_evidence="$tmp/report/cleanup.json"
  exit_objects="$tmp/report/exit-objects.json"
  exit_release="$tmp/report/exit-release.json"

  sed -n '/^active_shared_memory_records=()/,/^register_background_pid()/p' \
    "$bench" | sed '$d' >"$tmp/provider-functions.sh"
  # shellcheck source=/dev/null
  source "$tmp/provider-functions.sh"
  # shellcheck disable=SC2034
  FRESH_ROOT="$root"
  if register_external_shared_memory_provider one two three four five six \
    2>"$tmp/external-arity.log"; then
    echo 'external provider registry accepted the wrong field count' >&2
    exit 1
  fi
  if register_pending_external_shared_memory_provider one two three four \
    2>"$tmp/pending-arity.log"; then
    echo 'pending provider registry accepted the wrong field count' >&2
    exit 1
  fi
  grep -Fq 'requires seven fields' "$tmp/external-arity.log"
  grep -Fq 'requires five fields' "$tmp/pending-arity.log"
  register_external_shared_memory_provider linux-tmpfs-v1 "$provider_root" \
    "$evidence" "$evidence_sha256" "$cleanup_evidence" "$exit_objects" \
    "$exit_release"

  : >"$provider_root/postgresql-wasix-00000001-00000002"
  if release_external_shared_memory_providers bench-early-return \
    >"$tmp/nonempty.log" 2>&1; then
    echo 'benchmark cleanup removed a nonempty provider root' >&2
    exit 1
  fi
  [ -d "$provider_root" ]
  [ -s "$exit_objects" ]
  rm -f -- "$provider_root/postgresql-wasix-00000001-00000002"
  release_external_shared_memory_providers bench-early-return
  [ ! -e "$provider_root" ]
  [ -s "$cleanup_evidence" ]
  # shellcheck disable=SC2154
  [ "${#active_shared_memory_records[@]}" -eq 0 ]

  pending_evidence="$tmp/report/pending-provider.json"
  pending_identity="$(
    python3 "$helper" prepare --provider linux-tmpfs-v1 \
      --evidence "$pending_evidence" --measurement-id bench-pending-test \
      --target wasix --output-format path-sha256-tsv
  )"
  IFS=$'\t' read -r pending_root pending_sha256 pending_extra \
    <<<"$pending_identity"
  [ -n "$pending_root" ]
  [ -z "$pending_extra" ]
  [[ "$pending_sha256" =~ ^[0-9a-f]{64}$ ]]
  register_pending_external_shared_memory_provider linux-tmpfs-v1 \
    "$pending_evidence" "$tmp/report/pending-cleanup.json" \
    "$tmp/report/pending-exit-objects.json" \
    "$tmp/report/pending-exit-release.json"
  release_external_shared_memory_providers bench-pending-adoption
  [ ! -e "$pending_root" ]
  # shellcheck disable=SC2154
  [ "${#pending_shared_memory_records[@]}" -eq 0 ]

  missing_evidence="$tmp/report/missing-provider.json"
  missing_identity="$(
    python3 "$helper" prepare --provider linux-tmpfs-v1 \
      --evidence "$missing_evidence" --measurement-id bench-missing-test \
      --target wasix --output-format path-sha256-tsv
  )"
  IFS=$'\t' read -r missing_root missing_sha256 missing_extra \
    <<<"$missing_identity"
  [ -n "$missing_root" ]
  [ -z "$missing_extra" ]
  python3 "$helper" cleanup --provider linux-tmpfs-v1 \
    --root "$missing_root" --evidence "$missing_evidence" \
    --evidence-sha256 "$missing_sha256" \
    --cleanup-evidence "$tmp/report/missing-prior-cleanup.json" \
    --reason test-fixture-removal
  register_pending_external_shared_memory_provider linux-tmpfs-v1 \
    "$missing_evidence" "$tmp/report/missing-cleanup.json" \
    "$tmp/report/missing-exit-objects.json" \
    "$tmp/report/missing-exit-release.json"
  if recover_pending_external_shared_memory_providers \
    >"$tmp/missing-root.log" 2>&1; then
    echo 'pending provider recovery accepted a vanished evidenced root' >&2
    exit 1
  fi
  grep -Fq 'root disappeared before adoption' "$tmp/missing-root.log"
  # shellcheck disable=SC2154
  [ "${#pending_shared_memory_records[@]}" -eq 1 ]
  unregister_pending_external_shared_memory_provider "$missing_evidence"
fi

printf 'passed: explicit shared-memory provider parsing, evidence, and drained exact cleanup\n'
