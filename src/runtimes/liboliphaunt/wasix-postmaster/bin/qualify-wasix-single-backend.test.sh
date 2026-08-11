#!/usr/bin/env bash

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
QUALIFIER="$PROJECT_ROOT/bin/qualify-wasix-single-backend.sh"
TEST_ROOT="$(mktemp -d)"
cleanup() {
  if [ "${KEEP_WASIX_SINGLE_BACKEND_TEST_ROOT:-0}" = 1 ]; then
    printf 'preserved single-backend fixture root: %s\n' "$TEST_ROOT" >&2
  else
    rm -rf -- "$TEST_ROOT"
  fi
}
trap cleanup EXIT

FAKE_PROJECT="$TEST_ROOT/project"
FAKE_REPORTS="$TEST_ROOT/reports"
FAKE_CARRIER="$TEST_ROOT/carrier"
FAKE_NATIVE="$TEST_ROOT/native"
FAKE_IMMUTABLE_RECEIPT="$TEST_ROOT/immutable-carrier.receipt.json"
mkdir -p "$FAKE_PROJECT/bin" "$FAKE_PROJECT/lib" \
  "$FAKE_PROJECT/profiles/runtime-footprints" \
  "$FAKE_PROJECT/profiles/durability" "$FAKE_REPORTS" "$FAKE_CARRIER" \
  "$FAKE_NATIVE/bin" "$FAKE_NATIVE/lib"
cp "$QUALIFIER" "$FAKE_PROJECT/bin/qualify-wasix-single-backend.sh"
cp "$PROJECT_ROOT/bin/compare-postgres-settings.py" "$FAKE_PROJECT/bin/compare-postgres-settings.py"
cp "$PROJECT_ROOT/bin/validate-adaptive-file-cache-telemetry.py" \
  "$FAKE_PROJECT/bin/validate-adaptive-file-cache-telemetry.py"
cp "$PROJECT_ROOT/bin/validate-adaptive-file-cache-telemetry.test.py" \
  "$FAKE_PROJECT/bin/validate-adaptive-file-cache-telemetry.test.py"
cp "$PROJECT_ROOT/lib/postgres-profiles.sh" "$FAKE_PROJECT/lib/postgres-profiles.sh"
cp "$PROJECT_ROOT/lib/qualification-identities.sh" "$FAKE_PROJECT/lib/qualification-identities.sh"
cp "$PROJECT_ROOT/lib/durable_publication.py" "$FAKE_PROJECT/lib/durable_publication.py"
cp "$PROJECT_ROOT/profiles/runtime-footprints/embedded-concurrent-v1.gucs" \
  "$FAKE_PROJECT/profiles/runtime-footprints/embedded-concurrent-v1.gucs"
cp "$PROJECT_ROOT/profiles/durability/safe-v1.gucs" \
  "$FAKE_PROJECT/profiles/durability/safe-v1.gucs"
chmod +x "$FAKE_PROJECT/bin/compare-postgres-settings.py"
printf '{"schema":"fake-immutable"}\n' >"$FAKE_IMMUTABLE_RECEIPT"

cat >"$FAKE_PROJECT/lib/common.sh" <<EOF_COMMON
#!/usr/bin/env bash
set -euo pipefail
export FRESH_ROOT="$FAKE_PROJECT"
export REPORT_DIR="$FAKE_REPORTS"
export NATIVE_INSTALL_DIR="$FAKE_NATIVE"
fresh_write_report_header() {
  local report="\$1"
  local title="\$2"
  mkdir -p "\$(dirname "\$report")"
  printf '# %s\n\n' "\$title" >"\$report"
}
fresh_wasmer_bin_hash() {
  sha256sum "\$1" | awk '{ print \$1 }'
}
fresh_sha256_stream() {
  sha256sum | awk '{ print \$1 }'
}
fresh_claim_generated_directories() {
  local -a claimed=()
  local path
  local index

  [ "\$#" -gt 0 ] || return 2
  for path in "\$@"; do
    mkdir -p "\$(dirname "\$path")"
    if ! mkdir -- "\$path"; then
      for ((index = \${#claimed[@]} - 1; index >= 0; index--)); do
        rmdir -- "\${claimed[\$index]}" 2>/dev/null || true
      done
      return 2
    fi
    claimed+=("\$path")
  done
}
EOF_COMMON

cat >"$FAKE_PROJECT/lib/sealed-carrier.sh" <<'EOF_SEALED'
#!/usr/bin/env bash
fresh_verify_sealed_headless_carrier() {
  local root="$1"
  [ -d "$root" ] && [ ! -L "$root" ] &&
    [ -f "$root/manifest.json" ] && [ ! -L "$root/manifest.json" ] &&
    [ -f "$root/wasmer-build.receipt" ] && [ ! -L "$root/wasmer-build.receipt" ] &&
    [ -f "$root/payload.files" ] && [ ! -L "$root/payload.files" ] &&
    [ -x "$root/bin/wasmer-headless" ] && [ ! -L "$root/bin/wasmer-headless" ]
}
EOF_SEALED

cat >"$FAKE_PROJECT/bin/verify-immutable-sealed-carrier.sh" <<'EOF_IMMUTABLE'
#!/usr/bin/env bash
set -euo pipefail
{ [ "$#" -eq 4 ] || { [ "$#" -eq 5 ] && [ "$5" = --fast ]; }; } &&
  [ "$1" = --sealed-carrier ] && [ -d "$2" ] &&
  [ "$3" = --receipt ] && [ -f "$4" ] && [ ! -L "$4" ]
EOF_IMMUTABLE
chmod +x "$FAKE_PROJECT/bin/verify-immutable-sealed-carrier.sh"

mkdir -p "$FAKE_CARRIER/bin"
python3 - "$FAKE_PROJECT/bin/validate-adaptive-file-cache-telemetry.py" \
  "$FAKE_CARRIER/manifest.json" <<'PY'
import json
import runpy
import sys
from pathlib import Path

constants = runpy.run_path(sys.argv[1])
manifest = {
    "core-profile": "release-o3",
    "guest-build-recipe-sha256": "0" * 64,
    "runtime-abi-id": "12" * 32,
    "file-cache-policy": {
        "requested-policy-id": constants["POLICY_ID"],
        "approved-config-id": constants["CONFIG_ID"],
        "config-sha256": constants["CONFIG_SHA256"],
        "portable-fallback-mode": "observe-only",
    },
    "schema": "fake",
}
Path(sys.argv[2]).write_text(json.dumps(manifest) + "\n", encoding="utf-8")
PY
printf 'schema=fake\n' >"$FAKE_CARRIER/wasmer-build.receipt"
printf 'schema=fake-payload\n' >"$FAKE_CARRIER/payload.files"
printf '#!/usr/bin/env bash\nexit 0\n' >"$FAKE_CARRIER/bin/wasmer-headless"
chmod +x "$FAKE_CARRIER/bin/wasmer-headless"
for binary in postgres initdb psql; do
  printf '#!/usr/bin/env bash\nexit 0\n' >"$FAKE_NATIVE/bin/$binary"
  chmod +x "$FAKE_NATIVE/bin/$binary"
done
printf 'fake libpq\n' >"$FAKE_NATIVE/lib/libpq.so.5.18"
ln -s libpq.so.5.18 "$FAKE_NATIVE/lib/libpq.so.5"
ln -s libpq.so.5 "$FAKE_NATIVE/lib/libpq.so"

cat >"$FAKE_PROJECT/bin/bench-wasix-concurrent-query-suite.sh" <<'EOF_HARNESS'
#!/usr/bin/env bash
set -euo pipefail

source "$FRESH_ROOT/lib/common.sh"
source "$FRESH_ROOT/lib/postgres-profiles.sh"
source "$FRESH_ROOT/lib/sealed-carrier.sh"
source "$FRESH_ROOT/lib/qualification-identities.sh"

label=""
target=""
workload=""
connections=1
iterations=1
sealed_carrier=""
postgres_gucs=()
runtime_footprint=""
durability_profile=""
shared_memory_provider=""
require_zero_write_aot=0
immutable_carrier_receipt=""
immutable_verification_scope=full
cgroup_memory_max=""
cgroup_memory_high=""
cgroup_swap_max=""
adaptive_cache_evidence_policy=portable-correctness-v1
for wait_dump_name in \
  WASIX_PERF_WAIT_DUMP_INTERVAL_MS WASIX_PERF_WAIT_DUMP_FILE \
  WASIX_PERF_WAIT_DUMP_MAX_PER_WAIT WASIX_PERF_WAIT_DUMP_VERBOSE \
  WASIX_WAIT_DUMP_INTERVAL_MS WASIX_WAIT_DUMP_FILE \
  WASIX_WAIT_DUMP_MAX_PER_WAIT WASIX_WAIT_DUMP_VERBOSE \
  WASIX_WAIT_DUMP_FENCE_REQUEST_FILE WASIX_WAIT_DUMP_FENCE_ACK_FILE
do
  if [[ -v $wait_dump_name ]]; then
    printf 'fake timed harness inherited %s\n' "$wait_dump_name" >&2
    exit 65
  fi
done
[ ! -v OLIPHAUNT_WASIX_REQUIRE_ZERO_WRITE_AOT ]
[ ! -v OLIPHAUNT_WASIX_SEALED_LOADER_AUDIT_FILE ]
[ ! -v WASIX_CGROUP_MEMORY_MAX ]
[ ! -v WASIX_CGROUP_MEMORY_HIGH ]
[ ! -v WASIX_CGROUP_SWAP_MAX ]
[ "${WASIX_PERF_STATS:-}" = 0 ]
while [ "$#" -gt 0 ]; do
  case "$1" in
    --label) shift; label="$1" ;;
    --target) shift; target="$1" ;;
    --workload) shift; workload="$1" ;;
    --connections) shift; connections="$1" ;;
    --iterations) shift; iterations="$1" ;;
    --sealed-carrier) shift; sealed_carrier="$1" ;;
    --postgres-guc) shift; postgres_gucs+=("$1") ;;
    --runtime-footprint) shift; runtime_footprint="$1" ;;
    --durability) shift; durability_profile="$1" ;;
    --shared-memory-provider) shift; shared_memory_provider="$1" ;;
    --require-zero-write-aot) require_zero_write_aot=1 ;;
    --immutable-carrier-receipt) shift; immutable_carrier_receipt="$1" ;;
    --immutable-carrier-verification-scope) shift; immutable_verification_scope="$1" ;;
    --cgroup-memory-max) shift; cgroup_memory_max="$1" ;;
    --cgroup-memory-high) shift; cgroup_memory_high="$1" ;;
    --cgroup-swap-max) shift; cgroup_swap_max="$1" ;;
    --adaptive-cache-evidence-policy)
      shift
      adaptive_cache_evidence_policy="$1"
      ;;
    --rows|--timeout|--start-port|--checkpoint-policy|--resource-detail)
      shift
      ;;
  esac
  shift
done

if [ -n "${FAKE_EXPECT_CGROUP_BINDING:-}" ]; then
  IFS=: read -r expected_max expected_high expected_swap \
    <<<"$FAKE_EXPECT_CGROUP_BINDING"
  [ "$cgroup_memory_max" = "$expected_max" ] &&
    [ "$cgroup_memory_high" = "$expected_high" ] &&
    [ "$cgroup_swap_max" = "$expected_swap" ]
else
  [ -z "$cgroup_memory_max$cgroup_memory_high$cgroup_swap_max" ]
fi

if [ "$target" = wasix ]; then
  [ "$shared_memory_provider" = \
    "${FAKE_EXPECT_SHARED_MEMORY_PROVIDER:-portable-file-v1}" ]
else
  [ -z "$shared_memory_provider" ]
fi

if [ "$require_zero_write_aot" -eq 1 ]; then
  [ -f "$immutable_carrier_receipt" ]
fi

report="$REPORT_DIR/concurrent-query-suite/$label"
mkdir -p "$report/$target"
printf '%s\n' "${shared_memory_provider:-not-applicable}" \
  >"$report/$target/shared-memory-provider.txt"
fake_carrier_closure=none
if [ -n "$sealed_carrier" ]; then
  fresh_capture_qualification_carrier_identity "$sealed_carrier"
  fake_carrier_closure="$FRESH_QUALIFICATION_CARRIER_CLOSURE_IDENTITY"
fi
adaptive_runtime_mode=compiler
adaptive_manifest_sha=none
if [ "$target" = wasix ]; then
  adaptive_runtime_mode=sealed-headless
  adaptive_manifest_sha="$FRESH_QUALIFICATION_CARRIER_MANIFEST_SHA256"
fi
adaptive_claim_scope=portable-correctness
adaptive_required_host=any
adaptive_required_runtime=any
adaptive_required_outcome=adaptive-active-or-observe-only-fallback
adaptive_required_class=none
adaptive_min_offers=0
adaptive_min_calls=0
adaptive_min_bytes=0
adaptive_max_sample_errors=unbounded
adaptive_max_clock_errors=unbounded
adaptive_max_advice_errors=unbounded
adaptive_max_psi_breaker_trips=unbounded
adaptive_max_refault_breaker_trips=unbounded
adaptive_max_deferred_wal_pin_errors=unbounded
adaptive_max_contended_wal_pin_failures=unbounded
adaptive_terminal_receipt=active-finalized-or-admission-fallback
adaptive_scope_contract=not-required
adaptive_required_cgroup_binding=none
adaptive_required_limit_binding=none
adaptive_required_monotonic_window=none
if [ "$adaptive_cache_evidence_policy" = constrained-linux-wal-action-v1 ]; then
  [ "$target" = wasix ]
  adaptive_claim_scope=constrained-linux-performance
  adaptive_required_host=Linux
  adaptive_required_runtime=sealed-headless
  adaptive_required_outcome=adaptive-active
  adaptive_required_class=6
  adaptive_min_offers=1
  adaptive_min_calls=1
  adaptive_min_bytes=1
  adaptive_max_sample_errors=0
  adaptive_max_clock_errors=0
  adaptive_max_advice_errors=0
  adaptive_max_psi_breaker_trips=0
  adaptive_max_refault_breaker_trips=0
  adaptive_max_deferred_wal_pin_errors=0
  adaptive_max_contended_wal_pin_failures=0
  adaptive_terminal_receipt=active-finalized
  adaptive_scope_contract=required
  adaptive_required_cgroup_binding=per-target-device-inode
  adaptive_required_limit_binding=requested-equals-leaf-and-effective-min
  adaptive_required_monotonic_window=launch-before-through-post-shutdown
fi
adaptive_validator_sha="$(
  fresh_wasmer_bin_hash "$FRESH_ROOT/bin/validate-adaptive-file-cache-telemetry.py"
)"
IFS=$'\t' read -r adaptive_policy_id adaptive_config_id adaptive_config_sha < <(
  python3 - "$FRESH_ROOT/bin/validate-adaptive-file-cache-telemetry.py" <<'PY'
import runpy
import sys

constants = runpy.run_path(sys.argv[1])
print(
    constants["POLICY_ID"],
    constants["CONFIG_ID"],
    constants["CONFIG_SHA256"],
    sep="\t",
)
PY
)
printf 'schema_version\tacceptance_policy\tclaim_scope\trequired_host\tselected_host\trequired_runtime_mode\tselected_runtime_mode\tselected_memory_max\tselected_memory_high\tselected_swap_max\trequired_outcome\trequired_class\tmin_class_offers\tmin_class_advice_calls\tmin_class_advised_bytes\tmax_sample_errors\tmax_clock_errors\tmax_advice_errors\tmax_psi_breaker_trips\tmax_refault_breaker_trips\tmax_deferred_wal_pin_errors\tmax_contended_wal_pin_failures\tterminal_receipt\tvalidator_sha256\tsealed_manifest_sha256\tsample_scope_contract\trequired_cgroup_binding\trequired_limit_binding\trequired_monotonic_window\n' \
  >"$report/adaptive-cache-evidence-policy.tsv"
printf 'oliphaunt.wasix-postmaster.adaptive-cache-evidence-policy.v3\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
  "$adaptive_cache_evidence_policy" "$adaptive_claim_scope" \
  "$adaptive_required_host" "$(uname -s)" "$adaptive_required_runtime" \
  "$adaptive_runtime_mode" "${cgroup_memory_max:-none}" \
  "${cgroup_memory_high:-none}" "${cgroup_swap_max:-none}" \
  "$adaptive_required_outcome" "$adaptive_required_class" \
  "$adaptive_min_offers" "$adaptive_min_calls" "$adaptive_min_bytes" \
  "$adaptive_max_sample_errors" "$adaptive_max_clock_errors" \
  "$adaptive_max_advice_errors" "$adaptive_max_psi_breaker_trips" \
  "$adaptive_max_refault_breaker_trips" \
  "$adaptive_max_deferred_wal_pin_errors" \
  "$adaptive_max_contended_wal_pin_failures" "$adaptive_terminal_receipt" \
  "$adaptive_validator_sha" "$adaptive_manifest_sha" \
  "$adaptive_scope_contract" "$adaptive_required_cgroup_binding" \
  "$adaptive_required_limit_binding" "$adaptive_required_monotonic_window" \
  >>"$report/adaptive-cache-evidence-policy.tsv"
adaptive_policy_sha="$(fresh_wasmer_bin_hash "$report/adaptive-cache-evidence-policy.tsv")"
if [ "$target" = wasix ]; then
  adaptive_raw="$report/$target/cache-offers-postgres.adaptive.json"
  IFS=$'\t' read -r adaptive_cgroup_identity adaptive_window_start \
    adaptive_window_end < <(
      python3 - \
        "$FRESH_ROOT/bin/validate-adaptive-file-cache-telemetry.test.py" \
        "$adaptive_raw" "$label" "$adaptive_cache_evidence_policy" <<'PY'
import hashlib
import json
from pathlib import Path
import runpy
import sys

fixtures = runpy.run_path(sys.argv[1])
output = Path(sys.argv[2])
label = sys.argv[3]
policy = sys.argv[4]
seed = int(hashlib.sha256(label.encode()).hexdigest()[:12], 16)
device = 31
inode = seed + 1
sample_ns = 10_000_000_000 + seed
window_start = sample_ns - 1_000_000
window_end = sample_ns + 1_000_000
if policy == fixtures["CONSTRAINED_POLICY"]:
    value = fixtures["active_wal_action"]()
else:
    value = fixtures["fallback"]()
if label.startswith("adaptive-zero-action-"):
    value = fixtures["active"]()
elif label.startswith("adaptive-fallback-") or (
    label.startswith("adaptive-mixed-receipt-") and "-p3-wasix" in label
):
    value = fixtures["fallback"]()
elif label.startswith("adaptive-breaker-"):
    value["psi-breaker-trips"] = 1
elif label.startswith("adaptive-pin-failure-"):
    wal_bytes = 1024 * 1024
    value["classes"][5]["offers"] += 1
    value["classes"][5]["offered-finite-bytes"] += wal_bytes
    value["validation"][0] += 1
    value["range-offered-bytes"] += wal_bytes
    value["range-aligned-bytes"] += wal_bytes
    value["retain-reasons"][3]["calls"] += 1
    value["action-gate-contended-calls"] = 1
    value["action-gate-contended-retained"] = 1
    value["action-gate-contended-wal-pin-failures"] = 1
if "sample-count" in value and value.get("last-sample") is not None:
    # Qualification evidence is intentionally stricter than a structurally
    # valid warmup receipt: model a run that reached the configured admission
    # floor before it made a performance claim.
    value["sample-count"] = value["config"]["warmup-samples"]
if "last-sample" in value and value["last-sample"] is not None:
    sample = value["last-sample"]
    sample["membership-leaf-device"] = device
    sample["membership-leaf-inode"] = inode
    sample["pressure-source-device"] = device
    sample["pressure-source-inode"] = inode
    sample["monotonic-ns"] = sample_ns
    sample["effective-limit-bytes"] = 224 * 1024 * 1024
    if label.startswith("adaptive-cgroup-mismatch-"):
        sample["membership-leaf-inode"] += 1
        sample["pressure-source-inode"] += 1
    if label.startswith("adaptive-time-mismatch-"):
        sample["monotonic-ns"] = window_end + 1
    if label.startswith("adaptive-limit-mismatch-"):
        sample["effective-limit-bytes"] = 256 * 1024 * 1024
output.write_text(json.dumps(value) + "\n", encoding="utf-8")
print(f"{device}:{inode}", window_start, window_end, sep="\t")
PY
    )
  adaptive_contract_mode=portable-not-required
  adaptive_contract_path=none
  adaptive_lifecycle_path=""
  adaptive_contract_identity=none
  adaptive_contract_unit=none
  adaptive_requested_max_bytes=none
  adaptive_requested_high_bytes=none
  adaptive_requested_swap_bytes=none
  adaptive_observed_max_bytes=none
  adaptive_observed_high_bytes=none
  adaptive_observed_swap_bytes=none
  adaptive_final_max_bytes=none
  adaptive_final_high_bytes=none
  adaptive_final_swap_bytes=none
  adaptive_contract_start=none
  adaptive_contract_end=none
  if [ "$adaptive_cache_evidence_policy" = constrained-linux-wal-action-v1 ]; then
    adaptive_contract_mode=constrained-exact-cgroup-time
    adaptive_contract_identity="$adaptive_cgroup_identity"
    adaptive_contract_unit="fake-$label"
    adaptive_contract_path="/user.slice/user-1000.slice/user@1000.service/app.slice/$adaptive_contract_unit.scope"
    adaptive_lifecycle_path="$adaptive_contract_path"
    if [[ "$label" == adaptive-mixed-cgroup-path-* ]]; then
      # Reproduce the historical bug exactly: the contract carried the
      # controller filesystem path while lifecycle carried /proc/PID/cgroup's
      # namespace-relative membership path.
      adaptive_contract_path="/sys/fs/cgroup$adaptive_lifecycle_path"
    fi
    adaptive_requested_max_bytes=268435456
    adaptive_requested_high_bytes=234881024
    adaptive_requested_swap_bytes=0
    adaptive_observed_max_bytes="$adaptive_requested_max_bytes"
    adaptive_observed_high_bytes="$adaptive_requested_high_bytes"
    adaptive_observed_swap_bytes="$adaptive_requested_swap_bytes"
    adaptive_final_max_bytes="$adaptive_observed_max_bytes"
    adaptive_final_high_bytes="$adaptive_observed_high_bytes"
    adaptive_final_swap_bytes="$adaptive_observed_swap_bytes"
    if [[ "$label" == adaptive-cgroup-limit-drift-* ]]; then
      adaptive_final_high_bytes=$((adaptive_final_high_bytes - 4096))
    fi
    adaptive_contract_start="$adaptive_window_start"
    adaptive_contract_end="$adaptive_window_end"
  fi
  adaptive_server_pid=202
  adaptive_server_birth_identity="birth-$label"
  printf 'schema_version\tmeasurement_id\ttarget\tacceptance_policy\tcontract_mode\tbase_policy_sha256\tvalidator_sha256\tmanifest_sha256\tcgroup_path\tcgroup_identity\tserver_pid\tserver_birth_identity\tcgroup_unit\trequested_memory_max\trequested_memory_high\trequested_swap_max\trequested_memory_max_bytes\trequested_memory_high_bytes\trequested_swap_max_bytes\tobserved_initial_memory_max_bytes\tobserved_initial_memory_high_bytes\tobserved_initial_swap_max_bytes\tobserved_final_memory_max_bytes\tobserved_final_memory_high_bytes\tobserved_final_swap_max_bytes\tsample_window_start_monotonic_ns\tsample_window_end_monotonic_ns\tstatus\n' \
    >"$report/$target/adaptive-cache-sample-contract.tsv"
  {
    printf '%s' oliphaunt.wasix-postmaster.adaptive-cache-sample-contract.v1
    printf '\t%s' "$label" "$target" "$adaptive_cache_evidence_policy" \
      "$adaptive_contract_mode" "$adaptive_policy_sha" \
      "$adaptive_validator_sha" "$adaptive_manifest_sha" \
      "$adaptive_contract_path" "$adaptive_contract_identity" \
      "$adaptive_server_pid" "$adaptive_server_birth_identity" \
      "$adaptive_contract_unit" "${cgroup_memory_max:-none}" \
      "${cgroup_memory_high:-none}" "${cgroup_swap_max:-none}" \
      "$adaptive_requested_max_bytes" "$adaptive_requested_high_bytes" \
      "$adaptive_requested_swap_bytes" "$adaptive_observed_max_bytes" \
      "$adaptive_observed_high_bytes" "$adaptive_observed_swap_bytes" \
      "$adaptive_final_max_bytes" "$adaptive_final_high_bytes" \
      "$adaptive_final_swap_bytes" "$adaptive_contract_start" \
      "$adaptive_contract_end" passed
    printf '\n'
  } >>"$report/$target/adaptive-cache-sample-contract.tsv"
  validation_args=(
    --telemetry "$adaptive_raw"
    --manifest "$sealed_carrier/manifest.json"
    --output "$report/$target/cache-offers-postgres-adaptive-validation.tsv"
    --acceptance-policy "$adaptive_cache_evidence_policy"
    --measurement-id "$label"
    --target "$target"
  )
  if [ "$adaptive_cache_evidence_policy" = constrained-linux-wal-action-v1 ]; then
    validation_args+=(
      --cgroup-identity "$adaptive_contract_identity"
      --cgroup-memory-max-bytes "$adaptive_observed_max_bytes"
      --cgroup-memory-high-bytes "$adaptive_observed_high_bytes"
      --cgroup-swap-max-bytes "$adaptive_observed_swap_bytes"
      --sample-window-start-monotonic-ns "$adaptive_contract_start"
      --sample-window-end-monotonic-ns "$adaptive_contract_end"
    )
  fi
  if ! python3 "$FRESH_ROOT/bin/validate-adaptive-file-cache-telemetry.py" \
    "${validation_args[@]}"
  then
    validation_args=(
      --telemetry "$adaptive_raw"
      --manifest "$sealed_carrier/manifest.json"
      --output "$report/$target/cache-offers-postgres-adaptive-validation.tsv"
      --acceptance-policy portable-correctness-v1
      --measurement-id "$label"
      --target "$target"
    )
    python3 "$FRESH_ROOT/bin/validate-adaptive-file-cache-telemetry.py" \
      "${validation_args[@]}"
  fi
  if [[ "$label" == adaptive-mixed-receipt-*-p3-wasix ]]; then
    prior_validation="$(find "$REPORT_DIR/concurrent-query-suite" -path \
      '*/adaptive-mixed-receipt-*-p2-wasix/wasix/cache-offers-postgres-adaptive-validation.tsv' \
      -type f -print -quit)"
    [ -n "$prior_validation" ]
    chmod u+w "$report/$target/cache-offers-postgres-adaptive-validation.tsv"
    cp "$prior_validation" \
      "$report/$target/cache-offers-postgres-adaptive-validation.tsv"
  fi
fi
printf 'target\tserver_pid\tserver_pgid\tserver_birth_identity\tcgroup_path\tcgroup_identity\torderly_int\tforced\twait_status\tclean_shutdown_marker\tprocess_group_residue\tcgroup_residue\tport_residue\tstatus\treport\n' \
  >"$report/server-lifecycle.tsv"
if [ "$target" = wasix ] && \
  [ "$adaptive_cache_evidence_policy" = constrained-linux-wal-action-v1 ]; then
  printf '%s\t%s\t%s\t%s\t%s\t%s\t1\tnone\t0\t1\t0\t0\t0\tpassed\t%s/shutdown.tsv\n' \
    "$target" "$adaptive_server_pid" "$adaptive_server_pid" \
    "$adaptive_server_birth_identity" "$adaptive_lifecycle_path" \
    "$adaptive_contract_identity" "$report" >>"$report/server-lifecycle.tsv"
else
  printf '%s\t202\t202\tbirth-%s\t\t\t1\tnone\t0\t1\t0\t0\t0\tpassed\t%s/shutdown.tsv\n' \
    "$target" "$label" "$report" >>"$report/server-lifecycle.tsv"
fi
immutable_receipt_sha="$(fresh_wasmer_bin_hash "$immutable_carrier_receipt" 2>/dev/null || printf none)"
read -r immutable_receipt_dev immutable_receipt_ino < <(
  stat -c '%d %i' -- "$immutable_carrier_receipt" 2>/dev/null || printf 'none none\n'
)
printf 'schema_version\truntime_mode\trequire_zero_write_aot\tverification_scope\tactivation_policy\truntime_environment\taudit_environment\tenvironment_inheritance\tallowed_snapshot_modes\tmax_source_bytes_written\tmax_snapshot_bytes_written\tmax_sync_calls\tvalidator\tvalidator_sha256\timmutable_receipt_path\timmutable_receipt_sha256\timmutable_receipt_dev\timmutable_receipt_ino\tcarrier_closure_identity\tcore_profile\tguest_build_recipe_sha256\n' >"$report/sealed-loader-policy.tsv"
printf 'oliphaunt.wasix-postmaster.sealed-loader-policy.v2\tsealed-headless\t%s\t%s\t%s\t%s\t%s\tsanitized-then-explicit\t%s\t0\t0\t0\tfake-validator\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
  "$require_zero_write_aot" "$immutable_verification_scope" \
  "$([ "$require_zero_write_aot" -eq 1 ] && printf direct-immutable-only || printf compatibility)" \
  "$([ "$require_zero_write_aot" -eq 1 ] && printf OLIPHAUNT_WASIX_REQUIRE_ZERO_WRITE_AOT=1 || printf unset)" \
  "$([ "$require_zero_write_aot" -eq 1 ] && printf owned-per-target-jsonl || printf disabled)" \
  "$([ "$require_zero_write_aot" -eq 1 ] && printf direct-immutable-inode || printf unrestricted)" \
  "$(printf fake-validator | sha256sum | awk '{ print $1 }')" \
  "${immutable_carrier_receipt:-none}" "$immutable_receipt_sha" \
  "$immutable_receipt_dev" "$immutable_receipt_ino" \
  "$([ "$require_zero_write_aot" -eq 1 ] && printf '%s' "$fake_carrier_closure" || printf none)" \
  "$([ "$require_zero_write_aot" -eq 1 ] && printf '%s' "$FRESH_QUALIFICATION_CORE_PROFILE" || printf none)" \
  "$([ "$require_zero_write_aot" -eq 1 ] && printf '%s' "$FRESH_QUALIFICATION_GUEST_BUILD_RECIPE_SHA256" || printf none)" \
  >>"$report/sealed-loader-policy.tsv"
if [ "$require_zero_write_aot" -eq 1 ]; then
  [ "$target" = wasix ]
  printf '{"fake":"direct-immutable"}\n' >"$report/$target/sealed-loader-audit.jsonl"
  printf 'schema_version\tstatus\trecords\taot_records\tmemory_records\tinitdb_executions\tpostgres_executions\tinitdb_pids\tpostgres_pids\trequired_snapshot_mode\n%s\tpassed\t4\t2\t2\t1\t1\t101\t202\tdirect-immutable-inode\n' \
    oliphaunt.wasix-postmaster.sealed-loader-audit-validation.v3 \
    >"$report/$target/sealed-loader-audit-validation.tsv"
fi
printf 'schema_version\tlane\twasix_perf_stats\twait_dump_policy\twait_dump_interval_ms\twait_dump_max_per_wait\twait_dump_verbose\tfence_protocol\tsanitized_environment\n' \
  >"$report/instrumentation-policy.tsv"
printf 'oliphaunt.wasix-postmaster.instrumentation.v1\tbenchmark\t0\tprohibited\t0\t0\t0\tnone\tfixture\n' \
  >>"$report/instrumentation-policy.tsv"
printf '%s\n' "${postgres_gucs[@]}" >"$report/postgres-gucs.txt"
profile_resolution_active=0
if [ -n "$runtime_footprint$durability_profile" ]; then
  profile_resolution_active=1
  fresh_resolve_postgres_profiles "$runtime_footprint" "$durability_profile" \
    "${postgres_gucs[@]}"
  fresh_write_postgres_profile_evidence \
    "$report/postgres-profile-inputs.tsv" \
    "$report/postgres-profile-resolution.tsv"
fi
if [ "$target" = wasix ]; then
  fresh_capture_qualification_carrier_identity "$sealed_carrier"
  module_sha="$(fresh_wasmer_bin_hash "$FRESH_ROOT/fake-postgres.wasm")"
  printf 'schema_version\tpostgres_major\truntime_mode\tcarrier_closure_identity\tcarrier_manifest_sha256\tcarrier_receipt_sha256\tcarrier_payload_inventory_sha256\tcarrier_headless_sha256\twasmer_bin_sha256\tpostgres_module_sha256\truntime_footprint\truntime_footprint_sha256\tdurability_profile\tdurability_profile_sha256\tpostgres_profile_resolution_identity\n' >"$report/execution-identity.tsv"
  printf 'oliphaunt.wasix-postmaster.execution-identity.v1\t18\tsealed-headless\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$FRESH_QUALIFICATION_CARRIER_CLOSURE_IDENTITY" \
    "$FRESH_QUALIFICATION_CARRIER_MANIFEST_SHA256" \
    "$FRESH_QUALIFICATION_CARRIER_RECEIPT_SHA256" \
    "$FRESH_QUALIFICATION_CARRIER_PAYLOAD_SHA256" \
    "$FRESH_QUALIFICATION_CARRIER_HEADLESS_SHA256" \
    "$FRESH_QUALIFICATION_CARRIER_HEADLESS_SHA256" "$module_sha" \
    "${runtime_footprint:-none}" \
    "${FRESH_POSTGRES_RUNTIME_FOOTPRINT_SHA256:-none}" \
    "${durability_profile:-none}" \
    "${FRESH_POSTGRES_DURABILITY_SHA256:-none}" \
    "${FRESH_POSTGRES_PROFILE_RESOLUTION_IDENTITY:-none}" \
    >>"$report/execution-identity.tsv"
fi
if [ "$target" = "native" ]; then
  wall=100
  query=80.000
  throughput=100.000
else
  wall=120
  query=95.000
  throughput=80.000
fi
operation_count=$((connections * iterations))

printf 'target\tworkload\tstatus\tconnections\titerations\toperation_count\tverified_count\texpected_verify_count\tfanout_wall_ms\tthroughput_ops_per_sec\tok_clients\tfailed_clients\ttimed_out\tepoll_intr_count\tserver_log\treport_dir\n' \
  >"$report/summary.tsv"
printf '%s\t%s\t0\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t0\t0\t0\tserver.log\t%s\n' \
  "$target" "$workload" "$connections" "$iterations" "$operation_count" \
  "$operation_count" "$operation_count" "$wall" "$throughput" "$connections" \
  "$report" >>"$report/summary.tsv"

printf 'target\tworkload\tclient\tstatus\tbulk_batch_wall_ms\tbulk_batch_psql_time_sum_ms\tbulk_batch_psql_time_count\tlog\n' \
  >"$report/client-summary.tsv"
for ((client = 1; client <= connections; client++)); do
  printf '%s\t%s\t%s\t0\t%s\t%s\t1\tclient-%s.log\n' \
    "$target" "$workload" "$client" "$wall" "$query" "$client" \
    >>"$report/client-summary.tsv"
done

shared_buffers=2048
shared_buffers_source=default
io_method=worker
io_method_source=default
max_connections=33
autovacuum_worker_slots=16
worker_capacity_source=default
work_mem=""
work_mem_source='command line'
if [ "$runtime_footprint" = embedded-concurrent ]; then
  shared_buffers=4096
  shared_buffers_source='command line'
  io_method=sync
  io_method_source='command line'
  max_connections=8
  autovacuum_worker_slots=4
  worker_capacity_source='command line'
fi
for guc in "${postgres_gucs[@]}"; do
  case "$guc" in
    shared_buffers=32MB)
      shared_buffers=4096
      shared_buffers_source='command line'
      ;;
    work_mem=4MB)
      work_mem=4096
      ;;
  esac
done
case "$label:$target" in
  profile-mismatch-*:wasix) shared_buffers=$((shared_buffers + 1)) ;;
  work-mem-mismatch-*:wasix) work_mem=8192 ;;
esac
settings="$report/$target/effective-postgres-settings.tsv"
printf 'name\tsetting\tunit\tsource\n' >"$settings"
printf 'backend_flush_after\t0\t8kB\tdefault\n' >>"$settings"
printf 'autovacuum_worker_slots\t%s\t\t%s\n' \
  "$autovacuum_worker_slots" "$worker_capacity_source" >>"$settings"
printf 'bgwriter_flush_after\t64\t8kB\tdefault\n' >>"$settings"
printf 'checkpoint_flush_after\t32\t8kB\tdefault\n' >>"$settings"
printf 'checkpoint_timeout\t3600\ts\tcommand line\n' >>"$settings"
printf 'fsync\ton\t\tcommand line\n' >>"$settings"
printf 'full_page_writes\ton\t\tcommand line\n' >>"$settings"
printf 'io_method\t%s\t\t%s\n' "$io_method" "$io_method_source" >>"$settings"
printf 'max_connections\t%s\t\tcommand line\n' "$max_connections" >>"$settings"
printf 'max_wal_senders\t10\t\t%s\n' "$worker_capacity_source" >>"$settings"
printf 'max_worker_processes\t8\t\t%s\n' "$worker_capacity_source" >>"$settings"
printf 'max_wal_size\t8192\tMB\tcommand line\n' >>"$settings"
printf 'min_wal_size\t1024\tMB\tcommand line\n' >>"$settings"
printf 'shared_buffers\t%s\t8kB\t%s\n' "$shared_buffers" "$shared_buffers_source" >>"$settings"
printf 'synchronous_commit\ton\t\tcommand line\n' >>"$settings"
printf 'wal_segment_size\t16777216\tB\toverride\n' >>"$settings"
if [ -n "$work_mem" ]; then
  printf 'work_mem\t%s\tkB\t%s\n' "$work_mem" "$work_mem_source" >>"$settings"
fi

case "$label" in
  failure-*-p2-wasix) exit 1 ;;
  profile-evidence-mismatch-*-p2-wasix)
    chmod u+w "$report/postgres-profile-resolution.tsv"
    printf 'unexpected\trow\n' >>"$report/postgres-profile-resolution.tsv"
    ;;
  carrier-mutation-*-p2-wasix)
    printf 'mutated\n' >>"$sealed_carrier/manifest.json"
    ;;
  native-mutation-*-p2-wasix)
    printf '# mutation\n' >>"$NATIVE_INSTALL_DIR/bin/psql"
    ;;
  receipt-mutation-*-p2-wasix)
    printf 'mutated\n' >>"$immutable_carrier_receipt"
    ;;
esac
EOF_HARNESS
chmod +x "$FAKE_PROJECT/bin/bench-wasix-concurrent-query-suite.sh"
printf 'fake PostgreSQL guest module\n' >"$FAKE_PROJECT/fake-postgres.wasm"

run_qualifier() {
  local label="$1"
  shift
  "$FAKE_PROJECT/bin/qualify-wasix-single-backend.sh" \
    --sealed-carrier "$FAKE_CARRIER" \
    --blocks 1 \
    --workload indexed-read \
    --connections 1 \
    --iterations 10 \
    --rows 10 \
    --label "$label" "$@"
}

export WASIX_WAIT_DUMP_INTERVAL_MS=777
export WASIX_PERF_WAIT_DUMP_FILE="$TEST_ROOT/ambient-wait-dump.log"
run_qualifier success --postgres-guc shared_buffers=32MB >/dev/null
unset WASIX_WAIT_DUMP_INTERVAL_MS WASIX_PERF_WAIT_DUMP_FILE
success_root="$FAKE_REPORTS/single-backend-qualification/success"
[ -s "$success_root/bulk-batch-samples.tsv" ]
[ -s "$success_root/bulk-batch-summary.tsv" ]
[ ! -e "$success_root/latency-summary.tsv" ]
[ -s "$success_root/carrier-identity.tsv" ]
[ -s "$success_root/carrier-verification.tsv" ]
[ -s "$success_root/native-oracle-identity.tsv" ]
[ -s "$success_root/native-oracle-verification.tsv" ]
[ -s "$success_root/instrumentation-policy.tsv" ]
[ -s "$success_root/instrumentation-verification.tsv" ]
[ -s "$success_root/adaptive-cache-verification.tsv" ]
[ -s "$success_root/wasix-execution-identity.tsv" ]
[ "$(stat -c '%a' "$success_root/wasix-execution-identity.tsv")" = 444 ]
awk -F '\t' 'NR > 1 { if ($4 != "passed") exit 1; rows++ } END { exit rows != 4 }' \
  "$success_root/instrumentation-verification.tsv"
awk -F '\t' '
  NR == 1 {
    for (column = 1; column <= NF; column++) field[$column] = column
    next
  }
  NR > 1 {
    if ($(field["acceptance_policy"]) != "portable-correctness-v1" ||
        $(field["status"]) != "passed") exit 1
    if ($2 == "wasix" &&
        ($(field["outcome"]) != "observe-only-fallback" ||
         $(field["raw_telemetry_sha256"]) !~ /^[0-9a-f]{64}$/ ||
         $(field["qualification_validation_sha256"]) !~ /^[0-9a-f]{64}$/)) exit 1
    if ($2 == "native" && $(field["outcome"]) != "not-applicable") exit 1
    rows++
  }
  END { exit rows != 4 }
' "$success_root/adaptive-cache-verification.tsv"
awk -F '\t' 'NR > 1 { if ($9 != "passed") exit 1; rows++ } END { exit rows != 2 }' \
  "$success_root/profile-summary.tsv"
awk -F '\t' 'NR > 1 { if ($4 != "passed") exit 1; rows++ } END { exit rows != 16 }' \
  "$success_root/carrier-verification.tsv"
awk -F '\t' 'NR > 1 { if ($4 != "passed") exit 1; rows++ } END { exit rows != 12 }' \
  "$success_root/native-oracle-verification.tsv"
[ "$(find "$FAKE_REPORTS/concurrent-query-suite" -maxdepth 2 -name postgres-gucs.txt -path '*success*' -exec grep -l '^shared_buffers=32MB$' {} + | wc -l)" -eq 4 ]
awk -F '\t' '
  NR == 1 {
    if ($7 != "workload_status" || $8 != "harness_status" ||
        $9 != "effective_status" || $10 != "derived_metrics_valid") exit 1
  }
  NR > 1 && ($7 != 0 || $8 != 0 || $9 != 0 || $10 != 1 || $11 == "") {
    exit 1
  }
' "$success_root/samples.tsv"
awk -F '\t' 'NR == 2 { if ($NF != "passed") exit 1; found = 1 } END { exit !found }' \
  "$success_root/paired-summary.tsv"
awk -F '\t' 'NR == 2 { if ($NF != "passed") exit 1; found = 1 } END { exit !found }' \
  "$success_root/bulk-batch-summary.tsv"
for receipt in "$success_root/qualification-policy.tsv" \
  "$success_root/qualification-result.tsv"; do
  awk -F '\t' '
    NR == 1 {
      for (column = 1; column <= NF; column++) field[$column] = column
      next
    }
    NR == 2 {
      if ($(field["wasix_shared_memory_provider"]) != "portable-file-v1") exit 1
      valid = 1
    }
    END { exit !valid }
  ' "$receipt"
done
[ "$(find "$FAKE_REPORTS/concurrent-query-suite" -path '*success-*/wasix/shared-memory-provider.txt' -type f -exec grep -l '^portable-file-v1$' {} + | wc -l)" -eq 2 ]

FAKE_EXPECT_SHARED_MEMORY_PROVIDER=linux-tmpfs-v1 \
  run_qualifier shared-memory-tmpfs \
    --shared-memory-provider linux-tmpfs-v1 >/dev/null
shared_memory_root="$FAKE_REPORTS/single-backend-qualification/shared-memory-tmpfs"
for receipt in "$shared_memory_root/qualification-policy.tsv" \
  "$shared_memory_root/qualification-result.tsv"; do
  awk -F '\t' '
    NR == 1 {
      for (column = 1; column <= NF; column++) field[$column] = column
      next
    }
    NR == 2 {
      if ($(field["wasix_shared_memory_provider"]) != "linux-tmpfs-v1") exit 1
      valid = 1
    }
    END { exit !valid }
  ' "$receipt"
done
[ "$(find "$FAKE_REPORTS/concurrent-query-suite" -path '*shared-memory-tmpfs-*/wasix/shared-memory-provider.txt' -type f -exec grep -l '^linux-tmpfs-v1$' {} + | wc -l)" -eq 2 ]
grep -Fq 'WASIX shared-memory provider: `linux-tmpfs-v1`' \
  "$shared_memory_root/summary.md"

set +e
run_qualifier unknown-shared-memory-provider \
  --shared-memory-provider almost-tmpfs >"$TEST_ROOT/unknown-provider.log" 2>&1
unknown_provider_status=$?
set -e
[ "$unknown_provider_status" -eq 2 ]
grep -Fq -- '--shared-memory-provider requires portable-file-v1 or linux-tmpfs-v1' \
  "$TEST_ROOT/unknown-provider.log"

OLIPHAUNT_WASIX_REQUIRE_ZERO_WRITE_AOT=ambient \
OLIPHAUNT_WASIX_SEALED_LOADER_AUDIT_FILE=/ambient/audit \
  run_qualifier zero-write-success --require-zero-write-aot \
    --immutable-carrier-receipt "$FAKE_IMMUTABLE_RECEIPT" >/dev/null
zero_write_root="$FAKE_REPORTS/single-backend-qualification/zero-write-success"
awk -F '\t' '
  NR == 2 {
    if ($1 != "oliphaunt.wasix-postmaster.throughput-policy.v7" ||
        $20 != 1 || $21 != "direct-immutable-only" ||
        $22 != receipt || $23 !~ /^[0-9a-f]{64}$/ ||
        $24 !~ /^[0-9]+$/ || $25 !~ /^[0-9]+$/) exit 1
    valid = 1
  }
  END { exit !valid }
' receipt="$FAKE_IMMUTABLE_RECEIPT" "$zero_write_root/qualification-policy.tsv"
awk -F '\t' '
  NR > 1 && $2 == "wasix" {
    if ($4 !~ /^[0-9a-f]{64}$/ || $6 !~ /^[0-9a-f]{64}$/ ||
        $8 !~ /^[0-9a-f]{64}$/ || $9 != "passed") exit 1
    wasix++
  }
  END { exit wasix != 2 }
' "$zero_write_root/sealed-loader-verification.tsv"
awk -F '\t' '
  NR == 1 {
    if (NF != 8 || $7 != "observed_receipt_ino" || $8 != "status") exit 1
  }
  NR > 1 {
    if (NF != 8 || $2 != $3 || $4 != $5 || $6 != $7 || $8 != "passed") exit 1
    rows++
  }
  END { exit rows == 0 }
' "$zero_write_root/immutable-carrier-verification.tsv"

set +e
run_qualifier receipt-mutation --require-zero-write-aot \
  --immutable-carrier-receipt "$FAKE_IMMUTABLE_RECEIPT" >/dev/null 2>&1
receipt_mutation_status=$?
set -e
[ "$receipt_mutation_status" -ne 0 ]
receipt_mutation_root="$FAKE_REPORTS/single-backend-qualification/receipt-mutation"
awk -F '\t' '
  NR == 1 {
    if (NF != 8 || $7 != "observed_receipt_ino" || $8 != "status") exit 1
  }
  NR > 1 && $8 == "identity-changed" {
    if ($2 == $3 || $4 != $5 || $6 != $7) exit 1
    changed = 1
  }
  END { exit !changed }
' "$receipt_mutation_root/immutable-carrier-verification.tsv"
printf '{"schema":"fake-immutable"}\n' >"$FAKE_IMMUTABLE_RECEIPT"

WASIX_CGROUP_MEMORY_MAX=ambient-max \
WASIX_CGROUP_MEMORY_HIGH=ambient-high \
WASIX_CGROUP_SWAP_MAX=ambient-swap \
FAKE_EXPECT_CGROUP_BINDING=256M:224M:0 \
  run_qualifier cgroup-success \
    --cgroup-memory-max 256M \
    --cgroup-memory-high 224M \
    --cgroup-swap-max 0 >/dev/null
cgroup_root="$FAKE_REPORTS/single-backend-qualification/cgroup-success"
for receipt in "$cgroup_root/qualification-policy.tsv" \
  "$cgroup_root/qualification-result.tsv"; do
  awk -F '\t' '
    NR == 1 {
      for (column = 1; column <= NF; column++) column_index[$column] = column
      next
    }
    NR == 2 {
      if ($1 !~ /\.(throughput-policy|throughput-result)\.v7$/ ||
          $(column_index["cgroup_binding"]) != "dedicated-systemd-user-scope" ||
          $(column_index["cgroup_memory_max"]) != "256M" ||
          $(column_index["cgroup_memory_high"]) != "224M" ||
          $(column_index["cgroup_swap_max"]) != "0" ||
          $(column_index["cgroup_environment_action"]) != "ambient-sanitized-explicit-argv") exit 1
      valid = 1
    }
    END { exit !valid }
  ' "$receipt"
done
grep -Fq 'Server cgroup MemoryMax / MemoryHigh / MemorySwapMax: `256M / 224M / 0`' \
  "$cgroup_root/summary.md"

FAKE_EXPECT_CGROUP_BINDING=256M:224M:0 \
  run_qualifier adaptive-constrained-success \
    --connections 4 \
    --cgroup-memory-max 256M \
    --cgroup-memory-high 224M \
    --cgroup-swap-max 0 \
    --adaptive-cache-evidence-policy constrained-linux-wal-action-v1 \
    >/dev/null
adaptive_root="$FAKE_REPORTS/single-backend-qualification/adaptive-constrained-success"
for receipt in "$adaptive_root/qualification-policy.tsv" \
  "$adaptive_root/qualification-result.tsv"; do
  awk -F '\t' '
    NR == 1 {
      for (column = 1; column <= NF; column++) column_index[$column] = column
      next
    }
    NR == 2 {
      if ($(column_index["adaptive_cache_evidence_policy"]) != "constrained-linux-wal-action-v1" ||
          $(column_index["adaptive_cache_validator_sha256"]) !~ /^[0-9a-f]{64}$/) exit 1
      valid = 1
    }
    END { exit !valid }
  ' "$receipt"
done
awk -F '\t' '
  NR == 1 {
    for (column = 1; column <= NF; column++) field[$column] = column
    next
  }
  NR > 1 {
    if ($(field["status"]) != "passed") exit 1
    if ($2 == "wasix") {
      if ($(field["acceptance_policy"]) != "constrained-linux-wal-action-v1" ||
          $(field["outcome"]) != "adaptive-active" ||
          $(field["class6_offers"]) < 1 ||
          $(field["class6_advice_calls"]) < 1 ||
          $(field["class6_advised_bytes"]) < 1 ||
          $(field["sample_errors"]) != 0 ||
          $(field["clock_errors"]) != 0 ||
          $(field["advice_errors"]) != 0 ||
          $(field["raw_telemetry_sha256"]) !~ /^[0-9a-f]{64}$/ ||
          $(field["inner_validation_sha256"]) !~ /^[0-9a-f]{64}$/ ||
          $(field["qualification_validation_sha256"]) !~ /^[0-9a-f]{64}$/ ||
          $(field["cgroup_identity"]) != $(field["membership_leaf_identity"]) ||
          $(field["cgroup_identity"]) != $(field["pressure_source_identity"]) ||
          $(field["cgroup_initial_memory_max_bytes"]) != 268435456 ||
          $(field["cgroup_final_memory_max_bytes"]) != 268435456 ||
          $(field["last_sample_effective_limit_bytes"]) != 234881024) exit 1
      wasix++
    } else {
      if ($(field["acceptance_policy"]) != "portable-correctness-v1" ||
          $(field["outcome"]) != "not-applicable") exit 1
      native++
    }
  }
  END { exit wasix != 2 || native != 2 }
' "$adaptive_root/adaptive-cache-verification.tsv"

set +e
FAKE_EXPECT_CGROUP_BINDING=256M:224M:0 \
  run_qualifier adaptive-zero-action \
    --connections 4 \
    --cgroup-memory-max 256M \
    --cgroup-memory-high 224M \
    --cgroup-swap-max 0 \
    --adaptive-cache-evidence-policy constrained-linux-wal-action-v1 \
    >/dev/null 2>&1
adaptive_zero_status=$?
set -e
[ "$adaptive_zero_status" -ne 0 ]
awk -F '\t' '
  NR == 1 { for (column = 1; column <= NF; column++) field[$column] = column; next }
  NR > 1 && $2 == "wasix" && $(field["status"]) == "failed" { failed++ }
  END { exit failed == 0 }
' "$FAKE_REPORTS/single-backend-qualification/adaptive-zero-action/adaptive-cache-verification.tsv"

set +e
FAKE_EXPECT_CGROUP_BINDING=256M:224M:0 \
  run_qualifier adaptive-fallback \
    --connections 4 \
    --cgroup-memory-max 256M \
    --cgroup-memory-high 224M \
    --cgroup-swap-max 0 \
    --adaptive-cache-evidence-policy constrained-linux-wal-action-v1 \
    >/dev/null 2>&1
adaptive_fallback_status=$?
set -e
[ "$adaptive_fallback_status" -ne 0 ]
awk -F '\t' '
  NR == 1 { for (column = 1; column <= NF; column++) field[$column] = column; next }
  NR > 1 && $2 == "wasix" && $(field["status"]) == "failed" { failed++ }
  END { exit failed == 0 }
' "$FAKE_REPORTS/single-backend-qualification/adaptive-fallback/adaptive-cache-verification.tsv"

for adaptive_failure_label in adaptive-mixed-receipt adaptive-cgroup-mismatch \
  adaptive-time-mismatch adaptive-limit-mismatch adaptive-cgroup-limit-drift \
  adaptive-breaker adaptive-pin-failure adaptive-mixed-cgroup-path
do
  set +e
  FAKE_EXPECT_CGROUP_BINDING=256M:224M:0 \
    run_qualifier "$adaptive_failure_label" \
      --connections 4 \
      --cgroup-memory-max 256M \
      --cgroup-memory-high 224M \
      --cgroup-swap-max 0 \
      --adaptive-cache-evidence-policy constrained-linux-wal-action-v1 \
      >/dev/null 2>&1
  adaptive_failure_status=$?
  set -e
  [ "$adaptive_failure_status" -ne 0 ]
  awk -F '\t' '
    NR == 1 {
      for (column = 1; column <= NF; column++) field[$column] = column
      next
    }
    NR > 1 && $2 == "wasix" && $(field["status"]) == "failed" { failed++ }
    END { exit failed == 0 }
  ' "$FAKE_REPORTS/single-backend-qualification/$adaptive_failure_label/adaptive-cache-verification.tsv"
done

set +e
run_qualifier adaptive-policy-without-cgroup \
  --adaptive-cache-evidence-policy constrained-linux-wal-action-v1 \
  >"$TEST_ROOT/adaptive-policy-without-cgroup.log" 2>&1
adaptive_unconstrained_status=$?
run_qualifier adaptive-policy-unknown \
  --adaptive-cache-evidence-policy almost-constrained \
  >"$TEST_ROOT/adaptive-policy-unknown.log" 2>&1
adaptive_unknown_status=$?
set -e
[ "$adaptive_unconstrained_status" -eq 2 ]
[ "$adaptive_unknown_status" -eq 2 ]
grep -Fq 'requires finite cgroup MemoryMax, MemoryHigh, and MemorySwapMax' \
  "$TEST_ROOT/adaptive-policy-without-cgroup.log"
grep -Fq -- '--adaptive-cache-evidence-policy requires portable-correctness-v1 or constrained-linux-wal-action-v1' \
  "$TEST_ROOT/adaptive-policy-unknown.log"

set +e
WASIX_CGROUP_MEMORY_MAX=256M \
  run_qualifier partial-cgroup >"$TEST_ROOT/partial-cgroup.log" 2>&1
partial_cgroup_status=$?
set -e
[ "$partial_cgroup_status" -eq 2 ]
grep -q 'must be configured together' "$TEST_ROOT/partial-cgroup.log"
[ ! -e "$FAKE_REPORTS/single-backend-qualification/partial-cgroup" ]

run_qualifier named-success \
  --runtime-footprint embedded-concurrent \
  --durability safe \
  --postgres-guc work_mem=4MB >/dev/null
named_root="$FAKE_REPORTS/single-backend-qualification/named-success"
[ -s "$named_root/postgres-profile-inputs.tsv" ]
[ -s "$named_root/postgres-profile-resolution.tsv" ]
[ "$(find "$named_root/effective-settings" -maxdepth 1 \
  -name '*.profile-validation.tsv' -type f | wc -l)" -eq 4 ]
for validation in "$named_root"/effective-settings/*.profile-validation.tsv; do
  awk -F '\t' '
    NR > 1 { if ($7 != "matched") exit 1; rows++ }
    END { exit rows != 9 }
  ' "$validation"
done
for comparison in "$named_root"/profile-comparisons/*.tsv; do
  grep -q $'^work_mem\t4096\tkB\tcommand line\t4096\tkB\tcommand line\tmatched$' \
    "$comparison"
done
for report in "$FAKE_REPORTS"/concurrent-query-suite/named-success-*; do
  cmp -s "$named_root/postgres-profile-inputs.tsv" \
    "$report/postgres-profile-inputs.tsv"
  cmp -s "$named_root/postgres-profile-resolution.tsv" \
    "$report/postgres-profile-resolution.tsv"
done
awk -F '\t' '
  NR == 1 {
    if (NF != 19 || $18 != "postgres_profile_resolution_identity" ||
        $19 != "native_oracle_identity") exit 1
    next
  }
  $18 !~ /^[0-9a-f]{64}$/ { exit 1 }
  $19 !~ /^[0-9a-f]{64}$/ { exit 1 }
  { identities[$18] = 1; native_identities[$19] = 1; rows++ }
  END {
    for (value in identities) count++
    for (value in native_identities) native_count++
    exit rows != 4 || count != 1 || native_count != 1
  }
' "$named_root/samples.tsv"
awk -F '\t' '
  NR == 1 {
    if (NF != 20 || $19 != "postgres_profile_resolution_identity" ||
        $20 != "native_oracle_identity") exit 1
    next
  }
  $19 !~ /^[0-9a-f]{64}$/ { exit 1 }
  $20 !~ /^[0-9a-f]{64}$/ { exit 1 }
' "$named_root/bulk-batch-samples.tsv"
grep -q 'Runtime footprint: `embedded-concurrent`' "$named_root/summary.md"
grep -q 'Durability profile: `safe`' "$named_root/summary.md"
grep -q 'Classification: `throughput-diagnostic-non-release`' \
  "$named_root/summary.md"
grep -q 'throughput-only; lifecycle and memory evidence are not consumed' \
  "$named_root/summary.md"
if grep -q 'release-candidate' "$named_root/summary.md"; then
  echo 'throughput-only qualifier emitted an overbroad release classification' >&2
  exit 1
fi

set +e
run_qualifier profile-overlap \
  --runtime-footprint embedded-concurrent \
  --durability safe \
  --postgres-guc shared_buffers=64MB \
  >"$TEST_ROOT/profile-overlap.log" 2>&1
overlap_status=$?
set -e
[ "$overlap_status" -eq 2 ]
grep -q 'forbids explicit overrides of: shared_buffers' \
  "$TEST_ROOT/profile-overlap.log"
[ ! -e "$FAKE_REPORTS/single-backend-qualification/profile-overlap" ]

set +e
run_qualifier profile-evidence-mismatch \
  --runtime-footprint embedded-concurrent \
  --durability safe >/dev/null 2>&1
profile_evidence_status=$?
set -e
[ "$profile_evidence_status" -ne 0 ]
awk -F '\t' '
  NR > 1 && $6 ~ /p2-wasix$/ {
    found = 1
    if ($8 != 0 || $9 == 0 || $10 != 0 || $11 != "") exit 1
  }
  END { exit !found }
' "$FAKE_REPORTS/single-backend-qualification/profile-evidence-mismatch/samples.tsv"

set +e
run_qualifier failure >/dev/null 2>&1
failure_status=$?
set -e
[ "$failure_status" -ne 0 ]
failure_root="$FAKE_REPORTS/single-backend-qualification/failure"
awk -F '\t' '
  NR > 1 && $6 ~ /p2-wasix$/ {
    found = 1
    if ($7 != 0 || $8 == 0 || $9 == 0 || $10 != 0 || $11 != "" || $12 != "") {
      exit 1
    }
  }
  END { exit !found }
' "$failure_root/samples.tsv"
awk -F '\t' 'NR == 2 { if ($NF != "failed") exit 1; found = 1 } END { exit !found }' \
  "$failure_root/paired-summary.tsv"
awk -F '\t' 'NR == 2 { if ($NF != "failed") exit 1; found = 1 } END { exit !found }' \
  "$failure_root/bulk-batch-summary.tsv"

set +e
run_qualifier profile-mismatch \
  --runtime-footprint embedded-concurrent \
  --durability safe >/dev/null 2>&1
profile_status=$?
set -e
[ "$profile_status" -ne 0 ]
awk -F '\t' 'NR > 1 && $9 == "failed" { found = 1 } END { exit !found }' \
  "$FAKE_REPORTS/single-backend-qualification/profile-mismatch/profile-summary.tsv"
grep -q $'^shared_buffers\t4096\t8kB\t4097\t8kB\tcommand line\tmismatched$' \
  "$FAKE_REPORTS/single-backend-qualification/profile-mismatch/effective-settings/"*wasix.profile-validation.tsv

set +e
run_qualifier work-mem-mismatch \
  --postgres-guc work_mem=4MB >/dev/null 2>&1
work_mem_status=$?
set -e
[ "$work_mem_status" -ne 0 ]
work_mem_root="$FAKE_REPORTS/single-backend-qualification/work-mem-mismatch"
awk -F '\t' 'NR > 1 && $9 == "failed" { found = 1 } END { exit !found }' \
  "$work_mem_root/profile-summary.tsv"
grep -q $'^work_mem\t4096\tkB\tcommand line\t8192\tkB\tcommand line\tmismatched$' \
  "$work_mem_root/profile-comparisons/"*.tsv

set +e
run_qualifier invalid-guc-name --postgres-guc Work_mem=4MB \
  >"$TEST_ROOT/invalid-guc-name.log" 2>&1
invalid_guc_name_status=$?
run_qualifier invalid-guc-value --postgres-guc work_mem= \
  >"$TEST_ROOT/invalid-guc-value.log" 2>&1
invalid_guc_value_status=$?
run_qualifier duplicate-guc --postgres-guc work_mem=4MB \
  --postgres-guc work_mem=8MB >"$TEST_ROOT/duplicate-guc.log" 2>&1
duplicate_guc_status=$?
set -e
[ "$invalid_guc_name_status" -eq 2 ]
[ "$invalid_guc_value_status" -eq 2 ]
[ "$duplicate_guc_status" -eq 2 ]
grep -q 'invalid explicit PostgreSQL setting name: Work_mem' \
  "$TEST_ROOT/invalid-guc-name.log"
grep -q 'invalid empty/edge-whitespace explicit PostgreSQL value: work_mem' \
  "$TEST_ROOT/invalid-guc-value.log"
grep -q 'duplicate explicit PostgreSQL setting: work_mem' \
  "$TEST_ROOT/duplicate-guc.log"

set +e
run_qualifier native-mutation >/dev/null 2>&1
native_status=$?
set -e
[ "$native_status" -ne 0 ]
grep -q $'native-mutation-b01-indexed-read-p2-wasix:after\t.*\tidentity-changed$' \
  "$FAKE_REPORTS/single-backend-qualification/native-mutation/native-oracle-verification.tsv"
# Restore the native oracle so the independent carrier mutation test can start.
sed -i '$d' "$FAKE_NATIVE/bin/psql"

set +e
run_qualifier carrier-mutation >/dev/null 2>&1
carrier_status=$?
set -e
[ "$carrier_status" -ne 0 ]
grep -Eq $'carrier-mutation-b01-indexed-read-p2-wasix:after\t.*\t(identity-changed|verification-failed)$' \
  "$FAKE_REPORTS/single-backend-qualification/carrier-mutation/carrier-verification.tsv"

if "$FAKE_PROJECT/bin/qualify-wasix-single-backend.sh" \
  --sealed-carrier "$FAKE_CARRIER" --max-latency-p95 2 >/dev/null 2>&1; then
  echo "legacy latency gate unexpectedly accepted" >&2
  exit 1
fi

printf 'single-backend qualifier evidence tests passed\n'
