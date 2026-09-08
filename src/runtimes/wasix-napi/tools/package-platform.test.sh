#!/usr/bin/env bash
set -euo pipefail
# Exercise the Linux packaging route with a compiled binary, including a failed pack.
[ "$(uname -s)" = Linux ] && [ "$(uname -m)" = x86_64 ] || exit 0
root="$(git rev-parse --show-toplevel)"
fixture="$(mktemp -d)"
trap 'rm -rf "$fixture"' EXIT
product="$fixture/src/runtimes/wasix-napi"
mkdir -p "$product/tools" "$fixture/src" "$fixture/tools" "$fixture/prebuild"
cp "$root/src/runtimes/wasix-napi/tools/package-platform."{sh,mts} "$product/tools/"
cp "$root/src/runtimes/wasix-napi/tools/smoke-packaged-addon."{sh,mts} "$product/tools/"
cp "$root/src/runtimes/wasix-napi/package.json" "$product/"
ln -s "$root/src/runtimes/wasix-napi/packages" "$product/packages"
ln -s "$root/src/shared" "$fixture/src/shared"
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
if TMPDIR="$fixture/smoke-temp" bash "$product/tools/smoke-packaged-addon.sh" \
  --target linux-x64-gnu --runtime node --package-manager npm > "$fixture/smoke.log" 2>&1; then
  echo 'smoke accepted a library without a Node-API registration' >&2
  exit 1
fi
grep -F 'Module did not self-register' "$fixture/smoke.log" >/dev/null
[ -z "$(find "$fixture/smoke-temp" -maxdepth 1 -name 'tmp.*' -print -quit)" ]
rm -rf "$output/release-assets"
mkdir "$fixture/bin"
printf '#!/bin/sh\nexit 23\n' >"$fixture/bin/pnpm"
chmod +x "$fixture/bin/pnpm"
if PATH="$fixture/bin:$PATH" bash "$product/tools/package-platform.sh" --target linux-x64-gnu \
  --prebuild-dir "$fixture/prebuild" --build-inputs "$fixture/inputs.json"; then
  echo 'pack failure was ignored' >&2
  exit 1
fi
[ -z "$(ls -A "$output/release-assets")" ]
printf 'WASIX N-API package bytes, provenance, and failed-pack checks passed\n'
