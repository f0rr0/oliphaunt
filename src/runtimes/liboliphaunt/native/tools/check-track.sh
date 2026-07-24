#!/usr/bin/env sh
set -eu

mode="${1:-quick}"

root="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "must run inside the Oliphaunt git checkout" >&2
  exit 1
}
cd "$root"

. "$root/tools/runtime/preflight.sh"

work_root="$(oliphaunt_runtime_native_host_work_root)"
default_liboliphaunt="$(oliphaunt_runtime_native_host_default_lib)"
default_initdb="$(oliphaunt_runtime_native_host_default_initdb)"
default_postgres="$(oliphaunt_runtime_native_host_default_postgres)"
default_install_dir="$(oliphaunt_runtime_native_host_default_install_dir)"
build_policy="${OLIPHAUNT_TRACK_BUILD:-missing}"

run() {
  printf '\n==> %s\n' "$*"
  "$@"
}

native_runtime_lock() {
  run tools/dev/bun.sh tools/runtime/with-native-runtime-lock.mjs "$@"
}

require() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "missing required command: $1" >&2
    exit 1
  fi
}

run_native_backlog_guard() {
  run src/runtimes/liboliphaunt/native/tools/check-patch-stack.mjs --check
  if ! grep -Fq "Native Product Backlog" docs/internal/TODO.md; then
    echo "docs/internal/TODO.md must track the native product backlog" >&2
    exit 1
  fi
  if ! grep -Fq "Benchmarks release claims" docs/internal/TODO.md &&
    ! grep -Fq "Make Benchmarks Release-Grade" docs/internal/TODO.md; then
    echo "docs/internal/TODO.md must keep native benchmark release work visible" >&2
    exit 1
  fi
  if grep -Eiq -- 'route native product work back to WASIX|WASIX fallback|--skip-wasix|Wasmer' docs/internal/TODO.md; then
    echo "docs/internal/TODO.md must not route native product work back to the legacy runtime lane" >&2
    exit 1
  fi
}

runtime_ready() {
  [ -f "${LIBOLIPHAUNT_PATH:-$default_liboliphaunt}" ] &&
    [ -x "${OLIPHAUNT_INITDB:-$default_initdb}" ] &&
    [ -x "${OLIPHAUNT_POSTGRES:-$default_postgres}" ] &&
    [ -d "${OLIPHAUNT_INSTALL_DIR:-$default_install_dir}" ]
}

liboliphaunt_current() {
  if [ "${OLIPHAUNT_TRACK_SKIP_CURRENT_GUARD:-0}" = "1" ]; then
    return 0
  fi
  case "$(uname -s)" in
    Darwin)
      src/runtimes/liboliphaunt/native/bin/build-postgres18-macos.sh --check-oliphaunt-current >/dev/null
      ;;
    Linux)
      src/runtimes/liboliphaunt/native/bin/build-postgres18-linux.sh --check-current >/dev/null
      ;;
    MINGW* | MSYS* | CYGWIN*)
      pwsh -NoProfile -ExecutionPolicy Bypass -File src/runtimes/liboliphaunt/native/bin/build-postgres18-windows.ps1 -CheckCurrent >/dev/null
      ;;
    *)
      return 1
      ;;
  esac
}

host_supports_extension_artifacts() {
  [ "$(uname -s)" = "Darwin" ]
}

host_build_runtime() {
  case "$(uname -s)" in
    Darwin)
      env OLIPHAUNT_BUILD_EXTENSIONS="$OLIPHAUNT_BUILD_EXTENSIONS" \
        src/runtimes/liboliphaunt/native/bin/build-postgres18-macos.sh
      ;;
    Linux)
      src/runtimes/liboliphaunt/native/bin/build-postgres18-linux.sh
      ;;
    MINGW* | MSYS* | CYGWIN*)
      pwsh -NoProfile -ExecutionPolicy Bypass -File src/runtimes/liboliphaunt/native/bin/build-postgres18-windows.ps1
      ;;
    *)
      echo "native liboliphaunt validation is unsupported on $(uname -s)" >&2
      return 2
      ;;
  esac
}

requires_extension_artifacts() {
  case "$mode" in
    extensions|full)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

extension_sql_ready() {
  extension="$1"
  extension_dir="${OLIPHAUNT_INSTALL_DIR:-$default_install_dir}/share/postgresql/extension"
  [ -f "$extension_dir/$extension.control" ] || return 1
  ls "$extension_dir/$extension"--*.sql >/dev/null 2>&1
}

extension_artifacts_ready() {
  install_dir="${OLIPHAUNT_INSTALL_DIR:-$default_install_dir}"
  out_dir="$(dirname "${LIBOLIPHAUNT_PATH:-$default_liboliphaunt}")"
  [ -f "$out_dir/native-extension-artifacts.sha256" ] || return 1

  required_artifacts="$(src/runtimes/liboliphaunt/native/bin/build-postgres18-macos.sh --print-required-extension-artifacts)"
  for artifact in $required_artifacts; do
    kind="${artifact%%:*}"
    name="${artifact#*:}"
    case "$kind" in
      control)
        extension_sql_ready "$name" || return 1
        ;;
      module)
        [ -f "$install_dir/lib/postgresql/$name.dylib" ] || return 1
        [ -f "$out_dir/modules/$name.dylib" ] || return 1
        ;;
      *)
        echo "unknown native extension artifact kind from build script: $artifact" >&2
        return 1
        ;;
    esac
  done
}

export_default_runtime() {
  export LIBOLIPHAUNT_PATH="${LIBOLIPHAUNT_PATH:-$default_liboliphaunt}"
  export OLIPHAUNT_INITDB="${OLIPHAUNT_INITDB:-$default_initdb}"
  export OLIPHAUNT_POSTGRES="${OLIPHAUNT_POSTGRES:-$default_postgres}"
  export OLIPHAUNT_INSTALL_DIR="${OLIPHAUNT_INSTALL_DIR:-$default_install_dir}"
}

ensure_native_runtime() {
  case "$(uname -s)" in
    Darwin | Linux | MINGW* | MSYS* | CYGWIN*)
      ;;
    *)
      if [ -n "${OLIPHAUNT_REQUIRE_NATIVE:-}" ]; then
        echo "native liboliphaunt validation is unsupported on $(uname -s)" >&2
        exit 1
      fi
      echo "warning: skipping native runtime checks on unsupported host $(uname -s)" >&2
      return 1
      ;;
  esac

  export_default_runtime

  if requires_extension_artifacts; then
    if ! host_supports_extension_artifacts; then
      echo "native extension artifact validation currently requires Darwin host tooling" >&2
      return 1
    fi
    export OLIPHAUNT_BUILD_EXTENSIONS="${OLIPHAUNT_BUILD_EXTENSIONS:-1}"
  else
    export OLIPHAUNT_BUILD_EXTENSIONS="${OLIPHAUNT_BUILD_EXTENSIONS:-0}"
  fi

  case "$build_policy" in
    always)
      run host_build_runtime
      ;;
    missing)
      if ! runtime_ready; then
        run host_build_runtime
      elif ! liboliphaunt_current; then
        echo "refreshing stale native liboliphaunt runtime through fingerprinted build script"
        run host_build_runtime
      elif requires_extension_artifacts; then
        if src/runtimes/liboliphaunt/native/bin/build-postgres18-macos.sh --check-extension-artifacts-current >/dev/null; then
          echo "reusing current native extension artifacts at $work_root"
        else
          echo "refreshing native extension artifacts through fingerprinted build script"
          run host_build_runtime
        fi
      else
        echo "reusing native Oliphaunt runtime at $work_root"
      fi
      ;;
    never)
      if ! liboliphaunt_current; then
        cat >&2 <<MSG
native Oliphaunt runtime is missing or stale for the current C ABI sources.

Run:
  OLIPHAUNT_TRACK_BUILD=missing src/runtimes/liboliphaunt/native/tools/check-track.sh $mode
MSG
        exit 1
      fi
      echo "using existing native Oliphaunt runtime at $work_root"
      ;;
    *)
      echo "OLIPHAUNT_TRACK_BUILD must be one of: missing, never, always" >&2
      exit 2
      ;;
  esac

  export_default_runtime
  if ! runtime_ready; then
    cat >&2 <<MSG
missing native Oliphaunt runtime artifacts.

Expected:
  LIBOLIPHAUNT_PATH=$LIBOLIPHAUNT_PATH
  OLIPHAUNT_INITDB=$OLIPHAUNT_INITDB
  OLIPHAUNT_POSTGRES=$OLIPHAUNT_POSTGRES
  OLIPHAUNT_INSTALL_DIR=$OLIPHAUNT_INSTALL_DIR

Run:
  OLIPHAUNT_TRACK_BUILD=always src/runtimes/liboliphaunt/native/tools/check-track.sh $mode
MSG
    exit 1
  fi
  if requires_extension_artifacts && ! extension_artifacts_ready; then
    cat >&2 <<MSG
missing native extension artifacts for the liboliphaunt extension matrix.

Expected every required extension artifact from:
  src/runtimes/liboliphaunt/native/bin/build-postgres18-macos.sh --print-required-extension-artifacts

Artifact roots:
  ${OLIPHAUNT_INSTALL_DIR:-$default_install_dir}/share/postgresql/extension
  ${OLIPHAUNT_INSTALL_DIR:-$default_install_dir}/lib/postgresql
  $(dirname "${LIBOLIPHAUNT_PATH:-$default_liboliphaunt}")/modules

Run:
  OLIPHAUNT_TRACK_BUILD=missing src/runtimes/liboliphaunt/native/tools/check-track.sh $mode
MSG
    exit 1
  fi
}

run_native_smoke() {
  ensure_native_runtime || return 0
  native_runtime_lock node src/runtimes/liboliphaunt/native/tools/run-host-c-smoke.mjs
}

run_rust_quick() {
  require cargo
  native_runtime_lock cargo test -p oliphaunt --locked \
    --lib \
    --test sdk_shape \
    --test native_root_locking \
    --test native_sql_regression \
    -- \
    --test-threads=1
}

run_perf_harness_guard() {
  if [ "${OLIPHAUNT_TRACK_SKIP_HARNESS_GUARD:-0}" = "1" ]; then
    echo "skipping native harness guard because OLIPHAUNT_TRACK_SKIP_HARNESS_GUARD=1"
    return 0
  fi
  run tools/perf/check-native-perf-harness.sh
}

run_external_extension_pin_guard() {
  run src/runtimes/liboliphaunt/native/bin/check-external-extension-pins.sh
}

run_rust_sdk() {
  run src/sdks/rust/tools/check-sdk.sh
}

run_rust_extensions() {
  require cargo
  ensure_native_runtime || return 0
  export OLIPHAUNT_EXTENSION_MATRIX=1
  native_runtime_lock cargo test -p oliphaunt --test native_extensions --locked -- --test-threads=1
}

run_sdks() {
  run tools/policy/check-sdk-parity.sh
  run_rust_sdk
  run src/sdks/swift/tools/check-sdk.sh
  run src/sdks/kotlin/tools/check-sdk.sh
  run src/sdks/react-native/tools/check-sdk.sh
}

run_external_extension_pin_guard

run_native_backlog_guard

case "$mode" in
  host-smoke)
    run_native_smoke
    ;;
  quick)
    run_perf_harness_guard
    run_native_smoke
    run_rust_quick
    ;;
  rust)
    run_perf_harness_guard
    ensure_native_runtime || true
    run_rust_quick
    ;;
  extensions)
    run_perf_harness_guard
    run_native_smoke
    run_rust_quick
    run_rust_extensions
    ;;
  sdks)
    run_perf_harness_guard
    ensure_native_runtime || true
    run_sdks
    ;;
  external-pgrx)
    run src/runtimes/liboliphaunt/native/bin/build-external-pgrx-extensions-macos.sh --check-current
    ;;
  full)
    run_perf_harness_guard
    run_native_smoke
    run_rust_quick
    run_rust_extensions
    run_sdks
    ;;
  *)
    cat >&2 <<'MSG'
usage: src/runtimes/liboliphaunt/native/tools/check-track.sh [host-smoke|quick|rust|extensions|sdks|external-pgrx|full]

Modes:
  host-smoke  reuse existing native runtime and run the host C ABI smoke only
  quick       reuse/build missing native runtime, run C smoke and Rust native SDK tests
  rust        run Rust oliphaunt tests without forcing native runtime smoke
  extensions  quick plus the native extension matrix with extension artifacts enabled
  sdks        Rust, Swift, Kotlin, and React Native SDK package checks
  external-pgrx
              prove opt-in pgrx extension artifacts are current
  full        extensions plus SDK checks

Set OLIPHAUNT_TRACK_BUILD=never to fail fast if native artifacts are missing,
missing to build only when absent, or always for a deliberate rebuild.
MSG
    exit 2
    ;;
esac
