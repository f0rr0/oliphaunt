---
name: add-oliphaunt-extension
description: Add, update, promote, or remove an Oliphaunt PostgreSQL contrib or external extension, including source pins, build recipes, explicit target support, evidence, SDK metadata, release products, carrier identities, and package verification. Use whenever extension catalog, compatibility, packaging, or supported OS/runtime claims change.
---

# Add Oliphaunt Extension

Make support claims fail closed. A runtime target existing does not prove an extension supports that target.

## Classify

- contrib: source is PostgreSQL 18. The SQL member belongs to the single
  `oliphaunt-extension-contrib-pg18` distribution product at
  `src/extensions/contrib/`; that product is `runtime-bound` and is linked to
  both liboliphaunt runtimes. A contrib member does not own a leaf `VERSION`,
  changelog, `release.toml`, tag, or registry identity.
- external: source uses an immutable upstream commit, packaging versioning is `upstream-bound`, and runtime versions are compatibility metadata rather than release coupling.
- blocked: keep it out of promoted/public catalogs and record the concrete blocker.

Keep the SQL extension name distinct from the release product id and upstream project name.

## Implement

1. Add or update source pins, checksums, patches/dependency recipes, and Moon
   metadata. For an external extension, also maintain its product-local
   `release.toml`, `VERSION`, and empty first-release `CHANGELOG.md`. For a
   contrib member, update the canonical `postgres18.toml` inventory and the
   shared contrib product metadata; never create leaf release state. Check
   whether the upstream project operates an authoritative HTTPS Git mirror.
   When it does, record that reviewed endpoint as `mirror_url` and prove that
   it serves the exact pinned commit; never infer a mirror or use a community
   fork merely for availability.
2. Declare every supported and intentionally unsupported carrier in `targets/artifacts.toml`. Include evidence references; never rely on derived defaults.
3. Declare the stable Cargo façade plus native, mobile, WASIX portable/AOT, npm,
   and Maven carriers actually required by the owning release product. Contrib
   members use the shared bundle carriers and retain exact nested member
   paths/checksums; external extensions use their independent carriers. Let
   size-required Cargo package parts remain dynamic implementation carriers.
4. Regenerate the shared extension model:

```sh
tools/dev/bun.sh src/extensions/tools/check-extension-model.mjs --write
cargo run -p xtask -- assets verify-committed
```

If and only if the verification reports that source pins, patches, recipes,
compiler inputs, or binary producer code changed, refresh it with
`cargo run -p xtask -- assets input-fingerprint --write` and then verify again.
Version, changelog, registry coordinate, and `targets/artifacts.toml` edits are
package-envelope changes and must leave it unchanged. `--write-evidence`
regenerates claims only; it never creates or updates an observed passing run.

5. Verify the model and release graph:

```sh
tools/dev/bun.sh src/extensions/tools/check-extension-model.mjs --check
tools/dev/bun.sh tools/release/release-check.mjs
```

When source acquisition or `mirror_url` changes, also run the source-fetch
fault suite, validate the real manifest, and perform one live exact-commit
fetch from each newly declared endpoint. The canonical upstream must remain
the durable origin and every transport must resolve to the same immutable pin.

6. Build the exact extension artifacts for all declared published targets. Require package-shape, archive safety, checksums, runtime load/create, restart, and dump/restore evidence where the target contract promises them. The exact-SHA CI lane must run `src/extensions/tools/collect-wasix-evidence.sh` against portable and host-AOT artifacts from that same workflow run. Only that collector may record `wasix-full-lifecycle-v1`; its immutable record must identify the exact commit, tree, workflow run, attempt, and job, and qualification must pass `--require-current-evidence`.
7. Run a clean local-registry install for each ecosystem façade. For a contrib
   bundle, select at least two members and prove that only those nested members
   are staged even though one target carrier contains all contrib bytes. Also
   combine one contrib member with an independently versioned external member.
   Confirm target selection fetches only the expected carriers and an
   unsupported target fails with a useful error.

## Review

Reject the change if a declared target lacks a produced artifact/evidence row, an actual package lacks a declared identity, an external extension is runtime-version-coupled, or generated SDK support tables disagree. Report upstream source identity separately from Oliphaunt package version.
