# SDK resource packaging contract

A separate, deferred distribution change would make standard seeds optional and use
`initdb` by default. The [cluster-seed transition](../architecture/cluster-seeds-and-icu.md#optional-download-transition)
records the remaining native-mobile/browser initialization and carrier work.
The bundled-standard-seed descriptions below describe the current implementation,
not the target of that rollout.

Applications install a base SDK and explicitly select descriptors when opening a
database. The base SDK includes PostgreSQL, supported contrib extensions, and
the standard cluster seed. External extensions, ICU data with its matching seed,
and frontend tools are optional dependencies.

## Consumer setup

| SDK | External vector dependency | Per-database selection |
| --- | --- | --- |
| Native Rust | `oliphaunt-extension-vector` | `.extensions([oliphaunt_extension_vector::VECTOR, oliphaunt::extensions::HSTORE])` |
| WASIX Rust | `oliphaunt-extension-vector-wasix` | `.extensions([oliphaunt_extension_vector_wasix::VECTOR, oliphaunt_wasix::extensions::HSTORE])` |
| Native Node / Bun / Deno | `@oliphaunt/extension-vector` | `extensions: [vector, extensions.hstore]` |
| WASIX Node / Bun / Deno | `@oliphaunt/extension-vector-wasix` | `extensions: [vector, extensions.hstore]` |
| Kotlin / Java | `dev.oliphaunt.extensions:oliphaunt-extension-vector` | `Vector.descriptor`, `Extensions.HSTORE` |
| React Native | `@oliphaunt/extension-vector` | `extensions: [vector, extensions.hstore]` |
| Swift | `OliphauntExtensionVector` product | `OliphauntExtensionVector.descriptor`, `OliphauntExtensions.hstore` |

Dependency declarations and lockfiles choose external package versions. The SDK
validates compatibility with its runtime. Installing an extension does not select
it for every database. Applications use SQL migrations to run `CREATE EXTENSION`.
Required extension dependencies are included in the selected resource closure.

See the SDK READMEs for executable setup examples:

- [Native Rust](../../src/sdks/rust/README.md)
- [WASIX Rust](../../src/bindings/wasix-rust/crates/oliphaunt-wasix/README.md)
- [Native JavaScript](../../src/sdks/js/README.md)
- [WASIX TypeScript](../../src/bindings/wasix-ts/README.md)
- [Kotlin and Java](../../src/sdks/kotlin/README.md)
- [React Native](../../src/sdks/react-native/README.md)
- [Swift](../../src/sdks/swift/README.md)

## Package ownership

The native Rust SDK performs its build-time artifact selection internally. An
ordinary application needs no `build.rs`, `oliphaunt-build` dependency, application
runtime metadata, or resource registration. The SDK materializes verified embedded
files into a reusable cache. Advanced preassembled-resource and signed application
paths remain available.

WASIX Rust uses independent external extension crates. Per-extension SDK features
are absent. Internal artifact crates retain features used by source qualification;
those are not the consumer API. Package-owned descriptors identify portable bytes
and host AOT artifacts.

JavaScript descriptors bind native package resolution to the imported package's
location, including npm aliases and nested installations. The native addon receives
only explicitly selected external packages. WASIX N-API contains the core runtime,
standard seed, and contrib payloads. It obtains external AOT modules, ICU resources,
and frontend tool modules from optional packages.

Kotlin's Gradle plugin resolves the variant dependency graph to determine which
resources to package. React Native's Expo plugin reads installed dependencies and
uses the same native extension packages as Node. Applications do not maintain a
second version map or package-selection list. Both still require explicit
per-database descriptors. Java exposes a blocking `AutoCloseable` facade for worker
threads.

SwiftPM's base product includes contrib. External products and ICU have independent
package trees. Their descriptors hide native registration and resource locations.
Release tooling generates these packages from verified carrier inputs; consumers
use SwiftPM dependencies and products.

## ICU and storage

The default runtime includes only the standard cluster seed. Optional ICU packages
include ICU data and compatible seeds. Native seeds have explicit target identities
and bind the ICU logical data tree digest; WASIX seeds retain the WASIX physical
format. Seeds are implementation resources, not extra consumer configuration.

Startup PostgreSQL settings use Rust setters, JavaScript objects, Kotlin/Java maps,
and Swift dictionaries. Filesystem locations use platform conventions: paths in
Rust and JavaScript, URLs in Swift, and File/path APIs in Kotlin and Java. React
Native's `directory()` accepts a native path or local file URI supplied by a mobile
filesystem library. It does not define an application-data storage kind.

## Validation boundaries

Validate installed package ownership, version, runtime compatibility, target,
archive layout, and hashes before loading payloads. Native AOT validation also
checks compiler/runtime identity and the source fingerprint before deserialization.
An arbitrary caller-supplied path and adjacent checksum are not package provenance.
Native package installation is a trust boundary equivalent to installing native
code; package verification is not a claim of cryptographic publisher signatures.

Release checks inspect produced packages, enforce package-size limits and legal
notices, and reject external extension, ICU seed, or tool payloads leaking into the
base package. SDK tests exercise explicit selection and reject incompatible or
conflicting descriptors. Platform qualification must use the produced artifacts.
