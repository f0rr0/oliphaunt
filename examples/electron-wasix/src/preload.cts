import { contextBridge, ipcRenderer } from "electron";
import type { CreateTodoInput, StatusFilter, TodoApi } from "./types.js";

const api: TodoApi = {
  listTodos(filter: { search: string; status: StatusFilter }) {
    return ipcRenderer.invoke("todos:list", filter);
  },
  createTodo(input: CreateTodoInput) {
    return ipcRenderer.invoke("todos:create", input);
  },
  toggleTodo(id: number) {
    return ipcRenderer.invoke("todos:toggle", id);
  },
  deleteTodo(id: number) {
    return ipcRenderer.invoke("todos:delete", id);
  },
};

contextBridge.exposeInMainWorld("todos", api);
