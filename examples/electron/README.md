# Electron Native Todo

Electron owns the Oliphaunt TypeScript SDK in the main process and exposes a
small IPC surface to the renderer through preload. The app calls
`Oliphaunt.openServer` with persistent storage under Electron's user data
directory and owns the returned server handle. The explicit Electron E2E smoke
also exercises the optional `@oliphaunt/tools` facade with a schema-only
`pg_dump` and a non-interactive `psql` query; ordinary application startup does
not run PostgreSQL client tools.

```sh
pnpm --dir examples/electron install
pnpm --dir examples/electron start
```
