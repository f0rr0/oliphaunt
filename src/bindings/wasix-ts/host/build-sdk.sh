#!/usr/bin/env bash
set -euo pipefail

host_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
binding_dir="$(cd "$host_dir/.." && pwd)"
repo_root="$(cd "$binding_dir/../../.." && pwd)"
source_manifest="$host_dir/source.toml"
provenance_script="$host_dir/build-provenance.mjs"
target_parent="$repo_root/target/oliphaunt-wasix-ts/host"
target_dir="$target_parent/wasmer-sdk"
cargo_target_dir="$target_parent/cargo"

toml_value() {
  local wanted_section="$1"
  local wanted_key="$2"
  awk -v wanted_section="$wanted_section" -v wanted_key="$wanted_key" '
    /^\[/ {
      section = $0
      gsub(/^\[|\]$/, "", section)
      next
    }
    section == wanted_section && $1 == wanted_key {
      sub(/^[^=]*=[[:space:]]*"/, "")
      sub(/"[[:space:]]*$/, "")
      print
      exit
    }
  ' "$source_manifest"
}

wasmer_js_url="$(toml_value wasmer-js url)"
wasmer_js_version="$(toml_value wasmer-js version)"
wasmer_js_commit="$(toml_value wasmer-js commit)"
wasmer_wasix_url="$(toml_value wasmer-wasix url)"
wasmer_wasix_version="$(toml_value wasmer-wasix version)"
wasmer_wasix_sha256="$(toml_value wasmer-wasix sha256)"
wasmer_url="$(toml_value wasmer url)"
wasmer_version="$(toml_value wasmer version)"
wasmer_sha256="$(toml_value wasmer sha256)"

for value in "$wasmer_js_url" "$wasmer_js_version" "$wasmer_js_commit" "$wasmer_wasix_url" "$wasmer_wasix_version" "$wasmer_wasix_sha256" "$wasmer_url" "$wasmer_version" "$wasmer_sha256"; do
  if [[ -z "$value" ]]; then
    echo "wasix-ts host build: malformed $source_manifest" >&2
    exit 1
  fi
done

if ! command -v node >/dev/null 2>&1; then
  echo "wasix-ts host build: required command not found: node" >&2
  exit 1
fi
mapfile -t patch_series < <(node "$provenance_script" --patch-series)
input_hash="$(node "$provenance_script" --inputs-sha256)"

if [[ -f "$target_dir/.oliphaunt-input-sha256" ]] \
    && [[ "$(<"$target_dir/.oliphaunt-input-sha256")" == "$input_hash" ]] \
    && [[ -f "$target_dir/dist/index.mjs" ]] \
    && [[ -f "$target_dir/dist/worker.mjs" ]] \
    && [[ -f "$target_dir/dist/wasmer_js_bg.wasm" ]]; then
  echo "wasix-ts host build: using source-pinned SDK at $target_dir"
  exit 0
fi

mkdir -p "$target_parent"

for command_name in awk curl git node npm patch sha256sum tar wasm-pack; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "wasix-ts host build: required command not found: $command_name" >&2
    exit 1
  fi
done

build_root="$(mktemp -d "${TMPDIR:-/tmp}/oliphaunt-wasmer-sdk.XXXXXX")"
cleanup() {
  rm -rf -- "$build_root"
}
trap cleanup EXIT

wasmer_js_dir="$build_root/wasmer-js"
wasmer_wasix_archive="$build_root/wasmer-wasix.crate"
wasmer_wasix_dir="$build_root/wasmer-wasix-$wasmer_wasix_version"
wasmer_archive="$build_root/wasmer.crate"
wasmer_dir="$build_root/wasmer-$wasmer_version"

git init --quiet "$wasmer_js_dir"
git -C "$wasmer_js_dir" remote add origin "$wasmer_js_url"
git -C "$wasmer_js_dir" fetch --quiet --depth 1 origin "$wasmer_js_commit"
git -C "$wasmer_js_dir" checkout --quiet --detach FETCH_HEAD
if [[ "$(git -C "$wasmer_js_dir" rev-parse HEAD)" != "$wasmer_js_commit" ]]; then
  echo "wasix-ts host build: Wasmer JS checkout did not resolve the pinned commit" >&2
  exit 1
fi
actual_wasmer_js_version="$(node -p "require(process.argv[1]).version" "$wasmer_js_dir/package.json")"
if [[ "$actual_wasmer_js_version" != "$wasmer_js_version" ]]; then
  echo "wasix-ts host build: pinned Wasmer JS version is $actual_wasmer_js_version, expected $wasmer_js_version" >&2
  exit 1
fi

curl --fail --location --silent --show-error \
  --user-agent "oliphaunt-wasix-ts-source-build/0.0.0" \
  "$wasmer_wasix_url" --output "$wasmer_wasix_archive"
echo "$wasmer_wasix_sha256  $wasmer_wasix_archive" | sha256sum --check --status
tar -xzf "$wasmer_wasix_archive" -C "$build_root"

curl --fail --location --silent --show-error \
  --user-agent "oliphaunt-wasix-ts-source-build/0.0.0" \
  "$wasmer_url" --output "$wasmer_archive"
echo "$wasmer_sha256  $wasmer_archive" | sha256sum --check --status
tar -xzf "$wasmer_archive" -C "$build_root"

for patch_name in "${patch_series[@]}"; do
  patch_file="$host_dir/patches/$patch_name"
  case "$patch_name" in
    ????-wasmer-js-*.patch)
      patch_dir="$wasmer_js_dir"
      ;;
    ????-wasmer-wasix-*.patch)
      patch_dir="$wasmer_wasix_dir"
      ;;
    ????-wasmer-*.patch)
      patch_dir="$wasmer_dir"
      ;;
    *)
      echo "wasix-ts host build: patch target is not declared by its canonical name: $patch_name" >&2
      exit 1
      ;;
  esac
  patch --batch --forward -d "$patch_dir" -p1 < "$patch_file"
done

# The browser host runs every WASIX syscall and virtual-filesystem operation.
# Fail closed if the pinned speed profile ever drifts back to the upstream
# size-first release settings recorded in the source patch.
grep -Fqx "lto = true" "$wasmer_js_dir/Cargo.toml"
grep -Fqx "opt-level = 3" "$wasmer_js_dir/Cargo.toml"
grep -Fqx 'wasm-opt = ["--enable-threads", "--enable-bulk-memory", "-O3"]' \
  "$wasmer_js_dir/Cargo.toml"
for policy_source in \
  "$wasmer_wasix_dir/src/syscalls/wasix/mod.rs" \
  "$wasmer_wasix_dir/src/syscalls/wasix/thread_spawn.rs" \
  "$wasmer_wasix_dir/src/syscalls/wasix/proc_spawn.rs" \
  "$wasmer_wasix_dir/src/syscalls/wasix/proc_spawn2.rs" \
  "$wasmer_wasix_dir/src/syscalls/wasix/proc_exec3.rs" \
  "$wasmer_wasix_dir/src/syscalls/wasix/proc_fork.rs"; do
  grep -Fq 'oliphaunt_single_backend_requested' "$policy_source"
done
grep -Fq '.unwrap_or(true)' "$wasmer_wasix_dir/src/syscalls/wasix/mod.rs"

# The pinned source commit's npm lock predates its package metadata. Patch only
# the missing root metadata and dependencies, then install the integrity-pinned
# graph without allowing the package manager to rewrite it.
npm --prefix "$wasmer_js_dir" ci --ignore-scripts --no-audit --no-fund

(
  cd "$wasmer_js_dir"
  CARGO_TARGET_DIR="$cargo_target_dir" wasm-pack build --release --target=web --weak-refs --no-pack
  npm run build:rollup
)

for output in index.mjs worker.mjs wasmer_js_bg.wasm; do
  if [[ ! -f "$wasmer_js_dir/dist/$output" ]]; then
    echo "wasix-ts host build: expected output missing: dist/$output" >&2
    exit 1
  fi
done

staging_dir="$target_parent/.wasmer-sdk-$input_hash"
if [[ -e "$staging_dir" ]]; then
  rm -rf -- "$staging_dir"
fi
mkdir -p "$staging_dir"
cp -R "$wasmer_js_dir/dist" "$staging_dir/dist"
cp "$wasmer_js_dir/LICENSE" "$staging_dir/LICENSE"
printf '%s\n' "$input_hash" > "$staging_dir/.oliphaunt-input-sha256"
node "$provenance_script" --json > "$staging_dir/provenance.json"
chmod -R u+rwX,go+rX "$staging_dir"

previous_dir="$target_parent/.wasmer-sdk-previous"
if [[ -e "$previous_dir" ]]; then
  rm -rf -- "$previous_dir"
fi
if [[ -e "$target_dir" ]]; then
  mv "$target_dir" "$previous_dir"
fi
mv "$staging_dir" "$target_dir"
if [[ -e "$previous_dir" ]]; then
  rm -rf -- "$previous_dir"
fi

echo "wasix-ts host build: wrote source-pinned SDK to $target_dir"
