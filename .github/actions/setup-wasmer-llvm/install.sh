#!/usr/bin/env bash
set -euo pipefail

: "${LLVM_URL:?LLVM_URL is required}"
: "${LLVM_SHA256:?LLVM_SHA256 is required}"
: "${LLVM_BYTES:?LLVM_BYTES is required}"
: "${LLVM_VERSION:?LLVM_VERSION is required}"
: "${CACHE_KEY:?CACHE_KEY is required}"
: "${ACTION_PATH:?ACTION_PATH is required}"
: "${RUNNER_TEMP:?RUNNER_TEMP is required}"
: "${RUNNER_OS:?RUNNER_OS is required}"
: "${GITHUB_ENV:?GITHUB_ENV is required}"
: "${GITHUB_PATH:?GITHUB_PATH is required}"

curl_platform_flags="$ACTION_PATH/../../../tools/dev/curl-platform-flags.sh"
if [ ! -f "$curl_platform_flags" ] || [ -L "$curl_platform_flags" ]; then
  echo "Wasmer LLVM curl platform policy is missing: $curl_platform_flags" >&2
  exit 127
fi
# shellcheck source=tools/dev/curl-platform-flags.sh
. "$curl_platform_flags"

if [[ ! "$LLVM_URL" =~ ^https://[^[:space:]]+$ ]]; then
  echo "Wasmer LLVM URL must be a single HTTPS URL" >&2
  exit 2
fi
llvm_version_re='^[0-9]+(\.[0-9]+)+$'
if [[ ! "$LLVM_VERSION" =~ $llvm_version_re ]]; then
  echo "Wasmer LLVM version must contain only numeric components" >&2
  exit 2
fi
if [[ ! "$LLVM_SHA256" =~ ^[[:xdigit:]]{64}$ ]]; then
  echo "Wasmer LLVM SHA-256 must contain exactly 64 hexadecimal characters" >&2
  exit 2
fi
if [[ ! "$LLVM_BYTES" =~ ^[1-9][0-9]*$ ]] || [ "$LLVM_BYTES" -gt 2147483648 ]; then
  echo "Wasmer LLVM byte size must be an integer between 1 and 2147483648" >&2
  exit 2
fi
if [[ ! "$CACHE_KEY" =~ ^wasmer-llvm-[A-Za-z0-9._-]+$ ]]; then
  echo "Wasmer LLVM cache key contains unsupported characters" >&2
  exit 2
fi
case "$RUNNER_OS" in
  Linux|macOS|Windows) ;;
  *)
    echo "unsupported GitHub runner OS for Wasmer LLVM: $RUNNER_OS" >&2
    exit 2
    ;;
esac

LLVM_SHA256="$(printf '%s' "$LLVM_SHA256" | tr 'A-F' 'a-f')"

sha256_file() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    echo "Wasmer LLVM installation requires shasum or sha256sum" >&2
    return 127
  fi
}

llvm_config_path() {
  if [ "$RUNNER_OS" = "Windows" ]; then
    printf '%s/bin/llvm-config.exe\n' "$1"
  else
    printf '%s/bin/llvm-config\n' "$1"
  fi
}

cache_identity() {
  printf '%s\n' \
    'schema=1' \
    "url=$LLVM_URL" \
    "sha256=$LLVM_SHA256" \
    "bytes=$LLVM_BYTES" \
    "version=$LLVM_VERSION" \
    "cache_key=$CACHE_KEY"
}

validate_cache_identity() {
  local root="$1"
  local label="$2"
  local identity_file="$root/.oliphaunt-wasmer-llvm"
  local actual expected
  if [ ! -f "$identity_file" ]; then
    echo "$label lacks its pinned archive identity marker" >&2
    return 1
  fi
  actual="$(< "$identity_file")"
  expected="$(cache_identity)"
  if [ "$actual" != "$expected" ]; then
    echo "$label archive identity does not match the requested URL, digest, size, version, and cache key" >&2
    return 1
  fi
}

validate_llvm_install() {
  local root="$1"
  local label="$2"
  local llvm_config version targets
  llvm_config="$(llvm_config_path "$root")"
  if [ ! -x "$llvm_config" ]; then
    echo "$label did not produce executable bin/$(basename "$llvm_config")" >&2
    return 1
  fi
  if ! version="$("$llvm_config" --version)"; then
    echo "$label llvm-config --version failed" >&2
    return 1
  fi
  case "$version" in
    "$LLVM_VERSION"|"$LLVM_VERSION".*) ;;
    *)
      echo "$label has LLVM version $version; expected $LLVM_VERSION.x" >&2
      return 1
      ;;
  esac
  if ! targets="$("$llvm_config" --targets-built)"; then
    echo "$label llvm-config --targets-built failed" >&2
    return 1
  fi
  case "$targets" in
    *LoongArch*WebAssembly*|*WebAssembly*LoongArch*) ;;
    *)
      echo "$label lacks required LoongArch and WebAssembly targets: $targets" >&2
      return 1
      ;;
  esac
}

write_github_environment() {
  local install_dir="$1"
  local env_prefix path_entry
  if [ "$RUNNER_OS" = "Windows" ]; then
    env_prefix="$(cygpath -w "$install_dir")"
    path_entry="$(cygpath -w "$install_dir/bin")"
  else
    env_prefix="$install_dir"
    path_entry="$install_dir/bin"
  fi
  printf 'LLVM_PATH=%s\n' "$env_prefix" >> "$GITHUB_ENV"
  printf 'LLVM_SYS_221_PREFIX=%s\n' "$env_prefix" >> "$GITHUB_ENV"
  printf '%s\n' "$path_entry" >> "$GITHUB_PATH"
}

runner_temp="$RUNNER_TEMP"
if [ "$RUNNER_OS" = "Windows" ]; then
  if ! command -v cygpath >/dev/null 2>&1; then
    echo "Wasmer LLVM installation on Windows requires cygpath" >&2
    exit 127
  fi
  runner_temp="$(cygpath -u "$RUNNER_TEMP")"
fi

cache_root="$runner_temp/wasmer-llvm/$CACHE_KEY"
install_dir="$cache_root/llvm"
if [ -d "$install_dir" ]; then
  if validate_cache_identity "$install_dir" "cached Wasmer LLVM" \
    && validate_llvm_install "$install_dir" "cached Wasmer LLVM"; then
    write_github_environment "$install_dir"
    exit 0
  fi
  echo "discarding invalid cached Wasmer LLVM installation" >&2
  rm -rf "$install_dir"
fi

for command in curl tar mktemp python3; do
  if ! command -v "$command" >/dev/null 2>&1; then
    echo "Wasmer LLVM installation requires $command" >&2
    exit 127
  fi
done
if [ ! -f "$ACTION_PATH/validate-archive.py" ]; then
  echo "Wasmer LLVM archive validator is missing from $ACTION_PATH" >&2
  exit 127
fi
if ! command -v shasum >/dev/null 2>&1 && ! command -v sha256sum >/dev/null 2>&1; then
  echo "Wasmer LLVM installation requires shasum or sha256sum" >&2
  exit 127
fi

mkdir -p "$runner_temp" "$cache_root"
archive="$(mktemp "$runner_temp/wasmer-llvm-${LLVM_VERSION}.archive.XXXXXX")"
staging_dir=""
cleanup() {
  if [ -n "$archive" ]; then
    rm -f "$archive" || true
  fi
  if [ -n "$staging_dir" ]; then
    rm -rf "$staging_dir" || true
  fi
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

curl_args=(
  --location
  --fail
  --show-error
  --retry 4
  --retry-all-errors
  --retry-delay 10
  --retry-max-time 3600
  --connect-timeout 30
  --max-time 1800
  --max-filesize "$LLVM_BYTES"
  --proto '=https'
  --proto-redir '=https'
  --tlsv1.2
)
curl_platform_tls_flag="$(oliphaunt_curl_platform_tls_flag)"
if [ -n "$curl_platform_tls_flag" ]; then
  curl_args+=("$curl_platform_tls_flag")
fi
curl_args+=(--output "$archive" "$LLVM_URL")
curl "${curl_args[@]}"

actual_bytes="$(wc -c < "$archive" | tr -d '[:space:]')"
if [ "$actual_bytes" != "$LLVM_BYTES" ]; then
  echo "Wasmer LLVM archive byte-size mismatch: expected $LLVM_BYTES, got $actual_bytes" >&2
  exit 1
fi
actual_sha256="$(sha256_file "$archive")"
actual_sha256="$(printf '%s' "$actual_sha256" | tr 'A-F' 'a-f')"
if [ "$actual_sha256" != "$LLVM_SHA256" ]; then
  echo "Wasmer LLVM archive checksum mismatch" >&2
  echo "  expected: $LLVM_SHA256" >&2
  echo "  actual:   $actual_sha256" >&2
  exit 1
fi

python3 "$ACTION_PATH/validate-archive.py" "$archive" "$LLVM_BYTES"

staging_dir="$(mktemp -d "$cache_root/.llvm-stage.XXXXXX")"
if ! tar -xJf "$archive" -C "$staging_dir"; then
  echo "Wasmer LLVM archive extraction failed" >&2
  exit 1
fi
rm -f "$archive"
archive=""

if ! validate_llvm_install "$staging_dir" "staged Wasmer LLVM"; then
  exit 1
fi
cache_identity > "$staging_dir/.oliphaunt-wasmer-llvm"

rm -rf "$install_dir"
mv "$staging_dir" "$install_dir"
staging_dir=""
write_github_environment "$install_dir"
