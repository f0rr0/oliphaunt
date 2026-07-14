# Maintainer documentation

Status: index. Last verified: 2026-07-14. Owner: repository maintainers.

Executable configuration is authoritative. Documentation explains intent and operation; it must not invent workflow names, package identities, targets, or release state. When prose conflicts with the sources below, fix the prose in the same change.

| Topic | Maintainer entry point | Executable source |
| --- | --- | --- |
| Release products, versions, tags, and recovery | `release.md` | `release-please-config.json`, `.release-please-manifest.json`, product `release.toml`, `tools/release/publication-catalog.mjs`, `.github/scripts/manage-release-drafts.mjs` |
| Registry and GitHub environment setup | `release-setup.md` | `.github/workflows/release.yml`, `.github/workflows/release-execute.yml`, `tools/release/check_publish_environment.mjs` |
| CI gates and test selection | `testing.md`, `tooling.md` | `.github/workflows/ci.yml`, `tools/graph/ci_plan.mjs`, Moon project files |
| Binary artifacts and WASIX provenance | `assets.md`, `compiler-caching.md` | runtime target metadata, `tools/xtask`, the committed binary-semantic fingerprint |
| Extension support and packaging | `extension-packaging-policy.md` | extension catalog, product `targets/artifacts.toml`, evidence matrix, release catalog |
| SDK contracts | `sdk-products-policy.md`, `sdk-parity-policy.md`, `sdk-api-surface.md` | SDK manifests, package manifests, generated extension metadata, clean-consumer tests |
| Repository layout | `repo-structure.md` | Moon graph and build/package manifests |

The repository-local skills under `.codex/skills/` are the procedural entry points for agents. They route release, qualification, and extension work to executable checks and these focused references.

`consumer-dx-release-blueprint.md` is archived design history. Files under `docs/internal/` are implementation history, investigations, or evidence snapshots unless a current maintainer document links to a specific section. They are not policy and must not be used to override the executable sources above.

When changing a workflow or contract:

1. update the executable source and behavior tests;
2. update the relevant maintainer entry point and its verified date;
3. regenerate derived tables instead of hand-editing them;
4. avoid policy assertions that depend on YAML step order, display text, or helper filenames unless the string itself is an external API.
