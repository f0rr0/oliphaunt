# Native Runtime Agent Guide

## Scope

This directory owns the native `liboliphaunt` C ABI, PostgreSQL 18 patch stack,
native build scripts, target metadata, runtime resources, and host/mobile smoke
harnesses.

Use `.agents/skills/native-track/SKILL.md` for native runtime, C ABI,
PostgreSQL patch, target metadata, extension-matrix, or native SDK validation
work.

## Boundaries

- Keep native work in the native lane. Do not route native Rust, Swift, Kotlin,
  React Native, or TypeScript SDK behavior through `oliphaunt-wasix`.
- Treat `include/oliphaunt.h` as a public ABI boundary. Pair ABI changes with
  consumer smoke/tests and SDK bindings.
- PostgreSQL patch changes must stay under `patches/postgresql-18.4/` and be
  validated by the patch-stack checks.
- Target metadata lives in `targets/*.toml`; do not duplicate target matrices
  in CI or release scripts.
- Build outputs and packaged native libraries belong under ignored `target/`
  paths, never in this source tree.

## Commands

```sh
moon run liboliphaunt-native:check
moon run liboliphaunt-native:test
moon run liboliphaunt-native:smoke
src/runtimes/liboliphaunt/native/tools/check-track.sh host-smoke
src/runtimes/liboliphaunt/native/tools/check-track.sh quick
src/runtimes/liboliphaunt/native/tools/check-track.sh rust
src/runtimes/liboliphaunt/native/tools/check-track.sh sdks
src/runtimes/liboliphaunt/native/tools/check-track.sh extensions
src/runtimes/liboliphaunt/native/tools/check-track.sh full
```

Use `OLIPHAUNT_TRACK_BUILD=never` to prove an existing runtime is current,
`missing` to build only missing/stale artifacts, and `always` only for a
deliberate rebuild.

## Validation Pattern

- For metadata or patch-stack-only changes, start with
  `moon run liboliphaunt-native:check`.
- For host smoke evidence against an already-built runtime, use
  `OLIPHAUNT_TRACK_BUILD=never moon run liboliphaunt-native:test`.
- For local native iteration, prefer `check-track.sh quick` or `rust` before
  wider SDK or extension modes.
- For extension-sensitive changes, run `check-track.sh extensions` on a host
  that supports native extension artifacts.
- For SDK-surface changes, run `check-track.sh sdks` or targeted SDK Moon tasks.

## Edit Checklist

- Check `tools/runtime/preflight.sh` before changing runtime env vars or
  artifact discovery.
- Check `tools/perf/check-native-perf-harness.sh` before changing native
  benchmark lanes.
- Pair target metadata changes with `tools/release/artifact_targets.py`,
  `tools/release/check_artifact_targets.py`, and release asset package checks.
- Keep `OLIPHAUNT_*` as the public runtime/build control prefix. Use
  `LIBOLIPHAUNT_PATH` only for the literal native C library artifact path.
