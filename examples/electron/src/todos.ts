import { join } from "node:path";

import { Oliphaunt, type OliphauntDatabase, type QueryResult } from "@oliphaunt/ts";
import type { CreateTodoInput, StatusFilter, Todo } from "./types.js";

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
  id::text AS id,
  title,
  notes,
  COALESCE(tags -> 'area', '') AS area,
  COALESCE(tags -> 'context', '') AS context,
  done::text AS done,
  priority::text AS priority,
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
  id::text AS id,
  title,
  notes,
  COALESCE(tags -> 'area', '') AS area,
  COALESCE(tags -> 'context', '') AS context,
  done::text AS done,
  priority::text AS priority,
  to_char(created_at, 'YYYY-MM-DD HH24:MI') AS created_at,
  to_char(updated_at, 'YYYY-MM-DD HH24:MI') AS updated_at
`;

let dbPromise: Promise<OliphauntDatabase> | undefined;

export function getDatabase(userData: string) {
  dbPromise ??= openDatabase(userData);
  return dbPromise;
}

async function openDatabase(userData: string) {
  const db = await Oliphaunt.open({
    engine: "nativeBroker",
    root: join(userData, "oliphaunt-native-todos"),
    extensions: ["hstore", "pg_trgm", "unaccent"],
  });
  for (const statement of schemaStatements) {
    await db.execute(statement);
  }
  return db;
}

export async function listTodos(
  userData: string,
  filter: { search: string; status: StatusFilter },
) {
  const db = await getDatabase(userData);
  const result = await db.query(selectTodos, [filter.search, filter.status]);
  return todosFromResult(result);
}

export async function createTodo(userData: string, input: CreateTodoInput) {
  const db = await getDatabase(userData);
  const result = await db.query(
    `INSERT INTO todos (title, notes, tags, priority)
     VALUES ($1, $2, hstore(ARRAY['area', $3, 'context', $4]), $5)
     ${returningTodo}`,
    [input.title, input.notes, input.area, input.context, clampPriority(input.priority)],
  );
  return oneTodo(result);
}

export async function toggleTodo(userData: string, id: number) {
  const db = await getDatabase(userData);
  const result = await db.query(
    `UPDATE todos SET done = NOT done, updated_at = now() WHERE id = $1 ${returningTodo}`,
    [id],
  );
  return oneTodo(result);
}

export async function deleteTodo(userData: string, id: number) {
  const db = await getDatabase(userData);
  await db.query("DELETE FROM todos WHERE id = $1", [id]);
}

export async function closeDatabase() {
  if (!dbPromise) return;
  const db = await dbPromise;
  await db.close();
}

function todosFromResult(result: QueryResult) {
  return Array.from({ length: result.rowCount }, (_, index) => todoFromResult(result, index));
}

function oneTodo(result: QueryResult) {
  if (result.rowCount === 0) throw new Error("todo was not returned");
  return todoFromResult(result, 0);
}

function todoFromResult(result: QueryResult, row: number): Todo {
  return {
    id: Number(required(result, row, "id")),
    title: required(result, row, "title"),
    notes: required(result, row, "notes"),
    area: required(result, row, "area"),
    context: required(result, row, "context"),
    priority: Number(required(result, row, "priority")),
    done: required(result, row, "done") === "true",
    createdAt: required(result, row, "created_at"),
    updatedAt: required(result, row, "updated_at"),
  };
}

function required(result: QueryResult, row: number, column: string) {
  const value = result.getText(row, column);
  if (value === null) throw new Error(`missing ${column}`);
  return value;
}

function clampPriority(value: number) {
  return Math.min(Math.max(Math.trunc(value) || 2, 1), 3);
}
