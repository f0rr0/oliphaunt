#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
scratch=$(mktemp -d "${TMPDIR:-/tmp}/wasix-download-XXXXXX")
trap 'rm -rf "$scratch"' EXIT
mkdir "$scratch/bin"
TEST_REAL_BASH=$(command -v bash)
export TEST_REAL_BASH
for name in "${!GITHUB_@}" "${!GH_@}" "${!ACTIONS_@}" "${!OLIPHAUNT_GITHUB_@}" "${!OLIPHAUNT_RELEASE_@}" "${!RELEASE_@}"; do
  [ -z "$name" ] || unset "$name"
done
unset CI_RUN_ID BOOTSTRAP_LEDGER_PATH OLIPHAUNT_REQUIRE_GITHUB_CORE_REQUEST_JOURNAL
export GITHUB_TOKEN=fixture-token GH_REPO=fixture/oliphaunt
export RELEASE_ARTIFACT_SHA=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
export RELEASE_HEAD_SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
cat > "$scratch/bin/cargo" <<'SH'
#!/usr/bin/env bash
printf '%s\n' cargo "$@" >> "$CAPTURE_PATH"
SH
printf '#!%s\n' "$TEST_REAL_BASH" > "$scratch/bin/bash"
cat >> "$scratch/bin/bash" <<'SH'
if [ "$1" = .github/scripts/download-build-artifacts.sh ]; then
  printf '%s\n' bash "$@" >> "$CAPTURE_PATH"
  exit "${DOWNLOAD_FAILURE:-0}"
fi
exec "$TEST_REAL_BASH" "$@"
SH
cat > "$scratch/bin/gh" <<'SH'
#!/usr/bin/env bash
printf '%s\n' gh "$@" >> "$CAPTURE_PATH"
echo 777
SH
cat > "$scratch/bin/curl" <<'SH'
#!/usr/bin/env bash
set -eu
url= output=
while [ "$#" -gt 0 ]; do
  case "$1" in --output) output="$2"; shift;; https://*) url="$1";; esac
  shift
done
case "$url" in
  *sha256)
    digest=$(printf payload | shasum -a 256); digest="${digest%% *}"
    [ "${CORRUPT:-0}" = 0 ] || digest=0000000000000000000000000000000000000000000000000000000000000000
    for target in portable $AOT_TARGETS; do
      printf '%s  liboliphaunt-wasix-1.0.0-runtime-%s.tar.zst\n' "$digest" "$target"
    done > "$output";;
  *) printf payload > "$output";;
esac
SH
chmod +x "$scratch/bin/"*
export PATH="$scratch/bin:$PATH" CAPTURE_PATH="$scratch/commands"
AOT_TARGETS=$(bun tools/release/download-wasix-runtime-build-artifacts.test.mts targets | sed 's/^/aot-/')
export AOT_TARGETS
for mode in frozen selected failed public corrupt; do
  : > "$CAPTURE_PATH"
  unset CI_RUN_ID DOWNLOAD_FAILURE CORRUPT
  case "$mode" in
    frozen) export CI_RUN_ID=30358387218;;
    failed) export CI_RUN_ID=77 DOWNLOAD_FAILURE=17;;
    corrupt) export CORRUPT=1;;
  esac
  status=0
  if [[ "$mode" = public || "$mode" = corrupt ]]; then
    bash runtimes/liboliphaunt-wasix/tools/download-assets.sh --release liboliphaunt-wasix-v1.0.0 --all-targets > "$scratch/log" 2>&1 || status=$?
  else
    bash .github/scripts/download-wasix-runtime-build-artifacts.sh > "$scratch/log" 2>&1 || status=$?
  fi
  case "$mode" in
    failed) test "$status" = 17;;
    corrupt) test "$status" != 0; mode=failed;;
    *) [ "$status" = 0 ] || { cat "$scratch/log"; exit 1; };;
  esac
  bun tools/release/download-wasix-runtime-build-artifacts.test.mts "$mode" "$CAPTURE_PATH"
done
