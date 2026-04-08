import { Agent, ChatMessage, ToolCall } from "./types";

type ProviderMessage = Record<string, unknown>;

interface ChatCompletionRequest {
  agent: Agent;
  messages: ProviderMessage[];
  tools?: unknown[];
  toolChoice?: string;
  enableReasoning?: boolean;
  signal?: AbortSignal;
  onTextDelta?: (delta: string) => void;
  onReasoningDelta?: (delta: string) => void;
  onToolCallsDelta?: (toolCalls: ToolCall[]) => void;
}

export interface ProviderAdapter {
  sendChatCompletion: (request: ChatCompletionRequest) => Promise<any>;
}

const collectReasoningText = (value: unknown): string => {
  if (!value) return "";
  if (typeof value === "string") return value;

  if (Array.isArray(value)) {
    return value.map((item) => collectReasoningText(item)).join("");
  }

  if (typeof value === "object") {
    const candidate = value as Record<string, unknown>;
    return [
      candidate.reasoning_content,
      candidate.reasoning,
      candidate.reasoning_text,
      candidate.text,
      candidate.content,
      candidate.output_text,
    ]
      .map((item) => collectReasoningText(item))
      .join("");
  }

  return "";
};

const getOpenAIReasoningDelta = (delta: Record<string, unknown>) =>
  collectReasoningText(
    delta.reasoning_content ||
      delta.reasoning ||
      delta.reasoning_text ||
      delta.reasoning_details ||
      delta.reasoning_delta,
  );

const cloneToolCalls = (toolCalls: ToolCall[]) =>
  toolCalls.map((toolCall) => ({
    ...toolCall,
    function: {
      ...toolCall.function,
    },
  }));

const OPENAI_COMPATIBLE_PROVIDERS = new Set<Agent["provider"]>(["openai", "zhipu", "deepseek", "custom"]);

class OpenAICompatibleAdapter implements ProviderAdapter {
  async sendChatCompletion({
    agent,
    messages,
    tools,
    toolChoice,
    enableReasoning,
    signal,
    onTextDelta,
    onReasoningDelta,
    onToolCallsDelta,
  }: ChatCompletionRequest) {
    const response = await fetch(`${agent.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${agent.apiKey}`,
      },
      body: JSON.stringify({
        model: agent.modelName,
        messages,
        tools,
        tool_choice: toolChoice,
        stream: true,
        ...(enableReasoning
          ? {
              reasoning: { enabled: true },
              include_reasoning: true,
            }
          : {}),
      }),
      signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new Error(`API Error: ${response.status} ${response.statusText}${errorText ? ` - ${errorText}` : ""}`);
    }

    if (!response.body) {
      throw new Error("Empty response body");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
    let reasoning = "";
    const toolCalls: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> = [];

    let reading = true;
    while (reading) {
      const { done, value } = await reader.read();
      if (done) {
        reading = false;
        continue;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line.startsWith("data:")) continue;

        const payload = line.slice(5).trim();
        if (payload === "[DONE]") {
          continue;
        }

        let parsed;
        try {
          parsed = JSON.parse(payload);
        } catch {
          continue;
        }

        const delta = parsed.choices?.[0]?.delta;
        if (!delta) continue;

        const reasoningDelta = getOpenAIReasoningDelta(delta as Record<string, unknown>);
        if (reasoningDelta) {
          reasoning += reasoningDelta;
          onReasoningDelta?.(reasoningDelta);
        }

        if (typeof delta.content === "string" && delta.content) {
          content += delta.content;
          onTextDelta?.(delta.content);
        }

        if (Array.isArray(delta.tool_calls)) {
          let toolCallsChanged = false;
          for (const toolCallDelta of delta.tool_calls) {
            const index = toolCallDelta.index ?? toolCalls.length;
            if (!toolCalls[index]) {
              toolCalls[index] = {
                id: toolCallDelta.id || "",
                type: "function",
                function: {
                  name: toolCallDelta.function?.name || "",
                  arguments: toolCallDelta.function?.arguments || "",
                },
              };
              toolCallsChanged = true;
              continue;
            }

            if (toolCallDelta.id) {
              toolCalls[index].id = toolCallDelta.id;
              toolCallsChanged = true;
            }
            if (toolCallDelta.function?.name) {
              toolCalls[index].function.name += toolCallDelta.function.name;
              toolCallsChanged = true;
            }
            if (toolCallDelta.function?.arguments) {
              toolCalls[index].function.arguments += toolCallDelta.function.arguments;
              toolCallsChanged = true;
            }
          }

          if (toolCallsChanged) {
            onToolCallsDelta?.(cloneToolCalls(toolCalls.filter((toolCall) => toolCall.id || toolCall.function.name)));
          }
        }
      }
    }

    return {
      choices: [
        {
          message: {
            role: "assistant",
            content,
            reasoning,
            tool_calls: toolCalls.filter((toolCall) => toolCall.id || toolCall.function.name),
          },
        },
      ],
    };
  }
}

class AnthropicAdapter implements ProviderAdapter {
  async sendChatCompletion({
    agent,
    messages,
    tools,
    enableReasoning,
    signal,
    onTextDelta,
    onReasoningDelta,
    onToolCallsDelta,
  }: ChatCompletionRequest) {
    const systemMessages = messages.filter((message) => message.role === "system").map((message) => message.content);
    const conversationMessages = messages.filter((message) => message.role !== "system");

    const response = await fetch(`${agent.baseUrl}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": agent.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: agent.modelName,
        system: systemMessages.join("\n\n"),
        max_tokens: 4096,
        stream: true,
        messages: conversationMessages.map((message) => ({
          role: message.role === "assistant" ? "assistant" : "user",
          content: message.role === "tool" ? `Tool result (${message.name}): ${message.content}` : message.content,
        })),
        ...(enableReasoning
          ? {
              thinking: {
                type: "enabled",
                budget_tokens: 2048,
              },
            }
          : {}),
        tools: Array.isArray(tools)
          ? tools.map((tool: any) => ({
              name: tool.function.name,
              description: tool.function.description,
              input_schema: tool.function.parameters,
            }))
          : undefined,
      }),
      signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new Error(`API Error: ${response.status} ${response.statusText}${errorText ? ` - ${errorText}` : ""}`);
    }

    if (!response.body) {
      throw new Error("Empty response body");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
    let reasoning = "";
    const toolCalls: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> = [];
    let reading = true;

    while (reading) {
      const { done, value } = await reader.read();
      if (done) {
        reading = false;
        continue;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line.startsWith("data:")) continue;

        const payload = line.slice(5).trim();
        if (!payload) continue;

        let parsed;
        try {
          parsed = JSON.parse(payload);
        } catch {
          continue;
        }

        if (parsed.type === "content_block_delta" && parsed.delta?.type === "text_delta") {
          const deltaText = parsed.delta.text || "";
          content += deltaText;
          onTextDelta?.(deltaText);
        }

        if (parsed.type === "content_block_start" && parsed.content_block?.type === "thinking") {
          const thinkingText = parsed.content_block.thinking || parsed.content_block.text || "";
          if (thinkingText) {
            reasoning += thinkingText;
            onReasoningDelta?.(thinkingText);
          }
        }

        if (parsed.type === "content_block_delta" && parsed.delta?.type === "thinking_delta") {
          const thinkingText = parsed.delta.thinking || parsed.delta.text || "";
          if (thinkingText) {
            reasoning += thinkingText;
            onReasoningDelta?.(thinkingText);
          }
        }

        if (parsed.type === "content_block_start" && parsed.content_block?.type === "tool_use") {
          toolCalls.push({
            id: parsed.content_block.id || "",
            type: "function",
            function: {
              name: parsed.content_block.name || "",
              arguments: "",
            },
          });
          onToolCallsDelta?.(cloneToolCalls(toolCalls.filter((toolCall) => toolCall.id || toolCall.function.name)));
        }

        if (parsed.type === "content_block_delta" && parsed.delta?.type === "input_json_delta") {
          const lastToolCall = toolCalls[toolCalls.length - 1];
          if (lastToolCall) {
            lastToolCall.function.arguments += parsed.delta.partial_json || "";
            onToolCallsDelta?.(cloneToolCalls(toolCalls.filter((toolCall) => toolCall.id || toolCall.function.name)));
          }
        }
      }
    }

    return {
      choices: [
        {
          message: {
            role: "assistant",
            content,
            reasoning,
            tool_calls: toolCalls.filter((toolCall) => toolCall.id || toolCall.function.name),
          },
        },
      ],
    };
  }
}

export const isProviderImplemented = (provider: Agent["provider"]) =>
  OPENAI_COMPATIBLE_PROVIDERS.has(provider) || provider === "anthropic";

export const getProviderAdapter = (provider: Agent["provider"]): ProviderAdapter => {
  if (OPENAI_COMPATIBLE_PROVIDERS.has(provider)) {
    return new OpenAICompatibleAdapter();
  }

  if (provider === "anthropic") {
    return new AnthropicAdapter();
  }

  throw new Error(
    `Provider '${provider}' is not implemented yet. Please use OpenAI、智谱、DeepSeek、Custom(OpenAI-compatible) or Anthropic.`,
  );
};
