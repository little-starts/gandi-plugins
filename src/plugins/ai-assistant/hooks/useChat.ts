import { useEffect, useRef, useState } from "react";
import { FlattenedAgent, Attachment, ChatMessage } from "../types";
import { AITools } from "../tools";
import { scratchToolSchemas } from "../toolSchemas";
import { getProviderAdapter, isProviderImplemented } from "../providerAdapters";

interface UseChatOptions {
  messages: ChatMessage[];
  currentAgent: FlattenedAgent | null;
  updateSessionMessages: (newMessages: ChatMessage[], targetSessionId?: string) => string;
  appendSessionSnapshot: (
    snapshot: {
      messageId: string;
      projectJson: string;
      attachments: Attachment[];
      inputText: string;
      createdAt: number;
    },
    targetSessionId?: string,
  ) => void;
  enableReasoning: boolean;
  vm: any;
}

const createMessageId = () => `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const toProviderMessage = (message: ChatMessage, content: string) => ({
  role: message.role,
  content,
  ...(message.anthropic_content_blocks?.length
    ? {
        anthropic_content_blocks: message.anthropic_content_blocks,
      }
    : {}),
  ...(message.tool_calls
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

const buildRequestMessages = (messages: ChatMessage[]) =>
  messages.map((message) => {
    if (message.role !== "user" || !message.attachments?.length) {
      return toProviderMessage(message, message.content);
    }

    const attachmentText = message.attachments
      .map(
        (attachment, index) =>
          `[Attachment ${index + 1}] ${attachment.name} (${attachment.kind})${
            attachment.kind === "workspace-ucf-range" && attachment.meta?.startBlockId && attachment.meta?.endBlockId
              ? ` [editable-range startBlockId=${attachment.meta.startBlockId}, endBlockId=${attachment.meta.endBlockId}]`
              : ""
          }:\n${attachment.content}`,
      )
      .join("\n\n");

    const content = message.content
      ? `${message.content}\n\n=== Attachments ===\n${attachmentText}`
      : `=== Attachments ===\n${attachmentText}`;

    return toProviderMessage(message, content);
  });

const SYSTEM_PROMPT = `You are an AI assistant inside Gandi IDE (Scratch environment).

Language:
- Use the same language as the user's latest message. If unclear, use zh-CN.

Tools:
- Inspect: listTargets, getTopLevelScripts, getScriptUCF, getWorkspaceUCF, findBlocks, getBlocksRangeUCF
- Discover blocks: searchBlocks, getBlockInfo, getAllPrimitiveBlocks, getAllExtensions, getExtensionBlocks, getCustomBlocks
- Write: generateCodeFromUCF, replaceBlocksRangeByUCF, replaceScriptByUCF, cleanUpBlocks

Workflow:
1) Before writing blocks for ANY opcode you are not 100% sure about, call getBlockInfo(opcode).
2) For native Scratch blocks (built-in opcodes): ALWAYS follow getBlockInfo(opcode) exactly for:
   - which keys are fields vs inputs
   - exact field/input names (including substack names like SUBSTACK/SUBSTACK2 when present)
   Never invent names like BODY/THEN/ELSE for native blocks unless getBlockInfo explicitly uses them.
3) For extensions: also prefer getBlockInfo(opcode). Only if block info is unavailable, use best-effort and keep names stable.
4) Before defining/calling custom blocks: call getCustomBlocks and reuse existing proccode/args exactly.

Annotated JS:
- Read tools may append line-end comments: // blockId: <id>. Use them for replaceBlocksRangeByUCF boundaries.

STRICT JS DSL for generateCodeFromUCF / replace*ByUCF:
1) Program MUST be expression statements only. Each statement MUST be exactly one block call (CallExpression).
2) Block call: <callee>(<argsObject?>). If args exist, args MUST be an object literal.
3) callee may be Identifier or MemberExpression. Every MemberExpression segment MUST be a valid JS identifier.
4) Encode special chars inside identifier segments:
   - "." => "$dot$"
   - "-" => "$dash$"
5) Fields MUST use "$field_" keys (e.g. { $field_VARIABLE: "score" }).
6) Inputs use plain keys (e.g. { MESSAGE: "hi", VALUE: 1 }).
7) Any input whose value is an arrow function represents a substack/callback block sequence:
   INPUT_NAME: () => { block.call(...); }
   IMPORTANT: For native Scratch blocks, INPUT_NAME MUST match getBlockInfo exactly (often SUBSTACK/SUBSTACK2).
8) Reserved meta keys: $mutation (object), $args (array), $xy (object with x/y).
9) Connection rule: statements connect by order within the same scope; multiple top-level statements mean parallel scripts.
10) When writing JS DSL, output ONLY code (keep optional // blockId comments if present). No explanations.

Canonical patterns (always use these forms):
- Hat/event with body:
  event.whenflagclicked(() => { ... });
  event.whenkeypressed({ $field_KEY_OPTION: "space" }, () => { ... });

- Custom block:
  define({ proccode: "...", info: [...] }, () => { ... });
  procedures.call({ $mutation: { proccode: "...", warp: "true" }, $args: [...] });

Minimum example:
event.whenflagclicked(() => {
  control.repeat({ TIMES: 3, SUBSTACK: () => { looks.say({ MESSAGE: "ok" }); } });
  event.broadcast({ BROADCAST_INPUT: "msg1" });
});`;

export function useChat({
  messages,
  currentAgent,
  updateSessionMessages,
  appendSessionSnapshot,
  enableReasoning,
  vm,
}: UseChatOptions) {
  const [inputText, setInputText] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const aiToolsRef = useRef<AITools | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  const callTool = async (functionName: string, args: Record<string, any>) => {
    const aiTools = aiToolsRef.current as Record<string, any> | null;
    if (!aiTools || typeof aiTools[functionName] !== "function") {
      throw new Error(`Tool ${functionName} not found`);
    }

    switch (functionName) {
      case "findBlocks":
        return aiTools[functionName](args);
      case "generateCodeFromUCF":
        return aiTools[functionName](args.ucfString, args.targetId, args.x, args.y);
      case "getExtensionBlocks":
        return aiTools[functionName](args.extensionId);
      case "searchBlocks":
        return aiTools[functionName](args.keyword);
      case "getBlockInfo":
        return aiTools[functionName](args.opcode);
      case "cleanUpBlocks":
      case "getTopLevelScripts":
      case "getWorkspaceUCF":
        return aiTools[functionName](args.targetId);
      case "getScriptUCF":
        return aiTools[functionName](args.scriptId, args.targetId);
      case "getCustomBlocks":
        return aiTools[functionName](args.targetId);
      case "getBlocksRangeUCF":
        return aiTools[functionName](args.startBlockId, args.endBlockId);
      case "replaceBlocksRangeByUCF":
        return aiTools[functionName](args.startBlockId, args.endBlockId, args.ucfString);
      case "replaceScriptByUCF":
        return aiTools[functionName](args.scriptId, args.ucfString);
      default:
        return aiTools[functionName]();
    }
  };

  useEffect(() => {
    if (!aiToolsRef.current && vm) {
      aiToolsRef.current = new AITools(vm);
    }

    return () => {
      abortControllerRef.current?.abort();
    };
  }, [vm]);

  const handleSend = async () => {
    if (isGenerating) return;
    if (!inputText.trim() && attachments.length === 0) return;

    if (!currentAgent) {
      updateSessionMessages([
        ...messages,
        {
          id: createMessageId(),
          role: "assistant",
          content: "Error: 当前没有可用的 AI Agent，请先在设置中添加或恢复一个 Agent。",
        },
      ]);
      return;
    }

    if (!isProviderImplemented(currentAgent.provider)) {
      updateSessionMessages([
        ...messages,
        {
          id: createMessageId(),
          role: "assistant",
          content: `Error: 当前 Provider '${currentAgent.provider}' 暂未接入。请改用 OpenAI、智谱、DeepSeek 或 Custom(OpenAI-compatible)。`,
        },
      ]);
      return;
    }

    const newMessage: ChatMessage = {
      id: createMessageId(),
      role: "user",
      content: inputText,
      attachments,
    };
    const newMessages = [...messages, newMessage];
    let sessionId = "";

    sessionId = updateSessionMessages(newMessages);
    appendSessionSnapshot(
      {
        messageId: newMessage.id,
        projectJson: typeof vm?.toJSON === "function" ? vm.toJSON() : "",
        attachments,
        inputText,
        createdAt: Date.now(),
      },
      sessionId,
    );
    setInputText("");
    setAttachments([]);
    setIsGenerating(true);
    abortControllerRef.current?.abort();
    abortControllerRef.current = new AbortController();

    let currentMessages = newMessages;

    try {
      const providerAdapter = getProviderAdapter(currentAgent.provider);
      let shouldContinue = true;
      while (shouldContinue) {
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
        updateSessionMessages(currentMessages, sessionId);

        const data = await providerAdapter.sendChatCompletion({
          agent: currentAgent,
          messages: [
            { id: createMessageId(), role: "system", content: SYSTEM_PROMPT },
            ...buildRequestMessages(requestMessages),
          ],
          tools: scratchToolSchemas,
          toolChoice: "auto",
          enableReasoning,
          signal: abortControllerRef.current.signal,
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
            updateSessionMessages(currentMessages, sessionId);
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
            updateSessionMessages(currentMessages, sessionId);
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
            updateSessionMessages(currentMessages, sessionId);
          },
        });
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
        updateSessionMessages(currentMessages, sessionId);

        if (responseMessage.tool_calls && responseMessage.tool_calls.length > 0) {
          for (const toolCall of responseMessage.tool_calls) {
            const functionName = toolCall.function.name;
            let toolResult = "";

            currentMessages = [
              ...currentMessages,
              {
                id: createMessageId(),
                role: "tool",
                tool_call_id: toolCall.id,
                name: functionName,
                content: "",
              },
            ];
            updateSessionMessages(currentMessages, sessionId);

            try {
              let args: Record<string, any> = {};
              try {
                args = toolCall.function.arguments ? JSON.parse(toolCall.function.arguments) : {};
              } catch (parseError: any) {
                throw new Error(`Invalid tool arguments: ${parseError.message}`);
              }

              const result = await callTool(functionName, args);
              toolResult = typeof result === "object" ? JSON.stringify(result) : String(result);
            } catch (err: any) {
              toolResult = `Error: ${err.message}`;
            }

            currentMessages = [
              ...currentMessages.slice(0, -1),
              {
                id: createMessageId(),
                role: "tool",
                tool_call_id: toolCall.id,
                name: functionName,
                content: toolResult,
              },
            ];
            updateSessionMessages(currentMessages, sessionId);
          }
        } else {
          shouldContinue = false;
        }
      }
    } catch (err: any) {
      if (err?.name === "AbortError") {
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
        updateSessionMessages(trimmedMessages, sessionId);
        return;
      }
      updateSessionMessages(
        [...currentMessages, { id: createMessageId(), role: "assistant", content: `Error: ${err.message}` }],
        sessionId,
      );
    } finally {
      abortControllerRef.current = null;
      setIsGenerating(false);
    }
  };

  const handleStopGenerating = () => {
    abortControllerRef.current?.abort();
  };

  return {
    inputText,
    setInputText,
    isGenerating,
    attachments,
    setAttachments,
    handleSend,
    handleStopGenerating,
  };
}
