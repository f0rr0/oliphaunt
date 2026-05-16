#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
TARGET_ROOT="$REPO_ROOT/target/perf"

RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)"
RTT_ITERATIONS=100
PREPARED_ROWS=25000
SDK_ITERATIONS=1000
SPEED_REPEATS=10
RUN_WASIX=1
RUN_PREPARED=1
BUILD_XTASK="${PGLITE_OXIDE_PERF_BUILD_XTASK:-1}"
SPEED_SOURCE="${PGLITE_OXIDE_PERF_SPEED_SOURCE:-pglite}"
WASIX_POSTGRES_MAJOR="${PGLITE_OXIDE_PERF_WASIX_POSTGRES_MAJOR:-18}"
RUNTIME_KIND_WASIX_POSTGRES_SERVER="wasix-postgres-server"
CURRENT_WASIX_RUNTIME_KIND=""
STABLE_WORKTREE="${PGLITE_OXIDE_PERF_STABLE_WORKTREE:-}"
ALLOW_DIRTY_STABLE="${PGLITE_OXIDE_PERF_ALLOW_DIRTY_STABLE:-0}"
ALLOW_EXTERNAL_RUNTIME="${PGLITE_OXIDE_PERF_ALLOW_EXTERNAL_RUNTIME:-0}"
RUN_STABLE=0
if [[ -n "$STABLE_WORKTREE" ]]; then
  RUN_STABLE=1
fi

usage() {
  cat >&2 <<'USAGE'
usage: tools/scripts/perf/run_native_libpglite_matrix.sh [options]

Options:
  --run-id ID             Output run id. Defaults to current UTC timestamp.
  --rtt-iterations N     RTT samples per case. Default: 100.
  --prepared-rows N      Prepared-update rows. Default: 25000.
  --sdk-iterations N     High-level Rust SDK samples. Default: 1000.
  --speed-repeats N      Fresh-process speed-suite repeats for p50/p90. Default: 10.
  --speed-source SOURCE  Speed SQL source: generated, local, pglite, pglite-vendored, upstream.
                         Default: pglite.
  --wasix-postgres-major N
                         Required PostgreSQL major for current-branch WASIX assets.
                         Default: 18.
  --stable-worktree DIR  Also run stable pglite-oxide controls from another worktree.
                         Can also be set with PGLITE_OXIDE_PERF_STABLE_WORKTREE.
  --allow-dirty-stable   Allow a dirty stable worktree. This is for harness smoke
                         only; production comparison runs should use a clean tree.
  --skip-stable          Skip the stable-worktree lane even if the environment is set.
  --skip-wasix           Skip WASIX direct/server release-lane controls.
  --skip-prepared        Skip prepared-update suites.
  --skip-build           Reuse target/release/xtask without rebuilding it.
  -h, --help             Show this help.

Environment:
  LIBPGLITE_OXIDE_LIBPGLITE      Required path to libpglite.dylib/.so.
  LIBPGLITE_OXIDE_POSTGRES       Path to matching postgres binary.
  LIBPGLITE_OXIDE_INITDB         Path to matching initdb binary.
  PGLITE_OXIDE_PERF_STABLE_WORKTREE
                                  Optional stable pglite-oxide worktree path.
  PGLITE_OXIDE_PERF_WASIX_POSTGRES_MAJOR
                                  Expected current-branch WASIX PostgreSQL major.
  PGLITE_OXIDE_PERF_ALLOW_DIRTY_STABLE=1
                                  Allow dirty stable worktree for smoke runs.
  PGLITE_OXIDE_PERF_ALLOW_EXTERNAL_RUNTIME=1
                                  Allow explicit current runtime archives for
                                  smoke runs. Production matrix runs should use
                                  generated assets plus matching AOT manifests.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --run-id)
      RUN_ID="${2:?--run-id requires a value}"
      shift 2
      ;;
    --rtt-iterations)
      RTT_ITERATIONS="${2:?--rtt-iterations requires a value}"
      shift 2
      ;;
    --prepared-rows)
      PREPARED_ROWS="${2:?--prepared-rows requires a value}"
      shift 2
      ;;
    --sdk-iterations)
      SDK_ITERATIONS="${2:?--sdk-iterations requires a value}"
      shift 2
      ;;
    --speed-repeats)
      SPEED_REPEATS="${2:?--speed-repeats requires a value}"
      shift 2
      ;;
    --speed-source)
      SPEED_SOURCE="${2:?--speed-source requires a value}"
      shift 2
      ;;
    --wasix-postgres-major)
      WASIX_POSTGRES_MAJOR="${2:?--wasix-postgres-major requires a value}"
      shift 2
      ;;
    --stable-worktree)
      STABLE_WORKTREE="${2:?--stable-worktree requires a value}"
      RUN_STABLE=1
      shift 2
      ;;
    --allow-dirty-stable)
      ALLOW_DIRTY_STABLE=1
      shift
      ;;
    --skip-stable)
      RUN_STABLE=0
      shift
      ;;
    --skip-wasix)
      RUN_WASIX=0
      shift
      ;;
    --skip-prepared)
      RUN_PREPARED=0
      shift
      ;;
    --skip-build)
      BUILD_XTASK=0
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "unknown argument: $1" >&2
      usage
      exit 2
      ;;
  esac
done

if [[ "$RTT_ITERATIONS" -le 0 || "$PREPARED_ROWS" -le 0 || "$SDK_ITERATIONS" -le 0 || "$SPEED_REPEATS" -le 0 ]]; then
  echo "iteration, row, sample, and repeat counts must be positive" >&2
  exit 2
fi
if ! [[ "$WASIX_POSTGRES_MAJOR" =~ ^[0-9]+$ ]] || [[ "$WASIX_POSTGRES_MAJOR" -le 0 ]]; then
  echo "WASIX PostgreSQL major must be positive" >&2
  exit 2
fi

case "$SPEED_SOURCE" in
  generated|local|pglite|pglite-vendored|upstream)
    ;;
  *)
    echo "unknown speed source: $SPEED_SOURCE" >&2
    echo "expected one of: generated, local, pglite, pglite-vendored, upstream" >&2
    exit 2
    ;;
esac

LIBPGLITE="${LIBPGLITE_OXIDE_LIBPGLITE:-${PGLITE_OXIDE_NATIVE_LIBPGLITE:-$REPO_ROOT/target/libpglite-pg18/out/libpglite.dylib}}"
POSTGRES_BIN="${LIBPGLITE_OXIDE_POSTGRES:-${PGLITE_OXIDE_NATIVE_POSTGRES:-$REPO_ROOT/target/libpglite-pg18/install/bin/postgres}}"
INITDB_BIN="${LIBPGLITE_OXIDE_INITDB:-${PGLITE_OXIDE_NATIVE_INITDB:-$REPO_ROOT/target/libpglite-pg18/install/bin/initdb}}"

if [[ ! -f "$LIBPGLITE" ]]; then
  echo "missing native libpglite: $LIBPGLITE" >&2
  exit 1
fi
if [[ ! -x "$POSTGRES_BIN" ]]; then
  echo "missing native postgres binary: $POSTGRES_BIN" >&2
  exit 1
fi
if [[ ! -x "$INITDB_BIN" ]]; then
  echo "missing native initdb binary: $INITDB_BIN" >&2
  exit 1
fi

export LIBPGLITE_OXIDE_LIBPGLITE="$LIBPGLITE"
export LIBPGLITE_OXIDE_POSTGRES="$POSTGRES_BIN"
export LIBPGLITE_OXIDE_INITDB="$INITDB_BIN"
export PGLITE_OXIDE_NATIVE_LIBPGLITE="$LIBPGLITE"
export PGLITE_OXIDE_NATIVE_POSTGRES="$POSTGRES_BIN"
export PGLITE_OXIDE_NATIVE_INITDB="$INITDB_BIN"

RUN_DIR="$TARGET_ROOT/native-libpglite-$RUN_ID"
mkdir -p "$RUN_DIR"

XTASK="$REPO_ROOT/target/release/xtask"
STABLE_XTASK=""
STABLE_REVISION=""
STABLE_BRANCH=""
STABLE_DIRTY=0
STABLE_SUPPORTS_SERVER_TOKIO_SPEED=0

if [[ "$BUILD_XTASK" -eq 1 ]]; then
  echo "Building release xtask..."
  cargo build --release -p xtask
elif [[ ! -x "$XTASK" ]]; then
  echo "missing release xtask: $XTASK" >&2
  echo "run without --skip-build first" >&2
  exit 1
else
  echo "Reusing existing release xtask: $XTASK"
fi

if [[ "$RUN_STABLE" -eq 1 ]]; then
  if [[ -z "$STABLE_WORKTREE" ]]; then
    echo "--stable-worktree or PGLITE_OXIDE_PERF_STABLE_WORKTREE is required when stable lane is enabled" >&2
    exit 2
  fi
  if [[ ! -d "$STABLE_WORKTREE" || ! -f "$STABLE_WORKTREE/Cargo.toml" ]]; then
    echo "stable worktree is not a Rust workspace root: $STABLE_WORKTREE" >&2
    exit 2
  fi
  STABLE_WORKTREE="$(cd "$STABLE_WORKTREE" && pwd)"
  STABLE_XTASK="$STABLE_WORKTREE/target/release/xtask"
  STABLE_REVISION="$(git -C "$STABLE_WORKTREE" rev-parse --short HEAD 2>/dev/null || true)"
  STABLE_BRANCH="$(git -C "$STABLE_WORKTREE" branch --show-current 2>/dev/null || true)"
  if [[ -n "$(git -C "$STABLE_WORKTREE" status --porcelain 2>/dev/null || true)" ]]; then
    STABLE_DIRTY=1
  fi
  if [[ "$STABLE_DIRTY" -eq 1 && "$ALLOW_DIRTY_STABLE" -ne 1 ]]; then
    echo "stable worktree has local changes: $STABLE_WORKTREE" >&2
    echo "use a clean stable checkout for production comparisons, or pass --allow-dirty-stable for harness smoke only" >&2
    exit 2
  fi
  if [[ "$BUILD_XTASK" -eq 1 ]]; then
    echo "Building stable worktree release xtask..."
    (cd "$STABLE_WORKTREE" && cargo build --release -p xtask)
  elif [[ ! -x "$STABLE_XTASK" ]]; then
    echo "missing stable release xtask: $STABLE_XTASK" >&2
    echo "run without --skip-build first" >&2
    exit 1
  else
    echo "Reusing existing stable release xtask: $STABLE_XTASK"
  fi
  for stable_xtask_source in \
    "$STABLE_WORKTREE/tools/xtask/src/main.rs" \
    "$STABLE_WORKTREE/xtask/src/main.rs"
  do
    if [[ -f "$stable_xtask_source" ]] && grep -q "run_speed_server_tokio_postgres_simple_benchmark" "$stable_xtask_source"; then
      STABLE_SUPPORTS_SERVER_TOKIO_SPEED=1
      break
    fi
  done
fi

runtime_archive_env_path() {
  if [[ -n "${PGLITE_OXIDE_RUNTIME_ARCHIVE:-}" ]]; then
    printf '%s\n' "$PGLITE_OXIDE_RUNTIME_ARCHIVE"
  elif [[ -n "${PGLITE_OXIDE_RUNTIME_TAR:-}" ]]; then
    printf '%s\n' "$PGLITE_OXIDE_RUNTIME_TAR"
  fi
}

manifest_runtime_postgres_version() {
  local manifest="$1"
  node -e '
const fs = require("fs")
const manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
const runtime = manifest.runtime || {}
console.log(runtime["postgres-version"] || runtime.postgresVersion || "")
' "$manifest"
}

manifest_runtime_kind() {
  local manifest="$1"
  node -e '
const fs = require("fs")
const manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
const runtime = manifest.runtime || {}
console.log(runtime["runtime-kind"] || runtime.runtimeKind || "")
' "$manifest"
}

manifest_runtime_module_sha256() {
  local manifest="$1"
  node -e '
const fs = require("fs")
const manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
const runtime = manifest.runtime || {}
console.log(runtime["module-sha256"] || runtime.moduleSha256 || "")
' "$manifest"
}

aot_runtime_module_sha256() {
  local manifest="$1"
  node -e '
const fs = require("fs")
const manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
const artifact = (manifest.artifacts || []).find((entry) => entry.name === "runtime:pglite") || {}
console.log(artifact["module-sha256"] || artifact.moduleSha256 || "")
' "$manifest"
}

current_asset_metadata_postgres_version() {
  awk -F '"' '
    /^[[:space:]]*postgres-version[[:space:]]*=/ { print $2; exit }
  ' "$REPO_ROOT/crates/pglite-oxide/Cargo.toml"
}

host_target_triple() {
  case "$(uname -s)-$(uname -m)" in
    Darwin-arm64) echo "aarch64-apple-darwin" ;;
    Darwin-x86_64) echo "x86_64-apple-darwin" ;;
    Linux-x86_64) echo "x86_64-unknown-linux-gnu" ;;
    Linux-aarch64|Linux-arm64) echo "aarch64-unknown-linux-gnu" ;;
    MINGW*-x86_64|MSYS*-x86_64|CYGWIN*-x86_64) echo "x86_64-pc-windows-msvc" ;;
    *)
      echo "unsupported"
      ;;
  esac
}

current_aot_manifest_path() {
  local target
  target="$(host_target_triple)"
  local generated="$REPO_ROOT/target/pglite-oxide/aot/$target/manifest.json"
  local crate="$REPO_ROOT/crates/aot/$target/artifacts/manifest.json"
  if [[ -f "$generated" ]]; then
    printf '%s\n' "$generated"
  elif [[ -f "$crate" ]]; then
    printf '%s\n' "$crate"
  fi
}

preflight_current_wasix_metadata() {
  if [[ "$RUN_WASIX" -ne 1 ]]; then
    return
  fi

  local metadata_version
  metadata_version="$(current_asset_metadata_postgres_version)"
  if [[ -z "$metadata_version" ]]; then
    echo "current WASIX asset metadata is missing postgres-version in crates/pglite-oxide/Cargo.toml" >&2
    exit 2
  fi
  if [[ "$metadata_version" != "$WASIX_POSTGRES_MAJOR"* ]]; then
    echo "current WASIX asset metadata is not PostgreSQL $WASIX_POSTGRES_MAJOR: $metadata_version" >&2
    echo "update the current branch asset source metadata and regenerate assets before enabling current WASIX benchmarks" >&2
    exit 2
  fi
}

preflight_current_wasix_assets() {
  if [[ "$RUN_WASIX" -ne 1 ]]; then
    return
  fi

  local env_archive
  env_archive="$(runtime_archive_env_path || true)"
  if [[ -n "$env_archive" ]]; then
    if [[ ! -f "$env_archive" ]]; then
      echo "current WASIX runtime archive env path does not exist: $env_archive" >&2
      exit 2
    fi
    if [[ "$RUN_STABLE" -eq 1 ]]; then
      echo "PGLITE_OXIDE_RUNTIME_ARCHIVE/PGLITE_OXIDE_RUNTIME_TAR cannot be used while stable-worktree controls are enabled" >&2
      echo "the environment would contaminate the stable lane with current-branch runtime files" >&2
      exit 2
    fi
    if [[ "$ALLOW_EXTERNAL_RUNTIME" -ne 1 ]]; then
      echo "explicit current WASIX runtime archives are disabled for production matrix runs: $env_archive" >&2
      echo "install generated assets and matching AOT manifests, or set PGLITE_OXIDE_PERF_ALLOW_EXTERNAL_RUNTIME=1 for smoke-only runs" >&2
      exit 2
    fi
    local generated_manifest="$REPO_ROOT/target/pglite-oxide/assets/manifest.json"
    if [[ -f "$generated_manifest" ]]; then
      CURRENT_WASIX_RUNTIME_KIND="$(manifest_runtime_kind "$generated_manifest")"
    fi
    echo "Current WASIX runtime preflight: using explicit archive $env_archive (smoke-only; AOT/runtime match not proven)"
    return
  fi

  local asset_dir="$REPO_ROOT/target/pglite-oxide/assets"
  local manifest="$asset_dir/manifest.json"
  local archive="$asset_dir/pglite.wasix.tar.zst"
  if [[ ! -f "$manifest" || ! -f "$archive" ]]; then
    echo "current WASIX runtime assets are unavailable for the PG${WASIX_POSTGRES_MAJOR} matrix lane" >&2
    echo "expected $manifest and $archive, or set PGLITE_OXIDE_RUNTIME_ARCHIVE/PGLITE_OXIDE_RUNTIME_TAR" >&2
    echo "run or install current-branch PG${WASIX_POSTGRES_MAJOR} WASIX assets before enabling current WASIX benchmarks" >&2
    exit 2
  fi

  local version
  version="$(manifest_runtime_postgres_version "$manifest")"
  CURRENT_WASIX_RUNTIME_KIND="$(manifest_runtime_kind "$manifest")"
  if [[ "$version" != "$WASIX_POSTGRES_MAJOR"* ]]; then
    echo "current WASIX runtime manifest is not PostgreSQL $WASIX_POSTGRES_MAJOR: $version" >&2
    echo "manifest: $manifest" >&2
    exit 2
  fi
  if [[ "$CURRENT_WASIX_RUNTIME_KIND" == "$RUNTIME_KIND_WASIX_POSTGRES_SERVER" ]]; then
    echo "Current WASIX runtime preflight: $version $CURRENT_WASIX_RUNTIME_KIND assets from $asset_dir; external Wasmer server-core path does not require a direct AOT manifest"
    return
  fi

  local aot_manifest
  aot_manifest="$(current_aot_manifest_path || true)"
  if [[ -z "$aot_manifest" ]]; then
    echo "current WASIX AOT manifest is unavailable for $(host_target_triple)" >&2
    echo "expected target/pglite-oxide/aot/$(host_target_triple)/manifest.json or crates/aot/$(host_target_triple)/artifacts/manifest.json" >&2
    exit 2
  fi
  local runtime_sha
  local aot_sha
  runtime_sha="$(manifest_runtime_module_sha256 "$manifest")"
  aot_sha="$(aot_runtime_module_sha256 "$aot_manifest")"
  if [[ -z "$runtime_sha" || -z "$aot_sha" || "$runtime_sha" != "$aot_sha" ]]; then
    echo "current WASIX AOT runtime module does not match the runtime asset manifest" >&2
    echo "manifest runtime module-sha256: ${runtime_sha:-missing}" >&2
    echo "AOT runtime module-sha256: ${aot_sha:-missing}" >&2
    echo "AOT manifest: $aot_manifest" >&2
    exit 2
  fi
  echo "Current WASIX runtime preflight: $version assets from $asset_dir with matching AOT $aot_manifest"
}

preflight_current_wasix_metadata
preflight_current_wasix_assets

run_timed_json_in() {
  local cwd="$1"
  local name="$2"
  shift 2
  local json="$RUN_DIR/$name.json"
  local resource="$RUN_DIR/$name.resource.txt"

  echo "Running $name..."
  if [[ "$(uname -s)" == "Darwin" ]]; then
    (cd "$cwd" && /usr/bin/time -l -o "$resource" "$@") > "$json"
  elif /usr/bin/time -v true >/dev/null 2>&1; then
    (cd "$cwd" && /usr/bin/time -v -o "$resource" "$@") > "$json"
  else
    (cd "$cwd" && /usr/bin/time -p -o "$resource" "$@") > "$json"
  fi
}

run_timed_json() {
  run_timed_json_in "$REPO_ROOT" "$@"
}

run_timed_json native-libpglite-rtt \
  "$XTASK" perf native-libpglite \
  --suite rtt \
  --iterations "$RTT_ITERATIONS"

run_timed_json native-libpglite-open \
  "$XTASK" perf native-libpglite-open

run_timed_json native-libpglite-speed \
  "$XTASK" perf native-libpglite \
  --suite speed \
  --speed-source "$SPEED_SOURCE"

run_timed_json native-postgres-open \
  "$XTASK" perf native-postgres-open \
  --postgres-bin "$POSTGRES_BIN" \
  --initdb-bin "$INITDB_BIN"

run_timed_json native-postgres-tokio-all \
  "$XTASK" perf native-postgres \
  --suite all \
  --iterations "$RTT_ITERATIONS" \
  --speed-source "$SPEED_SOURCE" \
  --client tokio-postgres-simple \
  --postgres-bin "$POSTGRES_BIN" \
  --initdb-bin "$INITDB_BIN"

run_timed_json native-postgres-sqlx-all \
  "$XTASK" perf native-postgres \
  --suite all \
  --iterations "$RTT_ITERATIONS" \
  --speed-source "$SPEED_SOURCE" \
  --client sqlx \
  --postgres-bin "$POSTGRES_BIN" \
  --initdb-bin "$INITDB_BIN"

run_timed_json native-libpglite-sdk \
  "$XTASK" perf native-libpglite-sdk \
  --iterations "$SDK_ITERATIONS"

if [[ "$RUN_WASIX" -eq 1 ]]; then
  run_timed_json wasix-server-open \
    "$XTASK" perf pglite-server-open

  if [[ "$CURRENT_WASIX_RUNTIME_KIND" == "$RUNTIME_KIND_WASIX_POSTGRES_SERVER" ]]; then
    echo "Skipping wasix-direct-all: current PG${WASIX_POSTGRES_MAJOR} assets are $CURRENT_WASIX_RUNTIME_KIND and do not expose the legacy direct backend."
  else
    run_timed_json wasix-direct-all \
      "$XTASK" perf bench \
      --suite all \
      --mode direct \
      --iterations "$RTT_ITERATIONS" \
      --speed-source "$SPEED_SOURCE"
  fi

  run_timed_json wasix-server-sqlx-all \
    "$XTASK" perf bench \
    --suite all \
    --mode server-sqlx \
    --iterations "$RTT_ITERATIONS" \
    --speed-source "$SPEED_SOURCE"

  run_timed_json wasix-server-tokio-all \
    "$XTASK" perf bench \
    --suite all \
    --mode server-tokio-postgres-simple \
    --iterations "$RTT_ITERATIONS" \
    --speed-source "$SPEED_SOURCE"
fi

if [[ "$RUN_STABLE" -eq 1 ]]; then
  run_timed_json_in "$STABLE_WORKTREE" stable-wasix-direct-all \
    "$STABLE_XTASK" perf bench \
    --suite all \
    --mode direct \
    --iterations "$RTT_ITERATIONS" \
    --speed-source "$SPEED_SOURCE"

  run_timed_json_in "$STABLE_WORKTREE" stable-wasix-server-sqlx-all \
    "$STABLE_XTASK" perf bench \
    --suite all \
    --mode server-sqlx \
    --iterations "$RTT_ITERATIONS" \
    --speed-source "$SPEED_SOURCE"

  run_timed_json_in "$STABLE_WORKTREE" stable-wasix-server-tokio-all \
    "$STABLE_XTASK" perf bench \
    --suite all \
    --mode server-tokio-postgres-simple \
    --iterations "$RTT_ITERATIONS" \
    --speed-source "$SPEED_SOURCE"
fi

if [[ "$RUN_PREPARED" -eq 1 ]]; then
  run_timed_json native-libpglite-prepared \
    "$XTASK" perf native-libpglite \
    --suite prepared-updates \
    --rows "$PREPARED_ROWS"

  if [[ "$RUN_WASIX" -eq 1 ]]; then
    run_timed_json prepared-updates \
      "$XTASK" perf prepared-updates \
      --rows "$PREPARED_ROWS"
  fi

  if [[ "$RUN_STABLE" -eq 1 ]]; then
    run_timed_json_in "$STABLE_WORKTREE" stable-prepared-updates \
      "$STABLE_XTASK" perf prepared-updates \
      --rows "$PREPARED_ROWS"
  fi
fi

if [[ "$SPEED_REPEATS" -gt 1 ]]; then
  mkdir -p "$RUN_DIR/repeats"
  for index in $(seq -w 1 "$SPEED_REPEATS"); do
    run_timed_json "repeats/native-libpglite-speed-$index" \
      "$XTASK" perf native-libpglite \
      --suite speed \
      --speed-source "$SPEED_SOURCE"
    run_timed_json "repeats/native-postgres-tokio-speed-$index" \
      "$XTASK" perf native-postgres \
      --suite speed \
      --speed-source "$SPEED_SOURCE" \
      --client tokio-postgres-simple \
      --postgres-bin "$POSTGRES_BIN" \
      --initdb-bin "$INITDB_BIN"
    if [[ "$RUN_WASIX" -eq 1 ]]; then
      if [[ "$CURRENT_WASIX_RUNTIME_KIND" != "$RUNTIME_KIND_WASIX_POSTGRES_SERVER" ]]; then
        run_timed_json "repeats/wasix-direct-speed-$index" \
          "$XTASK" perf bench \
          --suite speed \
          --mode direct \
          --speed-source "$SPEED_SOURCE"
      fi
      run_timed_json "repeats/wasix-server-sqlx-speed-$index" \
        "$XTASK" perf bench \
        --suite speed \
        --mode server-sqlx \
        --speed-source "$SPEED_SOURCE"
      run_timed_json "repeats/wasix-server-tokio-speed-$index" \
        "$XTASK" perf bench \
        --suite speed \
        --mode server-tokio-postgres-simple \
        --speed-source "$SPEED_SOURCE"
    fi
    if [[ "$RUN_STABLE" -eq 1 ]]; then
      run_timed_json_in "$STABLE_WORKTREE" "repeats/stable-wasix-direct-speed-$index" \
        "$STABLE_XTASK" perf bench \
        --suite speed \
        --mode direct \
        --speed-source "$SPEED_SOURCE"
      run_timed_json_in "$STABLE_WORKTREE" "repeats/stable-wasix-server-sqlx-speed-$index" \
        "$STABLE_XTASK" perf bench \
        --suite speed \
        --mode server-sqlx \
        --speed-source "$SPEED_SOURCE"
      if [[ "$STABLE_SUPPORTS_SERVER_TOKIO_SPEED" -eq 1 ]]; then
        run_timed_json_in "$STABLE_WORKTREE" "repeats/stable-wasix-server-tokio-speed-$index" \
          "$STABLE_XTASK" perf bench \
          --suite speed \
          --mode server-tokio-postgres-simple \
          --speed-source "$SPEED_SOURCE"
      else
        echo "Skipping repeats/stable-wasix-server-tokio-speed-$index: stable xtask does not expose server tokio simple speed mode."
      fi
    fi
  done
fi

node "$SCRIPT_DIR/summarize_native_libpglite_matrix.mjs" \
  --run-dir "$RUN_DIR" \
  --run-id "$RUN_ID" \
  --postgres-version "$("$POSTGRES_BIN" --version)" \
  --speed-repeats "$SPEED_REPEATS" \
  --speed-source "$SPEED_SOURCE" \
  --current-runtime-kind "${CURRENT_WASIX_RUNTIME_KIND:-}" \
  --stable-worktree "${STABLE_WORKTREE:-}" \
  --stable-branch "${STABLE_BRANCH:-}" \
  --stable-revision "${STABLE_REVISION:-}" \
  --stable-dirty "${STABLE_DIRTY:-0}" \
  > "$RUN_DIR/report.md"

echo "$RUN_DIR/report.md"
