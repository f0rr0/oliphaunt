#!/usr/bin/env bash
set -euo pipefail
# Exercise the Linux packaging route with a compiled binary, including a failed pack.
[ "$(uname -s)" = Linux ] && [ "$(uname -m)" = x86_64 ] || exit 0
root="$(git rev-parse --show-toplevel)"
fixture="$(mktemp -d)"
trap 'rm -rf "$fixture"' EXIT
product="$fixture/sdks/ts-wasix/node-addon"
mkdir -p "$product/tools" "$fixture/tools" "$fixture/prebuild"
cp "$root/sdks/ts-wasix/node-addon/tools/package-platform."{sh,mts} "$product/tools/"
cp "$root/sdks/ts-wasix/node-addon/tools/smoke-packaged-addon."{sh,mts} "$product/tools/"
cp "$root/sdks/ts-wasix/node-addon/package.json" "$product/"
ln -s "$root/sdks/ts-wasix/node-addon/packages" "$product/packages"
ln -s "$root/tools/packaging" "$fixture/tools/packaging"
ln -s "$root/tools/dev" "$fixture/tools/dev"
git -C "$fixture" init --quiet
git -C "$fixture" -c user.name=Test -c user.email=test@example.invalid commit --quiet --allow-empty -m fixture
printf 'int oliphaunt_packaging_fixture(void) { return 42; }\n' >"$fixture/binary.c"
cc -shared -fPIC "$fixture/binary.c" -o "$fixture/prebuild/oliphaunt_wasix_napi.node"
cat >"$fixture/inputs.json" <<'JSON'
{"schema":"oliphaunt-wasix-napi-build-inputs-v1","target":"linux-x64-gnu","targetTriple":"x86_64-unknown-linux-gnu","inputs":{"extensionArtifacts":[{"fixture":true}]}}
JSON
bash "$product/tools/package-platform.sh" --target linux-x64-gnu \
  --prebuild-dir "$fixture/prebuild" --build-inputs "$fixture/inputs.json"
output="$fixture/target/oliphaunt-wasix-napi"
tar -xOf "$output"/npm-packages/*.tgz package/prebuilds/oliphaunt_wasix_napi.node >"$fixture/npm.node"
tar -xOf "$output"/release-assets/*.tar.gz oliphaunt_wasix_napi.node >"$fixture/release.node"
cmp "$fixture/prebuild/oliphaunt_wasix_napi.node" "$fixture/npm.node"
cmp "$fixture/npm.node" "$fixture/release.node"
tar -xOf "$output"/npm-packages/*.tgz package/artifact-provenance.json >"$fixture/npm.json"
tar -xOf "$output"/release-assets/*.tar.gz artifact-provenance.json >"$fixture/release.json"
cmp "$fixture/npm.json" "$fixture/release.json"
# This is a real ELF library, but not a Node addon: the clean-install smoke
# must surface the native loader failure and remove its private consumer.
mkdir "$fixture/smoke-temp"
for manager in npm bun; do
  if TMPDIR="$fixture/smoke-temp" bash "$product/tools/smoke-packaged-addon.sh" \
    --target linux-x64-gnu --runtime node --package-manager "$manager" >"$fixture/smoke.log" 2>&1; then
    echo 'smoke accepted a library without a Node-API registration' >&2
    exit 1
  fi
  grep -F 'Module did not self-register' "$fixture/smoke.log" >/dev/null
  [ -z "$(find "$fixture/smoke-temp" -maxdepth 1 -name 'tmp.*' -print -quit)" ]
done
rm -rf "$output/release-assets"
mkdir "$fixture/bin"
OLIPHAUNT_TEST_REAL_BUN="$(command -v bun)"
export OLIPHAUNT_TEST_REAL_BUN
cat >"$fixture/bin/bun" <<'SH'
#!/bin/sh
if [ "$1" = pm ] && [ "$2" = pack ]; then
  exit 23
fi
exec "$OLIPHAUNT_TEST_REAL_BUN" "$@"
SH
chmod +x "$fixture/bin/bun"
if PATH="$fixture/bin:$PATH" bash "$product/tools/package-platform.sh" --target linux-x64-gnu \
  --prebuild-dir "$fixture/prebuild" --build-inputs "$fixture/inputs.json"; then
  echo 'pack failure was ignored' >&2
  exit 1
fi
[ -z "$(ls -A "$output/release-assets")" ]
printf 'WASIX N-API package bytes, provenance, and failed-pack checks passed\n'
