---
name: add-oliphaunt-extension
description: Add, update, or remove an Oliphaunt PostgreSQL contrib or external extension, including source pins, build recipes, target support, SDK metadata, release products, carrier identities, and package verification. Use whenever extension catalog, compatibility, packaging, or supported OS/runtime claims change.
---

# Add Oliphaunt Extension

Make support claims fail closed. A runtime target existing does not prove an extension supports that target.

## Classify

- contrib: source is PostgreSQL 18. The SQL member belongs to the single
  `oliphaunt-extension-contrib-pg18` distribution product at
  `src/extensions/contrib/`; that product is `runtime-bound` and is linked to
  both liboliphaunt runtimes. A contrib member does not own a leaf `VERSION`,
  changelog, `release.toml`, tag, or registry identity.
- external: source uses an immutable upstream commit, packaging versioning is `upstream-bound`, and runtime versions are compatibility metadata rather than release coupling. `release.toml` is the public-product boundary. Incomplete or blocked work stays on a branch and has no main-branch catalog state.

Keep the SQL extension name distinct from the release product id and upstream project name.

## Implement

1. Add or update source pins, checksums, patches/dependency recipes, and Moon
   metadata. For a public external extension, also maintain its product-local
   `release.toml`, `VERSION`, and empty first-release `CHANGELOG.md`. Every
   external extension must own
   `upstream-license-data.json` beside that metadata. Freeze exactly the source
   identities and license/notice rows used by that extension, include only the
   referenced content-addressed blobs, and audit those bytes against the clean
   pinned checkout. Never put independently versioned extensions into one
   shared legal-data file. For a contrib member, update the canonical `postgres18.toml` inventory and the
   shared contrib product metadata; never create leaf release state. Check
   whether the upstream project operates an authoritative HTTPS Git mirror.
   When it does, record that reviewed endpoint as `mirror_url` and prove that
   it serves the exact pinned commit; never infer a mirror or use a community
   fork merely for availability.
2. The canonical target profiles in `tools/release/extension-target-profiles.toml` apply to every extension on main. A target-specific exception is branch work until its format and shipped behavior are implemented together; do not add status, promotion, or blocker metadata.
3. For an active public product, declare the stable Cargo façade plus native,
   mobile, WASIX portable/AOT, npm, and Maven carriers actually required by the
   owning release product. Contrib members use the shared bundle carriers and
   retain exact nested member paths/checksums; public external extensions use
   their independent carriers. Let size-required Cargo package parts remain
   dynamic implementation carriers.
4. Regenerate the shared extension model:

```sh
tools/dev/bun.sh src/extensions/tools/check-extension-model.mjs --write
cargo run -p xtask -- assets verify-committed
```

Source-pin, patch, recipe, compiler-input, or producer-code changes require the
product-owned portable/AOT build. Version, changelog, registry coordinate, and
target-profile edits are package-envelope changes.

5. Verify the model and release graph:

```sh
tools/dev/bun.sh src/extensions/tools/check-extension-model.mjs --check
tools/dev/bun.sh tools/release/release-check.mjs
```

When source acquisition or `mirror_url` changes, also run the source-fetch
fault suite, validate the real manifest, and perform one live exact-commit
fetch from each newly declared endpoint. The canonical upstream must remain
the durable origin and every transport must resolve to the same immutable pin.

6. Build the exact extension artifacts for all declared targets. Require package-shape, archive safety, checksums, runtime load/create, restart, and dump/restore evidence where the target contract promises them. The exact-SHA CI lane must run `src/extensions/tools/collect-wasix-evidence.sh` against portable and host-AOT artifacts from that same workflow run. Only that collector may record `wasix-full-lifecycle-v1`; its immutable record must identify the exact commit, tree, workflow run, attempt, and job, and qualification must pass `--require-current-evidence`.
7. Run a clean local-registry install for each ecosystem façade. For a contrib
   bundle, select at least two members and prove that only those nested members
   are staged even though one target carrier contains all contrib bytes. Also
   combine one contrib member with an independently versioned external member.
   Confirm target selection fetches only the expected carriers and an
   unsupported target fails with a useful error. Verify each carrier's derived
   license and notice profile; a passing profile check is not legal advice or
   certification of comprehensive legal compliance.

## Review

Reject the change if a declared target lacks a produced artifact, an actual package lacks a declared identity, an external extension is runtime-version-coupled, or generated SDK metadata disagrees. Reject any promotion, blocker, deferred, planned, or unsupported extension state on main. Report upstream source identity separately from Oliphaunt package version.
