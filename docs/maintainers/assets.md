# Maintainer Asset Notes

This page is maintainer documentation for packaged runtime assets, generated
payloads, and release provenance. It is not end-user product documentation.
Native application users should start with
`src/docs/content/learn/native-runtime.mdx` and the SDK README for their
platform. WASIX users should use the public Rust WASIX or WASIX TypeScript
guide under `src/docs/content/sdk/`.

`oliphaunt-wasix` does not embed the database runtime in the SDK crate. Runtime,
cluster-seed, extension, and AOT payloads are package-manager-resolved
artifact products staged by the language build integration.

## What Ships

The WASIX artifact products contain:

- the portable Oliphaunt/Postgres WASIX runtime tree;
- `standard` and `icu` cluster seeds for faster new databases;
- bundled extension archives for supported SQL extensions;
- the packaged `initdb` module used by asset CI and explicit fresh-initdb paths;
- the packaged `pg_dump` and `psql` modules used by the optional tools APIs and
  maintenance CLI;
- a target-specific Wasmer AOT pack when the current host target is supported.

Application code depends on `oliphaunt-wasix` plus the selected artifact
packages. The build integration stages only selected package-manager artifacts
into the application output.

## Feature Flags

Default SDK dependency after the first public release (use the exact version
selected by the application lockfile):

```toml
oliphaunt-wasix = "0.1"
```

Enable the extension API explicitly:

```toml
oliphaunt-wasix = { version = "0.1", features = ["extensions"] }
```

The repository source version remains `0.0.0` until Release Please creates the
first `0.1.0` release PR. Do not copy the repository source version into a
consumer manifest and do not reuse the legacy repository-wide `0.5.x` tags;
they predate the independently versioned Oliphaunt products.

The crate exposes no `bundled` feature. Runtime and AOT assets enter the
application through package-manager artifact products, not through SDK default
features or public archive environment variables.

## Cache Behavior

Runtime and cluster-seed assets are content-addressed, but hydration is
provider-specific. Rust WASIX host-directory storage expands one cached
seed and clones or copies it into each database; Rust WASIX memory storage
expands a fresh virtual filesystem for each database. WASIX TypeScript caches
the prepared runtime and module, while each selected storage provider
materializes and publishes its own mutable cluster. There is no universal
cached lower filesystem or copy-on-mutation implementation today.

The locked cross-runtime cluster-seed architecture, including the `standard`
and `icu` profiles and the recurring release checklist, is documented
in [Cluster seeds and ICU](../architecture/cluster-seeds-and-icu.md).

The portable artifact installs the backend once under PostgreSQL's conventional
`/bin/postgres` name. Both direct hosts execute that path, and upstream `initdb`
discovers the same regular file through its normal `find_other_exec()` path.
The internal build output and AOT artifact retain the Oliphaunt product identity,
but that branding does not leak into PostgreSQL's installed executable layout.

The cache is content-addressed by the asset manifest and artifact hashes. If an
asset hash does not match the manifest, startup fails instead of using a mixed
or corrupted runtime.

## Extension Assets

Extensions are demand-driven. Select extensions on the builder before `open()`
or server `start()`. The binding installs the selected archives and applies any
generated startup configuration, including `shared_preload_libraries`, before
PostgreSQL starts:

```rust,no_run
use oliphaunt_wasix::{extensions, Oliphaunt};

let mut db = Oliphaunt::builder()
    .extensions([extensions::VECTOR, extensions::PG_TRGM])
    .open()?;
# Ok::<_, Box<dyn std::error::Error>>(())
```

Archive extraction rejects parent traversal, absolute paths, symlinks,
hardlinks, device nodes, and unsupported entry types.

## Provenance

Asset provenance is recorded in runtime source pins under
`src/sources/third-party/**`, extension-owned source pins under
`src/extensions/external/**/source.toml` and
`src/extensions/external/**/dependencies/**/source.toml`,
`src/sources/toolchains/**`, the exact producer commit, and the generated
runtime/AOT manifests produced by the
`CI` workflow's WASIX runtime lane. Generated manifests record source pins,
runtime hashes, `initdb` hashes, cluster-seed hashes, extension archive
hashes, target information, and Wasmer engine identity. PostgreSQL ICU support
uses the same provenance path: ICU code is source-pinned in
`src/sources/third-party/shared/icu.toml`, while the canonical official
little-endian data archive is independently pinned in
`src/sources/third-party/shared/icu-data.toml`. Native and WASIX builders compile
target-specific ICU code but expand that one data archive into the shared
files-data identity. ICU data is packaged as a separate `oliphaunt-icu`
payload; standard native and WASIX runtime artifacts do not carry `share/icu`.
That payload supplies runtime capability; it is distinct
from the per-database `pg_collation` catalog state created during `initdb`.
An ICU-enabled new root therefore requires the matching `icu` cluster seed
as well as the ICU data payload.

The public repository tracks source-controlled inputs and crate skeletons. It
does not track upstream source checkouts, generated cluster seeds, portable
WASIX blobs, or native AOT binaries.
Maintainer source trees are fetched on demand into ignored
`target/oliphaunt-sources/checkouts/**` directories:

```sh
cargo run -p xtask -- assets fetch
```

A Git source may declare one manually reviewed `mirror_url` when upstream
operates an authoritative HTTPS mirror. The canonical `url` remains the
durable `origin`; the fetcher alternates the canonical endpoint and mirror
within one bounded retry budget, then accepts bytes only when Git resolves
`FETCH_HEAD` to the declared 40-hex commit. Mirror selection never changes the
branch, commit, checkout-safety checks, or transactional promotion boundary.
Do not infer mirrors from host names or add an unauthenticated community fork.
Acquisition-policy changes require the source-fetch fault suite, manifest
validation, and a live exact-commit fetch from every newly declared endpoint.

WASIX build and work trees are generated under
`target/oliphaunt-wasix/wasix-build/**`. The source tree
`src/runtimes/liboliphaunt/wasix/assets/build/**` is reserved for scripts, patches,
Docker inputs, and shims that define the build at the exact producer commit.

Normal development and source-free validation do not clone upstream repositories
or run Docker. The source-free gate is:

```sh
cargo run -p xtask -- assets verify-committed
```

It verifies source pins, source and toolchain inputs, extension
metadata/constants when generated manifests are installed, AOT crate
templates, and the absence of committed cluster-seed, portable WASIX, or
native AOT blobs.

Release assets are built with the `release` profile by default: WASIX C code
uses `-O2 -g0` with ThinLTO through the final guest link, and Binaryen runs the
wasixcc default optimization plus `--converge`, `--strip-debug`, and
`--strip-producers`. The `release-o3` profile remains available for explicit O3
comparison builds.

Generated runtime hashes in package metadata are refreshed in the release
staging workspace. CI-produced assets are selected by exact workflow run or
exact commit, and their manifests and checksums bind the installed runtime and
AOT bytes. Release versions, changelogs, package descriptions, and smoke
expectations belong to the publication envelope/lock and do not alter those
runtime bytes.

The WASIX builder declares its immutable bootstrap inputs in
`src/sources/toolchains/wasix.toml`: the Ubuntu base image digest, Dockerfile
frontend digest, Ubuntu snapshot timestamp, and the committed TLS root used to
reach `snapshot.ubuntu.com`. The APT helper writes one isolated deb822 source
containing only `noble`, `noble-updates`, and `noble-security` with the `main`
and `universe` components. Every update and install explicitly binds that
source, disabled source-parts discovery (`Dir::Etc::sourceparts=-`), a reset
list directory, and the verified CA bundle. A transient failure retries the
complete update/install transaction with a fixed bound; it never falls back to
a live mirror or disables TLS verification. `ca-certificates` is installed in
the same pinned transaction as the builder packages.

The committed `isrg-root-x1.pem` is independently SHA-256 pinned, and
`builder.snapshot_tls_root_not_after` records its certificate-derived expiry
boundary. Rotate it before the manifest-declared boundary, or sooner if the
snapshot service changes its certificate chain:

1. Obtain the replacement trust root from its authoritative CA distribution,
   verify its subject, issuer, fingerprint, and `notAfter` value independently,
   and replace only the committed PEM.
2. Update `snapshot_tls_root_sha256` and `snapshot_tls_root_not_after` in the
   WASIX toolchain manifest, then update the Docker SHA-256 build argument to
   match. If the Dockerfile frontend changes, pin its content digest in the
   same change.
3. Run the pinned APT helper fault tests, source-spine verification, and a clean
   Docker builder build. The build must reach the snapshot with normal peer
   verification and print the pinned wasixcc, Clang, and Binaryen versions.
4. Require the complete portable/AOT build and exact-SHA hosted qualification.

Treat any base image, frontend, snapshot, trust-root, source-set, APT helper, or
package-list change as a binary-semantic toolchain change. Ubuntu documents
archive snapshot availability for at least two years, so advance and qualify
the snapshot before that retention window expires or preserve it in an
authenticated archival mirror.

The `CI` workflow's WASIX runtime/AOT build lane mirrors the release topology on
trusted producer runs: one Linux/Docker job builds portable WASIX modules from
`src/runtimes/liboliphaunt/wasix/assets/build` into `target/oliphaunt-wasix/assets`,
then native matrix jobs generate and package target-specific Wasmer AOT crates
into `target/oliphaunt-wasix/aot/<target>`. Artifacts are uploaded with
checksums and manifests.

Pull requests run a Moon-based asset plan instead of GitHub path-filtering the
workflow. The plan uses `moon query affected` for the PR base/head, plus the
asset producer path allowlist, to decide whether the expensive producer jobs are
required. Non-asset PRs become an explicit no-op after the source and toolchain
checks. Asset-producing PRs run those checks and the same full
portable/AOT producer path as `main` and explicit maintainer dispatches.

Manual `CI` dispatches use the same producer path. Maintainers may select
one native target for focused validation, but the workflow still rebuilds
portable WASIX assets, generates AOT artifacts, runs the runtime gate, stages the
release workspace, package-checks the target crate, and uploads the canonical
release artifact shape.

Native AOT generation intentionally installs Wasmer's LLVM 22.1.x custom build
only inside the `CI` workflow's WASIX AOT jobs or a maintainer's explicit
local artifact build. Normal contributors and end users never need LLVM; they
use committed Rust sources plus downloaded or released AOT payloads.

The normal CI runtime matrix downloads a `CI` workflow WASIX runtime bundle by
exact run ID or exact commit SHA, validates its packaged manifests and
checksums, installs the payloads into ignored generated paths, and runs runtime
tests. Changes to source pins, WASIX patches, extension catalogs, build scripts,
or AOT crate templates are treated as asset-producing: pull requests must pass
the source and toolchain checks and the full producer workflow before
merge, while `main` and explicit maintainer dispatches remain trusted producer
lanes for release artifacts. Release validation downloads the exact-SHA
portable and AOT bundles, stages them into a clean release workspace, validates
package contents, and only then publishes.

Published releases also attach public `.tar.zst` mirrors of the validated
portable WASIX and target AOT bundles. `xtask assets download --release <tag>`
installs those release assets directly and does not require the GitHub CLI.
For workflow artifacts, select one exact run or full commit SHA; all three modes
validate checksums and packaged manifests before installation:

```sh
cargo run -p xtask -- assets download --run-id <id> --target-triple <triple>
cargo run -p xtask -- assets download --sha <full-40-character-sha> --target-triple <triple>
cargo run -p xtask -- assets download --release <tag> --target-triple <triple>
```
