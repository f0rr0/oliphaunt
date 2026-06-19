# Oliphaunt Node Direct Runtime

`oliphaunt-node-direct` owns the Node-API adapter that lets the TypeScript SDK
call the native `liboliphaunt` runtime without compiling native code during a
normal application install.

Published consumer packages are platform-specific optional npm packages:

- `@oliphaunt/node-direct-darwin-arm64`
- `@oliphaunt/node-direct-linux-x64-gnu`
- `@oliphaunt/node-direct-linux-arm64-gnu`
- `@oliphaunt/node-direct-win32-x64-msvc`

The TypeScript SDK selects the matching optional package when present and falls
back to verified GitHub release assets for release validation and local tests.
