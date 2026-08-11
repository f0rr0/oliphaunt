#!/usr/bin/env bash

# Shared, fail-closed identity capture for qualification runners.  Callers must
# source common.sh and sealed-carrier.sh first.

fresh_capture_stable_regular_file_identity() {
  local path="$1"
  local identity

  identity="$(python3 - "$path" <<'PY'
import hashlib
import os
import stat
import sys

path = sys.argv[1]


def identity(info: os.stat_result) -> tuple[int, ...]:
    return (
        info.st_dev,
        info.st_ino,
        info.st_mode,
        info.st_uid,
        info.st_gid,
        info.st_size,
        info.st_mtime_ns,
        info.st_ctime_ns,
    )


before = os.lstat(path)
if not stat.S_ISREG(before.st_mode) or stat.S_ISLNK(before.st_mode):
    raise SystemExit("identity input must be a regular non-symlink file")
descriptor = os.open(
    path,
    os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0),
)
try:
    opened = os.fstat(descriptor)
    if identity(before) != identity(opened):
        raise SystemExit("identity input changed while opening")
    digest = hashlib.sha256()
    while True:
        chunk = os.read(descriptor, 1024 * 1024)
        if not chunk:
            break
        digest.update(chunk)
    after = os.fstat(descriptor)
    if identity(opened) != identity(after):
        raise SystemExit("identity input changed while reading")
    pathname_after = os.lstat(path)
    if identity(after) != identity(pathname_after):
        raise SystemExit("identity input pathname changed while reading")
finally:
    os.close(descriptor)

print(digest.hexdigest(), opened.st_dev, opened.st_ino, sep="\t")
PY
  )" || return
  IFS=$'\t' read -r FRESH_QUALIFICATION_REGULAR_FILE_SHA256 \
    FRESH_QUALIFICATION_REGULAR_FILE_DEVICE \
    FRESH_QUALIFICATION_REGULAR_FILE_INODE <<<"$identity"
  [ "${#FRESH_QUALIFICATION_REGULAR_FILE_SHA256}" -eq 64 ] || return 2
  case "$FRESH_QUALIFICATION_REGULAR_FILE_SHA256" in
    *[!0-9a-f]*) return 2 ;;
  esac
  case "$FRESH_QUALIFICATION_REGULAR_FILE_DEVICE:$FRESH_QUALIFICATION_REGULAR_FILE_INODE" in
    *[!0-9:]*) return 2 ;;
    :*|*:|*:*:*) return 2 ;;
  esac
  export FRESH_QUALIFICATION_REGULAR_FILE_SHA256
  export FRESH_QUALIFICATION_REGULAR_FILE_DEVICE
  export FRESH_QUALIFICATION_REGULAR_FILE_INODE
}

fresh_capture_qualification_carrier_identity() {
  local carrier="$1"
  local manifest receipt payload headless identities provenance digest

  manifest="$carrier/manifest.json"
  receipt="$carrier/wasmer-build.receipt"
  payload="$carrier/payload.files"
  headless="$carrier/bin/wasmer-headless"
  fresh_verify_sealed_headless_carrier "$carrier" || return
  identities="$(
    printf '%s\t%s\t%s\t%s\n' \
      "$(fresh_wasmer_bin_hash "$manifest")" \
      "$(fresh_wasmer_bin_hash "$receipt")" \
      "$(fresh_wasmer_bin_hash "$payload")" \
      "$(fresh_wasmer_bin_hash "$headless")"
  )" || return
  IFS=$'\t' read -r FRESH_QUALIFICATION_CARRIER_MANIFEST_SHA256 \
    FRESH_QUALIFICATION_CARRIER_RECEIPT_SHA256 \
    FRESH_QUALIFICATION_CARRIER_PAYLOAD_SHA256 \
    FRESH_QUALIFICATION_CARRIER_HEADLESS_SHA256 <<<"$identities"
  for digest in \
    "$FRESH_QUALIFICATION_CARRIER_MANIFEST_SHA256" \
    "$FRESH_QUALIFICATION_CARRIER_RECEIPT_SHA256" \
    "$FRESH_QUALIFICATION_CARRIER_PAYLOAD_SHA256" \
    "$FRESH_QUALIFICATION_CARRIER_HEADLESS_SHA256"
  do
    [ "${#digest}" -eq 64 ] || return 2
    case "$digest" in
      *[!0-9a-f]*) return 2 ;;
    esac
  done
  provenance="$(python3 - "$manifest" <<'PY'
import json
import re
import sys

with open(sys.argv[1], encoding="utf-8") as stream:
    manifest = json.load(stream)
profile = manifest.get("core-profile")
recipe = manifest.get("guest-build-recipe-sha256")
if profile not in {"release-o3", "safe-o2"}:
    raise SystemExit("sealed carrier core profile differs")
if not isinstance(recipe, str) or re.fullmatch(r"[0-9a-f]{64}", recipe) is None:
    raise SystemExit("sealed carrier guest build recipe differs")
print(profile, recipe, sep="\t")
PY
  )" || return
  IFS=$'\t' read -r FRESH_QUALIFICATION_CORE_PROFILE \
    FRESH_QUALIFICATION_GUEST_BUILD_RECIPE_SHA256 <<<"$provenance"
  FRESH_QUALIFICATION_CARRIER_CLOSURE_IDENTITY="$(
    {
      printf '%s\0' oliphaunt.wasix-postmaster.qualification-carrier.v1
      printf '%s\0' "$FRESH_QUALIFICATION_CARRIER_MANIFEST_SHA256"
      printf '%s\0' "$FRESH_QUALIFICATION_CARRIER_RECEIPT_SHA256"
      printf '%s\0' "$FRESH_QUALIFICATION_CARRIER_PAYLOAD_SHA256"
      printf '%s\0' "$FRESH_QUALIFICATION_CARRIER_HEADLESS_SHA256"
    } | fresh_sha256_stream
  )" || return
  export FRESH_QUALIFICATION_CARRIER_CLOSURE_IDENTITY
  export FRESH_QUALIFICATION_CARRIER_MANIFEST_SHA256
  export FRESH_QUALIFICATION_CARRIER_RECEIPT_SHA256
  export FRESH_QUALIFICATION_CARRIER_PAYLOAD_SHA256
  export FRESH_QUALIFICATION_CARRIER_HEADLESS_SHA256
  export FRESH_QUALIFICATION_CORE_PROFILE
  export FRESH_QUALIFICATION_GUEST_BUILD_RECIPE_SHA256
}

fresh_write_native_oracle_manifest() {
  local install="$1"
  local output="$2"
  local relative path bytes digest link_target resolved
  local libpq_files=0

  [ -d "$install" ] && [ ! -L "$install" ] || {
    printf 'native install is missing or is a symlink: %s\n' "$install" >&2
    return 1
  }
  {
    printf 'schema\tkind\tpath\tbytes\tsha256_or_target\n'
    for relative in bin/postgres bin/initdb bin/psql; do
      path="$install/$relative"
      [ -f "$path" ] && [ ! -L "$path" ] && [ -x "$path" ] || {
        printf 'native oracle requires an executable regular file: %s\n' "$path" >&2
        return 1
      }
      bytes="$(wc -c <"$path" | tr -d '[:space:]')"
      digest="$(fresh_wasmer_bin_hash "$path")"
      printf 'oliphaunt.wasix-postmaster.native-oracle.v1\tfile\t%s\t%s\t%s\n' \
        "$relative" "$bytes" "$digest"
    done
    while IFS= read -r path; do
      [ -n "$path" ] || continue
      relative="${path#"$install"/}"
      case "$relative" in
        *$'\t'*|*$'\r'*|*$'\n'*)
          printf 'unsafe native libpq path: %s\n' "$relative" >&2
          return 1
          ;;
      esac
      bytes="$(wc -c <"$path" | tr -d '[:space:]')"
      digest="$(fresh_wasmer_bin_hash "$path")"
      printf 'oliphaunt.wasix-postmaster.native-oracle.v1\tfile\t%s\t%s\t%s\n' \
        "$relative" "$bytes" "$digest"
      libpq_files=$((libpq_files + 1))
    done < <(find "$install/lib" -maxdepth 1 -type f \
      \( -name 'libpq.a' -o -name 'libpq.*' \) -print | LC_ALL=C sort)
    while IFS= read -r path; do
      [ -n "$path" ] || continue
      relative="${path#"$install"/}"
      link_target="$(readlink "$path")" || return
      case "$relative:$link_target" in
        *$'\t'*|*$'\r'*|*$'\n'*|*:/*|*:*../*)
          printf 'unsafe native libpq symlink: %s -> %s\n' "$relative" "$link_target" >&2
          return 1
          ;;
      esac
      resolved="$(realpath "$path")" || return
      case "$resolved" in
        "$install"/lib/*) ;;
        *) printf 'native libpq symlink escapes install root: %s\n' "$path" >&2; return 1 ;;
      esac
      [ -f "$resolved" ] && [ ! -L "$resolved" ] || {
        printf 'native libpq symlink target is not a regular file: %s\n' "$path" >&2
        return 1
      }
      printf 'oliphaunt.wasix-postmaster.native-oracle.v1\tsymlink\t%s\t-\t%s\n' \
        "$relative" "$link_target"
    done < <(find "$install/lib" -maxdepth 1 -type l -name 'libpq*' \
      -print | LC_ALL=C sort)
  } >"$output"
  [ "$libpq_files" -gt 0 ] || {
    printf 'native oracle has no installed regular libpq artifact below %s/lib\n' \
      "$install" >&2
    return 1
  }
}

fresh_capture_native_oracle_identity() {
  local install="$1"
  local temporary_root first second

  temporary_root="$(mktemp -d)" || return
  if ! fresh_write_native_oracle_manifest "$install" "$temporary_root/first.tsv" ||
    ! fresh_write_native_oracle_manifest "$install" "$temporary_root/second.tsv" ||
    ! cmp -s "$temporary_root/first.tsv" "$temporary_root/second.tsv"; then
    printf 'native oracle changed while its verified identity was captured\n' >&2
    rm -rf -- "$temporary_root"
    return 1
  fi
  first="$(fresh_wasmer_bin_hash "$temporary_root/first.tsv")" || {
    rm -rf -- "$temporary_root"
    return 1
  }
  second="$(fresh_wasmer_bin_hash "$temporary_root/second.tsv")" || {
    rm -rf -- "$temporary_root"
    return 1
  }
  rm -rf -- "$temporary_root"
  [ "$first" = "$second" ] || return 1
  FRESH_QUALIFICATION_NATIVE_ORACLE_IDENTITY="$second"
  export FRESH_QUALIFICATION_NATIVE_ORACLE_IDENTITY
}

# Freeze the execution identity emitted by every WASIX harness invocation in a
# timed qualification lane.  The lane is invalid unless every invocation used
# the same sealed carrier, PostgreSQL guest module, and PostgreSQL profiles.
# This keeps a timed result from being composed with lifecycle/memory evidence
# produced by a different module that happened to share a carrier identity.
fresh_freeze_wasix_execution_identity() {
  local output="$1"
  local expected_carrier="$2"
  local expected_manifest="$3"
  local expected_receipt="$4"
  local expected_payload="$5"
  local expected_headless="$6"
  local expected_runtime="$7"
  local expected_runtime_sha="$8"
  local expected_durability="$9"
  shift 9
  local expected_durability_sha="$1"
  local expected_profile="$2"
  shift 2
  local report identity source_sha copied_sha pending publication_tool
  local pending_identity pending_dev pending_ino pending_size pending_sha
  local schema postgres_major runtime_mode carrier manifest receipt payload
  local headless wasmer postgres_module runtime runtime_sha durability
  local durability_sha profile
  local expected_header
  local first=1

  expected_header=$'schema_version\tpostgres_major\truntime_mode\tcarrier_closure_identity\tcarrier_manifest_sha256\tcarrier_receipt_sha256\tcarrier_payload_inventory_sha256\tcarrier_headless_sha256\twasmer_bin_sha256\tpostgres_module_sha256\truntime_footprint\truntime_footprint_sha256\tdurability_profile\tdurability_profile_sha256\tpostgres_profile_resolution_identity'
  [ "$#" -gt 0 ] || {
    echo 'no WASIX execution reports were supplied for qualification' >&2
    return 1
  }
  [ ! -e "$output" ] && [ ! -L "$output" ] || {
    printf 'WASIX execution identity output already exists: %s\n' "$output" >&2
    return 1
  }
  publication_tool="$FRESH_ROOT/lib/durable_publication.py"
  [ -f "$publication_tool" ] && [ ! -L "$publication_tool" ] || {
    printf 'missing regular durable-publication helper: %s\n' \
      "$publication_tool" >&2
    return 1
  }
  pending="$(dirname "$output")/.$(basename "$output").pending.$$"
  for report in "$@"; do
    identity="$report/execution-identity.tsv"
    [ -f "$identity" ] && [ ! -L "$identity" ] || {
      printf 'missing regular WASIX execution identity: %s\n' "$identity" >&2
      python3 "$publication_tool" discard-private "$pending" >/dev/null 2>&1 || true
      return 1
    }
    [ "$(sed -n '1p' "$identity")" = "$expected_header" ] &&
      [ "$(wc -l <"$identity" | tr -d '[:space:]')" = 2 ] || {
      printf 'unexpected WASIX execution identity schema: %s\n' "$identity" >&2
      python3 "$publication_tool" discard-private "$pending" >/dev/null 2>&1 || true
      return 1
    }
    source_sha="$(fresh_wasmer_bin_hash "$identity")" || {
      python3 "$publication_tool" discard-private "$pending" >/dev/null 2>&1 || true
      return 1
    }
    if [ "$first" -eq 1 ]; then
      if ! pending_identity="$(
        python3 "$publication_tool" write-stdin-identified "$pending" <"$identity"
      )"; then
        python3 "$publication_tool" discard-private "$pending" >/dev/null 2>&1 || true
        return 1
      fi
      copied_sha="$(fresh_wasmer_bin_hash "$pending")" || {
        python3 "$publication_tool" discard-private "$pending" >/dev/null 2>&1 || true
        return 1
      }
      first=0
    else
      copied_sha="$(fresh_wasmer_bin_hash "$pending")" || {
        python3 "$publication_tool" discard-private "$pending" >/dev/null 2>&1 || true
        return 1
      }
      python3 "$publication_tool" require-equal "$pending" "$identity" || {
        printf 'WASIX execution identity differs between timed samples: %s\n' \
          "$identity" >&2
        python3 "$publication_tool" discard-private "$pending" >/dev/null 2>&1 || true
        return 1
      }
    fi
    [ "$source_sha" = "$copied_sha" ] &&
      [ "$(fresh_wasmer_bin_hash "$identity")" = "$source_sha" ] || {
      printf 'WASIX execution identity changed while it was frozen: %s\n' \
        "$identity" >&2
      python3 "$publication_tool" discard-private "$pending" >/dev/null 2>&1 || true
      return 1
    }
  done
  IFS=$'\t' read -r schema postgres_major runtime_mode carrier manifest receipt \
    payload headless wasmer postgres_module runtime runtime_sha durability \
    durability_sha profile < <(sed -n '2p' "$pending")
  [ "$schema" = oliphaunt.wasix-postmaster.execution-identity.v1 ] &&
    [ "$postgres_major" = 18 ] && [ "$runtime_mode" = sealed-headless ] &&
    [ "$carrier" = "$expected_carrier" ] &&
    [ "$manifest" = "$expected_manifest" ] &&
    [ "$receipt" = "$expected_receipt" ] &&
    [ "$payload" = "$expected_payload" ] &&
    [ "$headless" = "$expected_headless" ] && [ "$wasmer" = "$headless" ] &&
    [ "$runtime" = "$expected_runtime" ] &&
    [ "$runtime_sha" = "$expected_runtime_sha" ] &&
    [ "$durability" = "$expected_durability" ] &&
    [ "$durability_sha" = "$expected_durability_sha" ] &&
    [ "$profile" = "$expected_profile" ] || {
    echo 'WASIX execution identity differs from frozen qualification inputs' >&2
    python3 "$publication_tool" discard-private "$pending" >/dev/null 2>&1 || true
    return 1
  }
  for source_sha in "$carrier" "$manifest" "$receipt" "$payload" "$headless" \
    "$wasmer" "$postgres_module"; do
    if [ "${#source_sha}" -ne 64 ]; then
      echo 'WASIX execution identity contains a malformed SHA-256' >&2
      python3 "$publication_tool" discard-private "$pending" >/dev/null 2>&1 || true
      return 1
    fi
    case "$source_sha" in
      *[!0-9a-f]*)
        echo 'WASIX execution identity contains a malformed SHA-256' >&2
        python3 "$publication_tool" discard-private "$pending" >/dev/null 2>&1 || true
        return 1
        ;;
    esac
  done
  for source_sha in "$runtime_sha" "$durability_sha" "$profile"; do
    [ "$source_sha" = none ] && continue
    [ "${#source_sha}" -eq 64 ] || {
      echo 'WASIX execution identity contains a malformed profile SHA-256' >&2
      python3 "$publication_tool" discard-private "$pending" >/dev/null 2>&1 || true
      return 1
    }
    case "$source_sha" in
      *[!0-9a-f]*)
        echo 'WASIX execution identity contains a malformed profile SHA-256' >&2
        python3 "$publication_tool" discard-private "$pending" >/dev/null 2>&1 || true
        return 1
        ;;
    esac
  done
  IFS=$'\t' read -r pending_dev pending_ino pending_size pending_sha \
    <<<"$pending_identity"
  if ! python3 "$publication_tool" publish-identified "$pending" "$output" \
    "$pending_dev" "$pending_ino" "$pending_size" "$pending_sha"; then
    python3 "$publication_tool" discard-private "$pending" >/dev/null 2>&1 || true
    return 1
  fi
  FRESH_QUALIFICATION_EXECUTION_IDENTITY_SHA256="$(fresh_wasmer_bin_hash "$output")"
  FRESH_QUALIFICATION_POSTGRES_MODULE_SHA256="$postgres_module"
  FRESH_QUALIFICATION_WASMER_BIN_SHA256="$wasmer"
  export FRESH_QUALIFICATION_EXECUTION_IDENTITY_SHA256
  export FRESH_QUALIFICATION_POSTGRES_MODULE_SHA256
  export FRESH_QUALIFICATION_WASMER_BIN_SHA256
}
