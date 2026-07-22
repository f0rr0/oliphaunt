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

Release ownership is not the same thing as SQL selection. The 32 promoted
PostgreSQL 18 contrib members belong to one independently tagged distribution
product, `oliphaunt-extension-contrib-pg18`. Its packaging version, changelog,
and compatibility metadata live at `src/extensions/contrib/`; it is
runtime-bound and shares the runtime linked-version group. Contrib member
folders retain exact build, target, and evidence metadata but do not own leaf
versions, changelogs, tags, or package identities.

Every build-enabled, stable promoted external extension is an independently
tagged release product. Its packaging version, changelog, immutable upstream
source identity, and compatibility metadata live with that product. A catalog
entry with `build = false` or `stable = false` is not a release member/product
and must retain a concrete blocker until it qualifies; it must not acquire
packages merely because its source pin exists.

For an external extension, `release.toml` is the active-public-product
boundary, not general build metadata. A deferred extension must have no
`release.toml`, `VERSION`, `CHANGELOG.md`, release-semantic fingerprint,
Release Please component, or Moon release-product metadata. Its source pin,
recipe, target profiles, build tasks, and qualification evidence remain so CI
can continue proving the implementation without reserving or publishing a
package identity.

Each exact SQL member has an explicit `targets/artifacts.toml`. The file opts
into named target profiles and may add member-specific target rows; the expanded
rows enumerate every published target and any member-specific planned or
unsupported target with evidence references. Targets outside the global release
OS policy are fail-closed and need not be repeated in every extension manifest.
Missing metadata for a claimed target is an error; release tooling must never
infer that an extension supports every runtime target merely because the
runtime supports it.

Ecosystem packages are carriers, not extra products: a stable Cargo façade,
native/WASIX Cargo leaves, an npm façade plus selected platform packages,
Android ABI Maven artifacts, and SwiftPM/GitHub assets as declared by the
target contract. Contrib carriers are shared by the contrib product and contain
an exact member inventory with nested path, byte count, and checksum for every
SQL member. External products have separate carriers and versions. Every
consumer resolves by SQL name and extracts/stages only the selected member and
its declared dependencies. The publication catalog defines the stable
identities and the frozen publication lock records the actual files. Only
oversized crates.io payload parts may be generated dynamically.

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
at the independently versioned extension release. JavaScript validates the
exact contract schema and uses it—not the SDK's current catalog snapshot—to
qualify the installed package's runtime leaf inventory. The SDK catalog remains
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

# async fn demo() -> oliphaunt::Result<()> {
let db = Oliphaunt::builder()
    .temporary()
    .native_direct()
    .extension(Extension::Vector)
    .open()
    .await?;

db.execute("CREATE EXTENSION vector").await?;
db.close().await?;
# Ok(())
# }
```

The same rule applies to package tooling:

```sh
cargo run -p oliphaunt --bin oliphaunt-resources -- \
  --output target/oliphaunt-resources \
  --extension vector \
  --force
```

Selecting `vector` ships `vector`. It must not ship `hstore`, `pg_trgm`,
`cube`, `earthdistance`, pgGraph, ParadeDB, or any other unselected extension.
The only exception is a mandatory dependency declared by
`NATIVE_EXTENSION_MANIFEST`; for example `earthdistance` includes `cube`.

End developers should not have to build PostgreSQL or extension source to know
what they can ship. The runtime-resource CLI exposes the release-ready prebuilt
catalog without requiring a local native build:

```sh
cargo run -p oliphaunt --bin oliphaunt-resources -- --list-extensions
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
cargo run -p oliphaunt --bin oliphaunt-resources -- \
  --output target/oliphaunt-resources \
  --extension vector \
  --prebuilt-extension vendor/acme_ext.tar.zst \
  --liboliphaunt-native-version 0.1.0 \
  --force
```

Artifacts are produced from already-built PostgreSQL runtime files with the
Rust SDK artifact tool:

```sh
cargo run -p oliphaunt --bin oliphaunt-extension-artifact -- \
  --runtime target/acme-pg18-runtime/files \
  --sql-name acme_ext \
  --native-module-stem acme_ext \
  --native-module-file acme_ext.so \
  --native-target linux-x64-gnu \
  --embedded-module-root target/acme-pg18-embedded/modules \
  --native-runtime-version 0.1.0 \
  --data-file data/acme_ext.rules \
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
cargo run -p oliphaunt --bin oliphaunt-extension-index -- \
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
cargo run -p oliphaunt --bin oliphaunt-resources -- \
  --list-extensions \
  --extension-index vendor/oliphaunt-extensions.toml \
  --extension-target macos-arm64 \
  --trusted-extension-index-key-file acme-release-2026q2:keys/acme-extension-index.ed25519.pub
```

Then app/package tooling can select the external extension by exact SQL name:

```sh
cargo run -p oliphaunt --bin oliphaunt-resources -- \
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
extension dependencies from the index. Built-in release-ready extension names
cannot be overridden by index entries. Local sidecar artifacts next to the index
are preferred. If a URL-backed artifact is missing locally, `--extension-cache`
downloads it to a target-scoped cache and verifies bytes, SHA-256, and manifest
before packaging. HTTPS artifact downloads are a packaging-tool capability; Rust
SDK release binaries enable the `extension-download` feature, while the embedded
library remains usable without HTTP/TLS dependencies. Signed index verification
uses `--trusted-extension-index-key-file <key-id>:<path>`, which requires a
matching `<index>.sig` sidecar before any indexed artifact can be used. The key
file contains a hex-encoded 32-byte Ed25519 public key. Signing and verification
are packaging-tool capabilities behind the `extension-signing` feature, so
embedded Rust/Tauri apps do not compile signing code unless they opt into it.

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
files=files
```

The v1 manifest has exactly these 20 fields; all fields are present even when
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
`files/lib/postgresql/acme_ext.dylib` on macOS. The runtime-resource generator copies only files
declared by the exact selected extension: matching control/SQL files, declared
`dataFiles`, and the declared native module. Extra files in the artifact are
ignored. A prebuilt artifact cannot override a built-in release-ready extension
name. Dependencies are exact extension names and must resolve either to the
built-in catalog or to another provided prebuilt artifact.

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

The Rust SDK owns the runtime-resource CLI and manifest contract.

Runtime resources are shared by Swift, Kotlin, and React Native:

```text
oliphaunt/
  runtime/
    manifest.properties
    files/
      lib/postgresql/  # standalone PostgreSQL server profile
      lib/modules/     # embedded direct/broker profile when selected
      share/postgresql/
  template-pgdata/
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
package	template-pgdata	-	10	20000
package	static-registry	-	2	3456
extensions	selected	-	3	63478
extension	vector	-	3	63478
```

Swift reads this through `OliphauntRuntimeResources.packageSizeReport()`;
Kotlin reads packaged app assets through
`OliphauntAndroid.packageSizeReport(context)` and unpacked smoke roots through
`OliphauntAndroid.packageSizeReport(resourceRoot)`; React Native delegates
`Oliphaunt.packageSizeReport(...)` to those platform SDK readers.

## Mobile Static Registry

iOS and Android cannot rely on arbitrary dynamic extension loading. A mobile
release package that includes module-backed extensions must also include and
register a matching static extension registry:

```sh
cargo run -p oliphaunt --bin oliphaunt-resources -- \
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

## Manifest

`NATIVE_EXTENSION_MANIFEST` is the PG18 native build inventory. It is not a
public target-support declaration. Each row records:

- SQL extension name;
- required control, SQL, data, and native module assets;
- mandatory extension dependencies;
- smoke SQL strategy;
- direct, broker, and server coverage expectation;
- mobile static-link status;
- first-party or external artifact policy.

`Extension::FIRST_PARTY_PG18_SUPPORTED` is the exact inventory of first-party
PG18 rows known to the native SDK. It is not a shipping promise.

`Extension::RELEASE_READY_PG18_SUPPORTED` is a generated desktop native view
for release packages. A row enters this catalog only when the product's
explicit target manifest and current evidence declare that desktop target
published. There is no contrib/default fallback.
Rows can be first-party inventory without being desktop release-ready. PostGIS
is target-specific rather than a blanket exception: native desktop, mobile,
and WASIX readiness are controlled by its target metadata and build recipes.
PostGIS mobile release readiness is target-owned and requires the selected iOS
and Android static dependency archives, hash-dependency sets, runtime data, and
smoke evidence.

External candidates such as pgGraph and ParadeDB remain internal metadata until
they have pinned artifacts, redistribution clearance, and direct, broker,
server, restart, backup, restore, and mobile static-registry evidence.

`Extension::MOBILE_RELEASE_READY_PG18_SUPPORTED` is the mobile exact-extension
catalog. Release readiness is target-specific: mobile can intentionally be
smaller than desktop native or WASIX support when static archives, dependency
archives, runtime data, or mobile smoke evidence are incomplete. The
runtime-resource CLI rejects attempts to mark a non-mobile-ready module as
complete with `--mobile-static-module`; that prevents apps from shipping a
manifest that claims an extension is linked when the prebuilt mobile artifact
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

## Target-Specific PG18.4 Readiness

The generated catalog is a derived view of Oliphaunt-compatible PG18.4
extension metadata. Product target manifests and evidence own release
readiness. WASIX,
native desktop, and mobile can move independently when their build recipes,
artifacts, smoke evidence, or platform constraints differ. The invariant is
strict: a public selection surface may advertise only the exact extensions that
the selected target can actually package and run.

Oliphaunt-listed extensions that are not stable stay out of every release-ready
catalog until their PG18.4 blockers are gone. The only current non-stable row is
Apache AGE, because the tracked source still calls PostgreSQL APIs removed in
PG18. PostgreSQL 18.4 can build `uuid-ossp` only with
`--with-uuid=bsd`, `--with-uuid=e2fs`, or `--with-uuid=ossp`. Oliphaunt carries
a first-party portable UUID compatibility source for the e2fs API under
`src/runtimes/liboliphaunt/native/portable-uuid`; the WASIX, Linux/macOS native,
iOS, Android, and Windows native build scripts compile and link it for
`uuid-ossp`. `uuid-ossp` is stable in the generated WASIX plan; WASIX side-module builds and packages with matching archive
and module hashes, has host AOT metadata, and has direct, server, restart, and
dump-restore smoke evidence recorded for the package.
