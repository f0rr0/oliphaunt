use std::path::PathBuf;

use oliphaunt::{Extension, Oliphaunt, QueryResult};
use serde::{Deserialize, Serialize};
use serde::ser::Serializer;
use tauri::Manager;
use tokio::sync::Mutex;

const SCHEMA: &str = r#"
CREATE EXTENSION IF NOT EXISTS hstore;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;

CREATE TABLE IF NOT EXISTS todos (
    id bigserial PRIMARY KEY,
    title text NOT NULL,
    notes text NOT NULL DEFAULT '',
    tags hstore NOT NULL DEFAULT ''::hstore,
    done boolean NOT NULL DEFAULT false,
    priority integer NOT NULL DEFAULT 2 CHECK (priority BETWEEN 1 AND 3),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS todos_title_trgm
    ON todos USING gin (title gin_trgm_ops);
"#;

const SELECT_TODOS: &str = r#"
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
"#;

const RETURNING_TODO: &str = r#"
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
"#;

struct TodoStore {
    db: Mutex<Oliphaunt>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateTodo {
    title: String,
    notes: String,
    area: String,
    context: String,
    priority: i32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Todo {
    id: i64,
    title: String,
    notes: String,
    area: String,
    context: String,
    priority: i32,
    done: bool,
    created_at: String,
    updated_at: String,
}

#[derive(Debug, thiserror::Error)]
enum CommandError {
    #[error("{0}")]
    Runtime(String),
}

impl serde::Serialize for CommandError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

impl From<anyhow::Error> for CommandError {
    fn from(value: anyhow::Error) -> Self {
        Self::Runtime(format!("{value:#}"))
    }
}

impl From<oliphaunt::Error> for CommandError {
    fn from(value: oliphaunt::Error) -> Self {
        Self::Runtime(value.to_string())
    }
}

async fn open_database(root: PathBuf) -> anyhow::Result<Oliphaunt> {
    let db = Oliphaunt::builder()
        .path(root)
        .native_direct()
        .extensions([Extension::Hstore, Extension::PgTrgm, Extension::Unaccent])
        .open()
        .await?;
    db.execute(SCHEMA).await?;
    Ok(db)
}

#[tauri::command]
async fn list_todos(
    state: tauri::State<'_, TodoStore>,
    search: String,
    status: String,
) -> Result<Vec<Todo>, CommandError> {
    let db = state.db.lock().await;
    let result = db.query_params(SELECT_TODOS, [search, status]).await?;
    todos_from_result(&result).map_err(CommandError::from)
}

#[tauri::command]
async fn create_todo(
    state: tauri::State<'_, TodoStore>,
    input: CreateTodo,
) -> Result<Todo, CommandError> {
    let db = state.db.lock().await;
    let priority = input.priority.clamp(1, 3).to_string();
    let sql = format!(
        "INSERT INTO todos (title, notes, tags, priority)
         VALUES ($1, $2, hstore(ARRAY['area', $3, 'context', $4]), $5::integer)
         {RETURNING_TODO}"
    );
    let result = db
        .query_params(
            &sql,
            [input.title, input.notes, input.area, input.context, priority],
        )
        .await?;
    one_todo(&result).map_err(CommandError::from)
}

#[tauri::command]
async fn toggle_todo(state: tauri::State<'_, TodoStore>, id: i64) -> Result<Todo, CommandError> {
    let db = state.db.lock().await;
    let sql = format!(
        "UPDATE todos
         SET done = NOT done, updated_at = now()
         WHERE id = $1
         {RETURNING_TODO}"
    );
    let result = db.query_params(&sql, [id]).await?;
    one_todo(&result).map_err(CommandError::from)
}

#[tauri::command]
async fn delete_todo(state: tauri::State<'_, TodoStore>, id: i64) -> Result<(), CommandError> {
    let db = state.db.lock().await;
    db.query_params("DELETE FROM todos WHERE id = $1 RETURNING id::text AS id", [id])
        .await?;
    Ok(())
}

fn todos_from_result(result: &QueryResult) -> anyhow::Result<Vec<Todo>> {
    (0..result.row_count()).map(|row| todo_from_result(result, row)).collect()
}

fn one_todo(result: &QueryResult) -> anyhow::Result<Todo> {
    todo_from_result(result, 0)
}

fn todo_from_result(result: &QueryResult, row: usize) -> anyhow::Result<Todo> {
    Ok(Todo {
        id: required(result, row, "id")?.parse()?,
        title: required(result, row, "title")?.to_owned(),
        notes: required(result, row, "notes")?.to_owned(),
        area: required(result, row, "area")?.to_owned(),
        context: required(result, row, "context")?.to_owned(),
        priority: required(result, row, "priority")?.parse()?,
        done: required(result, row, "done")? == "true",
        created_at: required(result, row, "created_at")?.to_owned(),
        updated_at: required(result, row, "updated_at")?.to_owned(),
    })
}

fn required<'a>(result: &'a QueryResult, row: usize, column: &str) -> anyhow::Result<&'a str> {
    result
        .get_text(row, column)?
        .ok_or_else(|| anyhow::anyhow!("missing {column}"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let root = app.path().app_data_dir()?.join("oliphaunt-native-todos");
            let db = tauri::async_runtime::block_on(open_database(root))?;
            app.manage(TodoStore { db: Mutex::new(db) });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_todos,
            create_todo,
            toggle_todo,
            delete_todo
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
