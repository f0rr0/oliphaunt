# Compiler Caching

Status: normative cache policy. Last verified: 2026-07-21. Owner: repository maintainers.

Oliphaunt uses three separate cache layers. Keep them separate:

- Moon caches deterministic task outputs.
- Cargo, Gradle, pnpm, SwiftPM, and Xcode cache their own dependency/build
  state through their native tools.
- Compiler caches reuse object-code compilation when a native lane has to run.

Moon decides whether a product task runs. Compiler caches make the task cheaper
when it does run. Do not replace affectedness with compiler cache hits, and do
not treat compiler cache hits as release evidence.

## Current Decision

Use `ccache` for C/PostgreSQL native runtime builds on macOS, Linux,
iOS-simulator/device, and Android host builds when the build runs from a Unix
shell. These lanes compile PostgreSQL and liboliphaunt through clang or gcc, and
the build scripts already route `CC`/`CXX` through ccache when it is available.

Use Cargo cache actions for Rust dependencies and `target` reuse only in the
bounded primary WASIX producer. Do not enable `sccache` by default yet.

Gradle consumers may restore the one Kotlin package-producer cache; only that
producer may write it. Use normal local SwiftPM, pnpm, and Moon caches, but do
not add repository-wide GitHub cache writers for them without measured evidence
and an explicit storage budget. Do not put simulator state, device state,
registry responses, PostgreSQL source checkouts, or release artifacts into
Moon's cache.

Do not share native build roots across targets. Sharing object caches can be
reasonable when the compiler cache understands the compiler identity and flags,
but sharing build directories across macOS, Linux, iOS, Android, and Windows is
not.

## Local Native Builds

The liboliphaunt build scripts automatically use `ccache` when it is on `PATH`.

```sh
brew install ccache
src/runtimes/liboliphaunt/native/bin/build-postgres18-macos.sh
ccache --show-stats
```

On Linux:

```sh
sudo apt-get install ccache gcc-12 g++-12
src/runtimes/liboliphaunt/native/bin/build-postgres18-linux.sh
ccache --show-stats
```

Linux release carriers are compiled with GCC/G++ 12 so they cannot require a
newer GNU C++ ABI than the published `GLIBCXX_3.4.30` ceiling. The build script
selects `gcc-12` and `g++-12` by default, verifies their major versions before
starting an expensive build, and fingerprints the exact compiler binaries into
the PostGIS dependency cache. Set `OLIPHAUNT_CC` and `OLIPHAUNT_CXX` together
only when pointing at an equivalent GCC 12 toolchain; other compiler majors are
rejected before compilation.

The iOS and Android native build scripts use the same `OLIPHAUNT_CCACHE`
contract because they are clang-based cross-builds launched from macOS.

Override or disable it with:

```sh
OLIPHAUNT_CCACHE=/opt/homebrew/bin/ccache src/runtimes/liboliphaunt/native/bin/build-postgres18-macos.sh
OLIPHAUNT_CCACHE=off src/runtimes/liboliphaunt/native/bin/build-postgres18-macos.sh
```

The build scripts use prefix mode (`CC="ccache cc"` style). Keep cache
configuration boring: set a local size, review `ccache --show-stats`, and avoid
broad `CCACHE_SLOPPINESS` settings unless a measured local experiment proves the
trade-off is worth it.

Recommended local defaults:

```sh
ccache --max-size=10G
ccache --set-config=compression=true
```

Use a per-workstation cache directory only when you need to isolate experiments:

```sh
CCACHE_DIR="$HOME/.cache/oliphaunt-ccache" src/runtimes/liboliphaunt/native/bin/build-postgres18-macos.sh
```

## CI Cache Writer Budget

Cross-run cache writes are allowed automatically only on a push to `main`. A
manual CI run may write them only when it targets `main` and explicitly enables
`save_heavy_caches`. Pull requests, branch qualification runs, release entry
jobs, and publish/finalization jobs are restore-only.

The bounded writer inventory is executable policy, not a convention:

- the primary Linux x64 WASIX runtime producer may write its Rust, Wasmer LLVM,
  BuildKit, and exact WASIX compilation caches;
- the iOS exact-extension producer may write one 512 MiB ccache entry after a
  miss;
- the Kotlin SDK package producer may let `actions/setup-java` write the Gradle
  dependency cache used by read-only consumers.

Every other Rust, LLVM, Gradle, and native lane is restore-only or uses only
ephemeral job-local state. Cache saves are best-effort and cannot fail
qualification. The workflow policy rejects implicit `actions/cache` writers,
additional composite-action writers, branch-writable conditions, and unbounded
native cache paths.

This is a storage and correctness boundary. A cache hit is never release
evidence, and deleting all repository caches must not change published bytes.

## CI Native Builds

Native jobs give each target an explicit local ccache directory under
`.ci-cache/ccache/native-extension/<target>` or
`.ci-cache/ccache/native-runtime/<target>`. Keeping that directory outside the
native work roots prevents source preparation from deleting compiler objects.
`CCACHE_BASEDIR` anchors paths to the checkout, `compiler_check=content` binds
hits to the actual compiler, and compression is enabled.

Only the iOS exact-extension ccache crosses job boundaries. Its key is:

```text
liboliphaunt-native-extension-ccache-v2-<target>-<runner.os>-<runner.arch>-<input-hash>
```

Desktop, Android, base-iOS, and non-iOS extension jobs still use ccache within
the job, but do not restore or save it across jobs. No native lane restores or
saves a build root. Build systems use timestamps and partially generated state;
a broad prefix restore can therefore make an old output look newer than changed
source and publish stale bytes. Exact keys reduce that risk but do not make a
multi-build tree a safe compiler cache.

Do not use `~/.ccache`: current ccache defaults use platform-specific cache
directories, so that legacy path can silently miss the actual compiler objects.
Do not combine a ccache directory and a native build root in one cache action.

The repository cache is already close to GitHub's 10 GiB budget, and WASIX/LLVM
entries are the largest high-value caches. Persist only the iOS extension
ccache, which serves the roughly 70-minute native-extension critical path, and
cap it at 512 MiB. Other extension targets may use local ephemeral ccache during
their job, but do not consume repository cache quota. Do not persist complete
extension work roots: the iOS host, simulator, device, dependency, and
XCFramework trees are multi-build state with no demonstrated transfer win, can
consume multiple GiB, and are not safe to reuse through broad restore prefixes.
The ccache restore prefix is safe because ccache independently keys objects by
compiler content, source content, and compilation options.

The iOS extension ccache input hash tracks compiler-affecting inputs only:
PostgreSQL and third-party pins, extension source/build metadata and patches,
generated build plans, Apple/toolchain setup, and the exact native runtime
sources and build scripts used by that target. It deliberately excludes
versions, changelogs, evidence prose, notices, and release orchestration that do
not alter compiler output. ccache still validates compiler content, source
content, and flags before returning an object.

CI prints `ccache --show-stats` after native builds. Treat those stats as the
first signal before changing cache size, keys, or storage.

## Windows

The Windows liboliphaunt lane uses MSVC and Meson/Ninja without cross-run build
root reuse. `ccache` is not the right default there; if Windows object caching
becomes necessary, use `sccache` for MSVC in a dedicated CI experiment before
promoting it to the release path.

Use a native Windows Perl for PostgreSQL's MSVC build, such as Strawberry Perl.
Do not let Meson discover Git/MSYS Perl for this lane: MSYS path rewriting can
turn native linker options into bogus paths before PostgreSQL's Windows export
generation calls `dumpbin`.

## sccache

`sccache` is attractive because it supports Rust, C/C++, MSVC, local caches,
GitHub Actions cache storage, cloud storage, and distributed compilation. It is
also a bigger operational choice:

- Rust cache hits require `RUSTC_WRAPPER=sccache`, and incremental workspace
  crates are not cacheable.
- C/C++ cache hits require build-system launcher integration per build path.
- Shared cache hit rates depend heavily on stable toolchains, SDKs, compiler
  flags, absolute path normalization, and per-platform keys.
- Remote or GitHub-backed caches add a new failure mode and need stats before
  being trusted.

Recommended adoption path:

1. Keep ephemeral native `ccache`, the one bounded iOS extension ccache, and the
   bounded primary WASIX Cargo cache as the release path.
2. Add a manual `workflow_dispatch` experiment that enables
   `mozilla-actions/sccache-action`, `SCCACHE_GHA_ENABLED=true`, and
   `RUSTC_WRAPPER=sccache` for Rust-heavy lanes only. Set `CARGO_INCREMENTAL=0`
   in that experiment so Rust compiler outputs are cacheable and comparable.
3. Compare wall time, cache hit rate, upload/download time, and flake rate
   against the current CI for at least five same-SHA reruns.
4. If Rust results are good, add a second experiment for Windows MSVC and
   Unix C/C++ builds through explicit compiler launchers. Keep target-specific
   cache scopes; do not let Linux, macOS, iOS, Android, and Windows publish into
   one undifferentiated cache namespace.
5. Promote sccache only after the experiment writes stable stats to the CI
   summary and has a documented rollback switch.

Use these environment variables only in the experiment workflow:

```text
SCCACHE_GHA_ENABLED=true
RUSTC_WRAPPER=sccache
CARGO_INCREMENTAL=0
```

For local Rust experimentation, keep it opt-in:

```sh
brew install sccache
RUSTC_WRAPPER=sccache CARGO_INCREMENTAL=0 cargo test -p oliphaunt
sccache --show-stats
```

## References

- ccache manual 4.13.6: <https://ccache.dev/manual/4.13.6.html>
- sccache README: <https://github.com/mozilla/sccache>
- sccache GitHub Action: <https://github.com/Mozilla-Actions/sccache-action>
- GitHub Actions cache: <https://github.com/actions/cache>
- Meson machine files: <https://mesonbuild.com/Machine-files.html>
