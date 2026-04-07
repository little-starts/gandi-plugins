import * as React from "react";
import ReactMarkdown from "react-markdown";
import styles from "../styles.less";
import { Attachment, ChatMessage, ToolCall } from "../types";
import { ToolCallViewer } from "./ToolCallViewer";
import { MessageAttachments } from "./MessageAttachments";

interface ChatAreaProps {
  messages: ChatMessage[];
  isGenerating: boolean;
  vm: PluginContext["vm"];
  onOpenWorkspaceAttachment: (attachment: Attachment) => void;
}

type AssistantSegment =
  | { type: "text"; id: string; content: string }
  | { type: "tools"; id: string; toolCalls: ToolCall[]; toolResults: ChatMessage[] };

interface AssistantBubble {
  segments: AssistantSegment[];
}

const collectAssistantBubbles = (messages: ChatMessage[]) => {
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
          const normalizedContent = currentMessage.content?.trim() || "";
          const hasTextContent = Boolean(normalizedContent);

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

      items.push({ segments });
      index = cursor - 1;
      continue;
    }

    items.push(message);
  }

  return items;
};

export const ChatArea: React.FC<ChatAreaProps> = ({ messages, isGenerating, vm, onOpenWorkspaceAttachment }) => {
  const displayItems = React.useMemo(() => collectAssistantBubbles(messages), [messages]);
  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  const [isStickyToBottom, setIsStickyToBottom] = React.useState(true);

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
              <div key={index} className={`${styles.messageRow} ${styles.userMessage}`}>
                <div className={styles.messageAvatar}>你</div>
                <div className={`${styles.messageBubble} ${styles.messageBubbleUser}`}>
                  <div className={styles.messageRoleLabel}>你的消息</div>
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
            <div key={index} className={`${styles.messageRow} ${styles.assistantMessage}`}>
              <div className={styles.messageAvatar}>AI</div>
              <div className={`${styles.messageBubble} ${styles.messageBubbleAssistant}`}>
                <div className={styles.messageRoleLabel}>助手回复</div>
                <div className={styles.assistantSegments}>
                  {item.segments.map((segment) =>
                    segment.type === "text" ? (
                      <div key={segment.id} className={styles.messageMarkdown}>
                        <ReactMarkdown>{segment.content}</ReactMarkdown>
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
            </div>
          );
        })
      )}
      {isGenerating && <div className={styles.generatingTip}>AI 正在思考...</div>}
      {!isStickyToBottom ? (
        <button className={styles.scrollToBottomButton} onClick={() => scrollToBottom()} title="回到底部">
          ↓
        </button>
      ) : null}
    </div>
  );
};
