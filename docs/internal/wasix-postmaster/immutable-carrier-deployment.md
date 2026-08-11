# Linux Immutable Carrier Deployment

## Purpose and claim boundary

The Linux research deployment executes the sealed carrier directly from verified
immutable inodes. It does not copy AOT archives or preinitialized executable
memory images into temporary files, memfds, a writable Wasmer cache, or a
reflink. This removes loader writeback and duplicate snapshot residency without
changing the postmaster design, fresh backend instances, PostgreSQL shared
memory, or private copy-on-write memory semantics.

This is a Linux ext-family deployment policy, not an all-platform release
claim. Generic read-only-filesystem recognition is outside the ext-family
claim. The ext-family qualifiers require every selected AOT and executable memory-image row to report
`direct-immutable-inode`.

This immutable payload boundary is distinct from executable-code working
state. On Linux x86_64 the postmaster executor mandates
`wasmer.code-memory.relocated-regular-file.linux-x86_64.v1` and creates a
private mode-0700 sibling directory named
`.oliphaunt-wasix-postmaster-code-memory-v1` beside the carrier. It pins that
directory by device/inode and creates unnamed regular-file code images there.
The sibling is writable runtime state and is intentionally outside the
immutable payload closure; placing it inside the `+i` carrier would make strict
activation impossible. The compiled non-Linux code path selects
`wasmer.code-memory.anonymous.v1`, but this project makes no other-host support
or Linux RSS/reclaimability claim for that path.

## Two closures with different jobs

The deployment receipt binds the complete verified `payload.files` closure:
every regular file and every directory, including the carrier root. All are
marked with `FS_IMMUTABLE_FL`. Files transition first, followed by directories
from deepest to shallowest and finally the root.

The direct activation subset is smaller and is derived from the unsigned sealed
manifest: five AOT artifacts and the `initdb` and `postgres` preinitialized
memory images. Wasmer maps only that subset as executable inputs. Marking the
whole carrier immutable is still necessary because cold qualification closes
all verifier descriptors before launch and the runtime subsequently reopens
paths. A writable sibling, directory, manifest, or inventory would leave the
reopened closure weaker than the one that was verified.

The external deployment receipt is part of the immutable state. It is created
before any carrier flag changes, owned by root, mode `0444`, and itself marked
immutable. Its canonical JSON binds carrier identities, every path's device,
inode, size, mode, uid/gid and digest, pre/post flags, and the direct subset. Benchmark
plans bind the receipt's SHA-256, device and inode plus the carrier closure
identity; a pathname by itself is never evidence.

The v2 receipt also records `core_profile` and
`guest_build_recipe_sha256`. Qualifiers perform one complete content check at
campaign start and one at campaign end. Per-sample `--fast` checks reopen the
receipt-bound closure and compare inode identity, type, size, mode, and `+i`
without reading payload contents. This is safe for the stated unprivileged
runner threat model because every parent directory and leaf remains immutable;
the privileged deployment authority remains trusted.

Carrier entry ownership is deliberately preserved rather than rewritten to
root. Both full and fast verification compare each live uid/gid with the
receipt. The security boundary is the immutable flag and
`CAP_LINUX_IMMUTABLE`: an unprivileged owner cannot clear `+i`, modify metadata
or bytes, or replace an immutable entry. Preserving ownership avoids a second,
destructive ownership migration and rollback protocol while still making any
ownership drift fail closed.

## Deploy, qualify, and remove

Build and verify a sealed carrier first. Choose a receipt parent controlled by
root and outside the carrier, then deploy with the capability required by the
Linux inode API:

```bash
project=src/runtimes/liboliphaunt/wasix-postmaster
carrier=/absolute/path/to/sealed-carrier
receipt=/var/lib/oliphaunt/wasix-postmaster/carrier.immutable.json

sudo "$project/bin/deploy-immutable-sealed-carrier.sh" \
  --sealed-carrier "$carrier" \
  --receipt "$receipt"
```

Deployment fails unless the caller has effective UID 0 and effective
`CAP_LINUX_IMMUTABLE`, every carrier inode is on a supported ext-family
filesystem, the payload inventory and manifest are exact, and no receipt
already exists. The verifier is read-only and can be run by the eventual
unprivileged service account:

```bash
"$project/bin/verify-immutable-sealed-carrier.sh" \
  --sealed-carrier "$carrier" \
  --receipt "$receipt"
```

Inside an already bounded campaign, use the byte-constant verifier:

```bash
"$project/bin/verify-immutable-sealed-carrier.sh" \
  --sealed-carrier "$carrier" \
  --receipt "$receipt" \
  --fast
```

Run performance qualification as that unprivileged account, with no effective
`CAP_LINUX_IMMUTABLE`. The explicit receipt and loader policy are mandatory for
the cold and checkpoint lanes and opt-in for the generic throughput/latency
lanes:

```bash
"$project/bin/qualify-wasix-single-backend.sh" \
  --sealed-carrier "$carrier" \
  --require-zero-write-aot \
  --immutable-carrier-receipt "$receipt" \
  --blocks 10 \
  --cgroup-memory-max 256M \
  --cgroup-memory-high 224M \
  --cgroup-swap-max 0 \
  --label immutable-throughput

"$project/bin/qualify-wasix-cold-ownership.sh" \
  --sealed-carrier "$carrier" \
  --immutable-carrier-receipt "$receipt" \
  --blocks 10 \
  --label immutable-cold
```

Remove the deployment only through the exact receipt-bound rollback operation:

```bash
sudo "$project/bin/deploy-immutable-sealed-carrier.sh" \
  --sealed-carrier "$carrier" \
  --receipt "$receipt" \
  --remove
```

Removal clears flags in reverse transition order and restores every inode's
recorded pre-deployment flags. It then clears the exact receipt inode's
immutable bit and unlinks it. It never uses a recursive `chattr` command or an
unverified glob.

## Loader fail-closed contract

Qualifiers remove both loader variables from their ambient environment before
launch. Only the measured WASIX `initdb` and postmaster commands receive:

```text
OLIPHAUNT_WASIX_REQUIRE_ZERO_WRITE_AOT=1
OLIPHAUNT_WASIX_SEALED_LOADER_AUDIT_FILE=<owned report path>
```

The first variable rejects streamed-copy and reflink compatibility paths. The
second produces newline-delimited JSON containing two schemas. Mapping rows use
`oliphaunt.wasix-postmaster.sealed-loader-receipt.v2`. Each row binds the PID,
artifact kind, module SHA-256, snapshot mode, logical/read/write/hash byte
counters, sync-call count, and write policy. It also records every read hint and
source/mapping DONTNEED call with applicability, host support, success, and
errno, plus point-in-time file residency after hash/inspection, after the AOT
archive mapping has been released, and immediately after source eviction.
Compatibility mode retains the exact already-open original carrier descriptor
when activation uses a streamed or reflink snapshot, advises the carrier source
and private activation snapshot separately, and reports both outcomes. It does
not relabel private-snapshot eviction as original-source eviction. Direct mode
has one inode, so snapshot eviction is explicitly not applicable.
Linux residency probes use a separate `PROT_NONE` mapping and `mincore(2)`;
they do not read payload bytes or inspect active CodeMemory mappings, regardless
of whether those mappings are anonymous compatibility memory or strict
regular-file-backed RX/RO memory.
The archive-release checkpoint is explicitly not applicable to memory images;
their row instead carries the DONTNEED outcome from the verified image mapping.

After the complete WASIX process tree is quiescent, the same executor appends
exactly one
`oliphaunt.wasix-postmaster.attested-start-runtime-summary.v1` row for each
loaded `(pid,module)` memory image. Terminal means the root status, execution
leases, pending child publications, and every process in the admitted epoch have
all joined; publishing a root exit status alone is insufficient. Summary rows
bind memory-image schema `oliphaunt.wasix-postmaster.memory-image.v2`, proof and
proof-output SHA-256, mapped size, ordinary-start/fresh/nonfresh counts,
comparison/reuse/remap outcomes and compared/skipped bytes. They appear after
their matching mapping row and are never emitted for an image that was not
loaded.

Qualification requires paired AOT and preinitialized-memory rows for every
expected fresh executable launch, `mapping_bytes_hashed == logical_bytes`, zero
source and snapshot writes, zero sync calls, successful supported advice,
well-formed measured Linux residency, `write_policy == none-immutable-source`,
and exact mode `direct-immutable-inode`. A successful advisory call is not a
claim that every page was reclaimed: the post-advice mincore counts are the
evidence, and may remain nonzero when the kernel retains or another mapping
uses clean pages.

The authority for the combined stream is
`oliphaunt.wasix-postmaster.sealed-loader-audit-validation.v3`. For every
preinitialized activation it requires exactly one terminal summary and:

```text
ordinary starts = fresh + nonfresh
validations = ordinary starts
full compare attempts = full compare successes + failures = 1
validations = compare attempts + reuse successes + reuse failures
reuse successes = ordinary starts - 1
compared bytes = mapped size * compare successes
skipped bytes = mapped size * reuse successes
remap successes + failures = compare successes + reuse successes
remap successes = ordinary starts
```

`nonfresh`, comparison/reuse/remap failures, and counter overflow must all be
zero. The validator also binds the mapping and summary module/proof/layout data
to the exact final `oliphaunt.wasix-postmaster.sealed-aot.v5` format-6
manifest. A mapping-only v2 audit is incomplete evidence and cannot satisfy a
v3 qualification gate.

The checkpoint lane counts its whole campaign rather than accepting one lucky
launch: two fresh WASIX initdb/postmaster pairs per ABBA/BAAB block, plus one
initdb and two postmasters for the standalone recycle lane when enabled.

## Crash recovery and trust assumptions

Receipt publication precedes carrier mutation, so the receipt is the recovery
journal. A failure while applying flags rolls completed transitions back. If a
host or process dies in the middle, rerun `--remove` with the same exact paths;
removal accepts receipt-bound inodes in either recorded pre-state or immutable
post-state. It also accepts an already-cleared receipt immutable bit, covering
a crash after that step but before unlink.

The helper anchors carrier traversal at a no-follow root descriptor, opens the
complete closure relative to directory descriptors, compares device/inode
identity, and retains descriptors through the flag transition. This closes
ordinary symlink and leaf replacement races. The wrappers canonicalize ancestor
paths before entering the helper, and final receipt unlink is pathname-based.
Therefore the receipt parent and carrier ancestors are a trusted boundary;
hostile privileged rename/replacement is unsupported. This is a local research
deployment, not a hostile-root-race or release-grade claim.

Never give the runtime or benchmark process root or `CAP_LINUX_IMMUTABLE` merely
to make deployment convenient. Deployment is a separate privileged phase;
execution is deliberately unprivileged and read-only.
