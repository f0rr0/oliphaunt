# oliphaunt-broker-linux-arm64-gnu

Cargo artifact crate for the `linux-arm64-gnu` `oliphaunt-broker` helper
binary. Applications do not depend on this crate directly; `oliphaunt` selects
it for matching Cargo targets.

The complete Oliphaunt Linux GNU surface is qualified at glibc 2.38 with a
`GLIBCXX_3.4.30` ceiling. This target ID is an ABI contract, not a claim of
support for every Linux distribution.
