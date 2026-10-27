Run native targets with `tools/dev/bazel.sh`. It reads `.bazelversion` and verifies
the downloaded executable against `tools/dev/bazel-checksums.tsv`, including cached
copies. Bazel bundles its Java runtime. No hosted execution or cache is configured.
Ordinary commands require the committed module lockfile. After an intentional
module/toolchain dependency change, refresh it with
`tools/dev/bazel.sh mod deps --lockfile_mode=update` and review the generated diff.

The source pins remain in `.prototools`, `rust-toolchain.toml`, `Cargo.toml`,
`tools/dev/bun.toml`, and `bun.lock`. The tracked repository importer reads these
inputs before invoking pinned Bun. Generated metadata is a one-way projection;
it does not select new dependency versions or run an install. Rule releases and
their dependencies are pinned in `MODULE.bazel` and its lockfile. Authored
TypeScript build scripts use the existing pinned Bun runtime.
Upstream Bazel rules retain their own tooling; for example, `rules_pkg` uses
Python internally. The repository does not add Python scripts for this migration.
Language acquisition reads only Rust version, edition, and locked Node declaration
dependencies. Query package name, version, and module type have separate projections;
changing those package facts cannot change the language acquisition lock inputs.

The Bun lock importer currently covers the query workspace's TypeScript compiler,
Node declarations, and their `undici-types` dependency. It checks the manifest,
catalog, supported lock schema, resolved versions, and integrity fields. Changes
requiring unsupported resolution behavior fail before the native build.

The Rust query slice imports crate name, version, edition, minimum compiler, and
Cargo package environment from the conventional manifests. Its current contract
is the default library target with inherited workspace edition and compiler
minimum, without dependencies, features, target-specific configuration, or build
scripts and additional automatically discovered Cargo targets. Adding such inputs
fails until the native graph represents them. A Rust
package version is a compiler environment input and can require recompilation.

The TypeScript CommonJS target validates the source package's effective `type`.
It does not depend on unrelated package metadata. The packaged consumer check
uses Node to exercise both ESM import and CommonJS require.

The platform labels describe configurations; they do not grant release support.
Native C currently uses the local host compiler and declared local generator
tools. That lane must remain outside hermetic release qualification until its
compiler, sysroot, and generator toolchains have been qualified. Source crate
consumer tooling and the existing publication checks remain necessary for the
public Cargo package contract.
