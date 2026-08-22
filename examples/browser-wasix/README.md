# Browser WASIX

This example runs the WASIX TypeScript binding directly in a browser or in a
Web Worker and demonstrates IndexedDB and OPFS persistence.

Build the WASIX runtime assets, then run:

```sh
pnpm --dir src/bindings/wasix-ts dev
```

The browser smoke and benchmark commands in `src/bindings/wasix-ts/package.json`
use the same example so there is only one browser integration surface to keep
current.
