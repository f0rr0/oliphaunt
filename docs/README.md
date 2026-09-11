# Oliphaunt documentation

The site at oliphaunt.dev contains latest-product guides, maintained on main.
It has no documentation-version archives or SDK API generation dependencies.
Authored SDK API maps remain ordinary guides.

From this directory after installing the root Bun workspace:

- `bun run dev`: prepare content and start Next.js.
- `bun run check`: check internal links and TypeScript.
- `bun run test`: exercise published-release selection and refresh-request handling.
- `bun run build`: resolve fresh completed releases and export the site.
- `bun run smoke`: check exported routes and text endpoints.

Published versions come from GitHub's completed, non-prerelease product releases,
never the Release Please candidate manifest. Unreleased resource and package
separation examples carry an explicit development label; remove that label only
after the corresponding products are publicly available. Kotlin's plugin and library use
the same product version. SDK packages own their compatible runtime dependencies;
guides do not independently select a newer runtime.

Each preparation resolves GitHub metadata anew and fails on network errors.
For an explicit offline build set `OLIPHAUNT_DOCS_RELEASES_FILE` to a previously
resolved `target/docs/published-releases.json` (absolute path recommended), or
a fixture containing GitHub release records. This is an opt-in snapshot, not
automatic stale fallback. `GITHUB_TOKEN` is optional for GitHub rate limits.

Vercel should build main for documentation changes, and rebuild once after an
entire product release operation has finalized. Build from this project with
`bun run build`; the export is `out` and the repository qualification copy
is `target/docs/build`. Deployment-hook credentials and actual deployment
status monitoring are release-integration responsibilities. No remote Vercel
configuration is changed by local builds.

## Release-triggered refresh: request wiring only

After the complete `publish` job successfully promotes a nonempty public release batch, the Release workflow runs a separate
`Request docs refresh` job in the `Production` environment. It sends one POST,
retains the returned job receipt, and explicitly reports that deployment success
is unverified. A failed refresh does not rerun registry publication. Retry only
the docs job after inspecting Vercel; an ambiguous HTTP failure may already have
queued a deployment, so the command does not automatically retry POST requests.

Read-only GitHub inspection on 2026-09-11 confirmed Vercel-managed Preview and
Production deployments. Neither the repository nor its Production environment
had a docs hook secret. The Vercel project settings were not accessible.
External prerequisites still required:

- Create/select one deploy hook for the oliphaunt.dev project targeting `main`;
  store its URL as `VERCEL_DOCS_DEPLOY_HOOK` in GitHub's protected `Production`
  environment, with deployment restricted to `main`.
- Confirm Vercel's project root is `docs`, its build command is
  `bun run build`, and output is `out`. Root workspace files and the extension
  catalog must remain accessible. Installation must use the pinned root Bun
  lockfile. Normal Git deployments should follow docs inputs; hook-triggered
  builds must not be skipped merely because the source commit is unchanged.
- Inspect the real Vercel deployment corresponding to a hook request and verify
  its successful production promotion and live published versions. The hook's
  documented response supplies a job ID, not a deployment ID or a documented
  job-status API. An unrelated deployment, newer timestamp, or accepted POST
  must not count as proof. Correlation and protection against an older build
  replacing newer guides still need implementation/verification against the
  actual project configuration.

Task 23a remains partial until those prerequisites and deployment verification
are complete. No metadata endpoint or guessed provider API is used to claim
completion. See [Vercel's deploy-hook contract](https://vercel.com/docs/deploy-hooks).
