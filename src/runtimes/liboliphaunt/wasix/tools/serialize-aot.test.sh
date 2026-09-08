#!/usr/bin/env bash
set -euo pipefail
script="$(git rev-parse --show-toplevel)/src/runtimes/liboliphaunt/wasix/tools/serialize-aot.sh"
fixture="$(mktemp -d)"
trap 'rm -rf "$fixture"' EXIT
export AOT_FIXTURE_ROOT="$fixture"
export CARGO_TARGET_DIR="$fixture/compiler output"
mkdir -p "$fixture/bin" "$CARGO_TARGET_DIR/release"
cat >"$fixture/bin/git" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$AOT_FIXTURE_ROOT"
SH
cat >"$fixture/bin/uname" <<'SH'
#!/usr/bin/env bash
printf 'Linux\n'
SH
cat >"$fixture/bin/cargo" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == build ]]; then exit "${FAIL_BUILD:-0}"; fi
[[ "$*" == 'run -p xtask --locked -- assets prepare-aot --target-triple fixture' ]]
printf 'input one.wasm\toutput one.zst\ninput two.wasm\toutput two.zst\n'
SH
cat >"$CARGO_TARGET_DIR/release/xtask" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
[[ "$#" == 6 && "$1 $2 $3 $5" == 'aot-serializer serialize --input --output' ]]
printf '%s\t%s\n' "$4" "$6" >> "$AOT_FIXTURE_ROOT/serialized"
exit "${FAIL_SERIALIZE:-0}"
SH
chmod +x "$fixture/bin/"* "$CARGO_TARGET_DIR/release/xtask"
export PATH="$fixture/bin:$PATH"
bash "$script" --target-triple fixture
printf 'input one.wasm\toutput one.zst\ninput two.wasm\toutput two.zst\n' >"$fixture/expected"
cmp "$fixture/expected" "$fixture/serialized"
rm "$fixture/serialized"
if FAIL_BUILD=1 bash "$script" --target-triple fixture; then exit 1; fi
[[ ! -e "$fixture/serialized" ]]
if FAIL_SERIALIZE=1 bash "$script" --target-triple fixture; then exit 1; fi
[[ "$(wc -l <"$fixture/serialized")" -eq 1 ]]
echo 'AOT Shell dispatch preserves module paths and stops on compiler failures'
