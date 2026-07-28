# oliphaunt Rust SDK Policy

The Rust SDK is a peer product SDK for Tauri and Rust desktop apps. Its package
source lives in `src/sdks/rust` rather than root docs so Cargo workspace
ownership, release metadata, examples, benches, and tests stay idiomatic.

Target users:

- Tauri desktop apps;
- Rust desktop apps that want embedded PostgreSQL without sidecars in direct
  mode;
- Rust services or developer tools that want broker/server modes with local
  PostgreSQL compatibility.

Validate the Rust SDK with:

```bash
moon run oliphaunt-rust:check
```

Other SDKs should match the shared Oliphaunt concepts where the platform allows it:

- engine modes: native direct, native broker, native server;
- raw PostgreSQL protocol boundary;
- typed query helpers layered above raw protocol;
- transaction helpers that keep one physical session pinned and reject
  unpinned interleaving, including backup/checkpoint work, while still allowing
  pinned raw and streaming protocol calls. Use `transaction()` when you want an
  explicit handle, or `with_transaction(async |tx| { ... })` for commit/rollback
  closure ergonomics;
- `checkpoint()` for explicit PostgreSQL checkpoint requests through the opened
  engine;
- startup identity through builder-level `username(...)` and `database(...)`
  options that feed direct, broker, and server-owned PostgreSQL sessions;
- SDK-owned executable/tooling paths such as `initdb_tooling_only(...)`,
  `broker_executable(...)`, and `server_executable(...)` are rejected when
  empty or NUL-containing before process startup;
- structured PostgreSQL errors with SQLSTATE and raw `ErrorResponse` fields;
- exact extensions selected before open;
- physical backup/restore for same-version archives;
- capability reporting for raw and streaming protocol, cancellation,
  backup/restore, simple-query execution, extensions, and session
  semantics, including concrete backup and restore format support through
  capability and opened-handle `supports_backup_format` and
  `supports_restore_format` helpers;
- `max_client_sessions(...)` is an honest concurrency knob: direct and broker mode reject values other than `1`; server mode is the mode for independent
  PostgreSQL client sessions and pools;
- SDK-boundary rejection for unsupported backup formats before work is queued
  onto the engine executor, and unsupported restore formats before a target
  root is materialized;
- explicit mode support discovery through
  `EngineCapabilities::rust_sdk_support()`;
- cancellation and close semantics;
- packaged runtime/template resources.

Swift, Kotlin, TypeScript, React Native, and WASM may expose platform-native
naming, async, and packaging conventions, but deviations from the shared
Oliphaunt contract should be documented and justified rather than allowed to
drift silently.
