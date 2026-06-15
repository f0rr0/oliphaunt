---
name: native-track
description: Native liboliphaunt workflow for C ABI, PostgreSQL 18 patches, native runtime targets, native extension matrix, and SDK parity validation. Use when changing src/runtimes/liboliphaunt/native, native target metadata, native runtime env vars, native performance harnesses, or SDK behavior that depends on the native runtime.
---

# Native Track

## Workflow

1. Identify the touched layer:
   - C ABI/header: `src/runtimes/liboliphaunt/native/include/oliphaunt.h`
   - C runtime implementation: `src/runtimes/liboliphaunt/native/src/`
   - PostgreSQL patch stack: `src/runtimes/liboliphaunt/native/patches/postgresql-18.4/`
   - platform build scripts: `src/runtimes/liboliphaunt/native/bin/`
   - target metadata: `src/runtimes/liboliphaunt/native/targets/*.toml`
   - Rust consumer/runtime bridge: `src/sdks/rust/src/runtimes/liboliphaunt/native/`
2. Verify current behavior from `src/runtimes/liboliphaunt/native/moon.yml`,
   `src/runtimes/liboliphaunt/native/tools/check-track.sh`, and
   `tools/runtime/preflight.sh`.
3. Keep native and WASIX lanes separate. Do not solve native SDK problems by
   depending on `oliphaunt-wasix`, WASIX AOT crates, or Wasmer runtime packages.
4. Prefer the smallest runtime lane that proves the change. Avoid broad rebuilds
   until static and targeted checks pass.

## Commands

```sh
moon run liboliphaunt-native:check
OLIPHAUNT_TRACK_BUILD=never moon run liboliphaunt-native:test
moon run liboliphaunt-native:smoke
src/runtimes/liboliphaunt/native/tools/check-track.sh quick
src/runtimes/liboliphaunt/native/tools/check-track.sh rust
src/runtimes/liboliphaunt/native/tools/check-track.sh sdks
src/runtimes/liboliphaunt/native/tools/check-track.sh extensions
tools/perf/check-native-perf-harness.sh
tools/release/release.py check
```

`OLIPHAUNT_TRACK_BUILD=never` fails when artifacts are missing or stale.
`missing` builds absent/stale artifacts. `always` is for deliberate rebuilds.

## Decision Rules

- For patch-stack/source metadata changes, start with `liboliphaunt-native:check`.
- For ABI changes, update consumer bindings and run a host smoke path.
- For extension artifact changes, use `check-track.sh extensions` only after
  static model and artifact metadata checks pass.
- For SDK parity changes, run `check-track.sh sdks` or targeted SDK tasks.
- For target matrix changes, inspect `targets/*.toml`,
  `tools/release/artifact_targets.py`, `tools/release/check_artifact_targets.py`,
  and CI matrix planner behavior.

## Evidence To Report

Report which layer changed, which runtime build policy was used, whether the
runtime was reused or rebuilt, and which Moon/script checks were run or skipped.
