#!/usr/bin/env bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
export OLIPHAUNT_EXTENSION_TARGET=android-arm64-v8a
export OLIPHAUNT_EXTENSION_PRODUCTS=oliphaunt-extension-pgtap
export OLIPHAUNT_EXTENSION_HOST_RUNTIME_ROOT="$scratch/host"
export OLIPHAUNT_MOBILE_EXTENSION_WORK_ROOT="$scratch/mobile"
export OLIPHAUNT_EXTENSION_RELEASE_ASSET_DIR="$scratch/assets"
export OLIPHAUNT_EXTENSION_RELEASE_STAGE_ROOT="$scratch/stage"
producer=src/extensions/artifacts/native/tools/package-release-assets.sh
sql="$scratch/host/share/postgresql/extension"
mkdir -p "$sql"
bun - "$scratch/host/postgres" <<'JS'
import {writeFileSync} from 'node:fs';
import {elfFixture} from './tools/packaging/testdata/release-fixture-utils.mts';
writeFileSync(process.argv[2], elfFixture({machine: 62, requiredVersions: ['GLIBC_2.17']}));
JS
printf "default_version = '1.3.5'\n" > "$sql/pgtap.control"
printf 'select 1;\n' > "$sql/pgtap--1.3.5.sql"
# SQL-only selection has a valid empty transfer and needs neither compiler.
OLIPHAUNT_EXTENSION_PHASE=android-static bash "$producer"
[ -d "$scratch/mobile/android-arm64-v8a/android-arm64/out" ]
OLIPHAUNT_EXTENSION_PHASE=android-package bash "$producer"
[ "$(find "$scratch/assets" -name '*-pgtap-*-runtime.tar.gz' | wc -l)" = 1 ]
# A package-only invocation must fail on missing inputs, never rebuild them.
if OLIPHAUNT_EXTENSION_PHASE=android-package OLIPHAUNT_EXTENSION_PRODUCTS=oliphaunt-extension-vector \
  bash "$producer" > "$scratch/missing-static.log" 2>&1; then
  echo 'accepted missing static archive' >&2; exit 1
fi
grep -Eq 'no ELF binaries|missing Android static archive for vector' "$scratch/missing-static.log"
rm -rf "$scratch/host"
if OLIPHAUNT_EXTENSION_PHASE=android-package bash "$producer" > "$scratch/missing-host.log" 2>&1; then
  echo 'accepted missing Linux support' >&2; exit 1
fi
grep -q 'missing mobile host extension runtime' "$scratch/missing-host.log"
if OLIPHAUNT_EXTENSION_PHASE=android-package OLIPHAUNT_EXTENSION_TARGET=ios-xcframework \
  bash "$producer" > "$scratch/wrong-phase.log" 2>&1; then
  echo 'accepted Android phase for iOS' >&2; exit 1
fi
grep -q 'invalid extension phase' "$scratch/wrong-phase.log"
echo 'Android split extension producer checks passed'
