# libpglite

`libpglite` is the native C boundary for embedded PostgreSQL. It owns the
PostgreSQL 18 source pin, upstreamable patch stack, C ABI header, native shim,
and local smoke/build scripts.

This directory is intentionally not the Rust SDK. Rust lives in
`crates/libpglite-oxide`; future Swift, Kotlin, React Native, and other targets
should bind to the same C ABI instead of reaching into PostgreSQL internals.

## Layout

- `include/libpglite.h`: public C ABI.
- `src/libpglite_native.c`: host-owned request/response transport and backend
  lifecycle shim.
- `patches/postgresql-18.3/`: minimal PostgreSQL patch stack.
- `postgres18/source.toml`: pinned PostgreSQL source manifest.
- `bin/build-postgres18-macos.sh`: macOS build harness.
- `bin/smoke-macos-happy-path.sh`: C ABI smoke harness.

## Build

```sh
libpglite/bin/build-postgres18-macos.sh
```

The default output root is `target/libpglite-pg18`. The script still accepts
the older `PGLITE_OXIDE_NATIVE_*` environment variables as migration fallbacks,
but new automation should use `LIBPGLITE_*` for the C layer and
`LIBPGLITE_OXIDE_*` for the Rust SDK layer.
