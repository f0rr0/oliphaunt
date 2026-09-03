#!/usr/bin/env bash
set -euo pipefail

root="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "must run inside the Oliphaunt git checkout" >&2
  exit 1
}
cd "$root"

run() {
  printf '\n==> %s\n' "$*"
  "$@"
}

while IFS= read -r script; do
  case "$(head -n 1 "$script")" in
    '#!/usr/bin/env bash')
      run bash -n "$script"
      ;;
    '#!/usr/bin/env sh')
      run sh -n "$script"
      ;;
  esac
done < <(find tools/policy -type f -name '*.sh' | LC_ALL=C sort)

js_check_root="$(mktemp -d)"
cleanup() {
  rm -rf "$js_check_root"
}
trap cleanup EXIT HUP INT TERM

js_files=()
while IFS= read -r script; do
  js_files+=("$script")
done < <(
  {
    find .github/scripts examples/tools tools/policy tools/graph -type f -name '*.mjs'
    printf '%s\n' src/runtimes/liboliphaunt/native/tools/build-ci-target.mjs
  } | LC_ALL=C sort
)
run bun build "${js_files[@]}" --target=bun --root "$root" --outdir="$js_check_root/js"

python_files=()
while IFS= read -r script; do
  python_files+=("$script")
done < <(find tools/policy -type f -name '*.py' | LC_ALL=C sort)

if ((${#python_files[@]} > 0)); then
  run env \
    PYTHONPYCACHEPREFIX="$js_check_root/python-pycache" \
    python3 -m py_compile "${python_files[@]}"
fi
