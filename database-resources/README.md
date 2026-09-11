# Database resources

This product owns PostgreSQL cluster seeds and canonical ICU data. A seed is an
initialized database directory; it contains neither a PostgreSQL runtime nor ICU
data. Existing databases do not need a seed.

The four selectable profiles are native standard, native ICU, WASIX standard,
and WASIX ICU. Native seeds additionally have a physical target: a seed for
`linux-x64-gnu` is not declared compatible with another architecture or mobile
layout. The compatibility keys are in [contracts/contract.json](contracts/contract.json).
Both ICU profiles reference the same pinned `icudt76l.dat` by its tree digest.
Producing this data carrier copies the verified upstream file; it does not build
PostgreSQL or ICU libraries.

Android selects `dev.oliphaunt.runtime:oliphaunt-seed-native-android-datum64-standard`
or `dev.oliphaunt.runtime:oliphaunt-seed-native-android-datum64-icu`. The existing
Gradle plugin merges the selected carrier; neither seed is a default dependency.
ICU selection also uses the independently versioned canonical ICU carrier.

The resource-owned Swift source archive exposes `OliphauntSeedNativeIOSStandard`,
`OliphauntSeedNativeIOSICU`, and `OliphauntICU`. Only the ICU seed target depends on
the ICU data target. These products belong to the resource package, not the SDK.
The archive can be used as a local SwiftPM dependency; automated remote SwiftPM
distribution requires a separate repository identity from the SDK. Downloading
the resource source archive includes both seed profiles, while target selection
controls the resources built into the application.

From the repository root:

```sh
moon run database-resources:package-icu
moon run database-resources:build-native-standard
moon run database-resources:build-native-icu
moon run database-resources:build-wasix-standard
moon run database-resources:build-wasix-icu
```

The same Moon commands work from this product directory. `moon run
database-resources:test` runs seed and ICU packaging tests
once, without compiling PostgreSQL. Packaging and seed creation use the explicit
profile tasks above; there is no default command that builds every profile.
Android seed production requires the Android NDK; iOS seed and carrier production
requires macOS and Apple SDKs. Existing compiler outputs can be used locally as
shown below without pretending to be a GitHub runner.

Each seed command produces only the requested profile. To use an existing
compiler output directly, bypass the build prerequisite and provide its prepared
runtime directory:

```sh
OLIPHAUNT_SEED_RUNTIME_DIR=/path/to/runtime bash database-resources/seeds/build.sh native standard
OLIPHAUNT_SEED_RUNTIME_DIR=/path/to/wasix/runtime bash database-resources/seeds/build.sh wasix standard
```

For ICU profiles, `OLIPHAUNT_ICU_DATA_DIR` can select an existing canonical files
tree. Otherwise the default is `target/database-resources/icu/data/share/icu`.
The standalone WASIX producer is an ordinary private Cargo project in
`seeds/wasix`; its CLI accepts a prepared runtime directory, a new working
directory, one profile, and an ICU directory only for the ICU profile.

Artifacts are written to `target/database-resources/release-assets`. Each seed
archive contains PGDATA directly and has an adjacent JSON manifest recording its
profile, physical compatibility, producer/initdb hashes, archive checksum,
and required ICU identity. These are frozen outputs of the actual `initdb` run;
two independent initializations are not assumed to have identical bytes.

The canonical ICU archive contains only `share/icu`, its manifest, size report,
and license notices. Cargo and npm carriers preserve that data-only payload.
The initial independent owner version is 0.2.1, above the completed 0.2.0 ICU
carrier histories; existing published versions remain immutable.

`package-native`, `package-wasix`, `package-android`, and `package-ios` create
separate npm and Cargo leaves for the corresponding physical targets and profiles.
Each leaf contains one seed. ICU leaves depend on the same canonical ICU carrier;
standard leaves have no ICU dependency. There is no package that installs every
seed, and data packages do not restrict the installation host's OS or CPU.

Native npm leaves contain unpacked PGDATA and expose `./pgdata/PG_VERSION` and
`./manifest.json`; the manifest includes the digest of the complete directory.
Cargo and WASIX npm leaves retain their compressed seed archive. The iOS npm
leaves also expose a resource-only CocoaPod that React Native autolinks. Install
one iOS profile; its seed bundle is separate from the SDK and canonical ICU data.

WASIX seed production uses `liboliphaunt-wasix:compiler-output`, whose prepared
runtime lives at `target/oliphaunt-wasix/wasix-build/build/install`. Runtime
packaging uses a separate staging directory so it cannot delete a seed producer's
input while the tasks run concurrently.

The consumer migration is still in progress. Mobile consumers now select resource
carriers independently, while actual Apple and Android installed applications
remain part of platform qualification.
