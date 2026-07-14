---
name: qualify-oliphaunt-change
description: Select, run, and diagnose Oliphaunt local and GitHub CI qualification for code, package, extension, SDK, policy, workflow, or release changes. Use before merge/release, when checks are slow or duplicated, or when an exact commit must be proven publishable.
---

# Qualify Oliphaunt Change

Use the repository graph to select work, but require the full exact-SHA gate for releases.

## Local feedback

1. Inspect the diff and ask Moon for affected projects/tasks. Do not infer affected products from directory names alone.
2. Run formatting/static checks and focused unit/package tests first. Run expensive producer/E2E lanes only when their inputs or release contract changed.
3. For any release, package identity, workflow, version, or extension change, run:

```sh
tools/dev/bun.sh tools/release/release-check.mjs
cargo run -p xtask -- assets verify-committed
tools/dev/bun.sh src/extensions/tools/check-extension-model.mjs --check
```

4. Use `actionlint` for workflow changes. Validate shell/JS/Python syntax before waiting for CI.

## GitHub qualification

- Identify runs by workflow plus exact `headSha`; never accept “latest successful on branch.”
- The release prerequisite is the non-cancelled `Qualified` gate for that SHA, including required checks, builds, policy, tests, and selected E2E.
- When WASIX or an extension is selected, require the same-run full lifecycle evidence artifact. It must cover every promoted extension in direct, server, restart, materialization, and dump/restore modes and satisfy `--require-current-evidence` for the candidate source digest.
- Ensure artifact attestations and the publication lock reference the same SHA/tree.
- Do not rerun duplicate downstream E2E workflows when the same evidence is already part of the required gate.
- On failure, inspect the failing job log and earliest causal error. Fix the cause, push a new SHA, and restart qualification; do not reuse artifacts from the failed SHA.

## Report

List commands and outcomes, skipped lanes with reasons, exact GitHub run/SHA, required gate state, produced artifact/lock evidence, WASIX lifecycle evidence when selected, and residual platform gaps. “Green CI” without exact-SHA and gate names is not release evidence.
