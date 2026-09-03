# Release tooling

This directory owns cross-product release planning, immutable candidate
validation, registry publication, and release-asset assembly. Product build and
package-shape logic stays with the product that ships it.

Primary entrypoints:

- `release-check.mjs`: exact candidate metadata and mutation checks;
- `release-publish.mjs`: protected registry publication;
- `release-verify.mjs`: post-publication verification;
- `release-graph.mjs`: released-product and carrier relationships; and
- `sdk-artifacts/`: SDK-specific artifact staging adapters.

Keep tests beside the module they exercise. Do not add generic helpers here
when `tools/dev`, `tools/policy`, or `tools/test` already owns the concern.
Existing underscore-named workflow entrypoints remain stable paths; rename or
split a domain only when doing so creates an independent ownership, import, or
task boundary.
