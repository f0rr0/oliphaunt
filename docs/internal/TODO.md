# Historical Native Product Backlog (Non-normative)

> **Historical research backlog — not a release gate.** This file preserves
> native product investigations and longer-horizon hardening ideas. Its `P0`,
> “remaining work,” acceptance, device-evidence, and production-readiness
> language reflects the track that created each entry; it is not an assertion
> about the current release candidate. Maintainers and agents must use
> [`docs/maintainers/release.md`](../maintainers/release.md),
> [`docs/maintainers/release-setup.md`](../maintainers/release-setup.md), the
> generated target/catalog contracts, and the repository
> [`release-oliphaunt`](../../.codex/skills/release-oliphaunt/SKILL.md) and
> [`qualify-oliphaunt-change`](../../.codex/skills/qualify-oliphaunt-change/SKILL.md)
> skills for current policy and exact-SHA readiness. Re-verify an item against
> the current tree before promoting it into normative maintainer documentation.

This was the unfinished implementation backlog for the native `liboliphaunt`
and `oliphaunt` product track. Completed historical work belongs in
[DONE.md](DONE.md).

The product objective for this historical track was native PostgreSQL through
`liboliphaunt`, not the legacy runtime lane. The entries were focused on work
that made the native direct, broker, server, and SDK surfaces more correct,
faster, easier to ship, or easier to validate.

Historical backlog priorities (not current release severity):

- `P0`: blocks calling the native product production-ready.
- `P1`: hardening needed for a durable, low-maintenance product.
- `P2`: future capabilities that should not shape the current release contract
  until they have measured evidence.

When reusing an item, move the verified durable result into current normative
documentation rather than treating this file as an active checklist.

## Product Target

`liboliphaunt` is the C engine boundary over patched PostgreSQL 18.
`oliphaunt` is the canonical Rust SDK and the shape followed by Swift,
Kotlin, and React Native:

- `NativeDirect` for lowest-latency embedded use;
- `NativeBroker` for robust desktop apps, multi-root ownership, crash isolation,
  recovery, and upgrade orchestration;
- `NativeServer` for true PostgreSQL client compatibility, independent
  connections, pools, `psql`, `pg_dump`, SQLx, and other external clients;
- explicit opt-in extensions with static registry support for mobile and a
  manifest model that can later carry signed desktop dynamic extension
  artifacts;
- benchmarks and release gates against native PostgreSQL and SQLite, using p90
  and p99 latency, throughput, CPU, memory, RSS, child-process RSS, open time,
  backup/restore time, and artifact size.

The native product must not fake semantics for convenience. Direct mode has one
physical backend session. Broker mode provides process isolation and multi-root
supervision. Server mode is the only mode that advertises independent
concurrent PostgreSQL sessions.

## P0 Native Release Backlog

### P0-01: Keep The PostgreSQL Patch Stack Minimal And Defensible

Outcome: `liboliphaunt` patches stay generic, reviewable, and upstreamable.

Remaining work:

- Re-audit every PostgreSQL 18 patch after each backend change:
  - host I/O vtables;
  - embedded entrypoint and lifecycle;
  - frontend terminate return path;
  - cleanup and current-working-directory restoration;
  - static extension loader.
- Keep patch comments and exported symbols generic. They must not mention a
  language SDK, product packaging detail, or temporary experiment.

Acceptance:

- `src/runtimes/liboliphaunt/native/tools/check-track.sh quick` proves C smoke plus Rust SDK
  smoke without rebuilding current artifacts.
- Patch-stack review output is deterministic and checked into release evidence.
- No patch grows product-specific branching that belongs above PostgreSQL.

### P0-02: Finish Rust SDK Runtime Semantics

Outcome: the Rust SDK is complete and honest across direct, broker, and server.

Remaining work:

- Keep `Oliphaunt` clone semantics explicit: clones share one executor in direct
  and broker sessions; server mode exposes a connection string for independent
  clients instead of pretending direct mode can pool.

Acceptance:

- Rust direct, broker, and server tests cover close, cancel, checkpoint,
  transaction pinning, backup, restore, reopen, and external client recovery.
- No direct-mode API advertises independent concurrent sessions.

### P0-03: Complete SDK Parity For The Public Contract

Outcome: Rust, Swift, Kotlin, and React Native expose the same product concepts
where the platform can support them.

Remaining work:

- Keep Rust classified as an SDK and the canonical product shape.
- Keep React Native as TypeScript and TurboModule glue over Swift and Kotlin;
  it must not grow a private database runtime.
- Build Android `NativeBroker` as a remote-process bound service with binder
  death/reconnect and WAL-recovery tests. This is the first mobile process
  isolation path.
- Run and document an iOS ExtensionFoundation/AppExtensionProcess broker
  feasibility track before promising iOS process isolation. Keep iOS direct as
  non-isolated unless that track passes real-device lifecycle and App Store
  constraints.
- Expand physical iOS benchmark-matrix evidence for the current `liboliphaunt`
  XCFramework before choosing mobile defaults. Device and simulator slices now
  build and reject forbidden mobile IPC imports, and the physical iPhone
  app build/install, crash-recovery verify, full smoke/lifecycle lanes, and
  process-memory-capable quick plus full-candidate Safe/Balanced footprint
  matrices pass. A Balanced quick tuning slice across
  `shared_buffers=8/16/32/64/128MB` and `min_wal_size=8/16/32MB` also passes.
  The next iOS evidence steps are Safe coverage for the chosen candidate axes,
  `wal_buffers` variation, runtime-footprint profile variation, and then the
  full preset physical-device matrix for the selected mobile default.
- Keep `pnpm moon run oliphaunt-swift:smoke` green as the fast
  no-artifact gate for PostgreSQL 18 embedded patch portability while the full
  iOS simulator/device artifacts are being built.
- Keep the Android Expo installed-app smoke lane reproducible from a checkout
  without a committed generated `android/` directory. The local
  `Pixel_9_API_34_Google_API` AVD now has benchmark and crash-recovery evidence
  when cold-started with software GPU/no snapshot, but physical Android device
  evidence and process-memory-capable full candidate/tuning slices are still
  needed before release claims. A later local AVD retry killed the app process
  before attach/startup and produced no Metro bundle request; treat that as a
  harness/device reliability gap, not PostgreSQL tuning evidence.

Acceptance:

- `src/runtimes/liboliphaunt/native/tools/check-track.sh sdks` passes on a current native
  runtime.
- `pnpm --dir src/sdks/react-native/examples/expo run smoke:android` passes on an Android
  emulator/device with current native Android artifacts.
- `pnpm moon run oliphaunt-swift:smoke` passes on macOS with Xcode and
  stays warning-clean for the PostgreSQL embedded patch objects.
- `pnpm moon run liboliphaunt-native:build-ios-xcframework` produces current
  iOS simulator/device `liboliphaunt.dylib` slices with the public C ABI
  symbols.
- `pnpm --dir src/sdks/react-native/examples/expo run smoke:ios` passes on an iOS
  simulator/device with current native iOS artifacts.
- Every row in `docs/maintainers/sdk-parity-policy.md` has SDK-specific tests or a documented
  product reason for non-parity.

### P0-04: Finish Extension Release Evidence

Outcome: extensions are opt-in, size-conscious, and backed by lifecycle
evidence across direct, broker, server, and mobile static registry packaging.

Remaining work:

- Keep exact PostgreSQL extension names as the only public selection primitive;
  do not introduce first-party selection aliases.
- Prove the native exact-extension artifact matrix is green for every published
  native runtime target: `macos-arm64`, `linux-x64-gnu`, `linux-arm64-gnu`,
  `windows-x64-msvc`, `ios-xcframework`, `android-arm64-v8a`, and
  `android-x86_64`. The package graph must not relabel one target's artifacts
  as cross-platform evidence; each builder must emit product-versioned
  extension release assets, target metadata, and smoke evidence for the target
  it built.
- Keep pgGraph and ParadeDB `pg_search` as explicit external extension
  candidates with pinned source, license, build fingerprint, preload metadata,
  and smoke evidence.

Acceptance:

- `src/runtimes/liboliphaunt/native/tools/check-track.sh extensions` passes with first-party
  extension artifacts.
- `extension-packages:assemble-release` receives native extension artifacts for every
  published native runtime target and WASIX extension artifacts for every
  published WASIX target.
- `extension-packages:assemble-mobile` receives only the Android/iOS native
  extension artifacts needed by focused mobile installed-app builders and does
  not force WASIX or desktop extension builders into mobile E2E runs.
- External extensions pass the opt-in external pgrx lane before they are
  advertised as shippable.
- Mobile package checks reject module-backed extensions unless a complete static
  registry is present.

### P0-05: Make Benchmarks Release-Grade

Outcome: native release claims are backed by reproducible benchmark reports that
can be compared against native PostgreSQL and SQLite.

Remaining work:

- Keep the native matrix native-only and no-build by default when artifacts are
  current.
- Keep the verified source-current full report fresh after benchmark harness,
  Rust SDK, or liboliphaunt runtime input changes. Latest complete verified
  baseline before the backup ABI/tar-writer updates:
  `target/perf/native-liboliphaunt-20260524T090412Z/report.md`. A new full
  matrix is required before current-checkout release claims.
- Investigate measured NativeDirect misses from the current report:
  speed-suite p90 (`1.103x` native PostgreSQL), speed tail throughput (`0.907x`
  native PostgreSQL), physical backup/restore total p90 (`1.622x` native
  PostgreSQL physical), physical backup throughput (`0.617x` native PostgreSQL
  physical), and speed cases `1`, `2.1`, `3`, `4`, `10`, and `13`, which
  reproduced in
  `target/perf/native-speed-diagnostics-20260524T090412Z-speed-misses/summary.md`.
  Cases `2`, `3.1`, and `5` missed in the full matrix but did not reproduce
  above tolerance in isolated fresh-process diagnostics.
- Keep investigating the current-source focused backup miss from
  `target/perf/native-liboliphaunt-20260524Tbackup-final-direct/report.md`:
  direct physical backup/restore p90 is `0.534 s` versus native PostgreSQL
  physical at `0.324 s`. `OLIPHAUNT_TRACE_BACKUP=1` shows the remaining direct
  cost is concentrated in `pg_backup_start` and PGDATA archiving after metadata
  append/copy overhead was removed from the hot path.
- Expand the release matrix beyond the current verified coverage where still
  missing: extended-query RTT as its own lane, typed query helper overhead,
  transaction throughput, dedicated bulk load variants, and cold/warm open
  repeat rows.
- Keep benchmark quality rules and NativeDirect regression diagnostics green as
  the suite changes.

Acceptance:

- `tools/perf/check-native-perf-harness.sh` passes.
- A complete provenance-verified report exists for direct, broker, server,
  native PostgreSQL, and SQLite.
- `src/docs/content/reference/performance.md` is updated only from verified output.

## P1 Product Hardening Backlog

### P1-01: Improve Repository And Release Organization

Outcome: `liboliphaunt`, `oliphaunt`, Swift, Kotlin, and React Native remain
separate products with clean ownership.

Remaining work:

- Keep native C sources under `src/runtimes/liboliphaunt/native/`.
- Keep the Rust SDK under `src/sdks/rust/`.
- Keep platform SDKs under `src/sdks/swift`, `src/sdks/kotlin`, and `src/sdks/react-native`.
- Keep legacy package code from becoming a dependency of native product checks.

### P1-02: Harden Storage And Backup

Outcome: directory storage feels ergonomic without hiding PostgreSQL realities.

Remaining work:

- Add multi-version upgrade policy fixtures once a second root schema or
  PostgreSQL major exists.
- Add restore upgrade choreography once archive metadata has more than one
  supported PostgreSQL major or archive layout.
- Add import/export documentation for desktop and mobile apps.

### P1-03: Reduce Open-Time And Steady-State Overhead

Outcome: native direct is not slower than the native PostgreSQL control for SDK
traffic after accounting for process model differences.

Remaining work:

- Profile direct-mode copies across C ABI, Rust protocol buffers, Swift `Data`,
  Kotlin `ByteArray`, JNI byte arrays, and React Native JSI ArrayBuffer
  transport.
- Add zero-copy or single-copy transport paths where the platform API supports
  them.
- Investigate warm template cache behavior and file-copy strategy per platform.
- Keep any startup GUC tuning explicit, documented, and safe for persistent
  roots.

### P1-04: Strengthen Developer Experience

Outcome: app developers can adopt native Oliphaunt with predictable packaging and
idiomatic APIs.

Remaining work:

- Add guided quickstarts for Rust/Tauri, Swift iOS, Swift macOS, Android, and
  React Native.
- Add troubleshooting docs for root locks, missing runtime resources, missing
  static registry entries, preload-required extensions, and benchmark misses.
- Add example apps that exercise open, query, transaction, extension, backup,
  restore, and close.

## P2 Future Capabilities

These are not release blockers until they have evidence and a crisp product
boundary.

- Signed dynamic desktop extensions.
- Out-of-process broker pools for multiple active backend workers per root.
- Mobile broker/server adapters when platform constraints and app-store rules
  are fully understood.
- Live-query APIs designed as native Rust/Swift/Kotlin/TypeScript surfaces
  rather than a compatibility shim.
- Cross-language generated bindings after the Rust, Swift, Kotlin, and React
  Native SDK shapes are stable.
