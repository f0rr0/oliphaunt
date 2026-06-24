import { join } from "node:path";

import { Kysely, PostgresDialect, sql, type Generated } from "kysely";
import pg from "pg";

import { startWasixSidecar, type WasixSidecar } from "./sidecar.js";
import type { CreateTodoInput, StatusFilter, Todo } from "./types.js";

const { Pool } = pg;

type TodoTable = {
  id: Generated<string>;
  title: string;
  notes: string;
  tags: string;
  done: Generated<string>;
  priority: number;
  created_at: Generated<string>;
  updated_at: Generated<string>;
};

type TodoDatabase = {
  todos: TodoTable;
};

type TodoRecord = {
  id: string;
  title: string;
  notes: string;
  area: string;
  context: string;
  done: string;
  priority: string;
  created_at: string;
  updated_at: string;
};

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

type Store = {
  db: Kysely<TodoDatabase>;
  sidecar: WasixSidecar;
};

let storePromise: Promise<Store> | undefined;

async function getStore(userData: string) {
  storePromise ??= openStore(userData);
  return storePromise;
}

async function openStore(userData: string): Promise<Store> {
  const sidecar = await startWasixSidecar(join(userData, "oliphaunt-wasix-todos"));
  const db = new Kysely<TodoDatabase>({
    dialect: new PostgresDialect({
      pool: new Pool({
        connectionString: sidecar.databaseUrl,
        max: 1,
      }),
    }),
  });
  for (const statement of schemaStatements) {
    await sql.raw(statement).execute(db);
  }
  return { db, sidecar };
}

export async function listTodos(
  userData: string,
  filter: { search: string; status: StatusFilter },
) {
  const { db } = await getStore(userData);
  const rows = await db
    .selectFrom("todos")
    .select(todoColumns)
    .where(searchPredicate(filter.search))
    .where(statusPredicate(filter.status))
    .orderBy("done", "asc")
    .orderBy("priority", "asc")
    .orderBy("updated_at", "desc")
    .orderBy("id", "desc")
    .execute();
  return rows.map(todoFromRow);
}

export async function createTodo(userData: string, input: CreateTodoInput) {
  const { db } = await getStore(userData);
  const row = await db
    .insertInto("todos")
    .values({
      title: input.title,
      notes: input.notes,
      tags: sql`hstore(ARRAY['area', ${input.area}, 'context', ${input.context}])`,
      priority: clampPriority(input.priority),
    })
    .returning(todoColumns)
    .executeTakeFirstOrThrow();
  return todoFromRow(row);
}

export async function toggleTodo(userData: string, id: number) {
  const { db } = await getStore(userData);
  const row = await db
    .updateTable("todos")
    .set({
      done: sql`NOT done`,
      updated_at: sql`now()`,
    })
    .where("id", "=", String(id))
    .returning(todoColumns)
    .executeTakeFirstOrThrow();
  return todoFromRow(row);
}

export async function deleteTodo(userData: string, id: number) {
  const { db } = await getStore(userData);
  await db.deleteFrom("todos").where("id", "=", String(id)).execute();
}

export async function closeStore() {
  if (!storePromise) return;
  const store = await storePromise;
  await store.db.destroy();
  store.sidecar.process.kill();
  storePromise = undefined;
}

function todoColumns() {
  return [
    sql<string>`id::text`.as("id"),
    "title",
    "notes",
    sql<string>`COALESCE(tags -> 'area', '')`.as("area"),
    sql<string>`COALESCE(tags -> 'context', '')`.as("context"),
    sql<string>`done::text`.as("done"),
    sql<string>`priority::text`.as("priority"),
    sql<string>`to_char(created_at, 'YYYY-MM-DD HH24:MI')`.as("created_at"),
    sql<string>`to_char(updated_at, 'YYYY-MM-DD HH24:MI')`.as("updated_at"),
  ] as const;
}

function searchPredicate(search: string) {
  return sql<boolean>`(
    ${search}::text = ''
    OR unaccent(title || ' ' || notes) ILIKE '%' || unaccent(${search}::text) || '%'
    OR COALESCE(tags -> 'area', '') ILIKE '%' || ${search}::text || '%'
    OR COALESCE(tags -> 'context', '') ILIKE '%' || ${search}::text || '%'
    OR tags ? ${search}::text
  )`;
}

function statusPredicate(status: StatusFilter) {
  return sql<boolean>`(
    ${status}::text = 'all'
    OR (${status}::text = 'open' AND NOT done)
    OR (${status}::text = 'done' AND done)
  )`;
}

function todoFromRow(row: TodoRecord): Todo {
  return {
    id: Number(row.id),
    title: row.title,
    notes: row.notes,
    area: row.area,
    context: row.context,
    priority: Number(row.priority),
    done: row.done === "true",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function clampPriority(value: number) {
  return Math.min(Math.max(Math.trunc(value) || 2, 1), 3);
}
