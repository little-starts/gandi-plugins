import * as React from "react";
import styles from "../styles.less";
import { ChatMessage, ToolCall } from "../types";

interface ToolCallViewerProps {
  toolCalls: ToolCall[];
  toolResults?: ChatMessage[];
  isGenerating?: boolean;
}

type ToolCallStatus = "running" | "success" | "error";

const tryFormatJson = (value: string) => {
  if (!value) return "";

  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
};

const getToolCallStatus = (result?: ChatMessage): ToolCallStatus => {
  if (!result) return "running";
  if (result.content.startsWith("Error:")) return "error";

  try {
    const parsed = JSON.parse(result.content);
    if (parsed && typeof parsed === "object" && "success" in parsed) {
      return parsed.success ? "success" : "error";
    }
  } catch {
    return "success";
  }

  return "success";
};

const buildEntries = (toolCalls: ToolCall[], toolResults: ChatMessage[]) =>
  toolCalls.map((toolCall) => {
    const result = toolResults.find((item) => item.tool_call_id === toolCall.id);
    return {
      id: toolCall.id,
      name: toolCall.function.name,
      rawArguments: toolCall.function.arguments,
      formattedArguments: tryFormatJson(toolCall.function.arguments),
      rawResult: result?.content || "",
      formattedResult: tryFormatJson(result?.content || ""),
      status: getToolCallStatus(result),
    };
  });

const STATUS_LABELS: Record<ToolCallStatus, string> = {
  running: "执行中",
  success: "成功",
  error: "错误",
};

export const ToolCallViewer: React.FC<ToolCallViewerProps> = ({
  toolCalls,
  toolResults = [],
  isGenerating = false,
}) => {
  const [expanded, setExpanded] = React.useState(false);
  const [expandedDetails, setExpandedDetails] = React.useState<Record<string, boolean>>({});

  const entries = React.useMemo(() => buildEntries(toolCalls, toolResults), [toolCalls, toolResults]);
  const runningCount = entries.filter((entry) => entry.status === "running").length;
  const errorCount = entries.filter((entry) => entry.status === "error").length;

  const toggleDetail = (id: string) => {
    setExpandedDetails((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  return (
    <div className={styles.toolCallSummary}>
      <div className={styles.toolCallSummaryHeader} onClick={() => setExpanded((prev) => !prev)}>
        <span className={styles.toggleIcon}>{expanded ? "▼" : "▶"}</span>
        <span>
          本轮调用了 {entries.length} 个工具
          {runningCount > 0 ? `，${runningCount} 个执行中` : ""}
          {errorCount > 0 ? `，${errorCount} 个失败` : ""}
          {isGenerating && runningCount === 0 ? "，等待模型继续处理" : ""}
        </span>
      </div>
      {expanded ? (
        <div className={styles.toolCallList}>
          {entries.map((entry) => (
            <div key={entry.id} className={styles.toolCallItem}>
              <div className={styles.toolCallItemHeader} onClick={() => toggleDetail(entry.id)}>
                <span className={styles.toggleIcon}>{expandedDetails[entry.id] ? "▼" : "▶"}</span>
                <span className={`${styles.toolCallStatus} ${styles[`toolCallStatus${entry.status}`]}`}>
                  {STATUS_LABELS[entry.status]}
                </span>
                <span className={styles.toolCallName}>{entry.name}</span>
              </div>
              {expandedDetails[entry.id] ? (
                <div className={styles.toolCallDetail}>
                  <div className={styles.toolCallSection}>
                    <div className={styles.toolCallSectionTitle}>调用参数</div>
                    <pre>{entry.formattedArguments || "{}"}</pre>
                  </div>
                  <div className={styles.toolCallSection}>
                    <div className={styles.toolCallSectionTitle}>返回结果</div>
                    <pre>{entry.formattedResult || (entry.status === "running" ? "执行中..." : "无返回内容")}</pre>
                  </div>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
};
