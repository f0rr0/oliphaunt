#!/usr/bin/env bash
set -euo pipefail
script="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/build-runtime-portable.sh"
fixture="$(mktemp -d)"
trap 'rm -rf "$fixture"' EXIT
git -C "$fixture" init -q
owner=runtimes/liboliphaunt-wasix
mkdir -p "$fixture/$owner/tools" "$fixture/$owner/assets/build" "$fixture/bin"
cp "$script" "$(dirname "$script")/build-compiler-output.sh" "$fixture/$owner/tools/"
touch "$fixture/package.json"
mkdir -p "$fixture/third-party/tools"
printf 'echo verify-sources >> "$BUILD_LOG"\n' > "$fixture/third-party/tools/fetch-sources.sh"
export BUILD_LOG="$fixture/log" DOCKER_CONFIG="$fixture/docker" ASSET_PROFILE=release
export OLIPHAUNT_SKIP_BUILD=0
export PATH="$fixture/bin:$PATH"
cat > "$fixture/bin/cargo" <<'CARGO'
#!/usr/bin/env bash
printf 'cargo %s\n' "$*" >> "$BUILD_LOG"
CARGO
chmod +x "$fixture/bin/"*
for name in prepare_postgres_source docker_oliphaunt docker_runtime_support docker_initdb ; do
  cat > "$fixture/$owner/assets/build/$name.sh" <<'BUILD'
#!/usr/bin/env bash
name="${0##*/}"
printf '%s\n' "${name%.sh}" >> "$BUILD_LOG"
[ "${FAIL_BUILD:-}" != "${name%.sh}" ] || exit 9
BUILD
done
receipt="$fixture/target/oliphaunt-wasix/wasix-build/work/docker-oliphaunt/.oliphaunt-wasix-build-profile"
mkdir -p "$(dirname "$receipt")"
echo profile=release > "$receipt"
bash "$fixture/$owner/tools/build-runtime-portable.sh"
cat > "$fixture/expected" <<'EXPECTED'
verify-sources
prepare_postgres_source
docker_oliphaunt
docker_runtime_support
docker_initdb
cargo run -p xtask -- assets stage-runtime
cargo run -p xtask -- assets package --skip-aot
cargo run -p xtask -- assets check --strict-generated
EXPECTED
diff -u "$fixture/expected" "$BUILD_LOG"
: > "$BUILD_LOG"
if FAIL_BUILD=docker_runtime_support bash "$fixture/$owner/tools/build-runtime-portable.sh"; then exit 1; fi
[ "$(tail -1 "$BUILD_LOG")" = docker_runtime_support ]
: > "$BUILD_LOG"
bash "$fixture/$owner/tools/build-runtime-portable.sh" --package-only
[ "$(wc -l < "$BUILD_LOG" | tr -d ' ')" = 2 ]
[ "$(head -1 "$BUILD_LOG")" = 'cargo run -p xtask -- assets package --skip-aot' ]
: > "$BUILD_LOG"
echo profile=debug > "$receipt"
if OLIPHAUNT_SKIP_BUILD=1 bash "$fixture/$owner/tools/build-runtime-portable.sh"; then exit 1; fi
[ "$(tail -1 "$BUILD_LOG")" = prepare_postgres_source ]
echo 'WASIX build order, core-only selection, failure propagation, and stale-profile refusal passed.'
