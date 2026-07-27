# Maintainer Asset Notes

This page is maintainer documentation for packaged runtime assets, generated
payloads, and release provenance. It is not end-user product documentation.
Native application users should start with
`src/docs/content/learn/native-runtime.md` and the SDK README for their
platform. WASIX users should use
the public WASM SDK guide and `src/docs/content/sdk/wasm/runtime.md`.

`oliphaunt-wasix` does not embed the database runtime in the SDK crate. Runtime,
PGDATA template, extension, and AOT payloads are package-manager-resolved
artifact products staged by the language build integration.

## What Ships

The WASIX artifact products contain:

- the portable Oliphaunt/Postgres WASIX runtime tree;
- a prepopulated PGDATA template for faster temporary databases;
- bundled extension archives for supported SQL extensions;
- the packaged `initdb` module used by asset CI and explicit fresh-initdb paths;
- the packaged `pg_dump` module used by the public dump API and CLI;
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

Runtime files are expanded into a cache and then composed with a small writable
per-root skeleton by default. Temporary and template-backed databases use a
cached PGDATA template as a lower filesystem and materialize files into the
database root only when PostgreSQL opens them for mutation.

The runtime tree keeps both `/bin/oliphaunt` and `/bin/postgres`. They are the same
backend module; the `postgres` path exists so upstream `initdb` can discover and
spawn the backend through PostgreSQL's normal `find_other_exec()` path.

The cache is content-addressed by the asset manifest and artifact hashes. If an
asset hash does not match the manifest, startup fails instead of using a mixed
or corrupted runtime.

## Extension Assets

Extensions are demand-driven. An extension archive is installed into the
database root only when the builder requests it or `enable_extension` is called:

```rust,no_run
use oliphaunt_wasix::{extensions, Oliphaunt};

let mut db = Oliphaunt::builder()
    .temporary()
    .extension(extensions::VECTOR)
    .open()?;

db.enable_extension(extensions::PG_TRGM)?;
# Ok::<_, Box<dyn std::error::Error>>(())
```

Archive extraction rejects parent traversal, absolute paths, symlinks,
hardlinks, device nodes, and unsupported entry types.

## Provenance

Asset provenance is recorded in runtime source pins under
`src/sources/third-party/**`, extension-owned source pins under
`src/extensions/external/**/source.toml` and
`src/extensions/external/**/dependencies/**/source.toml`,
`src/sources/toolchains/**`, the committed asset input fingerprint, and the
generated runtime/AOT manifests produced by the
`CI` workflow's WASM runtime lane. Generated manifests record source pins,
runtime hashes, `initdb` hashes, PGDATA template hashes, extension archive
hashes, target information, and Wasmer engine identity. PostgreSQL ICU support
uses the same provenance path: ICU is source-pinned in
`src/sources/third-party/shared/icu.toml`, checked out under
`target/oliphaunt-sources/checkouts/icu`, and built as target-specific static
libraries by the native and WASIX runtime builders. ICU data is packaged as a
separate `oliphaunt-icu` payload; base native and WASIX runtime artifacts do
not carry `share/icu`.

The public repository tracks source-controlled inputs and crate skeletons. It
does not track upstream source checkouts, generated PGDATA templates, portable
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
Docker inputs, and shims that should affect the committed asset fingerprint.

Normal development and source-free validation do not clone upstream repositories
or run Docker. The source-free gate is:

```sh
cargo run -p xtask -- assets verify-committed
```

It verifies source pins, source/build input fingerprints, extension
metadata/constants when generated manifests are installed, AOT crate templates,
and the absence of committed PGDATA template, portable WASIX, or native AOT
blobs.

Release assets are built with the `release` profile by default: WASIX C code
uses `-O2 -g0`, and Binaryen runs the wasixcc default optimization plus
`--converge`, `--strip-debug`, and `--strip-producers`. The `release-o3`
profile remains available for explicit O3/ThinLTO comparison builds.

Generated runtime hashes in package metadata are refreshed in the release
staging workspace. The committed `asset-inputs.sha256` is a
binary-semantic digest of source pins, patches, build recipes, producer code,
toolchain inputs, and normalized dependency locks. Release versions,
changelogs, package descriptions, and smoke expectations belong to the
publication envelope/lock and do not invalidate the expensive binary build.

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
4. Refresh `asset-inputs.sha256`, then require the complete portable/AOT build
   and exact-SHA hosted qualification.

Treat any base image, frontend, snapshot, trust-root, source-set, APT helper, or
package-list change as a binary-semantic toolchain change. Ubuntu documents
archive snapshot availability for at least two years, so advance and qualify
the snapshot before that retention window expires or preserve it in an
authenticated archival mirror.

The `CI` workflow's WASM runtime/AOT build lane mirrors the release topology on
trusted producer runs: one Linux/Docker job builds portable WASIX modules from
`src/runtimes/liboliphaunt/wasix/assets/build` into `target/oliphaunt-wasix/assets`,
then native matrix jobs generate and package target-specific Wasmer AOT crates
into `target/oliphaunt-wasix/aot/<target>`. Artifacts are uploaded with
checksums, manifests, and the committed asset-input fingerprint.

Pull requests run a Moon-based asset plan instead of GitHub path-filtering the
workflow. The plan uses `moon query affected` for the PR base/head, plus the
asset producer path allowlist, to decide whether the expensive producer jobs are
required. Non-asset PRs become an explicit no-op after the source-controlled
asset-input checks. Asset-producing PRs run those input checks and the same full
portable/AOT producer path as `main` and explicit maintainer dispatches.

Manual `CI` dispatches use the same producer path. Maintainers may select
one native target for focused validation, but the workflow still rebuilds
portable WASIX assets, generates AOT artifacts, runs the runtime gate, stages the
release workspace, package-checks the target crate, and uploads the canonical
release artifact shape.

Native AOT generation intentionally installs Wasmer's LLVM 22.1.x custom build
only inside the `CI` workflow's WASM AOT jobs or a maintainer's explicit
local artifact build. Normal contributors and end users never need LLVM; they
use committed Rust sources plus downloaded or released AOT payloads.

The normal CI runtime matrix downloads the latest compatible `CI` workflow
WASM runtime bundle, verifies that the downloaded fingerprint matches the
current source inputs, installs the payloads into ignored generated paths, and
runs runtime tests. Changes to source pins, WASIX patches, extension catalogs,
build scripts, or AOT crate templates are treated as asset-producing: pull
requests must pass the source-controlled asset-input gate and the full producer
workflow before merge, while `main` and explicit maintainer dispatches remain
trusted producer lanes for release artifacts. Release validation downloads the
exact-SHA portable and AOT bundles, stages them into a clean release workspace,
validates package contents, and only then publishes.

Published releases also attach public `.tar.zst` mirrors of the validated
portable WASIX and target AOT bundles. `xtask assets download --release <tag>`
installs those release assets directly and does not require the GitHub CLI.

After an intentional asset-source change and regenerated artifacts, refresh the
committed input fingerprint:

```sh
cargo run -p xtask -- assets input-fingerprint --write
```
