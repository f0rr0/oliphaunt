# oliphaunt-build

`oliphaunt-build` stages Cargo-resolved Oliphaunt artifacts. The native SDK and
resource packages call `embed_resolved_artifacts()` in their own builds, so
ordinary applications need no build script, build dependency, or
`package.metadata.oliphaunt` configuration. See the [Rust SDK setup](../../README.md).

Custom bundles can instead use the explicit staging API from their own
`build.rs`:

```rust
fn main() {
    oliphaunt_build::configure();
}
```

Direct application dependencies expose Cargo-resolved runtime, ICU, and
extension artifact manifests through Cargo `links` metadata. `oliphaunt-build`
validates the selected application metadata, copies the already-resolved
artifacts into `OUT_DIR/oliphaunt/resources`, and writes
`OUT_DIR/oliphaunt/oliphaunt-assets.lock`.

For `runtime = "liboliphaunt-wasix"`, root runtime staging includes only the
portable runtime and matching AOT runtime artifacts. If the application enables
the `oliphaunt-wasix` `tools` feature, `oliphaunt-build` also stages the split
`oliphaunt-wasix-tools` and tools-AOT artifacts that provide `pg_dump` and
`psql`. A native application stages `oliphaunt-tools` artifacts only when it
has an explicit dependency on the optional `oliphaunt-tools` facade. WASIX
applications that enable tools indirectly can set
`[package.metadata.oliphaunt] tools = true` to make that intent explicit.

It performs no network I/O, does not mutate `Cargo.toml`, and writes no generated
files outside `OUT_DIR`.
