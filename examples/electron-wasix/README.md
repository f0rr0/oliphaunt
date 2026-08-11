# Electron WASIX Todo

Electron keeps WASIX in a Rust sidecar. The sidecar starts
`OliphauntServer`, prints a local PostgreSQL URL, and stays alive until
Electron exits. The Electron main process uses `pg` with a single connection
and exposes the same preload API as the native Electron example.

```sh
pnpm --dir examples/electron-wasix install
pnpm --dir examples/electron-wasix start
```

For packaged apps, build the `src-wasix` binary and set
`OLIPHAUNT_WASIX_TODO_SIDECAR` to its path before launching Electron.
