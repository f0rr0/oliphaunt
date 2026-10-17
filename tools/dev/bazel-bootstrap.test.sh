#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
checkout="$scratch/checkout"
mkdir -p "$checkout/tools/dev" "$scratch/bin"
cp "$script_dir/bazel.sh" "$script_dir/acquisition.sh" "$checkout/tools/dev/"
printf '8.8.1\n' > "$checkout/.bazelversion"
# Exercise filename-escaped checksum output in every existing bootstrap case.
export XDG_CACHE_HOME="$scratch/cache\\native"
export MOCK_BINARY="$scratch/bazel"
export MOCK_EXECUTION_LOG="$scratch/executions"
export MOCK_DOWNLOAD_LOG="$scratch/downloads"
export MOCK_OS=Linux MOCK_ARCH=x86_64 MOCK_DOWNLOAD_KIND=valid
export PATH="$scratch/bin:$PATH"

fail() { echo "bazel-bootstrap.test.sh: $*" >&2; exit 1; }
cat > "$MOCK_BINARY" <<'SH'
#!/usr/bin/env bash
printf 'cwd=%s\n' "$PWD" >> "$MOCK_EXECUTION_LOG"
printf 'arg=%s\n' "$@" >> "$MOCK_EXECUTION_LOG"
SH
if command -v sha256sum >/dev/null 2>&1; then
  checksum="$(sha256sum "$MOCK_BINARY" | awk '{ print $1 }')"
else
  checksum="$(shasum -a 256 "$MOCK_BINARY" | awk '{ print $1 }')"
fi
for suffix in linux-x86_64 linux-arm64 darwin-x86_64 darwin-arm64 windows-x86_64.exe; do
  printf '8.8.1\tbazel-8.8.1-%s\t%s\n' "$suffix" "$checksum"
done > "$checkout/tools/dev/bazel-checksums.tsv"
cat > "$scratch/bin/uname" <<'SH'
#!/usr/bin/env bash
case "$1" in
  -s) printf '%s\n' "$MOCK_OS" ;;
  -m) printf '%s\n' "$MOCK_ARCH" ;;
  *) exit 1 ;;
esac
SH
cat > "$scratch/bin/curl" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
output='' url=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output) shift; output="$1" ;;
    https://*) url="$1" ;;
  esac
  shift
done
printf '%s\n' "$url" >> "$MOCK_DOWNLOAD_LOG"
case "$MOCK_DOWNLOAD_KIND" in
  valid) cp "$MOCK_BINARY" "$output" ;;
  corrupt) printf 'unverified download\n' > "$output" ;;
  fail) printf 'partial download\n' > "$output"; exit 22 ;;
esac
SH
# Retry behavior is tested without waiting between mock transport failures.
printf '#!/usr/bin/env bash\nexit 0\n' > "$scratch/bin/sleep"
chmod +x "$scratch/bin/"*
launcher="$checkout/tools/dev/bazel.sh"

for selector in Linux/x86_64 Linux/aarch64 Darwin/x86_64 Darwin/arm64 MINGW64_NT-10.0/x86_64; do
  MOCK_OS="${selector%/*}" MOCK_ARCH="${selector#*/}" \
    bash "$launcher" --output_user_root="$scratch/output root" build '//target:two words'
done
[ "$(wc -l < "$MOCK_DOWNLOAD_LOG")" -eq 5 ] || fail 'platform downloads were not selected once each'
for suffix in linux-x86_64 linux-arm64 darwin-x86_64 darwin-arm64 windows-x86_64.exe; do
  grep -Fxq "https://releases.bazel.build/8.8.1/release/bazel-8.8.1-$suffix" "$MOCK_DOWNLOAD_LOG" ||
    fail "incorrect official download URL for $suffix"
done
printf 'cwd=%s\narg=--output_user_root=%s/output root\narg=build\narg=//target:two words\n' \
  "$checkout" "$scratch" > "$scratch/expected"
head -n 4 "$MOCK_EXECUTION_LOG" > "$scratch/actual"
cmp "$scratch/expected" "$scratch/actual" || fail 'workspace or argument boundaries changed'

# A verified cache must work without contacting the network.
MOCK_DOWNLOAD_KIND=fail bash "$launcher" version
[ "$(wc -l < "$MOCK_DOWNLOAD_LOG")" -eq 5 ] || fail 'valid cache contacted the network'
binary="$XDG_CACHE_HOME/oliphaunt/bazel/8.8.1/bazel-8.8.1-linux-x86_64"
printf 'corrupt cache\n' > "$binary"
bash "$launcher" version
cmp "$MOCK_BINARY" "$binary" || fail 'corrupt cache was reused'
[ "$(wc -l < "$MOCK_DOWNLOAD_LOG")" -eq 6 ] || fail 'corrupt cache was not replaced'

expect_failure() {
  local before
  before="$(wc -l < "$MOCK_EXECUTION_LOG")"
  if bash "$launcher" version > "$scratch/failure" 2>&1; then
    fail 'invalid bootstrap input succeeded'
  fi
  [ "$(wc -l < "$MOCK_EXECUTION_LOG")" -eq "$before" ] || fail 'unverified binary executed'
  for partial in "$XDG_CACHE_HOME/oliphaunt/bazel/8.8.1"/.download.*; do
    [ ! -e "$partial" ] || fail 'temporary download survived failure'
  done
}
printf 'corrupt cache\n' > "$binary"
MOCK_DOWNLOAD_KIND=corrupt expect_failure
grep -q 'download checksum mismatch' "$scratch/failure" || fail 'missing checksum diagnosis'
MOCK_DOWNLOAD_KIND=fail expect_failure
grep -Fxq 'corrupt cache' "$binary" || fail 'failed download replaced cached bytes'
MOCK_ARCH=riscv64 expect_failure
grep -q 'unsupported bootstrap platform' "$scratch/failure" || fail 'unsupported platform was accepted'
printf '9.9.9\n' > "$checkout/.bazelversion"
expect_failure
grep -q 'missing or ambiguous checksum' "$scratch/failure" || fail 'unlisted version was accepted'
printf '8.8.1\n' > "$checkout/.bazelversion"
printf '8.8.1\tbazel-8.8.1-linux-x86_64\t%s\n' "$checksum" >> "$checkout/tools/dev/bazel-checksums.tsv"
expect_failure
grep -q 'missing or ambiguous checksum' "$scratch/failure" || fail 'duplicate checksum was accepted'

echo 'Bazel bootstrap passed: platforms, pinned downloads, verified cache, arguments and failure cleanup'
