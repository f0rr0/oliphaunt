#!/usr/bin/env bash
set -euo pipefail
root="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
fixture="$(mktemp -d)"
trap 'rm -rf "$fixture"' EXIT
owner=src/wasix/runtime/assets/build
mkdir -p "$fixture/$owner/wasix_shim" "$fixture/src/wasix/runtime/postgres" \
  "$fixture/src/third-party/postgres" "$fixture/tools/dev" "$fixture/bin" \
  "$fixture/archive/postgresql-18.4/src/include/port/wasix-dl" "$fixture/cache"
git -C "$fixture" init -q
cp "$root/$owner/"{prepare_postgres_source.sh,source_lane.sh,wasix_third_party.sh} "$fixture/$owner/"
cp "$root/src/third-party/postgres/"{fetch-source.sh,apply-series.sh} "$fixture/src/third-party/postgres/"
cp "$root/tools/dev/acquisition.sh" "$fixture/tools/dev/"
printf 'contract-v1\n' > "$fixture/$owner/wasix_shim/oliphaunt_wasix_protocol_contract.generated.h"
printf '%s\n' "$owner/wasix_shim/oliphaunt_wasix_protocol_contract.generated.h" \
  > "$fixture/src/wasix/runtime/postgres/source-inputs"
touch "$fixture/src/wasix/runtime/postgres/series"
tar -cjf "$fixture/cache/postgresql-18.4.tar.bz2" -C "$fixture/archive" postgresql-18.4
archive_sha="$(shasum -a 256 "$fixture/cache/postgresql-18.4.tar.bz2" | awk '{print $1}')"
printf 'version = "18.4"\nurl = "https://example.invalid/postgresql-18.4.tar.bz2"\nsha256 = "%s"\n' \
  "$archive_sha" > "$fixture/src/third-party/postgres/source.toml"
export SOURCE_CACHE="$fixture/cache" OLIPHAUNT_WASM_GENERATED_ROOT="$fixture/generated"
unset OLIPHAUNT_WASM_POSTGRES_WORK_ROOT
export REAL_INSTALL="$(command -v install)" INSTALL_LOG="$fixture/install.log"
cat > "$fixture/bin/install" <<'INSTALL'
#!/usr/bin/env bash
set -euo pipefail
destination="${@: -1}"
# A published header must be read-only on a hit and replaced atomically on repair.
if [[ "$destination" == */oliphaunt_wasix_protocol_contract.generated.h && -e "$destination" ]]; then
  echo 'attempted in-place rewrite of a published header' >&2
  exit 17
fi
printf '%s\n' "$destination" >> "$INSTALL_LOG"
if [[ "${FAIL_INSTALL:-0}" == 1 ]]; then
  printf 'partial\n' > "$destination"
  exit 23
fi
"$REAL_INSTALL" "$@"
INSTALL
chmod +x "$fixture/bin/install"
export PATH="$fixture/bin:$PATH"
script="$fixture/$owner/prepare_postgres_source.sh"
prepared="$(bash "$script")"
header="$prepared/src/include/port/wasix-dl/oliphaunt_wasix_protocol_contract.generated.h"
contract="$fixture/$owner/wasix_shim/oliphaunt_wasix_protocol_contract.generated.h"
cmp "$contract" "$header"
: > "$INSTALL_LOG"
prepare_concurrently() {
  local pids=() index status=0
  for index in 1 2 3 4 5 6 7 8; do
    bash "$script" > "$fixture/result-$index" &
    pids+=("$!")
  done
  for index in "${pids[@]}"; do wait "$index" || status=$?; done
  [[ "$status" == 0 ]] || return "$status"
  for index in 1 2 3 4 5 6 7 8; do
    [[ "$(cat "$fixture/result-$index")" == "$prepared" ]]
  done
  cmp "$contract" "$header"
}
prepare_concurrently
[[ ! -s "$INSTALL_LOG" ]]
printf 'corrupt\n' > "$header"
status=0
FAIL_INSTALL=1 bash "$script" > "$fixture/repair-failure.out" || status=$?
[[ "$status" == 23 && ! -s "$fixture/repair-failure.out" ]]
[[ "$(cat "$header")" == corrupt ]]
[[ -z "$(find "$(dirname "$header")" -name 'oliphaunt_wasix_protocol_contract.generated.h.*' -print)" ]]
prepare_concurrently
[[ -s "$INSTALL_LOG" ]]
rm "$header"
[[ "$(bash "$script")" == "$prepared" ]]
cmp "$contract" "$header"
# A changed contract is a source-input change, so the old tree is replaced.
printf 'contract-v2\n' > "$contract"
printf 'stale\n' > "$prepared/stale"
[[ "$(bash "$script")" == "$prepared" ]]
[[ ! -e "$prepared/stale" ]]
cmp "$contract" "$header"
# The Docker adapter must return the preparer's failure, preserving its error.
printf '#!/usr/bin/env bash\necho preparation-failed >&2\nexit 42\n' > "$script"
chmod +x "$script"
status=0
ROOT="$fixture/$owner" REPO_ROOT="$fixture" bash -c \
  'source "$ROOT/source_lane.sh"; oliphaunt_wasix_prepare_source_for_docker stable' \
  > "$fixture/failure.out" 2> "$fixture/failure.err" || status=$?
[[ "$status" == 42 && ! -s "$fixture/failure.out" ]]
[[ "$(cat "$fixture/failure.err")" == preparation-failed ]]
echo 'Parallel prepared-source reuse, atomic header repair, invalidation and failure propagation passed.'
