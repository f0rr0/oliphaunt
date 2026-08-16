#!/usr/bin/env bash

# Versioned PostgreSQL profile resolution for product-owned runtime-footprint
# and durability contracts. Source this after lib/common.sh.

FRESH_POSTGRES_RUNTIME_FOOTPRINT_ID=""
FRESH_POSTGRES_RUNTIME_FOOTPRINT_PATH=""
FRESH_POSTGRES_RUNTIME_FOOTPRINT_SHA256=""
FRESH_POSTGRES_DURABILITY_ID=""
FRESH_POSTGRES_DURABILITY_PATH=""
FRESH_POSTGRES_DURABILITY_SHA256=""
FRESH_POSTGRES_PROFILE_GUCS=()
FRESH_POSTGRES_PROFILE_EVIDENCE_ROWS=()
FRESH_POSTGRES_PROFILE_INPUT_ROWS=()
FRESH_POSTGRES_PROFILE_OVERLAPPING_EXPLICIT=()
FRESH_POSTGRES_PROFILE_RESOLUTION_IDENTITY=""

fresh_postgres_runtime_footprint_file() {
  case "${1:-}" in
    embedded-concurrent)
      printf '%s/profiles/runtime-footprints/embedded-concurrent-v1.gucs\n' \
        "$FRESH_ROOT"
      ;;
    *)
      printf 'unknown PostgreSQL runtime footprint: %s\n' "${1:-}" >&2
      return 2
      ;;
  esac
}

fresh_postgres_durability_file() {
  case "${1:-}" in
    safe)
      printf '%s/profiles/durability/safe-v1.gucs\n' "$FRESH_ROOT"
      ;;
    *)
      printf 'unknown PostgreSQL durability profile: %s\n' "${1:-}" >&2
      return 2
      ;;
  esac
}

fresh_postgres_profile_file_rows() {
  local kind="$1"
  local profile_id="$2"
  local path="$3"
  local digest="$4"
  local precedence line name value last_byte seen=" " line_number=0

  case "$kind" in
    runtime-footprint) precedence=1 ;;
    durability) precedence=2 ;;
    *) printf 'invalid PostgreSQL profile kind: %s\n' "$kind" >&2; return 2 ;;
  esac
  [ -f "$path" ] && [ ! -L "$path" ] || {
    printf 'PostgreSQL profile must be a regular non-symlink file: %s\n' \
      "$path" >&2
    return 2
  }
  [ -s "$path" ] || {
    printf 'PostgreSQL profile must not be empty: %s\n' "$path" >&2
    return 2
  }
  last_byte="$(tail -c 1 "$path" | od -An -t u1 | tr -d '[:space:]')"
  [ "$last_byte" = 10 ] || {
    printf 'PostgreSQL profile must end with a newline: %s\n' "$path" >&2
    return 2
  }
  while IFS= read -r line; do
    line_number=$((line_number + 1))
    if [ -z "$line" ] ||
      LC_ALL=C printf '%s' "$line" | grep -q '[[:cntrl:]]'; then
      printf 'invalid control/blank line in PostgreSQL profile %s:%s\n' \
        "$path" "$line_number" >&2
      return 2
    fi
    case "$line" in
      *=*) ;;
      *) printf 'PostgreSQL profile requires name=value at %s:%s\n' \
           "$path" "$line_number" >&2; return 2 ;;
    esac
    name="${line%%=*}"
    value="${line#*=}"
    [[ "$name" =~ ^[a-z][a-z0-9_]*$ ]] || {
      printf 'invalid PostgreSQL profile setting name at %s:%s: %s\n' \
        "$path" "$line_number" "$name" >&2
      return 2
    }
    case "$value" in
      ""|[[:space:]]*|*[[:space:]])
        printf 'invalid empty/edge-whitespace profile value at %s:%s\n' \
          "$path" "$line_number" >&2
        return 2
        ;;
    esac
    case "$seen" in
      *" $name "*)
        printf 'duplicate PostgreSQL profile setting at %s:%s: %s\n' \
          "$path" "$line_number" "$name" >&2
        return 2
        ;;
    esac
    seen="$seen$name "
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
      "$name" "$value" "$kind" "$profile_id" "$path" "$digest" \
      "$precedence"
  done <"$path"
}

fresh_postgres_explicit_rows() {
  local seen=" " guc name value

  for guc in "$@"; do
    if [ -z "$guc" ] ||
      LC_ALL=C printf '%s' "$guc" | grep -q '[[:cntrl:]]'; then
      printf 'invalid control/empty explicit PostgreSQL setting\n' >&2
      return 2
    fi
    case "$guc" in
      *=*) ;;
      *) printf -- '--postgres-guc requires name=value, got: %s\n' "$guc" >&2; return 2 ;;
    esac
    name="${guc%%=*}"
    value="${guc#*=}"
    [[ "$name" =~ ^[a-z][a-z0-9_]*$ ]] || {
      printf 'invalid explicit PostgreSQL setting name: %s\n' "$name" >&2
      return 2
    }
    case "$value" in
      ""|[[:space:]]*|*[[:space:]])
        printf 'invalid empty/edge-whitespace explicit PostgreSQL value: %s\n' \
          "$name" >&2
        return 2
        ;;
    esac
    case "$seen" in
      *" $name "*) printf 'duplicate explicit PostgreSQL setting: %s\n' "$name" >&2; return 2 ;;
    esac
    seen="$seen$name "
    printf '%s\t%s\texplicit\t\t\t\t3\n' "$name" "$value"
  done
}

fresh_resolve_postgres_profiles() {
  local runtime_id="$1"
  local durability_id="$2"
  shift 2
  local path digest rows all_rows="" profile_names=" " row name source
  local kind profile_id profile_digest

  FRESH_POSTGRES_RUNTIME_FOOTPRINT_ID="$runtime_id"
  FRESH_POSTGRES_RUNTIME_FOOTPRINT_PATH=""
  FRESH_POSTGRES_RUNTIME_FOOTPRINT_SHA256=""
  FRESH_POSTGRES_DURABILITY_ID="$durability_id"
  FRESH_POSTGRES_DURABILITY_PATH=""
  FRESH_POSTGRES_DURABILITY_SHA256=""
  FRESH_POSTGRES_PROFILE_GUCS=()
  FRESH_POSTGRES_PROFILE_EVIDENCE_ROWS=()
  FRESH_POSTGRES_PROFILE_INPUT_ROWS=()
  FRESH_POSTGRES_PROFILE_OVERLAPPING_EXPLICIT=()
  FRESH_POSTGRES_PROFILE_RESOLUTION_IDENTITY=""

  if [ -n "$runtime_id" ]; then
    path="$(fresh_postgres_runtime_footprint_file "$runtime_id")" || return
    [ -f "$path" ] && [ ! -L "$path" ] || {
      printf 'PostgreSQL runtime footprint is not regular: %s\n' "$path" >&2
      return 2
    }
    digest="$(fresh_wasmer_bin_hash "$path")" || return
    rows="$(fresh_postgres_profile_file_rows \
      runtime-footprint "$runtime_id" "$path" "$digest")" || return
    FRESH_POSTGRES_RUNTIME_FOOTPRINT_PATH="$path"
    FRESH_POSTGRES_RUNTIME_FOOTPRINT_SHA256="$digest"
    FRESH_POSTGRES_PROFILE_INPUT_ROWS+=("runtime-footprint"$'\t'"$runtime_id"$'\t'"$path"$'\t'"$digest")
    all_rows="$rows"
  fi
  if [ -n "$durability_id" ]; then
    path="$(fresh_postgres_durability_file "$durability_id")" || return
    [ -f "$path" ] && [ ! -L "$path" ] || {
      printf 'PostgreSQL durability profile is not regular: %s\n' "$path" >&2
      return 2
    }
    digest="$(fresh_wasmer_bin_hash "$path")" || return
    rows="$(fresh_postgres_profile_file_rows \
      durability "$durability_id" "$path" "$digest")" || return
    FRESH_POSTGRES_DURABILITY_PATH="$path"
    FRESH_POSTGRES_DURABILITY_SHA256="$digest"
    FRESH_POSTGRES_PROFILE_INPUT_ROWS+=("durability"$'\t'"$durability_id"$'\t'"$path"$'\t'"$digest")
    [ -z "$all_rows" ] || all_rows+=$'\n'
    all_rows+="$rows"
  fi
  rows="$(fresh_postgres_explicit_rows "$@")" || return
  if [ -n "$rows" ]; then
    [ -z "$all_rows" ] || all_rows+=$'\n'
    all_rows+="$rows"
  fi
  [ -n "$all_rows" ] || return 0

  while IFS=$'\t' read -r name _ source _; do
    [ "$source" = explicit ] && continue
    case "$profile_names" in *" $name "*) ;; *) profile_names="$profile_names$name " ;; esac
  done <<<"$all_rows"
  for row in "$@"; do
    name="${row%%=*}"
    case "$profile_names" in
      *" $name "*) FRESH_POSTGRES_PROFILE_OVERLAPPING_EXPLICIT+=("$name") ;;
    esac
  done

  while IFS= read -r row; do
    [ -n "$row" ] || continue
    FRESH_POSTGRES_PROFILE_EVIDENCE_ROWS+=("$row")
    IFS=$'\t' read -r name value _ <<<"$row"
    FRESH_POSTGRES_PROFILE_GUCS+=("$name=$value")
  done < <(
    printf '%s\n' "$all_rows" | awk -F '\t' '
      NF != 7 { exit 2 }
      { final[$1] = $0 }
      END { for (name in final) print final[name] }
    ' | LC_ALL=C sort -t $'\t' -k1,1
  )
  fresh_assert_postgres_profile_inputs
  # Public result consumed by callers that source this library.
  # shellcheck disable=SC2034
  FRESH_POSTGRES_PROFILE_RESOLUTION_IDENTITY="$(
    {
      printf 'schema\t%s\n' \
        oliphaunt.wasix-postmaster.postgres-profile-resolution.v1
      for row in "${FRESH_POSTGRES_PROFILE_INPUT_ROWS[@]}"; do
        IFS=$'\t' read -r kind profile_id path profile_digest <<<"$row"
        printf 'input\t%s\t%s\t%s\n' \
          "$kind" "$profile_id" "$profile_digest"
      done
      if [ "${#FRESH_POSTGRES_PROFILE_EVIDENCE_ROWS[@]}" -gt 0 ]; then
        printf '%s\n' "${FRESH_POSTGRES_PROFILE_EVIDENCE_ROWS[@]}" |
          awk -F '\t' -v OFS='\t' \
            '{ print "setting", $1, $2, $3, $4, $6, $7 }'
      fi
    } | fresh_sha256_stream
  )"
}

fresh_assert_postgres_profile_inputs() {
  local path digest

  if [ -n "$FRESH_POSTGRES_RUNTIME_FOOTPRINT_ID" ]; then
    path="$FRESH_POSTGRES_RUNTIME_FOOTPRINT_PATH"
    digest="$FRESH_POSTGRES_RUNTIME_FOOTPRINT_SHA256"
    [ -f "$path" ] && [ ! -L "$path" ] &&
      [ "$(fresh_wasmer_bin_hash "$path")" = "$digest" ] || {
        printf 'PostgreSQL runtime footprint identity changed: %s\n' "$path" >&2
        return 1
      }
  fi
  if [ -n "$FRESH_POSTGRES_DURABILITY_ID" ]; then
    path="$FRESH_POSTGRES_DURABILITY_PATH"
    digest="$FRESH_POSTGRES_DURABILITY_SHA256"
    [ -f "$path" ] && [ ! -L "$path" ] &&
      [ "$(fresh_wasmer_bin_hash "$path")" = "$digest" ] || {
        printf 'PostgreSQL durability profile identity changed: %s\n' "$path" >&2
        return 1
      }
  fi
}

fresh_write_postgres_profile_evidence() {
  local inputs="$1"
  local resolution="$2"
  local inputs_exists=0 resolution_exists=0
  local pending_inputs pending_resolution publication_tool row
  local inputs_identity inputs_dev inputs_ino inputs_size inputs_sha
  local resolution_identity resolution_dev resolution_ino resolution_size resolution_sha
  local publication_pairs=()

  if [ -e "$inputs" ] || [ -L "$inputs" ]; then
    [ -f "$inputs" ] && [ ! -L "$inputs" ] || {
      printf 'PostgreSQL profile input evidence is not regular: %s\n' "$inputs" >&2
      return 2
    }
    inputs_exists=1
  fi
  if [ -e "$resolution" ] || [ -L "$resolution" ]; then
    [ -f "$resolution" ] && [ ! -L "$resolution" ] || {
      printf 'PostgreSQL profile resolution evidence is not regular: %s\n' \
        "$resolution" >&2
      return 2
    }
    resolution_exists=1
  fi
  if [ "$inputs_exists" -eq 1 ] && [ "$resolution_exists" -eq 1 ]; then
    printf 'refusing to replace PostgreSQL profile evidence\n' >&2
    return 2
  fi
  [ -d "$(dirname "$inputs")" ] && [ -d "$(dirname "$resolution")" ] || return 2
  publication_tool="$FRESH_ROOT/lib/durable_publication.py"
  [ -f "$publication_tool" ] && [ ! -L "$publication_tool" ] || {
    printf 'missing regular durable-publication helper: %s\n' \
      "$publication_tool" >&2
    return 2
  }
  fresh_assert_postgres_profile_inputs || return
  pending_inputs="$(dirname "$inputs")/.$(basename "$inputs").pending.$$"
  pending_resolution="$(dirname "$resolution")/.$(basename "$resolution").pending.$$"
  if ! inputs_identity="$({
    printf 'kind\tid\tpath\tsha256\n'
    for row in "${FRESH_POSTGRES_PROFILE_INPUT_ROWS[@]}"; do printf '%s\n' "$row"; done
  } | python3 "$publication_tool" write-stdin-identified "$pending_inputs")"; then
    python3 "$publication_tool" discard-private "$pending_inputs" >/dev/null 2>&1 || true
    return 1
  fi
  if ! resolution_identity="$({
    printf 'name\tvalue\tsource\tprofile_id\tprofile_path\tprofile_sha256\tprecedence\n'
    for row in "${FRESH_POSTGRES_PROFILE_EVIDENCE_ROWS[@]}"; do printf '%s\n' "$row"; done
  } | python3 "$publication_tool" write-stdin-identified "$pending_resolution")"; then
    python3 "$publication_tool" discard-private "$pending_inputs" >/dev/null 2>&1 || true
    python3 "$publication_tool" discard-private "$pending_resolution" >/dev/null 2>&1 || true
    return 1
  fi
  if ! fresh_assert_postgres_profile_inputs; then
    python3 "$publication_tool" discard-private "$pending_inputs" >/dev/null 2>&1 || true
    python3 "$publication_tool" discard-private "$pending_resolution" >/dev/null 2>&1 || true
    return 1
  fi
  IFS=$'\t' read -r inputs_dev inputs_ino inputs_size inputs_sha \
    <<<"$inputs_identity"
  IFS=$'\t' read -r resolution_dev resolution_ino resolution_size resolution_sha \
    <<<"$resolution_identity"
  publication_pairs=(
    "$pending_inputs" "$inputs" "$inputs_dev" "$inputs_ino" "$inputs_size" "$inputs_sha"
    "$pending_resolution" "$resolution" "$resolution_dev" "$resolution_ino" "$resolution_size" "$resolution_sha"
  )
  # Validate an already-admitted half before creating the missing half. This
  # makes an interrupted pair recoverable without admitting new evidence next
  # to a conflicting or unsealed prior member.
  if [ "$resolution_exists" -eq 1 ]; then
    publication_pairs=(
      "$pending_resolution" "$resolution" "$resolution_dev" "$resolution_ino" "$resolution_size" "$resolution_sha"
      "$pending_inputs" "$inputs" "$inputs_dev" "$inputs_ino" "$inputs_size" "$inputs_sha"
    )
  fi
  if ! python3 "$publication_tool" publish-set-identified "${publication_pairs[@]}"; then
    python3 "$publication_tool" discard-private "$pending_inputs" >/dev/null 2>&1 || true
    python3 "$publication_tool" discard-private "$pending_resolution" >/dev/null 2>&1 || true
    return 1
  fi
}

fresh_postgres_profile_expected_settings() {
  local overlap=" " name
  for name in "${FRESH_POSTGRES_PROFILE_OVERLAPPING_EXPLICIT[@]}"; do
    overlap="$overlap$name "
  done
  if [ "$FRESH_POSTGRES_RUNTIME_FOOTPRINT_ID" = embedded-concurrent ]; then
    case "$overlap" in *' autovacuum_worker_slots '*) ;; *) printf 'autovacuum_worker_slots\t4\t\n' ;; esac
    case "$overlap" in *' io_method '*) ;; *) printf 'io_method\tsync\t\n' ;; esac
    case "$overlap" in *' shared_buffers '*) ;; *) printf 'shared_buffers\t4096\t8kB\n' ;; esac
    case "$overlap" in *' max_connections '*) ;; *) printf 'max_connections\t8\t\n' ;; esac
    case "$overlap" in *' max_wal_senders '*) ;; *) printf 'max_wal_senders\t10\t\n' ;; esac
    case "$overlap" in *' max_worker_processes '*) ;; *) printf 'max_worker_processes\t8\t\n' ;; esac
  fi
  if [ "$FRESH_POSTGRES_DURABILITY_ID" = safe ]; then
    case "$overlap" in *' fsync '*) ;; *) printf 'fsync\ton\t\n' ;; esac
    case "$overlap" in *' full_page_writes '*) ;; *) printf 'full_page_writes\ton\t\n' ;; esac
    case "$overlap" in *' synchronous_commit '*) ;; *) printf 'synchronous_commit\ton\t\n' ;; esac
  fi
}

fresh_validate_postgres_profile_settings() {
  local settings="$1"
  local output="$2"
  local expected pending publication_tool status pending_identity
  local pending_dev pending_ino pending_size pending_sha

  [ -f "$settings" ] && [ ! -L "$settings" ] || {
    printf 'effective PostgreSQL settings are not a regular file: %s\n' "$settings" >&2
    return 1
  }
  [ ! -e "$output" ] && [ ! -L "$output" ] || {
    printf 'refusing to replace PostgreSQL profile validation: %s\n' "$output" >&2
    return 2
  }
  publication_tool="$FRESH_ROOT/lib/durable_publication.py"
  [ -f "$publication_tool" ] && [ ! -L "$publication_tool" ] || {
    printf 'missing regular durable-publication helper: %s\n' \
      "$publication_tool" >&2
    return 2
  }
  expected="$(fresh_postgres_profile_expected_settings | LC_ALL=C sort)"
  [ -n "$expected" ] || {
    printf 'no named PostgreSQL profile settings to validate\n' >&2
    return 2
  }
  pending="$(dirname "$output")/.$(basename "$output").pending.$$"
  if pending_identity="$(awk -F '\t' -v OFS='\t' '
    NR == FNR {
      count++
      rows[count] = $0
      wanted[$1] = 1
      expected_setting[$1] = $2
      expected_unit[$1] = $3
      next
    }
    FNR == 1 {
      print "name", "expected_setting", "expected_unit", "observed_setting", "observed_unit", "source", "status"
      if ($0 != "name\tsetting\tunit\tsource") malformed = 1
      next
    }
    {
      if (NF != 4 || seen[$1]++) malformed = 1
      setting[$1] = $2
      unit[$1] = $3
      source[$1] = $4
    }
    END {
      failed = malformed
      for (i = 1; i <= count; i++) {
        split(rows[i], field, "\t")
        name = field[1]
        status = (seen[name] == 1 && setting[name] == expected_setting[name] &&
          unit[name] == expected_unit[name] && source[name] == "command line") ? "matched" : "mismatched"
        if (status != "matched") failed = 1
        print name, expected_setting[name], expected_unit[name], setting[name], unit[name], source[name], status
      }
      exit failed ? 1 : 0
    }
  ' <(printf '%s\n' "$expected") "$settings" |
    python3 "$publication_tool" write-stdin-identified "$pending")"; then
    status=0
  else
    status=$?
  fi
  if [ "$status" -gt 1 ] || [ ! -f "$pending" ] || [ -L "$pending" ]; then
    python3 "$publication_tool" discard-private "$pending" >/dev/null 2>&1 || true
    return 2
  fi
  IFS=$'\t' read -r pending_dev pending_ino pending_size pending_sha \
    <<<"$pending_identity"
  if ! python3 "$publication_tool" publish-identified "$pending" "$output" \
    "$pending_dev" "$pending_ino" "$pending_size" "$pending_sha"; then
    python3 "$publication_tool" discard-private "$pending" >/dev/null 2>&1 || true
    return 2
  fi
  return "$status"
}
