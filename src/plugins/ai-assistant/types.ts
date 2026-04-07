export interface Agent {
  id: string;
  provider: "openai" | "zhipu" | "deepseek" | "custom" | "anthropic" | "google" | "azure";
  baseUrl: string;
  apiKey: string;
  modelName: string;
  displayName: string;
}

export type AttachmentKind = "workspace-ucf" | "workspace-ucf-range" | "text-file" | "spreadsheet" | "document";

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

export interface ChatMessage {
  role: "user" | "assistant" | "tool" | "system";
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
  attachments?: Attachment[];
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
}
