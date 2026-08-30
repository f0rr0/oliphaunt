# Extensions

Status: normative extension packaging policy. Last verified: 2026-07-22.
Owner: repository maintainers.

Oliphaunt uses exact, opt-in PostgreSQL extension selection. App developers
select the SQL extension names they intend to ship, and the generated runtime
assets contain only those extension assets plus mandatory manifest
dependencies. `vector` means the PostgreSQL SQL extension named `vector`.
There is no selector expansion, alias, shorthand, or release selector that
expands to multiple extensions. Names such as `core`, `search`, or `geo` are
not Oliphaunt catalog entries or release units. A name is selectable only when
it is an exact PostgreSQL extension name from the built-in catalog or a
verified external artifact index.

## Release products and carriers

Release ownership is not the same thing as SQL selection. The 32 public
PostgreSQL 18 contrib members have native carriers owned by
`liboliphaunt-native` and WASIX carriers owned by `liboliphaunt-wasix`. The
shared inventory has no version, changelog, or tag of its own. A shared contrib
source change selects both runtimes; a native-only change does not select WASIX
and a WASIX-only change does not select native.

Every public external extension is an independently
tagged release product. Its packaging version, changelog, immutable upstream
source identity, and compatibility metadata live with that product.

For an external extension, `release.toml` is the active-public-product
boundary, not general build metadata. Experimental extension work belongs on a
branch; an extension merged into the public catalog has a complete package
identity and only claims targets it supports.

`tools/release/extension-target-profiles.toml` is the single exact-extension
target contract. Every extension merged to main ships on every target in that
contract; incomplete target work stays on a branch. This keeps target coverage
fail-closed without 39 identical member manifests or status fields. The
release tool expands the global profiles against the canonical SQL catalog and
the runtime artifact inventory, so a target absent from either source cannot
be packaged accidentally.

Native library relationships are declared once in
`src/extensions/catalog/native-components.toml`. A requirement is keyed by
exact SQL name, artifact family, artifact kind, and target. Its
transitive closure supplies component build order, static link units, runtime
files, and source identities to native mobile, desktop packaging, and WASIX
producers. Target differences must be separate requirement rows; for example,
PostGIS carries `libiconv` on Android and WASIX but not in its iOS closure, and
`proj` always brings `sqlite` plus `proj/proj.db`.

This component contract is data, not a second build graph. Moon remains the
only project/task dependency graph and invokes the existing artifact producers.
The producers resolve and validate the component closure for their concrete
target. SDKs consume the generated target projection or the resulting carrier;
they must not reproduce the component graph.

Ecosystem packages are carriers, not extra products: a stable Cargo façade,
native/WASIX Cargo leaves, an npm façade plus selected platform packages,
Android ABI Maven artifacts, and SwiftPM/GitHub assets as declared by the
target contract. Contrib carriers use their owning runtime release and contain
an exact member inventory with nested path, byte count, and checksum for every
SQL member. External products have separate carriers and versions. Every
consumer resolves by SQL name and extracts/stages only the selected member and
its declared dependencies. The publication catalog defines the stable
identities and the frozen publication lock records the actual files. Only
oversized crates.io payload parts may be generated dynamically.

JavaScript package naming keeps the established native/default surface
unsuffixed. For example, `@oliphaunt/extension-pgtap` remains the native npm
facade and its native platform leaves retain names such as
`@oliphaunt/extension-pgtap-linux-x64-gnu`. The portable WASIX leaf alone is
named `@oliphaunt/extension-pgtap-wasix`; there is no parallel `-native`
identity. The facade, native leaves, WASIX leaf, Cargo carriers, and release
assets all share the owning extension product's exact packaging version, tag,
and changelog.

An npm WASIX leaf is host-neutral: browser, Node, Bun, Deno, and Electron WASIX
hosts consume the same descriptor package. Its ESM descriptor selects one exact
SQL extension and carries the verified browser byte closure required to
materialize it. Native hosts validate that identity and resolve the SQL name
against the frozen catalog embedded in their Node-API addon. Contrib
members use exact package subpaths so importing one member does not create an
implicit selector group. Each extension product freezes its own archive
identity and `oliphaunt-wasix-extension-install-v1` projection: dependencies,
load order, lifecycle, installed files, compact module hashes, required core
exports, and unresolved imports. The compatible host checks the carried bytes
against that descriptor/install contract. The base runtime carrier deliberately
ships a core-only manifest with `extensions: []`; it owns runtime support and
core identity, not independently versioned extension metadata. Importing a
carrier is not by itself a browser, Node, Bun, Deno, or Electron support claim.

Physical aggregate carriers use `oliphaunt-extension-bundle-v1`. Their
manifest describes the immutable nested archives and compatibility contract;
every `kind=runtime` member has `identity=null` and is uniquely located by its
SQL name, kind, and nested path. The expanded npm platform package is a
different representation: publication extracts every nested archive into a
per-member runtime tree and writes `oliphaunt-npm-extension-bundle-v1`, adding
`runtimeRelativePath` and, when present, `moduleRelativePath`. These schemas
are deliberately not interchangeable. Published JavaScript consumers reject a
physical carrier manifest where the expanded npm index is required.

Every direct or bundle npm platform package also carries and exports
`extension-contract.json` with schema `oliphaunt-npm-extension-contract-v1`.
That manifest freezes each member's `createsExtension`, native module stem,
dependencies, data files, additional SQL names/prefixes, and preload libraries
at the independently versioned extension release. It also freezes the exact,
sorted `share/licenses/` file inventory derived from that member's canonical
carrier legal metadata. Every row binds the portable path, canonical SHA-256,
and archive mode `0644`; contrib members therefore declare an explicit empty
list. JavaScript validates the exact contract schema, rejects unsafe or
colliding paths, verifies the declared bytes, and rejects installed modes that
grant permissions beyond canonical mode `0644`; a consumer's restrictive
umask may safely remove write/read permissions during installation. On
Windows, where the installed filesystem does not preserve POSIX owner/group
mode bits, the runtime enforces the representable non-executable mode. The
packed carrier check proves exact mode `0644` on every platform. The runtime
also requires every declared legal file and no undeclared runtime leaf. It uses
this frozen contract—not the SDK's current catalog snapshot—to qualify the
installed package's runtime leaf inventory. The SDK catalog remains
authoritative for selection, release/package ownership, and dependency
compatibility.

## Carrier license and notice contract

Extension legal material is derived from the physical payload role. A
code-only Cargo or npm facade carries only the Oliphaunt MIT profile. A contrib
native or WASIX payload carries the PostgreSQL profile and carries OpenSSL only
for an exact target whose selected `pgcrypto` member embeds OpenSSL bytes. An
external payload carries the exact upstream license and notice files whose
source identities, paths, URLs, SHA-256 digests, and content-addressed bytes are
frozen in that product's canonical
`src/extensions/external/<sql_name>/upstream-license-data.json`. Keeping this
closure product-local preserves independent extension versioning: a legal-data
change for one extension cannot bump unrelated external products. Final
packaging verifies every digest and never depends on ambient source checkouts
or an implicit network fetch. Source qualification separately proves that the
committed blobs still match the clean, pinned upstream trees.

The same derived contract applies at every boundary: direct runtime archives,
mobile dependency archives, nested bundle members, physical aggregates,
payload-part packages, expanded npm packages, Maven primary artifacts and
their `sources` and `javadoc` companions, and final Cargo archives. Every final
archive is checked for an exact root notice profile and exact
`share/licenses/` namespace, including entry type and mode. Do not copy this
target/package mapping into documentation; the extension catalog, target
manifests, release-notice profiles, and upstream-license helper are the
executable authority.

These checks verify the repository-declared license and notice contents of each
carrier. Passing them is not legal advice or certification of comprehensive
legal compliance. PostGIS is an active public external product and follows the
same carrier checks as every other public external extension.

## Rust

The release invariant is strict: generated app resources must contain only the
selected exact extensions plus mandatory manifest dependencies.

```rust,no_run
use oliphaunt::{Extension, Oliphaunt};

# fn demo() -> oliphaunt::Result<()> {
let mut db = Oliphaunt::builder()
    .direct()
    .extension(Extension::VECTOR)
    .open()?;

db.execute("CREATE EXTENSION vector")?;
db.close()?;
# Ok(())
# }
```

The same rule applies to package tooling:

```sh
cargo run -p oliphaunt-native-packaging --bin oliphaunt-resources -- \
  --output target/oliphaunt-resources \
  --extension vector \
  --force
```

Selecting `vector` ships `vector`. It must not ship `hstore`, `pg_trgm`,
`cube`, `earthdistance`, pgGraph, ParadeDB, or any other unselected extension.
The only exception is a mandatory dependency declared by the canonical
generated extension metadata; for example `earthdistance` includes `cube`.

End developers should not have to build PostgreSQL or extension source to know
what they can ship. The runtime-resource CLI exposes the public prebuilt
catalog without requiring a local native build:

```sh
cargo run -p oliphaunt-native-packaging --bin oliphaunt-resources -- --list-extensions
```

The catalog is TSV so CI, SwiftPM plugins, Gradle tasks, Expo config plugins,
and release automation can consume it directly. `desktop_prebuilt=yes` means
the extension is available for Rust/Tauri, macOS, Linux, and desktop resource
artifacts from Oliphaunt release artifacts. `mobile_prebuilt=yes` means iOS and
Android apps can include the extension from Oliphaunt prebuilt mobile artifacts
without compiling extension source. `mobile_prebuilt=no` is a hard release
boundary, not a hint to make app developers compile source locally.

## Prebuilt Third-Party Artifacts

The open-ended extension path is also exact-name based. A third-party
extension is selected by passing a prebuilt artifact directory or archive, not
by compiling source inside the app project:

```sh
cargo run -p oliphaunt-native-packaging --bin oliphaunt-resources -- \
  --output target/oliphaunt-resources \
  --extension vector \
  --prebuilt-extension vendor/acme_ext.tar.zst \
  --liboliphaunt-native-version 0.1.0 \
  --force
```

Artifacts are produced from already-built PostgreSQL runtime files with the
unpublished native-packaging tool:

```sh
cargo run -p oliphaunt-native-packaging --bin oliphaunt-extension-artifact -- \
  --runtime target/acme-pg18-runtime/files \
  --sql-name acme_ext \
  --native-module-stem acme_ext \
  --native-module-file acme_ext.so \
  --native-target linux-x64-gnu \
  --embedded-module-root target/acme-pg18-embedded/modules \
  --native-runtime-version 0.1.0 \
  --data-file data/acme_ext.rules \
  --license-profile external-native \
  --legal-files-root vendor/acme_ext-legal \
  --license-file share/licenses/acme_ext/LICENSE \
  --output vendor/acme_ext.tar.zst \
  --format tar-zst \
  --force
```

For desktop module extensions, `--runtime` supplies the standalone PostgreSQL
module under `lib/postgresql`, while `--embedded-module-root` supplies the
native-direct module. The artifact preserves both profile paths under
`files/lib/postgresql` and `files/lib/modules`; native server consumers select
the former, while native-direct and native-broker consumers select the latter.
Both paths are mandatory, even when their files are byte-identical.

`--legal-files-root` is a source tree, not an output directory. For the command
above it contains `LICENSE`, `THIRD_PARTY_NOTICES.md`, and
`share/licenses/acme_ext/LICENSE`; the producer places the first two at the
carrier root and the declared upstream license below `files/`.

Binary qualification derives each profile's backend binding from the binary's
actual import inventory, never from the extension name. On Windows, a
host-bound server profile may import `postgres.exe` but not `oliphaunt.dll`, and
a host-bound embedded profile may import `oliphaunt.dll` but not `postgres.exe`.
Crossed provider bindings are always packaging errors. Host-bound profile copies
must also have distinct bytes. A profile that imports neither backend provider
is host-neutral; server and embedded copies may be byte-identical only when both
are host-neutral. Omitting either desktop profile remains a packaging error.

The command does not build PostgreSQL or extension source. The producer and
consumer share the same schema validation, so the generated artifact is
immediately consumable by `oliphaunt-resources --prebuilt-extension`.

For release distribution, publish an exact artifact index next to the binary
artifacts:

```sh
cargo run -p oliphaunt-native-packaging --bin oliphaunt-extension-index -- \
  --output vendor/oliphaunt-extensions.toml \
  --target macos-arm64 \
  --artifact vendor/acme_ext-macos-arm64.tar.zst \
  --base-url https://cdn.example.com/oliphaunt/extensions/macos-arm64 \
  --signing-key-file acme-release-2026q2:keys/acme-extension-index.ed25519 \
  --force
```

The index producer validates each artifact manifest, rejects built-in extension
name overrides, computes byte counts and SHA-256 digests, and records relative
artifact paths plus catalog metadata such as dependencies, native module stem,
preload requirements, and mobile-prebuilt readiness. That metadata lets app
tooling list exact external extension names from the index without downloading
or building extension source. `--base-url` additionally records a URL for each
exact artifact row so release tooling can fetch missing artifacts into a cache
before verification. Release indexes should also publish a detached Ed25519
sidecar signature at `<index>.sig`; `--signing-key-file <key-id>:<path>` signs
the exact index bytes after writing the TOML. The signing key file contains a
hex-encoded 32-byte Ed25519 signing key.

```toml
schema = "oliphaunt-extension-artifact-index-v1"
pg_major = 18

[[artifacts]]
sql_name = "acme_ext"
target = "macos-arm64"
creates_extension = true
native_module_stem = "acme_ext"
dependencies = []
shared_preload_libraries = []
mobile_prebuilt = true
mobile_static_archive_targets = ["ios-simulator", "ios-device", "arm64-v8a"]
path = "acme_ext-macos-arm64.tar.zst"
url = "https://cdn.example.com/oliphaunt/extensions/macos-arm64/acme_ext-macos-arm64.tar.zst"
sha256 = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
bytes = 123456
```

Developers can inspect built-in plus signed external availability without a
native build:

```sh
cargo run -p oliphaunt-native-packaging --bin oliphaunt-resources -- \
  --list-extensions \
  --extension-index vendor/oliphaunt-extensions.toml \
  --extension-target macos-arm64 \
  --trusted-extension-index-key-file acme-release-2026q2:keys/acme-extension-index.ed25519.pub
```

Then app/package tooling can select the external extension by exact SQL name:

```sh
cargo run -p oliphaunt-native-packaging --bin oliphaunt-resources -- \
  --output target/oliphaunt-resources \
  --extension acme_ext \
  --extension-index vendor/oliphaunt-extensions.toml \
  --extension-target macos-arm64 \
  --extension-cache ~/.cache/oliphaunt/extensions \
  --trusted-extension-index-key-file acme-release-2026q2:keys/acme-extension-index.ed25519.pub \
  --force
```

`oliphaunt-resources` verifies the artifact byte count, SHA-256 digest, PG major,
target, and artifact manifest before consuming it. It also follows exact
extension dependencies from the index. Built-in extension names
cannot be overridden by index entries. Local sidecar artifacts next to the index
are preferred. If a URL-backed artifact is missing locally, `--extension-cache`
downloads it to a target-scoped cache and verifies bytes, SHA-256, and manifest
before packaging. HTTPS artifact downloads are available only when maintainer
packaging tool builds enable the `extension-download` feature; the published SDK
does not expose or compile this HTTP/TLS implementation. Signed index verification
uses `--trusted-extension-index-key-file <key-id>:<path>`, which requires a
matching `<index>.sig` sidecar before any indexed artifact can be used. The key
file contains a hex-encoded 32-byte Ed25519 public key. Signing and verification
are maintainer packaging-tool operations behind the `extension-signing`
feature. They are not application SDK capabilities.

`--prebuilt-extension` accepts an unpacked artifact directory, `.tar`,
`.tar.gz`, or `.tar.zst`. The artifact root must contain
`manifest.properties` plus a
`files/` runtime tree:

```properties
packageLayout=oliphaunt-extension-artifact-v1
pgMajor=18
sqlName=acme_ext
createsExtension=yes
nativeModuleStem=acme_ext
nativeModuleFile=acme_ext.so
nativeTarget=linux-x64-gnu
nativeRuntimeProduct=liboliphaunt-native
nativeRuntimeVersion=0.1.0
dependencies=
dataFiles=
extensionSqlFileNames=
extensionSqlFilePrefixes=
sharedPreloadLibraries=
mobilePrebuilt=yes
mobileStaticArchives=android-arm64-v8a:mobile-static/android-arm64-v8a/extensions/acme_ext/liboliphaunt_extension_acme_ext.a,ios-device:mobile-static/ios-device/extensions/acme_ext/liboliphaunt_extension_acme_ext.a,ios-simulator:mobile-static/ios-simulator/extensions/acme_ext/liboliphaunt_extension_acme_ext.a
mobileStaticDependencyArchives=android-arm64-v8a:openssl:mobile-static/android-arm64-v8a/dependencies/openssl/libcrypto.a,ios-device:openssl:mobile-static/ios-device/dependencies/openssl/libcrypto.a,ios-simulator:openssl:mobile-static/ios-simulator/dependencies/openssl/libcrypto.a
staticSymbolPrefix=acme_static
staticSymbolAliases=
licenseFiles=share/licenses/acme_ext/LICENSE
licenseProfile=external-native
files=files
```

The v1 manifest has exactly these 22 fields; all fields are present even when
their value is empty, and unknown fields are rejected. `nativeRuntimeProduct`
is always `liboliphaunt-native`. `nativeRuntimeVersion` is a stable `X.Y.Z`
version and must equal the version explicitly selected by
`oliphaunt-resources --liboliphaunt-native-version` (or
`OLIPHAUNT_LIBOLIPHAUNT_VERSION`). The consumer checks every direct and
index-resolved prebuilt artifact before materializing the output resource tree,
so one mismatched artifact also rejects a mixed-version package.

`files/` mirrors PostgreSQL runtime paths, for example
`files/share/postgresql/extension/acme_ext.control`,
`files/share/postgresql/extension/acme_ext--1.0.sql`, and
`files/lib/postgresql/acme_ext.dylib` on macOS. The runtime-resource generator
copies only files declared by the exact selected extension: matching control/SQL
files, declared `dataFiles`, the declared native module, mobile archives, and
the exact `licenseFiles` inventory. The complete carrier leaf set must equal
that declaration; extra files are rejected rather than ignored. Paths are
canonical relative UTF-8 paths and manifests always use `/`, including when
the producer runs on Windows.

`licenseProfile=contrib-native` requires root `LICENSE`,
`THIRD_PARTY_NOTICES.md`, and
`THIRD_PARTY_LICENSES/PostgreSQL-COPYRIGHT`, with an empty `licenseFiles` value.
`contrib-native-openssl` additionally requires
`THIRD_PARTY_LICENSES/OpenSSL-LICENSE.txt`; it is mandatory for pgcrypto targets
that embed OpenSSL. `external-native` requires the two root notices plus at
least one sorted exact `licenseFiles` path beneath `share/licenses/`, stored
beneath carrier `files/`. Legal leaves must be non-empty regular non-symlink
files with canonical mode `0644` on Unix. Missing, extra, unsafe, duplicate,
wrong-profile, or wrongly permissioned legal leaves reject the carrier.

An explicitly caller-supplied direct `--prebuilt-extension` artifact is an
intentional local override: after its archive shape, exact manifest, complete
inventory, legal members, native target, and selected runtime version all pass
the normal validation boundary, it takes precedence over the built-in payload
for the same SQL name. Artifact-index creation and loading reject entries for
built-in names, so an index-resolved artifact cannot exercise
that override. Dependencies are exact extension names and resolve to an
explicitly provided prebuilt artifact first, then to the built-in catalog or
another provided prebuilt artifact.

For mobile, `mobilePrebuilt=yes` on a native-module artifact means the artifact
itself carries matching prebuilt static archives in `mobileStaticArchives`.
The runtime-resource generator copies only selected archives into
`static-registry/archives/<target>/extensions/<stem>/`. Dependency-backed
mobile artifacts can also carry `mobileStaticDependencyArchives` entries, which
the runtime-resource generator copies into
`static-registry/archives/<target>/dependencies/<name>/`. Android SDK builds
link those dependency archives when present, and the Apple packaging helper
emits matching `liboliphaunt_dependency_<name>.xcframework` outputs for Swift
and React Native CocoaPods consumers. Every extension and dependency
XCFramework contains macOS arm64, iOS device arm64, and iOS simulator arm64
slices; missing slices fail the binary contract before the archive is admitted.
The generated static-registry source uses
`staticSymbolPrefix` when present; missing selected archives remain build/link
errors.

## Runtime Resources

The unpublished `oliphaunt-native-packaging` workspace crate owns the
runtime-resource CLI and manifest contract. Public SDKs consume its generated
resource packages; they do not expose packaging implementation APIs.
Native tool payload validation requires `pg_basebackup`, `pg_dump`, and `psql`
as one complete tools set; an incomplete payload is rejected before packaging.

Runtime resources are shared by Swift, Kotlin, and React Native:

```text
oliphaunt/
  runtime/
    manifest.properties
    files/
      lib/postgresql/  # standalone PostgreSQL server profile
      lib/modules/     # embedded direct/broker profile when selected
      share/postgresql/
  cluster-seed/
    manifest.properties
    files/
      PG_VERSION
  package-size.tsv
```

The runtime manifest records four distinct, canonical extension domains. Every
CSV is sorted and duplicate-free:

```properties
schema=oliphaunt-runtime-resources-v1
layout=postgres-runtime-files-v1
selectedExtensions=auto_explain,vector
extensions=vector
runtimeFeatures=
sharedPreloadLibraries=
mobileStaticRegistryState=complete
mobileStaticRegistryRegistered=auto_explain,vector
mobileStaticRegistryPending=
nativeModuleStems=auto_explain,vector
```

`selectedExtensions` is the full dependency-closed set of SQL identities
materialized into the package. `extensions` is exactly the subset whose
canonical metadata has `creates-extension=true`; module-only entries such as
`auto_explain` therefore remain selected without pretending to support
`CREATE EXTENSION`. `mobileStaticRegistryRegistered` is the selected subset
with native modules, expressed as SQL identities, and `nativeModuleStems` is
the corresponding native stem set. The static-registry manifest must repeat
the registered SQL-name and native-stem domains exactly. A nonempty native
domain requires `mobileStaticRegistryState=complete` with empty pending fields;
an empty one requires `not-required`.

These are exact identities, not selection aliases or catalog expansions. SDK
availability checks use `selectedExtensions`; they must never use the narrower
createable `extensions` field to decide whether module-only resources exist.
SDKs reject `open(... extensions: ["vector"])` when the selected runtime does
not advertise `vector` in `selectedExtensions`.

The size report is exact-extension based:

```text
kind	id	extensions	files	bytes
package	total	-	42	123456
package	runtime	-	30	100000
package	cluster-seed	-	10	20000
package	static-registry	-	2	3456
extensions	selected	-	3	63478
extension	vector	-	3	63478
```

Packaging and release checks read this report directly. It is build evidence,
not a public Swift, Kotlin, React Native, or database runtime API.

## Mobile Static Registry

iOS and Android cannot rely on arbitrary dynamic extension loading. A mobile
release package that includes module-backed extensions must also include and
register a matching static extension registry:

```sh
cargo run -p oliphaunt-native-packaging --bin oliphaunt-resources -- \
  --output target/oliphaunt-resources \
  --extension vector \
  --mobile-static-module vector \
  --require-mobile-static-registry \
  --force
```

`--mobile-static-module` is an assertion that the platform build actually links
the selected module. Unknown or unselected stems fail the package build.
Mobile native build lanes emit one prebuilt archive per selected module at
`out/extensions/<stem>/liboliphaunt_extension_<stem>.a`, so release packaging
can link only the extensions the app selected.
Android SDK builds first consume selected archives carried by the resource
package under `static-registry/archives`; `-PoliphauntAndroidExtensionArchivesDir=<liboliphaunt-out>`
is the first-party build-output override. The Gradle/CMake build produces an
app-local `liboliphaunt_extensions.so` support library from prebuilt extension
objects plus generated registry glue. That build step links binary artifacts
only; it does not compile PostgreSQL or extension source in the app project.
The iOS XCFramework runtime-resource generator accepts the same Rust runtime-resource output via
`--runtime-resources <dir>` and derives `nativeModuleStems` from
`runtime/manifest.properties`; it uses carried `ios-simulator`/`ios-device`
archives when present and otherwise falls back to first-party build outputs.
There is still only one extension selection list.
The generated registry source deliberately uses strong references for selected
extension magic and SQL entry points. A missing selected prebuilt archive must
fail the app build or link, not degrade into a late runtime `CREATE EXTENSION`
failure.

## Canonical Metadata

The generated extension metadata is the single PG18 extension inventory. It is
not a public target-support declaration. Each row records:

- SQL extension name;
- required control, SQL, data, and native module assets;
- mandatory extension dependencies;
- smoke SQL strategy;
- direct, broker, and server coverage expectation;
- mobile static-link status;
- first-party or external artifact policy.

`Extension::ALL` is the public exact-extension catalog used by
application code. The native-packaging tools consume the same generated
metadata for artifact ownership and target support; vendor-provided
artifact-index rows remain a separate runtime input. Desktop native, mobile,
and WASIX can differ where their artifacts or platform constraints differ.
PostGIS, for example, requires the selected iOS and Android static dependency
archives, hash-dependency sets, and runtime data on mobile. The
runtime-resource CLI rejects attempts to mark a module without a mobile
prebuilt artifact as complete with `--mobile-static-module`; that prevents apps
from shipping a manifest that claims an extension is linked when the archive
does not exist.

`pgcrypto` is mobile-prebuilt through the first-party OpenSSL for `pgcrypto`
static `libcrypto` archive. The Windows native producer also builds the pinned
OpenSSL checkout and links `pgcrypto` against the staged static `libcrypto`.
`uuid-ossp` is mobile-prebuilt through the first-party portable UUID static
`libuuid` archive. The Windows native producer links the same portable UUID
source directly into the `uuid-ossp` module and installs the matching
control/SQL files. The Windows native PostGIS producer builds the pinned GEOS,
PROJ, SQLite, json-c, and libxml2 dependency stack, links the generated
`postgis-3` module against those static archives, and stages the matching
extension SQL plus `proj/proj.db`.

## Target-Specific PG18.4 Support

The generated catalog is a derived view of Oliphaunt-compatible PG18.4
extension metadata. WASIX, native desktop, and mobile support can differ when
their artifacts or platform constraints differ. The invariant is strict: a
public selection surface may advertise only the exact extensions that the
selected target can actually package and run.

PostgreSQL 18.4 can build `uuid-ossp` only with
`--with-uuid=bsd`, `--with-uuid=e2fs`, or `--with-uuid=ossp`. Oliphaunt carries
a first-party portable UUID compatibility source for the e2fs API under
`src/runtimes/liboliphaunt/native/portable-uuid`; the WASIX, Linux/macOS native,
iOS, Android, and Windows native build scripts compile and link it for
`uuid-ossp`. `uuid-ossp` is stable in the generated WASIX plan; WASIX side-module builds and packages with matching archive
and module hashes, has host AOT metadata, and has direct, server, restart, and
dump-restore smoke evidence recorded for the package.
