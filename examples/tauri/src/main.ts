import { invoke } from "@tauri-apps/api/core";

type Todo = {
  id: number;
  title: string;
  notes: string;
  area: string;
  context: string;
  priority: number;
  done: boolean;
  createdAt: string;
  updatedAt: string;
};

type CreateTodoInput = {
  title: string;
  notes: string;
  area: string;
  context: string;
  priority: number;
};

type StatusFilter = "open" | "all" | "done";

const form = document.querySelector<HTMLFormElement>("#todo-form");
const list = document.querySelector<HTMLElement>("#todo-list");
const status = document.querySelector<HTMLOutputElement>("#status");
const search = document.querySelector<HTMLInputElement>("#search");
const openCount = document.querySelector<HTMLOutputElement>("#open-count");
const doneCount = document.querySelector<HTMLOutputElement>("#done-count");
const highCount = document.querySelector<HTMLOutputElement>("#high-count");
let activeStatus: StatusFilter = "open";
let todos: Todo[] = [];

async function listTodos() {
  todos = await invoke<Todo[]>("list_todos", {
    search: search?.value.trim() ?? "",
    status: activeStatus,
  });
  render();
}

async function createTodo(input: CreateTodoInput) {
  await invoke<Todo>("create_todo", { input });
  await listTodos();
}

async function toggleTodo(id: number) {
  await invoke<Todo>("toggle_todo", { id });
  await listTodos();
}

async function deleteTodo(id: number) {
  await invoke("delete_todo", { id });
  await listTodos();
}

function setStatus(message: string) {
  if (status) status.value = message;
}

function priorityLabel(priority: number) {
  if (priority === 1) return "High";
  if (priority === 3) return "Low";
  return "Normal";
}

function render() {
  const open = todos.filter((todo) => !todo.done).length;
  const done = todos.filter((todo) => todo.done).length;
  const high = todos.filter((todo) => !todo.done && todo.priority === 1).length;
  if (openCount) openCount.value = `${open} open`;
  if (doneCount) doneCount.value = `${done} done`;
  if (highCount) highCount.value = `${high} high priority`;
  if (!list) return;
  if (todos.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "No todos match the current filter.";
    list.replaceChildren(empty);
    return;
  }
  list.replaceChildren(...todos.map(renderTodo));
}

function renderTodo(todo: Todo) {
  const row = document.createElement("article");
  row.className = todo.done ? "todo done" : "todo";

  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.checked = todo.done;
  checkbox.addEventListener("change", () => void toggleTodo(todo.id));

  const body = document.createElement("div");
  const title = document.createElement("h2");
  title.textContent = todo.title;
  const notes = document.createElement("p");
  notes.textContent = todo.notes || "No notes";
  const meta = document.createElement("div");
  meta.className = "meta";
  for (const value of [
    priorityLabel(todo.priority),
    todo.area ? `area:${todo.area}` : "",
    todo.context ? `context:${todo.context}` : "",
    `updated ${todo.updatedAt}`,
  ]) {
    if (!value) continue;
    const pill = document.createElement("span");
    pill.className = "pill";
    pill.textContent = value;
    meta.append(pill);
  }
  body.append(title, notes, meta);

  const remove = document.createElement("button");
  remove.className = "secondary";
  remove.type = "button";
  remove.textContent = "Delete";
  remove.addEventListener("click", () => void deleteTodo(todo.id));

  row.append(checkbox, body, remove);
  return row;
}

form?.addEventListener("submit", (event) => {
  event.preventDefault();
  const data = new FormData(form);
  const input: CreateTodoInput = {
    title: String(data.get("title") ?? "").trim(),
    notes: String(data.get("notes") ?? "").trim(),
    area: String(data.get("area") ?? "").trim(),
    context: String(data.get("context") ?? "").trim(),
    priority: Number(data.get("priority") ?? 2),
  };
  if (!input.title) return;
  setStatus("Saving");
  createTodo(input)
    .then(() => {
      form.reset();
      setStatus("Saved");
    })
    .catch((error) => setStatus(String(error)));
});

search?.addEventListener("input", () => {
  void listTodos().catch((error) => setStatus(String(error)));
});

document.querySelectorAll<HTMLButtonElement>("[data-status]").forEach((button) => {
  button.addEventListener("click", () => {
    activeStatus = button.dataset.status as StatusFilter;
    document
      .querySelectorAll<HTMLButtonElement>("[data-status]")
      .forEach((candidate) => candidate.classList.toggle("active", candidate === button));
    void listTodos().catch((error) => setStatus(String(error)));
  });
});

void listTodos().catch((error) => setStatus(String(error)));
