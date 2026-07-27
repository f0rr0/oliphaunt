import type { CreateTodoInput, StatusFilter, Todo, TodoApi } from "./types";

declare global {
  interface Window {
    todos: TodoApi;
  }
}

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
  todos = await window.todos.listTodos({
    search: search?.value.trim() ?? "",
    status: activeStatus,
  });
  render();
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
  checkbox.addEventListener("change", () => {
    void window.todos.toggleTodo(todo.id).then(listTodos).catch((error) => setStatus(String(error)));
  });

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
  remove.addEventListener("click", () => {
    void window.todos.deleteTodo(todo.id).then(listTodos).catch((error) => setStatus(String(error)));
  });

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
  window.todos
    .createTodo(input)
    .then(() => {
      form.reset();
      setStatus("Saved");
      return listTodos();
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
