# Electron Native Todo

Electron owns the Oliphaunt TypeScript SDK in the main process and exposes a
small IPC surface to the renderer through preload. The app uses `nativeServer`
mode with a persistent root under Electron's user data directory.

```sh
examples/tools/with-local-registries.sh pnpm --dir examples/electron install
examples/tools/with-local-registries.sh pnpm --dir examples/electron start
```
