#!/usr/bin/env bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
fixture=extensions/artifacts/native/tools/create-artifact.test.mts
producer=extensions/artifacts/native/tools/create-artifact.sh
sql="$scratch/runtime/share/postgresql/extension"
mkdir -p "$sql"
printf "default_version = '1.3.5'\n" > "$sql/pgtap.control"
for name in pgtap--1.3.5.sql uninstall_pgtap.sql pgtap-core--fixture.sql pgtap-core-evil.control foreign.control; do printf fixture > "$sql/$name"; done
common=(--runtime "$scratch/runtime" --native-target linux-x64-gnu --native-runtime-product liboliphaunt-native --native-runtime-version 1.2.3 --format tar-gz --stage-root "$scratch/stage" --force)
produce() { bash "$producer" "${common[@]}" --sql-name pgtap --output "$scratch/$1.tar.gz" "${@:2}"; }
reject() {
  local pattern="$1"; shift
  if "$@" > "$scratch/rejected.log" 2>&1; then echo 'Invalid artifact was accepted' >&2; exit 1; fi
  grep -Eq -- "$pattern" "$scratch/rejected.log"
}
produce base
bun "$fixture" verify "$scratch" base
printf "default_version = '1.3.4'\n" > "$sql/pgtap.control"
reject 'does not match source-owned catalog version' produce skew
printf "default_version = '1.3.5'\n" > "$sql/pgtap.control"
rm "$sql/pgtap--1.3.5.sql"
for name in pgtap--1.3.3.sql pgtap--1.3.3--1.3.4.sql pgtap--1.3.4--1.3.5.sql; do printf fixture > "$sql/$name"; done
produce chain
bun "$fixture" verify "$scratch" chain
rm "$sql/pgtap--1.3.4--1.3.5.sql"
reject 'has no canonical installation script or update path' produce disconnected
rm "$sql/pgtap--1.3.3.sql" "$sql/pgtap--1.3.3--1.3.4.sql"
printf fixture > "$sql/pgtap--1.3.4--1.3.5.sql"
reject 'control file and canonical base install SQL' produce ancillary
rm "$sql/pgtap--1.3.4--1.3.5.sql"
printf fixture > "$sql/pgtap--release.sql"
reject 'control file and canonical base install SQL' produce letter
rm "$sql/pgtap--release.sql"
printf fixture > "$sql/pgtap--1.3.5.sql"
bun "$fixture" prepare-stream "$scratch"
produce stream --data-files oliphaunt-streaming/a.bin,oliphaunt-streaming/b.bin,oliphaunt-streaming/c.bin
bun "$fixture" verify "$scratch" stream
bun "$fixture" prepare-binaries "$scratch"
printf '#!/usr/bin/env sh\nexit 0\n' > "$scratch/strip"
chmod +x "$scratch/strip"
export OLIPHAUNT_ELF_STRIP="$scratch/strip"
module=(--sql-name auto_explain --creates-extension false --native-module-stem auto_explain --native-module-file auto_explain.so)
bash "$producer" "${common[@]}" "${module[@]}" --embedded-module-root "$scratch/embedded" --output "$scratch/module.tar.gz"
bun "$fixture" verify "$scratch" module
reject 'require --embedded-module-root' bash "$producer" "${common[@]}" "${module[@]}" --output "$scratch/missing.tar.gz"
reject '--embedded-module-root is only valid' produce unexpected --embedded-module-root "$scratch/embedded"
echo 'Actual producer SQL closure, source identity, module profiles and streaming checks passed'
