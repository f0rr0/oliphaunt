# Cluster seeds and ICU

Status: locked architecture and implemented contract, updated 2026-08-24.

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
base runtime/package and says nothing about the catalogue. `full` falsely
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
standard seed does not repeat that catalogue work. Therefore a newly seeded ICU
database needs both `icu-data` and the matching `icu` seed.

The four conceptual cases are:

| Initialization | ICU data | Result |
| --- | --- | --- |
| `standard` seed | absent | Fast ordinary new database. |
| `icu` seed | present | Fast new database with the predefined ICU catalogue. |
| `initdb` | absent | Correct ordinary database; slower initialization. |
| `initdb` | present | Correct ICU database; slower initialization. |

The last case is important for explicit/custom runtimes and custom initial
superusers. ICU does not require a seed. A seed is an optimization; ICU data is
a capability. Published package-managed defaults use a seed so users normally
avoid `initdb`.

## User-visible behavior

There is no public initialization-mode enum and no raw seed/archive injection
API. Package-managed SDKs resolve the correct seed transitively.

- Installing/selecting the ordinary runtime resolves the `standard` seed.
- Selecting the language-native ICU package or feature resolves `icu-data` and
  the matching `icu` seed as one checked closure.
- A custom initial superuser cannot use the release seed because the release
  seed is initialized for `postgres`; the SDK runs `initdb --username=<name>`.
- An explicit native runtime may run `initdb`. If ICU data is explicitly
  supplied, that `initdb` receives the exact internal ICU-readiness signal and
  produces the normal ICU catalogue.
- Existing nonempty roots are opened as they are. They are never replaced,
  re-seeded, or silently catalogue-migrated.

WASIX TypeScript uses an explicit descriptor, following the useful part of
PGlite's end-user shape without exposing a raw filesystem option:

```ts
import Oliphaunt from '@oliphaunt/wasix-ts';
import icu from '@oliphaunt/wasix-icu';

const db = await Oliphaunt.open({ icu });
```

Without `icu`, the matching runtime package supplies the `standard` seed.
With `icu`, `@oliphaunt/wasix-icu` supplies the shared ICU data and the WASIX
`icu` seed. Its descriptor is versioned and runtime-bound; arbitrary paths and
untyped objects are not accepted.

Other SDKs retain language-native package selection:

| SDK | Ordinary selection | ICU selection |
| --- | --- | --- |
| Native Rust | target runtime artifact selected by `oliphaunt-build` | Cargo ICU feature/artifact stages `oliphaunt-icu` |
| Native TypeScript | target runtime npm package | optional `@oliphaunt/icu` package |
| Swift | ordinary runtime resources | `OliphauntICU` SwiftPM/CocoaPods resources |
| Kotlin | ordinary Maven runtime resources | Gradle ICU dependency/selection |
| React Native | ordinary generated native carrier | `@oliphaunt/icu` native resource carrier |
| Rust WASIX | portable runtime artifact | Cargo ICU feature/artifact |
| WASIX TypeScript | default runtime descriptor | explicit `@oliphaunt/wasix-icu` descriptor |

This is semantic parity, not identical signatures.

## Why the catalogue matters

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

Oliphaunt never rewrites PostgreSQL catalogue files or injects hidden SQL to
pretend that a standard seed was ICU-initialized. That is the correctness rule
behind “do not silently rewrite the seed's catalogue.” For a new root the SDK
uses the right seed. For an existing root, catalogue changes remain explicit
application migration work.

## Runtime and data distribution

ICU has two physical components:

1. target-compiled ICU code is linked into each native or WASIX runtime; and
2. the large files-data tree is distributed separately as `icu-data`.

Compiled code cannot be shared between native machine code and wasm32-WASIX.
The data files can be shared because the qualified native and WASIX ICU 76.1
producers emitted the same 4,136 paths and 31,697,003 content bytes, and the
native ICU library successfully consumed the WASIX-produced tree. Carriers
normalize files to `0644`, directories to `0755`, reject links/special files,
and bind the logical tree with
`SHA-256(path NUL size NUL bytes LF)` in bytewise path order.

There is one logical `icu-data` artifact. Ecosystem wrappers may differ:

- `@oliphaunt/icu`, SwiftPM resources, Maven resources, and the shared Rust
  `oliphaunt-icu` crate carry native-consumable data;
- `@oliphaunt/wasix-icu` and the WASIX Cargo assembly carry the same logical
  data behind WASIX-specific descriptors/archives; and
- every wrapper must prove the same logical tree digest.

The shared Rust `oliphaunt-icu` crate remains data-only. It does not embed a
native cluster seed, because WASIX users must not download a native PGDATA
image. Cargo's target-specific native runtime carrier also transports the small
matching native `icu` seed as `cluster-seed-icu`; this is carrier aggregation
required by Cargo's static build graph, not a merger of the logical artifacts.
The runtime resolver still pairs that seed with the independently staged
`icu-data` artifact.

The native ICU release asset records separate size rows for `icu-data` and
`cluster-seed-icu`. The standard runtime report records `cluster-seed`
separately from runtime bytes. Cargo and npm package limits continue to apply to
the final carrier bytes.

## Seed compatibility

A physical cluster seed is more restrictive than ICU data. PostgreSQL records
ABI facts in `global/pg_control` and refuses incompatible clusters.

Oliphaunt currently has two compatibility keys:

| Runtime family | Compatibility key | Reason |
| --- | --- | --- |
| native 64-bit | `native-pg18-datum64-v1` | Eight-byte `Datum`; `float8` is passed by value. |
| wasm32-WASIX | `wasix-pg18-datum32-v1` | Four-byte pointer/`Datum`; `float8` is passed by reference. |

WASIX extends WASI with operating-system APIs but does not change wasm32 linear
memory to 64-bit. PostgreSQL defines `Datum` from `uintptr_t`, so forcing a
64-bit `Datum` into today's wasm32 build would create an incompatible
PostgreSQL and extension ABI. A local cross-runtime experiment confirmed that
PostgreSQL rejects the other family's seed with the explicit
`USE_FLOAT8_BYVAL` mismatch.

Native and WASIX therefore have distinct `standard` and `icu` seed bytes. The
ICU files-data tree remains shared.

## Architecture and DRY boundary

The implementation has four layers:

1. **Producer** — the exact packaged runtime runs its exact `initdb`, validates
   catalogue and shutdown invariants, cleans transient PGDATA, and emits a
   deterministic seed plus manifest.
2. **Release graph** — generated metadata binds runtime, profile, seed, ICU
   data, target ABI, source lane, and ecosystem carrier by exact identity.
3. **Resolved runtime closure** — each SDK resolves runtime, catalogue profile,
   optional ICU data, matching seed, and extensions before storage mutation.
4. **Provider-local hydrator** — native filesystems, WASIX memory, IndexedDB,
   OPFS, and host directories copy/extract into private staging and publish a
   mutable root atomically.

The cross-language contract lives in
`src/shared/cluster-seed-contract/contract.json`. It owns profile names,
artifact roles, ICU form/version, readiness signal, physical formats,
compatibility keys, and the logical digest algorithm. The policy gate validates
canonical fixtures and is a dependency of `sdk-contracts:check`. Release tools
reuse one native manifest/digest validator rather than reimplementing it.

Filesystem hot paths deliberately remain provider-local. A universal
filesystem abstraction would hide different atomicity, locking, and cloning
semantics and would harm performance. The shared abstraction is the validated
`ResolvedRuntimeClosure`, not a universal file API.

## Correctness rules

These rules are locked:

- A seed contains only ordinary `initdb` bootstrap state. It contains no user
  schema/data, secrets, selected optional extensions, or migrations.
- `standard` generation clears ambient ICU variables. `icu` generation requires
  the exact verified data tree.
- PostgreSQL trusts only `OLIPHAUNT_INTERNAL_ICU_READY=1` during controlled
  `initdb`; ambient `ICU_DATA` alone cannot select a catalogue profile.
- The internal readiness variable is removed or set deterministically for every
  child process. It is not a public feature switch.
- A published package with a missing, malformed, wrong-profile, or incompatible
  seed fails closed. Maintainer/source builds may use the explicit local
  `initdb` fallback.
- A seed is copied into a private destination. Hydration never hardlinks mutable
  database files to package contents or another database.
- Native hydration normalizes host-dependent shared-memory settings after the
  copy. WASIX hydration retains its provider-specific overlay/extraction path.
- Existing roots are never implicitly reinitialized or reseeded.
- ICU upgrades never trigger hidden `REINDEX` or
  `ALTER COLLATION ... REFRESH VERSION`; applications follow PostgreSQL's
  per-database upgrade procedure.
- The five-field `.oliphaunt.json` storage descriptor and physical backup
  formats do not gain a seed-profile field. The database catalogue is the
  resulting state; seed provenance is not durable root identity.
- Seed clones retain the producer database-system identifier in v1. Independent
  seeded roots must not be treated as distinct replication/WAL archive systems.
  Oliphaunt does not byte-patch `pg_control`.

## PGlite comparison

PGlite's `@electric-sql/pglite-prepopulatedfs` demonstrates the startup value
of shipping initialized PGDATA. Its public helper returns an archive through
`loadDataDir`, while ICU is supplied separately through `icuDataDir`.

Oliphaunt adopts runtime-bound preinitialization but makes two stricter choices:

- users do not manually align or inject a raw seed archive; the runtime carrier
  supplies it; and
- selecting packaged ICU also selects a seed whose catalogue was initialized
  with that exact ICU data.

PGlite's separate `loadDataDir` and `icuDataDir` concepts are valid. The risky
combination is an arbitrary prepopulated archive plus ICU data when the archive
was initialized without ICU: the bytes are available, but the predefined
catalogue is not retroactively created. Oliphaunt prevents that mismatch in its
package-managed path.

## Implemented shipment checklist

The repository implementation must keep every item below true:

- [x] Canonical names are `standard`, `icu`, and `icu-data`; artifact roles are
  `cluster-seed-standard`, `cluster-seed-icu`, and `icu-data`.
- [x] Native Datum64 and WASIX Datum32 use different compatibility keys and
  physical seed products.
- [x] Native and WASIX PostgreSQL patch stacks use the same exact internal ICU
  readiness rule during `initdb`.
- [x] Native and WASIX producers generate both profiles through one
  parameterized pipeline per runtime family.
- [x] Producers clear ambient ICU selection, require exact data for `icu`, and
  emit extension-free, clean-shutdown seeds.
- [x] WASIX runtime manifests use format v2 and carry both seed descriptors and
  archives under `cluster-seeds/`.
- [x] Native target release assets carry the `standard` seed.
- [x] The native ICU data asset carries the native `icu` seed and an exact
  logical ICU tree binding.
- [x] The WASIX ICU carrier carries shared ICU data plus the WASIX `icu` seed;
  it never carries a native seed.
- [x] Native Cargo target carriers aggregate both native seeds while the shared
  `oliphaunt-icu` crate stays data-only.
- [x] npm, Cargo, SwiftPM, Maven, Kotlin, React Native, Rust, native TypeScript,
  Rust WASIX, and WASIX TypeScript carrier/resolver paths reject missing or
  wrong-profile closure members.
- [x] Native TypeScript uses the release seed for the default `postgres`
  superuser and preserves custom `username` semantics through `initdb`.
- [x] Native Rust, native TypeScript, Swift, Kotlin, React Native, Rust WASIX,
  and WASIX TypeScript hydrate only new/empty roots and leave existing roots
  untouched.
- [x] Hydration copies mutable files, rejects unsafe archive members, uses
  private staging, and publishes through provider-appropriate atomicity.
- [x] ICU data composition occurs before extensions; extension selection remains
  independent and generated from the canonical extension model.
- [x] Release validators compare exact manifest fields and ICU logical tree
  digests instead of accepting directory names or substring matches.
- [x] Release notice closures include PostgreSQL for derived seed files and ICU
  for data files.
- [x] Package footprint reports separate runtime, standard seed, ICU seed, and
  ICU data bytes where those products are assembled.
- [x] The cluster-seed contract is wired into `sdk-contracts:check`; source-free
  asset and release checks cover the generated graph.
- [x] Negative tests cover profile mismatches, missing members, changed data
  digests, unsafe inputs, and fail-closed package resolution.

## Per-release qualification checklist

These are recurring release gates, not unfinished architecture:

- [ ] Generate all seeds from the exact release runtime/source commit in trusted
  CI; never reuse an unbound developer cache.
- [ ] Verify `PG_VERSION`, `pg_control`, clean shutdown, bootstrap databases,
  empty extension selection, and exact catalogue expectations for both profiles.
- [ ] Open each native seed with every declared compatible native target and
  prove that native rejects WASIX seeds and WASIX rejects native seeds.
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

- standard users do not download the 31.7 MB uncompressed ICU data tree;
- package-managed new roots avoid end-user `initdb`;
- seed manifests and descriptor hashes are validated before mutation;
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
