import * as React from "react";
import composer from "../ui/Composer.module.less";
import { ChatMessage, TodoItem, TodoStatus, ToolCall } from "../types";
import ChevronRightIcon from "../assets/icon-chevron-right.svg";

interface TodoProgressDockProps {
  messages: ChatMessage[];
  isGenerating: boolean;
}

type DisplayTodoStatus = TodoStatus | "transferred";
type DisplayTodoItem = Omit<TodoItem, "status"> & { status: DisplayTodoStatus };

export interface TodoSnapshot {
  id: string;
  todos: DisplayTodoItem[];
  activeTodo: DisplayTodoItem | null;
  completed: number;
  total: number;
  isRunning: boolean;
}

const TODO_STATUS_LABELS: Record<DisplayTodoStatus, string> = {
  pending: "等待中",
  in_progress: "执行中",
  completed: "已完成",
  cancelled: "已取消",
  transferred: "已跳转",
};

const TODO_STATUS_ICON_CLASS: Record<TodoStatus, string> = {
  pending: composer.todoDockStatusIconpending,
  in_progress: composer.todoDockStatusIconinProgress,
  completed: composer.todoDockStatusIconcompleted,
  cancelled: composer.todoDockStatusIconcancelled,
};

const safeParseJson = (value: string) => {
  if (!value) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
};

const normalizeTodoStatus = (value: unknown): TodoStatus => {
  const status = String(value || "pending") as TodoStatus;
  return status === "in_progress" || status === "completed" || status === "cancelled" ? status : "pending";
};

const getTodoSnapshot = (toolCall: ToolCall, resultMessage?: ChatMessage): TodoSnapshot | null => {
  if (toolCall.function.name !== "updateTodoList") return null;

  const args = safeParseJson(toolCall.function.arguments) as any;
  const result = safeParseJson(resultMessage?.content || "") as any;
  const rawTodos = Array.isArray(result?.todos) ? result.todos : Array.isArray(args?.todos) ? args.todos : [];
  const todos = rawTodos
    .map((todo: any, index: number) => ({
      id: String(todo?.id || `todo-${index}`),
      title: String(todo?.title || "").trim(),
      status: result?.transferred && todo?.status === "transferred" ? "transferred" : normalizeTodoStatus(todo?.status),
    }))
    .filter((todo: DisplayTodoItem) => todo.title);

  if (!todos.length) return null;

  const activeTodo = todos.find((todo) => todo.status === "in_progress") || null;
  const completed = todos.filter((todo) => todo.status === "completed").length;

  return {
    id: toolCall.id,
    todos,
    activeTodo,
    completed,
    total: todos.length,
    isRunning: !resultMessage || Boolean(activeTodo),
  };
};

export const getLatestTodoSnapshot = (messages: ChatMessage[]) => {
  const lastUserIndex = Math.max(
    0,
    messages.reduce((lastIndex, message, index) => (message.role === "user" ? index : lastIndex), -1),
  );
  const latestTurnMessages = messages.slice(lastUserIndex);
  const toolResults = latestTurnMessages.filter((message) => message.role === "tool");
  let latestSnapshot: TodoSnapshot | null = null;

  latestTurnMessages.forEach((message) => {
    if (message.role !== "assistant" || !message.tool_calls?.length) return;

    message.tool_calls.forEach((toolCall) => {
      const resultMessage = toolResults.find((item) => item.tool_call_id === toolCall.id);
      const snapshot = getTodoSnapshot(toolCall, resultMessage);
      if (snapshot) {
        latestSnapshot = snapshot;
      }
    });
  });

  return latestSnapshot;
};

const TodoDockStatusIcon = ({ status, running }: { status: DisplayTodoStatus; running?: boolean }) => {
  const normalizedStatus = status === "transferred" ? "cancelled" : status;
  const statusClass = running ? composer.todoDockStatusIconRunning : TODO_STATUS_ICON_CLASS[normalizedStatus];

  return (
    <span className={[composer.todoDockStatusIcon, statusClass].filter(Boolean).join(" ")}>
      {running ? "" : status === "completed" ? "✓" : status === "cancelled" ? "×" : ""}
    </span>
  );
};

export const TodoProgressDock: React.FC<TodoProgressDockProps> = ({ messages, isGenerating }) => {
  const latestSnapshot = React.useMemo(() => getLatestTodoSnapshot(messages), [messages]);
  const [expanded, setExpanded] = React.useState(false);

  React.useEffect(() => {
    setExpanded(false);
  }, [latestSnapshot?.activeTodo?.id]);

  if (!latestSnapshot || (!isGenerating && !latestSnapshot.activeTodo)) {
    return null;
  }

  const activeTodo = latestSnapshot.activeTodo;
  const headerStatus: DisplayTodoStatus = activeTodo?.status || (latestSnapshot.isRunning ? "in_progress" : "completed");
  const headerTitle = activeTodo?.title || `${latestSnapshot.completed}/${latestSnapshot.total} 已完成`;
  const isRunning = headerStatus === "in_progress" && Boolean(latestSnapshot.isRunning || activeTodo);

  return (
    <div className={`${composer.todoDock} ${expanded ? composer.todoDockExpanded : ""}`}>
      <button
        type="button"
        className={composer.todoDockHeader}
        onClick={() => setExpanded((previous) => !previous)}
        aria-expanded={expanded}
      >
        <TodoDockStatusIcon status={headerStatus} running={isRunning} />
        <span className={composer.todoDockTitle}>{headerTitle}</span>
        <span className={composer.todoDockMeta}>
          {latestSnapshot.completed}/{latestSnapshot.total}
        </span>
        <span className={`${composer.todoDockChevron} ${expanded ? composer.todoDockChevronExpanded : ""}`}>
          <ChevronRightIcon aria-hidden="true" />
        </span>
      </button>
      <div
        className={`${composer.todoDockBody} ${expanded ? composer.todoDockBodyExpanded : ""}`}
        aria-hidden={!expanded}
      >
        <div className={composer.todoDockBodyInner}>
          {latestSnapshot.todos.map((todo) => {
            const runningTodo = todo.status === "in_progress";
            return (
              <div
                key={todo.id}
                className={[
                  composer.todoDockItem,
                  runningTodo ? composer.todoDockItemRunning : "",
                  todo.status === "completed" ? composer.todoDockItemCompleted : "",
                  todo.status === "cancelled" ? composer.todoDockItemCancelled : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
              >
                <TodoDockStatusIcon status={todo.status} running={runningTodo} />
                <span>{todo.title}</span>
                <em>{TODO_STATUS_LABELS[todo.status]}</em>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};
