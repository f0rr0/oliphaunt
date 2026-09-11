#!/usr/bin/env bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

export CARGO_INCREMENTAL=0
if [[ -z "${LLVM_SYS_221_PREFIX:-}" && -d /opt/homebrew/opt/llvm ]]; then
  export LLVM_SYS_221_PREFIX=/opt/homebrew/opt/llvm
fi
suffix=
case "$(uname -s)" in
  MINGW* | MSYS* | CYGWIN*)
    suffix=.exe
    llvm_prefix="${LLVM_SYS_221_PREFIX:-${LLVM_PATH:-}}"
    if [[ -n "$llvm_prefix" && -d "$llvm_prefix/lib" ]]; then
      export LIB="$(cygpath -aw "$llvm_prefix/lib")${LIB:+;$LIB}"
    fi
    ;;
esac

cargo build -p xtask --release --locked --features aot-serializer
serializer="${CARGO_TARGET_DIR:-target}/release/xtask$suffix"
[[ -f "$serializer" ]] || {
  echo "missing AOT serializer: $serializer" >&2
  exit 1
}
inputs="$(cargo run -p xtask --locked -- assets prepare-aot "$@")"
[[ -n "$inputs" ]] || {
  echo 'no WASIX modules selected for AOT' >&2
  exit 1
}
while IFS=$'\t' read -r input output; do
  [[ -n "$input" && -n "$output" ]] || {
    echo 'incomplete AOT module paths' >&2
    exit 1
  }
  "$serializer" aot-serializer serialize --input "$input" --output "$output"
done <<<"$inputs"
