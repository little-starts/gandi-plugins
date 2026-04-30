import * as React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import styles from "../styles.less";
import { Attachment, ChatMessage, ToolCall } from "../types";
import { ToolCallViewer } from "./ToolCallViewer";
import { MessageAttachments } from "./MessageAttachments";
import ChevronRightIcon from "assets/icon-chevron-right.svg";
import CopyIcon from "assets/icon-copy.svg";
import UndoIcon from "assets/icon-undo.svg";

interface ChatAreaProps {
  messages: ChatMessage[];
  isGenerating: boolean;
  vm: PluginContext["vm"];
  onOpenWorkspaceAttachment: (attachment: Attachment) => void;
  onRestoreToUserMessage: (messageId: string, message: ChatMessage) => void;
  hasSnapshot: (messageId: string) => boolean;
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

  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (message.role === "system" || message.role === "tool") {
      continue;
    }

    if (message.role === "assistant") {
      const segments: AssistantSegment[] = [];
      let cursor = index;

      while (cursor < messages.length && messages[cursor].role !== "user") {
        const currentMessage = messages[cursor];

        if (currentMessage.role === "assistant") {
          const normalizedReasoning = currentMessage.reasoning?.trim() || "";
          const normalizedContent = currentMessage.content?.trim() || "";
          const hasReasoningContent = Boolean(normalizedReasoning);
          const hasTextContent = Boolean(normalizedContent);

          if (hasReasoningContent) {
            segments.push({
              type: "reasoning",
              id: `reasoning-${cursor}`,
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
            cursor === messages.length - 1
          ) {
            segments.push({
              type: "reasoning",
              id: `reasoning-${cursor}`,
              content: "",
              isComplete: false,
              startedAt: currentMessage.reasoningStartedAt,
              endedAt: currentMessage.reasoningEndedAt,
            });
          }

          if (hasTextContent) {
            segments.push({
              type: "text",
              id: `text-${cursor}`,
              content: normalizedContent,
            });
          }

          if (currentMessage.tool_calls?.length) {
            const toolResults: ChatMessage[] = [];
            let resultCursor = cursor + 1;
            while (resultCursor < messages.length && messages[resultCursor].role === "tool") {
              toolResults.push(messages[resultCursor]);
              resultCursor++;
            }

            const previousSegment = segments[segments.length - 1];
            if (previousSegment?.type === "tools" && !hasTextContent) {
              previousSegment.toolCalls.push(...currentMessage.tool_calls);
              previousSegment.toolResults.push(...toolResults);
            } else {
              segments.push({
                type: "tools",
                id: `tools-${cursor}`,
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

export const ChatArea: React.FC<ChatAreaProps> = ({
  messages,
  isGenerating,
  vm,
  onOpenWorkspaceAttachment,
  onRestoreToUserMessage,
  hasSnapshot,
}) => {
  const displayItems = React.useMemo(() => collectAssistantBubbles(messages, isGenerating), [messages, isGenerating]);
  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  const [isStickyToBottom, setIsStickyToBottom] = React.useState(true);
  const [reasoningPanels, setReasoningPanels] = React.useState<Record<string, ReasoningPanelState>>({});

  const scrollToBottom = React.useCallback((behavior: ScrollBehavior = "smooth") => {
    const element = scrollRef.current;
    if (!element) return;
    element.scrollTo({ top: element.scrollHeight, behavior });
  }, []);

  const handleScroll = React.useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;

    const distanceToBottom = element.scrollHeight - element.scrollTop - element.clientHeight;
    setIsStickyToBottom(distanceToBottom <= 24);
  }, []);

  React.useEffect(() => {
    if (isStickyToBottom) {
      scrollToBottom("auto");
    }
  }, [displayItems, isGenerating, isStickyToBottom, scrollToBottom]);

  React.useEffect(() => {
    setReasoningPanels((previous) => {
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

      return changed ? next : previous;
    });
  }, [displayItems]);

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

  return (
    <div className={styles.chatArea} ref={scrollRef} onScroll={handleScroll}>
      {displayItems.length === 0 ? (
        <div className={styles.emptyState}>
          <span className={styles.emptyStateBadge}>AI Assistant</span>
          <h4 className={styles.emptyStateTitle}>把问题、需求或代码片段直接发进来</h4>
          <p className={styles.emptyStateText}>
            可以让它解释积木逻辑、整理上下文、分析附件，或者直接帮助你修改当前工作区内容。
          </p>
        </div>
      ) : (
        displayItems.map((item, index) => {
          if ("role" in item) {
            return (
              <div key={item.id || index} className={`${styles.messageRow} ${styles.userMessage}`}>
                <div className={`${styles.messageActionRail} ${styles.messageActionRailHorizontal}`}>
                  <button
                    type="button"
                    className={styles.messageActionButton}
                    title="复制消息"
                    aria-label="复制消息"
                    onClick={() => void handleCopy(item.content)}
                  >
                    <CopyIcon aria-hidden="true" />
                  </button>
                  {hasSnapshot(item.id) ? (
                    <button
                      type="button"
                      className={styles.messageActionButton}
                      title="撤回到这里"
                      aria-label="撤回到这里"
                      onClick={() => onRestoreToUserMessage(item.id, item)}
                    >
                      <UndoIcon aria-hidden="true" />
                    </button>
                  ) : null}
                </div>
                <div className={styles.messageAvatar}>你</div>
                <div className={`${styles.messageBubble} ${styles.messageBubbleUser}`}>
                  <pre className={styles.messageText}>{item.content}</pre>
                  {item.attachments?.length ? (
                    <MessageAttachments
                      attachments={item.attachments}
                      onOpenAttachment={onOpenWorkspaceAttachment}
                      vm={vm}
                    />
                  ) : null}
                </div>
              </div>
            );
          }

          return (
            <div key={item.sourceMessage.id || index} className={`${styles.messageRow} ${styles.assistantMessage}`}>
              <div className={styles.messageAvatar}>AI</div>
              <div className={`${styles.messageBubble} ${styles.messageBubbleAssistant}`}>
                <div className={styles.assistantSegments}>
                  {item.segments.map((segment) =>
                    segment.type === "text" ? (
                      <div key={segment.id} className={styles.messageMarkdown}>
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>{segment.content}</ReactMarkdown>
                      </div>
                    ) : segment.type === "reasoning" ? (
                      <div key={segment.id} className={styles.reasoningInline}>
                        <button
                          type="button"
                          className={styles.reasoningInlineButton}
                          onClick={() => toggleReasoning(segment.id)}
                        >
                          <span className={styles.reasoningInlineLabel}>
                            {segment.isComplete
                              ? formatReasoningDuration(segment.startedAt, segment.endedAt)
                              : "思考中..."}
                          </span>
                          <span className={styles.reasoningInlineArrow}>
                            <ReasoningChevron expanded={!reasoningPanels[segment.id]?.collapsed} />
                          </span>
                        </button>
                        {!reasoningPanels[segment.id]?.collapsed ? (
                          <div className={styles.reasoningInlineBody}>
                            <pre className={styles.reasoningText}>{segment.content || "模型正在整理思路..."}</pre>
                          </div>
                        ) : null}
                      </div>
                    ) : (
                      <ToolCallViewer
                        key={segment.id}
                        toolCalls={segment.toolCalls}
                        toolResults={segment.toolResults}
                        isGenerating={isGenerating}
                      />
                    ),
                  )}
                </div>
              </div>
              <div className={styles.messageActionRail}>
                <button
                  type="button"
                  className={styles.messageActionButton}
                  title="复制消息"
                  aria-label="复制消息"
                  onClick={() => void handleCopy(summarizeAssistantMessageForCopy(item))}
                >
                  <CopyIcon aria-hidden="true" />
                </button>
              </div>
            </div>
          );
        })
      )}
      {!isStickyToBottom ? (
        <button className={styles.scrollToBottomButton} onClick={() => scrollToBottom()} title="回到底部">
          ↓
        </button>
      ) : null}
    </div>
  );
};
