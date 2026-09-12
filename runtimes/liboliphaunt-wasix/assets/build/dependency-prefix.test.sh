#!/usr/bin/env bash
set -euo pipefail
owner="$(cd "$(dirname "$0")" && pwd)"
root="$(git -C "$owner" rev-parse --show-toplevel)"
scratch="$(mktemp -d "$root/target/dependency-prefix-test.XXXXXX")"
trap 'rm -rf "$scratch"' EXIT
mkdir -p "$scratch/recipes" "$scratch/bin" "$scratch/sqlite"
cp "$owner"/build_wasix_{geos,proj,openssl,sqlite}.sh "$owner/wasix_third_party.sh" "$owner/profile_flags.sh" "$scratch/recipes/"
# Compiler provisioning is separate; exercise the real recipes with tiny
# command fixtures instead of compiling complete upstream dependency trees.
: > "$scratch/recipes/docker_wasix_env.sh"
printf sqlite > "$scratch/sqlite/.oliphaunt-wasix-sqlite-build"
export SQLITE_PREFIX="$scratch/sqlite" PATH="$scratch/bin:$PATH"
export DEPENDENCY_INPUT=one DEPENDENCY_LOG="$scratch/commands"
cat > "$scratch/bin/wasixcc" <<'SH'
#!/bin/sh
printf '%s\n' "$DEPENDENCY_INPUT"
SH
cat > "$scratch/bin/sqlite3" <<'SH'
#!/bin/sh
exit 0
SH
cat > "$scratch/bin/cmake" <<'SH'
#!/usr/bin/env bash
set -eu
echo "$*" >> "$DEPENDENCY_LOG"
case "$1" in
  -S)
    [[ ${DEPENDENCY_FAIL:-} != configure ]]
    source=$2; build=$4
    for arg; do case "$arg" in -DCMAKE_INSTALL_PREFIX=*) prefix=${arg#*=};; esac; done
    mkdir -p "$build/data"
    printf '%s' "$prefix" > "$build/prefix"
    printf '%s' "$DEPENDENCY_INPUT" > "$build/data/proj.db"
    ;;
  --build) [[ ${DEPENDENCY_FAIL:-} != build ]];;
  --install)
    build=$2
    prefix="${DESTDIR:?}$(cat "$build/prefix")"
    mkdir -p "$prefix/include" "$prefix/lib"
    touch "$prefix/include/geos_c.h" "$prefix/include/proj.h"
    for name in geos geos_c proj; do printf '%s' "$DEPENDENCY_INPUT" > "$prefix/lib/lib$name.a"; done
    [[ ${DEPENDENCY_FAIL:-} != install ]]
    ;;
esac
SH
cat > "$scratch/bin/make" <<'SH'
#!/usr/bin/env bash
set -eu
echo "$*" >> "$DEPENDENCY_LOG"
case " $* " in
  *' install_dev '*)
    for arg; do case "$arg" in DESTDIR=*) stage=${arg#*=};; esac; done
    prefix="${stage:?}$(cat prefix)"
    mkdir -p "$prefix/include/openssl" "$prefix/lib"
    touch "$prefix/include/openssl/evp.h"
    printf '%s' "$DEPENDENCY_INPUT" > "$prefix/lib/libcrypto.a"
    [[ ${DEPENDENCY_FAIL:-} != install ]]
    ;;
  *) [[ ${DEPENDENCY_FAIL:-} != build ]];;
esac
SH
chmod +x "$scratch/bin/"*
for name in geos proj openssl; do
  mkdir -p "$scratch/source-$name"
  touch "$scratch/source-$name/CMakeLists.txt"
done
cat > "$scratch/source-openssl/Configure" <<'SH'
#!/usr/bin/env bash
set -eu
[[ ${DEPENDENCY_FAIL:-} != configure ]]
for arg; do case "$arg" in --prefix=*) printf '%s' "${arg#*=}" > prefix;; esac; done
SH
chmod +x "$scratch/source-openssl/Configure"
export GEOS_SOURCE_DIR="$scratch/source-geos" PROJ_SOURCE_DIR="$scratch/source-proj" OPENSSL_SOURCE_DIR="$scratch/source-openssl"
export OLIPHAUNT_WASM_GENERATED_ROOT="$scratch/generated"
for name in geos proj openssl; do
  recipe="$scratch/recipes/build_wasix_$name.sh"
  prefix="$scratch/generated/work/$name-wasix"
  archive="$prefix/lib/lib$name.a"
  [[ $name != openssl ]] || archive="$prefix/lib/libcrypto.a"
  export DEPENDENCY_INPUT=one
  bash "$recipe" > "$scratch/recipe.log" 2>&1
  initial_stamp=$(cat "$prefix/.oliphaunt-wasix-$name-build")
  calls=$(wc -l < "$DEPENDENCY_LOG")
  bash "$recipe" >> "$scratch/recipe.log" 2>&1
  [[ $(wc -l < "$DEPENDENCY_LOG") == "$calls" ]]
  export DEPENDENCY_INPUT=two
  for phase in configure build install; do
    export DEPENDENCY_FAIL=$phase
    if bash "$recipe" >> "$scratch/recipe.log" 2>&1; then
      echo "$name unexpectedly accepted $phase failure" >&2; exit 1
    fi
    [[ $(cat "$archive") == one ]]
    [[ $(cat "$prefix/.oliphaunt-wasix-$name-build") == "$initial_stamp" ]]
  done
  unset DEPENDENCY_FAIL
  bash "$recipe" >> "$scratch/recipe.log" 2>&1
  [[ $(cat "$archive") == two ]]
  [[ $(cat "$prefix/.oliphaunt-wasix-$name-build") != "$initial_stamp" ]]
  calls=$(wc -l < "$DEPENDENCY_LOG")
  bash "$recipe" >> "$scratch/recipe.log" 2>&1
  [[ $(wc -l < "$DEPENDENCY_LOG") == "$calls" ]]
  echo "$name repeat/change-input and configure/build/install failure retention passed"
done
