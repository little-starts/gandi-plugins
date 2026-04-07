import { Agent, ChatMessage } from "./types";

interface ChatCompletionRequest {
  agent: Agent;
  messages: ChatMessage[];
  tools?: unknown[];
  toolChoice?: string;
  signal?: AbortSignal;
  onTextDelta?: (delta: string) => void;
}

export interface ProviderAdapter {
  sendChatCompletion: (request: ChatCompletionRequest) => Promise<any>;
}

const OPENAI_COMPATIBLE_PROVIDERS = new Set<Agent["provider"]>(["openai", "zhipu", "deepseek", "custom"]);

class OpenAICompatibleAdapter implements ProviderAdapter {
  async sendChatCompletion({ agent, messages, tools, toolChoice, signal, onTextDelta }: ChatCompletionRequest) {
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

        if (typeof delta.content === "string" && delta.content) {
          content += delta.content;
          onTextDelta?.(delta.content);
        }

        if (Array.isArray(delta.tool_calls)) {
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
              continue;
            }

            if (toolCallDelta.id) {
              toolCalls[index].id = toolCallDelta.id;
            }
            if (toolCallDelta.function?.name) {
              toolCalls[index].function.name += toolCallDelta.function.name;
            }
            if (toolCallDelta.function?.arguments) {
              toolCalls[index].function.arguments += toolCallDelta.function.arguments;
            }
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
            tool_calls: toolCalls.filter((toolCall) => toolCall.id || toolCall.function.name),
          },
        },
      ],
    };
  }
}

class AnthropicAdapter implements ProviderAdapter {
  async sendChatCompletion({ agent, messages, tools, signal, onTextDelta }: ChatCompletionRequest) {
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

        if (parsed.type === "content_block_start" && parsed.content_block?.type === "tool_use") {
          toolCalls.push({
            id: parsed.content_block.id || "",
            type: "function",
            function: {
              name: parsed.content_block.name || "",
              arguments: "",
            },
          });
        }

        if (parsed.type === "content_block_delta" && parsed.delta?.type === "input_json_delta") {
          const lastToolCall = toolCalls[toolCalls.length - 1];
          if (lastToolCall) {
            lastToolCall.function.arguments += parsed.delta.partial_json || "";
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
