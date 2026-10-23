This is a closed installed Cargo consumer test for the current checkout. It uses
actual constructed source crates, a genuine Cargo-generated lockfile, captured
sparse index records, and registry archives authenticated by that lockfile.
It does not authorize publication or establish completed release origins.
Archive acquisition uses Cargo's selected Linux host graph; the remaining
cross-target index records support offline resolution without downloading their
unused platform archives.

`consumer_test` runs three common preparation cases: the current SDK/helper
composition with its declared candidate dependency closure, a direct packaged
Core public API consumer, and the current helper with the genuine held SDK and
runtime. Each case compiles and executes SQL/reopen checks. The direct Core case
leaves the held SDK's requirements unchanged.

`consumer_minimum_test` checks the additional declared internal source floors
for a prepared selected native SDK or Broker. The SDK case runs SQL/reopen; the
Broker case installs its original binary source envelope independently of SDK
constraints and dev requirements, then checks Cargo's compiled manifest paths.
Each floor uses its exact retained completed archive or an explicitly selected
current producer at that version. A newer compatible input cannot prove the
floor. The source-owned final policy requires this test for these selected
carriers; preparation alone cannot satisfy that requirement.
Cargo resolves both tests' compositions offline from the conventional manifests
and captured inputs. For SDK compositions, independently held runtime
requirements remain the SDK manifest's requirements. Results record which
source candidates Cargo actually selected; an unused patch is not qualification
of that candidate.

The WASIX `source_compile_test` cases compile each extracted package's original
tests, including dev requirements. Registry-only source dependencies retain their
completed captured identities while the packaged requirements still accept them.
An authored local path can select its actual
current dependency before release version calculation; its original manifest
must identify the explicitly supplied dependency archive's source manifest.
Co-selection alone does not change a registry requirement or a held dependency.
For prepared selected source owners with local dependencies, the same worker
additionally compiles the declared production floors. Library owners compile as
dependencies, so their dev requirements cannot raise the qualified floor. Binary
owners use Cargo's offline install of the original envelope to compile both
library and binary production targets. These cases share a Cargo cache and target
directory, preserve original source manifests, and verify the compiler-reported
manifest paths. Their results distinguish source test compilation from production
floor compilation. Selection stays within the captured one-identity-per-local-name
closure; it is not a general minimal-version resolver. The existing selector test
uses tiny controlled archives and declared tools to exercise these phases; its
fixtures have no completed-publication provenance claim.

Each case also supplies its original exact runtime, helper and data payload
archives. Completed bytes take precedence, including at the same version.
Current payloads are eligible only when their actual source consumer and producer
are prepared selected at the constructed versions and the original manifest pins
that exact producer version. The held SDK case retains its own payload pins.
Native multipart inputs retain the original part set; WASIX current inputs are
the original configured Cargo carrier Files from the same invocation. Workers
stage only requested archives, keep the third-party context unchanged, and let
offline Cargo generate the lock before locked compilation. They do not edit
source manifests or manufacture registry entries for unpublished inputs.
These installed qualifiers require the source-bound native release input
snapshot's actual completed payload pool. A matching archive in the captured
registry cache cannot replace a missing required completed input. Prepared late
qualification additionally receives actual current producer Files. This input
requirement establishes the test composition; it does not establish publication
admission by itself.

Registry requirement changes need explicit qualification preflight. Run
`capture.mts` with the pinned Cargo and rustc executable paths, an output
directory, and the constructed source archive paths. The updater invokes real
Cargo resolution and fetch, verifies each downloaded archive against its lock
checksum and sparse index record, and emits `Cargo.lock` plus
`registry-index.json`. Replace both fixture files together with these generated
outputs, review the dependency changes, refresh the module acquisition lock if
needed, then run the closed test. No manually edited resolution graph is used.

The production frozen consumer adapter independently authenticates selected
candidate and held origins from its publication capsule before sharing the same
source-envelope stager. This checkout test intentionally has no publication
capsule or production origin claim.
