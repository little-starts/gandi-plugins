import * as React from "react";
import chat from "../ui/Chat.module.less";
import { Attachment, ChatMessage, ContextUsageInfo, SubAgentIconKey, SubAgentProfile, TodoItem, TodoStatus, ToolCall } from "../types";
import { ToolCallViewer } from "./ToolCallViewer";
import { AssistantMarkdown, serializeBlocksToPreviewSvg } from "./AssistantMarkdown";
import ChevronRightIcon from "../assets/icon-chevron-right.svg";
import CopyIcon from "../assets/icon-copy.svg";
import UndoIcon from "../assets/icon-undo.svg";
import { SubAgentIcon } from "../subAgentIcons";
import {
  FileReferenceRange,
  findAttachmentReferenceRanges,
  findGuideReferenceRanges,
  findSubAgentMentionRanges,
  renderMessageInlineNodes,
} from "../mentionUtils";
import type { GuideSummary } from "../guideRegistry";
import { findVirtualBlockLineReferenceRanges, ResolvedVirtualBlockLineReference, resolveVirtualBlockLineReference } from "../blockReferenceUtils";
import { ucfToScratch } from "../ucf";
import { getBlocksRangeBlockStates } from "../workspaceRangeTools";
import { scrollBlockIntoView } from "utils/block-helper";
import { BlockReferencePreviewDialog } from "./BlockReferencePreviewDialog";
import { createPortal } from "react-dom";

const RefreshIcon = (props: React.SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M16.4 8.2a6.5 6.5 0 1 0-1.7 6.3" />
    <path d="M16.5 4.5v3.8h-3.8" />
  </svg>
);

const CompressIcon = (props: React.SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M4 7h4V3" />
    <path d="M3.4 3.4 8 8" />
    <path d="M16 7h-4V3" />
    <path d="m16.6 3.4-4.6 4.6" />
    <path d="M4 13h4v4" />
    <path d="m3.4 16.6 4.6-4.6" />
    <path d="M16 13h-4v4" />
    <path d="m16.6 16.6-4.6-4.6" />
  </svg>
);

interface ChatAreaProps {
  messages: ChatMessage[];
  isGenerating: boolean;
  conversationMode: "chat" | "code";
  examplePrompts: string[];
  vm: PluginContext["vm"];
  blockly?: any;
  workspace?: Blockly.WorkspaceSvg;
  subAgents: SubAgentProfile[];
  guides: GuideSummary[];
  onOpenWorkspaceAttachment: (attachment: Attachment) => void;
  onPreviewAttachment: (attachment: Attachment) => void;
  onRestoreToUserMessage: (messageId: string, message: ChatMessage) => void;
  hasSnapshot: (messageId: string) => boolean;
  contextUsage: ContextUsageInfo;
  onRetryLastResponse: () => void;
  onCompressContext: () => void;
  isCompressingContext: boolean;
  onUseExamplePrompt?: (prompt: string) => void;
  onRequestOpenUrl?: (url: string, requiresConfirmation: boolean) => void;
}

type AssistantSegment =
  | { type: "text"; id: string; content: string }
  | {
      type: "reasoning";
      id: string;
      content: string;
      isComplete: boolean;
      startedAt?: number;
      endedAt?: number;
    }
  | { type: "tools"; id: string; toolCalls: ToolCall[]; toolResults: ChatMessage[] };

interface AssistantBubble {
  sourceMessage: ChatMessage;
  segments: AssistantSegment[];
}

interface ReasoningPanelState {
  collapsed: boolean;
  hasAutoCollapsed: boolean;
}

interface ChangeSummaryFile {
  path: string;
  added: number;
  deleted: number;
  operations: number;
}

interface ChangeSummary {
  files: ChangeSummaryFile[];
  added: number;
  deleted: number;
  operations: number;
}

type DisplayTodoStatus = TodoStatus | "transferred";
type DisplayTodoItem = Omit<TodoItem, "status"> & { status: DisplayTodoStatus };

interface TodoSnapshot {
  id: string;
  todos: DisplayTodoItem[];
  activeTodo: DisplayTodoItem | null;
  completed: number;
  total: number;
  isRunning: boolean;
}

type ToolSegment = Extract<AssistantSegment, { type: "tools" }>;
type InlineAssistantSegment = Exclude<AssistantSegment, ToolSegment>;

type ToolFlowNode = { type: "tools"; id: string; toolCalls: ToolCall[]; toolResults: ChatMessage[] };

type UserQuestionFlowNode = {
  type: "userQuestion";
  id: string;
  questions: Array<{ id: string; question: string; answer: string; isAnswered: boolean }>;
  isAnswered: boolean;
};

type SubAgentFlowNode = {
  type: "subAgent";
  id: string;
  name: string;
  task: string;
  summary: string;
  avatarBackground: string;
  avatarIcon: SubAgentIconKey;
  status: "running" | "completed" | "error" | "terminated";
  children: AssistantFlowNode[];
};

type TodoTaskFlowNode = {
  type: "todo";
  id: string;
  task: DisplayTodoItem;
  status: DisplayTodoStatus;
  snapshot: TodoSnapshot;
  children: Array<InlineAssistantSegment | ToolFlowNode | UserQuestionFlowNode | SubAgentFlowNode>;
};

type AssistantFlowNode =
  | InlineAssistantSegment
  | ToolFlowNode
  | TodoTaskFlowNode
  | UserQuestionFlowNode
  | SubAgentFlowNode;

const STICKY_BOTTOM_DISTANCE = 48;
const USER_MESSAGE_COLLAPSE_LENGTH = 160;
const USER_MESSAGE_PREVIEW_LENGTH = 180;
const USER_MESSAGE_COLLAPSE_ANIMATION_MS = 260;
const VIRTUAL_SCROLL_OVERSCAN_PX = 1400;
const VIRTUAL_ESTIMATED_MESSAGE_HEIGHT = 180;
const VIRTUAL_MESSAGE_GAP = 14;
const VIRTUAL_MIN_RENDER_COUNT = 8;

const isLongUserMessage = (content: string) =>
  content.length > USER_MESSAGE_COLLAPSE_LENGTH || content.replace(/\r\n?/g, "\n").split("\n").length > 1;

const getUserMessagePreview = (content: string) => {
  const normalized = content.replace(/\s+/g, " ").trim();
  if (!normalized) return "空消息";
  return normalized.length > USER_MESSAGE_PREVIEW_LENGTH
    ? `${normalized.slice(0, USER_MESSAGE_PREVIEW_LENGTH)}...`
    : normalized;
};

const getDisplayItemKey = (item: ChatMessage | AssistantBubble, index: number) =>
  "role" in item
    ? `message-${item.id || index}`
    : `assistant-${item.sourceMessage.id || index}`;

const getVirtualItemHeight = (heightByKey: Map<string, number>, item: ChatMessage | AssistantBubble, index: number) =>
  heightByKey.get(getDisplayItemKey(item, index)) || VIRTUAL_ESTIMATED_MESSAGE_HEIGHT;

const sumVirtualItemHeights = (
  items: Array<ChatMessage | AssistantBubble>,
  heightByKey: Map<string, number>,
  start: number,
  end: number,
) => {
  let total = 0;
  for (let index = start; index < end; index += 1) {
    total += getVirtualItemHeight(heightByKey, items[index], index);
  }
  return total;
};

const getVirtualSpacerHeight = (
  items: Array<ChatMessage | AssistantBubble>,
  heightByKey: Map<string, number>,
  start: number,
  end: number,
) => {
  const count = Math.max(0, end - start);
  if (!count) return 0;
  return sumVirtualItemHeights(items, heightByKey, start, end) + Math.max(0, count - 1) * VIRTUAL_MESSAGE_GAP;
};

const calculateVirtualRange = (
  items: Array<ChatMessage | AssistantBubble>,
  heightByKey: Map<string, number>,
  scrollTop: number,
  clientHeight: number,
) => {
  const total = items.length;
  if (total <= VIRTUAL_MIN_RENDER_COUNT * 2) {
    return { start: 0, end: total };
  }

  const viewportTop = Math.max(0, scrollTop - VIRTUAL_SCROLL_OVERSCAN_PX);
  const viewportBottom = Math.max(viewportTop, scrollTop + Math.max(clientHeight, 1) + VIRTUAL_SCROLL_OVERSCAN_PX);
  let offset = 0;
  let start = 0;
  let end = total;

  for (let index = 0; index < total; index += 1) {
    const itemHeight = getVirtualItemHeight(heightByKey, items[index], index);
    const itemBottom = offset + itemHeight;
    if (itemBottom >= viewportTop) {
      start = index;
      break;
    }
    offset = itemBottom + VIRTUAL_MESSAGE_GAP;
  }

  for (let index = start; index < total; index += 1) {
    const itemHeight = getVirtualItemHeight(heightByKey, items[index], index);
    const itemTop = offset;
    const itemBottom = itemTop + itemHeight;
    if (itemTop > viewportBottom) {
      end = index;
      break;
    }
    offset = itemBottom + VIRTUAL_MESSAGE_GAP;
  }

  if (end - start < VIRTUAL_MIN_RENDER_COUNT) {
    const missing = VIRTUAL_MIN_RENDER_COUNT - (end - start);
    start = Math.max(0, start - Math.ceil(missing / 2));
    end = Math.min(total, Math.max(end, start + VIRTUAL_MIN_RENDER_COUNT));
    start = Math.max(0, Math.min(start, end - VIRTUAL_MIN_RENDER_COUNT));
  }

  return { start, end };
};

const ReasoningChevron = ({ expanded }: { expanded: boolean }) => (
  <span
    style={{
      display: "inline-flex",
      transform: expanded ? "rotate(90deg)" : "rotate(0deg)",
      transition: "transform 0.2s ease",
    }}
  >
    <ChevronRightIcon aria-hidden="true" />
  </span>
);

const formatReasoningDuration = (startedAt?: number, endedAt?: number) => {
  if (!startedAt || !endedAt || endedAt < startedAt) {
    return "已思考";
  }

  return `已思考 ${((endedAt - startedAt) / 1000).toFixed(2)}s`;
};

const collectAssistantBubbles = (messages: ChatMessage[], isGenerating: boolean) => {
  const items: Array<ChatMessage | AssistantBubble> = [];
  const visibleMessages = messages.filter((message) => !message.hidden && message.kind !== "contextSummary");

  for (let index = 0; index < visibleMessages.length; index++) {
    const message = visibleMessages[index];
    if (message.kind === "compressionStatus") {
      items.push(message);
      continue;
    }

    if (message.role === "system" || message.role === "tool") {
      continue;
    }

    if (message.role === "assistant") {
      const segments: AssistantSegment[] = [];
      let cursor = index;

      while (cursor < visibleMessages.length && visibleMessages[cursor].role !== "user") {
        const currentMessage = visibleMessages[cursor];
        const segmentKey = currentMessage.id || String(cursor);

        if (currentMessage.role === "assistant") {
          const normalizedReasoning = currentMessage.reasoning?.trim() || "";
          const normalizedContent = currentMessage.content?.trim() || "";
          const hasReasoningContent = Boolean(normalizedReasoning);
          const hasTextContent = Boolean(normalizedContent);

          if (hasReasoningContent) {
            segments.push({
              type: "reasoning",
              id: `reasoning-${segmentKey}`,
              content: normalizedReasoning,
              isComplete: Boolean(normalizedContent || currentMessage.tool_calls?.length),
              startedAt: currentMessage.reasoningStartedAt,
              endedAt: currentMessage.reasoningEndedAt,
            });
          }

          if (
            !hasReasoningContent &&
            !hasTextContent &&
            !currentMessage.tool_calls?.length &&
            isGenerating &&
            cursor === visibleMessages.length - 1
          ) {
            segments.push({
              type: "reasoning",
              id: `reasoning-${segmentKey}`,
              content: "",
              isComplete: false,
              startedAt: currentMessage.reasoningStartedAt,
              endedAt: currentMessage.reasoningEndedAt,
            });
          }

          if (hasTextContent) {
            segments.push({
              type: "text",
              id: `text-${segmentKey}`,
              content: normalizedContent,
            });
          }

          if (currentMessage.tool_calls?.length) {
            const toolResults: ChatMessage[] = [];
            let resultCursor = cursor + 1;
            while (resultCursor < visibleMessages.length && visibleMessages[resultCursor].role === "tool") {
              toolResults.push(visibleMessages[resultCursor]);
              resultCursor++;
            }

            const previousSegment = segments[segments.length - 1];
            if (previousSegment?.type === "tools" && !hasTextContent) {
              previousSegment.toolCalls.push(...currentMessage.tool_calls);
              previousSegment.toolResults.push(...toolResults);
            } else {
              segments.push({
                type: "tools",
                id: `tools-${segmentKey}`,
                toolCalls: [...currentMessage.tool_calls],
                toolResults,
              });
            }
            cursor = resultCursor - 1;
          }
        }

        cursor++;
      }

      items.push({ sourceMessage: message, segments });
      index = cursor - 1;
      continue;
    }

    items.push(message);
  }

  return items;
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

const getTodoSnapshots = (toolCalls: ToolCall[], toolResults: ChatMessage[]): TodoSnapshot[] =>
  toolCalls
    .map((toolCall) => {
      if (toolCall.function.name !== "updateTodoList") return null;
      const resultMessage = toolResults.find((item) => item.tool_call_id === toolCall.id);
      const args = safeParseJson(toolCall.function.arguments) as any;
      const result = safeParseJson(resultMessage?.content || "") as any;
      const isTerminated = Boolean(result?.terminated || result?.cancelled);
      const rawTodos = Array.isArray(result?.todos) ? result.todos : Array.isArray(args?.todos) ? args.todos : [];
      const todos = rawTodos
        .map((todo: any, index: number) => ({
          id: String(todo?.id || `todo-${index}`),
          title: String(todo?.title || "").trim(),
          status:
            result?.transferred && todo?.status === "transferred"
              ? "transferred"
              : isTerminated && todo?.status === "in_progress"
                ? "cancelled"
                : normalizeTodoStatus(todo?.status),
        }))
        .filter((todo: DisplayTodoItem) => todo.title);
      const activeTodo = todos.find((todo) => todo.status === "in_progress") || null;
      const completed = todos.filter((todo) => todo.status === "completed").length;
      return {
        id: toolCall.id,
        todos,
        activeTodo,
        completed,
        total: todos.length,
        isRunning: !resultMessage || (!isTerminated && Boolean(activeTodo)),
      };
    })
    .filter(Boolean) as TodoSnapshot[];

const createUserQuestionFlowNode = (toolCall: ToolCall, resultMessage?: ChatMessage): UserQuestionFlowNode => {
  const args = safeParseJson(toolCall.function.arguments) as any;
  const result = safeParseJson(resultMessage?.content || "") as any;
  const rawQuestions = Array.isArray(args?.questions)
    ? args.questions
    : [{ id: "question-0", question: args?.question || result?.question || "需要补充信息" }];
  const rawAnswers = Array.isArray(result?.answers) ? result.answers : [];
  const questions = rawQuestions.map((item: any, index: number) => {
    const answer = rawAnswers[index];
    return {
      id: String(item?.id || `question-${index}`),
      question: String(item?.question || "需要补充信息").trim(),
      answer: String(answer?.answer || "").trim(),
      isAnswered: Boolean(String(answer?.answer || "").trim()),
    };
  });

  return {
    type: "userQuestion",
    id: `user-question-${toolCall.id}`,
    questions,
    isAnswered: questions.every((item) => item.isAnswered),
  };
};

const buildSubAgentFlowNode = (toolCall: ToolCall, resultMessage?: ChatMessage): SubAgentFlowNode => {
  const args = safeParseJson(toolCall.function.arguments) as any;
  const result = safeParseJson(resultMessage?.displayContent || resultMessage?.content || "") as any;
  const plainResult = !result && resultMessage?.content && !resultMessage.content.startsWith("Error:") ? resultMessage.content : "";
  const rawMessages = Array.isArray(result?.messages) ? (result.messages as ChatMessage[]) : [];
  const hasProgressPayload = rawMessages.length > 0 || result?.task || result?.name || result?.context || result?.successCriteria;
  const resolvedName = String(result?.name || args?.name || "").trim();
  const name = resolvedName || (!resultMessage || !resultMessage.content.trim() ? "准备调用..." : "子AI");
  const task = String(hasProgressPayload ? result?.task || args?.task || "子任务" : args?.task || "子任务").trim() || "子任务";
  const summary =
    String(
      resultMessage?.content?.startsWith("Error:")
        ? resultMessage.content
        : plainResult || result?.summary || result?.error || "子任务执行中...",
    ).trim() || "子任务执行中...";
  const status =
    !resultMessage || !resultMessage.content.trim()
      ? "running"
      : result?.terminated || result?.cancelled
        ? "terminated"
      : result?.completed === false
        ? "running"
        : resultMessage.content.startsWith("Error:") || result?.success === false
          ? "error"
          : "completed";

  const children = collectAssistantBubbles(rawMessages, false).reduce<AssistantFlowNode[]>((resultNodes, item) => {
    if ("role" in item) {
      return resultNodes;
    }
    resultNodes.push(...buildAssistantFlowNodes(item.segments));
    return resultNodes;
  }, []);

  return {
    type: "subAgent",
    id: `subagent-flow-${toolCall.id}`,
    name,
    task,
    summary,
    avatarBackground: String(result?.avatarBackground || "linear-gradient(135deg, #64748b, #a855f7)"),
    avatarIcon: (result?.avatarIcon || "robot") as SubAgentIconKey,
    status,
    children,
  };
};

const getSnapshotTodo = (snapshot: TodoSnapshot, todoId?: string | null) =>
  todoId ? snapshot.todos.find((todo) => todo.id === todoId) || null : null;

const findStartedTodo = (snapshot: TodoSnapshot, previousSnapshot?: TodoSnapshot | null) => {
  if (!previousSnapshot) {
    return snapshot.activeTodo;
  }

  return (
    snapshot.activeTodo ||
    snapshot.todos.find((todo) => {
      const previousTodo = previousSnapshot.todos.find((item) => item.id === todo.id);
      return previousTodo?.status === "pending" && todo.status !== "pending";
    }) ||
    null
  );
};

const getFallbackTodo = (snapshot: TodoSnapshot, previousSnapshot?: TodoSnapshot | null) =>
  snapshot.activeTodo ||
  [...snapshot.todos].reverse().find((todo) => {
    const previousTodo = previousSnapshot ? getSnapshotTodo(previousSnapshot, todo.id) : null;
    return todo.status !== "pending" && previousTodo?.status !== todo.status;
  }) ||
  [...snapshot.todos].reverse().find((todo) => todo.status !== "pending") ||
  null;

const createTodoFlowNode = (snapshot: TodoSnapshot, task: DisplayTodoItem): TodoTaskFlowNode => ({
  type: "todo",
  id: `todo-flow-${snapshot.id}-${task.id}`,
  task,
  status: task.status,
  snapshot,
  children: [],
});

const buildAssistantFlowNodes = (segments: AssistantSegment[]): AssistantFlowNode[] => {
  const nodes: AssistantFlowNode[] = [];
  let currentTodoNode: TodoTaskFlowNode | null = null;
  let previousSnapshot: TodoSnapshot | null = null;
  const lastNonReasoningSegment = [...segments].reverse().find((segment) => segment.type !== "reasoning");
  const finalResponseTextSegmentId = lastNonReasoningSegment?.type === "text" ? lastNonReasoningSegment.id : null;

  const closeCurrentTodoNode = (snapshot: TodoSnapshot) => {
    if (!currentTodoNode) return null;
    const updatedTask = getSnapshotTodo(snapshot, currentTodoNode.task.id);
    if (updatedTask) {
      currentTodoNode.task = updatedTask;
      currentTodoNode.status = updatedTask.status;
      currentTodoNode.snapshot = snapshot;
    }

    if (currentTodoNode.status !== "in_progress") {
      const closedTodoId = currentTodoNode.task.id;
      currentTodoNode = null;
      return closedTodoId;
    }

    return null;
  };

  const appendFlowNode = (node: InlineAssistantSegment | ToolFlowNode | UserQuestionFlowNode | SubAgentFlowNode) => {
    if (node.type === "text" && node.id === finalResponseTextSegmentId) {
      nodes.push(node);
      return;
    }

    if (currentTodoNode) {
      currentTodoNode.children.push(node);
      return;
    }

    nodes.push(node);
  };

  const appendToolCall = (toolCall: ToolCall, resultMessage?: ChatMessage) => {
    const targetNodes = currentTodoNode ? currentTodoNode.children : nodes;
    const previousNode = targetNodes[targetNodes.length - 1];

    if (previousNode?.type === "tools") {
      previousNode.toolCalls.push(toolCall);
      if (resultMessage) {
        previousNode.toolResults.push(resultMessage);
      }
      return;
    }

    targetNodes.push({
      type: "tools",
      id: `tools-flow-${toolCall.id}`,
      toolCalls: [toolCall],
      toolResults: resultMessage ? [resultMessage] : [],
    });
  };

  segments.forEach((segment) => {
    if (segment.type !== "tools") {
      appendFlowNode(segment);
      return;
    }

    segment.toolCalls.forEach((toolCall) => {
      const resultMessage = segment.toolResults.find((item) => item.tool_call_id === toolCall.id);

      if (toolCall.function.name === "askUser") {
        appendFlowNode(createUserQuestionFlowNode(toolCall, resultMessage));
        return;
      }

      if (toolCall.function.name === "runSubAgent") {
        appendFlowNode(buildSubAgentFlowNode(toolCall, resultMessage));
        return;
      }

      if (toolCall.function.name === "updateTodoList") {
        const snapshot = getTodoSnapshots([toolCall], resultMessage ? [resultMessage] : [])[0];
        if (!snapshot || snapshot.todos.length === 0) {
          return;
        }

        const closedTodoId = closeCurrentTodoNode(snapshot);
        const nextTask = findStartedTodo(snapshot, previousSnapshot) || getFallbackTodo(snapshot, previousSnapshot);
        const isSameTask = Boolean(currentTodoNode && nextTask && currentTodoNode.task.id === nextTask.id);

        if (nextTask && nextTask.status !== "pending" && nextTask.id !== closedTodoId && !isSameTask) {
          currentTodoNode = createTodoFlowNode(snapshot, nextTask);
          nodes.push(currentTodoNode);
        }

        previousSnapshot = snapshot;
        return;
      }

      appendToolCall(toolCall, resultMessage);
    });
  });

  return nodes;
};

const TODO_STATUS_ICON_CLASS: Record<TodoStatus, string> = {
  pending: chat.todoStatusIconpending,
  in_progress: chat.todoStatusIconinProgress,
  completed: chat.todoStatusIconcompleted,
  cancelled: chat.todoStatusIconcancelled,
};

const TodoStatusIcon = ({ status, running }: { status: TodoStatus; running?: boolean }) => {
  const statusClass = running ? chat.todoStatusIconRunning : TODO_STATUS_ICON_CLASS[status];

  return (
    <span className={[chat.todoStatusIcon, statusClass].filter(Boolean).join(" ")}>
      {running ? "" : status === "completed" ? "✓" : status === "cancelled" ? "×" : ""}
    </span>
  );
};

const TodoTaskFlow = ({
  node,
  isLatestLiveItem,
  hasChildren,
  children,
}: {
  node: TodoTaskFlowNode;
  isLatestLiveItem: boolean;
  hasChildren?: boolean;
  children?: React.ReactNode;
}) => {
  const isTransferred = node.status === "transferred";
  const isRunning =
    node.status === "in_progress" ||
    Boolean(isLatestLiveItem && node.snapshot.isRunning && node.snapshot.activeTodo?.id === node.task.id);
  const hasBody = Boolean(hasChildren);
  const [expanded, setExpanded] = React.useState(() => isRunning);
  const previousAutoStateRef = React.useRef({ nodeId: node.id, isRunning });

  React.useEffect(() => {
    const previous = previousAutoStateRef.current;
    const nodeChanged = previous.nodeId !== node.id;
    const runningChanged = previous.isRunning !== isRunning;
    previousAutoStateRef.current = { nodeId: node.id, isRunning };
    if (nodeChanged || runningChanged) {
      setExpanded(isRunning);
    }
  }, [isRunning, node.id]);

  const status = isRunning ? "in_progress" : node.status;

  return (
    <div
      className={`${chat.todoFlow} ${isRunning ? chat.todoFlowRunning : chat.todoFlowComplete} ${
        status === "cancelled" || status === "transferred" ? chat.todoFlowTerminated : ""
      } ${
        expanded && hasBody ? chat.todoFlowExpanded : ""
      }`}
    >
      <button
        type="button"
        className={chat.todoFlowHeader}
        onClick={() => (hasBody ? setExpanded((previous) => !previous) : undefined)}
      >
        <TodoStatusIcon status={status === "transferred" ? "cancelled" : status} running={isRunning && !isTransferred} />
        <span>{node.task.title}</span>
        {status === "cancelled" ? <span className={chat.todoFlowStatus}>已终止</span> : null}
        {status === "transferred" ? <span className={chat.todoFlowStatus}>已跳转</span> : null}
        {hasBody ? (
          <span className={`${chat.todoFlowChevron} ${expanded ? chat.todoFlowChevronExpanded : ""}`}>
            <ChevronRightIcon aria-hidden="true" />
          </span>
        ) : null}
      </button>
      {hasBody ? (
        <div className={`${chat.todoFlowBody} ${expanded ? chat.todoFlowBodyExpanded : ""}`} aria-hidden={!expanded}>
          <div className={chat.todoFlowContent}>{children}</div>
        </div>
      ) : null}
    </div>
  );
};

const UserQuestionFlow = ({ node }: { node: UserQuestionFlowNode }) => {
  const [expanded, setExpanded] = React.useState(() => !node.isAnswered);
  const previousAnsweredRef = React.useRef({ nodeId: node.id, isAnswered: node.isAnswered });

  React.useEffect(() => {
    const previous = previousAnsweredRef.current;
    const nodeChanged = previous.nodeId !== node.id;
    const answeredChanged = previous.isAnswered !== node.isAnswered;
    previousAnsweredRef.current = { nodeId: node.id, isAnswered: node.isAnswered };
    if (nodeChanged) {
      setExpanded(!node.isAnswered);
      return;
    }
    if (answeredChanged && node.isAnswered) {
      setExpanded(false);
    }
  }, [node.isAnswered, node.id]);

  return (
    <div className={`${chat.userQuestionFlow} ${expanded ? chat.userQuestionFlowExpanded : ""}`}>
      <button
        type="button"
        className={chat.userQuestionFlowHeader}
        onClick={() => setExpanded((previous) => !previous)}
        aria-expanded={expanded}
      >
        <span className={chat.userQuestionFlowIcon}>?</span>
        <span>{node.questions[0]?.question || "需要补充信息"}</span>
        <span className={`${chat.userQuestionFlowChevron} ${expanded ? chat.userQuestionFlowChevronExpanded : ""}`}>
          <ChevronRightIcon aria-hidden="true" />
        </span>
      </button>
      <div
        className={`${chat.userQuestionFlowBody} ${expanded ? chat.userQuestionFlowBodyExpanded : ""}`}
        aria-hidden={!expanded}
      >
        <div className={chat.userQuestionFlowBodyInner}>
          {node.isAnswered ? (
            node.questions.map((item) => (
              <div key={item.id} className={chat.userQuestionAnswer}>
                <span>{item.question}</span>
                <strong>{item.answer}</strong>
              </div>
            ))
          ) : (
            <div className={chat.userQuestionPending}>等待你补充信息...</div>
          )}
        </div>
      </div>
    </div>
  );
};

const SubAgentTaskFlow = ({ node, children }: { node: SubAgentFlowNode; children?: React.ReactNode }) => {
  const isRunning = node.status === "running";
  const shouldShowSummary = !isRunning && node.children.length === 0 && Boolean(node.summary);
  const hasBody = Boolean(isRunning || shouldShowSummary || node.children.length > 0);
  const [expanded, setExpanded] = React.useState(() => isRunning);
  const scrollAreaRef = React.useRef<HTMLDivElement | null>(null);
  const stickyRef = React.useRef(true);
  const userDetachedRef = React.useRef(false);
  const scrollFrameRef = React.useRef<number | null>(null);
  const lastScrollTopRef = React.useRef(0);
  const programmaticScrollRef = React.useRef(false);
  const userScrollIntentUntilRef = React.useRef(0);
  const lastTouchYRef = React.useRef<number | null>(null);
  const [isStickyToBottom, setIsStickyToBottom] = React.useState(true);

  const setStickyState = React.useCallback((nextSticky: boolean) => {
    if (stickyRef.current === nextSticky) return;
    stickyRef.current = nextSticky;
    setIsStickyToBottom(nextSticky);
  }, []);

  const cancelScheduledScroll = React.useCallback(() => {
    if (scrollFrameRef.current !== null) {
      window.cancelAnimationFrame(scrollFrameRef.current);
      scrollFrameRef.current = null;
    }
  }, []);

  const scrollToBottom = React.useCallback(
    (behavior: ScrollBehavior = "smooth") => {
      const element = scrollAreaRef.current;
      if (!element) return;

      const targetTop = Math.max(0, element.scrollHeight - element.clientHeight);
      userDetachedRef.current = false;
      programmaticScrollRef.current = true;
      setStickyState(true);

      if (behavior === "smooth") {
        element.scrollTo({ top: targetTop, behavior });
      } else {
        element.scrollTop = targetTop;
      }

      window.setTimeout(() => {
        programmaticScrollRef.current = false;
        const currentElement = scrollAreaRef.current;
        if (currentElement) {
          lastScrollTopRef.current = currentElement.scrollTop;
        }
      }, behavior === "smooth" ? 220 : 0);
    },
    [setStickyState],
  );

  const detachFromAutoScroll = React.useCallback(() => {
    cancelScheduledScroll();
    userDetachedRef.current = true;
    setStickyState(false);
  }, [cancelScheduledScroll, setStickyState]);

  const markUserScrollIntent = React.useCallback(() => {
    userScrollIntentUntilRef.current = Date.now() + 320;
  }, []);

  const scheduleFollowBottom = React.useCallback(
    (behavior: ScrollBehavior = "auto") => {
      if (!stickyRef.current) return;

      if (scrollFrameRef.current !== null) {
        window.cancelAnimationFrame(scrollFrameRef.current);
      }

      scrollFrameRef.current = window.requestAnimationFrame(() => {
        scrollFrameRef.current = null;
        scrollToBottom("auto");
        window.requestAnimationFrame(() => {
          if (stickyRef.current) {
            scrollToBottom(behavior);
          }
        });
      });
    },
    [scrollToBottom],
  );

  React.useEffect(() => {
    if (isRunning && !expanded) {
      setExpanded(true);
    }
  }, [expanded, isRunning, node.id]);

  React.useLayoutEffect(() => {
    if (!expanded || !stickyRef.current) return;
    scheduleFollowBottom("auto");
  }, [children, expanded, node.summary, scheduleFollowBottom]);

  React.useEffect(() => {
    const element = scrollAreaRef.current;
    if (!element || typeof ResizeObserver === "undefined") return undefined;

    const observer = new ResizeObserver(() => {
      if (expanded && stickyRef.current) {
        scheduleFollowBottom("auto");
      }
    });

    observer.observe(element);
    Array.from(element.children).forEach((child) => observer.observe(child));
    return () => observer.disconnect();
  }, [children, expanded, scheduleFollowBottom]);

  React.useEffect(() => {
    const element = scrollAreaRef.current;
    if (!element || typeof MutationObserver === "undefined") return undefined;

    const observer = new MutationObserver(() => {
      if (expanded && stickyRef.current) {
        scheduleFollowBottom("auto");
      }
    });

    observer.observe(element, { childList: true, subtree: true, characterData: true, attributes: true });
    return () => observer.disconnect();
  }, [expanded, scheduleFollowBottom]);

  React.useEffect(
    () => () => {
      cancelScheduledScroll();
    },
    [cancelScheduledScroll],
  );

  const handleScroll = React.useCallback(() => {
    const element = scrollAreaRef.current;
    if (!element) return;

    const distanceToBottom = element.scrollHeight - element.scrollTop - element.clientHeight;
    const isScrollingUp = element.scrollTop < lastScrollTopRef.current - 1;
    lastScrollTopRef.current = element.scrollTop;

    if (programmaticScrollRef.current) {
      return;
    }

    if (isScrollingUp && Date.now() <= userScrollIntentUntilRef.current) {
      detachFromAutoScroll();
      return;
    }

    if (userDetachedRef.current) {
      const isBackAtBottom = distanceToBottom <= STICKY_BOTTOM_DISTANCE;
      if (isBackAtBottom) {
        userDetachedRef.current = false;
      }
      setStickyState(isBackAtBottom);
      return;
    }

    if (distanceToBottom <= STICKY_BOTTOM_DISTANCE) {
      setStickyState(true);
    }
  }, [detachFromAutoScroll, setStickyState]);

  const handleWheel = React.useCallback(
    (event: React.WheelEvent<HTMLDivElement>) => {
      markUserScrollIntent();
      if (event.deltaY < -1) {
        detachFromAutoScroll();
      }
    },
    [detachFromAutoScroll, markUserScrollIntent],
  );

  const handlePointerDown = React.useCallback(() => {
    markUserScrollIntent();
  }, [markUserScrollIntent]);

  const handleTouchStart = React.useCallback(
    (event: React.TouchEvent<HTMLDivElement>) => {
      lastTouchYRef.current = event.touches[0]?.clientY ?? null;
      markUserScrollIntent();
    },
    [markUserScrollIntent],
  );

  const handleTouchMove = React.useCallback(
    (event: React.TouchEvent<HTMLDivElement>) => {
      const nextY = event.touches[0]?.clientY ?? null;
      const previousY = lastTouchYRef.current;
      if (nextY !== null && previousY !== null) {
        markUserScrollIntent();
        if (nextY > previousY + 1) {
          detachFromAutoScroll();
        }
      }
      lastTouchYRef.current = nextY;
    },
    [detachFromAutoScroll, markUserScrollIntent],
  );

  return (
    <div
      className={`${chat.todoFlow} ${isRunning ? chat.todoFlowRunning : chat.todoFlowComplete} ${
        expanded && hasBody ? chat.todoFlowExpanded : ""
      }`}
    >
      <button
        type="button"
        className={chat.todoFlowHeader}
        onClick={() => (hasBody ? setExpanded((previous) => !previous) : undefined)}
      >
        <span className={chat.subAgentAvatar} style={{ backgroundColor: node.avatarBackground }}>
          <span className={chat.subAgentAvatarGlyph} aria-hidden="true">
            <SubAgentIcon icon={node.avatarIcon} />
          </span>
        </span>
        <span className={chat.subAgentFlowTitle}>{node.name}</span>
        {node.status === "terminated" ? <span className={chat.todoFlowStatus}>已终止</span> : null}
        {hasBody ? (
          <span className={`${chat.todoFlowChevron} ${expanded ? chat.todoFlowChevronExpanded : ""}`}>
            <ChevronRightIcon aria-hidden="true" />
          </span>
        ) : null}
      </button>
      {hasBody ? (
        <div className={`${chat.subAgentFlowBody} ${expanded ? chat.subAgentFlowBodyExpanded : ""}`} aria-hidden={!expanded}>
          <div className={chat.subAgentScrollWrap}>
            <div
              ref={scrollAreaRef}
              className={`${chat.todoFlowContent} ${chat.subAgentScrollArea}`}
              onScroll={handleScroll}
              onWheel={handleWheel}
              onPointerDown={handlePointerDown}
              onTouchStart={handleTouchStart}
              onTouchMove={handleTouchMove}
            >
              {shouldShowSummary ? (
                <div className={chat.subAgentSummaryWrap}>
                  <pre className={chat.reasoningText}>{node.summary}</pre>
                </div>
              ) : null}
              {children}
            </div>
            {!isStickyToBottom ? (
              <button
                type="button"
                className={chat.subAgentScrollToBottomButton}
                onClick={() => scrollToBottom()}
                title="吸附到底部"
                aria-label="吸附到底部"
              >
                ↓
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
};

const parsePatchStats = (patch: string) => {
  const files: Array<{ path: string; added: number; deleted: number }> = [];
  let current: { path: string; added: number; deleted: number } | null = null;

  String(patch || "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .forEach((line) => {
      if (line.startsWith("*** Update File:")) {
        current = {
          path: line.slice("*** Update File:".length).trim(),
          added: 0,
          deleted: 0,
        };
        files.push(current);
        return;
      }

      if (line.startsWith("*** Add File:")) {
        current = {
          path: line.slice("*** Add File:".length).trim(),
          added: 1,
          deleted: 0,
        };
        files.push(current);
        return;
      }

      if (line.startsWith("*** Delete File:")) {
        current = {
          path: line.slice("*** Delete File:".length).trim(),
          added: 0,
          deleted: 1,
        };
        files.push(current);
        return;
      }

      if (line.startsWith("*** Move to:")) {
        const movePath = line.slice("*** Move to:".length).trim();
        if (current && movePath) {
          files.push({ path: movePath, added: 0, deleted: 0 });
        }
        return;
      }

      if (
        !current ||
        line === "*** Begin Patch" ||
        line === "*** End Patch" ||
        line.startsWith("@@") ||
        line.startsWith("*** ")
      ) {
        return;
      }

      if (line.startsWith("+")) {
        current.added += 1;
        return;
      }

      if (line.startsWith("-")) {
        current.deleted += 1;
        return;
      }

      if (!line.startsWith(" ")) {
        current.added += 1;
      }
    });

  return files.filter((file) => file.path);
};

const collectLatestChangeSummary = (messages: ChatMessage[], isGenerating: boolean): ChangeSummary | null => {
  if (isGenerating) return null;

  const lastUserIndex = Math.max(
    0,
    messages.reduce((lastIndex, message, index) => (message.role === "user" ? index : lastIndex), -1),
  );
  const latestTurnMessages = messages.slice(lastUserIndex);
  const toolResults = latestTurnMessages.filter((message) => message.role === "tool");
  const byPath = new Map<string, ChangeSummaryFile>();

  latestTurnMessages.forEach((message) => {
    if (message.role !== "assistant" || !message.tool_calls?.length) {
      return;
    }

    message.tool_calls.forEach((toolCall) => {
      if (toolCall.function.name !== "applyPatch") {
        return;
      }

      const resultMessage = toolResults.find((result) => result.tool_call_id === toolCall.id);
      const result = safeParseJson(resultMessage?.content || "") as any;
      if (!result || result.success === false) {
        return;
      }

      const args = safeParseJson(toolCall.function.arguments) as any;
      parsePatchStats(args?.patch || "").forEach((file) => {
        const existing = byPath.get(file.path) || { path: file.path, added: 0, deleted: 0, operations: 0 };
        existing.added += file.added;
        existing.deleted += file.deleted;
        byPath.set(file.path, existing);
      });

      (Array.isArray(result?.changedFiles) ? result.changedFiles : []).forEach((path: string) => {
        if (!path) return;
        byPath.set(path, byPath.get(path) || { path, added: 0, deleted: 0, operations: 0 });
      });

      (Array.isArray(result?.syncResults) ? result.syncResults : []).forEach((syncResult: any) => {
        const path = syncResult?.path || syncResult?.operations?.[0]?.newPath || syncResult?.operations?.[0]?.path;
        if (!path) return;
        const existing = byPath.get(path) || { path, added: 0, deleted: 0, operations: 0 };
        existing.operations += Number(syncResult?.operationCount || 0);
        byPath.set(path, existing);
      });
    });
  });

  const files = [...byPath.values()];
  if (!files.length) {
    return null;
  }

  return {
    files,
    added: files.reduce((sum, file) => sum + file.added, 0),
    deleted: files.reduce((sum, file) => sum + file.deleted, 0),
    operations: files.reduce((sum, file) => sum + file.operations, 0),
  };
};

const summarizeAssistantMessageForCopy = (item: AssistantBubble) =>
  item.segments
    .map((segment) => {
      if (segment.type === "text") {
        return segment.content;
      }

      if (segment.type === "tools") {
        return `${segment.toolCalls.length}次工具调用`;
      }

      return "";
    })
    .filter(Boolean)
    .join("\n\n");

const ContextUsageFooter = ({
  usage,
  canRetry,
  onRetry,
  onCompress,
  isCompressing,
}: {
  usage: ContextUsageInfo;
  canRetry: boolean;
  onRetry: () => void;
  onCompress: () => void;
  isCompressing: boolean;
}) => {
  const radius = 16;
  const circumference = 2 * Math.PI * radius;
  const progress = Math.max(0, Math.min(100, usage.percent));
  const dashOffset = circumference * (1 - progress / 100);
  const usedLabel = usage.usedTokens >= 1000 ? `${(usage.usedTokens / 1000).toFixed(1)}k` : String(usage.usedTokens);
  const limitLabel = usage.limitTokens >= 1000 ? `${Math.round(usage.limitTokens / 1000)}k` : String(usage.limitTokens);
  const usageKindLabel = usage.isEstimate ? "估算" : "实际";

  return (
    <div className={chat.contextUsageFooter}>
      <div className={chat.contextUsageInfo} title={`${usageKindLabel}上下文：${usage.usedTokens} / ${usage.limitTokens} tokens`}>
        <svg className={chat.contextUsageRing} viewBox="0 0 40 40" aria-hidden="true">
          <circle className={chat.contextUsageRingTrack} cx="20" cy="20" r={radius} />
          <circle
            className={chat.contextUsageRingValue}
            cx="20"
            cy="20"
            r={radius}
            strokeDasharray={circumference}
            strokeDashoffset={dashOffset}
          />
        </svg>
        <div className={chat.contextUsageText}>
          <strong>上下文 {progress}%</strong>
          <span>{usageKindLabel} {usedLabel} / {limitLabel}</span>
        </div>
      </div>
      <div className={chat.contextFooterActions}>
        <button type="button" className={chat.contextIconButton} onClick={onRetry} disabled={!canRetry} title="重试" aria-label="重试">
          <RefreshIcon aria-hidden="true" />
        </button>
        <button
          type="button"
          className={chat.contextIconButton}
          onClick={onCompress}
          disabled={isCompressing}
          title="压缩对话"
          aria-label="压缩对话"
        >
          <CompressIcon aria-hidden="true" />
        </button>
      </div>
    </div>
  );
};

const CompressionDivider = ({ message }: { message: ChatMessage }) => (
  <div className={chat.compressionDivider} data-status={message.compressionStatus || "completed"}>
    <span>{message.content}</span>
  </div>
);

export const ChatArea: React.FC<ChatAreaProps> = ({
  messages,
  isGenerating,
  conversationMode,
  examplePrompts,
  vm,
  blockly,
  workspace,
  subAgents,
  guides,
  onOpenWorkspaceAttachment,
  onPreviewAttachment,
  onRestoreToUserMessage,
  hasSnapshot,
  contextUsage,
  onRetryLastResponse,
  onCompressContext,
  isCompressingContext,
  onUseExamplePrompt,
  onRequestOpenUrl,
}) => {
  const displayItems = React.useMemo(() => collectAssistantBubbles(messages, isGenerating), [messages, isGenerating]);
  const hasRetryableError = React.useMemo(
    () => messages.some((message) => !message.hidden && message.kind !== "contextSummary" && message.role === "assistant" && message.status === "error"),
    [messages],
  );
  const userMessages = React.useMemo(
    () => displayItems.filter((item): item is ChatMessage => "role" in item && item.role === "user"),
    [displayItems],
  );
  const latestChangeSummary = React.useMemo(
    () => collectLatestChangeSummary(messages, isGenerating),
    [messages, isGenerating],
  );
  const reasoningPanelSignature = React.useMemo(
    () =>
      displayItems
        .flatMap((item) =>
          "role" in item
            ? []
            : item.segments
                .filter((segment): segment is Extract<AssistantSegment, { type: "reasoning" }> => segment.type === "reasoning")
                .map((segment) => `${segment.id}:${segment.isComplete ? "1" : "0"}`),
        )
        .join("|"),
    [displayItems],
  );
  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  const railRef = React.useRef<HTMLDivElement | null>(null);
  const userMessageNavRef = React.useRef<HTMLElement | null>(null);
  const bottomRef = React.useRef<HTMLDivElement | null>(null);
  const userMessageRefs = React.useRef<Record<string, HTMLDivElement | null>>({});
  const userMessageCollapseTimers = React.useRef<Record<string, number>>({});
  const stickyRef = React.useRef(true);
  const userDetachedRef = React.useRef(false);
  const scrollFrameRef = React.useRef<number | null>(null);
  const virtualScrollFrameRef = React.useRef<number | null>(null);
  const virtualHeightByKeyRef = React.useRef<Map<string, number>>(new Map());
  const lastScrollTopRef = React.useRef(0);
  const programmaticScrollRef = React.useRef(false);
  const userScrollIntentUntilRef = React.useRef(0);
  const lastTouchYRef = React.useRef<number | null>(null);
  const [isStickyToBottom, setIsStickyToBottom] = React.useState(true);
  const [virtualViewport, setVirtualViewport] = React.useState({ scrollTop: 0, clientHeight: 0 });
  const [virtualHeightVersion, setVirtualHeightVersion] = React.useState(0);
  const [reasoningPanels, setReasoningPanels] = React.useState<Record<string, ReasoningPanelState>>({});
  const reasoningPanelsRef = React.useRef(reasoningPanels);
  const [expandedUserMessages, setExpandedUserMessages] = React.useState<Record<string, boolean>>({});
  const [collapsingUserMessages, setCollapsingUserMessages] = React.useState<Record<string, boolean>>({});
  const [hoveredUserPreview, setHoveredUserPreview] = React.useState<{
    id: string;
    content: string;
    top: number;
    left: number;
  } | null>(null);
  const [blockPreviewDialog, setBlockPreviewDialog] = React.useState<{
    reference: ResolvedVirtualBlockLineReference;
    svg: string;
  } | null>(null);
  const virtualRange = React.useMemo(
    () =>
      calculateVirtualRange(
        displayItems,
        virtualHeightByKeyRef.current,
        virtualViewport.scrollTop,
        virtualViewport.clientHeight || scrollRef.current?.clientHeight || 0,
      ),
    [displayItems, virtualHeightVersion, virtualViewport],
  );
  const visibleDisplayItems = React.useMemo(
    () => displayItems.slice(virtualRange.start, virtualRange.end),
    [displayItems, virtualRange.end, virtualRange.start],
  );
  const topVirtualSpacerHeight = React.useMemo(
    () => getVirtualSpacerHeight(displayItems, virtualHeightByKeyRef.current, 0, virtualRange.start),
    [displayItems, virtualHeightVersion, virtualRange.start],
  );
  const bottomVirtualSpacerHeight = React.useMemo(
    () => getVirtualSpacerHeight(displayItems, virtualHeightByKeyRef.current, virtualRange.end, displayItems.length),
    [displayItems, virtualHeightVersion, virtualRange.end],
  );
  const hasVirtualizedMessages = virtualRange.start > 0 || virtualRange.end < displayItems.length;

  const setStickyState = React.useCallback((nextSticky: boolean) => {
    if (stickyRef.current === nextSticky) return;
    stickyRef.current = nextSticky;
    setIsStickyToBottom(nextSticky);
  }, []);

  const cancelScheduledScroll = React.useCallback(() => {
    if (scrollFrameRef.current !== null) {
      window.cancelAnimationFrame(scrollFrameRef.current);
      scrollFrameRef.current = null;
    }
  }, []);

  const updateVirtualViewport = React.useCallback((element: HTMLDivElement | null = scrollRef.current) => {
    if (!element) return;
    const nextViewport = {
      scrollTop: element.scrollTop,
      clientHeight: element.clientHeight,
    };
    setVirtualViewport((previous) =>
      Math.abs(previous.scrollTop - nextViewport.scrollTop) <= 1 && previous.clientHeight === nextViewport.clientHeight
        ? previous
        : nextViewport,
    );
  }, []);

  const scheduleVirtualViewportUpdate = React.useCallback(
    (element: HTMLDivElement | null = scrollRef.current) => {
      if (!element) return;
      if (virtualScrollFrameRef.current !== null) return;
      virtualScrollFrameRef.current = window.requestAnimationFrame(() => {
        virtualScrollFrameRef.current = null;
        updateVirtualViewport(element);
      });
    },
    [updateVirtualViewport],
  );

  const measureVisibleVirtualItems = React.useCallback(() => {
    const railElement = railRef.current;
    if (!railElement) return;
    let changed = false;
    railElement.querySelectorAll<HTMLElement>("[data-ai-virtual-item-key]").forEach((element) => {
      const key = element.dataset.aiVirtualItemKey || "";
      if (!key) return;
      const height = element.offsetHeight;
      if (!Number.isFinite(height) || height <= 0) return;
      const previous = virtualHeightByKeyRef.current.get(key);
      if (previous !== undefined && Math.abs(previous - height) <= 1) return;
      virtualHeightByKeyRef.current.set(key, height);
      changed = true;
    });
    if (changed) {
      setVirtualHeightVersion((version) => version + 1);
    }
  }, []);

  const scrollToBottom = React.useCallback(
    (behavior: ScrollBehavior = "smooth") => {
      const element = scrollRef.current;
      if (!element) return;
      const targetTop = Math.max(0, element.scrollHeight - element.clientHeight);
      if (Math.abs(element.scrollTop - targetTop) <= 1 && stickyRef.current) {
        setStickyState(true);
        return;
      }
      userDetachedRef.current = false;
      programmaticScrollRef.current = true;
      setStickyState(true);

      if (behavior === "smooth") {
        element.scrollTo({ top: targetTop, behavior });
      } else {
        element.scrollTop = targetTop;
      }
      updateVirtualViewport(element);

      window.setTimeout(() => {
        programmaticScrollRef.current = false;
        const currentElement = scrollRef.current;
        if (currentElement) {
          lastScrollTopRef.current = currentElement.scrollTop;
          updateVirtualViewport(currentElement);
        }
      }, behavior === "smooth" ? 220 : 0);
    },
    [setStickyState, updateVirtualViewport],
  );

  const detachFromAutoScroll = React.useCallback(() => {
    cancelScheduledScroll();
    userDetachedRef.current = true;
    setStickyState(false);
  }, [cancelScheduledScroll, setStickyState]);

  const markUserScrollIntent = React.useCallback(() => {
    userScrollIntentUntilRef.current = Date.now() + 320;
  }, []);

  const handleScroll = React.useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;

    const distanceToBottom = element.scrollHeight - element.scrollTop - element.clientHeight;
    const isScrollingUp = element.scrollTop < lastScrollTopRef.current - 1;
    lastScrollTopRef.current = element.scrollTop;
    scheduleVirtualViewportUpdate(element);

    if (programmaticScrollRef.current) {
      return;
    }

    if (isScrollingUp && Date.now() <= userScrollIntentUntilRef.current) {
      detachFromAutoScroll();
      return;
    }

    if (userDetachedRef.current) {
      const isBackAtBottom = distanceToBottom <= 4;
      if (isBackAtBottom) {
        userDetachedRef.current = false;
      }
      setStickyState(isBackAtBottom);
      return;
    }

    if (distanceToBottom <= STICKY_BOTTOM_DISTANCE) {
      setStickyState(true);
    }
  }, [detachFromAutoScroll, scheduleVirtualViewportUpdate, setStickyState]);

  const handleWheel = React.useCallback(
    (event: React.WheelEvent<HTMLDivElement>) => {
      markUserScrollIntent();
      if (event.deltaY < -1) {
        detachFromAutoScroll();
      }
    },
    [detachFromAutoScroll, markUserScrollIntent],
  );

  const handlePointerDown = React.useCallback(() => {
    markUserScrollIntent();
  }, [markUserScrollIntent]);

  const handleTouchStart = React.useCallback(
    (event: React.TouchEvent<HTMLDivElement>) => {
      lastTouchYRef.current = event.touches[0]?.clientY ?? null;
      markUserScrollIntent();
    },
    [markUserScrollIntent],
  );

  const handleTouchMove = React.useCallback(
    (event: React.TouchEvent<HTMLDivElement>) => {
      const nextY = event.touches[0]?.clientY ?? null;
      const previousY = lastTouchYRef.current;
      if (nextY !== null && previousY !== null) {
        markUserScrollIntent();
        if (nextY > previousY + 1) {
          detachFromAutoScroll();
        }
      }
      lastTouchYRef.current = nextY;
    },
    [detachFromAutoScroll, markUserScrollIntent],
  );

  const scheduleFollowBottom = React.useCallback(
    (behavior: ScrollBehavior = "auto") => {
      if (!stickyRef.current) return;

      if (scrollFrameRef.current !== null) {
        window.cancelAnimationFrame(scrollFrameRef.current);
      }

      scrollFrameRef.current = window.requestAnimationFrame(() => {
        scrollFrameRef.current = null;
        scrollToBottom("auto");
        if (behavior === "smooth") {
          window.requestAnimationFrame(() => scrollToBottom("smooth"));
        }
      });
    },
    [scrollToBottom],
  );

  React.useLayoutEffect(() => {
    updateVirtualViewport();
    measureVisibleVirtualItems();
    if (stickyRef.current) {
      scheduleFollowBottom("auto");
    }
  }, [displayItems, isGenerating, measureVisibleVirtualItems, scheduleFollowBottom, updateVirtualViewport, virtualRange.end, virtualRange.start]);

  React.useEffect(() => {
    const scrollElement = scrollRef.current;
    const railElement = railRef.current;
    if (!scrollElement || !railElement || typeof ResizeObserver === "undefined") return undefined;

    const observer = new ResizeObserver(() => {
      updateVirtualViewport(scrollElement);
      measureVisibleVirtualItems();
      if (stickyRef.current) {
        scheduleFollowBottom("auto");
      }
    });

    observer.observe(railElement);
    observer.observe(scrollElement);
    return () => observer.disconnect();
  }, [isGenerating, measureVisibleVirtualItems, scheduleFollowBottom, updateVirtualViewport]);

  React.useEffect(
    () => () => {
      cancelScheduledScroll();
      if (virtualScrollFrameRef.current !== null) {
        window.cancelAnimationFrame(virtualScrollFrameRef.current);
        virtualScrollFrameRef.current = null;
      }
      Object.values(userMessageCollapseTimers.current).forEach((timer) => window.clearTimeout(timer));
    },
    [cancelScheduledScroll],
  );

  React.useEffect(() => {
    reasoningPanelsRef.current = reasoningPanels;
  }, [reasoningPanels]);

  React.useEffect(() => {
    if (!reasoningPanelSignature) return;
    const previous = reasoningPanelsRef.current;
    const next = { ...previous };
    let changed = false;

    displayItems.forEach((item) => {
      if ("role" in item) {
        return;
      }

      item.segments.forEach((segment) => {
        if (segment.type !== "reasoning") {
          return;
        }

        if (!(segment.id in next)) {
          next[segment.id] = {
            collapsed: segment.isComplete,
            hasAutoCollapsed: segment.isComplete,
          };
          changed = true;
          return;
        }

        if (segment.isComplete && !next[segment.id].hasAutoCollapsed) {
          next[segment.id] = {
            collapsed: true,
            hasAutoCollapsed: true,
          };
          changed = true;
        }
      });
    });

    if (!changed) return;
    reasoningPanelsRef.current = next;
    setReasoningPanels(next);
  }, [reasoningPanelSignature]);

  const toggleReasoning = React.useCallback((id: string) => {
    setReasoningPanels((previous) => ({
      ...previous,
      [id]: {
        collapsed: !previous[id]?.collapsed,
        hasAutoCollapsed: previous[id]?.hasAutoCollapsed ?? false,
      },
    }));
  }, []);

  const handleCopy = React.useCallback(async (text: string) => {
    if (!text.trim()) return;
    await navigator.clipboard.writeText(text);
  }, []);

  const openVirtualBlockPreview = React.useCallback(
    (range: ReturnType<typeof findVirtualBlockLineReferenceRanges>[number] | null | undefined) => {
      if (!range) return;
      const resolved = resolveVirtualBlockLineReference(vm, range);
      if (!resolved) return;
      try {
        const parseBlocks = (code: string) =>
          ucfToScratch(code, {
            runtime: vm?.runtime,
            includeComments: true,
            validate: false,
          });
        let blocks: any[];
        const runtimeRange = getBlocksRangeBlockStates(vm, resolved.startBlockId, resolved.endBlockId);
        if (runtimeRange.success && Array.isArray((runtimeRange as any).blocks) && (runtimeRange as any).blocks.length) {
          blocks = (runtimeRange as any).blocks;
        } else {
          try {
            blocks = parseBlocks(resolved.code);
          } catch (error) {
            if (!resolved.fallbackCode) throw error;
            blocks = parseBlocks(resolved.fallbackCode);
          }
        }
        const rendered = serializeBlocksToPreviewSvg(blocks, blockly, vm);
        setBlockPreviewDialog({ reference: resolved, svg: rendered.svg });
      } catch (error) {
        console.warn("[AI Assistant Block Reference Preview] Failed to render user message block reference", {
          reference: range,
          error,
        });
      }
    },
    [blockly, vm],
  );

  const jumpToPreviewBlock = React.useCallback(() => {
    const reference = blockPreviewDialog?.reference;
    if (!reference || !workspace || !vm || !reference.targetId || !reference.startBlockId) return;

    const tryScroll = () => {
      const block =
        (typeof workspace.getBlockById === "function" ? workspace.getBlockById(reference.startBlockId) : null) ||
        (workspace as any).blockDB_?.[reference.startBlockId];
      if (!block) return false;
      scrollBlockIntoView(block, workspace);
      return true;
    };

    if (vm.editingTarget?.id === reference.targetId && tryScroll()) return;
    let attempts = 0;
    const retry = () => {
      attempts += 1;
      if (tryScroll() || attempts > 20) return;
      window.requestAnimationFrame(retry);
    };
    vm.setEditingTarget?.(reference.targetId);
    window.requestAnimationFrame(retry);
  }, [blockPreviewDialog?.reference, vm, workspace]);

  const scrollToUserMessage = React.useCallback(
    (messageId: string) => {
      const element = userMessageRefs.current[messageId];
      const scrollElement = scrollRef.current;
      if (!scrollElement) return;
      detachFromAutoScroll();
      if (!element) {
        const targetIndex = displayItems.findIndex((item) => "role" in item && item.role === "user" && item.id === messageId);
        if (targetIndex < 0) return;
        const targetTop = getVirtualSpacerHeight(displayItems, virtualHeightByKeyRef.current, 0, targetIndex) - 18;
        scrollElement.scrollTo({ top: Math.max(0, targetTop), behavior: "smooth" });
        updateVirtualViewport(scrollElement);
        return;
      }
      const targetTop =
        scrollElement.scrollTop + element.getBoundingClientRect().top - scrollElement.getBoundingClientRect().top - 18;
      scrollElement.scrollTo({ top: Math.max(0, targetTop), behavior: "smooth" });
      updateVirtualViewport(scrollElement);
    },
    [detachFromAutoScroll, displayItems, updateVirtualViewport],
  );

  const toggleUserMessageExpanded = React.useCallback(
    (messageId: string) => {
      const existingTimer = userMessageCollapseTimers.current[messageId];
      if (existingTimer) {
        window.clearTimeout(existingTimer);
        delete userMessageCollapseTimers.current[messageId];
      }

      if (expandedUserMessages[messageId]) {
        setCollapsingUserMessages((previous) => ({ ...previous, [messageId]: true }));
        userMessageCollapseTimers.current[messageId] = window.setTimeout(() => {
          setExpandedUserMessages((previous) => ({ ...previous, [messageId]: false }));
          setCollapsingUserMessages((previous) => {
            const next = { ...previous };
            delete next[messageId];
            return next;
          });
          delete userMessageCollapseTimers.current[messageId];
        }, USER_MESSAGE_COLLAPSE_ANIMATION_MS);
        return;
      }

      setCollapsingUserMessages((previous) => {
        if (!previous[messageId]) return previous;
        const next = { ...previous };
        delete next[messageId];
        return next;
      });
      setExpandedUserMessages((previous) => ({
        ...previous,
        [messageId]: true,
      }));
    },
    [expandedUserMessages],
  );

  const showUserMessagePreview = React.useCallback(
    (message: ChatMessage, event: React.MouseEvent<HTMLButtonElement> | React.FocusEvent<HTMLButtonElement>) => {
      const rect = event.currentTarget.getBoundingClientRect();
      const navRect = userMessageNavRef.current?.getBoundingClientRect();
      setHoveredUserPreview({
        id: message.id,
        content: getUserMessagePreview(message.content),
        top: navRect ? rect.top - navRect.top + rect.height / 2 : event.currentTarget.offsetTop + rect.height / 2,
        left: navRect ? rect.right - navRect.left + 6 : event.currentTarget.offsetLeft + rect.width + 6,
      });
    },
    [],
  );

  const hideUserMessagePreview = React.useCallback(() => {
    setHoveredUserPreview(null);
  }, []);

  return (
    <div
      className={chat.chatArea}
      ref={scrollRef}
      onScroll={handleScroll}
      onWheel={handleWheel}
      onPointerDown={handlePointerDown}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
    >
      {userMessages.length ? (
        <nav className={chat.userMessageNav} ref={userMessageNavRef} aria-label="用户消息导航">
          <div className={chat.userMessageDotList}>
            {userMessages.map((message, index) => (
              <button
                key={message.id || index}
                type="button"
                className={chat.userMessageDot}
                aria-label={`跳转到第 ${index + 1} 条用户消息`}
                onClick={() => scrollToUserMessage(message.id)}
                onMouseEnter={(event) => showUserMessagePreview(message, event)}
                onMouseLeave={hideUserMessagePreview}
                onFocus={(event) => showUserMessagePreview(message, event)}
                onBlur={hideUserMessagePreview}
              />
            ))}
          </div>
          {hoveredUserPreview ? (
            <div
              key={hoveredUserPreview.id}
              className={chat.userMessageNavPreview}
              style={{ top: hoveredUserPreview.top, left: hoveredUserPreview.left }}
            >
              {hoveredUserPreview.content}
            </div>
          ) : null}
        </nav>
      ) : null}
      <div className={chat.conversationRail} ref={railRef}>
        {displayItems.length === 0 ? (
          <div className={chat.emptyState}>
            <div className={chat.emptyStateHeader}>
              <span className={chat.emptyStateBadge}>AI Assistant</span>
              <span className={chat.emptyStateMode}>{conversationMode === "chat" ? "Chat" : "Code"}</span>
            </div>
            <h4 className={chat.emptyStateTitle}>
              {conversationMode === "chat" ? "先聊清楚想法，再决定怎么做" : "把要改的功能直接交给 AI"}
            </h4>
            <p className={chat.emptyStateText}>
              {conversationMode === "chat"
                ? "适合解释作品、梳理玩法、分析问题和规划下一步。"
                : "适合新增脚本、修复逻辑、调整造型资源和整理项目文件。"}
            </p>
            {examplePrompts.length ? (
              <div className={chat.emptyStateExamples} aria-label="示例需求">
                {examplePrompts.map((prompt) => (
                  <button
                    key={prompt}
                    type="button"
                    className={chat.emptyStateExampleButton}
                    onClick={() => onUseExamplePrompt?.(prompt)}
                  >
                    {prompt}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        ) : (
          <>
          {topVirtualSpacerHeight > 0 ? (
            <div className={chat.virtualMessageSpacer} style={{ height: topVirtualSpacerHeight }} aria-hidden="true" />
          ) : null}
          {visibleDisplayItems.map((item, visibleIndex) => {
            const index = virtualRange.start + visibleIndex;
            const virtualItemKey = getDisplayItemKey(item, index);
            const isLatestLiveItem = isGenerating && index === displayItems.length - 1;
            const disableEnterAnimation = hasVirtualizedMessages && !isLatestLiveItem;
            if ("role" in item) {
              if (item.kind === "compressionStatus") {
                return (
                  <div
                    key={virtualItemKey}
                    data-ai-virtual-item-key={virtualItemKey}
                    className={disableEnterAnimation ? chat.virtualMessageNoEnter : undefined}
                  >
                    <CompressionDivider message={item} />
                  </div>
                );
              }

              const isExpanded = Boolean(expandedUserMessages[item.id]);
              const isCollapsing = Boolean(collapsingUserMessages[item.id]);
              const shouldShowExpandedContent = isExpanded || isCollapsing;
              const showExpandedButton = isExpanded && !isCollapsing;
              const canCollapse = isLongUserMessage(item.content);
              const mentionRanges = findSubAgentMentionRanges(item.content, subAgents);
              const fileReferenceRanges = findAttachmentReferenceRanges(item.content, item.attachments || []);
              const virtualBlockReferenceRanges = findVirtualBlockLineReferenceRanges(item.content);
              const virtualBlockReferenceFileRanges: FileReferenceRange[] = virtualBlockReferenceRanges.map((range) => ({
                start: range.start,
                end: range.end,
                name: range.text,
                attachmentName: range.text,
                nameStart: range.start,
                nameEnd: range.end,
              }));
              const visibleFileReferenceRanges = [...fileReferenceRanges, ...virtualBlockReferenceFileRanges].sort(
                (left, right) => left.start - right.start || left.end - right.end,
              );
              const guideReferenceRanges = findGuideReferenceRanges(item.content, guides);
              const handleInlineFileClick = (attachmentId?: string, fileName?: string) => {
                const attachment =
                  item.attachments?.find((candidate) => candidate.id === attachmentId) ||
                  item.attachments?.find((candidate) => candidate.name === fileName);
                if (!attachment) {
                  const virtualRange = virtualBlockReferenceRanges.find((range) => range.text === fileName);
                  openVirtualBlockPreview(virtualRange);
                  return;
                }
                if (attachment.kind === "workspace-ucf" || attachment.kind === "workspace-ucf-range") {
                  onOpenWorkspaceAttachment(attachment);
                  return;
                }
                onPreviewAttachment(attachment);
              };
              const renderUserMessageContent = (content: string) =>
                renderMessageInlineNodes(
                  content,
                  mentionRanges,
                  visibleFileReferenceRanges,
                  chat.userMessageMentionToken,
                  chat.userMessageFileToken,
                  handleInlineFileClick,
                  undefined,
                  guideReferenceRanges,
                  chat.userMessageGuideToken,
                );
              return (
                <div
                  key={virtualItemKey}
                  data-ai-virtual-item-key={virtualItemKey}
                  ref={(element) => {
                    userMessageRefs.current[item.id] = element;
                  }}
                  className={`${chat.messageRow} ${chat.userMessage} ${disableEnterAnimation ? chat.virtualMessageNoEnter : ""}`}
                >
                  <div className={`${chat.messageActionRail} ${chat.messageActionRailHorizontal}`}>
                    <button
                      type="button"
                      className={chat.messageActionButton}
                      title="复制消息"
                      aria-label="复制消息"
                      onClick={() => void handleCopy(item.content)}
                    >
                      <CopyIcon aria-hidden="true" />
                    </button>
                    {hasSnapshot(item.id) ? (
                      <button
                        type="button"
                        className={chat.messageActionButton}
                        title="撤回到这里"
                        aria-label="撤回到这里"
                        onClick={() => onRestoreToUserMessage(item.id, item)}
                      >
                        <UndoIcon aria-hidden="true" />
                      </button>
                    ) : null}
                  </div>
                  <div className={chat.messageTurnBody}>
                    <div
                      className={`${chat.messageBubble} ${chat.messageBubbleUser} ${
                        canCollapse ? chat.messageBubbleUserCollapsible : ""
                      } ${canCollapse && shouldShowExpandedContent ? chat.messageBubbleUserExpanded : ""} ${
                        canCollapse && isCollapsing ? chat.messageBubbleUserCollapsing : ""
                      }`}
                    >
                      {canCollapse ? (
                        <div
                          className={`${chat.userMessageTextCrossfade} ${
                            shouldShowExpandedContent ? chat.userMessageTextCrossfadeExpanded : ""
                          }`}
                        >
                          <pre
                            className={`${chat.messageText} ${chat.messageTextCollapsed} ${chat.userMessageTextCollapsedLayer} ${
                              shouldShowExpandedContent
                                ? chat.userMessageTextLayerHidden
                                : chat.userMessageTextLayerVisible
                            }`}
                          >
                            {renderUserMessageContent(item.content)}
                          </pre>
                          <pre
                            className={`${chat.messageText} ${chat.userMessageTextExpandedLayer} ${
                              shouldShowExpandedContent
                                ? chat.userMessageTextLayerVisible
                                : chat.userMessageTextLayerHidden
                            }`}
                          >
                            {renderUserMessageContent(item.content)}
                          </pre>
                        </div>
                      ) : (
                        <pre className={chat.messageText}>{renderUserMessageContent(item.content)}</pre>
                      )}
                      {canCollapse ? (
                        <button
                          type="button"
                          className={`${chat.userMessageExpandButton} ${
                            showExpandedButton ? chat.userMessageExpandButtonExpanded : ""
                          }`}
                          title={showExpandedButton ? "收起消息" : "展开消息"}
                          aria-label={showExpandedButton ? "收起消息" : "展开消息"}
                          aria-expanded={showExpandedButton}
                          onClick={() => toggleUserMessageExpanded(item.id)}
                        >
                          <span aria-hidden="true" />
                          <span aria-hidden="true" />
                        </button>
                      ) : null}
                    </div>
                  </div>
                </div>
              );
            }

            const latestStreamingTextSegmentId = isLatestLiveItem
              ? [...item.segments].reverse().find((segment) => segment.type === "text")?.id
              : undefined;
            const assistantFlowNodes = buildAssistantFlowNodes(item.segments);

            const renderAssistantFlowNode = (segment: AssistantFlowNode): React.ReactNode => {
              if (segment.type === "text") {
                const isStreamingTextSegment = segment.id === latestStreamingTextSegmentId;
                return (
                  <div
                    key={segment.id}
                    className={chat.messageMarkdown}
                  >
                    <AssistantMarkdown
                      content={segment.content}
                      isStreaming={Boolean(isStreamingTextSegment)}
                      subAgents={subAgents}
                      streamKey={segment.id}
                      vm={vm}
                      blockly={blockly}
                      workspace={workspace}
                      onRequestOpenUrl={onRequestOpenUrl}
                    />
                  </div>
                );
              }

              if (segment.type === "reasoning") {
                return (
                  <div
                    key={segment.id}
                    className={`${chat.reasoningInline} ${
                      !segment.isComplete && isLatestLiveItem ? chat.reasoningInlineActive : ""
                    }`}
                  >
                    <button
                      type="button"
                      className={chat.reasoningInlineButton}
                      onClick={() => toggleReasoning(segment.id)}
                    >
                      <span className={chat.reasoningInlineLabel}>
                        {segment.isComplete ? formatReasoningDuration(segment.startedAt, segment.endedAt) : "思考中..."}
                      </span>
                      <span className={chat.reasoningInlineArrow}>
                        <ReasoningChevron expanded={!reasoningPanels[segment.id]?.collapsed} />
                      </span>
                    </button>
                    <div
                      className={`${chat.reasoningInlineBody} ${
                        !reasoningPanels[segment.id]?.collapsed ? chat.reasoningInlineBodyExpanded : ""
                      }`}
                      aria-hidden={Boolean(reasoningPanels[segment.id]?.collapsed)}
                    >
                      <div className={chat.reasoningInlineBodyInner}>
                        <pre className={chat.reasoningText}>{segment.content || "模型正在整理思路..."}</pre>
                      </div>
                    </div>
                  </div>
                );
              }

              if (segment.type === "todo") {
                return (
                  <TodoTaskFlow
                    key={segment.id}
                    node={segment}
                    isLatestLiveItem={isLatestLiveItem}
                    hasChildren={segment.children.length > 0}
                  >
                    {segment.children.map(renderAssistantFlowNode)}
                  </TodoTaskFlow>
                );
              }

              if (segment.type === "userQuestion") {
                return <UserQuestionFlow key={segment.id} node={segment} />;
              }

              if (segment.type === "subAgent") {
                return (
                  <SubAgentTaskFlow key={segment.id} node={segment}>
                    {segment.children.map(renderAssistantFlowNode)}
                  </SubAgentTaskFlow>
                );
              }

              return (
                <ToolCallViewer
                  key={segment.id}
                  toolCalls={segment.toolCalls}
                  toolResults={segment.toolResults}
                  isGenerating={isLatestLiveItem}
                  vm={vm}
                  blockly={blockly}
                />
              );
            };

            return (
              <div
                key={virtualItemKey}
                data-ai-virtual-item-key={virtualItemKey}
                className={`${chat.messageRow} ${chat.assistantMessage} ${isLatestLiveItem ? chat.messageRowLive : ""} ${
                  disableEnterAnimation ? chat.virtualMessageNoEnter : ""
                }`}
              >
                  <div className={chat.messageTurnBody}>
                    <div className={`${chat.messageBubble} ${chat.messageBubbleAssistant}`}>
                      <div className={chat.assistantSegments}>{assistantFlowNodes.map(renderAssistantFlowNode)}</div>
                      {item.sourceMessage.status === "error" ? (
                        <div className={chat.assistantErrorNotice}>
                          <strong>回复中断</strong>
                          <span>{item.sourceMessage.error || "请求未完成。可以点击底部重试继续生成。"}</span>
                        </div>
                      ) : null}
                    </div>
                  </div>
                <div className={chat.messageActionRail}>
                  <button
                    type="button"
                    className={chat.messageActionButton}
                    title="复制消息"
                    aria-label="复制消息"
                    onClick={() => void handleCopy(summarizeAssistantMessageForCopy(item))}
                  >
                    <CopyIcon aria-hidden="true" />
                  </button>
                </div>
              </div>
            );
          })}
          {bottomVirtualSpacerHeight > 0 ? (
            <div className={chat.virtualMessageSpacer} style={{ height: bottomVirtualSpacerHeight }} aria-hidden="true" />
          ) : null}
          </>
        )}
        {latestChangeSummary ? (
          <div className={chat.finalChangeSummary}>
            <div className={chat.finalChangeSummaryHeader}>
              <strong>{latestChangeSummary.files.length} 个文件已更改</strong>
              <span>
                <b className={chat.diffAdded}>+{latestChangeSummary.added}</b>{" "}
                <b className={chat.diffDeleted}>-{latestChangeSummary.deleted}</b>
              </span>
            </div>
            <div className={chat.finalChangeFileList}>
              {latestChangeSummary.files.map((file) => (
                <div key={file.path} className={chat.finalChangeFileItem}>
                  <span>{file.path}</span>
                  <span>
                    <b className={chat.diffAdded}>+{file.added}</b> <b className={chat.diffDeleted}>-{file.deleted}</b>
                    {file.operations ? <em>{file.operations} 个同步操作</em> : null}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ) : null}
        {!isGenerating && displayItems.length > 0 ? (
          <ContextUsageFooter
            usage={contextUsage}
            canRetry={hasRetryableError}
            onRetry={onRetryLastResponse}
            onCompress={onCompressContext}
            isCompressing={isCompressingContext}
          />
        ) : null}
        <div ref={bottomRef} className={chat.bottomAnchor} aria-hidden="true" />
      </div>
      {blockPreviewDialog && typeof document !== "undefined" && document.body
        ? createPortal(
            <BlockReferencePreviewDialog
              title={blockPreviewDialog.reference.path}
              svg={blockPreviewDialog.svg}
              onClose={() => setBlockPreviewDialog(null)}
              onJump={jumpToPreviewBlock}
            />,
            document.body,
          )
        : null}
      {!isStickyToBottom ? (
        <button className={chat.scrollToBottomButton} onClick={() => scrollToBottom()} title="回到底部">
          ↓
        </button>
      ) : null}
    </div>
  );
};
