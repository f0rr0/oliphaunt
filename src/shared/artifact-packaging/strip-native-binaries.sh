#!/usr/bin/env bash
set -euo pipefail
script_root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
target= roots=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --target) [ "$#" -ge 2 ] && [ -n "$2" ] || { echo '--target requires a value' >&2; exit 2; }; target="$2"; shift ;;
    --help|-h) echo 'usage: strip-native-binaries.sh [--target TARGET] PATH [PATH...]'; exit 0 ;;
    -*) echo "unknown option: $1" >&2; exit 2 ;;
    *) roots+=("$1") ;;
  esac
  shift
done
[ "${#roots[@]}" -gt 0 ] || { echo 'at least one input path is required' >&2; exit 2; }
for root in "${roots[@]}"; do [ -f "$root" ] || [ -d "$root" ] || { echo "input path does not exist: $root" >&2; exit 2; }; done
host="$(uname -s)"
vc_dlls="$(jq -r '.windowsVcRuntimeDlls[] | ascii_downcase' "$script_root/../../runtimes/liboliphaunt/native/tools/native-runtime-payload-policy.json")"
files="$(mktemp)"
trap 'rm -f "$files"' EXIT
find -H "${roots[@]}" -type f -print0 | LC_ALL=C sort -z >"$files"
checked=0 changed=0
while IFS= read -r -d '' file; do
  magic="$(od -An -tx1 -N8 "$file" | tr -d ' \n')"
  case "$magic" in
    7f454c46*) kind=elf ;;
    feedface*|cefaedfe*|feedfacf*|cffaedfe*|cafebabe*|bebafeca*) kind=macho ;;
    4d5a*) kind=pe ;;
    213c617263683e0a) kind=archive ;;
    *) continue ;;
  esac
  checked=$((checked + 1))
  name="$(basename "$file" | tr '[:upper:]' '[:lower:]')"
  if [ "$kind" = pe ] && grep -Fxq "$name" <<<"$vc_dlls"; then
    printf 'preservedAppLocalVcRuntime=%s\n' "$file" >&2
    continue
  fi
  if [ "$kind" = archive ] && [[ "$name" = *.lib ]]; then
    printf 'skippedMsvcImportLibrary=%s\n' "$file" >&2
    continue
  fi
  tool= flags=(--strip-unneeded)
  if [[ "$target" = android-* ]] && { [ "$kind" = elf ] || [ "$kind" = archive ]; }; then
    [ "$kind" != archive ] || flags=(--strip-debug)
    tool="${OLIPHAUNT_ANDROID_STRIP:-${OLIPHAUNT_ELF_STRIP:-${OLIPHAUNT_STRIP:-}}}"
    if [ -z "$tool" ]; then
      ndk="${ANDROID_NDK_HOME:-${ANDROID_NDK_ROOT:-}}"
      case "$host" in Linux) hosts=(linux-x86_64) ;; Darwin) hosts=(darwin-arm64 darwin-x86_64) ;; MINGW*|MSYS*) hosts=(windows-x86_64) ;; *) hosts=() ;; esac
      for arch in "${hosts[@]}"; do
        candidate="$ndk/toolchains/llvm/prebuilt/$arch/bin/llvm-strip"
        [[ "$host" != MINGW* && "$host" != MSYS* ]] || candidate="$candidate.exe"
        if [ -n "$ndk" ] && [ -x "$candidate" ]; then tool="$candidate"; break; fi
      done
    fi
  elif [ "$kind" = macho ] || { [ "$kind" = archive ] && [ "$host" = Darwin ]; }; then
    tool="${OLIPHAUNT_MACHO_STRIP:-${OLIPHAUNT_STRIP:-}}"
    if [ -z "$tool" ] && [ "$host" = Darwin ]; then tool="$(xcrun --find strip 2>/dev/null || true)"; fi
    [ -n "$tool" ] || tool="$(command -v strip || true)"
    flags=(-S)
  else
    if [ "$kind" = pe ]; then tool="${OLIPHAUNT_PE_STRIP:-${OLIPHAUNT_STRIP:-}}"; else tool="${OLIPHAUNT_ELF_STRIP:-${OLIPHAUNT_STRIP:-}}"; fi
    [ -n "$tool" ] || tool="$(command -v llvm-strip || command -v strip || true)"
    if [ "$kind" = pe ] || [ "$kind" = archive ]; then flags=(--strip-debug); fi
    if [ "$kind" = pe ] && [ -z "$tool" ]; then printf 'skippedPeNativeFile=%s\n' "$file" >&2; continue; fi
  fi
  [ -n "$tool" ] || { echo "missing $kind strip tool for $file (target $target)" >&2; exit 2; }
  before="$(wc -c <"$file")"
  "$tool" "${flags[@]}" "$file"
  after="$(wc -c <"$file")"
  [ "$before" = "$after" ] || changed=$((changed + 1))
done <"$files"
printf 'strippedNativeFiles=%s\ncheckedNativeFiles=%s\n' "$changed" "$checked"
