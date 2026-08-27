# Browser WASIX

This example exercises both public calling contracts: the normal package-owned
Worker entrypoint and the explicit caller-realm `/blocking` entrypoint. It also
demonstrates IndexedDB and OPFS persistence and verifies that `/blocking`
constructs no hidden Worker.

Build the WASIX runtime assets, then run:

```sh
pnpm --dir src/bindings/wasix-ts dev
```

The browser smoke and benchmark commands in `src/bindings/wasix-ts/package.json`
use the same example so there is only one browser integration surface to keep
current.
