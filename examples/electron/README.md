# Electron Native Todo

Electron owns the Oliphaunt TypeScript SDK in the main process and exposes a
small IPC surface to the renderer through preload. The app calls
`Oliphaunt.openServer` with persistent storage under Electron's user data
directory and owns the returned server handle.

```sh
pnpm --dir examples/electron install
pnpm --dir examples/electron start
```
