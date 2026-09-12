#!/usr/bin/env bash
set -euo pipefail
root="$(git rev-parse --show-toplevel)"
cd "$root"
. runtimes/liboliphaunt-native/tools/runtime-preflight.sh
oliphaunt_runtime_native_host_require basic
scratch="$(mktemp -d "${TMPDIR:-/tmp}/oliphaunt-kotlin-native.XXXXXX")"
trap 'rm -rf "$scratch"' EXIT
export LIBOLIPHAUNT_PATH="$(oliphaunt_runtime_native_host_lib)"
export OLIPHAUNT_INSTALL_DIR="$(oliphaunt_runtime_native_host_install_dir)"
export OLIPHAUNT_EMBEDDED_MODULE_DIR="${OLIPHAUNT_EMBEDDED_MODULE_DIR:-$(oliphaunt_runtime_native_host_work_root)/out/modules}"
export OLIPHAUNT_MOBILE_BINDINGS_DIR="${CARGO_TARGET_DIR:-$root/target}/debug"
export OLIPHAUNT_MOBILE_TEST_PGDATA="$scratch/pgdata"
OLIPHAUNT_INTERNAL_SKIP_ICU_DISCOVERY=1 "$(oliphaunt_runtime_native_host_initdb)" \
  -D "$OLIPHAUNT_MOBILE_TEST_PGDATA" -U postgres --locale=C --encoding=UTF8 --auth=trust
cd sdks/kotlin
./gradlew :oliphaunt:testDebugUnitTest --tests dev.oliphaunt.NativeBindingsTest --console=plain
