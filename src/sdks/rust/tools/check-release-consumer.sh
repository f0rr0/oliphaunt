#!/usr/bin/env bash
set -euo pipefail

root="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "check-release-consumer.sh: must run inside the Oliphaunt checkout" >&2
  exit 1
}
cd "$root"

scratch=""
cleanup() {
  [ -z "$scratch" ] || rm -rf "$scratch"
}
trap cleanup EXIT

fail() {
  echo "check-release-consumer.sh: $*" >&2
  exit 1
}

require_file() {
  [ -s "$1" ] || fail "missing or empty file: $1"
}

find_one() {
  local directory="$1"
  local pattern="$2"
  local matches=()
  while IFS= read -r file; do
    matches+=("$file")
  done < <(find "$directory" -type f -name "$pattern" -print)
  [ "${#matches[@]}" -eq 1 ] ||
    fail "expected one $pattern under $directory, found ${#matches[@]}"
  printf '%s\n' "${matches[0]}"
}

require_linux_x64() {
  [ "$(uname -s)" = "Linux" ] || fail "release consumer requires Linux"
  case "$(uname -m)" in
    x86_64|amd64) ;;
    *) fail "release consumer requires x64, found $(uname -m)" ;;
  esac
}

build_consumer() {
  local sdk_artifacts="$1"
  local output="$2"
  local crate packed_manifest metadata dependency_rows name version stub
  local manifests=()
  [ -d "$sdk_artifacts" ] || fail "Rust SDK artifact directory is missing: $sdk_artifacts"
  crate="$(find_one "$sdk_artifacts" 'oliphaunt-[0-9]*.crate')"
  scratch="$(mktemp -d "${TMPDIR:-/tmp}/oliphaunt-rust-release-consumer-build.XXXXXX")"

  mkdir -p "$scratch/unpacked" "$scratch/packed" "$scratch/consumer/src" "$scratch/consumer/.cargo"
  tar -xzf "$crate" -C "$scratch/unpacked"
  while IFS= read -r file; do
    manifests+=("$file")
  done < <(find "$scratch/unpacked" -mindepth 2 -maxdepth 2 -type f -name Cargo.toml -print)
  [ "${#manifests[@]}" -eq 1 ] ||
    fail "packed crate must contain one root Cargo.toml, found ${#manifests[@]}"
  packed_manifest="${manifests[0]}"
  mv "$(dirname "$packed_manifest")" "$scratch/packed/oliphaunt"
  cp src/sdks/rust/tests/release-consumer/Cargo.toml "$scratch/consumer/Cargo.toml"
  cp src/sdks/rust/tests/release-consumer/src/main.rs "$scratch/consumer/src/main.rs"

  metadata="$scratch/metadata.json"
  dependency_rows="$scratch/artifact-dependencies.tsv"
  cargo metadata --manifest-path "$scratch/packed/oliphaunt/Cargo.toml" \
    --format-version 1 --no-deps --offline >"$metadata"
  OLIPHAUNT_CARGO_METADATA="$metadata" tools/dev/bun.sh -e '
    const metadata = await Bun.file(process.env.OLIPHAUNT_CARGO_METADATA).json();
    for (const dependency of metadata.packages[0].dependencies) {
      if (dependency.name === "oliphaunt-tools" || dependency.name.startsWith("liboliphaunt-native-") || dependency.name.startsWith("oliphaunt-broker-")) {
        const version = dependency.req.match(/^=([0-9A-Za-z.+-]+)$/)?.[1];
        if (!version) throw new Error(`artifact dependency ${dependency.name} must use an exact version`);
        console.log(`${dependency.name}\t${version}`);
      }
    }
  ' | sort -u >"$dependency_rows"
  for pattern in '^liboliphaunt-native-' '^oliphaunt-broker-' '^oliphaunt-tools\t'; do
    rg -q "$pattern" "$dependency_rows" || fail "packed crate is missing artifact dependency $pattern"
  done

  {
    printf '[net]\noffline = true\n\n[patch.crates-io]\n'
    while IFS=$'\t' read -r name version; do
      stub="$scratch/stubs/$name"
      mkdir -p "$stub/src"
      printf '[package]\nname = "%s"\nversion = "%s"\nedition = "2024"\npublish = false\n\n[lib]\npath = "src/lib.rs"\n' \
        "$name" "$version" >"$stub/Cargo.toml"
      printf '#![forbid(unsafe_code)]\n' >"$stub/src/lib.rs"
      printf '"%s" = { path = "%s" }\n' "$name" "$stub"
    done <"$dependency_rows"
  } >"$scratch/consumer/.cargo/config.toml"

  CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$scratch/target}" \
    cargo --config "$scratch/consumer/.cargo/config.toml" generate-lockfile \
      --manifest-path "$scratch/consumer/Cargo.toml" --offline
  CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$scratch/target}" \
    cargo --config "$scratch/consumer/.cargo/config.toml" build \
      --manifest-path "$scratch/consumer/Cargo.toml" --locked --offline --release
  mkdir -p "$(dirname "$output")"
  install -m 0755 \
    "${CARGO_TARGET_DIR:-$scratch/target}/release/oliphaunt-rust-release-consumer" "$output"
  echo "Built packed-crate Rust release consumer: $output"
}

run_consumer() {
  local consumer="$1"
  local native_assets="$2"
  local runtime_archive tools_archive install_dir tools_dir
  require_linux_x64
  require_file "$consumer"
  [ -x "$consumer" ] || fail "release consumer is not executable: $consumer"
  [ -d "$native_assets" ] || fail "native asset directory is missing: $native_assets"
  runtime_archive="$(find_one "$native_assets" 'liboliphaunt-*-linux-x64-gnu.tar.gz')"
  tools_archive="$(find_one "$native_assets" 'oliphaunt-tools-*-linux-x64-gnu.tar.gz')"
  scratch="$(mktemp -d "${TMPDIR:-/tmp}/oliphaunt-rust-release-consumer-run.XXXXXX")"

  mkdir -p "$scratch/native" "$scratch/tools" "$scratch/runtime-cache"
  tar -xzf "$runtime_archive" -C "$scratch/native"
  tar -xzf "$tools_archive" -C "$scratch/tools"
  install_dir="$scratch/native/runtime"
  tools_dir="$scratch/tools/runtime"
  for file in "$install_dir/bin/postgres" "$install_dir/bin/initdb" "$install_dir/bin/pg_ctl" \
    "$tools_dir/bin/pg_dump" "$tools_dir/bin/psql"; do
    require_file "$file"
  done

  env \
    OLIPHAUNT_INSTALL_DIR="$install_dir" \
    OLIPHAUNT_TOOLS_DIR="$tools_dir" \
    OLIPHAUNT_RUNTIME_CACHE_DIR="$scratch/runtime-cache" \
    LD_LIBRARY_PATH="$install_dir/lib:$scratch/native/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" \
    "$consumer" "$scratch/database"
}

case "${1:-}" in
  build)
    [ "$#" -eq 3 ] || fail "usage: $0 build SDK_ARTIFACT_DIR OUTPUT"
    build_consumer "$2" "$3"
    ;;
  run)
    [ "$#" -eq 3 ] || fail "usage: $0 run CONSUMER NATIVE_ASSET_DIR"
    run_consumer "$2" "$3"
    ;;
  *) fail "usage: $0 {build SDK_ARTIFACT_DIR OUTPUT|run CONSUMER NATIVE_ASSET_DIR}" ;;
esac
