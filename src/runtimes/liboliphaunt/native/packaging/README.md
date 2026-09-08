# Native packaging tools

This unpublished workspace crate owns maintainer-only native runtime-resource,
extension-artifact, and extension-index packaging. It is used by release and
platform-package automation; application code must use the published
`oliphaunt` and `oliphaunt-build` crates instead.

The three binaries retain their established command names:

- `oliphaunt-resources`
- `oliphaunt-extension-artifact`
- `oliphaunt-extension-index`

The crate reads the generated extension catalog and does not maintain a second
extension inventory.
