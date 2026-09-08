#!/usr/bin/env bash
set -euo pipefail
script="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/build-runtime-portable.sh"
fixture="$(mktemp -d)"
trap 'rm -rf "$fixture"' EXIT
git -C "$fixture" init -q
owner=src/runtimes/liboliphaunt/wasix
mkdir -p "$fixture/$owner/tools" "$fixture/$owner/assets/build" "$fixture/bin"
cp "$script" "$fixture/$owner/tools/"
touch "$fixture/package.json"
mkdir -p "$fixture/src/sources/tools"
printf 'echo verify-sources >> "$BUILD_LOG"\n' > "$fixture/src/sources/tools/fetch-sources.sh"
export BUILD_LOG="$fixture/log" DOCKER_CONFIG="$fixture/docker" ASSET_PROFILE=release
export OLIPHAUNT_SKIP_BUILD=0 OLIPHAUNT_WASM_SKIP_EXTENSIONS_FOR_PERF=0
export PATH="$fixture/bin:$PATH"
cat > "$fixture/bin/bun" <<'BUN'
#!/usr/bin/env bash
set -e
case "$1" in
  *extension-build-scripts.mts) echo 'extension.sh' ;;
  *) exit 1 ;;
esac
BUN
cat > "$fixture/bin/cargo" <<'CARGO'
#!/usr/bin/env bash
printf 'cargo %s\n' "$*" >> "$BUILD_LOG"
CARGO
chmod +x "$fixture/bin/"*
for name in prepare_postgres_source docker_oliphaunt docker_runtime_support docker_initdb docker_pgxs_extensions docker_contrib_extensions docker_pgdump docker_psql; do
  cat > "$fixture/$owner/assets/build/$name.sh" <<'BUILD'
#!/usr/bin/env bash
name="${0##*/}"
printf '%s\n' "${name%.sh}" >> "$BUILD_LOG"
[ "${FAIL_BUILD:-}" != "${name%.sh}" ] || exit 9
BUILD
done
printf 'echo extension >> "$BUILD_LOG"\n' > "$fixture/extension.sh"
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
docker_pgxs_extensions
docker_contrib_extensions
extension
docker_pgdump
docker_psql
cargo run -p xtask --features cluster-seed-runner -- assets package --skip-aot
cargo run -p xtask -- assets check --strict-generated
EXPECTED
diff -u "$fixture/expected" "$BUILD_LOG"
: > "$BUILD_LOG"
if FAIL_BUILD=docker_runtime_support bash "$fixture/$owner/tools/build-runtime-portable.sh"; then exit 1; fi
[ "$(tail -1 "$BUILD_LOG")" = docker_runtime_support ]
: > "$BUILD_LOG"
OLIPHAUNT_WASM_SKIP_EXTENSIONS_FOR_PERF=1 bash "$fixture/$owner/tools/build-runtime-portable.sh"
[ "$(wc -l < "$BUILD_LOG" | tr -d ' ')" = 7 ]
: > "$BUILD_LOG"
echo profile=debug > "$receipt"
if OLIPHAUNT_SKIP_BUILD=1 bash "$fixture/$owner/tools/build-runtime-portable.sh"; then exit 1; fi
[ "$(tail -1 "$BUILD_LOG")" = prepare_postgres_source ]
echo 'WASIX build order, core-only selection, failure propagation, and stale-profile refusal passed.'
