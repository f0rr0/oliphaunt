#!/usr/bin/env bash
set -euo pipefail
[ "$#" -ge 2 ] || { echo 'usage: run-native.sh OUTPUT_DIRECTORY native-liboliphaunt|native-postgres|sqlite|diagnose-speed-cases [OPTIONS...]' >&2; exit 2; }
case "$1" in /*) output="$1" ;; *) output="$PWD/$1" ;; esac
shift
root="$(git -C "$(dirname "${BASH_SOURCE[0]}")" rev-parse --show-toplevel)"
cd "$root"
mkdir -p "$(dirname "$output")"
mkdir "$output" # Never mix measurements from different invocations.
if command -v sha256sum >/dev/null; then hash=(sha256sum); else hash=(shasum -a 256); fi
{
  git rev-parse HEAD
  git status --short -- sdks/rust/sdk sdks/rust-query benchmarks/perf benchmarks/native/sql Cargo.toml Cargo.lock rust-toolchain.toml .cargo
  rustc -Vv
  uname -a
  date -u
} >"$output/context.txt"

{
  for name in LIBOLIPHAUNT_PATH OLIPHAUNT_POSTGRES OLIPHAUNT_INITDB OLIPHAUNT_BROKER_PATH; do
    value="${!name:-}"
    if [ -n "$value" ]; then
      [ -f "$value" ] || value="$(command -v "$value")"
      "${hash[@]}" "$value"
    fi
  done
  while IFS= read -r -d '' file; do
    [ ! -f "$file" ] || "${hash[@]}" "$file"
  done < <(git ls-files -z --cached --others --exclude-standard -- sdks/rust/sdk sdks/rust-query benchmarks/perf/runner benchmarks/perf/run-native.sh benchmarks/native/sql Cargo.toml Cargo.lock rust-toolchain.toml .cargo)
} >"$output/inputs.sha256"
CARGO_TARGET_DIR="$root/target" cargo build --release --locked -p oliphaunt-perf >"$output/build.log" 2>&1
runner="$root/target/release/oliphaunt-perf"
[ ! -f "$runner.exe" ] || runner="$runner.exe"
"${hash[@]}" "$runner" >>"$output/inputs.sha256"
printf '%q ' "$runner" "$@" >"$output/command.sh"
printf '\n' >>"$output/command.sh"
"$runner" "$@" >"$output/report.json.partial" 2>"$output/stderr.log"
"${hash[@]}" -c "$output/inputs.sha256" >"$output/verification.log"
mv "$output/report.json.partial" "$output/report.json"
printf 'Benchmark report: %s/report.json\n' "$output"
