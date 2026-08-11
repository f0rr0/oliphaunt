#!/usr/bin/env bash

set -euo pipefail

usage() {
  printf 'usage: %s SMAPS MAPPINGS_TSV CATEGORIES_TSV\n' "${0##*/}" >&2
  exit 64
}

[ "$#" -eq 3 ] || usage

SMAPS_PATH="$1"
MAPPINGS_OUT="$2"
CATEGORIES_OUT="$3"

[ -r "$SMAPS_PATH" ] || {
  printf 'smaps summary: input is not readable: %s\n' "$SMAPS_PATH" >&2
  exit 66
}
[ "$SMAPS_PATH" != "$MAPPINGS_OUT" ] || {
  printf 'smaps summary: mappings output must not overwrite the input\n' >&2
  exit 64
}
[ "$SMAPS_PATH" != "$CATEGORIES_OUT" ] || {
  printf 'smaps summary: categories output must not overwrite the input\n' >&2
  exit 64
}
[ "$MAPPINGS_OUT" != "$CATEGORIES_OUT" ] || {
  printf 'smaps summary: output paths must be distinct\n' >&2
  exit 64
}

MAPPINGS_DIR="$(dirname "$MAPPINGS_OUT")"
CATEGORIES_DIR="$(dirname "$CATEGORIES_OUT")"
[ -d "$MAPPINGS_DIR" ] || {
  printf 'smaps summary: mappings output directory does not exist: %s\n' "$MAPPINGS_DIR" >&2
  exit 73
}
[ -d "$CATEGORIES_DIR" ] || {
  printf 'smaps summary: categories output directory does not exist: %s\n' "$CATEGORIES_DIR" >&2
  exit 73
}

MAPPINGS_TMP="$(mktemp "$MAPPINGS_DIR/.smaps-mappings.XXXXXX")"
CATEGORIES_TMP="$(mktemp "$CATEGORIES_DIR/.smaps-categories.XXXXXX")"
cleanup() {
  rm -f "$MAPPINGS_TMP" "$CATEGORIES_TMP"
}
trap cleanup EXIT HUP INT TERM

awk -v mappings_out="$MAPPINGS_TMP" -v categories_out="$CATEGORIES_TMP" '
BEGIN {
  OFS = "\t"
  category_order = "postgres-shared stack heap anonymous-exec anonymous-rw anonymous-reserved anonymous-other file-executable file-backed"
  category_count = split(category_order, categories, " ")

  print "category", "address", "perms", "offset", "device", "inode", "pathname", \
    "size_kb", "rss_kb", "pss_kb", "private_kb", "shared_kb", \
    "anonymous_kb", "swap_kb" > mappings_out
}

function reset_metrics() {
  size_kb = 0
  rss_kb = 0
  pss_kb = 0
  private_clean_kb = 0
  private_dirty_kb = 0
  private_hugetlb_kb = 0
  shared_clean_kb = 0
  shared_dirty_kb = 0
  shared_hugetlb_kb = 0
  anonymous_kb = 0
  swap_kb = 0
}

function mapping_category(path, mapping_perms, lowered_path, anonymous_mapping) {
  lowered_path = tolower(path)
  if (lowered_path ~ /postgresql-wasix/ || lowered_path ~ /(^|\/)postgresql\./) {
    return "postgres-shared"
  }
  if (path ~ /^\[stack(:[^]]+)?\]$/) {
    return "stack"
  }
  if (path == "[heap]") {
    return "heap"
  }

  anonymous_mapping = (path == "" || path ~ /^\[/)
  if (anonymous_mapping && mapping_perms ~ /x/) {
    return "anonymous-exec"
  }
  if (anonymous_mapping && mapping_perms ~ /^---[ps]$/) {
    return "anonymous-reserved"
  }
  if (anonymous_mapping && mapping_perms ~ /w/) {
    return "anonymous-rw"
  }
  if (anonymous_mapping) {
    return "anonymous-other"
  }
  if (mapping_perms ~ /x/) {
    return "file-executable"
  }
  return "file-backed"
}

function flush_mapping(  category, private_kb, shared_kb) {
  if (!have_mapping) {
    return
  }

  category = mapping_category(pathname, perms)
  private_kb = private_clean_kb + private_dirty_kb + private_hugetlb_kb
  shared_kb = shared_clean_kb + shared_dirty_kb + shared_hugetlb_kb

  print category, address, perms, offset, device, inode, pathname, \
    size_kb, rss_kb, pss_kb, private_kb, shared_kb, anonymous_kb, \
    swap_kb > mappings_out

  mappings[category]++
  sizes[category] += size_kb
  rss[category] += rss_kb
  pss[category] += pss_kb
  private_pages[category] += private_kb
  shared_pages[category] += shared_kb
  anonymous_pages[category] += anonymous_kb
  swaps[category] += swap_kb

  total_mappings++
  total_size += size_kb
  total_rss += rss_kb
  total_pss += pss_kb
  total_private += private_kb
  total_shared += shared_kb
  total_anonymous += anonymous_kb
  total_swap += swap_kb
}

$1 ~ /^[[:xdigit:]]+-[[:xdigit:]]+$/ && $2 ~ /^[r-][w-][x-][ps]$/ && NF >= 5 {
  flush_mapping()

  address = $1
  perms = $2
  offset = $3
  device = $4
  inode = $5
  pathname = ""
  for (field = 6; field <= NF; field++) {
    if (field > 6) {
      pathname = pathname " "
    }
    pathname = pathname $field
  }
  gsub(/[\t\r\n]/, " ", pathname)
  reset_metrics()
  have_mapping = 1
  next
}

have_mapping && $1 == "Size:"             { size_kb = $2 + 0; next }
have_mapping && $1 == "Rss:"              { rss_kb = $2 + 0; next }
have_mapping && $1 == "Pss:"              { pss_kb = $2 + 0; next }
have_mapping && $1 == "Private_Clean:"    { private_clean_kb = $2 + 0; next }
have_mapping && $1 == "Private_Dirty:"    { private_dirty_kb = $2 + 0; next }
have_mapping && $1 == "Private_Hugetlb:"  { private_hugetlb_kb = $2 + 0; next }
have_mapping && $1 == "Shared_Clean:"     { shared_clean_kb = $2 + 0; next }
have_mapping && $1 == "Shared_Dirty:"     { shared_dirty_kb = $2 + 0; next }
have_mapping && $1 == "Shared_Hugetlb:"   { shared_hugetlb_kb = $2 + 0; next }
have_mapping && $1 == "Anonymous:"        { anonymous_kb = $2 + 0; next }
have_mapping && $1 == "Swap:"             { swap_kb = $2 + 0; next }

END {
  flush_mapping()
  if (total_mappings == 0) {
    print "smaps summary: no mapping records found" > "/dev/stderr"
    exit 65
  }

  print "category", "mappings", "size_kb", "rss_kb", "pss_kb", \
    "private_kb", "shared_kb", "anonymous_kb", "swap_kb" > categories_out
  for (category_index = 1; category_index <= category_count; category_index++) {
    category = categories[category_index]
    print category, mappings[category] + 0, sizes[category] + 0, \
      rss[category] + 0, pss[category] + 0, private_pages[category] + 0, \
      shared_pages[category] + 0, anonymous_pages[category] + 0, \
      swaps[category] + 0 > categories_out
  }
  print "total", total_mappings, total_size, total_rss, total_pss, \
    total_private, total_shared, total_anonymous, total_swap > categories_out
}
' "$SMAPS_PATH"

mv "$MAPPINGS_TMP" "$MAPPINGS_OUT"
mv "$CATEGORIES_TMP" "$CATEGORIES_OUT"
trap - EXIT HUP INT TERM
