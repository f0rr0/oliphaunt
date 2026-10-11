# Native extension construction

The native graph constructs all 32 PostgreSQL 18 contrib members and the seven
external extensions on Linux. The qualified Linux x86_64 glibc 2.28 profile has
passed actual SQL consumers for all 39 members, with separate archive validators. Linux
ARM64 has passed the earlier 37-member construction batch; the completed
pgcrypto/PostGIS graph and latest vector recipe still require ARM64 qualification.
The extension rules remain incompatible with other native platforms until their
module and dependency recipes are implemented and tested.

Source pins, SQL defaults, release identities, carrier ownership and permitted
resources come from `@oliphaunt_metadata`, imported from existing descriptors.
External source repositories use full immutable Git commits. The pgTAP tool
expands the pinned SQL inputs and compatibility patches with TypeScript using
pinned Bun, then invokes the exact upstream gencore and uninstall Perl code
through the declared Perl toolchain. It does not invoke PGXS, Make or pg_config.
Its Makefile recipe fingerprint fails closed when installation semantics change.
The per-pin parity test compares all installed bytes with real upstream
patch/Perl execution; it never calls the production TypeScript patch implementation.

C members compile twice through ordinary CcInfo: server headers for
`lib/postgresql`, and embedded headers plus liboliphaunt for `lib/modules`.
Those files are independent compiler outputs. Packaging maps resource paths
explicitly and emits deterministic internal tar archives and inventories.
The independent reader inspects actual archive entries, SQL installation paths,
checksums, module ELF architecture and expected carrier identity.

Contrib generation uses the declared Perl, Bison, Flex and M4 toolchains.
pgcrypto consumes the pinned OpenSSL provider. PostGIS builds its six pinned
dependency libraries, upstream scanner and SQL generators, and PROJ database
from declared sources. Its current generated configuration is specific to Linux
LP64 and cannot establish WASIX or mobile support.

The qualified Zig Linux x86_64 vector recipe preserves upstream CPU dispatch.
It enables the compiler's EVEX width support without raising the default AVX
CPU baseline, and links the matching immutable LLVM compiler-rt CPU-model
provider. The member archive carries that provider's source receipt and license;
independent validation rejects a missing or modified notice.

These archives use `ecosystem = "internal"`, `role = "extension-member"`.
They are construction inputs, not final registry envelopes. Recorded workspace
PostgreSQL source pins are build-input facts; they do not
replace an external product's published compatibility requirements or prove
compatibility with a released runtime binary after workspace changes.

Run the focused generator tests separately when those inputs change:

```sh
tools/dev/bazel.sh test \
  //build_defs/extensions:pgtap_sql_test \
  //build_defs/extensions:member_payload_test \
  //src/extensions/external/pgtap:upstream_sql_parity_test
```

Run the broad installed SQL consumers with the qualified compiler profile:

```sh
tools/dev/bazel.sh test \
  //build_defs/extensions:native_built_extension_sql_test \
  //build_defs/extensions:native_frozen_extension_sql_test \
  --platforms=//build_defs/native:linux_x86_64_glibc_2_28 \
  --host_platform=//build_defs/native:linux_x86_64_glibc_2_28
```

The candidate consumer overlays all 39 actual member archives onto the built
runtime payload. The frozen consumer overlays the seven independently versioned
external members onto the actual immutable published native 0.3.3 archive and
compiles against that archive's header and library. Each selected member must
declare that exact host requirement; the acquisition binding alone does not
prove compatibility. Contrib members follow their runtime owner and are tested
with the candidate runtime.

Both consumers install and execute extensions through the embedded C ABI,
reopen the persisted database in a new process, and separately execute the
server modules through the extracted PostgreSQL executable. Consumers are
relocated outside source runfiles and use only extracted library directories.
Removing the runtime library must fail loading; removing a PostGIS dependency
must fail each module layout independently. No workstation PostgreSQL supplies
the runtime or modules.

Final registry envelopes, all remaining platform qualification, WASIX
pgcrypto/PostGIS dependencies and full publication integration remain separate
migration gates. Internal member archives do not satisfy those gates by
themselves.
