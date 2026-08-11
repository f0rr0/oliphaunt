#!/usr/bin/env bash

set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
workspace_root="$(cd "$project_root/../../../.." && pwd)"
test_root="$(mktemp -d \
  "$workspace_root/target/oliphaunt-wasix-postmaster/baseline-test.XXXXXX")"
cleanup() { rm -rf -- "$test_root"; }
trap cleanup EXIT HUP INT TERM
mkdir -p "$test_root/work/sources" "$test_root/work/reports" "$test_root/work/runs"

export FRESH_WORK_ROOT="$test_root/work"
export BASELINE_DIR="$FRESH_WORK_ROOT/sources/postgresql-18.4"
export REPORT_DIR="$FRESH_WORK_ROOT/reports"
export RUN_DIR="$FRESH_WORK_ROOT/runs"
source "$project_root/lib/common.sh"

fingerprint="$(fresh_postgres_baseline_fingerprint)"
mkdir -p "$BASELINE_DIR/src/test/regress/results"
git init --quiet "$BASELINE_DIR"
git -C "$BASELINE_DIR" config user.email test@example.invalid
git -C "$BASELINE_DIR" config user.name 'Oliphaunt Baseline Test'
printf 'results/\n' >"$BASELINE_DIR/src/test/regress/.gitignore"
printf 'archive member\n' \
  >"$BASELINE_DIR/src/test/regress/results/from-archive.out"
git -c commit.gpgsign=false -C "$BASELINE_DIR" add -f -A
git -c commit.gpgsign=false -C "$BASELINE_DIR" commit --quiet -m fixture
git -C "$BASELINE_DIR" ls-files --error-unmatch \
  src/test/regress/results/from-archive.out >/dev/null || {
  echo 'forced baseline add omitted an archive member matched by .gitignore' >&2
  exit 1
}
head="$(git -C "$BASELINE_DIR" rev-parse HEAD)"
tree="$(git -C "$BASELINE_DIR" rev-parse 'HEAD^{tree}')"
manifest="$BASELINE_DIR/.git/oliphaunt-baseline.manifest"
{
  printf 'schema=oliphaunt.wasix-postmaster.postgres-baseline.v1\n'
  printf 'fingerprint=%s\n' "$fingerprint"
  printf 'head=%s\n' "$head"
  printf 'tree=%s\n' "$tree"
} >"$manifest"
chmod 0444 "$manifest"
fresh_require_postgres_baseline "$fingerprint"

printf 'ignored drift\n' >"$BASELINE_DIR/src/test/regress/results/ignored-drift.out"
if fresh_require_postgres_baseline "$fingerprint"; then
  echo 'baseline identity accepted an ignored untracked file' >&2
  exit 1
fi
rm -f -- "$BASELINE_DIR/src/test/regress/results/ignored-drift.out"
fresh_require_postgres_baseline "$fingerprint"

chmod 0644 "$manifest"
sed 's/^tree=.*/tree=0000000000000000000000000000000000000000/' \
  "$manifest" >"$manifest.changed"
mv "$manifest.changed" "$manifest"
chmod 0444 "$manifest"
if fresh_require_postgres_baseline "$fingerprint"; then
  echo 'baseline identity accepted a mismatched tree manifest' >&2
  exit 1
fi

fresh_lock_postgres_baseline shared
[ -f "$FRESH_POSTGRES_BASELINE_LOCK_PATH" ]
fresh_unlock_postgres_baseline

printf 'PostgreSQL baseline identity tests passed\n'
