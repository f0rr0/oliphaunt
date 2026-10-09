# Browser WASIX

This example exercises both public execution surfaces: the direct caller-realm
root entrypoint and the explicit package-owned `/worker` entrypoint. It also
demonstrates IndexedDB and OPFS persistence and verifies that the root
constructs no hidden Worker.

Build the runtime and the independently selected standard seed, then start the example:

```sh
moon run liboliphaunt-wasix:runtime-portable database-resources:build-wasix-standard
bun run --cwd src/wasix/sdks/ts dev
```

`resources.ts` selects the seed served by the local asset middleware to speed up
initialization. Without a seed, new browser storage runs the runtime's `initdb`.
Reopening IndexedDB or OPFS needs only the runtime.

The browser smoke and benchmark commands in `src/wasix/sdks/ts/package.json`
use the same example so there is only one browser integration surface to keep
current.
