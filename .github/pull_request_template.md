## Summary

## Release Intent

- [ ] Package/API/runtime change: PR title uses `feat:`, `fix:`, `perf:`, `refactor:`, `revert:`, or a breaking `!`.
- [ ] Docs/CI/repository-only change: no release intended.
- [ ] Asset/source-spine change: source pins/fingerprints are current and the Assets workflow will generate/test release artifacts.

## Verification

- [ ] `tools/scripts/validate.sh repo`
- [ ] `tools/scripts/validate.sh artifacts`
- [ ] `tools/scripts/validate.sh lint`
- [ ] `tools/scripts/validate.sh test`
- [ ] `tools/scripts/validate.sh package` when published package contents changed
- [ ] `cargo deny check`
