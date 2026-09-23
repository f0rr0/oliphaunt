# Cluster seeds and ICU

Status: current split-resource architecture, updated 2026-09-15.

This document is the source of truth for preinitialized PostgreSQL clusters,
ICU data, their public selection, and their release qualification.

## Names

The public and manifest vocabulary is deliberately small:

| Name | Meaning |
| --- | --- |
| `standard` | A cluster seed created without optional ICU data. |
| `icu` | A cluster seed created by `initdb` with the exact packaged ICU data available. |
| `icu-data` | The independently packaged ICU runtime data files. |

The corresponding artifact roles are `cluster-seed-standard`,
`cluster-seed-icu`, and `icu-data`.

Do not call these profiles `base` or `icu-full`. `base` is ambiguous with a
base runtime/package and says nothing about the catalog. `full` falsely
suggests that smaller public ICU editions exist. Oliphaunt ships one optional
ICU data form, so `icu` is the complete and accurate name.

“Prepopulated filesystem” is acceptable when comparing with PGlite.
“Preinitialized PGDATA” is acceptable in explanatory prose. Code, manifests,
package metadata, and architecture use **cluster seed**.

## Simple model

A cluster seed and ICU data are independent concepts:

- A cluster seed is immutable initialization state. Oliphaunt copies it only
  when creating a new, empty database root.
- ICU data is a runtime capability. PostgreSQL needs those files whenever it
  executes ICU locale or collation operations.
- Extensions are a third independent layer. Seeds contain no optional
  extensions or application data.

They overlap in one place: PostgreSQL's ICU-aware `initdb` imports predefined
ICU collations into each bootstrap database. Adding ICU data after copying a
standard seed does not repeat that catalog work. Therefore a newly seeded ICU
database needs both `icu-data` and the matching `icu` seed.

The four conceptual cases are:

| Initialization | ICU data | Result |
| --- | --- | --- |
| `standard` seed | absent | Fast ordinary new database. |
| `icu` seed | present | Fast new database with the predefined ICU catalog. |
| `initdb` | absent | Correct ordinary database; slower initialization. |
| `initdb` | present | Correct ICU database; slower initialization. |

The last case is important for explicit or locally built runtimes. ICU does not
require a seed. A seed is an optimization; ICU data is a capability.
Desktop SDKs can initialize without downloading a seed. New browser and mobile
databases require an explicitly selected seed; existing databases do not need one.

## User-visible behavior

Runtime, seed, and ICU data are selected independently. Installing a runtime
does not install either seed profile or ICU data. A seed package contains one
profile for one compatibility domain.

- Selecting a standard seed avoids `initdb` and has no ICU dependency.
- Selecting an ICU seed also requires the exact canonical ICU data. Selecting
  ICU data alone does not implicitly select a seed.
- Every seed and `initdb` fallback creates PostgreSQL's fixed `postgres`
  bootstrap role. Public `username` options consistently select an existing
  connection role; they never create a superuser as a side effect.
- Opening a new root as another username fails before seed loading or PGDATA
  mutation/publication. The
  application can first open as `postgres`, create the role, and then reopen as
  that role.
- An explicit native runtime may run `initdb`. If ICU data is explicitly
  supplied, that `initdb` receives the exact internal ICU-readiness signal and
  produces the normal ICU catalog.
- Existing nonempty roots are opened as they are. They are never replaced,
  re-seeded, or silently catalog-migrated.

WASIX TypeScript accepts an explicit archive/manifest pair. For a browser bundler:

```ts
import Oliphaunt from '@oliphaunt/wasix-ts';
import archive from '@oliphaunt/seed-wasix-standard/seed.tar.zst?url';
import manifest from '@oliphaunt/seed-wasix-standard/manifest.json?url';

const db = await Oliphaunt.open({ seed: { archive, manifest } });
```

For ICU, select `@oliphaunt/seed-wasix-icu` and pass `icu: { data, manifest }`,
using `@oliphaunt/icu/data` and `@oliphaunt/icu/manifest`. Node, Bun, and Deno
can initialize without a seed; new browser storage requires one. Incomplete
archive/manifest pairs fail closed rather than silently selecting `initdb`.

Other SDKs retain language-native package selection:

| SDK | Ordinary selection | ICU selection |
| --- | --- | --- |
| Native Rust | separately selected runtime and optional seed resources | independently selected `oliphaunt-icu` data |
| Native TypeScript | optional `seed` resource directory; desktop `initdb` when absent | `icuData` resource directory |
| Swift | explicit `OliphauntSeedNativeIOSStandard` resource target | `OliphauntSeedNativeIOSICU` and `OliphauntICU` |
| Kotlin | explicit Android standard seed Maven dependency | Android ICU seed and canonical ICU data dependencies |
| React Native | explicit mobile `seedProfile` and resource package | ICU profile and `@oliphaunt/icu` resource carrier |
| Rust WASIX | optional `.seed(ClusterSeed::new(archive, manifest))` | `.icu_data(IcuData::new(data_bytes, manifest_bytes)?)` |
| WASIX TypeScript | explicit `seed: { archive, manifest }` | independent `icu: { data, manifest }` |

Rust WASIX memory/directory stores support split `initdb` when no seed is
selected. Mobile applications still select a seed; this does not imply a
seed-free mobile initialization path. Existing ICU databases continue to need
their ICU data on reopen. Resource package names and exports are maintained in
[database-resources](../../database-resources/README.md).

## Why the catalog matters

PostgreSQL initializes `template1`, imports system collations into it, and then
copies it to create `template0` and `postgres`. `pg_collation` is per-database.
Consequently:

- loading ICU bytes after a standard seed does not create the predefined
  `*-x-icu` rows;
- importing into one application database changes only that database;
- importing into `template1` later affects future databases but does not repair
  the already-created `postgres`, `template0`, or other databases;
- explicit `CREATE COLLATION ... provider = icu` can still work when ICU data
  is present; and
- enabling ICU does not silently change the cluster's default locale provider.

Oliphaunt never rewrites PostgreSQL catalog files or injects hidden SQL to
pretend that a standard seed was ICU-initialized. That is the correctness rule
behind “do not silently rewrite the seed's catalog.” For a new root the SDK
uses the right seed. For an existing root, catalog changes remain explicit
application migration work.

## Runtime and data distribution

Target-compiled ICU code is linked into each native or WASIX runtime. The
canonical little-endian ICU 76.1 data file, `icudt76l.dat`, is packaged
separately by `database-resources`. Its producer copies the verified upstream
file into `share/icu`; it does not expand thousands of resource files or build
PostgreSQL or ICU libraries.

Native and WASIX consumers use the same canonical data. `@oliphaunt/icu` and
`oliphaunt-icu` are data-only. Standard seed leaves have no ICU dependency;
ICU seed leaves reference the exact canonical data identity and depend on that
carrier. Neither seed profile is bundled into the runtime carrier.

The ICU `manifest.properties` records its schema, artifact role, version/form,
and logical tree SHA-256. The digest remains
`SHA-256(path NUL size NUL bytes LF)` in bytewise path order. Seed manifests
bind the required ICU digest separately from their physical runtime identity.
Producer and unmanaged-resource checks verify actual bytes.

Native npm seed leaves expose `./pgdata/PG_VERSION` and `./manifest.json`.
The manifest preserves empty-directory paths through package installation.
Cargo and WASIX npm leaves retain the compressed seed archive; Cargo leaves
expose `seed_archive()` and `seed_manifest()`. Each carrier contains one
profile and compatibility domain. The resource-owned Swift source archive
contains both iOS profiles, while target selection controls app resources.

Database-resource release assets account for standard seed, ICU seed, and ICU
data independently of runtime bytes. Registry limits apply to final carriers.

## Seed compatibility

A physical cluster seed is more restrictive than ICU data. PostgreSQL records
ABI facts in `global/pg_control` and refuses incompatible clusters.

Oliphaunt has two compatibility domains:

| Runtime family | Compatibility identity | Reason |
| --- | --- | --- |
| native | Target-qualified PostgreSQL 18 native identity | Physical files are qualified for the declared native target and ABI; distributed seeds intentionally contain no imported host libc collation rows. |
| wasm32-WASIX | `wasix-pg18-datum32-v1` | Four-byte pointer/`Datum`; `float8` is passed by reference. |

WASIX extends WASI with operating-system APIs but does not change wasm32 linear
memory to 64-bit. PostgreSQL defines `Datum` from `uintptr_t`, so forcing a
64-bit `Datum` into today's wasm32 build would create an incompatible
PostgreSQL and extension ABI. A local cross-runtime experiment confirmed that
PostgreSQL rejects the other family's seed with the explicit
`USE_FLOAT8_BYVAL` mismatch.

Every desktop native target and WASIX therefore receive separately qualified
`standard` and `icu` seed bytes. Mobile domains receive a producer-built
candidate only after exact ABI receipts prove equality across the producer and
both target builds; the carrier then binds it to that mobile domain. No seed is
silently relabelled on pointer-width or operating-system assumptions alone.
The canonical ICU data remains shared.

The v1 native compatibility targets are deliberately finite:

| Target | Compatibility key |
| --- | --- |
| `macos-arm64` | `native-pg18-macos-arm64-v1` |
| `linux-x64-gnu` | `native-pg18-linux-x64-gnu-v1` |
| `linux-arm64-gnu` | `native-pg18-linux-arm64-gnu-v1` |
| `windows-x64-msvc` | `native-pg18-windows-x64-msvc-v1` |
| `ios-datum64` | `native-pg18-ios-datum64-v1` |
| `android-datum64` | `native-pg18-android-datum64-v1` |

Before app packaging, Android x86_64, Android arm64, and the Linux producer must
have identical compile/header ABI receipts. The equivalent iOS gate compares
the simulator, device, and macOS producer receipts. This admits an
**ABI-compatible candidate closure**; the embedded provenance records do not
claim that the seed executed on every target.

The receipt compares PostgreSQL's independent physical-compatibility inputs:
byte order, `Datum` width, maximum alignment, `float8` passing, block and
relation-segment sizes, `NAMEDATALEN`, `INDEX_MAX_KEYS`, and catalog/control
versions. PostgreSQL 18 derives `LOBLKSIZE` from the block size and derives its
TOAST chunk size from the same block/alignment inputs and pinned source; integer
datetimes are unconditional. Repeating those derived values would not add
independent evidence. The finite arm64/x86_64 target set uses the platforms'
standard floating-point ABI, and the installed-app E2E remains the execution
proof.

The x86_64 emulator and iOS simulator then execute the packaged representative
candidate, verify its selected catalog profile, and reopen the same persistent
root. Those installed-app checks feed the required top-level E2E gate, which is
the final mobile release execution qualification. These are explicit
compatibility domains, not inferences from pointer width.

## Architecture and DRY boundary

The implementation has four layers:

1. **Producer** — an ordinary native bootstrap PostgreSQL process runs
   `initdb`, rather than loading embedded consumer substitutions. The pipeline
   validates catalog and shutdown invariants, cleans transient PGDATA, and
   emits a deterministic seed plus manifest. Compile/header ABI receipts admit
   the candidate closure before packaging; representative installed-app E2E
   admits it for release.
2. **Release graph** — generated metadata binds runtime, profile, seed, ICU
   data, target ABI, source lane, and ecosystem carrier by exact identity.
3. **Resolved runtime closure** — each SDK resolves runtime, catalog profile,
   optional ICU data, optional matching seed, and extensions before seed loading or
   PGDATA mutation/publication.
4. **Provider-local hydrator** — native filesystems, WASIX memory, IndexedDB,
   OPFS, and host directories copy/extract into private staging and publish
   through their honest durability boundary. Directory SDKs publish PGDATA and
   then the descriptor durably; interruption between them fails closed rather
   than pretending that multiple filesystem entries are one atomic operation.

The cross-language contract lives in
`src/database-resources/contracts/contract.json`. It owns profile names,
artifact roles, ICU form/version, readiness signal, physical formats,
compatibility keys, required PGDATA directories, and the logical digest algorithm.
The product tests validate canonical fixtures through the real seed readers. Release tools
reuse one native manifest/digest validator rather than reimplementing it.

Filesystem hot paths deliberately remain provider-local. A universal
filesystem abstraction would hide different atomicity, locking, and cloning
semantics and would harm performance. The shared abstraction is the validated
`ResolvedRuntimeClosure`, not a universal file API.

## Correctness rules

These rules are locked:

- A seed contains only ordinary `initdb` bootstrap state. It contains no user
  schema/data, secrets, selected optional extensions, or migrations.
- Seeds and explicit `initdb` fallback always bootstrap the fixed `postgres`
  role. Connection username is not an initialization option.
- `standard` generation clears ambient ICU variables. `icu` generation requires
  the exact verified data tree.
- PostgreSQL trusts only `OLIPHAUNT_INTERNAL_ICU_READY=1` during controlled
  `initdb`; ambient `ICU_DATA` alone cannot select a catalog profile.
- The internal readiness variable is removed or set deterministically for every
  runtime instance. It is not a public feature switch.
- A selected seed with missing members, malformed metadata, the wrong profile,
  or incompatible physical identity fails closed. Omitting a seed selects
  `initdb` only on SDK/provider paths that support it.
- Manifest cache keys are single portable path components; `.` and `..` are
  invalid even though dot is otherwise allowed in an identifier.
- A seed is copied into a private destination. Hydration never hardlinks mutable
  database files to package contents or another database.
- Native hydration normalizes host-dependent shared-memory settings after the
  copy. WASIX hydration retains its provider-specific overlay/extraction path.
- Existing roots are never implicitly reinitialized or reseeded.
- ICU upgrades never trigger hidden `REINDEX` or
  `ALTER COLLATION ... REFRESH VERSION`; applications follow PostgreSQL's
  per-database upgrade procedure.
- The five-field `.oliphaunt.json` storage descriptor and physical backup
  formats do not gain a seed-profile field. The database catalog is the
  resulting state; seed provenance is not durable root identity.
- Embedded seed clones retain the producer database-system identifier in v1 and
  do not expose physical replication or WAL-archive identity semantics. New
  native server roots use normal server `initdb` so every server receives a
  unique system identifier. Oliphaunt does not byte-patch `pg_control`.

## PGlite comparison

PGlite's `@electric-sql/pglite-prepopulatedfs` demonstrates the startup value
of shipping initialized PGDATA. Its public helper returns an archive through
`loadDataDir`, while ICU is supplied separately through `icuDataDir`.

Oliphaunt also keeps seed state and ICU data separate. Applications may select
a packaged archive and manifest explicitly, while SDKs validate physical
compatibility, profile, archive integrity, and the required ICU identity.
Adding ICU bytes to a standard seed does not retroactively create its predefined
ICU catalog; catalog changes to existing databases remain explicit.

## Distribution boundaries

- `database-resources` owns seed profiles and canonical ICU data; runtime
  packages contain executable runtime assets.
- Each seed carrier contains one qualified profile and physical domain. There
  is no default carrier that installs every seed.
- Producers and archive packaging validate the shared PGDATA directory
  contract, including empty directories. Carrier transport preserves them.
- Seeds are copied into private mutable storage; package files are never
  hardlinked into PGDATA. Existing databases do not need seed downloads.
- Selected resources are checked for compatibility and integrity before use.
  Installed-app qualification remains required for Android and iOS.

## Per-release qualification checklist

These are recurring release gates, not unfinished architecture:

- [ ] Generate all seeds from the exact release runtime/source commit in trusted
  CI; never reuse an unbound developer cache.
- [ ] Verify `PG_VERSION`, `pg_control`, clean shutdown, bootstrap databases,
  empty extension selection, and exact catalog expectations for both profiles.
- [ ] Compare all target and producer compile/header ABI receipts before mobile
  app packaging, then require representative emulator/simulator installed-app
  E2E before final release execution qualification.
- [ ] Compare the native and WASIX ICU logical tree digests and run
  representative locale/collation probes against the exact released data.
- [ ] Pack and reinstall every Cargo, npm, SwiftPM, Maven, and React Native
  carrier; verify no source-tree or sibling-package fallback is possible.
- [ ] Exercise memory, host-directory, IndexedDB, OPFS, direct, broker, server,
  and mobile paths that are available on the release matrix.
- [ ] Prove first-open success, reopen stability, crash-safe unpublished staging,
  concurrent-open exclusion, and nonempty-root nonmutation.
- [ ] Benchmark paired cold/warm `initdb` versus seed hydration and first query;
  publish medians, tails, bytes, CPU, I/O, and decompression costs.
- [ ] Audit the standard and ICU size rows and enforce registry/package limits.
- [ ] Run repository release, committed-asset, extension-model, SDK-contract, and
  affected-target qualification at the exact candidate SHA.

## Performance policy

Performance is a feature, but it does not weaken correctness:

- standard users do not download optional ICU data;
- selecting a seed avoids `initdb`; supported seed-free paths avoid its download;
- seed manifests and descriptor hashes are validated before seed loading or
  PGDATA mutation/publication;
- persistent WASIX stores are inspected before seed archives are fetched or
  expanded;
- package-managed immutable ICU identities are not recomputed by reading the
  complete data tree on every open;
- PostgreSQL frontend tools do not mount backend-only ICU data;
- hot provider operations use their existing copy-on-write, reflink, archive,
  journal, or direct-OPFS mechanisms;
- immutable source package files are never made mutable through hardlinks; and
- claims use reproducible cold/warm benchmarks on final carrier bytes, not a
  one-off producer-tree timing.

If a future consumer cannot use the canonical ICU data form because of ICU
major, endianness, charset family, or a different data filter, it receives a
new compatibility identity only after an executable consumer gate proves the
difference. If a future wasm64-WASIX runtime changes PostgreSQL's `Datum` ABI,
it likewise receives a new seed compatibility key rather than reusing today's
wasm32 seed.
