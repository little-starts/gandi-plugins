export interface AgentModel {
  id: string;
  name: string;
  modelId: string;
  maxTokens?: number;
}

export type GuideCategory = "read" | "edit" | string;

export type SubAgentIconKey = "search" | "code" | "robot" | "spark";
export type SubAgentToolGroup = "read" | "edit" | "game";
export type GameAgentLimitValue = number | "infinite";

export interface GameAgentLimits {
  maxActionsPerScript: GameAgentLimitValue;
  maxWaitMs: GameAgentLimitValue;
  maxScriptDurationMs: GameAgentLimitValue;
  maxToolTurns: GameAgentLimitValue;
  maxScreenshotBytes: GameAgentLimitValue;
}

export interface SubAgentProfile {
  id: string;
  name: string;
  description: string;
  prompt: string;
  avatarBackground: string;
  avatarIcon: SubAgentIconKey;
  builtinToolMode?: "read" | "all";
  builtinToolGroups: SubAgentToolGroup[];
  enabledGuideCategories: string[];
  enabledUserGuideIds: string[];
  enableExtensionGuides: boolean;
  enabled: boolean;
  gameLimits?: GameAgentLimits;
  isDefault?: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface Agent {
  id: string;
  provider: "openai" | "zhipu" | "deepseek" | "custom" | "custom_anthropic" | "anthropic" | "google" | "azure";
  baseUrl: string;
  apiKey: string;
  name: string;
  models: AgentModel[];
}

export interface FlattenedAgent {
  id: string;
  agentId: string;
  provider: Agent["provider"];
  baseUrl: string;
  apiKey: string;
  modelName: string;
  displayName: string;
  maxTokens?: number;
}

export type DefaultCostumeType = "ask" | "vector" | "bitmap";
export type StageScreenshotMode = "fast" | "full";
export type ReasoningEffort = "minimal" | "low" | "medium" | "high" | "max";
export type AiGuideVerificationMode =
  | "review_all"
  | "review_code"
  | "no_review"
  | "auto_review_all"
  | "auto_review_code";

export interface ImageGenerationModelConfig {
  provider: Agent["provider"];
  baseUrl: string;
  apiKey: string;
  modelName: string;
  displayName: string;
}

export type AttachmentKind = "workspace-ucf" | "workspace-ucf-range" | "text-file" | "spreadsheet" | "document" | "image";

export interface Attachment {
  id: string;
  name: string;
  kind: AttachmentKind;
  mimeType: string;
  content: string;
  preview?: string;
  meta?: {
    targetId?: string;
    blockId?: string;
    startBlockId?: string;
    endBlockId?: string;
    topBlockId?: string;
    selectedBlockIds?: string[];
    blockCount?: number;
    source?: string;
  };
}

export interface ToolCall {
  id: string;
  type?: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled";

export interface TodoItem {
  id: string;
  title: string;
  status: TodoStatus;
}

export interface UserQuestionOption {
  id: string;
  label: string;
  value: string;
  disabled?: boolean;
}

export interface PendingUserQuestionItem {
  id: string;
  question: string;
  details?: string;
  questionType: "choice" | "input";
  options: UserQuestionOption[];
  placeholder?: string;
  customOptionLabel: string;
  allowCustomInput?: boolean;
}

export interface UserQuestionAnswer {
  questionId: string;
  question: string;
  answer: string;
  selectedOption?: UserQuestionOption | null;
}

export interface PendingUserQuestion {
  id: string;
  toolCallId: string;
  questions: PendingUserQuestionItem[];
  currentIndex: number;
  answers: UserQuestionAnswer[];
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "tool" | "system";
  content: string;
  modelContent?: string;
  displayContent?: string;
  hidden?: boolean;
  excludeFromModel?: boolean;
  kind?: "compressionStatus" | "contextSummary";
  compressionStatus?: "compressing" | "completed" | "failed";
  status?: "error";
  error?: string;
  reasoning?: string;
  anthropic_content_blocks?: Array<
    | { type: "text"; text: string }
    | { type: "thinking"; thinking: string; signature?: string }
    | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  >;
  reasoningStartedAt?: number;
  reasoningEndedAt?: number;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
  attachments?: Attachment[];
  stageObservation?: {
    mimeType: string;
    dataUrl: string;
  };
  stageObservationForDisplay?: {
    mimeType: string;
    dataUrl: string;
  };
  stageObservations?: Array<{
    mimeType: string;
    dataUrl: string;
  }>;
  stageObservationsForDisplay?: Array<{
    mimeType: string;
    dataUrl: string;
  }>;
}

export interface SessionSnapshot {
  messageId: string;
  projectData?: ArrayBuffer;
  targetCount?: number;
  blockCount?: number;
  projectRollbackSkipped?: boolean;
  projectRollbackSkipReason?: string;
  attachments: Attachment[];
  inputText: string;
  createdAt: number;
}

export interface RangeAttachmentMeta {
  targetId: string;
  startBlockId: string;
  endBlockId: string;
  topBlockId?: string;
  selectedBlockIds?: string[];
  blockCount?: number;
}

export interface ChatSession {
  id: string;
  title: string;
  messages: ChatMessage[];
  updatedAt: number;
  projectId?: string;
  projectName?: string;
}

export interface ContextUsageInfo {
  usedTokens: number;
  limitTokens: number;
  percent: number;
  isEstimate: boolean;
  updatedAt: number;
}

export type MemoryScope = "longTerm" | "project";

export interface MemoryBlock {
  id: string;
  scope: MemoryScope;
  content: string;
  description?: string;
  projectId?: string;
  createdAt: number;
  updatedAt: number;
}

export interface UserGuide {
  id: string;
  name: string;
  title: string;
  content: string;
  description?: string;
  category?: GuideCategory;
  createdBy?: "user" | "ai";
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  indexJs?: string;
}
