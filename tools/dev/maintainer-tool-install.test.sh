#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
repo="$PWD"
scratch=$(mktemp -d "${TMPDIR:-/tmp}/oliphaunt-maintainer-tools-XXXXXX")
trap 'rm -rf "$scratch"' EXIT
FAKE_REAL_MV="$(command -v mv)"
export FAKE_REAL_MV
mkdir -p "$scratch/fakes" "$scratch/source" "$scratch/action/docs"
cat > "$scratch/source/cargo-binstall" <<'BIN'
#!/usr/bin/env bash
echo 'cargo-binstall 1.19.1'
BIN
cat > "$scratch/action/actionlint" <<'BIN'
#!/usr/bin/env bash
echo 'actionlint version 1.7.12'
BIN
chmod +x "$scratch/source/cargo-binstall" "$scratch/action/actionlint"
printf 'upstream documentation\n' > "$scratch/action/docs/README.md"
tar -czf "$scratch/cargo.tgz" -C "$scratch/source" cargo-binstall
tar -czf "$scratch/action.tgz" -C "$scratch/action" actionlint docs/README.md
printf extra > "$scratch/source/extra"
tar -czf "$scratch/extra.tgz" -C "$scratch/source" cargo-binstall extra
mkdir "$scratch/link"
ln -s "$scratch/not-to-be-read" "$scratch/link/cargo-binstall"
tar -czf "$scratch/link.tgz" -C "$scratch/link" cargo-binstall
ln -s "$scratch/not-to-be-read" "$scratch/link/actionlint"
tar -czf "$scratch/action-link.tgz" -C "$scratch/link" actionlint
tar -czf "$scratch/action-duplicate.tgz" -C "$scratch/action" actionlint actionlint
cat > "$scratch/fakes/uname" <<'FAKE'
#!/usr/bin/env bash
case "$1" in -s) echo "${FAKE_UNAME_OS:-Linux}";; -m) echo x86_64;; esac
FAKE
cat > "$scratch/fakes/curl" <<'FAKE'
#!/usr/bin/env bash
set -eu
printf '%s\n' "$@" >> "$FAKE_CURL_LOG"
output=
while [ "$#" -gt 0 ]; do
  if [ "$1" = --output ]; then output="$2"; shift; fi
  shift
done
case "${FAKE_CURL_MODE:-success}" in
  success) cp "$FAKE_CURL_SOURCE" "$output";;
  transport) printf partial > "$output"; exit 28;;
  http) exit 22;;
  oversized) printf partial > "$output"; exit 63;;
  interrupt) printf partial > "$output"; kill -TERM "$PPID"; exit 143;;
esac
FAKE
cat > "$scratch/fakes/cargo" <<'FAKE'
#!/usr/bin/env bash
set -eu
printf '%s\n' "$*" >> "$FAKE_CARGO_LOG"
[ "${FAKE_CARGO_MODE:-success}" = success ] || exit 42
while [ "$1" != --root ]; do shift; done
mkdir -p "$2/bin"
cp "$FAKE_SOURCE_BINARY" "$2/bin/cargo-binstall"
FAKE
cat > "$scratch/fakes/go" <<'FAKE'
#!/usr/bin/env bash
touch "$FAKE_GO_LOG"
exit 99
FAKE
cat > "$scratch/fakes/mv" <<'FAKE'
#!/usr/bin/env bash
set -eu
if [ "${!#}" = "${FAKE_MV_FAIL_TARGET:-}" ] && [ ! -f "$FAKE_MV_FAILURE_MARKER" ]; then
  touch "$FAKE_MV_FAILURE_MARKER"
  exit 91
fi
exec "$FAKE_REAL_MV" "$@"
FAKE
chmod +x "$scratch/fakes/"*
export PATH="$scratch/fakes:$PATH"
export FAKE_SOURCE_BINARY="$scratch/source/cargo-binstall"
sha() { shasum -a 256 "$1" | awk '{print $1}'; }
manifest() {
  cat > "$OLIPHAUNT_MAINTAINER_TOOLS_MANIFEST" <<EOF
[cargo-binstall]
version = "1.19.1"
source_fallback = "cargo install cargo-binstall --version 1.19.1 --locked"
[cargo-binstall.assets.x86_64-unknown-linux-musl]
url = "https://github.com/cargo-bins/cargo-binstall/releases/download/v1.19.1/cargo-binstall-x86_64-unknown-linux-musl.tgz"
sha256 = "$(sha "${cargo_archive:-$scratch/cargo.tgz}")"
binary_sha256 = "$(sha "$scratch/source/cargo-binstall")"
format = "tgz"
binary_path = "cargo-binstall"
max_archive_bytes = "${max_archive:-1048576}"
max_binary_bytes = "1048576"
[actionlint]
version = "1.7.12"
source_fallback = "none"
[actionlint.assets.linux-amd64]
url = "https://github.com/rhysd/actionlint/releases/download/v1.7.12/actionlint_1.7.12_linux_amd64.tar.gz"
sha256 = "$(sha "${action_archive:-$scratch/action.tgz}")"
binary_sha256 = "$(sha "$scratch/action/actionlint")"
format = "tgz"
binary_path = "actionlint"
max_archive_bytes = "1048576"
max_binary_bytes = "1048576"
EOF
}
fixture() {
  case_root="$scratch/$1"
  mkdir -p "$case_root/bin"
  export CARGO_HOME="$case_root/cargo-home"
  export OLIPHAUNT_MAINTAINER_TOOLS_ROOT="$case_root"
  export OLIPHAUNT_MAINTAINER_TOOLS_MANIFEST="$case_root/manifest.toml"
  export OLIPHAUNT_MAINTAINER_BIN_DIR="$case_root/bin"
  export OLIPHAUNT_MAINTAINER_TOOLS_CURL="$scratch/fakes/curl"
  export FAKE_CURL_LOG="$case_root/curl.log" FAKE_CARGO_LOG="$case_root/cargo.log" FAKE_GO_LOG="$case_root/go.log"
  export FAKE_MV_FAILURE_MARKER="$case_root/mv-failed"
  export FAKE_CURL_SOURCE="$scratch/cargo.tgz"
  unset cargo_archive action_archive max_archive FAKE_CURL_MODE FAKE_CARGO_MODE FAKE_MV_FAIL_TARGET FAKE_UNAME_OS
  manifest
}
install_tool() { bash "$repo/tools/dev/install-pinned-maintainer-tool.sh" "$@"; }
reject() {
  local expected="$1"; shift
  local status=0
  "$@" > "$case_root/failure.log" 2>&1 || status=$?
  [ "$status" -ne 0 ] || { echo "unexpected success: $*" >&2; exit 1; }
  if [ "$expected" != any ]; then test "$status" -eq "$expected"; fi
}
no_debris() {
  local file
  for file in "$OLIPHAUNT_MAINTAINER_BIN_DIR"/.*.download.* "$OLIPHAUNT_MAINTAINER_BIN_DIR"/.*.install.*; do
    [ ! -e "$file" ] || { echo "installer left $file" >&2; exit 1; }
  done
}
fixture cache
install_tool cargo-binstall
final="$OLIPHAUNT_MAINTAINER_BIN_DIR/cargo-binstall"
marker="$OLIPHAUNT_MAINTAINER_BIN_DIR/.cargo-binstall.oliphaunt-source"
cmp "$final" "$scratch/source/cargo-binstall"
cp "$FAKE_CURL_LOG" "$case_root/first.log"
install_tool cargo-binstall
cmp "$FAKE_CURL_LOG" "$case_root/first.log"
printf '# corrupted\n' >> "$final"
install_tool cargo-binstall
cmp "$final" "$scratch/source/cargo-binstall"
printf '# force refresh\n' >> "$final"
cp "$final" "$case_root/previous"
cp "$marker" "$case_root/previous-marker"
for archive in checksum extra link oversized; do
  fixture_archive="$scratch/$archive.tgz"
  case "$archive" in
    checksum) printf wrong > "$fixture_archive";;
    extra|link) cargo_archive="$fixture_archive";;
    oversized) unset cargo_archive; max_archive=1; fixture_archive="$scratch/cargo.tgz";;
  esac
  manifest
  export FAKE_CURL_SOURCE="$fixture_archive"
  reject any install_tool cargo-binstall
  cmp "$final" "$case_root/previous"
  cmp "$marker" "$case_root/previous-marker"
  no_debris
done
unset cargo_archive max_archive
manifest
export FAKE_CURL_SOURCE="$scratch/cargo.tgz" FAKE_MV_FAIL_TARGET="$marker"
reject any install_tool cargo-binstall
cmp "$final" "$case_root/previous"
cmp "$marker" "$case_root/previous-marker"
no_debris
fixture transport
export FAKE_CURL_MODE=transport
reject 75 install_tool cargo-binstall
export FAKE_CURL_MODE=interrupt
reject any install_tool cargo-binstall
test ! -e "$OLIPHAUNT_MAINTAINER_BIN_DIR/cargo-binstall"
no_debris
fixture fallback
export FAKE_CURL_MODE=transport OLIPHAUNT_BOOTSTRAP_CARGO_BINSTALL_ONLY=1
bash tools/dev/bootstrap-tools.sh
grep -Eq '^install cargo-binstall --version 1.19.1 --locked --root /' "$FAKE_CARGO_LOG"
cmp "$OLIPHAUNT_MAINTAINER_BIN_DIR/cargo-binstall" "$scratch/source/cargo-binstall"
grep -q 'source=locked-cargo-install' "$OLIPHAUNT_MAINTAINER_BIN_DIR/.cargo-binstall.oliphaunt-source"
cp "$FAKE_CURL_LOG" "$case_root/first.log"
install_tool cargo-binstall
cmp "$FAKE_CURL_LOG" "$case_root/first.log"
no_debris
for mode in http oversized checksum; do
  fixture "fallback-$mode"
  export FAKE_CURL_MODE="$mode"
  if [ "$mode" = checksum ]; then export FAKE_CURL_MODE=success FAKE_CURL_SOURCE="$scratch/checksum.tgz"; fi
  reject any bash tools/dev/bootstrap-tools.sh
  test ! -e "$FAKE_CARGO_LOG"
  no_debris
done
fixture fallback-failure
printf old > "$OLIPHAUNT_MAINTAINER_BIN_DIR/cargo-binstall"
printf marker > "$OLIPHAUNT_MAINTAINER_BIN_DIR/.cargo-binstall.oliphaunt-source"
export FAKE_CURL_MODE=transport FAKE_CARGO_MODE=fail
reject any bash tools/dev/bootstrap-tools.sh
test "$(cat "$OLIPHAUNT_MAINTAINER_BIN_DIR/cargo-binstall")" = old
test "$(cat "$OLIPHAUNT_MAINTAINER_BIN_DIR/.cargo-binstall.oliphaunt-source")" = marker
no_debris
fixture action
export FAKE_CURL_SOURCE="$scratch/action.tgz"
install_tool actionlint
cmp "$OLIPHAUNT_MAINTAINER_BIN_DIR/actionlint" "$scratch/action/actionlint"
printf '# refresh\n' >> "$OLIPHAUNT_MAINTAINER_BIN_DIR/actionlint"
cp "$OLIPHAUNT_MAINTAINER_BIN_DIR/actionlint" "$case_root/previous"
for action_archive in "$scratch/action-link.tgz" "$scratch/action-duplicate.tgz"; do
  manifest
  export FAKE_CURL_SOURCE="$action_archive"
  reject any install_tool actionlint
  cmp "$OLIPHAUNT_MAINTAINER_BIN_DIR/actionlint" "$case_root/previous"
  no_debris
done
fixture action-transport
export FAKE_CURL_MODE=transport
reject 75 bash tools/dev/install-actionlint.sh
test ! -e "$FAKE_GO_LOG"
no_debris
fixture unsupported
export FAKE_UNAME_OS=FreeBSD
reject 69 install_tool cargo-binstall
test ! -e "$FAKE_CURL_LOG"
no_debris
echo 'Maintainer tool integrity, cache repair, rollback and pinned fallback checks passed'
