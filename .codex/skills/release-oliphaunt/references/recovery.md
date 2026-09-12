# Release recovery

## Failed or partial publish

1. Freeze further publication and save the workflow URL, candidate SHA,
   publication lock, receipts, and registry responses. Save the complete
   checkpoint chain only when first-identity bootstrap was running.
2. For bootstrap, validate every checkpoint digest and previous-checkpoint
   link. Confirm the source SHA/tree, lock/catalog digests, package envelope,
   and selected products are unchanged. Never hand-edit or truncate the chain.
3. Query every expected identity and GitHub tag/release. Classify it as absent, present-and-byte-matching, or conflicting. An existence-only response is not matching evidence.
4. Keep the candidate source and bytes unchanged. Product or packaging fixes
   require a new candidate and qualification. For a publication-only fix, the
   controller allowlist may authorize a new current-main workflow to publish
   the original candidate using explicit `release_commit` and `approval_run_id`.
5. For normal publication, use GitHub's rerun on the original Release run; it
   re-inventories the complete lock and publishes only identities still absent
   after byte verification. For bootstrap, use the failed job's reported rerun
   command after any not-before delay. It reinstalls the same approved candidate
   and resumes in dependency order from its newest validated checkpoint, using
   one sequential Cargo lane and one sequential npm lane with cross-lane
   dependency barriers and canonical checkpoint appends.
6. Seal bootstrap only after every identity in its immutable absent-name scope has a receipt. Existing names outside that scope remain mandatory normal-publication work. Promote draft GitHub releases only after the final all-registry receipt proof and exact-lock anonymous public-consumer probes produce their deterministic receipt-bound evidence. Retry a transient visibility failure only from a fresh cache under the original shared deadline; do not retry an exact identity/source/closure mismatch. Swift remains a source-tag/manifest probe before promotion because draft binary-target assets are not anonymously public. npm's normal tag is attached by its immutable version publish because OIDC does not authorize a later dist-tag mutation.

### Normal publish retry

Normal recovery is an exact-commit rerun, not a new recovery commit:

1. Use GitHub's rerun for the original failed root `publish` run at the same
   release commit and approved publication candidate. Do not create a fresh
   dispatch after `main` moves. The original run and every referenced candidate
   artifact must remain available.
2. Re-inventory every selected Cargo/npm/Maven identity and GitHub
   tag/release/asset. Skip an existing item only after its bytes and metadata
   match the lock.
3. Publish or stage only missing state. Any mismatch stops the release.
4. For a publication-only controller fix, dispatch `publish` with the original
   source SHA and candidate run ID. A failed prior run is accepted only if its
   candidate preparation job succeeded; active or cancelled runs are rejected.
   Product, packaging, CI, or lockfile changes require fresh qualification.
