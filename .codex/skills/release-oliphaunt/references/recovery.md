# Release and history recovery

## Failed or partial publish

1. Freeze further publication and save the workflow URL, candidate SHA, publication lock, complete checkpoint chain, and registry responses.
2. Validate every checkpoint digest and previous-checkpoint link. Confirm the source SHA/tree, lock/catalog digests, package envelope, and selected products are unchanged. Never hand-edit or truncate the chain.
3. Query every expected identity and GitHub tag/release. Classify it as absent, present-and-byte-matching, or conflicting. An existence-only response is not matching evidence.
4. Fix only the failed phase. Requalify a new commit if repository code/configuration changes; never attach old artifacts or a prior ledger to it.
5. Resume in dependency order from the newest validated checkpoint. Re-inventory the complete exact lock first: a carrier accepted before an ambiguous response or checkpoint interruption is recovery input, not permission to upload again. Skip it only after its registry checksum/SRI/payload/file manifest matches the frozen bytes. Bootstrap resumes with one sequential Cargo lane and one sequential npm lane, preserves cross-lane dependency barriers, and serializes canonical checkpoint appends.
6. Seal bootstrap only after every expected identity has a receipt. Promote draft GitHub releases only after the final all-registry receipt proof and exact-lock anonymous public-consumer probes produce their deterministic receipt-bound evidence. Retry a transient visibility failure only from a fresh cache under the original shared deadline; do not retry an exact identity/source/closure mismatch. Swift remains a source-tag/manifest probe before promotion because draft binary-target assets are not anonymously public. npm's normal tag is attached by its immutable version publish because OIDC does not authorize a later dist-tag mutation.

## Pre-publication main-history repair

This path is forbidden after any affected product tag/package is public.

1. Freeze main and verify the exact old tip. Create an archive ref and offline bundle.
2. Build the desired tree on a temporary branch and qualify it before touching main.
3. Create one tree-identical introduction commit on the intended stable parent. Put one generated release-bump commit above it.
4. Temporarily allow only the minimum force-push authority. Push with `--force-with-lease=<main>:<recorded-old-sha>`.
5. Immediately restore branch protection, require pull requests/checks, and disable force-push.
6. Qualify the new introduction SHA. Prepare, review, and qualify the release commit. Publish only that exact SHA.

Do not automate repository-setting changes or the force-push without explicit maintainer authorization at execution time.
