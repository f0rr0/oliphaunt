#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/build.sh"
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
mkdir -p "$scratch/source" "$scratch/bin"
export ICU_TEST_LOG="$scratch/commands" ICU_TEST_INPUT=one
export PATH="$scratch/bin:$PATH"
cat > "$scratch/source/configure" <<'SH'
#!/usr/bin/env bash
set -eu
echo configure >> "$ICU_TEST_LOG"
[[ ${ICU_TEST_FAIL:-} != configure ]]
mkdir -p config lib stubdata bin data
printf 'ICUDATA_NAME = icudt76l\n' > config/Makefile.inc
touch icudefs.mk config/icucross.mk config/icucross.inc
for name in icui18n icuuc icutu; do printf '%s' "$ICU_TEST_INPUT" > "lib/lib$name.a"; done
printf stub > stubdata/stubdata.ao
ar cr stubdata/libicudata.a stubdata/stubdata.ao
for name in makeconv gencnval gencfu genbrk gendict genrb gensprep icupkg pkgdata genccode gencmn; do
  printf '#!/bin/sh\nexit 0\n' > "bin/$name"
  chmod +x "bin/$name"
done
for arg; do case "$arg" in --prefix=*) printf '%s' "${arg#--prefix=}" > configured-prefix;; esac; done
SH
cat > "$scratch/bin/make" <<'SH'
#!/usr/bin/env bash
set -eu
echo "$*" >> "$ICU_TEST_LOG"
[[ ${ICU_TEST_FAIL:-} != make ]]
if [[ $1 == install ]]; then
  stage=
  for arg; do case "$arg" in DESTDIR=*) stage=${arg#DESTDIR=};; esac; done
  [[ -n $stage ]]
  prefix="$stage$(cat configured-prefix)"
  mkdir -p "$prefix/include/unicode" "$prefix/lib"
  touch "$prefix/include/unicode/ucol.h"
  cp lib/libicui18n.a lib/libicuuc.a "$prefix/lib/"
  [[ ${ICU_TEST_FAIL:-} != install ]]
fi
SH
chmod +x "$scratch/source/configure" "$scratch/bin/make"
# Replace only source/data acquisition; execute the real cache, configure,
# install, archive validation and publication paths against a tiny build.
oliphaunt_icu_source_commit() { printf '%s\n' "$ICU_TEST_INPUT"; }
oliphaunt_icu_canonical_data_sha256() { printf data; }
oliphaunt_icu_canonical_data_archive() { printf data; }
oliphaunt_icu_require_canonical_data() { :; }
oliphaunt_icu_install_canonical_data() { mkdir -p "$2"; printf data > "$2/data"; }
oliphaunt_icu_files_data_ready() { test -f "$1/data"; }
build() {
  oliphaunt_icu_build_target "$scratch/source" "$scratch/native" \
    "$scratch/build" "$scratch/install" 1 test test cc c++ ar ranlib '' '' ''
}
build
first_stamp=$(cat "$scratch/install/.oliphaunt-icu-build")
first_commands=$(wc -l < "$ICU_TEST_LOG")
build
[[ $(wc -l < "$ICU_TEST_LOG") == "$first_commands" ]]
export ICU_TEST_INPUT=two ICU_TEST_FAIL=configure
# A failed native-tools rebuild must restore the original absolute-path tree.
set +e
(set -e; build)
status=$?
set -e
[[ $status != 0 && $(cat "$scratch/native/lib/libicuuc.a") == one ]]
[[ $(cat "$scratch/install/.oliphaunt-icu-build") == "$first_stamp" ]]
unset ICU_TEST_FAIL
oliphaunt_icu_build_native_tools "$scratch/source" "$scratch/native" 1
for phase in make install; do
  export ICU_TEST_FAIL=$phase
  set +e
  (set -e; build)
  status=$?
  set -e
  [[ $status != 0 && $(cat "$scratch/install/lib/libicuuc.a") == one ]]
  [[ $(cat "$scratch/install/.oliphaunt-icu-build") == "$first_stamp" ]]
done
unset ICU_TEST_FAIL
build
[[ $(cat "$scratch/install/lib/libicuuc.a") == two ]]
[[ $(cat "$scratch/install/.oliphaunt-icu-build") != "$first_stamp" ]]
last_commands=$(wc -l < "$ICU_TEST_LOG")
build
[[ $(wc -l < "$ICU_TEST_LOG") == "$last_commands" ]]
printf 'ICU repeated builds, changed inputs and failed rebuild preservation passed\n'
