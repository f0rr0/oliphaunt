import { join } from "node:path";

import pg from "pg";
import type { CreateTodoInput, StatusFilter, Todo } from "./types.js";
import { startWasixSidecar, type WasixSidecar } from "./sidecar.js";

const { Pool } = pg;

const schemaStatements = [
  "CREATE EXTENSION IF NOT EXISTS hstore",
  "CREATE EXTENSION IF NOT EXISTS pg_trgm",
  "CREATE EXTENSION IF NOT EXISTS unaccent",
  `CREATE TABLE IF NOT EXISTS todos (
    id bigserial PRIMARY KEY,
    title text NOT NULL,
    notes text NOT NULL DEFAULT '',
    tags hstore NOT NULL DEFAULT ''::hstore,
    done boolean NOT NULL DEFAULT false,
    priority integer NOT NULL DEFAULT 2 CHECK (priority BETWEEN 1 AND 3),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  "CREATE INDEX IF NOT EXISTS todos_title_trgm ON todos USING gin (title gin_trgm_ops)",
];

const selectTodos = `
SELECT
  id,
  title,
  notes,
  COALESCE(tags -> 'area', '') AS area,
  COALESCE(tags -> 'context', '') AS context,
  done,
  priority,
  to_char(created_at, 'YYYY-MM-DD HH24:MI') AS created_at,
  to_char(updated_at, 'YYYY-MM-DD HH24:MI') AS updated_at
FROM todos
WHERE
  (
    $1::text = ''
    OR unaccent(title || ' ' || notes) ILIKE '%' || unaccent($1::text) || '%'
    OR COALESCE(tags -> 'area', '') ILIKE '%' || $1::text || '%'
    OR COALESCE(tags -> 'context', '') ILIKE '%' || $1::text || '%'
    OR tags ? $1::text
  )
  AND (
    $2::text = 'all'
    OR ($2::text = 'open' AND NOT done)
    OR ($2::text = 'done' AND done)
  )
ORDER BY done ASC, priority ASC, updated_at DESC, id DESC
`;

const returningTodo = `
RETURNING
  id,
  title,
  notes,
  COALESCE(tags -> 'area', '') AS area,
  COALESCE(tags -> 'context', '') AS context,
  done,
  priority,
  to_char(created_at, 'YYYY-MM-DD HH24:MI') AS created_at,
  to_char(updated_at, 'YYYY-MM-DD HH24:MI') AS updated_at
`;

type Store = {
  pool: pg.Pool;
  sidecar: WasixSidecar;
};

let storePromise: Promise<Store> | undefined;

async function getStore(userData: string) {
  storePromise ??= openStore(userData);
  return storePromise;
}

async function openStore(userData: string): Promise<Store> {
  const sidecar = await startWasixSidecar(join(userData, "oliphaunt-wasix-todos"));
  const pool = new Pool({
    connectionString: sidecar.databaseUrl,
    max: 1,
  });
  for (const statement of schemaStatements) {
    await pool.query(statement);
  }
  return { pool, sidecar };
}

export async function listTodos(
  userData: string,
  filter: { search: string; status: StatusFilter },
) {
  const { pool } = await getStore(userData);
  const result = await pool.query(selectTodos, [filter.search, filter.status]);
  return result.rows.map(todoFromRow);
}

export async function createTodo(userData: string, input: CreateTodoInput) {
  const { pool } = await getStore(userData);
  const result = await pool.query(
    `INSERT INTO todos (title, notes, tags, priority)
     VALUES ($1, $2, hstore(ARRAY['area', $3, 'context', $4]), $5)
     ${returningTodo}`,
    [input.title, input.notes, input.area, input.context, clampPriority(input.priority)],
  );
  return oneTodo(result.rows);
}

export async function toggleTodo(userData: string, id: number) {
  const { pool } = await getStore(userData);
  const result = await pool.query(
    `UPDATE todos SET done = NOT done, updated_at = now() WHERE id = $1 ${returningTodo}`,
    [id],
  );
  return oneTodo(result.rows);
}

export async function deleteTodo(userData: string, id: number) {
  const { pool } = await getStore(userData);
  await pool.query("DELETE FROM todos WHERE id = $1", [id]);
}

export async function closeStore() {
  if (!storePromise) return;
  const store = await storePromise;
  await store.pool.end();
  store.sidecar.process.kill();
}

function oneTodo(rows: unknown[]) {
  if (rows.length === 0) throw new Error("todo was not returned");
  return todoFromRow(rows[0] as pg.QueryResultRow);
}

function todoFromRow(row: pg.QueryResultRow): Todo {
  return {
    id: Number(row.id),
    title: String(row.title),
    notes: String(row.notes),
    area: String(row.area),
    context: String(row.context),
    priority: Number(row.priority),
    done: Boolean(row.done),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function clampPriority(value: number) {
  return Math.min(Math.max(Math.trunc(value) || 2, 1), 3);
}
