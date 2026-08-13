#!/usr/bin/env bash
set -euo pipefail

host_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
binding_dir="$(cd "$host_dir/.." && pwd)"
repo_root="$(cd "$binding_dir/../../.." && pwd)"
source_manifest="$host_dir/source.toml"
wasmer_js_patch="$host_dir/patches/0001-wasmer-js-run-configured-wasix-process.patch"
wasmer_wasix_patch="$host_dir/patches/0002-wasmer-wasix-add-0702-compatibility-imports.patch"
wasmer_js_filesystem_patch="$host_dir/patches/0003-wasmer-js-install-browser-runtime-devices.patch"
wasmer_wasix_recovery_patch="$host_dir/patches/0004-wasmer-wasix-recover-stdio-pgwire-errors.patch"
wasmer_js_init_patch="$host_dir/patches/0005-wasmer-js-use-object-wasm-init.patch"
wasmer_js_precompiled_module_patch="$host_dir/patches/0006-wasmer-js-reuse-precompiled-wasix-module.patch"
wasmer_js_direct_patch="$host_dir/patches/0007-wasmer-js-run-oliphaunt-direct.patch"
wasmer_async_instance_patch="$host_dir/patches/0008-wasmer-instantiate-js-modules-async.patch"
wasmer_wasix_async_instance_patch="$host_dir/patches/0009-wasmer-wasix-instantiate-main-module-async.patch"
wasmer_js_lock_patch="$host_dir/patches/0010-wasmer-js-refresh-npm-lock.patch"
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

input_hash="$({
  for input in "$source_manifest" "$wasmer_js_patch" "$wasmer_wasix_patch" "$wasmer_js_filesystem_patch" "$wasmer_wasix_recovery_patch" "$wasmer_js_init_patch" "$wasmer_js_precompiled_module_patch" "$wasmer_js_direct_patch" "$wasmer_async_instance_patch" "$wasmer_wasix_async_instance_patch" "$wasmer_js_lock_patch" "${BASH_SOURCE[0]}"; do
    sha256sum "$input" | cut -d ' ' -f 1
  done
} | sha256sum | cut -d ' ' -f 1)"

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

patch --batch --forward -d "$wasmer_js_dir" -p1 < "$wasmer_js_patch"
patch --batch --forward -d "$wasmer_wasix_dir" -p1 < "$wasmer_wasix_patch"
patch --batch --forward -d "$wasmer_js_dir" -p1 < "$wasmer_js_filesystem_patch"
patch --batch --forward -d "$wasmer_wasix_dir" -p1 < "$wasmer_wasix_recovery_patch"
patch --batch --forward -d "$wasmer_js_dir" -p1 < "$wasmer_js_init_patch"
patch --batch --forward -d "$wasmer_js_dir" -p1 < "$wasmer_js_precompiled_module_patch"
patch --batch --forward -d "$wasmer_js_dir" -p1 < "$wasmer_js_direct_patch"
patch --batch --forward -d "$wasmer_dir" -p1 < "$wasmer_async_instance_patch"
patch --batch --forward -d "$wasmer_wasix_dir" -p1 < "$wasmer_wasix_async_instance_patch"
patch --batch --forward -d "$wasmer_js_dir" -p1 < "$wasmer_js_lock_patch"

# The pinned source commit's npm lock predates its package metadata. Patch only
# the missing root metadata and dependencies, then install the integrity-pinned
# graph without allowing the package manager to rewrite it.
package_lock_sha256="$(sha256sum "$wasmer_js_dir/package-lock.json" | cut -d ' ' -f 1)"
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
printf '{\n  "wasmerJsVersion": "%s",\n  "wasmerJsCommit": "%s",\n  "wasmerVersion": "%s",\n  "wasmerWasixVersion": "%s",\n  "packageLockSha256": "%s",\n  "inputsSha256": "%s"\n}\n' \
  "$wasmer_js_version" "$wasmer_js_commit" "$wasmer_version" "$wasmer_wasix_version" "$package_lock_sha256" "$input_hash" > "$staging_dir/provenance.json"
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
