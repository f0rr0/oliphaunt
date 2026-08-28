# Oliphaunt Node Direct Runtime

`oliphaunt-node-direct` owns the Node-API adapter that lets the TypeScript SDK
call the native `liboliphaunt` runtime without compiling native code during a
normal application install.

Published consumer packages are platform-specific optional npm packages:

- `@oliphaunt/node-direct-darwin-arm64`
- `@oliphaunt/node-direct-linux-x64-gnu`
- `@oliphaunt/node-direct-linux-arm64-gnu`
- `@oliphaunt/node-direct-win32-x64-msvc`

The TypeScript SDK selects the matching optional package. Missing packages fail
with an install-time action instead of downloading runtime assets.

Native database calls run on addon-owned background threads and return to
JavaScript through bounded Node-API thread-safe-function bridges. Environment
cleanup first aborts those JavaScript delivery bridges and waits only for a
producer already inside Node-API to observe that abort. An asynchronous reaper
then cancels the resident backend, waits for every registered native call
(including one whose thread has not started yet), and terminally closes only
the generation owned by that environment. It marshals final cleanup-hook
removal back to Node's event-loop thread. Cleanup never waits for a promise
completion or runs PostgreSQL teardown on Node's environment thread.
