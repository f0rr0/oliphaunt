#!/usr/bin/env bash
set -euo pipefail
tools="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
test_data="$tools/ios-app-transport.test.mts"
cli="$tools/ios-app-transport.sh"
bun test "$test_data"
reject() {
  local expected="$1"
  shift
  if bash "$cli" "$@" > "$scratch/failure.log" 2>&1; then
    echo 'invalid iOS transport unexpectedly accepted' >&2
    exit 1
  fi
  grep -Eq "$expected" "$scratch/failure.log" || { cat "$scratch/failure.log" >&2; exit 1; }
}
if [[ "$(uname -s)" != Darwin ]]; then
  reject 'required Apple command ditto was not found; run this operation on macOS' pack --app-dir "$scratch/app" --transport-dir "$scratch/transport"
  echo 'Apple transport roundtrip requires macOS; portable archive rejection tests passed.'
  exit 0
fi
pack() { bash "$cli" pack --app-dir "$1/app" --transport-dir "$1/transport"; }
extract() { bash "$cli" verify-extract --transport-dir "$1/transport" --output-dir "$1/output"; }
root="$scratch/roundtrip"
bun "$test_data" prepare "$root"
pack "$root"
bash "$cli" pack --app-dir "$root/app" --transport-dir "$root/second"
extract "$root"
bun "$test_data" check-roundtrip "$root"
for attempt in 1 2; do
  bun "$test_data" stale "$root"
  pack "$root"
  bun "$test_data" check-clean "$root"
done
root="$scratch/case"
status=0
bun "$test_data" prepare "$root" case || status=$?
if [[ "$status" == 0 ]]; then
  pack "$root"
  extract "$root"
  bun "$test_data" check-case "$root"
elif [[ "$status" == 77 ]]; then
  echo 'Case-distinct resource test requires a case-sensitive temporary volume.'
else
  exit "$status"
fi
for scenario in traversal tamper-archive tamper-report; do
  root="$scratch/$scenario"
  bun "$test_data" prepare "$root"
  pack "$root"
  bun "$test_data" "$scenario" "$root"
  case "$scenario" in
    traversal) expected='ZIP contains unsafe member path';;
    tamper-archive) expected='transport archive (byte count|checksum) mismatch';;
    tamper-report) expected='transport build report identity does not match its manifest binding';;
  esac
  reject "$expected" verify-extract --transport-dir "$root/transport" --output-dir "$root/output"
  [[ ! -e "$root/escaped.txt" ]]
done
for scenario in multiple nonexec; do
  root="$scratch/invalid-pack-$scenario"
  bun "$test_data" prepare "$root" "$scenario"
  if [[ "$scenario" == multiple ]]; then expected='must contain exactly one direct \.app directory; found 2'; else expected='executable is not executable'; fi
  reject "$expected" pack --app-dir "$root/app" --transport-dir "$root/transport"
done
for scenario in unrelated multiple nonexec; do
  root="$scratch/invalid-extract-$scenario"
  bun "$test_data" prepare "$root"
  pack "$root"
  mkdir "$root/payload"
  ditto -x -k "$root/transport/react-native-mobile-ios-app.zip" "$root/payload"
  bun "$test_data" mutate-payload "$root" "$scenario"
  rm "$root/transport/react-native-mobile-ios-app.zip"
  ditto -c -k --sequesterRsrc "$root/payload" "$root/transport/react-native-mobile-ios-app.zip"
  bun "$test_data" rebind "$root"
  case "$scenario" in
    unrelated) expected='iOS app ZIP member is outside Fixture\.app: "unrelated\.txt"';;
    multiple) expected='iOS app ZIP member is outside Fixture\.app: "Second\.app/"';;
    nonexec) expected='executable is not executable';;
  esac
  reject "$expected" verify-extract --transport-dir "$root/transport" --output-dir "$root/output"
done
