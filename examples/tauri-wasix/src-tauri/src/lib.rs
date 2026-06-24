use std::path::PathBuf;
use std::time::Duration;

use anyhow::{Context, Result};
use oliphaunt_wasix::{extensions, OliphauntServer};
use serde::{Deserialize, Serialize};
use serde::ser::Serializer;
use sqlx::postgres::PgPoolOptions;
use sqlx::{PgPool, Row};
use tauri::Manager;
use tokio::sync::Mutex;

const CREATE_EXTENSIONS: &[&str] = &[
    "CREATE EXTENSION IF NOT EXISTS hstore",
    "CREATE EXTENSION IF NOT EXISTS pg_trgm",
    "CREATE EXTENSION IF NOT EXISTS unaccent",
];

const CREATE_TABLE: &str = r#"
CREATE TABLE IF NOT EXISTS todos (
    id bigserial PRIMARY KEY,
    title text NOT NULL,
    notes text NOT NULL DEFAULT '',
    tags hstore NOT NULL DEFAULT ''::hstore,
    done boolean NOT NULL DEFAULT false,
    priority integer NOT NULL DEFAULT 2 CHECK (priority BETWEEN 1 AND 3),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
)
"#;

const CREATE_INDEX: &str = "CREATE INDEX IF NOT EXISTS todos_title_trgm ON todos USING gin (title gin_trgm_ops)";

const SELECT_TODOS: &str = r#"
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
"#;

const RETURNING_TODO: &str = r#"
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
"#;

struct TodoStore {
    inner: Mutex<TodoDatabase>,
}

struct TodoDatabase {
    pool: PgPool,
    _server: OliphauntServer,
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

impl From<sqlx::Error> for CommandError {
    fn from(value: sqlx::Error) -> Self {
        Self::Runtime(value.to_string())
    }
}

async fn open_database(root: PathBuf) -> Result<TodoDatabase> {
    let server = OliphauntServer::builder()
        .path(root)
        .extensions([extensions::HSTORE, extensions::PG_TRGM, extensions::UNACCENT])
        .start()
        .context("start oliphaunt-wasix server")?;
    let pool = PgPoolOptions::new()
        .max_connections(1)
        .acquire_timeout(Duration::from_secs(30))
        .connect(&server.connection_uri())
        .await
        .context("connect SQLx pool to oliphaunt-wasix server")?;
    init_schema(&pool).await?;
    Ok(TodoDatabase {
        pool,
        _server: server,
    })
}

async fn init_schema(pool: &PgPool) -> Result<()> {
    for statement in CREATE_EXTENSIONS {
        sqlx::query(statement).execute(pool).await?;
    }
    sqlx::query(CREATE_TABLE).execute(pool).await?;
    sqlx::query(CREATE_INDEX).execute(pool).await?;
    Ok(())
}

#[tauri::command]
async fn list_todos(
    state: tauri::State<'_, TodoStore>,
    search: String,
    status: String,
) -> Result<Vec<Todo>, CommandError> {
    let db = state.inner.lock().await;
    let rows = sqlx::query(SELECT_TODOS)
        .bind(search)
        .bind(status)
        .fetch_all(&db.pool)
        .await?;
    rows.into_iter()
        .map(|row| todo_from_row(&row).map_err(CommandError::from))
        .collect()
}

#[tauri::command]
async fn create_todo(
    state: tauri::State<'_, TodoStore>,
    input: CreateTodo,
) -> Result<Todo, CommandError> {
    let db = state.inner.lock().await;
    let sql = format!(
        "INSERT INTO todos (title, notes, tags, priority)
         VALUES ($1, $2, hstore(ARRAY['area', $3, 'context', $4]), $5)
         {RETURNING_TODO}"
    );
    let row = sqlx::query(&sql)
        .bind(input.title)
        .bind(input.notes)
        .bind(input.area)
        .bind(input.context)
        .bind(input.priority.clamp(1, 3))
        .fetch_one(&db.pool)
        .await?;
    todo_from_row(&row).map_err(CommandError::from)
}

#[tauri::command]
async fn toggle_todo(state: tauri::State<'_, TodoStore>, id: i64) -> Result<Todo, CommandError> {
    let db = state.inner.lock().await;
    let sql = format!(
        "UPDATE todos SET done = NOT done, updated_at = now() WHERE id = $1 {RETURNING_TODO}"
    );
    let row = sqlx::query(&sql).bind(id).fetch_one(&db.pool).await?;
    todo_from_row(&row).map_err(CommandError::from)
}

#[tauri::command]
async fn delete_todo(state: tauri::State<'_, TodoStore>, id: i64) -> Result<(), CommandError> {
    let db = state.inner.lock().await;
    sqlx::query("DELETE FROM todos WHERE id = $1")
        .bind(id)
        .execute(&db.pool)
        .await?;
    Ok(())
}

fn todo_from_row(row: &sqlx::postgres::PgRow) -> Result<Todo> {
    Ok(Todo {
        id: row.try_get("id")?,
        title: row.try_get("title")?,
        notes: row.try_get("notes")?,
        area: row.try_get("area")?,
        context: row.try_get("context")?,
        priority: row.try_get("priority")?,
        done: row.try_get("done")?,
        created_at: row.try_get("created_at")?,
        updated_at: row.try_get("updated_at")?,
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let root = app.path().app_data_dir()?.join("oliphaunt-wasix-todos");
            let db = tauri::async_runtime::block_on(open_database(root))?;
            app.manage(TodoStore {
                inner: Mutex::new(db),
            });
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
