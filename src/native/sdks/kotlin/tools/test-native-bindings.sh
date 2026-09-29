#!/usr/bin/env bash
set -euo pipefail
root="$(git rev-parse --show-toplevel)"
cd "$root"
. src/native/runtime/tools/runtime-preflight.sh
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
cd src/native/sdks/kotlin
export OLIPHAUNT_GRADLE_BUILD_ROOT="${OLIPHAUNT_GRADLE_BUILD_ROOT:-$root/target}"
./gradlew :oliphaunt:testDebugUnitTest --tests dev.oliphaunt.NativeBindingsTest --console=plain "$@"
python3 - <<'CHECK'
import os
from pathlib import Path
from xml.etree import ElementTree
root = Path(os.environ.get("OLIPHAUNT_GRADLE_BUILD_ROOT", "../../../../target"))
report = root / "oliphaunt/test-results/testDebugUnitTest/TEST-dev.oliphaunt.NativeBindingsTest.xml"
suite = ElementTree.parse(report).getroot()
assert int(suite.attrib["tests"]) > 0 and all(int(suite.attrib.get(key, 0)) == 0 for key in ("skipped", "failures", "errors")), "native binding tests must execute and pass"
CHECK
