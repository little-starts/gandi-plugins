import { TodoItem, TodoStatus } from "./types";

let currentTodos: TodoItem[] = [];

const TODO_STATUSES = new Set<TodoStatus>(["pending", "in_progress", "completed", "cancelled"]);

const normalizeStatus = (status: unknown): TodoStatus => {
  const normalized = String(status || "pending") as TodoStatus;
  return TODO_STATUSES.has(normalized) ? normalized : "pending";
};

const createTodoId = (index: number) => `todo-${Date.now()}-${index}`;

export const updateTodoList = (items: Array<Partial<TodoItem>> = []) => {
  const todos = items
    .map((item, index) => ({
      id: String(item.id || currentTodos[index]?.id || createTodoId(index)),
      title: String(item.title || "").trim(),
      status: normalizeStatus(item.status),
    }))
    .filter((item) => item.title);

  currentTodos = todos;
  const completed = todos.filter((item) => item.status === "completed").length;
  const active = todos.find((item) => item.status === "in_progress") || null;

  return {
    success: true,
    todos,
    activeTodo: active,
    completed,
    total: todos.length,
    summary: active ? active.title : todos.length > 0 ? `${completed}/${todos.length} 已完成` : "没有待办任务",
  };
};

export const listCurrentTodos = () => ({
  success: true,
  todos: currentTodos,
  activeTodo: currentTodos.find((item) => item.status === "in_progress") || null,
  completed: currentTodos.filter((item) => item.status === "completed").length,
  total: currentTodos.length,
});
