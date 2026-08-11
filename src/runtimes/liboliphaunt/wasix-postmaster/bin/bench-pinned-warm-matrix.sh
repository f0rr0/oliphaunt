#!/usr/bin/env bash

set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib/common.sh"

usage() {
  cat <<'USAGE'
Usage: bench-pinned-warm-matrix.sh --pin NAME_OR_PATH [bench args...]

Run the query performance matrix against a pinned runtime bundle. The wrapper
sources the pin's env.sh and forces --skip-build --skip-precompile so accepted
PostgreSQL and Wasmer compiled artifacts are not rebuilt after experiments.
USAGE
}

pin=""
forwarded=()
profile_explicit=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --pin)
      shift
      if [ "$#" -eq 0 ]; then
        echo "--pin requires a name or path" >&2
        exit 2
      fi
      pin="$1"
      ;;
    --profile|--profiles)
      opt="$1"
      profile_explicit=1
      forwarded+=("$opt")
      shift
      if [ "$#" -eq 0 ]; then
        echo "$opt requires a value" >&2
        exit 2
      fi
      forwarded+=("$1")
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      forwarded+=("$1")
      ;;
  esac
  shift
done

if [ -z "$pin" ]; then
  echo "--pin is required" >&2
  usage >&2
  exit 2
fi

case "$pin" in
  /*|.*/*|*/*) pin_root="$pin" ;;
  *) pin_root="$FRESH_WORK_ROOT/tools/pinned-runtimes/$pin" ;;
esac
if [ ! -f "$pin_root/env.sh" ]; then
  printf 'missing pinned runtime env: %s\n' "$pin_root/env.sh" >&2
  exit 2
fi

# shellcheck disable=SC1090
source "$pin_root/env.sh"

if [ "$profile_explicit" -ne 1 ]; then
  forwarded=(--profile "${FRESH_PINNED_WASIX_CORE_PROFILE:-$WASIX_CORE_PROFILE}" "${forwarded[@]}")
fi

snapshot_tree() {
  local root="$1"
  local out="$2"
  if [ "${FRESH_PINNED_VERIFY_HASH:-0}" = "1" ]; then
    (
      cd "$root"
      find . -type f | LC_ALL=C sort | while IFS= read -r rel; do
        hash="$(shasum -a 256 "$rel" | awk '{print $1}')"
        printf '%s\t%s\n' "$hash" "${rel#./}"
      done
      find . -type l | LC_ALL=C sort | while IFS= read -r rel; do
        target="$(readlink "$rel")"
        printf 'SYMLINK\t%s\t%s\n' "${rel#./}" "$target"
      done
    ) >"$out"
  else
    (
      cd "$root"
      perl -MFile::Find -e '
        use strict;
        use warnings;
        my @rows;
        find({
          no_chdir => 1,
          wanted => sub {
            my $path = $File::Find::name;
            return if $path eq ".";
            (my $rel = $path) =~ s{^\./}{};
            if (-l $path) {
              my $target = readlink($path);
              push @rows, join("\t", "L", $rel, $target);
              return;
            }
            return unless -f $path;
            my @s = stat($path);
            push @rows, join("\t", "F", $rel, $s[7], $s[9]);
          },
        }, ".");
        print "$_\n" for sort @rows;
      '
    ) >"$out"
  fi
}

verify_unchanged="${FRESH_PINNED_VERIFY_UNCHANGED:-1}"
tmp_dir=""
if [ "$verify_unchanged" != "0" ]; then
  tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/fresh-wasix-pin.XXXXXX")"
  trap 'rm -rf "$tmp_dir"' EXIT
  snapshot_tree "$FRESH_PINNED_WASIX_INSTALL_DIR" "$tmp_dir/install.before"
  snapshot_tree "$FRESH_PINNED_WASMER_CACHE_DIR" "$tmp_dir/cache.before"
fi

set +e
"$FRESH_ROOT/bin/bench-wasix-query-suite.sh" \
  --skip-build \
  --skip-precompile \
  "${forwarded[@]}"
bench_status=$?
set -e

if [ "$verify_unchanged" != "0" ]; then
  snapshot_tree "$FRESH_PINNED_WASIX_INSTALL_DIR" "$tmp_dir/install.after"
  snapshot_tree "$FRESH_PINNED_WASMER_CACHE_DIR" "$tmp_dir/cache.after"
  if ! diff -u "$tmp_dir/install.before" "$tmp_dir/install.after" >"$tmp_dir/install.diff"; then
    echo "pinned WASIX install changed during benchmark: $FRESH_PINNED_WASIX_INSTALL_DIR" >&2
    sed -n '1,80p' "$tmp_dir/install.diff" >&2
    exit 1
  fi
  if ! diff -u "$tmp_dir/cache.before" "$tmp_dir/cache.after" >"$tmp_dir/cache.diff"; then
    echo "pinned Wasmer cache changed during benchmark: $FRESH_PINNED_WASMER_CACHE_DIR" >&2
    sed -n '1,80p' "$tmp_dir/cache.diff" >&2
    exit 1
  fi
fi

exit "$bench_status"
