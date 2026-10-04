#!/usr/bin/env bash
set -euo pipefail

fail() {
  echo "WASIX SJLJ artifact guard: $*" >&2
  exit 2
}

if [ "$#" -ne 3 ]; then
  fail "usage: $0 ARTIFACT LLVM_NM WASM_DIS"
fi

artifact="$1"
symbol_tool="$2"
disassembler="$3"

[ -f "$artifact" ] && [ ! -L "$artifact" ] || fail "unsafe or missing artifact: $artifact"
[ -x "$symbol_tool" ] || fail "llvm-nm is not executable: $symbol_tool"
[ -x "$disassembler" ] || fail "wasm-dis is not executable: $disassembler"

if ! undefined_symbols="$("$symbol_tool" -u "$artifact")"; then
  fail "llvm-nm could not inspect artifact: $artifact"
fi

plain_symbols="$({
  printf '%s\n' "$undefined_symbols" |
    awk '$NF ~ /^_?(sig)?(setjmp|longjmp)$/ { print $NF }' |
    LC_ALL=C sort -u |
    paste -sd, -
})"
[ -z "$plain_symbols" ] ||
  fail "unlowered SJLJ symbols remain in $artifact: $plain_symbols"

for required_symbol in __c_longjmp __wasm_setjmp_test; do
  printf '%s\n' "$undefined_symbols" |
    awk -v symbol="$required_symbol" '$NF == symbol { found = 1 } END { exit found ? 0 : 1 }' ||
    fail "lowered SJLJ symbol is missing from $artifact: $required_symbol"
done

if ! "$disassembler" "$artifact" -o - 2>/dev/null | awk '
  /\(import "env" "__c_longjmp" \(tag / { tag_import = 1 }
  /\(try_table \(catch / { catch_frame = 1 }
  END { exit tag_import && catch_frame ? 0 : 1 }
'; then
  fail "could not prove a lowered __c_longjmp try_table/catch in artifact: $artifact"
fi
