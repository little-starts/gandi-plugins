import { SetStateAction, useEffect, useRef, useState } from "react";
import {
  FlattenedAgent,
  Attachment,
  AiGuideVerificationMode,
  ChatMessage,
  ContextUsageInfo,
  DefaultCostumeType,
  ImageGenerationModelConfig,
  PendingUserQuestion,
  PendingUserQuestionItem,
  ReasoningEffort,
  StageScreenshotMode,
  SubAgentProfile,
  SubAgentToolGroup,
  ToolCall,
  UserGuide,
  UserQuestionAnswer,
  UserQuestionOption,
} from "../types";
import { AITools } from "../tools";
import { scratchToolSchemas } from "../toolSchemas";
import {
  ChatCompletionUsage,
  generateImageWithOpenAICompatibleModel,
  getProviderAdapter,
  isProviderImplemented,
} from "../providerAdapters";
import {
  getAllGuides,
  getEnabledGuideSystemText,
  getRuntimeExtensionGuides,
} from "../guideRegistry";
import { buildMemorySystemText, listMemoryBlocks } from "../memoryStore";
import {
  ExamplePromptSet,
  normalizeExamplePromptSet,
  parseProjectExamplePrompts,
  serializeProjectExamplePrompts,
} from "../examplePrompts";
import { EDIT_BUILTIN_TOOL_NAMES, GAME_BUILTIN_TOOL_NAMES, READ_BUILTIN_TOOL_NAMES } from "../subAgentConfig";
import { createProjectSnapshot, getRuntimeBlockCount, LARGE_PROJECT_ROLLBACK_BLOCK_THRESHOLD } from "../projectSnapshot";
import {
  activateStageTakeover,
  getStageScriptPartialResult,
  normalizeStageComputerUseLimits,
  observeStage,
  runStageScript,
} from "../stageComputerUse";
import { buildModelContentWithReferences } from "../mentionUtils";
import { showAssistantAlert } from "../components/AssistantDialogHost";

interface UseChatOptions {
  messages: ChatMessage[];
  currentAgent: FlattenedAgent | null;
  updateSessionMessages: (newMessages: ChatMessage[], targetSessionId?: string) => string;
  createChatSession: (newMessages: ChatMessage[], title?: string) => string;
  appendSessionSnapshot: (
    snapshot: {
      messageId: string;
      projectData?: ArrayBuffer;
      attachments: Attachment[];
      inputText: string;
      createdAt: number;
    },
    targetSessionId?: string,
  ) => void;
  enableReasoning: boolean;
  reasoningEffort?: ReasoningEffort;
  vm: any;
  blockly?: any;
  workspace: Blockly.WorkspaceSvg;
  utils: PluginContext["utils"];
  userGuides?: UserGuide[];
  createAiGuide?: (guide: Partial<UserGuide>) => UserGuide;
  aiGuideVerificationMode?: AiGuideVerificationMode;
  subAgents?: SubAgentProfile[];
  allowSubAgents?: boolean;
  defaultCostumeType?: DefaultCostumeType;
  stageScreenshotMode?: StageScreenshotMode;
  imageGenerationModel?: ImageGenerationModelConfig | null;
  conversationMode?: "chat" | "code";
}

const createMessageId = () => `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const STREAM_MESSAGE_FLUSH_MS = 80;
const DEFAULT_CONTEXT_LIMIT_TOKENS = 128000;
const AUTO_CONTEXT_COMPRESSION_THRESHOLD_PERCENT = 90;
const AUTO_CONTEXT_COMPRESSION_ERROR_CODE = "AI_ASSISTANT_AUTO_CONTEXT_COMPRESSION";
const RETRY_CONTINUATION_PROMPT =
  "上一轮回复在传输过程中中断。请基于上方已经生成的 assistant 内容继续完成回复；不要重复已经完整写出的内容。如果需要继续工具调用，请从当前上下文继续。";
const AUTO_CONTEXT_CONTINUATION_PROMPT =
  "上下文已自动压缩。请根据上方历史摘要继续完成刚才被中断的当前任务；不要重复已经完整完成的内容，直接从当前进度继续。";
const SUBAGENT_CONTEXT_CONTINUATION_PROMPT =
  "子智能体上下文已自动压缩。请根据上方历史摘要继续完成当前委托任务；不要重复已经完整完成的内容，直接从当前进度继续。";
const COMPRESSION_SUMMARY_SYSTEM_PROMPT =
  "你正在为当前对话生成后续会话可用的上下文摘要。请保留用户目标、已做决定、项目结构理解、已修改/涉及文件、关键约束、未完成事项、错误与验证结果。用中文输出，简洁但足够让新会话继续工作；不要输出寒暄。";
const STAGE_IMAGE_MEMORY_SYSTEM_PROMPT =
  "你正在为 Scratch 游戏测试中的舞台截图生成临时视觉记忆。请只描述截图中对后续操作有用的信息：界面布局、可交互元素、文本、数值、卡牌/角色状态、位置关系、明显变化和下一步可用线索。用中文，简洁但具体；不要寒暄，不要说你无法操作。";
const SUBAGENT_STREAM_INTERRUPTION_RETRY_LIMIT = 3;
const SUBAGENT_STREAM_INTERRUPTION_COMPRESSION_TRIM_PERCENT = 10;
const MAIN_CONTEXT_COMPRESSION_RETRY_TRIM_PERCENT = 15;
const NETWORK_RETRY_DELAYS_MS = [3000, 9000, 21000];
const AI_GUIDE_AUTO_REVIEW_TIMEOUT_MS = 45000;
const PROJECT_INDEX_BLOCKED_TOOL_MESSAGE = '项目索引尚未构建，请先点击“构建项目索引”。';
const PROJECT_INDEX_LARGE_SCRIPT_THRESHOLD = 24;
const PROJECT_INDEX_LARGE_BLOCK_THRESHOLD = 800;
const PROJECT_INDEX_LARGE_CODE_CHARS_THRESHOLD = 80000;
const PROJECT_INDEX_CONTINUE_PROMPT = "请持续构建，直到构建完全完成后主动调用成功的工具";
const PROJECT_INDEX_MEMORY_ID = "project-index-understanding";
const PROJECT_INDEX_MEMORY_MAX_CHARS = 5000;
const PROJECT_INDEX_BLOCKED_TOOL_NAMES = new Set([
  "listFiles",
  "readFile",
  "searchFiles",
  "applyPatch",
  "getDiagnostics",
  "discardDraft",
  "insertCostume",
  "updateCostume",
  "deleteCostume",
]);
const CHAT_MODE_BLOCKED_TOOL_MESSAGE =
  "当前为 Chat 模式，本轮不能修改项目内容。可以读取和分析项目；如需应用补丁、丢弃草稿、改动造型或加载扩展，请切换到 Code 模式。";
const CHAT_MODE_BLOCKED_TOOL_NAMES = new Set([
  "applyPatch",
  "discardDraft",
  "insertCostume",
  "updateCostume",
  "deleteCostume",
  "addExtension",
]);

const truncateProjectIndexText = (value: string, maxLength: number) => {
  const text = String(value || "").trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 18)).trimEnd()}\n...内容已截断`;
};

const buildProjectIndexMemoryContent = (projectUnderstanding: string, targetPlans: any[], examplePrompts?: ExamplePromptSet | null) => {
  const groupingLines = (targetPlans || []).flatMap((targetPlan: any) => {
    const targetName = String(targetPlan?.targetName || targetPlan?.targetId || "target");
    const files = Array.isArray(targetPlan?.files) ? targetPlan.files : [];
    return [
      `## ${targetName}`,
      `默认新增脚本文件：${String(targetPlan?.defaultScriptFileName || "default.js")}`,
      ...files.map((file: any) => {
        const scriptCount = Array.isArray(file?.scriptIds) ? file.scriptIds.length : 0;
        const description = String(file?.description || "").trim();
        return `- ${String(file?.fileName || "default.js")}：${description || "未填写功能描述"}（${scriptCount} 段脚本）`;
      }),
      "",
    ];
  });
  const content = [
    "# 项目索引理解",
    "",
    truncateProjectIndexText(projectUnderstanding, 3000),
    "",
    serializeProjectExamplePrompts(examplePrompts),
    "",
    "# 功能文件分组",
    "",
    ...groupingLines,
  ].join("\n");
  return truncateProjectIndexText(content, PROJECT_INDEX_MEMORY_MAX_CHARS);
};

const createAutoContextCompressionError = () =>
  Object.assign(new Error("AI context reached the automatic compression threshold."), {
    code: AUTO_CONTEXT_COMPRESSION_ERROR_CODE,
  });

const isAutoContextCompressionError = (error: unknown) =>
  Boolean(error && typeof error === "object" && (error as { code?: string }).code === AUTO_CONTEXT_COMPRESSION_ERROR_CODE);

const isUpstreamInterruptionError = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error || "");
  return /stream ended|ended before completion|connection was dropped|upstream/i.test(message);
};

const isNetworkRetryableError = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error || "");
  return /failed to fetch|network error/i.test(message);
};

const isChatRequestRetryableError = (error: unknown) =>
  isNetworkRetryableError(error) || isUpstreamInterruptionError(error);

const waitForRetryDelay = (delayMs: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason || new DOMException("Aborted", "AbortError"));
      return;
    }
    const handleAbort = () => {
      window.clearTimeout(timer);
      reject(signal?.reason || new DOMException("Aborted", "AbortError"));
    };
    const timer = window.setTimeout(() => {
      signal?.removeEventListener("abort", handleAbort);
      resolve();
    }, delayMs);
    signal?.addEventListener("abort", handleAbort, { once: true });
  });

const getNetworkRetryNotice = (delayMs: number, attemptIndex: number, error: unknown) =>
  `AI request failed: ${error instanceof Error ? error.message : String(error || "Failed to fetch")}\nRetrying in ${Math.round(
    delayMs / 1000,
  )}s (${attemptIndex + 1}/${NETWORK_RETRY_DELAYS_MS.length})...`;

const isCompressionFallbackError = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error || "");
  return (
    isUpstreamInterruptionError(error) ||
    /summary.*empty|empty.*summary|failed to fetch|network|context length|too many tokens|token limit/i.test(message)
  );
};

const estimateTextTokens = (value: string) => Math.ceil(value.length / 3.2);

const estimateStageImageTokens = (message: ChatMessage) => {
  const imageCount = (message.stageObservation ? 1 : 0) + (message.stageObservations?.length || 0);
  return imageCount * 3000;
};

const getMessageContentForModel = (message: ChatMessage) => {
  if (message.role === "tool" && message.name === "runSubAgent") {
    if (message.modelContent) return message.modelContent;
    try {
      const parsed = JSON.parse(message.content || "{}");
      const summary = String(parsed?.summary || parsed?.error || "").trim();
      if (summary) return `Sub agent summary: ${summary}`;
    } catch (_error) {
      const content = String(message.content || "").trim();
      if (content.startsWith("Error:")) return content;
    }
    return "Sub agent execution result omitted from model context.";
  }
  return message.modelContent ?? message.content ?? "";
};

const estimateMessageTokens = (message: ChatMessage) => {
  const contentForModel = getMessageContentForModel(message);
  const attachmentTokens = (message.attachments || []).reduce(
    (sum, attachment) => {
      if (attachment.kind === "workspace-ucf" || attachment.kind === "workspace-ucf-range") {
        return sum + estimateTextTokens(`${attachment.name}\n${attachment.kind}\n${JSON.stringify(attachment.meta || {})}`);
      }
      return sum + estimateTextTokens(`${attachment.name}\n${attachment.content || attachment.preview || ""}`);
    },
    0,
  );
  const toolCallTokens = (message.tool_calls || []).reduce(
    (sum, toolCall) => sum + estimateTextTokens(`${toolCall.function.name}\n${toolCall.function.arguments}`),
    0,
  );
  return (
    estimateTextTokens(contentForModel) +
    estimateTextTokens(message.reasoning || "") +
    attachmentTokens +
    toolCallTokens +
    estimateStageImageTokens(message) +
    8
  );
};

const isEmptyAssistantPlaceholder = (message: ChatMessage) =>
  message.role === "assistant" &&
  !message.status &&
  !(message.content || "").trim() &&
  !(message.modelContent || "").trim() &&
  !message.reasoning &&
  !message.tool_calls?.length &&
  !message.attachments?.length &&
  !message.stageObservation &&
  !message.stageObservations?.length;

const shouldSendToProvider = (message: ChatMessage) =>
  !message.excludeFromModel && message.kind !== "compressionStatus" && !isEmptyAssistantPlaceholder(message);

const estimateContextUsage = (messages: ChatMessage[], currentAgent: FlattenedAgent | null): ContextUsageInfo => {
  const usedTokens = messages.filter(shouldSendToProvider).reduce((sum, message) => sum + estimateMessageTokens(message), 0);
  const limitTokens = currentAgent?.maxTokens || DEFAULT_CONTEXT_LIMIT_TOKENS;
  return {
    usedTokens,
    limitTokens,
    percent: Math.min(100, Math.round((usedTokens / limitTokens) * 100)),
    isEstimate: true,
    updatedAt: Date.now(),
  };
};

const isSameContextUsage = (left: ContextUsageInfo, right: ContextUsageInfo) =>
  left.usedTokens === right.usedTokens &&
  left.limitTokens === right.limitTokens &&
  left.percent === right.percent &&
  left.isEstimate === right.isEstimate;

const getUsageUsedTokens = (usage?: ChatCompletionUsage) => {
  if (!usage) return null;
  if (typeof usage.total_tokens === "number") return usage.total_tokens;
  const promptTokens = typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : usage.input_tokens;
  const completionTokens = typeof usage.completion_tokens === "number" ? usage.completion_tokens : usage.output_tokens;
  if (typeof promptTokens === "number" && typeof completionTokens === "number") return promptTokens + completionTokens;
  if (typeof promptTokens === "number") return promptTokens;
  return null;
};

const isVisionModel = (_agent: FlattenedAgent | null) => true;

const contextUsageFromProviderUsage = (
  usage: ChatCompletionUsage | undefined,
  currentAgent: FlattenedAgent | null,
): ContextUsageInfo | null => {
  const usedTokens = getUsageUsedTokens(usage);
  if (usedTokens === null) return null;
  const limitTokens = currentAgent?.maxTokens || DEFAULT_CONTEXT_LIMIT_TOKENS;
  return {
    usedTokens,
    limitTokens,
    percent: Math.min(100, Math.round((usedTokens / limitTokens) * 100)),
    isEstimate: false,
    updatedAt: Date.now(),
  };
};

const trimMessagesForCompressionRequest = (
  messages: ChatMessage[],
  currentAgent: FlattenedAgent | null,
  trimPercent: number,
) => {
  if (trimPercent <= 0) return messages;
  const removableMessages = messages.filter((message) => shouldSendToProvider(message) && message.role !== "user");
  const tokensToTrim = Math.ceil(estimateContextUsage(messages, currentAgent).usedTokens * (trimPercent / 100));
  let trimmedTokens = 0;
  const trimmedIds = new Set<string>();

  for (const message of removableMessages) {
    if (trimmedTokens >= tokensToTrim) break;
    trimmedTokens += estimateMessageTokens(message);
    trimmedIds.add(message.id);
  }

  return messages.map((message) =>
    trimmedIds.has(message.id)
      ? {
          ...message,
          excludeFromModel: true,
        }
      : message,
  );
};

const omitStageImagesForModel = (messages: ChatMessage[]) =>
  messages.map((message) =>
    message.stageObservation || message.stageObservations?.length
      ? {
          ...message,
          modelContent: message.modelContent || "Stage screenshot(s) omitted from retry context.",
          stageObservation: undefined,
          stageObservations: undefined,
        }
      : message,
  );

const findLastRetryableAssistantIndex = (messages: ChatMessage[]) => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === "assistant" && message.status === "error") return index;
  }
  return -1;
};

const isErrorOnlyAssistantMessage = (message: ChatMessage) => {
  if (message.role !== "assistant" || message.status !== "error") return false;
  if (message.reasoning || message.tool_calls?.length || message.attachments?.length) return false;
  const content = (message.content || "").trim();
  if (!content) return true;
  if (message.error && (content === message.error || content === `Error: ${message.error}`)) return true;
  return /^Error[:：]/i.test(content);
};

const prepareMessagesForRetry = (messages: ChatMessage[]) =>
  stripIncompleteTailToolCalls(messages.filter((message) => !isErrorOnlyAssistantMessage(message))).map((message) =>
    message.status === "error"
      ? {
          ...message,
          status: undefined,
          error: undefined,
        }
      : message,
  );

const stripIncompleteTailToolCalls = (messages: ChatMessage[]) => {
  const lastRetryableIndex = findLastRetryableAssistantIndex(messages);
  if (lastRetryableIndex < 0) return messages;
  return messages.map((message, index) => {
    if (index !== lastRetryableIndex || !message.tool_calls?.length) return message;
    const hasMissingToolResult = message.tool_calls.some(
      (toolCall) => !messages.some((candidate) => candidate.role === "tool" && candidate.tool_call_id === toolCall.id),
    );
    if (!hasMissingToolResult) return message;
    return {
      ...message,
      tool_calls: undefined,
    };
  });
};

const materializeIncompleteToolCallsAsInterrupted = (messages: ChatMessage[], reason: string) => {
  const existingToolResultIds = new Set(
    messages
      .filter((message) => message.role === "tool" && message.tool_call_id)
      .map((message) => message.tool_call_id as string),
  );
  const nextMessages: ChatMessage[] = [];

  messages.forEach((message) => {
    nextMessages.push(message);
    if (message.role !== "assistant" || !message.tool_calls?.length) return;

    message.tool_calls.forEach((toolCall) => {
      if (existingToolResultIds.has(toolCall.id)) return;
      existingToolResultIds.add(toolCall.id);
      nextMessages.push({
        id: createMessageId(),
        role: "tool",
        tool_call_id: toolCall.id,
        name: toolCall.function.name,
        content: `Error: ${reason || "Tool call was interrupted before execution."}`,
        modelContent: "Tool call was interrupted before execution.",
      });
    });
  });

  return nextMessages;
};

const stripUnansweredAssistantToolCalls = (messages: ChatMessage[]) =>
  messages.map((message) => {
    if (message.role !== "assistant" || !message.tool_calls?.length) return message;
    const hasMissingToolResult = message.tool_calls.some(
      (toolCall) => !messages.some((candidate) => candidate.role === "tool" && candidate.tool_call_id === toolCall.id),
    );
    return hasMissingToolResult
      ? {
          ...message,
          tool_calls: undefined,
        }
      : message;
  });

const stripCompletedSubAgentToolArguments = (messages: ChatMessage[], toolCallId: string) =>
  messages.map((message) => {
    if (message.role !== "assistant" || !message.tool_calls?.length) return message;
    const toolCalls = message.tool_calls.map((toolCall) =>
      toolCall.id === toolCallId && toolCall.function.name === "runSubAgent"
        ? {
            ...toolCall,
            function: {
              ...toolCall.function,
              arguments: "{}",
            },
          }
        : toolCall,
    );
    return {
      ...message,
      tool_calls: toolCalls,
    };
  });

const buildSessionSnapshot = async (
  vm: any,
  messageId: string,
  inputText: string,
  attachments: Attachment[],
  createdAt = Date.now(),
) => {
  const blockCount = getRuntimeBlockCount(vm);
  const isLargeProject = typeof blockCount === "number" && blockCount >= LARGE_PROJECT_ROLLBACK_BLOCK_THRESHOLD;
  const snapshot = isLargeProject ? null : await createProjectSnapshot(vm, { skipLargeProject: true });
  return {
    messageId,
    projectData: snapshot?.projectData,
    targetCount: snapshot?.targetCount,
    blockCount: snapshot?.blockCount || blockCount,
    projectRollbackSkipped: isLargeProject || !snapshot?.projectData,
    projectRollbackSkipReason: isLargeProject
      ? `当前作品包含约 ${blockCount} 个积木，属于大型项目；为避免 Scratch VM 加载大型快照导致角色丢失，撤回时仅回滚对话。`
      : !snapshot?.projectData
        ? "无法创建安全的 SB3 项目快照；撤回时仅回滚对话。"
        : undefined,
    attachments,
    inputText,
    createdAt,
  };
};

const safeParseJson = (value: string) => {
  if (!value) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
};

const serializeToolResultForDisplay = (functionName: string, result: unknown) => {
  if (functionName === "observeStage") {
    const image = getStageObservationFromResult(result);
    return JSON.stringify({ success: true, isRunning: Boolean((result as any)?.isRunning), message: "Stage screenshot captured.", image });
  }
  if (functionName === "runStageScript" && result && typeof result === "object") {
    const screenshots = Array.isArray((result as any).screenshots) ? (result as any).screenshots.length : 0;
    return JSON.stringify({
      success: (result as any).success !== false,
      actions: (result as any).actions,
      elapsedMs: (result as any).elapsedMs,
      screenshots,
      error: (result as any).error,
      failedActionIndex: (result as any).failedActionIndex,
      failedAction: (result as any).failedAction,
    });
  }
  return typeof result === "object" ? JSON.stringify(result) : String(result);
};

const compactDiagnosticItemForModel = (item: any) => ({
  path: item?.path,
  valid: Boolean(item?.valid),
  syncStatus: item?.syncStatus,
  errorCount: Array.isArray(item?.errors) ? item.errors.length : 0,
  warningCount: Array.isArray(item?.warnings) ? item.warnings.length : 0,
  errors: Array.isArray(item?.errors) ? item.errors.slice(0, 8) : [],
  warnings: Array.isArray(item?.warnings) ? item.warnings.slice(0, 5) : [],
  repairHint: item?.repairHint,
});

const compactDiagnosticsResultForModel = (result: any) => {
  const diagnostics = Array.isArray(result?.diagnostics) ? result.diagnostics : [];
  const invalidOrWarned = diagnostics.filter(
    (item: any) => !item?.valid || (Array.isArray(item?.warnings) && item.warnings.length > 0),
  );
  return {
    success: result?.success !== false,
    valid: Boolean(result?.valid),
    error: result?.error,
    summary: result?.summary,
    checkedFileCount: diagnostics.length,
    omittedReadOnlyLegacyViews: result?.omittedReadOnlyLegacyViews,
    hint: result?.hint,
    diagnostics: invalidOrWarned.slice(0, 20).map(compactDiagnosticItemForModel),
    omittedDiagnosticCount: Math.max(0, invalidOrWarned.length - 20),
  };
};

const compactSyncResultForModel = (item: any) => ({
  path: item?.path || item?.newPath || item?.operations?.[0]?.path || item?.operations?.[0]?.newPath,
  targetId: item?.targetId,
  operationCount: item?.operationCount,
  type: item?.type,
  success: item?.success,
  error: item?.error,
  operations: Array.isArray(item?.operations)
    ? item.operations.slice(0, 8).map((operation: any) => ({
        type: operation?.type,
        path: operation?.path || operation?.newPath,
        scriptId: operation?.scriptId,
        targetId: operation?.targetId,
        success: operation?.success,
        error: operation?.error,
        insertedTopBlockId: operation?.result?.insertedTopBlockId,
      }))
    : undefined,
});

const compactApplyPatchResultForModel = (result: any) => {
  const diagnostics = Array.isArray(result?.diagnostics) ? result.diagnostics : [];
  const invalidOrWarned = diagnostics.filter(
    (item: any) => !item?.valid || (Array.isArray(item?.warnings) && item.warnings.length > 0),
  );
  const syncResults = Array.isArray(result?.syncResults) ? result.syncResults : [];
  const normalizedDiffs = Array.isArray(result?.normalizedDiffs) ? result.normalizedDiffs : [];
  return {
    success: result?.success !== false,
    error: result?.error,
    changedFiles: Array.isArray(result?.changedFiles) ? result.changedFiles : [],
    fileCount: result?.fileCount,
    operationCount: result?.operationCount ?? result?.scriptOperationCount,
    rolledBack: result?.rolledBack,
    preservedDrafts: result?.preservedDrafts,
    repairHints: Array.isArray(result?.repairHints) ? result.repairHints.slice(0, 10) : undefined,
    diagnosticsSummary: result?.diagnosticsSummary,
    diagnostics: invalidOrWarned.slice(0, 20).map(compactDiagnosticItemForModel),
    omittedDiagnosticCount: Math.max(0, invalidOrWarned.length - 20),
    syncResults: syncResults.slice(0, 20).map(compactSyncResultForModel),
    omittedSyncResultCount: Math.max(0, syncResults.length - 20),
    normalizedDiffCount: normalizedDiffs.length,
    normalizedDiffs: normalizedDiffs.slice(0, 5).map((diff: any) => ({
      path: diff?.path,
      direction: diff?.direction,
      severity: diff?.severity,
      message: diff?.message,
    })),
  };
};

const compactTodoResultForModel = (result: any) => {
  const todos = Array.isArray(result?.todos) ? result.todos : [];
  return {
    success: result?.success !== false,
    activeTodo: result?.activeTodo
      ? {
          id: result.activeTodo.id,
          title: result.activeTodo.title,
          status: result.activeTodo.status,
        }
      : null,
    completed: result?.completed,
    total: result?.total,
    summary: result?.summary,
    statusCounts: todos.reduce((acc: Record<string, number>, todo: any) => {
      const status = String(todo?.status || "pending");
      acc[status] = (acc[status] || 0) + 1;
      return acc;
    }, {}),
  };
};

const attachStageImagesToToolMessage = (
  subMessages: ChatMessage[],
  toolMessageIndex: number,
  functionName: string,
  result: unknown,
  modelToolResult: string,
) => {
  const stageObservation = functionName === "observeStage" ? getStageObservationFromResult(result) : undefined;
  const stageObservations = functionName === "runStageScript" ? getStageObservationsFromResult(result) : undefined;
  if (
    (functionName === "observeStage" && (result as any)?.image?.dataUrl) ||
    (functionName === "runStageScript" && stageObservations?.length)
  ) {
    subMessages.forEach((message) => {
      if (message.stageObservation || message.stageObservations?.length) {
        message.modelContent = "Previous stage screenshot(s) omitted; use the latest stage image message.";
        message.stageObservation = undefined;
        message.stageObservations = undefined;
      }
    });
  }
  subMessages[toolMessageIndex] = {
    ...subMessages[toolMessageIndex],
    modelContent: modelToolResult,
    stageObservation,
    stageObservationForDisplay: stageObservation,
    stageObservations,
    stageObservationsForDisplay: stageObservations,
  };
};

const getStageObservationFromResult = (result: unknown) => {
  const image = (result as any)?.image;
  const dataUrl = typeof image?.dataUrl === "string" ? image.dataUrl : "";
  if (!dataUrl) return undefined;
  return {
    mimeType: typeof image?.mimeType === "string" ? image.mimeType : "image/png",
    dataUrl,
  };
};

const getStageObservationsFromResult = (result: unknown) => {
  const screenshots = Array.isArray((result as any)?.screenshots) ? (result as any).screenshots : [];
  return screenshots
    .map((image: any) => {
      const dataUrl = typeof image?.dataUrl === "string" ? image.dataUrl : "";
      if (!dataUrl) return null;
      return {
        mimeType: typeof image?.mimeType === "string" ? image.mimeType : "image/png",
        dataUrl,
      };
    })
    .filter(Boolean) as NonNullable<ChatMessage["stageObservations"]>;
};

const getMessageStageImages = (message: ChatMessage) =>
  [message.stageObservation, ...(message.stageObservations || [])].filter(Boolean) as Array<{ mimeType: string; dataUrl: string }>;

const createStageObservationProviderMessage = (message: ChatMessage) => ({
  role: "user",
  content: getMessageStageImages(message).map((image) => ({
    type: "image_url",
    image_url: {
      url: image.dataUrl,
    },
  })),
});

const buildStageImageMemoryMessages = (message: ChatMessage) => [
  {
    id: createMessageId(),
    role: "system" as const,
    content: STAGE_IMAGE_MEMORY_SYSTEM_PROMPT,
  },
  {
    id: createMessageId(),
    role: "user" as const,
    content: [
      {
        type: "text",
        text: `工具 ${message.name || message.tool_call_id || "stage"} 返回了舞台截图。请生成后续可替代图片上下文的临时视觉记忆。工具文本结果：${message.modelContent || message.content || ""}`,
      },
      ...getMessageStageImages(message).map((image) => ({
        type: "image_url",
        image_url: {
          url: image.dataUrl,
        },
      })),
    ],
  },
];

const toProviderMessage = (message: ChatMessage, content: string, includeAssistantMetadata = false) => ({
  role: message.role,
  content,
  ...(includeAssistantMetadata && message.reasoning
    ? {
        reasoning: message.reasoning,
      }
    : {}),
  ...(includeAssistantMetadata && message.anthropic_content_blocks?.length
    ? {
        anthropic_content_blocks: message.anthropic_content_blocks,
      }
    : {}),
  ...(message.tool_calls?.length
    ? {
        tool_calls: message.tool_calls.map((toolCall) => ({
          id: toolCall.id,
          type: toolCall.type || "function",
          function: toolCall.function,
        })),
      }
    : {}),
  ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {}),
  ...(message.name ? { name: message.name } : {}),
});

const buildRequestMessages = (messages: ChatMessage[], includeAssistantMetadata = false) =>
  messages.filter(shouldSendToProvider).flatMap((message) => {
    const messageContent = getMessageContentForModel(message);
    const providerMessage = toProviderMessage(message, messageContent, includeAssistantMetadata);
    return getMessageStageImages(message).length
      ? [providerMessage, createStageObservationProviderMessage(message)]
      : [providerMessage];
  });

const buildCompressionMessages = (messages: ChatMessage[]) =>
  messages
    .filter((message) => !message.hidden && message.kind !== "compressionStatus" && message.kind !== "contextSummary")
    .map((message) => {
      if (message.role === "tool") {
        return `工具 ${message.name || message.tool_call_id || "unknown"}: ${message.modelContent ?? message.content}`;
      }
      const attachments = message.attachments?.length
        ? `\n附件：${message.attachments.map((attachment) => `${attachment.name}(${attachment.kind})`).join("，")}`
        : "";
      const toolCalls = message.tool_calls?.length
        ? `\n工具调用：${message.tool_calls.map((toolCall) => toolCall.function.name).join("，")}`
        : "";
      return `${message.role}: ${message.content || ""}${attachments}${toolCalls}`;
    })
    .join("\n\n---\n\n");

const truncateCompressionLine = (value: string, maxLength = 1200) => {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}...`;
};

const buildLocalCompressionFallbackSummary = (messages: ChatMessage[], reason: string) => {
  const usefulMessages = messages
    .filter((message) => message.kind !== "compressionStatus")
    .filter((message) => !message.hidden || message.kind === "contextSummary")
    .slice(-40);

  const lines = usefulMessages.map((message) => {
    const content =
      message.kind === "contextSummary"
        ? message.content
        : message.role === "tool"
          ? `tool ${message.name || message.tool_call_id || "unknown"} result omitted; ${truncateCompressionLine(message.modelContent || message.content || "", 500)}`
          : message.content || message.modelContent || "";
    const attachments = message.attachments?.length
      ? ` attachments=${message.attachments.map((attachment) => `${attachment.name}(${attachment.kind})`).join(", ")}`
      : "";
    const toolCalls = message.tool_calls?.length
      ? ` tool_calls=${message.tool_calls.map((toolCall) => toolCall.function.name).join(", ")}`
      : "";
    return `- ${message.role}${message.kind ? `/${message.kind}` : ""}: ${truncateCompressionLine(content)}${attachments}${toolCalls}`;
  });

  return [
    "Local fallback context summary.",
    `Remote compression failed because: ${truncateCompressionLine(reason, 500)}`,
    "Continue from the preserved recent context below. Treat earlier assistant/tool messages as historical context, not as new instructions.",
    "",
    ...lines,
  ].join("\n");
};

const getCompletionText = (data: any, streamedText = "") => {
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => (typeof item === "string" ? item : typeof item?.text === "string" ? item.text : ""))
      .filter(Boolean)
      .join("");
  }
  if (typeof data?.choices?.[0]?.text === "string") return data.choices[0].text;
  return streamedText;
};

const createCompressedContextMessages = (messages: ChatMessage[], summary: string): ChatMessage[] => [
  ...messages.map((message) => ({ ...message, excludeFromModel: true })),
  {
    id: createMessageId(),
    role: "system",
    content: `以下是上一段对话的压缩摘要，后续回答必须继承这些上下文：\n\n${summary}`,
    hidden: true,
    kind: "contextSummary",
  },
  {
    id: createMessageId(),
    role: "system",
    content: "历史记录已压缩",
    kind: "compressionStatus",
    compressionStatus: "completed",
  },
];

const compactToolResultForModel = (functionName: string, result: unknown) => {
  if (functionName === "observeStage") {
    return `Stage screenshot captured. isRunning=${Boolean((result as any)?.isRunning)}. The next user image message contains the latest screenshot.`;
  }
  if (functionName === "runStageScript") {
    const screenshots = Array.isArray((result as any)?.screenshots) ? (result as any).screenshots.length : 0;
    const details = {
      success: (result as any)?.success !== false,
      actions: (result as any)?.actions,
      elapsedMs: (result as any)?.elapsedMs,
      screenshots,
      error: (result as any)?.error,
      failedActionIndex: (result as any)?.failedActionIndex,
      failedAction: (result as any)?.failedAction,
    };
    return screenshots > 0
      ? `Stage script result: ${JSON.stringify(details)}. The next user image message contains ${screenshots} screenshot(s) captured during the script.`
      : typeof result === "object"
        ? JSON.stringify(result)
        : String(result);
  }
  if (functionName === "updateTodoList") {
    return JSON.stringify(compactTodoResultForModel(result as any));
  }
  if (functionName === "getDiagnostics") {
    return JSON.stringify(compactDiagnosticsResultForModel(result as any));
  }
  if (functionName === "applyPatch") {
    return JSON.stringify(compactApplyPatchResultForModel(result as any));
  }
  return typeof result === "object" ? JSON.stringify(result) : String(result);
};

const getSessionTitleFromMessages = (messages: ChatMessage[]) => {
  const firstUserMessage = messages.find((message) => !message.hidden && !message.kind && message.role === "user");
  const rawTitle =
    firstUserMessage?.content ||
    firstUserMessage?.attachments?.map((attachment) => attachment.name).join(", ") ||
    "压缩后的对话";
  return rawTitle.length > 20 ? `${rawTitle.substring(0, 20)}...` : rawTitle;
};

const SYSTEM_PROMPT = `You are an AI assistant inside Gandi IDE (Scratch environment).

Language: reply in the user's latest language, or zh-CN if unclear.

Workflow:
- If missing details would change the result, call askUser once before planning/editing.
- For non-trivial work, maintain updateTodoList: short ordered list, exactly one in_progress item, immediate completion updates, and no in_progress item before final reply.
- Use memory sparingly: after first reading and understanding a saved project, store concise project understanding (structure, key targets, script organization, conventions) in project memory for faster future sessions; store stable user-stated rules/preferences in long-term memory.
- When a repeated scenario would benefit from a reusable same-scenario guide, use createAiGuide to save concise Markdown guidance and optional guide tools for future conversations.
- For createAiGuide indexJs, prefer simple top-level async functions: async function toolName(args) { return { result }; }. Each function becomes skillName.toolName.
- If the user asks for a persistent future behavior ("from now on...", "every time...", "after each task...", etc.), treat it as both a long-term preference and, when executable, a reusable AI guide/tool opportunity. Save the preference with setMemoryBlock and create/update an AI guide when a guide can help future turns perform the behavior.
- A guide tool is appropriate for repeatable assistant-side actions that can run from available browser/JS/tool context, such as formatting final summaries, validating output, preparing a standard report, or sending a browser notification if permission is available. Do not create a fake tool that only describes the action; make the tool actually perform the useful work or return an explicit unavailable/denied result.
- On later turns, if memory says a persistent behavior applies and an enabled guide tool exists for it, call runGuideTool at the relevant point before the final assistant message. Do not claim the behavior happened unless the tool result confirms it. Example: for "notify me when each response is complete", create a notification guide tool and then call that guide tool before final replies.
- 对非简单 Scratch 任务，优先使用子代理提升开发效率：一个子代理可以检查当前项目；一个子代理可以研究积木语法 / 菜单并构建脚本 / 资源；不要委托需要用户判断、共享顺序状态或最终集成决策的步骤；父 AI 始终负责：总结、分析现状、分配、安排、规划。
- Start Scratch project work with getProjectOverview, then readFile only the files you will edit. Use stable paths from listFiles; never invent target-id paths.
- Before writing, patching, or displaying Scratch block code, make sure you know the relevant block implementation: namespace, argument, field, menu, callback, mutation, and nesting shape. Do not query help for common core blocks you already know. If uncertain, read the relevant getScratchGuide topic(s) and use one getBlocksHelp call for the unfamiliar blocks only. For procedures/custom args/rendering, use the matching guide/help when uncertain and prefer custom blocks over broadcast-only local logic.
- For features outside core Scratch blocks, check installed extensions with getAllExtensions and approved extensions with getScratchGuide({ topic: "extension-index" }) before proposing implementation details. You can also read built-in extension guides directly with getScratchGuide({ topic: "extension-<extensionId>" }) or getScratchGuide({ topic: "<extensionId>" }) even before the extension is installed.
- Edit scripts/SVG/data with applyPatch only; do not ask the user to paste code. Patch small scripts one at a time, then call getDiagnostics for changed files.

Assistant response rendering:
- The chat UI supports two non-standard Markdown helpers. Use them only when they help the user inspect or reuse Scratch blocks.
- To reference existing local Scratch blocks, write a virtual script file plus a single line or line range in plain text, such as \`/角色1/scripts/movement.js 3行\`, \`movement.js:3\`, or \`/角色1/scripts/movement.js 3行到5行\`. The UI will render it as clickable block l10n labels and jump to the referenced workspace blocks. Prefer full virtual paths when multiple files may share the same name.
- To show reusable Scratch blocks directly in the answer, use a fenced code block whose language is exactly \`DSL\`. Only put Scratch JS DSL whose block implementation you know inside it; if uncertain, read the needed guide(s) and/or getBlocksHelp first. The UI renders it as block-style preview and lets the user copy a block-sharing-compatible payload for pasting into the workspace. Use other language fences for ordinary source code.
- When explaining Scratch logic that is naturally a block sequence (movement, collision, conditions, loops, variables, broadcasts, algorithms, or small implementation snippets), prefer a short verified \`DSL\` fence instead of prose pseudocode or ordinary code so the user sees rendered blocks. Keep prose around it brief. If exact block syntax is not already verified, call the needed guide/help tools before writing the \`DSL\` fence.
- Treat \`DSL\` fences as an internal rendering instruction, not a user-facing topic. In visible prose, call them "blocks"/"积木" or place the fence directly; do not say "DSL", "Scratch JS DSL", "opcode", "mutation", "$dynamicArgs", "namespace", or similar implementation terms unless the user explicitly asks for converter/debugging details.
- Do not show a separate textual block mockup such as "积木：复制 执行 [CODE]" and then another "DSL 写法" for the same idea. Output one verified \`DSL\` fence when the user needs copyable/rendered blocks, with only a short practical sentence around it.

Scratch VFS:
- Targets are root folders with writable scripts/*.js, read-only legacy script.js, custom, and audio. Stage is fixed at /stage and cannot be renamed/deleted.
- Script files live at /<target>/scripts/*.js and are feature files. A file may contain multiple // @script <id> sections; each section must produce exactly one Scratch top-level stack. Add independent stacks by adding sections to the relevant feature file or by adding a new feature file.
- Sprite folders: Add File /新角色名 creates, Update File /旧角色名 + Move to /新角色名 renames, Delete File /角色名 deletes.
- SVG costumes/backdrops are editable under /<target>/custom/*.svg; reorder costumes/backdrops by reordering /<target>/custom/order.json; audio is under /<target>/audio/*. Delete costume/audio by deleting files. insertCostume creates vector or bitmap costumes/backdrops by user setting and falls back to SVG if bitmap generation fails; updateCostume edits vector costumes/backdrops as SVG and bitmap costumes/backdrops with the configured image model. To use an existing project costume/backdrop as visual reference for insertCostume or updateCostume, pass referenceCostumeId, referenceCostumePath, referenceCostumeName, referenceCostumeIndex, or the backward-compatible referenceImageName.
- Root SVG attributes data-rotation-center-x and data-rotation-center-y control Scratch rotation center in SVG coordinates; edit them for pivot changes. Missing values are added from the SVG geometric center.
- Root /variables.json and /lists.json are global data. /stage/... and /<target>/... data paths, plus Chinese aliases such as /变量.json, are compatibility aliases, not private target data. Script DSL references auto-create global variables/lists; patch JSON only for bulk initialization, rename, deletion, or explicit value edits.
- Invalid script drafts are preserved for repair without changing Scratch blocks; valid sync may return normalizedDiffs showing Scratch serializer changes.

applyPatch:
- Use Codex-style patches starting with *** Begin Patch; never wrap patches in Markdown fences.
- Use Add File/Delete File/Update File, @@ hunks with space/+/- context for existing files, and Move to for renames.
- For empty files or full replacement, content may follow *** Update File directly without + prefixes.

Virtual JS DSL:
- Program bodies contain expression statements only; each statement is one Scratch block call.
- Calls use namespace.method({ args }) or identifier({ args }); dotted DSL calls are preferred over underscore opcode identifiers.
- Fields, variables, lists, dropdowns, broadcasts, keys, sounds, clone targets, and other selectors use $field_* keys. Use $field_VARIABLE/$field_LIST and data.variable({ $field_VARIABLE: "name" }) to read variables.
- Inputs use plain keys. Boolean slots such as CONDITION require Boolean reporters such as operator.equals/operator.gt/operator.lt. Substacks use arrow functions. Reserved meta keys: $mutation, $args, $dynamicArgs, $dynamicArgTypes, $xy. Use top-level $xy for stack placement.
- Dynamic extension inputs use $dynamicArgs: [...] in DSL. Read getScratchGuide({ topic: "dynamic-blocks" }) for examples.
- Custom block parameters are not variables. Inside define(...), read them with argument.reporter_string_number({ $field_VALUE: "param" }) or argument.reporter_boolean({ $field_VALUE: "flag" }); never data.variable.
- Stage scripts orchestrate variables, lists, broadcasts, backdrops, and sounds. Put motion, pen, clones, position, size, and speech bubbles in sprite files.
- Use broadcasts for cross-target orchestration, not local function calls when procedures.call with $args can pass parameters. Use custom blocks for reusable logic, algorithms, sorting, math helpers, and pen rendering; add info: ["warp"] for no-screen-refresh helpers.
- control.if has only SUBSTACK; use control.if_else for else. Arithmetic operators use NUM1/NUM2; comparisons use OPERAND1/OPERAND2. If searchFiles cannot find an extension block such as pen.*, avoid relying on it unless the project already uses it.

Examples live in getScratchGuide topics (extension-index, quickstart, events, data, control, procedures, custom-args, dynamic-blocks, rendering, menus, pen, patching, debugging) and exact getBlocksHelp results.`;

const SUBAGENT_SYSTEM_PROMPT = `You are a delegated AI inside Gandi IDE (Scratch environment). Use the delegated task language, or zh-CN if unclear.

Finish one concrete task with available tools. Do not ask the user, use memory/todos, or launch child AIs. Stay focused; if blocked, report the blocker.

Rules: orient with getProjectOverview/listFiles when needed; use stable virtual paths; patch scripts/SVG with applyPatch and run getDiagnostics for changed files; /<target>/scripts/*.js files are feature files and may contain multiple // @script sections; each section must produce one top-level stack; discard unwanted invalid drafts with discardDraft; add SVG costumes/backdrops with Add File /<target>/custom/名字.svg; end with a concise, precise final reply containing only findings/results the parent needs.`;

const GAME_AGENT_SYSTEM_PROMPT = `Game Agent mode: test the Scratch stage visually like a player. Use getProjectOverview when stage ratio or project orientation helps, then observeStage. If observeStage reports isRunning=true, do not press greenFlag again unless restarting is part of the test. Use runStageScript for short reproducible DOM-input scripts such as wait(1000); click({x:0,y:0}); screenshot(); mouseMove({x:100,y:0,durationMs:500}); keyPress({key:"space"});. Use screenshot(); inside scripts to capture intermediate evidence; captured images are returned as image inputs. Coordinates default to Scratch coordinates: center is (0,0), y increases upward, height is 360, and width follows the current stage aspect ratio. Use click({x,y,button:"right"}) for right click; button defaults to left. Do not modify the project. Final report only: tested goal, observed behavior, bugs found, reproduction steps, expected behavior, and useful clues for the parent AI.`;

const REQUIRED_TOOL_ARGUMENTS: Record<string, string[]> = {
  observeStage: [],
  runStageScript: ["script"],
  readFile: ["path"],
  searchFiles: ["query"],
  searchBlocks: ["query"],
  getBlocksHelp: ["opcodes"],
  discardDraft: ["path"],
  runGuideTool: ["tool"],
  createAiGuide: ["name", "description", "content"],
  searchExtensions: [],
  addExtension: ["extensionId"],
  getExtensionBlocks: ["extensionId"],
  applyPatch: ["patch"],
  runSubAgent: ["name", "task"],
  updateTodoList: ["todos"],
  askUser: ["question"],
  insertCostume: ["costumeName", "costumeDescription"],
  updateCostume: ["updateDescription"],
  deleteCostume: [],
  getMemoryBlock: ["id"],
  setMemoryBlock: ["content"],
  replaceMemoryBlockText: ["id", "oldText", "newText"],
  deleteMemoryBlock: ["id"],
};

const SUBAGENT_DISABLED_TOOL_NAMES = new Set([
  "runSubAgent",
  "updateTodoList",
  "askUser",
  "insertCostume",
  "listMemoryBlocks",
  "getMemoryBlock",
  "setMemoryBlock",
  "replaceMemoryBlockText",
  "deleteMemoryBlock",
  "createAiGuide",
]);

const SUBAGENT_TOOL_SCHEMAS = scratchToolSchemas.filter(
  (toolSchema: any) => !SUBAGENT_DISABLED_TOOL_NAMES.has(toolSchema?.function?.name),
);
const MAIN_TOOL_SCHEMAS_WITHOUT_SUBAGENTS = scratchToolSchemas.filter(
  (toolSchema: any) => !["runSubAgent", "observeStage", "runStageScript"].includes(toolSchema?.function?.name),
);
const MAIN_TOOL_SCHEMAS_WITH_SUBAGENTS = scratchToolSchemas.filter(
  (toolSchema: any) => !["observeStage", "runStageScript"].includes(toolSchema?.function?.name),
);

const filterToolSchemasForProjectIndex = (schemas: any[], blocked: boolean) =>
  blocked
    ? schemas.filter((toolSchema: any) => !PROJECT_INDEX_BLOCKED_TOOL_NAMES.has(toolSchema?.function?.name))
    : schemas;

const filterToolSchemasForChatMode = (schemas: any[], conversationMode: "chat" | "code") =>
  conversationMode === "chat"
    ? schemas.filter((toolSchema: any) => !CHAT_MODE_BLOCKED_TOOL_NAMES.has(toolSchema?.function?.name))
    : schemas;

const SUBAGENT_READ_TOOL_NAMES = new Set([...READ_BUILTIN_TOOL_NAMES, "runGuideTool"]);
const SUBAGENT_ALL_TOOL_NAMES = new Set([...READ_BUILTIN_TOOL_NAMES, ...EDIT_BUILTIN_TOOL_NAMES]);
const SUBAGENT_GAME_TOOL_NAMES = new Set(GAME_BUILTIN_TOOL_NAMES);
const TOOL_NAMES_BY_GROUP: Record<SubAgentToolGroup, Set<string>> = {
  read: SUBAGENT_READ_TOOL_NAMES,
  edit: new Set(EDIT_BUILTIN_TOOL_NAMES),
  game: SUBAGENT_GAME_TOOL_NAMES,
};

const cloneToolCalls = (toolCalls?: ToolCall[]) =>
  Array.isArray(toolCalls)
    ? toolCalls.map((toolCall) => ({
        ...toolCall,
        function: {
          ...toolCall.function,
        },
      }))
    : undefined;

const cloneChatMessages = (messages: ChatMessage[]) =>
  messages.map((message) => ({
    ...message,
    tool_calls: cloneToolCalls(message.tool_calls),
    anthropic_content_blocks: message.anthropic_content_blocks ? [...message.anthropic_content_blocks] : undefined,
  }));

const TERMINATED_TOOL_RESULT = JSON.stringify({ success: false, terminated: true, error: "用户已终止执行。" });

type QueuedUserMessage = {
  id: string;
  content: string;
  attachments: Attachment[];
  createdAt: number;
};

const buildTerminatedTodoResult = (argumentsText: string) => {
  const args = safeParseJson(argumentsText) as any;
  const todos = Array.isArray(args?.todos) ? args.todos : [];
  if (!todos.length) return null;
  const activeTodo = todos.find((todo: any) => todo?.status === "in_progress") || null;

  return JSON.stringify({
    success: false,
    terminated: true,
    error: "用户已终止执行。",
    terminatedTodoId: activeTodo?.id ? String(activeTodo.id) : undefined,
    todos: todos.map((todo: any) => ({
      ...todo,
      status: todo?.status === "in_progress" ? "cancelled" : todo?.status,
    })),
  });
};

const terminateTodoArguments = (argumentsText: string) => {
  const args = safeParseJson(argumentsText) as any;
  const todos = Array.isArray(args?.todos) ? args.todos : [];
  if (!todos.length) return argumentsText;

  return JSON.stringify({
    ...args,
    todos: todos.map((todo: any) => ({
      ...todo,
      status: todo?.status === "in_progress" ? "cancelled" : todo?.status,
    })),
  });
};

const buildTransferredTodoResult = (argumentsText: string) => {
  const args = safeParseJson(argumentsText) as any;
  const todos = Array.isArray(args?.todos) ? args.todos : [];
  const transferredTodo = todos.find((todo: any) => todo?.status === "in_progress") || null;
  if (!transferredTodo) return null;

  return JSON.stringify({
    success: true,
    transferred: true,
    transferredTodoId: transferredTodo?.id ? String(transferredTodo.id) : undefined,
    message: "用户追加了新消息，任务已跳转到新的对话上下文。",
    todos: todos.map((todo: any) => ({
      ...todo,
      status: todo?.status === "in_progress" ? "transferred" : todo?.status,
    })),
  });
};

const markLatestTodoAsTransferred = (messages: ChatMessage[]) => {
  const nextMessages = cloneChatMessages(messages);
  const lastUserIndex = nextMessages.reduce((lastIndex, message, index) => (message.role === "user" ? index : lastIndex), -1);
  const latestTodoToolCall = [...nextMessages]
    .slice(lastUserIndex + 1)
    .reverse()
    .filter((message) => message.role === "assistant" && message.tool_calls?.length)
    .flatMap((message) => message.tool_calls || [])
    .find((toolCall) => toolCall.function.name === "updateTodoList");
  const transferredTodoResult = latestTodoToolCall ? buildTransferredTodoResult(latestTodoToolCall.function.arguments) : null;

  if (!latestTodoToolCall || !transferredTodoResult) {
    return messages;
  }

  let updatedExistingResult = false;
  const patchedMessages = nextMessages.map((message) => {
    if (message.role === "tool" && message.tool_call_id === latestTodoToolCall.id) {
      updatedExistingResult = true;
      return {
        ...message,
        name: "updateTodoList",
        content: transferredTodoResult,
      };
    }
    return message;
  });

  if (updatedExistingResult) {
    return patchedMessages;
  }

  return [
    ...patchedMessages,
    {
      id: createMessageId(),
      role: "tool" as const,
      tool_call_id: latestTodoToolCall.id,
      name: "updateTodoList",
      content: transferredTodoResult,
    },
  ];
};

const terminatePendingExecution = (messages: ChatMessage[]) => {
  const terminatedMessages = cloneChatMessages(messages);
  const lastUserIndex = terminatedMessages.reduce((lastIndex, message, index) => (message.role === "user" ? index : lastIndex), -1);
  const latestTodoToolCall = [...terminatedMessages]
    .slice(lastUserIndex + 1)
    .reverse()
    .filter((message) => message.role === "assistant" && message.tool_calls?.length)
    .flatMap((message) => message.tool_calls || [])
    .find((toolCall) => toolCall.function.name === "updateTodoList");
  const terminatedTodoResult = latestTodoToolCall ? buildTerminatedTodoResult(latestTodoToolCall.function.arguments) : null;

  if (latestTodoToolCall && terminatedTodoResult) {
    latestTodoToolCall.function = {
      ...latestTodoToolCall.function,
      arguments: terminateTodoArguments(latestTodoToolCall.function.arguments),
    };
  }

  const toolResultIds = new Set(
    terminatedMessages
      .filter((message) => message.role === "tool" && message.tool_call_id && message.content.trim())
      .map((message) => message.tool_call_id),
  );
  const pendingToolCalls = terminatedMessages
    .filter((message) => message.role === "assistant" && message.tool_calls?.length)
    .flatMap((message) => message.tool_calls || [])
    .filter((toolCall) => !toolResultIds.has(toolCall.id));

  if (!pendingToolCalls.length && !terminatedTodoResult) {
    return terminatedMessages;
  }

  const lastTodoToolCall = [...pendingToolCalls].reverse().find((toolCall) => toolCall.function.name === "updateTodoList");

  if (lastTodoToolCall) {
    lastTodoToolCall.function = {
      ...lastTodoToolCall.function,
      arguments: terminateTodoArguments(lastTodoToolCall.function.arguments),
    };
  }

  const nextMessages = terminatedMessages.map((message) => {
    if (terminatedTodoResult && message.role === "tool" && message.tool_call_id === latestTodoToolCall?.id) {
      return {
        ...message,
        name: "updateTodoList",
        content: terminatedTodoResult,
      };
    }

    if (message.role !== "tool" || !message.tool_call_id || message.content.trim()) {
      return message;
    }

    const pendingToolCall = pendingToolCalls.find((toolCall) => toolCall.id === message.tool_call_id);
    if (!pendingToolCall) {
      return message;
    }

    return {
      ...message,
      name: pendingToolCall.function.name,
      content: TERMINATED_TOOL_RESULT,
    };
  });

  const existingToolMessageIds = new Set(
    nextMessages.filter((message) => message.role === "tool" && message.tool_call_id).map((message) => message.tool_call_id),
  );
  const missingResultMessages = pendingToolCalls
    .filter((toolCall) => !existingToolMessageIds.has(toolCall.id))
    .map<ChatMessage>((toolCall) => ({
      id: createMessageId(),
      role: "tool",
      tool_call_id: toolCall.id,
      name: toolCall.function.name,
      content: terminatedTodoResult && toolCall.id === latestTodoToolCall?.id ? terminatedTodoResult : TERMINATED_TOOL_RESULT,
    }));

  return missingResultMessages.length ? [...nextMessages, ...missingResultMessages] : nextMessages;
};

const buildSubAgentSystemText = (subAgents: SubAgentProfile[], unavailableSubAgents: string[] = []) => {
  const lines = subAgents.length
    ? [
        "Available sub agents:",
        ...subAgents.map(
          (agent) =>
            `- ${agent.name}: ${agent.description || "No description"}; builtin tool groups: ${agent.builtinToolGroups.join(", ") || "none"}; guide categories: ${agent.enabledGuideCategories.join(", ") || "none"}`,
        ),
        "When the user mentions @AgentName, that refers to a configured sub agent, not a Scratch project file or extension. Call runSubAgent with the exact name in the name field.",
      ]
    : ["No sub agents are configured. Do not call runSubAgent."];

  if (unavailableSubAgents.length) {
    lines.push(
      `Unavailable sub agents: ${unavailableSubAgents.join(", ")}. They are configured but cannot be used with the current model/settings; report that blocker instead of searching project files or extensions.`,
    );
  }

  return lines.join("\n");
};

const isMissingToolArgument = (value: unknown) =>
  value === undefined || value === null || (typeof value === "string" && value.trim() === "");

const validateToolArguments = (functionName: string, args: Record<string, unknown>) => {
  if (functionName === "askUser") {
    const hasSingleQuestion = !isMissingToolArgument(args.question);
    const hasMultipleQuestions = Array.isArray(args.questions) && args.questions.length > 0;
    if (!hasSingleQuestion && !hasMultipleQuestions) {
      throw new Error(`Tool askUser requires question or non-empty questions. Received: ${JSON.stringify(args)}`);
    }
    return;
  }

  const requiredArguments = REQUIRED_TOOL_ARGUMENTS[functionName] || [];
  const missingArguments = requiredArguments.filter((argumentName) => isMissingToolArgument(args[argumentName]));

  if (missingArguments.length > 0) {
    throw new Error(
      `Tool ${functionName} requires argument(s): ${missingArguments.join(", ")}. Received: ${JSON.stringify(args)}`,
    );
  }
};

export function useChat({
  messages,
  currentAgent,
  updateSessionMessages,
  createChatSession,
  appendSessionSnapshot,
  enableReasoning,
  reasoningEffort = "medium",
  vm,
  blockly,
  workspace,
  utils,
  userGuides = [],
  createAiGuide,
  aiGuideVerificationMode = "review_code",
  subAgents = [],
  allowSubAgents = true,
  defaultCostumeType = "ask",
  stageScreenshotMode = "fast",
  imageGenerationModel = null,
  conversationMode = "code",
}: UseChatOptions) {
  const [inputText, setInputText] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  const [queuedUserMessages, setQueuedUserMessages] = useState<QueuedUserMessage[]>([]);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [pendingUserQuestion, setPendingUserQuestion] = useState<PendingUserQuestion | null>(null);
  const [contextUsage, setContextUsage] = useState<ContextUsageInfo>(() => estimateContextUsage(messages, currentAgent));
  const [isCompressingContext, setIsCompressingContext] = useState(false);
  const [projectIndexStatus, setProjectIndexStatus] = useState<any>(null);
  const [projectIndexBuild, setProjectIndexBuild] = useState<{
    running: boolean;
    progress: number;
    phase: string;
    error?: string;
    largeProject?: boolean;
    stopped?: boolean;
    exportText?: string;
  }>({ running: false, progress: 0, phase: "" });
  const [projectExamplePrompts, setProjectExamplePrompts] = useState<ExamplePromptSet | null>(null);
  const aiToolsRef = useRef<AITools | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const projectIndexAbortControllerRef = useRef<AbortController | null>(null);
  const projectIndexBlockedRef = useRef(false);
  const activeGenerationRef = useRef<{ sessionId: string; messages: ChatMessage[] } | null>(null);
  const queuedUserMessagesRef = useRef<QueuedUserMessage[]>([]);
  const userQuestionAnswerRef = useRef<((payload: { answers: UserQuestionAnswer[] }) => void) | null>(null);
  const autoCompressionRef = useRef(false);
  const activeConversationModeRef = useRef<"chat" | "code">(conversationMode);
  useEffect(() => {
    if (isGenerating) return;
    const nextUsage = estimateContextUsage(messages, currentAgent);
    setContextUsage((previous) => (isSameContextUsage(previous, nextUsage) ? previous : nextUsage));
  }, [currentAgent, isGenerating, messages]);

  const refreshProjectIndexStatus = () => {
    const nextStatus = aiToolsRef.current?.getProjectIndexStatus?.() || null;
    projectIndexBlockedRef.current = Boolean(nextStatus?.blocked);
    setProjectIndexStatus((previous) =>
      JSON.stringify(previous || null) === JSON.stringify(nextStatus || null) ? previous : nextStatus,
    );
    return nextStatus;
  };

  const refreshProjectExamplePrompts = () => {
    if (!vm) {
      setProjectExamplePrompts(null);
      return null;
    }
    const blocks = listMemoryBlocks(vm, "project").blocks || [];
    const block = blocks.find((item) => item.id === PROJECT_INDEX_MEMORY_ID);
    const nextPrompts = block ? parseProjectExamplePrompts(block.content) : null;
    setProjectExamplePrompts((previous) =>
      JSON.stringify(previous || null) === JSON.stringify(nextPrompts || null) ? previous : nextPrompts,
    );
    return nextPrompts;
  };

  const setQueuedMessages = (updater: SetStateAction<QueuedUserMessage[]>) => {
    setQueuedUserMessages((previous) => {
      const next = typeof updater === "function" ? (updater as (value: QueuedUserMessage[]) => QueuedUserMessage[])(previous) : updater;
      queuedUserMessagesRef.current = next;
      return next;
    });
  };

  const enqueueCurrentInput = (sourceInputText = inputText, sourceAttachments = attachments) => {
    const content = sourceInputText.trim();
    if (!content && sourceAttachments.length === 0) return false;
    setQueuedMessages((previous) => [
      ...previous,
      {
        id: createMessageId(),
        content: sourceInputText,
        attachments: sourceAttachments,
        createdAt: Date.now(),
      },
    ]);
    setInputText("");
    setAttachments([]);
    return true;
  };

  const normalizeQuestionOptions = (value: unknown) =>
    (Array.isArray(value) ? value : [])
      .map((option: any, index: number) => {
        if (typeof option === "string") {
          const label = option.trim();
          return label ? { id: `option-${index}`, label, value: label } : null;
        }

        const label = String(option?.label || option?.value || "").trim();
        const optionValue = String(option?.value || label).trim();
        return label && optionValue
          ? {
              id: String(option?.id || `option-${index}`),
              label,
              value: optionValue,
              disabled: Boolean(option?.disabled),
            }
          : null;
      })
      .filter(Boolean) as UserQuestionOption[];

  const normalizePendingQuestions = (args: Record<string, any>) => {
    const multiQuestions = (Array.isArray(args.questions) ? args.questions : [])
      .map((item: any, index: number) => {
        const question = String(item?.question || "").trim();
        if (!question) return null;
        return {
          id: String(item?.id || `question-${index}`),
          question,
          details: typeof item?.details === "string" ? item.details : undefined,
          options: normalizeQuestionOptions(item?.options),
          questionType:
            item?.questionType === "input" || item?.questionType === "choice"
              ? item.questionType
              : Array.isArray(item?.options) && item.options.length > 0
                ? "choice"
                : "input",
          placeholder: typeof item?.placeholder === "string" ? item.placeholder : undefined,
          customOptionLabel: String(item?.customOptionLabel || "其他 / 自定义").trim() || "其他 / 自定义",
          allowCustomInput: item?.allowCustomInput !== false,
        } satisfies PendingUserQuestionItem;
      })
      .filter(Boolean) as PendingUserQuestionItem[];

    if (multiQuestions.length > 0) {
      return multiQuestions;
    }

    const singleQuestion = String(args.question || "").trim();
    if (!singleQuestion) {
      return [];
    }

    return [
      {
        id: "question-0",
        question: singleQuestion,
        details: typeof args.details === "string" ? args.details : undefined,
        options: normalizeQuestionOptions(args.options),
        questionType: Array.isArray(args.options) && args.options.length > 0 ? "choice" : "input",
        placeholder: typeof args.placeholder === "string" ? args.placeholder : undefined,
        customOptionLabel: String(args.customOptionLabel || "其他 / 自定义").trim() || "其他 / 自定义",
        allowCustomInput: args.allowCustomInput !== false,
      },
    ] satisfies PendingUserQuestionItem[];
  };

  const askUser = (args: Record<string, any>, toolCallId: string) =>
    new Promise((resolve, reject) => {
      const questions = normalizePendingQuestions(args);
      if (!questions.length) {
        reject(new Error("askUser requires question or non-empty questions"));
        return;
      }

      const signal = abortControllerRef.current?.signal;
      const cleanup = () => {
        signal?.removeEventListener("abort", handleAbort);
        userQuestionAnswerRef.current = null;
      };
      const handleAbort = () => {
        cleanup();
        setPendingUserQuestion(null);
        reject(new DOMException("User question aborted", "AbortError"));
      };

      if (signal?.aborted) {
        handleAbort();
        return;
      }

      signal?.addEventListener("abort", handleAbort, { once: true });
      userQuestionAnswerRef.current = ({ answers }) => {
        cleanup();
        setPendingUserQuestion(null);
        resolve({
          success: true,
          questions: questions.map((item) => item.question),
          answers,
          answer: answers[0]?.answer || "",
          selectedOption: answers[0]?.selectedOption || null,
        });
      };

      setPendingUserQuestion({
        id: `question-${toolCallId}`,
        toolCallId,
        questions,
        currentIndex: 0,
        answers: [],
      });
    });

  const buildAiGuideReviewDetails = (args: Record<string, any>) =>
    [
      `skillName: ${String(args.name || "").trim() || "(missing)"}`,
      `title: ${String(args.title || args.name || "").trim() || "(missing)"}`,
      `description: ${String(args.description || "").trim() || "(missing)"}`,
      "",
      "Markdown:",
      "```md",
      String(args.content || ""),
      "```",
      "",
      "index.js:",
      "```js",
      String(args.indexJs || ""),
      "```",
    ].join("\n");

  const shouldAuditAiGuideWithUser = (mode: AiGuideVerificationMode, hasIndexJs: boolean) =>
    mode === "review_all" || (mode === "review_code" && hasIndexJs);

  const shouldAuditAiGuideAutomatically = (mode: AiGuideVerificationMode, hasIndexJs: boolean) =>
    mode === "auto_review_all" || (mode === "auto_review_code" && hasIndexJs);

  const reviewAiGuideWithUser = async (args: Record<string, any>, toolCallId: string) => {
    const answer = (await askUser(
      {
        question: `AI 想创建指南「${String(args.title || args.name || "未命名指南")}」，是否允许？`,
        details: buildAiGuideReviewDetails(args),
        options: [
          { id: "approve", label: "允许创建", value: "approve" },
          { id: "reject", label: "拒绝", value: "reject" },
        ],
        allowCustomInput: false,
      },
      toolCallId,
    )) as { selectedOption?: UserQuestionOption | null; answer?: string };
    return answer.selectedOption?.value === "approve" || answer.answer === "approve";
  };

  const reviewAiGuideAutomatically = async (args: Record<string, any>) => {
    if (!currentAgent || !isProviderImplemented(currentAgent.provider)) {
      return { success: false, fallbackToUser: true, reason: "No available model for automatic guide safety review." };
    }
    const providerAdapter = getProviderAdapter(currentAgent.provider);
    let text = "";
    const parentSignal = abortControllerRef.current?.signal;
    const reviewAbortController = new AbortController();
    let timedOut = false;
    const handleParentAbort = () => reviewAbortController.abort();
    const timeoutId = window.setTimeout(() => {
      timedOut = true;
      reviewAbortController.abort();
    }, AI_GUIDE_AUTO_REVIEW_TIMEOUT_MS);
    parentSignal?.addEventListener("abort", handleParentAbort, { once: true });

    let data: any;
    try {
      data = await providerAdapter.sendChatCompletion({
        agent: currentAgent,
        messages: [
          {
            id: createMessageId(),
            role: "system",
            content: [
              "You are a strict security reviewer for AI-created Gandi IDE guides.",
              "Decide whether the Markdown guide and optional index.js guide tools are safe to store and run in future conversations.",
              "Reject code that exfiltrates data, steals credentials, performs network/file/storage abuse, hides malicious behavior, executes arbitrary user-supplied code, changes project/user data without explicit intent, or weakens security.",
              'Return only JSON: {"approved":true|false,"reason":"short reason"}.',
            ].join("\n"),
          },
          {
            id: createMessageId(),
            role: "user",
            content: buildAiGuideReviewDetails(args),
          },
        ],
        enableReasoning: false,
        stream: false,
        signal: reviewAbortController.signal,
        onTextDelta: (delta) => {
          text += delta;
        },
      });
    } catch (error: any) {
      if (parentSignal?.aborted) {
        throw error;
      }
      return {
        success: false,
        fallbackToUser: true,
        reason: timedOut
          ? "Automatic guide safety review timed out."
          : `Automatic guide safety review failed: ${error?.message || String(error)}`,
      };
    } finally {
      window.clearTimeout(timeoutId);
      parentSignal?.removeEventListener("abort", handleParentAbort);
    }

    const rawText = getCompletionText(data, text).trim();
    const parsed = safeParseJson(rawText) || safeParseJson(rawText.replace(/^```(?:json)?\s*|\s*```$/g, ""));
    if (!parsed || typeof parsed !== "object" || typeof (parsed as any).approved !== "boolean") {
      return {
        success: false,
        fallbackToUser: true,
        reason: rawText
          ? `Automatic guide safety review returned an invalid result: ${rawText.slice(0, 240)}`
          : "Automatic guide safety review returned an empty result.",
      };
    }
    return {
      success: true,
      approved: Boolean((parsed as any).approved),
      reason: String((parsed as any).reason || "").trim(),
    };
  };

  const auditAiGuideCreation = async (args: Record<string, any>, toolCallId: string) => {
    const hasIndexJs = Boolean(String(args.indexJs || "").trim());
    if (shouldAuditAiGuideWithUser(aiGuideVerificationMode, hasIndexJs)) {
      const approved = await reviewAiGuideWithUser(args, toolCallId);
      if (!approved) {
        throw new Error("AI guide creation was rejected by the user.");
      }
      return;
    }
    if (shouldAuditAiGuideAutomatically(aiGuideVerificationMode, hasIndexJs)) {
      const review = await reviewAiGuideAutomatically(args);
      if (review.success && !review.approved) {
        throw new Error(`AI guide creation was rejected by automatic safety review: ${review.reason || "unsafe guide"}`);
      }
      if (!review.success && review.fallbackToUser) {
        const approved = await reviewAiGuideWithUser(
          {
            ...args,
            description: `${String(args.description || "").trim()} [Automatic review unavailable: ${review.reason}]`,
          },
          toolCallId,
        );
        if (!approved) {
          throw new Error("AI guide creation was rejected by the user after automatic review fallback.");
        }
      }
    }
  };

  const answerUserQuestion = (answer: string, selectedOption?: UserQuestionOption | null) => {
    const normalizedAnswer = answer.trim();
    if (!normalizedAnswer || !pendingUserQuestion) return;

    const currentQuestion = pendingUserQuestion.questions[pendingUserQuestion.currentIndex];
    if (!currentQuestion) return;

    const nextAnswers = [...pendingUserQuestion.answers];
    nextAnswers[pendingUserQuestion.currentIndex] = {
      questionId: currentQuestion.id,
      question: currentQuestion.question,
      answer: normalizedAnswer,
      selectedOption: selectedOption || null,
    };
    const nextIndex = pendingUserQuestion.currentIndex + 1;

    if (nextIndex >= pendingUserQuestion.questions.length) {
      setPendingUserQuestion(null);
      userQuestionAnswerRef.current?.({ answers: nextAnswers.filter(Boolean) });
      return;
    }

    setPendingUserQuestion({
      ...pendingUserQuestion,
      currentIndex: nextIndex,
      answers: nextAnswers,
    });
  };

  const goBackUserQuestion = () => {
    if (!pendingUserQuestion || pendingUserQuestion.currentIndex <= 0) return;
    setPendingUserQuestion({
      ...pendingUserQuestion,
      currentIndex: pendingUserQuestion.currentIndex - 1,
    });
  };

  const getCostumeTarget = (targetId?: string) => {
    const target = targetId ? vm?.runtime?.getTargetById?.(targetId) : vm?.editingTarget;
    if (!target) {
      throw new Error("Target not found");
    }
    return target;
  };

  const getTargetAssetLabel = (target: any) => (target?.isStage ? "backdrop" : "costume");
  const getTargetAssetLabelZh = (target: any) => (target?.isStage ? "背景" : "造型");

  const getImageGenerationSize = (args: Record<string, any>) => {
    const rawSize = String(args.imageSize || args.size || "").trim();
    return /^\d{2,4}x\d{2,4}$/.test(rawSize) ? rawSize : "1024x1024";
  };

  const getTargetCostumes = (target: any) =>
    (typeof target.getCostumes === "function"
      ? target.getCostumes()
      : target?.sprite?.costumes_ || []) as Scratch.Costume[];

  const getTargetName = (target: any) => String(target?.getName?.() || target?.sprite?.name || target?.id || "");

  const getAllScratchTargets = () => (Array.isArray(vm?.runtime?.targets) ? vm.runtime.targets : []).filter(Boolean);

  const findTargetByReferenceName = (name: string) => {
    const normalizedName = name.trim().replace(/^\/+|\/+$/g, "");
    if (!normalizedName) return null;
    if (normalizedName.toLowerCase() === "stage") {
      return getAllScratchTargets().find((target) => target?.isStage) || null;
    }
    return (
      getAllScratchTargets().find((target) => getTargetName(target) === normalizedName) ||
      getAllScratchTargets().find((target) => getTargetName(target).toLowerCase() === normalizedName.toLowerCase()) ||
      null
    );
  };

  const findCostume = (target: any, args: Record<string, any>) => {
    const costumes = getTargetCostumes(target);
    let index = typeof args.costumeIndex === "number" ? args.costumeIndex : -1;
    if (index < 0 && args.costumeId) {
      index = costumes.findIndex((costume) => costume.id === args.costumeId);
    }
    if (index < 0 && args.costumeName) {
      const requestedName = String(args.costumeName).trim();
      index = costumes.findIndex((costume) => costume.name === requestedName);
    }
    const costume = costumes[index];
    if (!costume) {
      throw new Error(`${getTargetAssetLabel(target)} not found. Provide costumeId, costumeName, or zero-based costumeIndex.`);
    }
    return { costume, index };
  };

  const getCostumeFileName = (costume: Scratch.Costume) => {
    const format = String(costume?.dataFormat || "dat").toLowerCase();
    return `${costume?.name || costume?.id || "costume"}.${format}`;
  };

  const getFileStem = (fileName: string) => {
    const value = String(fileName || "");
    const dotIndex = value.lastIndexOf(".");
    return dotIndex > 0 ? value.slice(0, dotIndex) : value;
  };

  const bytesToBase64 = (bytes: Uint8Array) => {
    let binary = "";
    const chunkSize = 0x8000;
    for (let index = 0; index < bytes.length; index += chunkSize) {
      binary += String.fromCharCode(...bytes.slice(index, index + chunkSize));
    }
    return window.btoa(binary);
  };

  const getCostumeAssetBytes = (costume: Scratch.Costume) => {
    const assetData = (costume?.asset as any)?.data;
    if (!assetData) return null;
    if (assetData instanceof Uint8Array) return assetData;
    if (assetData instanceof ArrayBuffer) return new Uint8Array(assetData);
    if (ArrayBuffer.isView(assetData)) {
      return new Uint8Array(assetData.buffer, assetData.byteOffset, assetData.byteLength);
    }
    return null;
  };

  const getCostumeMimeType = (costume: Scratch.Costume) => {
    const format = String(costume?.dataFormat || "").toLowerCase();
    if (format === "svg") return "image/svg+xml";
    if (format === "jpg" || format === "jpeg") return "image/jpeg";
    if (format === "png" || format === "bmp" || format === "gif" || format === "webp") return `image/${format}`;
    return "application/octet-stream";
  };

  const buildReferenceCostumeAsset = (target: any, costume: Scratch.Costume, index: number) => {
    const mimeType = getCostumeMimeType(costume);
    const svgText = String(costume?.dataFormat || "").toLowerCase() === "svg" ? getCostumeSvg(target, costume, index) : undefined;
    const dataUrl =
      svgText !== undefined
        ? `data:image/svg+xml;base64,${bytesToBase64(new TextEncoder().encode(svgText))}`
        : (costume?.asset as any)?.encodeDataURI?.() ||
          (() => {
            const bytes = getCostumeAssetBytes(costume);
            return bytes ? `data:${mimeType};base64,${bytesToBase64(bytes)}` : "";
          })();

    if (!dataUrl) {
      throw new Error(`Reference costume asset data is unavailable: ${costume?.name || costume?.id || index}`);
    }

    return {
      targetId: target.id,
      targetName: getTargetName(target),
      costumeId: costume.id,
      costumeName: costume.name,
      costumeIndex: index,
      fileName: getCostumeFileName(costume),
      name: `${getTargetName(target)}/${getCostumeFileName(costume)}`,
      mimeType,
      dataUrl,
      svgText,
    };
  };

  const resolveReferenceCostumeAsset = (args: Record<string, any>, defaultTarget: any) => {
    const referenceId = String(
      args.referenceCostumeId || args.referenceImageAttachmentId || args.referenceImageId || args.imageAttachmentId || "",
    ).trim();
    const referenceIndex =
      typeof args.referenceCostumeIndex === "number"
        ? args.referenceCostumeIndex
        : typeof args.referenceImageIndex === "number"
          ? args.referenceImageIndex
          : undefined;
    const rawReference = String(
      args.referenceCostumePath ||
        args.referenceCostumeName ||
        args.referenceImageName ||
        args.referenceImageFileName ||
        args.referenceImageFile ||
        args.imageFileName ||
        "",
    )
      .trim()
      .replace(/^\[file:/, "")
      .replace(/]$/, "");
    const explicitReferenceTargetId = String(args.referenceTargetId || args.referenceCostumeTargetId || "").trim();
    if (!referenceId && typeof referenceIndex !== "number" && !rawReference) return null;

    const pathParts = rawReference.replace(/\\/g, "/").split("/").filter(Boolean);
    const pathTargetName = pathParts.length >= 3 && pathParts[pathParts.length - 2] === "custom" ? pathParts[0] : "";
    const referenceFileName = pathParts.length ? pathParts[pathParts.length - 1] : rawReference;
    const referenceStem = getFileStem(referenceFileName);
    const explicitTarget =
      (explicitReferenceTargetId ? vm?.runtime?.getTargetById?.(explicitReferenceTargetId) : null) ||
      (pathTargetName ? findTargetByReferenceName(pathTargetName) : null);
    const targets = explicitTarget
      ? [explicitTarget]
      : [
          defaultTarget,
          ...getAllScratchTargets().filter((target) => target !== defaultTarget),
        ].filter(Boolean);

    const matches: Array<{ target: any; costume: Scratch.Costume; index: number }> = [];
    targets.forEach((target) => {
      getTargetCostumes(target).forEach((costume, index) => {
        const fileName = getCostumeFileName(costume);
        const targetName = getTargetName(target);
        const virtualPath = `/${target?.isStage ? "stage" : targetName}/custom/${fileName}`;
        const idMatches =
          referenceId &&
          [costume.id, costume.assetId, costume.md5, costume.asset?.assetId].some((value) => String(value || "") === referenceId);
        const indexMatches = typeof referenceIndex === "number" && index === referenceIndex;
        const nameMatches =
          rawReference &&
          [
            costume.name,
            fileName,
            referenceStem && costume.name === referenceStem ? rawReference : "",
            virtualPath,
            virtualPath.toLowerCase(),
          ].some((value) => String(value || "") === rawReference || String(value || "") === referenceFileName || String(value || "") === referenceStem);
        if (idMatches || indexMatches || nameMatches) {
          matches.push({ target, costume, index });
        }
      });
    });

    if (!matches.length) {
      throw new Error(`Reference costume not found: ${referenceId || rawReference || referenceIndex}`);
    }

    const preferredMatch = matches.find((match) => match.target === defaultTarget) || matches[0];
    return buildReferenceCostumeAsset(preferredMatch.target, preferredMatch.costume, preferredMatch.index);
  };

  const extractSvgCode = (value: string) => {
    const text = String(value || "").trim();
    const parsed = (() => {
      try {
        return JSON.parse(text);
      } catch {
        return null;
      }
    })();
    const candidate = typeof parsed?.svgCode === "string" ? parsed.svgCode : text;
    const match = candidate.match(/<svg[\s\S]*<\/svg>/i);
    if (!match) {
      throw new Error("Sub AI did not return valid SVG code");
    }
    return match[0].trim();
  };

  const SVG_ROTATION_CENTER_X_ATTR = "data-rotation-center-x";
  const SVG_ROTATION_CENTER_Y_ATTR = "data-rotation-center-y";

  const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  const readSvgNumberAttr = (text: string, name: string) => {
    const match = text.match(new RegExp(`\\b${escapeRegExp(name)}\\s*=\\s*["']?(-?(?:\\d+\\.?\\d*|\\.\\d+)(?:e[+-]?\\d+)?)`, "i"));
    if (!match) return null;
    const value = Number(match[1]);
    return Number.isFinite(value) ? value : null;
  };

  const formatSvgNumberAttr = (value: number) => {
    if (!Number.isFinite(value)) return "0";
    return Number(value.toFixed(6)).toString();
  };

  const getSvgRootTag = (svgCode: string) => {
    const match = svgCode.match(/<svg\b[^>]*>/i);
    return match ? { tag: match[0], index: match.index || 0 } : null;
  };

  const readSvgRootNumberAttr = (svgCode: string, name: string) => {
    const root = getSvgRootTag(svgCode);
    return root ? readSvgNumberAttr(root.tag, name) : null;
  };

  const getSvgSize = (svgCode: string) => {
    const readNumberAttr = (name: string) => {
      const match = svgCode.match(new RegExp(`\\b${name}\\s*=["']?([0-9.]+)`, "i"));
      return match ? Number(match[1]) : 0;
    };
    const viewBox =
      /viewBox=["']([^"']+)["']/i
        .exec(svgCode)?.[1]
        ?.split(/[\s,]+/)
        .map(Number) || [];
    const width = readSvgRootNumberAttr(svgCode, "width") || viewBox[2] || 480;
    const height = readSvgRootNumberAttr(svgCode, "height") || viewBox[3] || 360;
    return { width, height };
  };

  const getSvgGeometry = (svgCode: string) => {
    const readNumberAttr = (name: string) => {
      const match = svgCode.match(new RegExp(`\\b${name}\\s*=["']?(-?[0-9.]+)`, "i"));
      return match ? Number(match[1]) : 0;
    };
    const viewBox =
      /viewBox=["']([^"']+)["']/i
        .exec(svgCode)?.[1]
        ?.split(/[\s,]+/)
        .map(Number) || [];
    const viewBoxX = Number.isFinite(viewBox[0]) ? viewBox[0] : 0;
    const viewBoxY = Number.isFinite(viewBox[1]) ? viewBox[1] : 0;
    const width = readSvgRootNumberAttr(svgCode, "width") || viewBox[2] || 480;
    const height = readSvgRootNumberAttr(svgCode, "height") || viewBox[3] || 360;
    const defaultRotationCenterX = viewBoxX + width / 2;
    const defaultRotationCenterY = viewBoxY + height / 2;
    const explicitRotationCenterX = readSvgRootNumberAttr(svgCode, SVG_ROTATION_CENTER_X_ATTR);
    const explicitRotationCenterY = readSvgRootNumberAttr(svgCode, SVG_ROTATION_CENTER_Y_ATTR);
    return {
      viewBoxX,
      viewBoxY,
      width,
      height,
      rotationCenterX: explicitRotationCenterX ?? defaultRotationCenterX,
      rotationCenterY: explicitRotationCenterY ?? defaultRotationCenterY,
      hasRotationCenterXAttr: explicitRotationCenterX !== null,
      hasRotationCenterYAttr: explicitRotationCenterY !== null,
      hasRotationCenterAttrs: explicitRotationCenterX !== null && explicitRotationCenterY !== null,
    };
  };

  const ensureSvgRotationCenterAttrs = (svgCode: string) => {
    const geometry = getSvgGeometry(svgCode);
    const root = getSvgRootTag(svgCode);
    if (!root || geometry.hasRotationCenterAttrs) return { svgCode, geometry };
    const insertion = `${geometry.hasRotationCenterXAttr ? "" : ` ${SVG_ROTATION_CENTER_X_ATTR}="${formatSvgNumberAttr(geometry.rotationCenterX)}"`}${geometry.hasRotationCenterYAttr ? "" : ` ${SVG_ROTATION_CENTER_Y_ATTR}="${formatSvgNumberAttr(geometry.rotationCenterY)}"`}`;
    const insertAt = root.index + root.tag.length - (root.tag.endsWith("/>") ? 2 : 1);
    const normalizedSvgCode = `${svgCode.slice(0, insertAt)}${insertion}${svgCode.slice(insertAt)}`;
    return { svgCode: normalizedSvgCode, geometry: getSvgGeometry(normalizedSvgCode) };
  };

  const runSvgSubAgent = async ({
    mode,
    costumeName,
    costumeDescription,
    originalSvg,
    referenceCostume,
  }: {
    mode: "create" | "update";
    costumeName: string;
    costumeDescription: string;
    originalSvg?: string;
    referenceCostume?: ReturnType<typeof resolveReferenceCostumeAsset>;
  }) => {
    if (!currentAgent) {
      throw new Error("No current AI agent available for SVG generation");
    }

    const providerAdapter = getProviderAdapter(currentAgent.provider);
    const finishSvgTool = {
      type: "function",
      function: {
        name: "finishSvg",
        description: "Return the final complete SVG code.",
        parameters: {
          type: "object",
          properties: { svgCode: { type: "string" } },
          required: ["svgCode"],
        },
      },
    };
    const replaceSvgTextTool = {
      type: "function",
      function: {
        name: "replaceSvgText",
        description: "Replace exact text in the current SVG. Use this for local edits before finishSvg.",
        parameters: {
          type: "object",
          properties: {
            oldText: { type: "string" },
            newText: { type: "string" },
            replaceAll: { type: "boolean" },
          },
          required: ["oldText", "newText"],
        },
      },
    };

    let workingSvg = originalSvg || "";
    let subMessages: ChatMessage[] = [
      {
        id: createMessageId(),
        role: "system",
        content:
          mode === "create"
            ? `You are a sub AI process that creates clean Scratch-compatible vector SVG costumes. Return SVG only by calling finishSvg. Use a simple viewBox, valid SVG elements, no scripts, no external images. The root <svg> may include ${SVG_ROTATION_CENTER_X_ATTR} and ${SVG_ROTATION_CENTER_Y_ATTR}; these control the Scratch costume rotation center in SVG coordinates.`
            : `You are a sub AI process that edits Scratch-compatible vector SVG costumes. Prefer replaceSvgText for local edits, then call finishSvg with the final complete SVG. Use valid SVG only, no scripts, no external images. The root <svg> may include ${SVG_ROTATION_CENTER_X_ATTR} and ${SVG_ROTATION_CENTER_Y_ATTR}; editing them changes the Scratch costume rotation center in SVG coordinates. Preserve them unless the requested change needs a new pivot point.`,
      },
      {
        id: createMessageId(),
        role: "user",
        content:
          mode === "create"
            ? `Create a vector SVG costume.\nCostume name: ${costumeName}\nStyle/description: ${costumeDescription}${
                referenceCostume
                  ? `\nReference costume: ${referenceCostume.name}. Use it for visual style, shape, and colors; do not embed the image.${
                      referenceCostume.svgText ? `\n\nReference SVG:\n${referenceCostume.svgText}` : ""
                    }`
                  : ""
              }`
            : `Edit this vector SVG costume.\nCostume name: ${costumeName}\nRequested update: ${costumeDescription}${
                referenceCostume
                  ? `\nReference costume: ${referenceCostume.name}. Use it for visual style, shape, and colors; do not embed the image.${
                      referenceCostume.svgText ? `\n\nReference SVG:\n${referenceCostume.svgText}` : ""
                    }`
                  : ""
              }\n\nOriginal SVG:\n${workingSvg}`,
        ...(referenceCostume && !referenceCostume.svgText
          ? {
              stageObservation: {
                mimeType: referenceCostume.mimeType || "image/png",
                dataUrl: referenceCostume.dataUrl,
              },
            }
          : {}),
      },
    ];

    const isSvgSubAgentRetryableError = (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error || "");
      return /stream ended|ended before completion|connection was dropped|upstream/i.test(message);
    };

    const sendSvgSubAgentRequest = async () => {
      let lastError: unknown = null;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          return await providerAdapter.sendChatCompletion({
            agent: currentAgent,
            messages: buildRequestMessages(subMessages, false),
            tools: mode === "update" ? [replaceSvgTextTool, finishSvgTool] : [finishSvgTool],
            toolChoice: "auto",
            enableReasoning: false,
            stream: false,
            signal: abortControllerRef.current?.signal,
          });
        } catch (error) {
          lastError = error;
          if (attempt > 0 || !isSvgSubAgentRetryableError(error) || abortControllerRef.current?.signal.aborted) {
            throw error;
          }
        }
      }
      throw lastError instanceof Error ? lastError : new Error(String(lastError || "SVG sub AI request failed"));
    };

    for (let turn = 0; turn < 6; turn += 1) {
      const data = await sendSvgSubAgentRequest();
      const message = data.choices[0].message as ChatMessage;

      if (!message.tool_calls?.length) {
        return extractSvgCode(message.content || workingSvg);
      }

      subMessages.push({ ...message, id: createMessageId(), role: "assistant", content: message.content || "" });
      for (const toolCall of message.tool_calls) {
        const toolArgs = safeParseJson(toolCall.function.arguments) as any;
        if (toolCall.function.name === "finishSvg") {
          return extractSvgCode(toolArgs?.svgCode || message.content || workingSvg);
        }

        if (toolCall.function.name === "replaceSvgText") {
          const oldText = String(toolArgs?.oldText || "");
          const newText = String(toolArgs?.newText || "");
          const replaceAll = Boolean(toolArgs?.replaceAll);
          let result: Record<string, unknown>;
          if (!oldText || !workingSvg.includes(oldText)) {
            result = { success: false, error: "oldText not found", currentSvg: workingSvg };
          } else {
            workingSvg = replaceAll ? workingSvg.split(oldText).join(newText) : workingSvg.replace(oldText, newText);
            result = { success: true, currentSvg: workingSvg };
          }
          subMessages.push({
            id: createMessageId(),
            role: "tool",
            tool_call_id: toolCall.id,
            name: toolCall.function.name,
            content: JSON.stringify(result),
          });
        }
      }
    }

    return extractSvgCode(workingSvg);
  };

  const getCostumeSvg = (target: any, costume: Scratch.Costume, costumeIndex: number) => {
    if (costume.dataFormat !== "svg") {
      throw new Error("Only vector SVG costumes are supported for update.");
    }
    return (
      utils?.getCostumeFromTarget?.(costumeIndex, target.id) ||
      new TextDecoder().decode(costume.asset?.data || new Uint8Array())
    );
  };

  const readImageBufferDimensions = (buffer: ArrayBuffer): Promise<{ width: number; height: number }> =>
    new Promise((resolve, reject) => {
      const image = new Image();
      const objectUrl = URL.createObjectURL(new Blob([buffer], { type: "image/png" }));
      image.onload = () => {
        URL.revokeObjectURL(objectUrl);
        const width = image.naturalWidth || image.width;
        const height = image.naturalHeight || image.height;
        if (!width || !height) {
          reject(new Error("Generated bitmap image has no readable dimensions."));
          return;
        }
        resolve({ width, height });
      };
      image.onerror = () => {
        URL.revokeObjectURL(objectUrl);
        reject(new Error("Failed to decode generated bitmap image."));
      };
      image.src = objectUrl;
    });

  const getScaledBitmapRotationCenter = (costume: Scratch.Costume, width: number, height: number) => {
    const originalWidth = Number(costume?.size?.[0]) || 0;
    const originalHeight = Number(costume?.size?.[1]) || 0;
    const originalCenterX = Number(costume?.rotationCenterX);
    const originalCenterY = Number(costume?.rotationCenterY);
    const hasOriginalGeometry =
      originalWidth > 0 &&
      originalHeight > 0 &&
      Number.isFinite(originalCenterX) &&
      Number.isFinite(originalCenterY);
    if (!hasOriginalGeometry) {
      return {
        rotationCenterX: width / 2,
        rotationCenterY: height / 2,
      };
    }
    return {
      rotationCenterX: (originalCenterX / originalWidth) * width,
      rotationCenterY: (originalCenterY / originalHeight) * height,
    };
  };

  const insertCostume = async (args: Record<string, any>, toolCallId: string) => {
    const target = getCostumeTarget(args.targetId);
    const costumeName = String(args.costumeName || "").trim();
    const costumeDescription = String(args.costumeDescription || "").trim();
    const assetLabel = getTargetAssetLabel(target);
    const assetLabelZh = getTargetAssetLabelZh(target);
    const imageSize = getImageGenerationSize(args);
    const referenceCostume = resolveReferenceCostumeAsset(args, target);
    if (!costumeName || !costumeDescription) {
      throw new Error("insertCostume requires costumeName and costumeDescription");
    }

    let costumeType: DefaultCostumeType = defaultCostumeType;
    if (costumeType === "ask") {
      const answer = (await askUser(
        {
          question: `为新${assetLabelZh}「${costumeName}」选择类型`,
          options: [
            { id: "vector", label: "矢量图", value: "vector" },
            { id: "bitmap", label: "位图", value: "bitmap" },
          ],
          allowCustomInput: false,
        },
        `${toolCallId}-type`,
      )) as any;
      costumeType = answer.selectedOption?.value === "bitmap" ? "bitmap" : "vector";
    }

    let bitmapFallbackError = "";
    if (costumeType === "bitmap") {
      if (!imageGenerationModel) {
        bitmapFallbackError = "未配置文生图模型。";
      } else {
        try {
          const imageBuffer = await generateImageWithOpenAICompatibleModel({
            model: imageGenerationModel,
            prompt: `${costumeName}\n${costumeDescription}`,
            size: imageSize,
            referenceImage: referenceCostume
              ? {
                  dataUrl: referenceCostume.dataUrl,
                  mimeType: referenceCostume.mimeType,
                  name: referenceCostume.fileName,
                }
              : undefined,
            signal: abortControllerRef.current?.signal,
          });
          const costumes = await utils.addCostumeToTarget(imageBuffer, `${costumeName}.png`, "image/png", target.id);
          return {
            success: true,
            targetId: target.id,
            targetName: target.getName?.() || target.sprite?.name,
            targetType: target.isStage ? "stage" : "sprite",
            assetType: assetLabel,
            costumeName,
            costumeType: "bitmap",
            imageSize,
            imageModel: imageGenerationModel.displayName,
            referenceCostumeId: referenceCostume?.costumeId,
            referenceCostumeName: referenceCostume?.costumeName,
            createdCostumes: costumes.map((costume) => ({ id: costume.id, name: costume.name })),
          };
        } catch (error) {
          bitmapFallbackError = error instanceof Error ? error.message : String(error);
        }
      }
    }

    const { svgCode } = ensureSvgRotationCenterAttrs(await runSvgSubAgent({ mode: "create", costumeName, costumeDescription, referenceCostume }));
    const costumes = await utils.addCostumeToTarget(svgCode, `${costumeName}.svg`, "image/svg+xml", target.id);
    return {
      success: true,
      targetId: target.id,
      targetName: target.getName?.() || target.sprite?.name,
      targetType: target.isStage ? "stage" : "sprite",
      assetType: assetLabel,
      costumeName,
      costumeType: "vector",
      referenceCostumeId: referenceCostume?.costumeId,
      referenceCostumeName: referenceCostume?.costumeName,
      fallbackFromBitmap: Boolean(bitmapFallbackError),
      bitmapError: bitmapFallbackError || undefined,
      createdCostumes: costumes.map((costume) => ({ id: costume.id, name: costume.name })),
    };
  };

  const updateCostume = async (args: Record<string, any>) => {
    const target = getCostumeTarget(args.targetId);
    const { costume, index } = findCostume(target, args);
    const assetLabel = getTargetAssetLabel(target);
    const updateDescription = String(args.updateDescription || args.costumeDescription || "").trim();
    const imageSize = getImageGenerationSize(args);
    const referenceCostume = resolveReferenceCostumeAsset(args, target);
    if (!updateDescription) {
      throw new Error("updateCostume requires updateDescription");
    }

    if (String(costume.dataFormat || "").toLowerCase() !== "svg") {
      if (!imageGenerationModel) {
        throw new Error("更新位图造型需要先配置文生图模型。");
      }
      const originalCostumeImage = buildReferenceCostumeAsset(target, costume, index);
      const referenceHint =
        referenceCostume && referenceCostume.costumeId !== costume.id
          ? `\nAdditional visual reference: ${referenceCostume.name}. Use it for style, shape, and colors when helpful.`
          : "";
      const imageBuffer = await generateImageWithOpenAICompatibleModel({
        model: imageGenerationModel,
        prompt: `Edit this Scratch bitmap ${assetLabel}.\nCostume name: ${costume.name}\nRequested update: ${updateDescription}${referenceHint}`,
        size: imageSize,
        referenceImage: {
          dataUrl: originalCostumeImage.dataUrl,
          mimeType: originalCostumeImage.mimeType,
          name: originalCostumeImage.fileName,
        },
        signal: abortControllerRef.current?.signal,
      });
      const { width, height } = await readImageBufferDimensions(imageBuffer);
      const { rotationCenterX, rotationCenterY } = getScaledBitmapRotationCenter(costume, width, height);
      utils.updateCostumeByTargetId(
        {
          costumeId: costume.id,
          costumeIndex: index,
          isVector: false,
          bitmap: imageBuffer,
          rotationCenterX,
          rotationCenterY,
          width,
          height,
        },
        target.id,
      );

      return {
        success: true,
        targetId: target.id,
        targetType: target.isStage ? "stage" : "sprite",
        assetType: assetLabel,
        costumeId: costume.id,
        costumeName: costume.name,
        costumeType: "bitmap",
        imageSize,
        imageModel: imageGenerationModel.displayName,
        referenceCostumeId: referenceCostume?.costumeId,
        referenceCostumeName: referenceCostume?.costumeName,
      };
    }

    const originalSvg = getCostumeSvg(target, costume, index);
    const normalizedSvg = ensureSvgRotationCenterAttrs(await runSvgSubAgent({
      mode: "update",
      costumeName: costume.name,
      costumeDescription: updateDescription,
      originalSvg,
      referenceCostume,
    }));
    const { svgCode } = normalizedSvg;
    const { width, height, rotationCenterX, rotationCenterY } = normalizedSvg.geometry;
    utils.updateCostumeByTargetId(
      {
        costumeId: costume.id,
        isVector: true,
        bitmap: svgCode,
        rotationCenterX,
        rotationCenterY,
        width,
        height,
      },
      target.id,
    );

    return {
      success: true,
      targetId: target.id,
      targetType: target.isStage ? "stage" : "sprite",
      assetType: assetLabel,
      costumeId: costume.id,
      costumeName: costume.name,
      referenceCostumeId: referenceCostume?.costumeId,
      referenceCostumeName: referenceCostume?.costumeName,
    };
  };

  const deleteCostume = async (args: Record<string, any>) => {
    const target = getCostumeTarget(args.targetId);
    const { costume, index } = findCostume(target, args);
    const costumes = getTargetCostumes(target);
    if (costumes.length <= 1) {
      throw new Error(`Cannot delete the only ${getTargetAssetLabel(target)} of a target.`);
    }
    utils.deleteCostumeByTargetId(index, target.id);
    return {
      success: true,
      targetId: target.id,
      targetType: target.isStage ? "stage" : "sprite",
      assetType: getTargetAssetLabel(target),
      deletedCostumeId: costume.id,
      deletedCostumeName: costume.name,
    };
  };

  const observeStageTool = async (limits?: SubAgentProfile["gameLimits"]) =>
    observeStage(vm, {
      signal: abortControllerRef.current?.signal,
      mode: stageScreenshotMode,
      maxScreenshotBytes: limits?.maxScreenshotBytes,
    });

  const runStageScriptTool = async (args: Record<string, any>, limits?: SubAgentProfile["gameLimits"]) => {
    const script = String(args.script || "").trim();
    if (!script) throw new Error("runStageScript requires script");
    return runStageScript(vm, script, limits, {
      signal: abortControllerRef.current?.signal,
      mode: stageScreenshotMode,
      maxScreenshotBytes: limits?.maxScreenshotBytes,
    });
  };

  const callSubAgentTool = async (functionName: string, args: Record<string, any>, toolCallId = "") => {
    if (SUBAGENT_DISABLED_TOOL_NAMES.has(functionName)) {
      throw new Error(`Tool ${functionName} is not available in child AI.`);
    }
    return callTool(functionName, args, toolCallId);
  };

  const runSubAgent = async (
    args: Record<string, any>,
    onProgress?: (payload: {
      success: boolean;
      name: string;
      task: string;
      context: string;
      successCriteria: string;
      avatarBackground: string;
      avatarIcon: string;
      summary: string;
      messages: ChatMessage[];
      completed: boolean;
      turnCount: number;
    }) => void,
  ) => {
    if (!currentAgent) {
      throw new Error("No current AI agent available for delegated execution");
    }
    if (!allowSubAgents) {
      throw new Error("Sub agents are disabled in settings.");
    }

    const task = String(args.task || "").trim();
    const name = String(args.name || "").trim() || "子AI";
    const context = String(args.context || "").trim();
    const successCriteria = String(args.successCriteria || "").trim();
    if (!task) {
      throw new Error("runSubAgent requires task");
    }

    const subAgentProfile = subAgents.find((agent) => agent.name === name);
    if (!subAgentProfile) {
      throw new Error(`Sub agent not found: ${name}`);
    }
    if (subAgentProfile.enabled === false) {
      throw new Error(`Sub agent is disabled: ${name}`);
    }

    const providerAdapter = getProviderAdapter(currentAgent.provider);
    const isGameAgent = subAgentProfile.builtinToolGroups.includes("game");
    if (isGameAgent && !isVisionModel(currentAgent)) {
      throw new Error("Game Agent requires a multimodal vision model. Enable a vision-capable model before using it.");
    }
    const extensionGuides = getRuntimeExtensionGuides(vm?.runtime);
    const allowedUserGuides = userGuides.filter(
      (guide) => guide.enabled !== false && subAgentProfile.enabledUserGuideIds.includes(guide.id),
    );
    const allowedExtensionGuides = subAgentProfile.enableExtensionGuides ? extensionGuides : [];
    const allowedGuideNameSet = new Set(
      getAllGuides(allowedUserGuides, allowedExtensionGuides).map((guide) => guide.name),
    );
    const allowedToolNames = new Set<string>();
    subAgentProfile.builtinToolGroups.forEach((group) => {
      TOOL_NAMES_BY_GROUP[group]?.forEach((toolName) => allowedToolNames.add(toolName));
    });
    if (subAgentProfile.builtinToolGroups.includes("read")) allowedToolNames.add("runGuideTool");
    const allowedToolSchemas = filterToolSchemasForChatMode(
      filterToolSchemasForProjectIndex(
        SUBAGENT_TOOL_SCHEMAS.filter((toolSchema: any) => allowedToolNames.has(toolSchema?.function?.name)),
        projectIndexBlockedRef.current,
      ),
      activeConversationModeRef.current,
    );
    let subMessages: ChatMessage[] = [
      {
        id: createMessageId(),
        role: "user",
        content: [
          `Delegated task:\n${task}`,
          `Child AI name:\n${name}`,
          subAgentProfile.description ? `Role description:\n${subAgentProfile.description}` : "",
          context ? `Context:\n${context}` : "",
          successCriteria ? `Definition of done:\n${successCriteria}` : "",
        ]
          .filter(Boolean)
          .join("\n\n"),
      },
    ];

    const emitProgress = (completed: boolean, turnCount: number) => {
      const finalAssistantMessage = [...subMessages]
        .reverse()
        .find((message) => message.role === "assistant" && (message.content?.trim() || message.reasoning?.trim()));
      const payload = {
        success: true,
        name,
        task,
        context,
        successCriteria,
        avatarBackground: subAgentProfile.avatarBackground,
        avatarIcon: subAgentProfile.avatarIcon,
        summary:
          String(finalAssistantMessage?.content || finalAssistantMessage?.reasoning || "子任务执行中...").trim() ||
          "子任务执行中...",
        messages: cloneChatMessages(subMessages),
        completed,
        turnCount,
      };
      onProgress?.(payload);
      return payload;
    };

    const createFinalSubAgentResult = (completed: boolean, turnCount: number) => {
      const finalAssistantMessage = [...subMessages]
        .reverse()
        .find((message) => message.role === "assistant" && (message.content?.trim() || message.reasoning?.trim()));
      return (
        String(finalAssistantMessage?.content || finalAssistantMessage?.reasoning || "").trim() ||
        (completed ? "子任务已完成，但没有返回可用摘要。" : `子任务未完成，已执行 ${turnCount} 轮。`)
      );
    };

    let shouldContinue = true;
    let turns = 0;

    const compressSubAgentMessages = async (options?: { trimPercent?: number }) => {
      const trimmedMessages = subMessages.filter(
        (message, index) =>
          !(
            index === subMessages.length - 1 &&
            message.role === "assistant" &&
            !message.content &&
            !message.reasoning &&
            !message.tool_calls?.length
          ),
      );
      const normalizedMessages = trimMessagesForCompressionRequest(
        stripUnansweredAssistantToolCalls(stripIncompleteTailToolCalls(trimmedMessages)),
        currentAgent,
        options?.trimPercent || 0,
      );
      const requestCompressionSummary = async (messagesForSummary: ChatMessage[]) => {
        let summary = "";
        const data = await providerAdapter.sendChatCompletion({
        agent: currentAgent,
        messages: [
          {
            id: createMessageId(),
            role: "system",
            content: COMPRESSION_SUMMARY_SYSTEM_PROMPT,
          },
          {
            id: createMessageId(),
            role: "user",
            content: buildCompressionMessages(messagesForSummary),
          },
        ],
        enableReasoning: false,
        stream: false,
        signal: abortControllerRef.current?.signal,
        onTextDelta: (delta) => {
          summary += delta;
        },
        });
        return getCompletionText(data, summary).trim();
      };
      let finalSummary = await requestCompressionSummary(normalizedMessages).catch((error) => {
        if (!isCompressionFallbackError(error)) throw error;
        return "";
      });
      if (!finalSummary) {
        finalSummary = buildLocalCompressionFallbackSummary(normalizedMessages, "Sub agent remote compression returned an empty summary.");
      }
      subMessages = [
        ...createCompressedContextMessages(normalizedMessages, finalSummary),
        {
          id: createMessageId(),
          role: "user",
          content: SUBAGENT_CONTEXT_CONTINUATION_PROMPT,
          hidden: true,
        },
      ];
      emitProgress(false, turns);
    };

    const compressSubAgentMessagesIfNeeded = async () => {
      if (estimateContextUsage(subMessages, currentAgent).percent < AUTO_CONTEXT_COMPRESSION_THRESHOLD_PERCENT) return;
      await compressSubAgentMessages();
    };

    const isStreamInterruptionError = (error: unknown) => {
      return isUpstreamInterruptionError(error);
    };

    emitProgress(false, 0);

    const gameLimits = normalizeStageComputerUseLimits(subAgentProfile.gameLimits);
    const maxTurns = isGameAgent ? gameLimits.maxToolTurns : 8;
    const appendSubAgentAssistantMessage = () => {
      const assistantMessageId = createMessageId();
      subMessages.push({
        id: assistantMessageId,
        role: "assistant",
        content: "",
        reasoning: "",
      });
      emitProgress(false, turns);
      return assistantMessageId;
    };
    const updateSubAgentAssistantMessage = (
      assistantMessageId: string,
      updater: (message: ChatMessage) => ChatMessage,
    ) => {
      subMessages = subMessages.map((message) => (message.id === assistantMessageId ? updater(message) : message));
      emitProgress(false, turns);
    };
    const buildSubAgentProviderMessages = () => [
      {
        id: createMessageId(),
        role: "system" as const,
        content: [
          SUBAGENT_SYSTEM_PROMPT,
          isGameAgent ? GAME_AGENT_SYSTEM_PROMPT : "",
          subAgentProfile.prompt,
          getEnabledGuideSystemText(allowedUserGuides, allowedExtensionGuides),
        ]
          .filter(Boolean)
          .join("\n\n"),
      },
      ...buildRequestMessages(subMessages, false),
    ];
    const sendSubAgentCompletion = (assistantMessageId: string) =>
      providerAdapter.sendChatCompletion({
        agent: currentAgent,
        messages: buildSubAgentProviderMessages(),
        tools: allowedToolSchemas,
        toolChoice: "auto",
        enableReasoning: false,
        signal: abortControllerRef.current?.signal,
        onReasoningDelta: (delta) => {
          updateSubAgentAssistantMessage(assistantMessageId, (message) => ({
            ...message,
            reasoning: `${message.reasoning || ""}${delta}`,
          }));
        },
        onTextDelta: (delta) => {
          updateSubAgentAssistantMessage(assistantMessageId, (message) => ({
            ...message,
            content: `${message.content || ""}${delta}`,
          }));
        },
        onToolCallsDelta: (toolCalls) => {
          updateSubAgentAssistantMessage(assistantMessageId, (message) => ({
            ...message,
            tool_calls: toolCalls,
          }));
        },
      });

    const materializeStageImageMemory = async (toolMessageIndex: number) => {
      const sourceMessage = subMessages[toolMessageIndex];
      if (!getMessageStageImages(sourceMessage).length) return;
      let memoryText = "";
      const data = await providerAdapter.sendChatCompletion({
        agent: currentAgent,
        messages: buildStageImageMemoryMessages(sourceMessage),
        enableReasoning: false,
        stream: false,
        signal: abortControllerRef.current?.signal,
        onTextDelta: (delta) => {
          memoryText += delta;
        },
      });
      const finalMemory = (data.choices[0].message.content || memoryText).trim();
      if (!finalMemory) return;
      subMessages[toolMessageIndex] = {
        ...subMessages[toolMessageIndex],
        modelContent: `${subMessages[toolMessageIndex].modelContent || "Stage screenshot captured."}\n\nTemporary visual memory for this screenshot:\n${finalMemory}`,
        stageObservation: undefined,
        stageObservations: undefined,
      };
      emitProgress(false, turns);
    };

    const releaseStageTakeover = isGameAgent ? activateStageTakeover(vm, name) : undefined;
    try {
    while (shouldContinue && (maxTurns === "infinite" || turns < maxTurns)) {
      await compressSubAgentMessagesIfNeeded();
      turns += 1;
      let assistantMessageId = appendSubAgentAssistantMessage();

      let data;
      for (let attempt = 0; attempt <= SUBAGENT_STREAM_INTERRUPTION_RETRY_LIMIT; attempt += 1) {
        try {
          data = await sendSubAgentCompletion(assistantMessageId);
          break;
        } catch (error) {
          if (
            abortControllerRef.current?.signal.aborted ||
            (!isStreamInterruptionError(error) && !isNetworkRetryableError(error)) ||
            attempt >= SUBAGENT_STREAM_INTERRUPTION_RETRY_LIMIT
          ) {
            throw error;
          }
          if (isNetworkRetryableError(error)) {
            const delayMs = NETWORK_RETRY_DELAYS_MS[attempt];
            const messagesBeforeRetry = cloneChatMessages(subMessages);
            subMessages = subMessages.map((message) =>
              message.id === assistantMessageId
                ? {
                    ...message,
                    content: getNetworkRetryNotice(delayMs, attempt, error),
                    reasoning: message.reasoning || "",
                    tool_calls: undefined,
                  }
                : message,
            );
            emitProgress(false, turns);
            await waitForRetryDelay(delayMs, abortControllerRef.current?.signal);
            subMessages = messagesBeforeRetry;
            emitProgress(false, turns);
            continue;
          }
          subMessages = omitStageImagesForModel(subMessages);
          emitProgress(false, turns);
          try {
            await compressSubAgentMessages({
              trimPercent: SUBAGENT_STREAM_INTERRUPTION_COMPRESSION_TRIM_PERCENT * (attempt + 1),
            });
          } catch (compressionError) {
            if (attempt >= SUBAGENT_STREAM_INTERRUPTION_RETRY_LIMIT) {
              throw compressionError;
            }
            continue;
          }
          assistantMessageId = appendSubAgentAssistantMessage();
        }
      }
      if (!data) {
        throw new Error("子智能体请求未返回结果。");
      }
      const responseMessage = data.choices[0].message as ChatMessage;
      updateSubAgentAssistantMessage(assistantMessageId, (message) => ({
        ...message,
        role: "assistant",
        content: responseMessage.content || message.content || "",
        reasoning: responseMessage.reasoning || message.reasoning,
        tool_calls: responseMessage.tool_calls || message.tool_calls,
        anthropic_content_blocks: responseMessage.anthropic_content_blocks,
      }));
      emitProgress(false, turns);

      const providerContextUsage = contextUsageFromProviderUsage(data.usage, currentAgent);
      if (providerContextUsage?.percent >= AUTO_CONTEXT_COMPRESSION_THRESHOLD_PERCENT) {
        await compressSubAgentMessages();
        continue;
      }

      if (!responseMessage.tool_calls?.length) {
        shouldContinue = false;
        break;
      }

      for (const toolCall of responseMessage.tool_calls) {
        const functionName = toolCall.function.name;
        let toolResult = "";
        const toolMessageIndex = subMessages.length;
        subMessages.push({
          id: createMessageId(),
          role: "tool",
          tool_call_id: toolCall.id,
          name: functionName,
          content: "",
        });
        emitProgress(false, turns);

        let modelToolResult = "";
        try {
          let parsedArgs: Record<string, any> = {};
          try {
            const candidate = toolCall.function.arguments ? JSON.parse(toolCall.function.arguments) : {};
            if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
              throw new Error("Tool arguments must be a JSON object");
            }
            parsedArgs = candidate;
          } catch (parseError: any) {
            throw new Error(`Invalid tool arguments: ${parseError.message}`);
          }

          validateToolArguments(functionName, parsedArgs);
          if (functionName === "runGuideTool") {
            const fullToolName = String(parsedArgs.tool || "").trim();
            const skillName = fullToolName.split(".")[0];
            if (!allowedGuideNameSet.has(skillName)) {
              throw new Error(`Guide tool is not enabled for sub agent ${name}: ${fullToolName}`);
            }
          }
          const result =
            functionName === "observeStage"
              ? await observeStageTool(subAgentProfile.gameLimits)
              : functionName === "runStageScript"
                ? await runStageScriptTool(parsedArgs, subAgentProfile.gameLimits)
                : await callSubAgentTool(functionName, parsedArgs, toolCall.id);
          toolResult = serializeToolResultForDisplay(functionName, result);
          modelToolResult = compactToolResultForModel(functionName, result);
          attachStageImagesToToolMessage(subMessages, toolMessageIndex, functionName, result, modelToolResult);
        } catch (error: any) {
          if (error?.name === "AbortError") {
            throw error;
          }
          const partialStageResult = functionName === "runStageScript" ? getStageScriptPartialResult(error) : undefined;
          if (partialStageResult) {
            toolResult = serializeToolResultForDisplay(functionName, partialStageResult);
            modelToolResult = compactToolResultForModel(functionName, partialStageResult);
            attachStageImagesToToolMessage(
              subMessages,
              toolMessageIndex,
              functionName,
              partialStageResult,
              modelToolResult,
            );
          } else {
            toolResult = `Error: ${error?.message || String(error)}`;
            modelToolResult = toolResult;
          }
        }

        subMessages[toolMessageIndex] = {
          ...subMessages[toolMessageIndex],
          role: "tool",
          tool_call_id: toolCall.id,
          name: functionName,
          content: toolResult,
          modelContent:
            subMessages[toolMessageIndex].modelContent ||
            modelToolResult ||
            (functionName === "observeStage"
              ? "Stage screenshot capture failed. No image is available."
              : undefined),
          stageObservation: subMessages[toolMessageIndex].stageObservation,
          stageObservations: subMessages[toolMessageIndex].stageObservations,
          stageObservationForDisplay: subMessages[toolMessageIndex].stageObservationForDisplay,
          stageObservationsForDisplay: subMessages[toolMessageIndex].stageObservationsForDisplay,
        };
        emitProgress(false, turns);
        await materializeStageImageMemory(toolMessageIndex);
        await compressSubAgentMessagesIfNeeded();
      }
    }

    emitProgress(true, turns);
    return createFinalSubAgentResult(true, turns);
    } finally {
      releaseStageTakeover?.();
    }
  };

  const callTool = async (functionName: string, args: Record<string, any>, toolCallId = "") => {
    if (activeConversationModeRef.current === "chat" && CHAT_MODE_BLOCKED_TOOL_NAMES.has(functionName)) {
      throw new Error(CHAT_MODE_BLOCKED_TOOL_MESSAGE);
    }
    if (projectIndexBlockedRef.current && PROJECT_INDEX_BLOCKED_TOOL_NAMES.has(functionName)) {
      throw new Error(PROJECT_INDEX_BLOCKED_TOOL_MESSAGE);
    }
    if (functionName === "askUser") {
      return askUser(args, toolCallId);
    }
    if (functionName === "runSubAgent") {
      return runSubAgent(args);
    }
    if (functionName === "insertCostume") {
      return insertCostume(args, toolCallId);
    }
    if (functionName === "updateCostume") {
      return updateCostume(args);
    }
    if (functionName === "deleteCostume") {
      return deleteCostume(args);
    }

    const aiTools = aiToolsRef.current as Record<string, any> | null;
    if (!aiTools || typeof aiTools[functionName] !== "function") {
      throw new Error(`Tool ${functionName} not found`);
    }

    switch (functionName) {
      case "readFile":
        return aiTools[functionName](args.path, args.startLine, args.endLine);
      case "discardDraft":
        return aiTools[functionName](args.path);
      case "searchFiles":
        return aiTools[functionName](args);
      case "searchBlocks":
        return aiTools[functionName](args);
      case "getBlocksHelp":
        return aiTools[functionName]({ opcodes: args.opcodes, includeSuggestions: args.includeSuggestions });
      case "getScratchGuide":
        return aiTools[functionName](args.topic);
      case "runGuideTool":
        return aiTools[functionName]({ tool: args.tool, args: args.args });
      case "createAiGuide":
        await auditAiGuideCreation(args, toolCallId);
        return aiTools[functionName]({
          name: args.name,
          title: args.title,
          description: args.description,
          content: args.content,
          indexJs: args.indexJs,
        });
      case "getAllExtensions":
        return aiTools[functionName]();
      case "searchExtensions":
        return aiTools[functionName](args);
      case "addExtension":
        return aiTools[functionName](args.extensionId);
      case "getExtensionBlocks":
        return aiTools[functionName](args.extensionId);
      case "getProjectOverview":
        return aiTools[functionName]();
      case "applyPatch":
        return aiTools[functionName](args.patch);
      case "getDiagnostics":
        return aiTools[functionName](args.path, { verbose: Boolean(args.verbose) });
      case "listFiles":
        return aiTools[functionName]();
      case "updateTodoList":
        return aiTools[functionName]({ todos: args.todos });
      case "listMemoryBlocks":
        return aiTools[functionName]({ scope: args.scope });
      case "getMemoryBlock":
        return aiTools[functionName](args.id, args.scope);
      case "setMemoryBlock":
        return aiTools[functionName]({
          id: args.id,
          scope: args.scope,
          content: args.content,
          description: args.description,
        });
      case "replaceMemoryBlockText":
        return aiTools[functionName]({
          id: args.id,
          oldText: args.oldText,
          newText: args.newText,
          scope: args.scope,
        });
      case "deleteMemoryBlock":
        return aiTools[functionName](args.id, args.scope);
      default:
        return aiTools[functionName]();
    }
  };

  useEffect(() => {
    if (vm) {
      aiToolsRef.current = new AITools(vm, userGuides, workspace, blockly, { createAiGuide });
      refreshProjectIndexStatus();
      refreshProjectExamplePrompts();
    }
  }, [vm, userGuides, workspace, blockly, createAiGuide]);

  useEffect(() => {
    if (!vm) return undefined;
    const intervalId = window.setInterval(() => {
      if (!projectIndexBuild.running) {
        refreshProjectIndexStatus();
        refreshProjectExamplePrompts();
      }
    }, 2000);
    return () => window.clearInterval(intervalId);
  }, [vm, projectIndexBuild.running]);

  useEffect(() => {
    if (projectIndexBuild.running || projectIndexBuild.error || projectIndexBuild.stopped) return undefined;
    if (!projectIndexBuild.phase && !projectIndexBuild.exportText) return undefined;
    if (projectIndexStatus?.blocked) return undefined;
    if (Number(projectIndexBuild.progress || 0) < 100) return undefined;

    const timerId = window.setTimeout(() => {
      setProjectIndexBuild((previous) => {
        if (previous.running || previous.error || previous.stopped || Number(previous.progress || 0) < 100) return previous;
        if (projectIndexBlockedRef.current) return previous;
        return { running: false, progress: 0, phase: "" };
      });
    }, 2000);
    return () => window.clearTimeout(timerId);
  }, [
    projectIndexBuild.error,
    projectIndexBuild.exportText,
    projectIndexBuild.phase,
    projectIndexBuild.progress,
    projectIndexBuild.running,
    projectIndexBuild.stopped,
    projectIndexStatus?.blocked,
  ]);

  useEffect(() => {
    return () => {
      abortControllerRef.current?.abort();
      projectIndexAbortControllerRef.current?.abort();
    };
  }, []);

  const handleStopProjectIndex = () => {
    const controller = projectIndexAbortControllerRef.current;
    if (!controller || controller.signal.aborted) return;
    controller.abort(new DOMException("Project index build stopped by user.", "AbortError"));
    setProjectIndexBuild((previous) => ({
      ...previous,
      running: false,
      phase: "索引构建已停止",
      error: "已停止构建项目索引。",
      stopped: true,
    }));
  };

  const handleBuildProjectIndex = async () => {
    if (projectIndexBuild.running) return;
    const aiTools = aiToolsRef.current;
    if (!aiTools) {
      setProjectIndexBuild({ running: false, progress: 0, phase: "索引工具不可用", error: "AI 工具尚未初始化。" });
      return;
    }
    if (!currentAgent || !isProviderImplemented(currentAgent.provider)) {
      setProjectIndexBuild({ running: false, progress: 0, phase: "索引构建失败", error: "当前没有可用的 AI Agent。" });
      return;
    }

    const buildAbortController = new AbortController();
    projectIndexAbortControllerRef.current = buildAbortController;
    const getAbortSignal = () => buildAbortController.signal;
    const buildLog: Array<Record<string, unknown>> = [];
    const appendBuildLog = (event: string, data?: Record<string, unknown>) => {
      buildLog.push({
        time: new Date().toISOString(),
        event,
        ...(data || {}),
      });
    };
    const createBuildExportText = (status: string, extra?: Record<string, unknown>) =>
      JSON.stringify(
        {
          type: "ai-assistant-project-index-build",
          exportedAt: new Date().toISOString(),
          status,
          currentProjectIndexStatus: aiTools.getProjectIndexStatus?.(),
          ...(extra || {}),
          log: buildLog,
        },
        null,
        2,
      );
    const throwIfBuildStopped = () => {
      if (buildAbortController.signal.aborted) {
        throw buildAbortController.signal.reason || new DOMException("Project index build stopped by user.", "AbortError");
      }
    };

    const setProgress = (progress: number, phase: string, error?: string, largeProject?: boolean) => {
      appendBuildLog("progress", { progress: Math.max(0, Math.min(100, progress)), phase, error });
      setProjectIndexBuild({
        running: progress < 100 && !error,
        progress: Math.max(0, Math.min(100, progress)),
        phase,
        error,
        largeProject,
        stopped: false,
        exportText: error ? createBuildExportText("failed", { error, phase }) : undefined,
      });
    };

    try {
      setProgress(0, "扫描项目");
      const snapshot = aiTools.getProjectIndexSnapshot();
      appendBuildLog("snapshot", {
        targetCount: snapshot.targetCount,
        scriptCount: snapshot.scriptCount,
        targets: (snapshot.targets || []).map((target: any) => ({
          targetId: target.targetId,
          targetName: target.targetName,
          scriptCount: Array.isArray(target.scripts) ? target.scripts.length : 0,
          mappedScriptCount: target.mappedScriptCount,
          missingScriptIds: target.missingScriptIds,
          hasIndexComment: target.hasIndexComment,
          existingFiles: target.existingFiles,
          defaultScriptFileName: target.defaultScriptFileName,
        })),
      });
      if (!snapshot.scriptCount) {
        setProgress(100, "项目没有脚本，无需构建索引");
        refreshProjectIndexStatus();
        setProjectIndexBuild((previous) => ({
          ...previous,
          exportText: createBuildExportText("skipped", { reason: "no scripts" }),
        }));
        return;
      }

      const targetsToIndex = (snapshot.targets || [])
        .map((target: any) => {
          const allScripts = Array.isArray(target?.scripts) ? target.scripts : [];
          const missingScriptIdSet = new Set((target?.missingScriptIds || []).map((scriptId: any) => String(scriptId)));
          const scriptsToIndex = target?.hasIndexComment
            ? allScripts.filter((script: any) => script?.needsIndex || missingScriptIdSet.has(String(script?.scriptId)))
            : allScripts;
          return {
            ...target,
            scripts: scriptsToIndex,
            allScriptCount: allScripts.length,
            incremental: Boolean(target?.hasIndexComment),
          };
        })
        .filter((target: any) => Array.isArray(target?.scripts) && target.scripts.length > 0);
      const snapshotBlockCount = targetsToIndex.reduce(
        (sum: number, target: any) =>
          sum + (target.scripts || []).reduce((scriptSum: number, script: any) => scriptSum + Number(script.blockCount || 0), 0),
        0,
      );
      const snapshotCodeChars = targetsToIndex.reduce(
        (sum: number, target: any) =>
          sum + (target.scripts || []).reduce((scriptSum: number, script: any) => scriptSum + String(script.code || "").length, 0),
        0,
      );
      const pendingScriptCount = targetsToIndex.reduce(
        (sum: number, target: any) => sum + (Array.isArray(target?.scripts) ? target.scripts.length : 0),
        0,
      );
      const isLargeProjectIndex =
        pendingScriptCount >= PROJECT_INDEX_LARGE_SCRIPT_THRESHOLD ||
        snapshotBlockCount >= PROJECT_INDEX_LARGE_BLOCK_THRESHOLD ||
        snapshotCodeChars >= PROJECT_INDEX_LARGE_CODE_CHARS_THRESHOLD;
      appendBuildLog("pendingIndexWork", {
        pendingScriptCount,
        pendingTargetCount: targetsToIndex.length,
        fullScriptCount: snapshot.scriptCount,
        incremental: targetsToIndex.some((target: any) => target.incremental),
      });
      const totalTargetCount = Math.max(1, targetsToIndex.length);
      const submittedTargetPlans = new Map<string, any>();
      let finishRequested = false;
      const getIndexedProgress = () => Math.round((submittedTargetPlans.size / totalTargetCount) * 82);
      const updateIndexedProgress = (phase?: string) => {
        setProjectIndexBuild({
          running: true,
          progress: Math.max(0, Math.min(82, getIndexedProgress())),
          phase: phase || `索引 AI 正在整理 ${submittedTargetPlans.size}/${totalTargetCount} 个角色`,
          largeProject: isLargeProjectIndex,
          stopped: false,
        });
      };
      const getIndexScriptVirtualPath = (target: any, scriptId: string) =>
        `${target.rootPath}/index-scripts/${encodeURIComponent(scriptId)}.js`;
      const snapshotByTargetId = new Map(targetsToIndex.map((target: any) => [String(target.targetId), target]));
      const targetListForModel = targetsToIndex.map((target: any) => ({
        targetId: target.targetId,
        targetName: target.targetName,
        isStage: target.isStage,
        rootPath: target.rootPath,
        defaultScriptFileName: target.defaultScriptFileName,
        incremental: target.incremental,
        allScriptCount: target.allScriptCount,
        mappedScriptCount: target.mappedScriptCount,
        existingFiles: target.existingFiles || [],
        scripts: (target.scripts || []).map((script: any) => ({
          scriptId: script.scriptId,
          virtualPath: getIndexScriptVirtualPath(target, String(script.scriptId)),
          hatOpcode: script.hatOpcode,
          blockCount: script.blockCount,
          suggestedFileName: script.suggestedFileName,
          x: script.x,
          y: script.y,
        })),
      }));

      const indexToolSchemas = [
        {
          type: "function",
          function: {
            name: "listIndexFiles",
            description:
              "List the Scratch targets and temporary script files that still need project-index grouping. For incremental targets, existingFiles are already indexed and must be preserved.",
            parameters: { type: "object", properties: {} },
          },
        },
        {
          type: "function",
          function: {
            name: "readIndexScript",
            description:
              "Read one temporary script file's Scratch JS DSL before deciding which feature file it belongs in.",
            parameters: {
              type: "object",
              properties: {
                targetId: { type: "string", description: "Target id from listIndexFiles." },
                scriptId: { type: "string", description: "Script id from listIndexFiles." },
              },
              required: ["targetId", "scriptId"],
            },
          },
        },
        {
          type: "function",
          function: {
            name: "submitTargetIndex",
            description:
              "Submit the completed grouping for exactly one target. Include each pending scriptId from that target exactly once; existingFiles are preserved automatically in incremental builds.",
            parameters: {
              type: "object",
              properties: {
                targetId: { type: "string" },
                defaultScriptFileName: {
                  type: "string",
                  description: "Default feature file for newly added scripts in this target, such as default.js.",
                },
                files: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      fileName: { type: "string", description: "Feature file name ending in .js." },
                      description: { type: "string", description: "Short functional purpose." },
                      scriptIds: { type: "array", items: { type: "string" } },
                    },
                    required: ["fileName", "scriptIds"],
                  },
                },
              },
              required: ["targetId", "files"],
            },
          },
        },
        {
          type: "function",
          function: {
            name: "finishProjectIndex",
            description:
              "Call only after every target returned by listIndexFiles has been submitted with submitTargetIndex. Include your concise understanding of the project so it can be saved into project memory.",
            parameters: {
              type: "object",
              properties: {
                projectUnderstanding: {
                  type: "string",
                  description:
                    "Concise Chinese summary of the project goal, major sprites/systems, important script organization, and useful notes for future editing.",
                },
                chatExampleRequests: {
                  type: "array",
                  items: { type: "string" },
                  description:
                    "3-5 concise Chinese example requests for Chat mode. They should help the user ask for explanation, planning, analysis, or review based on this project, without directly editing it.",
                },
                codeExampleRequests: {
                  type: "array",
                  items: { type: "string" },
                  description:
                    "3-5 concise Chinese example requests for Code mode. They should be practical edit requests based on this project, such as adding a feature, fixing logic, or improving scripts.",
                },
              },
              required: ["projectUnderstanding"],
            },
          },
        },
      ];

      const buildIndexToolResult = (functionName: string, args: any) => {
        if (functionName === "listIndexFiles") {
          return {
            success: true,
            targetCount: targetsToIndex.length,
            submittedTargetCount: submittedTargetPlans.size,
            remainingTargetIds: targetsToIndex
              .map((target: any) => String(target.targetId))
              .filter((targetId: string) => !submittedTargetPlans.has(targetId)),
            targets: targetListForModel.map((target: any) => ({
              ...target,
              status: submittedTargetPlans.has(String(target.targetId)) ? "indexed" : "pending",
            })),
          };
        }
        if (functionName === "readIndexScript") {
          const targetId = String(args?.targetId || "");
          const scriptId = String(args?.scriptId || "");
          const target = snapshotByTargetId.get(targetId) as any;
          const script = target?.scripts?.find((item: any) => String(item.scriptId) === scriptId);
          if (!target || !script) {
            return { success: false, error: `Script not found: targetId=${targetId}, scriptId=${scriptId}` };
          }
          return {
            success: true,
            targetId,
            targetName: target.targetName,
            scriptId,
            virtualPath: getIndexScriptVirtualPath(target, scriptId),
            hatOpcode: script.hatOpcode,
            blockCount: script.blockCount,
            suggestedFileName: script.suggestedFileName,
            code: script.code,
          };
        }
        if (functionName === "submitTargetIndex") {
          const targetId = String(args?.targetId || "");
          const target = snapshotByTargetId.get(targetId) as any;
          if (!target) return { success: false, error: `Unknown targetId: ${targetId}` };
          const files = Array.isArray(args?.files) ? args.files : [];
          const expectedScriptIds = new Set<string>((target.scripts || []).map((script: any) => String(script.scriptId)));
          const seenScriptIds = new Set<string>();
          const seenFileNames = new Set<string>();
          const defaultScriptFileName = String(args?.defaultScriptFileName || files[0]?.fileName || "default.js").trim() || "default.js";
          const normalizedFiles = files.map((file: any, index: number) => {
            const fileName = String(file?.fileName || `feature-${index + 1}.js`).trim();
            const scriptIds = Array.isArray(file?.scriptIds) ? file.scriptIds.map((scriptId: any) => String(scriptId)) : [];
            if (!fileName || !/\.js$/i.test(fileName)) {
              throw new Error(`submitTargetIndex fileName must end with .js: ${fileName || "(empty)"}`);
            }
            if (seenFileNames.has(fileName)) {
              throw new Error(`submitTargetIndex duplicate fileName: ${fileName}`);
            }
            seenFileNames.add(fileName);
            if (!scriptIds.length) throw new Error(`submitTargetIndex file ${fileName} has no scriptIds.`);
            scriptIds.forEach((scriptId) => {
              if (!expectedScriptIds.has(scriptId)) throw new Error(`submitTargetIndex unknown scriptId: ${scriptId}`);
              if (seenScriptIds.has(scriptId)) throw new Error(`submitTargetIndex duplicate scriptId: ${scriptId}`);
              seenScriptIds.add(scriptId);
            });
            return {
              fileName,
              description: String(file?.description || "").trim(),
              scriptIds,
            };
          });
          const missingScriptIds = [...expectedScriptIds].filter((scriptId) => !seenScriptIds.has(scriptId));
          if (missingScriptIds.length) {
            const defaultFile =
              normalizedFiles.find((file: any) => file.fileName === defaultScriptFileName) ||
              normalizedFiles.find((file: any) => file.fileName === "default.js");
            if (defaultFile) {
              defaultFile.scriptIds.push(...missingScriptIds);
            } else {
              normalizedFiles.push({
                fileName: defaultScriptFileName,
                description: "Default file for unclassified scripts.",
                scriptIds: missingScriptIds,
              });
            }
          }
          const submittedPlan = {
            targetId,
            targetName: target.targetName,
            incremental: target.incremental,
            defaultScriptFileName,
            files: normalizedFiles,
          };
          submittedTargetPlans.set(targetId, submittedPlan);
          const checkpointResult =
            typeof aiTools.applyProjectScriptIndex === "function"
              ? aiTools.applyProjectScriptIndex({
                  targets: [submittedPlan],
                  incremental: true,
                  partial: true,
                })
              : null;
          appendBuildLog("submitTargetIndex", {
            targetId,
            targetName: target.targetName,
            incremental: target.incremental,
            defaultScriptFileName,
            files: normalizedFiles.map((file: any) => ({
              fileName: file.fileName,
              description: file.description,
              scriptIds: file.scriptIds,
            })),
            autoAssignedMissingScriptIds: missingScriptIds,
            checkpointResult,
          });
          refreshProjectIndexStatus();
          updateIndexedProgress(`已整理 ${submittedTargetPlans.size}/${totalTargetCount} 个角色`);
          return {
            success: true,
            targetId,
            checkpointSaved: Boolean(checkpointResult?.success),
            checkpointStatus: checkpointResult?.status,
            autoAssignedMissingScriptIds: missingScriptIds,
            submittedTargetCount: submittedTargetPlans.size,
            totalTargetCount,
            remainingTargetIds: targetsToIndex
              .map((item: any) => String(item.targetId))
              .filter((itemTargetId: string) => !submittedTargetPlans.has(itemTargetId)),
          };
        }
        if (functionName === "finishProjectIndex") {
          const missingTargetIds = targetsToIndex
            .map((target: any) => String(target.targetId))
            .filter((targetId: string) => !submittedTargetPlans.has(targetId));
          if (missingTargetIds.length) {
            return { success: false, error: `Targets not indexed yet: ${missingTargetIds.join(", ")}` };
          }
          const projectUnderstanding = String(args?.projectUnderstanding || "").trim();
          if (!projectUnderstanding) {
            return { success: false, error: "finishProjectIndex requires projectUnderstanding." };
          }
          const plans = targetsToIndex.map((target: any) => submittedTargetPlans.get(String(target.targetId)));
          const examplePrompts = normalizeExamplePromptSet({
            chatExampleRequests: args?.chatExampleRequests,
            codeExampleRequests: args?.codeExampleRequests,
          });
          const memoryContent = buildProjectIndexMemoryContent(projectUnderstanding, plans, examplePrompts);
          const memoryResult = aiTools.setMemoryBlock?.({
            id: PROJECT_INDEX_MEMORY_ID,
            scope: "project",
            description: "项目索引构建时由 AI 生成的项目理解和脚本分组摘要。",
            content: memoryContent,
          });
          setProjectExamplePrompts(examplePrompts);
          appendBuildLog("finishProjectIndex", {
            projectUnderstanding,
            examplePrompts,
            memoryStored: Boolean(memoryResult?.success),
            memoryError: memoryResult?.success ? undefined : memoryResult?.error,
          });
          finishRequested = true;
          return {
            success: true,
            targetCount: submittedTargetPlans.size,
            memoryStored: Boolean(memoryResult?.success),
            memoryError: memoryResult?.success ? undefined : memoryResult?.error,
            memoryId: memoryResult?.block?.id,
            examplePrompts,
            plan: { targets: plans },
          };
        }
        return { success: false, error: `Unknown index tool: ${functionName}` };
      };

      setProgress(0, "生成虚拟文件列表", undefined, isLargeProjectIndex);
      const providerAdapter = getProviderAdapter(currentAgent.provider);
      let indexMessages: Record<string, unknown>[] = [
        {
          id: createMessageId(),
          role: "system",
          content: [
            "You are a Scratch project indexing agent. Your job is to group existing top-level Scratch DSL scripts into fewer functional virtual JS files.",
            "Do not output a final JSON blob. Use tools to inspect temporary script files, submit one target at a time, then call finishProjectIndex.",
            PROJECT_INDEX_CONTINUE_PROMPT,
            "Each target must be submitted exactly once. Each pending scriptId listed for that target must appear exactly once. Group related scripts by game/system function.",
            "If a target has incremental=true, this is an incremental build: existingFiles are already indexed and will be preserved automatically. Only classify the pending scripts, preferably into matching existing file names when appropriate.",
            "Use concise kebab-case English file names ending in .js, such as player-control.js, enemy-ai.js, ui-flow.js, default.js.",
            "A resulting feature file may contain multiple // @script sections. The grouping only changes virtual file mapping; it must not change Scratch behavior.",
            "When calling finishProjectIndex, pass projectUnderstanding in Chinese: summarize the project goal, important targets, core systems, and notes future editing should remember.",
            "Also pass chatExampleRequests and codeExampleRequests. Chat examples are for explaining/planning/analyzing this project without editing. Code examples are for concrete edits that fit this project.",
          ].join("\n"),
        },
        {
          id: createMessageId(),
          role: "user",
          content: JSON.stringify({
            instruction:
              "Use listIndexFiles, readIndexScript, submitTargetIndex for each target, then finishProjectIndex with projectUnderstanding.",
            targets: targetListForModel,
          }),
        },
      ];

      updateIndexedProgress();
      for (let turn = 0; turn < Math.max(12, totalTargetCount * 8); turn += 1) {
        throwIfBuildStopped();
        const data = await providerAdapter.sendChatCompletion({
          agent: currentAgent,
          messages: indexMessages,
          tools: indexToolSchemas,
          toolChoice: "auto",
          enableReasoning: false,
          stream: false,
          signal: getAbortSignal(),
        });
        throwIfBuildStopped();
        const responseMessage = data.choices[0].message as ChatMessage;
        indexMessages.push({
          ...responseMessage,
          id: createMessageId(),
          role: "assistant",
          content: responseMessage.content || "",
          tool_calls: responseMessage.tool_calls?.length ? responseMessage.tool_calls : undefined,
        });
        if (!responseMessage.tool_calls?.length) {
          if (finishRequested) break;
          indexMessages.push({
            id: createMessageId(),
            role: "user",
            content: PROJECT_INDEX_CONTINUE_PROMPT,
          });
          continue;
        }
        for (const toolCall of responseMessage.tool_calls) {
          let parsedArgs: Record<string, any> = {};
          try {
            parsedArgs = toolCall.function.arguments ? JSON.parse(toolCall.function.arguments) : {};
          } catch (parseError: any) {
            parsedArgs = {};
            indexMessages.push({
              id: createMessageId(),
              role: "tool",
              tool_call_id: toolCall.id,
              name: toolCall.function.name,
              content: JSON.stringify({ success: false, error: `Invalid tool arguments: ${parseError?.message || String(parseError)}` }),
            });
            continue;
          }
          try {
            const result = buildIndexToolResult(toolCall.function.name, parsedArgs);
            indexMessages.push({
              id: createMessageId(),
              role: "tool",
              tool_call_id: toolCall.id,
              name: toolCall.function.name,
              content: JSON.stringify(result),
            });
          } catch (toolError: any) {
            indexMessages.push({
              id: createMessageId(),
              role: "tool",
              tool_call_id: toolCall.id,
              name: toolCall.function.name,
              content: JSON.stringify({ success: false, error: toolError?.message || String(toolError) }),
            });
          }
        }
        if (finishRequested) break;
      }
      if (!finishRequested) {
        throw new Error(`索引 AI 未完成整理：已整理 ${submittedTargetPlans.size}/${totalTargetCount} 个角色。`);
      }

      const plan = { targets: targetsToIndex.map((target: any) => submittedTargetPlans.get(String(target.targetId))) };
      setProgress(88, "写入 Scratch 注释", undefined, isLargeProjectIndex);
      const result = aiTools.applyProjectScriptIndex({ ...plan, incremental: true });
      appendBuildLog("applyProjectScriptIndex", { result });
      setProgress(96, "刷新虚拟文件列表", undefined, isLargeProjectIndex);
      let nextStatus = result?.status || refreshProjectIndexStatus();
      if (nextStatus?.blocked && typeof aiTools.completeProjectScriptIndexWithDefaultFiles === "function") {
        const repairResult = aiTools.completeProjectScriptIndexWithDefaultFiles();
        appendBuildLog("completeProjectScriptIndexWithDefaultFiles", { result: repairResult });
        nextStatus = repairResult?.status || refreshProjectIndexStatus();
      }
      refreshProjectIndexStatus();
      const stillBlocked = Boolean(nextStatus?.blocked);
      setProjectIndexBuild({
        running: false,
        progress: 100,
        phase: stillBlocked ? "项目索引已写入，但仍需检查" : "项目索引构建完成",
        error: stillBlocked ? "索引写入后仍有脚本未映射，已生成构建记录供检查。" : undefined,
        largeProject: isLargeProjectIndex,
        stopped: false,
        exportText: createBuildExportText(stillBlocked ? "needs-check" : "success", {
          plan,
          applyResult: result,
          finalProjectIndexStatus: nextStatus,
          indexMessages,
        }),
      });
    } catch (error: any) {
      if (error?.name === "AbortError" || buildAbortController.signal.aborted) {
        appendBuildLog("stopped", { error: error?.message || String(error) });
        setProjectIndexBuild((previous) => ({
          ...previous,
          running: false,
          phase: "索引构建已停止",
          error: "已停止构建项目索引。",
          stopped: true,
          exportText: createBuildExportText("stopped", { error: error?.message || String(error) }),
        }));
        return;
      }
      appendBuildLog("error", { error: error?.message || String(error) });
      setProjectIndexBuild({
        running: false,
        progress: 0,
        phase: "索引构建失败",
        error: error?.message || String(error),
        exportText: createBuildExportText("failed", { error: error?.message || String(error) }),
      });
    } finally {
      if (projectIndexAbortControllerRef.current === buildAbortController) {
        projectIndexAbortControllerRef.current = null;
      }
    }
  };

  const compressContextMessages = async ({
    sourceMessages,
    sourceSessionId,
    createNewSession = true,
    alertOnFailure = true,
  }: {
    sourceMessages: ChatMessage[];
    sourceSessionId?: string;
    createNewSession?: boolean;
    alertOnFailure?: boolean;
  }) => {
    if (!currentAgent || !isProviderImplemented(currentAgent.provider)) {
      const error = new Error("当前没有可用的 AI Agent，无法压缩对话。");
      if (alertOnFailure) void showAssistantAlert(error.message);
      throw error;
    }

    const statusMessageId = createMessageId();
    const normalizedSourceMessages = sourceMessages.filter((message) => message.kind !== "compressionStatus");
    const targetSessionId = updateSessionMessages(
      [
        ...normalizedSourceMessages,
        {
          id: statusMessageId,
          role: "system",
          content: "正在压缩对话...",
          kind: "compressionStatus",
          compressionStatus: "compressing",
        },
      ],
      sourceSessionId,
    );

    setIsCompressingContext(true);
    try {
      const providerAdapter = getProviderAdapter(currentAgent.provider);
      const requestCompressionSummary = async (messagesForSummary: ChatMessage[]) => {
        let summary = "";
        const data = await providerAdapter.sendChatCompletion({
        agent: currentAgent,
        messages: [
          {
            id: createMessageId(),
            role: "system",
            content: COMPRESSION_SUMMARY_SYSTEM_PROMPT,
          },
          {
            id: createMessageId(),
            role: "user",
            content: buildCompressionMessages(messagesForSummary),
          },
        ],
        enableReasoning: false,
        stream: false,
        signal: abortControllerRef.current?.signal,
        onTextDelta: (delta) => {
          summary += delta;
        },
      });
        return getCompletionText(data, summary).trim();
      };

      let finalSummary = "";
      try {
        finalSummary = await requestCompressionSummary(normalizedSourceMessages);
        if (!finalSummary) {
          throw new Error("Compression summary was empty");
        }
      } catch (firstError) {
        if (!isCompressionFallbackError(firstError)) throw firstError;
        try {
          const trimmedMessages = trimMessagesForCompressionRequest(
            normalizedSourceMessages,
            currentAgent,
            MAIN_CONTEXT_COMPRESSION_RETRY_TRIM_PERCENT,
          );
          finalSummary = await requestCompressionSummary(trimmedMessages);
          if (!finalSummary) {
            throw new Error("Compression summary was empty after retry");
          }
        } catch (secondError) {
          if (!isCompressionFallbackError(secondError)) throw secondError;
          finalSummary = buildLocalCompressionFallbackSummary(
            normalizedSourceMessages,
            secondError instanceof Error ? secondError.message : String(secondError || firstError),
          );
        }
      }
      if (!finalSummary) {
        finalSummary = buildLocalCompressionFallbackSummary(normalizedSourceMessages, "Remote compression returned an empty summary.");
      }

      updateSessionMessages(
        [
          ...normalizedSourceMessages,
          {
            id: statusMessageId,
            role: "system",
            content: "历史记录已压缩",
            kind: "compressionStatus",
            compressionStatus: "completed",
          },
        ],
        targetSessionId,
      );

      const compressedMessages = createCompressedContextMessages(normalizedSourceMessages, finalSummary);

      const newSessionId = createNewSession
        ? createChatSession(compressedMessages, getSessionTitleFromMessages(normalizedSourceMessages))
        : undefined;
      return {
        summary: finalSummary,
        sourceSessionId: targetSessionId,
        newSessionId,
        newMessages: compressedMessages,
      };
    } catch (error: any) {
      updateSessionMessages(
        [
          ...normalizedSourceMessages,
          {
            id: statusMessageId,
            role: "system",
            content: "历史记录压缩失败",
            kind: "compressionStatus",
            compressionStatus: "failed",
            error: error?.message || String(error),
          },
        ],
        targetSessionId,
      );
      if (alertOnFailure) {
        void showAssistantAlert(`压缩对话失败：${error?.message || String(error)}`);
      }
      throw error;
    } finally {
      setIsCompressingContext(false);
    }
  };

  const runChatGeneration = async ({
    initialMessages,
    sessionId,
    retrying = false,
    mode = conversationMode,
  }: {
    initialMessages: ChatMessage[];
    sessionId: string;
    retrying?: boolean;
    mode?: "chat" | "code";
  }) => {
    if (isGenerating) {
      return;
    }
    activeConversationModeRef.current = mode;

    if (!currentAgent) {
      updateSessionMessages([
        ...initialMessages,
        {
          id: createMessageId(),
          role: "assistant",
          content: "Error: 当前没有可用的 AI Agent，请先在设置中添加或恢复一个 Agent。",
          status: "error",
          error: "当前没有可用的 AI Agent，请先在设置中添加或恢复一个 Agent。",
        },
      ], sessionId);
      return;
    }

    if (!isProviderImplemented(currentAgent.provider)) {
      updateSessionMessages([
        ...initialMessages,
        {
          id: createMessageId(),
          role: "assistant",
          content: `Error: 当前 Provider '${currentAgent.provider}' 暂未接入。请改用 OpenAI、智谱、DeepSeek 或 Custom(OpenAI-compatible)。`,
          status: "error",
          error: `当前 Provider '${currentAgent.provider}' 暂未接入。`,
        },
      ], sessionId);
      return;
    }

    setIsGenerating(true);
    abortControllerRef.current?.abort();
    abortControllerRef.current = new AbortController();
    const generationAbortController = abortControllerRef.current;

    let currentMessages = prepareMessagesForRetry(initialMessages);
    activeGenerationRef.current = { sessionId, messages: currentMessages };
    let flushMessagesTimer: number | null = null;

    const setCurrentMessages = (nextMessages: ChatMessage[], options?: { immediate?: boolean }) => {
      currentMessages = nextMessages;
      activeGenerationRef.current = { sessionId, messages: currentMessages };
      if (!options?.immediate) {
        if (flushMessagesTimer === null) {
          flushMessagesTimer = window.setTimeout(() => {
            flushMessagesTimer = null;
            updateSessionMessages(currentMessages, sessionId);
          }, STREAM_MESSAGE_FLUSH_MS);
        }
        return;
      }
      if (flushMessagesTimer !== null) {
        window.clearTimeout(flushMessagesTimer);
        flushMessagesTimer = null;
      }
      updateSessionMessages(currentMessages, sessionId);
    };

    const abortForAutoCompressionIfNeeded = () => {
      if (
        !autoCompressionRef.current &&
        estimateContextUsage(currentMessages, currentAgent).percent >= AUTO_CONTEXT_COMPRESSION_THRESHOLD_PERCENT
      ) {
        autoCompressionRef.current = true;
        generationAbortController.abort(createAutoContextCompressionError());
      }
    };

    const flushCurrentMessages = () => setCurrentMessages(currentMessages, { immediate: true });

    const appendQueuedUserMessages = () => {
      const queuedMessages = queuedUserMessagesRef.current;
      if (!queuedMessages.length) return false;

      setQueuedMessages([]);
      currentMessages = markLatestTodoAsTransferred(currentMessages);
      const userMessages = queuedMessages.map<ChatMessage>((queuedMessage) => ({
        id: queuedMessage.id,
        role: "user",
        content: queuedMessage.content,
        attachments: queuedMessage.attachments,
      }));
      currentMessages = [...currentMessages, ...userMessages];
      setCurrentMessages(currentMessages, { immediate: true });
      queuedMessages.forEach((queuedMessage) => {
        buildSessionSnapshot(vm, queuedMessage.id, queuedMessage.content, queuedMessage.attachments, queuedMessage.createdAt).then(
          (snapshot) => appendSessionSnapshot(snapshot, sessionId),
        );
      });
      return true;
    };

    try {
      const providerAdapter = getProviderAdapter(currentAgent.provider);
      let shouldContinue = true;
      while (shouldContinue) {
        autoCompressionRef.current = false;
        if (estimateContextUsage(currentMessages, currentAgent).percent >= AUTO_CONTEXT_COMPRESSION_THRESHOLD_PERCENT) {
          throw createAutoContextCompressionError();
        }
        const requestMessages = currentMessages;
        const assistantMessageIndex = currentMessages.length;
        currentMessages = [
          ...currentMessages,
          {
            id: createMessageId(),
            role: "assistant",
            content: "",
            reasoning: "",
            reasoningStartedAt: enableReasoning ? Date.now() : undefined,
          },
        ];
        setCurrentMessages(currentMessages, { immediate: true });

        const memorySystemText = buildMemorySystemText(vm);
        const guideSystemText = getEnabledGuideSystemText(userGuides, getRuntimeExtensionGuides(vm?.runtime));
        const currentModelSupportsVision = isVisionModel(currentAgent);
        const enabledSubAgents = subAgents.filter(
          (agent) => agent.enabled !== false && (!agent.builtinToolGroups.includes("game") || currentModelSupportsVision),
        );
        const unavailableSubAgents = subAgents
          .filter((agent) => agent.enabled !== false && agent.builtinToolGroups.includes("game") && !currentModelSupportsVision)
          .map((agent) => agent.name);
        const projectIndexBlocked = Boolean(refreshProjectIndexStatus()?.blocked);
        const subAgentSystemText = allowSubAgents ? buildSubAgentSystemText(enabledSubAgents, unavailableSubAgents) : "";
        const projectIndexSystemText = projectIndexBlocked
          ? `${PROJECT_INDEX_BLOCKED_TOOL_MESSAGE} Until the user builds the project index, do not attempt to inspect virtual files, edit scripts/assets, or create/update/delete costumes. You may answer conceptually or ask the user to build the index first.`
          : "";
        const chatModeSystemText =
          mode === "chat"
            ? `${CHAT_MODE_BLOCKED_TOOL_MESSAGE} You may inspect, search, read, and diagnose project context in this turn, but do not patch, discard drafts, modify assets, add extensions, or otherwise change the project. If the user wants project file edits, ask them to switch to Code mode.`
            : "";
        const mainToolSchemas = filterToolSchemasForChatMode(
          filterToolSchemasForProjectIndex(
            allowSubAgents ? MAIN_TOOL_SCHEMAS_WITH_SUBAGENTS : MAIN_TOOL_SCHEMAS_WITHOUT_SUBAGENTS,
            projectIndexBlocked,
          ),
          mode,
        );
        const sendMainCompletion = (streamResponse: boolean) => providerAdapter.sendChatCompletion({
          agent: currentAgent,
          messages: [
            {
              id: createMessageId(),
              role: "system",
              content: [
                SYSTEM_PROMPT,
                projectIndexSystemText,
                chatModeSystemText,
                subAgentSystemText,
                memorySystemText,
                guideSystemText,
              ]
                .filter(Boolean)
                .join("\n\n"),
            },
            ...buildRequestMessages(requestMessages, enableReasoning),
          ],
          tools: mainToolSchemas,
          toolChoice: "auto",
          enableReasoning,
          reasoningEffort,
          stream: streamResponse,
          signal: generationAbortController.signal,
          onReasoningDelta: (delta) => {
            currentMessages = currentMessages.map((message, index) =>
              index === assistantMessageIndex
                ? {
                    ...message,
                    reasoning: `${message.reasoning || ""}${delta}`,
                    reasoningStartedAt: message.reasoningStartedAt || Date.now(),
                  }
                : message,
            );
            setCurrentMessages(currentMessages);
            abortForAutoCompressionIfNeeded();
          },
          onTextDelta: (delta) => {
            currentMessages = currentMessages.map((message, index) =>
              index === assistantMessageIndex
                ? {
                    ...message,
                    content: `${message.content}${delta}`,
                  }
                : message,
            );
            setCurrentMessages(currentMessages);
            abortForAutoCompressionIfNeeded();
          },
          onToolCallsDelta: (toolCalls) => {
            currentMessages = currentMessages.map((message, index) =>
              index === assistantMessageIndex
                ? {
                    ...message,
                    tool_calls: toolCalls,
                  }
                : message,
            );
            setCurrentMessages(currentMessages);
            abortForAutoCompressionIfNeeded();
          },
        });
        let data;
        let streamResponse = true;
        for (let attempt = 0; attempt <= NETWORK_RETRY_DELAYS_MS.length; attempt += 1) {
          const messagesBeforeAttempt = cloneChatMessages(currentMessages);
          try {
            data = await sendMainCompletion(streamResponse);
            break;
          } catch (error) {
            if (
              generationAbortController.signal.aborted ||
              !isChatRequestRetryableError(error) ||
              attempt >= NETWORK_RETRY_DELAYS_MS.length
            ) {
              throw error;
            }
            const delayMs = NETWORK_RETRY_DELAYS_MS[attempt];
            const interruptedReason = error instanceof Error ? error.message : String(error || "AI request failed");
            currentMessages = materializeIncompleteToolCallsAsInterrupted(currentMessages, interruptedReason).map((message, index) =>
              index === assistantMessageIndex
                ? {
                    ...message,
                    content: getNetworkRetryNotice(delayMs, attempt, error),
                    reasoning: message.reasoning || "",
                    status: "error" as const,
                    error: interruptedReason,
                  }
                : message,
            );
            setCurrentMessages(currentMessages, { immediate: true });
            await waitForRetryDelay(delayMs, generationAbortController.signal);
            currentMessages = messagesBeforeAttempt;
            setCurrentMessages(currentMessages, { immediate: true });
            if (isUpstreamInterruptionError(error)) {
              streamResponse = false;
            }
          }
        }
        if (!data) {
          throw new Error("AI request did not return a result.");
        }
        const providerContextUsage = contextUsageFromProviderUsage(data.usage, currentAgent);
        if (providerContextUsage) {
          setContextUsage(providerContextUsage);
          if (providerContextUsage.percent >= AUTO_CONTEXT_COMPRESSION_THRESHOLD_PERCENT) {
            throw createAutoContextCompressionError();
          }
        } else {
          setContextUsage(estimateContextUsage(currentMessages, currentAgent));
        }
        const responseMessage = data.choices[0].message as ChatMessage;

        currentMessages = currentMessages.map((message, index) =>
          index === assistantMessageIndex
            ? {
                ...message,
                ...responseMessage,
                content: responseMessage.content || message.content,
                reasoning: responseMessage.reasoning || message.reasoning,
                reasoningStartedAt: message.reasoningStartedAt,
                reasoningEndedAt:
                  message.reasoningStartedAt && (responseMessage.reasoning || message.reasoning)
                    ? Date.now()
                    : message.reasoningEndedAt,
              }
            : message,
        );
        setCurrentMessages(currentMessages, { immediate: true });

        if (responseMessage.tool_calls && responseMessage.tool_calls.length > 0) {
          currentMessages = [
            ...currentMessages,
            ...responseMessage.tool_calls.map((toolCall) => ({
              id: createMessageId(),
              role: "tool" as const,
              tool_call_id: toolCall.id,
              name: toolCall.function.name,
              content: "",
            })),
          ];
          setCurrentMessages(currentMessages, { immediate: true });

          const executeToolCall = async (toolCall: ToolCall) => {
            const functionName = toolCall.function.name;
            let toolResult = "";
            let modelToolResult = "";

            const updateToolMessageContent = (content: string, modelContent?: string) => {
              if (generationAbortController.signal.aborted && content !== TERMINATED_TOOL_RESULT) {
                return;
              }
              currentMessages = currentMessages.map((message) =>
                message.role === "tool" && message.tool_call_id === toolCall.id
                  ? {
                      ...message,
                      name: functionName,
                      content,
                      modelContent,
                    }
                  : message,
              );
              setCurrentMessages(currentMessages);
            };

            try {
              let args: Record<string, any> = {};
              try {
                const parsedArgs = toolCall.function.arguments ? JSON.parse(toolCall.function.arguments) : {};
                if (!parsedArgs || typeof parsedArgs !== "object" || Array.isArray(parsedArgs)) {
                  throw new Error("Tool arguments must be a JSON object");
                }
                args = parsedArgs;
              } catch (parseError: any) {
                throw new Error(`Invalid tool arguments: ${parseError.message}`);
              }

              validateToolArguments(functionName, args);
              const result =
                functionName === "runSubAgent"
                  ? await runSubAgent(args, (payload) => {
                      updateToolMessageContent(JSON.stringify(payload));
                    })
                  : await callTool(functionName, args, toolCall.id);
            if (generationAbortController.signal.aborted) {
              return;
            }
            toolResult = typeof result === "object" ? JSON.stringify(result) : String(result);
            modelToolResult = compactToolResultForModel(functionName, result);
            if (functionName === "runSubAgent") {
              const finalResultForModel = toolResult;
              currentMessages = stripCompletedSubAgentToolArguments(currentMessages, toolCall.id);
              const latestProgressMessage = currentMessages.find(
                (message) => message.role === "tool" && message.tool_call_id === toolCall.id,
              );
              const latestProgress = safeParseJson(latestProgressMessage?.content || "") as any;
              const displayResult = latestProgress?.messages
                ? JSON.stringify({
                    ...latestProgress,
                    completed: true,
                    summary: finalResultForModel || latestProgress.summary,
                  })
                : finalResultForModel;
              currentMessages = currentMessages.map((message) =>
                message.role === "tool" && message.tool_call_id === toolCall.id
                  ? {
                      ...message,
                      name: functionName,
                      content: finalResultForModel,
                      modelContent: finalResultForModel,
                      displayContent: displayResult,
                    }
                  : message,
              );
              setCurrentMessages(currentMessages);
              return;
            }
          } catch (err: any) {
              if (err?.name === "AbortError") {
                throw err;
              }
              if (functionName === "runSubAgent") {
                const latestProgressMessage = currentMessages.find(
                  (message) => message.role === "tool" && message.tool_call_id === toolCall.id,
                );
                const latestProgress = safeParseJson(latestProgressMessage?.content || "") as any;
                if (latestProgress?.messages) {
                  const errorSummary = `Error: ${err?.message || String(err)}`;
                  toolResult = JSON.stringify({
                    ...latestProgress,
                    success: false,
                    completed: false,
                    error: err?.message || String(err),
                    summary: errorSummary,
                  });
                  currentMessages = currentMessages.map((message) =>
                    message.role === "tool" && message.tool_call_id === toolCall.id
                      ? {
                          ...message,
                          name: functionName,
                          content: errorSummary,
                          modelContent: errorSummary,
                          displayContent: toolResult,
                        }
                      : message,
                  );
                  setCurrentMessages(currentMessages);
                  return;
                } else {
                  toolResult = `Error: ${err.message}`;
                  modelToolResult = toolResult;
                }
              } else {
              toolResult = `Error: ${err.message}`;
              modelToolResult = toolResult;
              }
            }

            if (generationAbortController.signal.aborted) {
              return;
            }
            updateToolMessageContent(toolResult, modelToolResult || undefined);
          };

          let toolCallIndex = 0;
          while (toolCallIndex < responseMessage.tool_calls.length) {
            const currentToolCall = responseMessage.tool_calls[toolCallIndex];
            if (currentToolCall.function.name === "runSubAgent") {
              const subAgentBatch: ToolCall[] = [];
              let batchIndex = toolCallIndex;
              while (
                batchIndex < responseMessage.tool_calls.length &&
                responseMessage.tool_calls[batchIndex].function.name === "runSubAgent"
              ) {
                subAgentBatch.push(responseMessage.tool_calls[batchIndex]);
                batchIndex += 1;
              }
              await Promise.all(subAgentBatch.map((toolCall) => executeToolCall(toolCall)));
              toolCallIndex = batchIndex;
              continue;
            }

            await executeToolCall(currentToolCall);
            toolCallIndex += 1;
          }
          if (appendQueuedUserMessages()) {
            continue;
          }
        } else {
          if (appendQueuedUserMessages()) {
            continue;
          }
          shouldContinue = false;
        }
      }
    } catch (err: any) {
      const abortReason = generationAbortController.signal.reason;
      if (isAutoContextCompressionError(err) || isAutoContextCompressionError(abortReason)) {
        if (flushMessagesTimer !== null) {
          window.clearTimeout(flushMessagesTimer);
          flushMessagesTimer = null;
        }
        const trimmedMessages = currentMessages.filter(
          (message, index) =>
            !(
              index === currentMessages.length - 1 &&
              message.role === "assistant" &&
              !message.content &&
              !message.reasoning &&
              !message.tool_calls?.length
            ),
        );
        const resumableMessages = stripUnansweredAssistantToolCalls(stripIncompleteTailToolCalls(trimmedMessages));
        updateSessionMessages(resumableMessages, sessionId);
        try {
          const compressed = await compressContextMessages({
            sourceMessages: resumableMessages,
            sourceSessionId: sessionId,
            alertOnFailure: false,
          });
          if (compressed.newSessionId) {
            const continuationPrompt: ChatMessage = {
              id: createMessageId(),
              role: "user",
              content: AUTO_CONTEXT_CONTINUATION_PROMPT,
              hidden: true,
            };
            const continuationMessages = [...compressed.newMessages, continuationPrompt];
            updateSessionMessages(continuationMessages, compressed.newSessionId);
            window.setTimeout(() => {
              runChatGeneration({ initialMessages: continuationMessages, sessionId: compressed.newSessionId as string, retrying: true });
            }, 0);
          }
        } catch (compressionError: any) {
          const errorMessage = compressionError?.message || String(compressionError);
          updateSessionMessages(
            [
              ...resumableMessages,
              {
                id: createMessageId(),
                role: "assistant",
                content: `Error: 自动压缩上下文失败：${errorMessage}`,
                status: "error",
                error: errorMessage,
              },
            ],
            sessionId,
          );
        }
        return;
      }
      if (err?.name === "AbortError") {
        if (flushMessagesTimer !== null) {
          window.clearTimeout(flushMessagesTimer);
          flushMessagesTimer = null;
        }
        const trimmedMessages = currentMessages.filter(
          (message, index) =>
            !(
              index === currentMessages.length - 1 &&
              message.role === "assistant" &&
              !message.content &&
              !message.reasoning &&
              !message.tool_calls?.length
            ),
        );
        updateSessionMessages(terminatePendingExecution(trimmedMessages), sessionId);
        return;
      }
      if (flushMessagesTimer !== null) {
        window.clearTimeout(flushMessagesTimer);
        flushMessagesTimer = null;
      }
      const errorMessage = err?.message || String(err);
      const errorMessages = (() => {
        const nextMessages = materializeIncompleteToolCallsAsInterrupted([...currentMessages], errorMessage);
        for (let index = nextMessages.length - 1; index >= 0; index -= 1) {
          const message = nextMessages[index];
          if (message.role === "assistant") {
            const existingContent = message.content || message.reasoning || message.tool_calls?.length ? message.content : "";
            nextMessages[index] = {
              ...message,
              content: existingContent || `Error: ${errorMessage}`,
              status: "error",
              error: errorMessage,
            };
            return nextMessages;
          }
        }
        return [
          ...nextMessages,
          {
            id: createMessageId(),
            role: "assistant" as const,
            content: `Error: ${errorMessage}`,
            status: "error" as const,
            error: errorMessage,
          },
        ];
      })();
      updateSessionMessages(errorMessages, sessionId);
    } finally {
      if (flushMessagesTimer !== null) {
        window.clearTimeout(flushMessagesTimer);
        flushMessagesTimer = null;
        updateSessionMessages(currentMessages, sessionId);
      }
      abortControllerRef.current = null;
      activeGenerationRef.current = null;
      userQuestionAnswerRef.current = null;
      setPendingUserQuestion(null);
      setIsGenerating(false);
    }
  };

  const handleSend = async () => {
    if (isGenerating) {
      enqueueCurrentInput();
      return;
    }
    if (!inputText.trim() && attachments.length === 0) return;

    const allGuides = getAllGuides(userGuides, getRuntimeExtensionGuides(vm?.runtime));
    const newMessage: ChatMessage = {
      id: createMessageId(),
      role: "user",
      content: inputText,
      modelContent: buildModelContentWithReferences(inputText, attachments, allGuides),
      attachments,
    };
    const newMessages = [...messages, newMessage];
    const sessionId = updateSessionMessages(newMessages);
    appendSessionSnapshot(await buildSessionSnapshot(vm, newMessage.id, inputText, attachments), sessionId);
    setInputText("");
    setAttachments([]);

    if (estimateContextUsage(newMessages, currentAgent).percent >= AUTO_CONTEXT_COMPRESSION_THRESHOLD_PERCENT) {
      try {
        const compressed = await compressContextMessages({
          sourceMessages: newMessages,
          sourceSessionId: sessionId,
          alertOnFailure: false,
        });
        if (compressed.newSessionId) {
          const continuationPrompt: ChatMessage = {
            id: createMessageId(),
            role: "user",
            content: AUTO_CONTEXT_CONTINUATION_PROMPT,
            hidden: true,
          };
          const continuationMessages = [...compressed.newMessages, continuationPrompt];
          updateSessionMessages(continuationMessages, compressed.newSessionId);
          await runChatGeneration({
            initialMessages: continuationMessages,
            sessionId: compressed.newSessionId,
            retrying: true,
            mode: conversationMode,
          });
        }
      } catch (error: any) {
        updateSessionMessages(
          [
            ...newMessages,
            {
              id: createMessageId(),
              role: "assistant",
              content: `Error: 自动压缩上下文失败：${error?.message || String(error)}`,
              status: "error",
              error: error?.message || String(error),
            },
          ],
          sessionId,
        );
      }
      return;
    }

    await runChatGeneration({ initialMessages: newMessages, sessionId, mode: conversationMode });
  };

  const handleRetryLastResponse = async () => {
    if (isGenerating) return;
    const retryableIndex = findLastRetryableAssistantIndex(messages);
    if (retryableIndex < 0) return;
    const retryPrompt: ChatMessage = {
      id: createMessageId(),
      role: "user",
      content: RETRY_CONTINUATION_PROMPT,
      hidden: true,
    };
    const retryMessages = [...prepareMessagesForRetry(messages), retryPrompt];
    const sessionId = updateSessionMessages(retryMessages);
    await runChatGeneration({ initialMessages: retryMessages, sessionId, retrying: true, mode: conversationMode });
  };

  const handleCompressContext = async () => {
    if (isGenerating || isCompressingContext || !messages.length) return;
    try {
      await compressContextMessages({ sourceMessages: messages });
    } catch {
      // compressContextMessages already updates the divider and displays the failure.
    }
  };

  const handleStopGenerating = () => {
    const activeGeneration = activeGenerationRef.current;
    if (activeGeneration) {
      const terminatedMessages = terminatePendingExecution(activeGeneration.messages);
      activeGenerationRef.current = { ...activeGeneration, messages: terminatedMessages };
      updateSessionMessages(terminatedMessages, activeGeneration.sessionId);
    }
    abortControllerRef.current?.abort();
  };

  return {
    inputText,
    setInputText,
    isGenerating,
    queuedUserMessages,
    pendingUserQuestion,
    answerUserQuestion,
    goBackUserQuestion,
    attachments,
    setAttachments,
    handleSend,
    handleRetryLastResponse,
    handleCompressContext,
    handleStopGenerating,
    contextUsage,
    isCompressingContext,
    projectIndexStatus,
    projectIndexBuild,
    projectExamplePrompts,
    handleBuildProjectIndex,
    handleStopProjectIndex,
  };
}
