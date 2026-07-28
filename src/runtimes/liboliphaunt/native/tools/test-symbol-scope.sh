#!/usr/bin/env bash
set -euo pipefail

root="$(git rev-parse --show-toplevel)"
source_root="$root/src/runtimes/liboliphaunt/native"
work_root="$root/target/liboliphaunt-symbol-scope-test"
macos_module_nm_audit="$source_root/tools/audit-macos-module-nm.awk"
macos_provider_collision_audit="$source_root/tools/audit-macos-provider-collisions.awk"
macos_build_script="$source_root/bin/build-postgres18-macos.sh"
rm -rf "$work_root"
mkdir -p "$work_root"
trap 'rm -rf "$work_root"' EXIT

# A module can legitimately contain no unresolved PostgreSQL symbols at all.
# earthdistance is one such carrier: PostgreSQL access is through inlined ABI
# macros and its external calls are system math functions. Both that shape and
# a normal dynamic PostgreSQL import are safe. A main-executable ordinal is
# never safe because node, bun, deno, and other embedding hosts do not export
# PostgreSQL's symbols from their main executable.
awk -f "$macos_module_nm_audit" <<'NM'
0000000000003f40 (__TEXT,__text) external _geo_distance
                 (undefined) external _asin (from libSystem)
                 (undefined) external _sqrt (from libSystem)
NM

awk -f "$macos_module_nm_audit" <<'NM'
                 (undefined) external _palloc (dynamically looked up)
                 (undefined) external _sqrt (from libSystem)
NM

if awk -f "$macos_module_nm_audit" >/dev/null 2>&1 <<'NM'
                 (undefined) external _palloc (dynamically looked up)
                 (undefined) external _BufferBlocks (from executable)
NM
then
  echo "macOS module audit accepted a main-executable symbol binding" >&2
  exit 1
fi

cat >"$work_root/engine.nm" <<'NM'
0000000000001000 T _oliphaunt_pg_hash_create
0000000000001010 T _oliphaunt_pg_hash_destroy
0000000000001020 T _oliphaunt_pg_hash_search
0000000000001030 T _palloc
NM

awk -v require_namespaced_dynahash=1 \
  -f "$macos_provider_collision_audit" "$work_root/engine.nm" - <<'NM'
                 (undefined) external _palloc (dynamically looked up)
                 (undefined) external _sqrt (from libSystem)
NM

awk -v allowed_engine_provider=liboliphaunt \
  -v require_namespaced_dynahash=1 \
  -f "$macos_provider_collision_audit" "$work_root/engine.nm" - <<'NM'
                 (undefined) external _palloc (from liboliphaunt)
                 (undefined) external _sqrt (from libSystem)
NM

if awk -f "$macos_provider_collision_audit" "$work_root/engine.nm" - >/dev/null 2>&1 <<'NM'
                 (undefined) external _hash_create (from libSystem)
NM
then
  echo "macOS module audit accepted an engine symbol bound to another provider" >&2
  exit 1
fi

if awk -f "$macos_provider_collision_audit" "$work_root/engine.nm" - >/dev/null 2>&1 <<'NM'
                 (undefined) external _hash_destroy (dynamically looked up)
NM
then
  echo "macOS module audit accepted a stale dynamically looked-up dynahash symbol" >&2
  exit 1
fi

if awk -f "$macos_provider_collision_audit" "$work_root/engine.nm" - >/dev/null 2>&1 <<'NM'
                 (undefined) external _missing_engine_symbol (dynamically looked up)
NM
then
  echo "macOS module audit accepted a dynamically looked-up symbol absent from liboliphaunt" >&2
  exit 1
fi

cat >"$work_root/incomplete-engine.nm" <<'NM'
0000000000001000 T _oliphaunt_pg_hash_create
0000000000001010 T _oliphaunt_pg_hash_search
0000000000001020 T _palloc
NM

if awk -v require_namespaced_dynahash=1 \
  -f "$macos_provider_collision_audit" "$work_root/incomplete-engine.nm" - >/dev/null 2>&1 <<'NM'
                 (undefined) external _palloc (dynamically looked up)
NM
then
  echo "macOS module audit accepted a liboliphaunt missing a namespaced dynahash export" >&2
  exit 1
fi

plpgsql_builder="$(
  awk '
    /^build_embedded_plpgsql_module\(\) \{/ { in_function = 1 }
    in_function { print }
    in_function && /^}$/ { exit }
  ' "$macos_build_script"
)"
if ! grep -q 'embedded_plpgsql_build_stamp' <<< "$plpgsql_builder" ||
  ! grep -q 'desired_build_hash' <<< "$plpgsql_builder"; then
  echo "embedded plpgsql reuse is not bound to the current PostgreSQL build" >&2
  exit 1
fi
if [ "$(grep -c 'embedded_plpgsql_avoids_provider_collisions' <<< "$plpgsql_builder")" -lt 2 ]; then
  echo "embedded plpgsql reuse and promotion do not both enforce the provider audit" >&2
  exit 1
fi

for generation_input in \
  "generation_schema=2" \
  "pg_version=%s" \
  "pg_sha256=%s" \
  "build_script=%s" \
  "common_script=%s" \
  "fetch_script=%s" \
  "source_manifest=%s" \
  "module_audit=%s" \
  "provider_audit=%s" \
  "apple_toolchain=%s"
do
  if ! grep -Fq "$generation_input" "$macos_build_script"; then
    echo "macOS native build generation omits identity input: $generation_input" >&2
    exit 1
  fi
done

generation_invalidator="$(
  awk '
    /^if \[ "\$current_generation_hash" != "\$desired_build_hash" \]/ { in_block = 1 }
    in_block { print }
    in_block && /^mkdir -p "\$out_dir"$/ { exit }
  ' "$macos_build_script"
)"
if ! grep -Fq 'rm -rf \' <<< "$generation_invalidator" ||
  ! grep -Fq 'mv -f "$generation_stamp_stage" "$generation_stamp"' <<< "$generation_invalidator"; then
  echo "macOS native cache invalidation is not an atomic stamped generation replacement" >&2
  exit 1
fi
for generation_root in \
  '"$build_dir"' \
  '"$install_dir"' \
  '"$out_dir"' \
  '"$icu_native_build_dir"' \
  '"$icu_build_dir"' \
  '"$icu_prefix"' \
  '"$work_root/icu"'
do
  if ! grep -Fq "$generation_root" <<< "$generation_invalidator"; then
    echo "macOS native generation invalidation omits cache root: $generation_root" >&2
    exit 1
  fi
done
if ! grep -Fq '[ -L "$generation_stamp" ]' "$macos_build_script" ||
  ! grep -Fq 'rm -rf "$generation_stamp"' "$macos_build_script" ||
  ! grep -Fq 'rm -rf "$generation_stamp_stage"' <<< "$generation_invalidator"; then
  echo "macOS generation stamp replacement does not self-heal malformed stamp paths" >&2
  exit 1
fi

extension_dependency_invalidator="$(
  awk '
    /^invalidate_native_extension_dependency_cache\(\) \{/ { in_function = 1 }
    in_function { print }
    in_function && /^}$/ { exit }
  ' "$macos_build_script"
)"
for dependency_cache in \
  '"$native_uuid_dependency_dir"' \
  '"$work_root/postgis-native-dependency-scripts"'
do
  if ! grep -Fq "$dependency_cache" <<< "$extension_dependency_invalidator"; then
    echo "native extension invalidation omits dependency cache: $dependency_cache" >&2
    exit 1
  fi
done
if [ "$(grep -Fc 'invalidate_native_extension_dependency_cache' "$macos_build_script")" -lt 2 ]; then
  echo "native extension rebuild does not invalidate its dependency cache" >&2
  exit 1
fi

for dependency_cache_contract in \
  'native_postgis_dependency_fingerprint()' \
  'oliphaunt_postgis_dependency_cache_prepare' \
  'oliphaunt_postgis_dependency_cache_commit' \
  'native_postgis_dependency_required_outputs=(' \
  'postgis_use_pinned_deps=%s' \
  'exact_checkout_identity' \
  'openssl_dependency_identity || return 1' \
  'postgis_host_dependency_identity || return 1' \
  'apple_toolchain_hash'
do
  if ! grep -Fq "$dependency_cache_contract" "$macos_build_script"; then
    echo "native PostGIS dependency cache omits contract: $dependency_cache_contract" >&2
    exit 1
  fi
done
if [ "$(grep -Ec 'exact_checkout_identity .* \|\| return 1' "$macos_build_script")" -lt 3 ] ||
  ! grep -Fq 'postgis_dependency_hash="$(native_postgis_dependency_fingerprint)" || return 1' "$macos_build_script"; then
  echo "native extension fingerprints do not fail closed on checkout/dependency identity errors" >&2
  exit 1
fi

postgis_dependency_build_roots="$(
  awk '
    /^native_postgis_dependency_build_roots=\(/ { in_array = 1 }
    in_array { print }
    in_array && /^\)$/ { exit }
  ' "$macos_build_script"
)"
for dependency_build_root in json-c sqlite geos libxml2 proj; do
  if ! grep -Fq '"$work_root/'"$dependency_build_root"'-native-build"' <<< "$postgis_dependency_build_roots"; then
    echo "native PostGIS dependency cache omits build root: $dependency_build_root" >&2
    exit 1
  fi
done

if ! grep -Fq '! -name plpgsql.dylib -exec rm -rf {} +' "$macos_build_script" ||
  ! grep -Fq 'rm -rf "$embedded_modules_dir/plpgsql.dylib"' "$macos_build_script" ||
  ! grep -Fq 'base_embedded_module_closure_ready' "$macos_build_script"; then
  echo "base macOS runtime does not self-heal and enforce an exact embedded plpgsql-only closure" >&2
  exit 1
fi

common_flags=(
  -std=c11
  -Wall
  -Wextra
  -Werror
  -I "$source_root/include"
  -I "$source_root/src"
)

case "$(uname -s)" in
  Linux)
    provider="$work_root/liboliphaunt-scope-provider.so"
    consumer="$work_root/liboliphaunt-scope-consumer.so"
    cc "${common_flags[@]}" -fPIC -shared -pthread \
      "$source_root/src/liboliphaunt_process.c" \
      "$source_root/smoke/liboliphaunt_symbol_scope_provider.c" \
      -ldl -o "$provider"
    cc "${common_flags[@]}" -fPIC -shared \
      "$source_root/smoke/liboliphaunt_symbol_scope_consumer.c" \
      -o "$consumer"
    cc "${common_flags[@]}" \
      "$source_root/smoke/liboliphaunt_symbol_scope_host.c" \
      -ldl -o "$work_root/scope-host"
    ;;
  Darwin)
    provider="$work_root/liboliphaunt-scope-provider.dylib"
    consumer="$work_root/liboliphaunt-scope-consumer.dylib"
    cc "${common_flags[@]}" -dynamiclib \
      "$source_root/src/liboliphaunt_process.c" \
      "$source_root/smoke/liboliphaunt_symbol_scope_provider.c" \
      -o "$provider"
    cc "${common_flags[@]}" -dynamiclib -undefined dynamic_lookup \
      "$source_root/smoke/liboliphaunt_symbol_scope_consumer.c" \
      -o "$consumer"
    cc "${common_flags[@]}" \
      "$source_root/smoke/liboliphaunt_symbol_scope_host.c" \
      -o "$work_root/scope-host"
    ;;
  *)
    echo "symbol-scope behavior test is not applicable on $(uname -s)"
    exit 0
    ;;
esac

"$work_root/scope-host" "$provider" "$consumer"
echo "liboliphaunt process-global extension symbol scope passed"
