# Release tooling

This directory owns cross-product release planning, frozen candidate verification,
and registry publication. Builds, package preparation and product tests live
with their owning projects.

The normal workflow has two operations: prepare the release PR, then publish its
qualified candidate. Publication freezes package bytes, handles missing registry
identities when needed, and resumes from verified receipts.

Local entrypoints:

- `bash tools/release/release-check.sh`: release metadata and release/policy tests.
- `bash tools/release/release-check-registries.sh --products-json '["oliphaunt-js"]' --head-ref HEAD`:
  read-only registry preflight for the selected products.
- `bash tools/release/verify-product-tags.sh`: exact release-commit tag checks.
- `bash tools/release/package-release-carriers.sh --products-json '["oliphaunt-broker"]'`:
  assemble the selected products' registry packages from staged runtime assets.
- `bash tools/release/release-verify.sh`: post-publication verification.
- `tools/release/release-publish.mts`: protected publication controller.
- `bash tools/release/qualified-release-replay.sh HEAD COMMIT_SHA`: verify a clean
  source checkout matches the exact candidate before assembly.

Product and carrier relationships live in `tools/release/`.
Each SDK owns its artifact staging under its own `tools/` directory. Keep tests
beside the implementation they exercise; Shell runs external commands and
TypeScript reads, transforms, and validates data.
