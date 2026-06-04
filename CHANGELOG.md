# Changelog

All notable changes to this project will be documented in this file.

This project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.6.0](https://github.com/f0rr0/oliphaunt/compare/0.5.0...0.6.0) - 2026-06-04

### Fixed

- webc dependency conflict ([#39](https://github.com/f0rr0/oliphaunt/pull/39))

## [0.5.0](https://github.com/f0rr0/oliphaunt/compare/0.4.1...0.5.0) - 2026-05-08

### Added

- [**breaking**] add WASIX asset pipeline and protocol recovery ([#13](https://github.com/f0rr0/oliphaunt/pull/13))

### Fixed

- publish runtime assets on GitHub releases ([#27](https://github.com/f0rr0/oliphaunt/pull/27))
- mount WASIX urandom as virtual device ([#31](https://github.com/f0rr0/oliphaunt/pull/31))
- quiet expected postgres error recovery ([#28](https://github.com/f0rr0/oliphaunt/pull/28))

## [0.4.1](https://github.com/f0rr0/oliphaunt/compare/0.4.0...0.4.1) - 2026-05-07

### Fixed

- Publish release crates from the validated staged workspace so the
  `pglite-oxide-assets` and target-specific AOT crates include their generated
  payloads ([#25](https://github.com/f0rr0/oliphaunt/pull/25),
  [#24](https://github.com/f0rr0/oliphaunt/issues/24)).
- Release all internal asset/AOT crates at `0.4.1` alongside the root crate so
  the fixed release cannot resolve to broken `0.4.0` payload packages.
- Guard release validation against root/internal package version drift and
  Cargo's same-release internal dependency dry-run wording.

## [0.4.0](https://github.com/f0rr0/oliphaunt/compare/0.3.0...0.4.0) - 2026-05-07

> **Known broken release:** The crates.io packages for `0.4.0` were published
> without the generated runtime/AOT payloads, causing default `bundled` builds
> to fail at startup with missing embedded runtime assets. Use `0.4.1` or newer.

### Breaking

- Pivoted `pglite-oxide` to a new runtime architecture built around
  reproducible Wasmer WASIX artifacts, generated asset manifests, and
  target-specific AOT crates instead of checked-in runtime blobs
  ([#13](https://github.com/f0rr0/oliphaunt/pull/13)).
- Release packages now rely on CI-generated portable WASIX and native AOT
  artifacts for the exact release SHA. Applications should use the crate APIs
  instead of depending on repository asset paths.

### Added

- Added extension catalog/build metadata, smoke/promoted extension manifests,
  and generated APIs for discovering bundled PostgreSQL extensions.
- Added `pg_dump` support and native AOT packages for the supported macOS,
  Linux, and Windows target triples.

### Changed

- Reworked runtime startup, asset loading, protocol recovery, proxy behavior,
  and test coverage around the new backend.

### Fixed

- Refreshed example lockfiles automatically after release-plz version bumps so
  release PRs keep examples in sync with package versions.
- Isolated downloaded AOT artifacts by target and preserved portable assets
  after cache restore during asset/release jobs.
- Kept release validation inside the generated staged workspace so package
  checks run against the publishable crate contents.
- Allowed release dry-runs to reuse the latest compatible Assets run when
  package-only release commits do not change runtime inputs.

## [0.3.0](https://github.com/f0rr0/oliphaunt/compare/0.2.0...0.3.0) - 2026-04-26

### Breaking

- optimize startup and add Tauri SQLx profiler ([#9](https://github.com/f0rr0/oliphaunt/pull/9))

- `PgliteRuntimeOptions::default` now selects the optimized embedded-template
  startup path.
- `ensure_cluster` now requires runtime options.
- Runtime packaging now uses a bundled optimized runtime archive.

### Added

- Reusable embedded runtime caching and on-disk compiled-module cache support
  for faster startup.
- Embedded prepopulated PGDATA template with manifest validation.
- Vanilla Tauri v2 SQLx profiler example with release-mode workload reporting.
- Repo hooks for Conventional Commit validation, formatting, and pre-push checks.

### Changed

- Quieted WASI stdio by default and prefer Unix sockets where available.
- Streamlined runtime, release, contributing, and usage docs around the optimized
  default path.

### Fixed

- Hardened proxy frontend framing for SSL requests, cancel requests,
  split/coalesced packets, and extended-query batching.

## [0.2.0](https://github.com/f0rr0/oliphaunt/compare/0.1.0...0.2.0) - 2026-04-24

### Added

- modernize embedded PGlite API and OSS tooling ([#3](https://github.com/f0rr0/oliphaunt/pull/3))

- Added the high-level `Pglite` and `PgliteServer` APIs for direct embedded use
  and PostgreSQL client compatibility.
- Added process-local template cluster reuse for fast temporary databases.
- Added SQLx and `tokio-postgres` compatibility coverage, runtime/proxy smoke
  tests, CI, cargo-deny policy checks, Conventional Commit validation, and
  documented runtime asset provenance.
- Improved the blocking proxy/server path for extended-protocol clients,
  readiness handling, and socket mode behavior.

## [0.1.0](https://github.com/f0rr0/oliphaunt/releases/tag/0.1.0) - 2025-09-27

- Initial repository release.
