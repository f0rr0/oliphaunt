#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../.."
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
guard() (
  source runtimes/liboliphaunt-native/tools/liboliphaunt-extension-guard.sh
  oliphaunt_assert_base_embedded_modules_exact "$scratch/modules" so
)
reject() {
  if guard > "$scratch/rejected.log" 2>&1; then
    echo 'Invalid embedded module inventory was accepted' >&2; exit 1
  fi
}
reject
mkdir "$scratch/modules"
printf snowball > "$scratch/modules/dict_snowball.so"
reject
printf plpgsql > "$scratch/modules/plpgsql.so"
guard
printf stale > "$scratch/modules/.stale-extension.so"
reject
rm "$scratch/modules/.stale-extension.so"
printf linked > "$scratch/outside.so"
for module in plpgsql dict_snowball; do
  rm "$scratch/modules/$module.so"
  ln -s "$scratch/outside.so" "$scratch/modules/$module.so"
  reject
  rm "$scratch/modules/$module.so"
  printf regular > "$scratch/modules/$module.so"
done

bun runtimes/liboliphaunt-native/tools/liboliphaunt-extension-guard.fixture.mts "$scratch/payload"
bun runtimes/liboliphaunt-native/tools/native-runtime-payload.mts "$scratch/payload" --target linux-x64-gnu --tool-set runtime
rm "$scratch/payload/runtime/share/postgresql/tsearch_data/english.stop"
if bun runtimes/liboliphaunt-native/tools/native-runtime-payload.mts "$scratch/payload" \
  --target linux-x64-gnu --tool-set runtime --check > "$scratch/payload.log" 2>&1; then
  echo 'Incomplete Snowball runtime data was accepted' >&2; exit 1
fi
grep -Eq 'missing required core runtime file .*english[.]stop' "$scratch/payload.log"
echo 'Embedded module inventory and Snowball resource validation passed'
