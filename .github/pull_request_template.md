## Summary

## Release Intent

- [ ] Package/API/runtime change: PR title uses `feat:`, `fix:`, `perf:`, `refactor:`, `revert:`, or a breaking `!`.
- [ ] Docs/CI/repository-only change: no release intended.
- [ ] Asset/source-spine change: source pins/fingerprints are current and the Assets workflow will generate/test release artifacts.

## Verification

- [ ] `scripts/validate.sh repo`
- [ ] `scripts/validate.sh artifacts`
- [ ] `scripts/validate.sh lint`
- [ ] `scripts/validate.sh test`
- [ ] `scripts/validate.sh package` when published package contents changed
- [ ] `cargo deny check`
