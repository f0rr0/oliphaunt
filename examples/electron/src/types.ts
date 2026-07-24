export type Todo = {
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

export type CreateTodoInput = {
  title: string;
  notes: string;
  area: string;
  context: string;
  priority: number;
};

export type StatusFilter = "open" | "all" | "done";

export type TodoApi = {
  listTodos(filter: { search: string; status: StatusFilter }): Promise<Todo[]>;
  createTodo(input: CreateTodoInput): Promise<Todo>;
  toggleTodo(id: number): Promise<Todo>;
  deleteTodo(id: number): Promise<void>;
};
