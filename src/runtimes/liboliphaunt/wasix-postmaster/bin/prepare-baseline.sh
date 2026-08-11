#!/usr/bin/env bash

set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib/common.sh"
source "$REPO_ROOT/src/postgres/versions/18/fetch-source.sh"

print_path=0
refresh=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --print-path) print_path=1 ;;
    --refresh) refresh=1 ;;
    *) echo "usage: $0 [--print-path] [--refresh]" >&2; exit 2 ;;
  esac
  shift
done

read_toml_value() {
  local key="$1"
  awk -F'=' -v key="$key" '
    $1 ~ "^[[:space:]]*" key "[[:space:]]*$" {
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", $2)
      gsub(/^"|"$/, "", $2)
      print $2
      exit
    }
  ' "$POSTGRES_SOURCE_TOML"
}

sha256_file() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    sha256sum "$1" | awk '{print $1}'
  fi
}

fresh_ensure_dirs
fresh_require_command flock
fresh_require_command git
fresh_require_command mktemp
fresh_require_command tar
fresh_require_managed_generated_path "$BASELINE_DIR" BASELINE_DIR

# Fetching, extracting, and publishing are one transaction.  Consumers take
# this same lock in shared mode for every interval in which they read the
# baseline, so no process can observe a partially replaced checkout.
fresh_lock_postgres_baseline exclusive

manifest_version="$(read_toml_value version)"
manifest_url="$(read_toml_value url)"
manifest_sha256="$(read_toml_value sha256)"
[ "$manifest_version" = "$POSTGRES_VERSION" ] || {
  echo "PostgreSQL version mismatch: common=$POSTGRES_VERSION manifest=$manifest_version" >&2
  exit 1
}
expected_tag="REL_${POSTGRES_VERSION//./_}"
[ "$POSTGRES_TAG" = "$expected_tag" ] || {
  echo "PostgreSQL tag mismatch: expected $expected_tag, got $POSTGRES_TAG" >&2
  exit 1
}

source_cache="$REPO_ROOT/target/liboliphaunt-pg18/source"
tarball="$source_cache/postgresql-$POSTGRES_VERSION.tar.bz2"
fingerprint="$POSTGRES_VERSION:$manifest_sha256"
baseline_parent="$(dirname "$BASELINE_DIR")"
baseline_name="$(basename "$BASELINE_DIR")"
stage_root=""
retired_root=""
preserve_retired=0

cleanup() {
  local status="$?"
  trap - EXIT HUP INT TERM
  if [ -n "$retired_root" ] && [ -d "$retired_root/baseline" ]; then
    if [ ! -e "$BASELINE_DIR" ] && [ ! -L "$BASELINE_DIR" ]; then
      mv "$retired_root/baseline" "$BASELINE_DIR" || true
    elif ! fresh_require_postgres_baseline "$fingerprint" >/dev/null 2>&1; then
      if fresh_require_managed_generated_path "$BASELINE_DIR" BASELINE_DIR &&
        [ -d "$BASELINE_DIR" ] && [ ! -L "$BASELINE_DIR" ]; then
        rm -rf -- "$BASELINE_DIR"
        mv "$retired_root/baseline" "$BASELINE_DIR" || true
      else
        printf 'refusing unsafe PostgreSQL baseline rollback target: %s\n' \
          "$BASELINE_DIR" >&2
        preserve_retired=1
      fi
    fi
  fi
  if [ -n "$stage_root" ] && [ -d "$stage_root" ]; then
    rm -rf -- "$stage_root"
  fi
  if [ -n "$retired_root" ] && [ -d "$retired_root" ] &&
    [ "$preserve_retired" -eq 0 ]; then
    rm -rf -- "$retired_root"
  elif [ "$preserve_retired" -eq 1 ]; then
    printf 'retained prior PostgreSQL baseline for manual recovery: %s/baseline\n' \
      "$retired_root" >&2
  fi
  fresh_unlock_postgres_baseline || true
  exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

if [ "$refresh" -eq 1 ]; then
  rm -f "$tarball"
fi

oliphaunt_fetch_postgresql_source_archive \
  "$tarball" \
  "$POSTGRES_VERSION" \
  "$manifest_sha256" \
  "$manifest_url"

[ "$(sha256_file "$tarball")" = "$manifest_sha256" ] || {
  echo "verified PostgreSQL source cache changed unexpectedly: $tarball" >&2
  exit 1
}

reuse=0
if [ "$refresh" -eq 0 ] && fresh_require_postgres_baseline "$fingerprint"; then
  reuse=1
fi

if [ "$reuse" -eq 0 ]; then
  mkdir -p "$baseline_parent"
  stage_root="$(mktemp -d "$baseline_parent/.${baseline_name}.stage.XXXXXX")"
  fresh_require_managed_generated_path "$stage_root" postgres-baseline-stage
  extracted="$stage_root/postgresql-$POSTGRES_VERSION"
  tar -tjf "$tarball" | awk -v root="postgresql-$POSTGRES_VERSION" '
    $0 != root && index($0, root "/") != 1 { exit 2 }
    $0 ~ /(^|\/)\.\.($|\/)/ { exit 2 }
    END { if (NR == 0) exit 2 }
  ' || {
    printf 'PostgreSQL archive has an unsafe or unexpected layout: %s\n' "$tarball" >&2
    exit 1
  }
  tar -xjf "$tarball" -C "$stage_root"
  [ -d "$extracted" ] && [ ! -L "$extracted" ] || {
    printf 'PostgreSQL archive did not produce the expected source root: %s\n' "$extracted" >&2
    exit 1
  }

  git init --quiet "$extracted"
  git -C "$extracted" config core.autocrlf false
  git -C "$extracted" config core.eol lf
  git -c commit.gpgsign=false -C "$extracted" add -f -A
  GIT_AUTHOR_NAME="Oliphaunt Source Prep" \
  GIT_AUTHOR_EMAIL="dev@oliphaunt.dev" \
  GIT_AUTHOR_DATE="2000-01-01T00:00:00Z" \
  GIT_COMMITTER_NAME="Oliphaunt Source Prep" \
  GIT_COMMITTER_EMAIL="dev@oliphaunt.dev" \
  GIT_COMMITTER_DATE="2000-01-01T00:00:00Z" \
    git -c commit.gpgsign=false -C "$extracted" commit --quiet \
      -m "source: PostgreSQL $POSTGRES_VERSION"
  candidate_head="$(git -C "$extracted" rev-parse --verify 'HEAD^{commit}')"
  candidate_tree="$(git -C "$extracted" rev-parse --verify 'HEAD^{tree}')"
  candidate_manifest="$extracted/.git/oliphaunt-baseline.manifest"
  {
    printf 'schema=oliphaunt.wasix-postmaster.postgres-baseline.v1\n'
    printf 'fingerprint=%s\n' "$fingerprint"
    printf 'version=%s\n' "$POSTGRES_VERSION"
    printf 'archive_url=%s\n' "$manifest_url"
    printf 'archive_sha256=%s\n' "$manifest_sha256"
    printf 'head=%s\n' "$candidate_head"
    printf 'tree=%s\n' "$candidate_tree"
  } >"$candidate_manifest"
  chmod 0444 "$candidate_manifest"
  [ -z "$(git -C "$extracted" status --porcelain=v1 --untracked-files=all --ignored)" ] || {
    printf 'staged PostgreSQL baseline is not clean: %s\n' "$extracted" >&2
    exit 1
  }

  if [ -e "$BASELINE_DIR" ] || [ -L "$BASELINE_DIR" ]; then
    retired_root="$(mktemp -d "$baseline_parent/.${baseline_name}.retired.XXXXXX")"
    fresh_require_managed_generated_path "$retired_root" postgres-baseline-retired
    mv "$BASELINE_DIR" "$retired_root/baseline"
  fi
  mv "$extracted" "$BASELINE_DIR"
  fresh_require_postgres_baseline "$fingerprint" || {
    printf 'published PostgreSQL baseline failed identity validation: %s\n' "$BASELINE_DIR" >&2
    exit 1
  }
  rmdir "$stage_root"
  stage_root=""
  if [ -n "$retired_root" ]; then
    rm -rf -- "$retired_root"
    retired_root=""
  fi
fi

fresh_require_postgres_baseline "$fingerprint" || {
  printf 'PostgreSQL baseline failed final identity validation: %s\n' "$BASELINE_DIR" >&2
  exit 1
}
baseline_head="$FRESH_POSTGRES_BASELINE_HEAD"
baseline_tree="$FRESH_POSTGRES_BASELINE_TREE"
report="$REPORT_DIR/baseline.md"
fresh_write_report_header "$report" "Clean PostgreSQL Baseline"
{
  printf '## Result\n\n'
  printf -- '- Source directory: `%s`\n' "$BASELINE_DIR"
  printf -- '- Pinned archive: `%s`\n' "$manifest_url"
  printf -- '- Archive SHA-256: `%s`\n' "$manifest_sha256"
  printf -- '- Local deterministic baseline commit: `%s`\n\n' "$baseline_head"
  printf -- '- Local deterministic baseline tree: `%s`\n\n' "$baseline_tree"
  printf '## Lineage Rule\n\n'
  printf 'This checkout is the clean canonical PostgreSQL 18.4 archive oracle. Do not apply runtime patches here.\n'
} >>"$report"

if [ "$print_path" -eq 1 ]; then
  printf '%s\n' "$BASELINE_DIR"
else
  printf 'prepared clean PostgreSQL %s at %s\n' "$POSTGRES_VERSION" "$BASELINE_DIR"
fi
