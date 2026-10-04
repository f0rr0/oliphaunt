#!/usr/bin/env bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
mkdir -p "$scratch/bin" "$scratch/assets" "$scratch/payload/lib" "$scratch/payload/runtime/bin"
cat > "$scratch/bin/bun" <<'BUN'
#!/usr/bin/env bash
printf '1.0.0\n'
BUN
chmod +x "$scratch/bin/bun"
. src/native/runtime/tools/runtime-preflight.sh
target="$(oliphaunt_runtime_native_host_target_id)"
case "$target" in
  linux-*) library=liboliphaunt.so ;;
  macos-*) library=liboliphaunt.dylib ;;
  *) echo 'archive fixture runs on Unix hosts'; exit 0 ;;
esac
touch "$scratch/payload/lib/$library"
for tool in initdb postgres; do
  printf '#!/bin/sh\nexit 0\n' > "$scratch/payload/runtime/bin/$tool"
  chmod +x "$scratch/payload/runtime/bin/$tool"
done
archive="$scratch/assets/liboliphaunt-1.0.0-$target.tar.gz"
tar -czf "$archive" -C "$scratch/payload" .
export PATH="$scratch/bin:$PATH"
export OLIPHAUNT_LIBOLIPHAUNT_RELEASE_ASSETS="$scratch/assets"
export OLIPHAUNT_INITDB=/must/not/use/a/previous/runtime
export LD_LIBRARY_PATH="$scratch/existing-library-path"
"$BASH" src/native/sdks/tests/with-runtime.sh bash -c '
  test -f "$LIBOLIPHAUNT_PATH"
  test -x "$OLIPHAUNT_INITDB"
  test "$LD_LIBRARY_PATH" = "${OLIPHAUNT_INSTALL_DIR%/runtime}/lib:$OLIPHAUNT_INSTALL_DIR/lib:$1/existing-library-path"
  test ! -e "$OLIPHAUNT_INSTALL_DIR/bin/pg_config"
  printf "%s\n" "$OLIPHAUNT_INSTALL_DIR" > "$1/staged"
' -- "$scratch"
test ! -e "$(cat "$scratch/staged")"
tar -czf "$scratch/assets/oliphaunt-tools-1.0.0-$target.tar.gz" -C "$scratch/payload" .
mkdir -p "$scratch/broker/bin"
cp "$scratch/payload/runtime/bin/postgres" "$scratch/broker/bin/oliphaunt-broker"
tar -czf "$scratch/assets/oliphaunt-broker-1.0.0-$target.tar.gz" -C "$scratch/broker" .
export OLIPHAUNT_POSTGRES_TOOLS_RELEASE_ASSETS="$scratch/assets"
export OLIPHAUNT_BROKER_RELEASE_ASSETS="$scratch/assets"
"$BASH" src/native/sdks/tests/with-runtime.sh --tools --broker bash -c '
  test -x "$OLIPHAUNT_TOOLS_DIR/bin/postgres"
  test -x "$OLIPHAUNT_BROKER"
'
status=0
"$BASH" src/native/sdks/tests/with-runtime.sh bash -c 'exit 43' || status=$?
test "$status" = 43
rm "$scratch/payload/runtime/bin/initdb"
tar -czf "$archive" -C "$scratch/payload" .
if "$BASH" src/native/sdks/tests/with-runtime.sh true > "$scratch/missing.log" 2>&1; then
  echo 'incomplete runtime accepted' >&2; exit 1
fi
grep -q 'missing native Oliphaunt runtime artifacts' "$scratch/missing.log"
echo 'SDK runtime staging: shipped payload, isolated paths, cleanup and failure propagation passed'
