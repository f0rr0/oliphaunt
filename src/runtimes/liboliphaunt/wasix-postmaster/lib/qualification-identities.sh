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
