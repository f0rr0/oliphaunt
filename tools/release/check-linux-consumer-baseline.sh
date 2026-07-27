#!/usr/bin/env bash
set -euo pipefail

root="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "check-linux-consumer-baseline.sh: must run inside the Oliphaunt git checkout" >&2
  exit 1
}

fail() {
  echo "check-linux-consumer-baseline.sh: $*" >&2
  exit 1
}

require() {
  command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"
}

target=""
consumer_root=""
library_roots=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --target)
      [ "$#" -ge 2 ] || fail "--target requires a value"
      target="$2"
      shift 2
      ;;
    --root)
      [ "$#" -ge 2 ] || fail "--root requires a value"
      consumer_root="$2"
      shift 2
      ;;
    --library-root)
      [ "$#" -ge 2 ] || fail "--library-root requires a value"
      library_roots+=("$2")
      shift 2
      ;;
    *) fail "unknown argument: $1" ;;
  esac
done
[ -n "$target" ] || fail "--target is required"
[ -n "$consumer_root" ] || fail "--root is required"

if [ "$(uname -s)" != "Linux" ]; then
  fail "the Linux consumer baseline rehearsal must run on Linux"
fi
case "$(uname -m)" in
  x86_64|amd64) host_target="linux-x64-gnu" ;;
  aarch64|arm64) host_target="linux-arm64-gnu" ;;
  *) fail "unsupported Linux architecture $(uname -m)" ;;
esac
[ "$target" = "$host_target" ] || fail "target $target does not match host $host_target"

# Fedora 39 is deliberately retained only as a reproducible glibc 2.38 ABI
# rehearsal fixture. It is end-of-life and is not a supported-production-OS or
# security-maintenance claim. The multi-architecture OCI index is immutable.
readonly image="fedora@sha256:d63d63fe593749a5e8dbc8152427d40bbe0ece53d884e00e5f3b44859efa5077"
readonly expected_glibc="glibc 2.38"

case "$consumer_root" in
  /*) ;;
  *) consumer_root="$root/$consumer_root" ;;
esac
[ -d "$consumer_root" ] || fail "consumer root is missing or not a directory: $consumer_root"
consumer_root="$(cd "$consumer_root" && pwd -P)"
case "$consumer_root" in
  "$root/target"/*) ;;
  *) fail "consumer root must be below $root/target" ;;
esac

for index in "${!library_roots[@]}"; do
  library_root="${library_roots[$index]}"
  case "$library_root" in
    /*) ;;
    *) library_root="$root/$library_root" ;;
  esac
  [ -d "$library_root" ] || fail "library root is missing or not a directory: $library_root"
  library_root="$(cd "$library_root" && pwd -P)"
  case "$library_root" in
    "$root/target"/*) ;;
    *) fail "library root must be below $root/target" ;;
  esac
  library_roots[index]="$library_root"
done

require docker
require grep
require timeout

if ! docker image inspect "$image" >/dev/null 2>&1; then
  pulled=0
  for attempt in 1 2 3; do
    if timeout 180 docker pull "$image"; then
      pulled=1
      break
    fi
    if [ "$attempt" -lt 3 ]; then
      sleep "$attempt"
    fi
  done
  [ "$pulled" -eq 1 ] || fail "could not pull pinned Linux ABI rehearsal image after 3 attempts"
fi

repo_digests="$(docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$image")"
if ! grep -Fxq "docker.io/library/$image" <<<"$repo_digests" \
  && ! grep -Fxq "$image" <<<"$repo_digests"; then
  fail "local Linux ABI rehearsal image does not report the required pinned digest"
fi

volume_args=(--volume "$consumer_root:/consumer:ro")
for index in "${!library_roots[@]}"; do
  volume_args+=(--volume "${library_roots[index]}:/dependencies/$index:ro")
done

# shellcheck disable=SC2016 # evaluated inside the pinned container
timeout 300 docker run \
  --rm \
  --pull never \
  --network none \
  --read-only \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --user "$(id -u):$(id -g)" \
  --tmpfs /tmp:rw,nosuid,nodev \
  --env "EXPECTED_GLIBC=$expected_glibc" \
  "${volume_args[@]}" \
  --workdir /consumer \
  "$image" \
  bash -euo pipefail -c '
    observed_glibc="$(getconf GNU_LIBC_VERSION)"
    if [ "$observed_glibc" != "$EXPECTED_GLIBC" ]; then
      echo "Linux ABI fixture drifted: expected $EXPECTED_GLIBC, observed $observed_glibc" >&2
      exit 1
    fi

    search_roots=(/consumer)
    if [ -d /dependencies ]; then
      search_roots+=(/dependencies)
    fi
    library_path=/consumer
    while IFS= read -r directory; do
      [ -n "$directory" ] || continue
      library_path="$library_path:$directory"
    done < <(find "${search_roots[@]}" -type f -name "*.so*" -printf "%h\n" | sort -u)
    export LD_LIBRARY_PATH="$library_path"

    elf_count=0
    execution_count=0
    while IFS= read -r -d "" file; do
      magic="$(od -An -N4 -tx1 "$file" | tr -d " \n")"
      [ "$magic" = "7f454c46" ] || continue
      elf_count=$((elf_count + 1))
      elf_type="$(od -An -j16 -N2 -tx1 "$file" | tr -d " \n")"
      if [ "$elf_type" = "0100" ]; then
        continue
      fi
      case "$elf_type" in
        0200|0300) ;;
        *)
          echo "unsupported ELF type $elf_type in $file" >&2
          exit 1
          ;;
      esac

      dependencies="$(ldd "$file" 2>&1)"
      if grep -Eq "(^|[[:space:]])not found([[:space:]]|$)|version .+ not found" <<<"$dependencies"; then
        echo "baseline loader rejected $file:" >&2
        echo "$dependencies" >&2
        exit 1
      fi

      case "${file##*/}" in
        oliphaunt-broker)
          set +e
          output="$(timeout 10 "$file" --oliphaunt-linux-abi-probe 2>&1)"
          code=$?
          set -e
          [ "$code" -eq 2 ]
          [ "$output" = "OLIPHAUNT_BROKER_ERROR unknown broker argument '\''--oliphaunt-linux-abi-probe'\''" ]
          execution_count=$((execution_count + 1))
          ;;
        initdb|pg_ctl|pg_dump|postgres|psql)
          timeout 10 "$file" --version >/dev/null
          execution_count=$((execution_count + 1))
          ;;
      esac
    done < <(find /consumer -type f -print0)

    [ "$elf_count" -gt 0 ] || {
      echo "consumer tree contains no ELF files" >&2
      exit 1
    }
    echo "Linux consumer ABI rehearsal passed: glibc=$observed_glibc ELF=$elf_count executed=$execution_count"
  '
