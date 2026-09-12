#!/usr/bin/env bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
bun test ./extensions/artifacts/native/tools/ios-extension-registration.test.mts
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
cat > "$scratch/extension.c" <<'C'
void oliphaunt_static_sample_Pg_magic_func(void) {}
void sample_sql(void) {}
C
cc -c "$scratch/extension.c" -o "$scratch/extension.o"
for slice in simulator device macos; do
  mkdir -p "$scratch/$slice/extensions/sample"
  printf '%s\n' "$scratch/extension.o" > "$scratch/$slice/extensions/sample/objects.list"
  printf 'sample_sql\n' > "$scratch/$slice/extensions/sample/symbols.list"
done
args=(--sql-name sample --native-module-stem sample --simulator-out "$scratch/simulator" --device-out "$scratch/device" --macos-out "$scratch/macos" --output "$scratch/registration.json")
bash extensions/artifacts/native/tools/ios-extension-registration.sh "${args[@]}"
bun -e 'import assert from "node:assert/strict"; const value=await Bun.file(process.argv[1]).json(); assert.deepEqual(value.symbols,[{name:"sample_sql",address:"sample_sql"}])' "$scratch/registration.json"
cp "$scratch/registration.json" "$scratch/before.json"
printf 'missing_sql\n' > "$scratch/device/extensions/sample/symbols.list"
if bash extensions/artifacts/native/tools/ios-extension-registration.sh "${args[@]}" > "$scratch/invalid.log" 2>&1; then
  echo 'Registration accepted an undefined symbol' >&2
  exit 1
fi
grep -q 'not defined.*missing_sql' "$scratch/invalid.log"
cmp "$scratch/before.json" "$scratch/registration.json"
echo 'Compiled registration and failed-slice atomic output checks passed'
