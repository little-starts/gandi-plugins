import { useEffect, useRef, useState } from "react";
import { Agent, Attachment, ChatMessage } from "../types";
import { AITools } from "../tools";
import { scratchToolSchemas } from "../toolSchemas";
import { getProviderAdapter, isProviderImplemented } from "../providerAdapters";

interface UseChatOptions {
  messages: ChatMessage[];
  currentAgent: Agent | null;
  updateSessionMessages: (newMessages: ChatMessage[], targetSessionId?: string) => string;
  vm: any;
}

const toProviderMessage = (message: ChatMessage, content: string) => ({
  role: message.role,
  content,
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

const SYSTEM_PROMPT = `You are an AI assistant in Gandi IDE (Scratch environment).
Your current user speaks: ${navigator.language || "zh-CN"}. Use this language to search for blocks using searchBlocks if needed, and communicate with the user.

You have tools to read blocks and write blocks. Use tools whenever necessary to fulfill the user's request.

AVAILABLE TOOLS & HOW TO USE THEM:
- searchBlocks: Search for block opcodes by keywords.
- getBlockInfo: Get exact parameters and field names for a specific opcode.
- getAllPrimitiveBlocks: View all native Scratch opcodes and their text. Use this to quickly learn native blocks if needed.
- getAllExtensions: List all loaded extensions in the project.
- getExtensionBlocks: List all blocks for a specific extension.
- getWorkspaceUCF: Read the current workspace code to understand the context.
- getCustomBlocks: Read currently available custom block definitions before defining or calling one.
- getBlocksRangeUCF: Read a user-selected continuous block range using start/end block ids.
- cleanUpBlocks: Arrange the blocks neatly in the workspace.
- generateCodeFromUCF: Generate and insert Scratch blocks into the workspace.
- replaceBlocksRangeByUCF: Replace a selected continuous block range with new UCF while preserving surrounding connections.

RULES:
1. If the user does not explicitly request using an extension, directly use native Scratch blocks. Do not search for extensions first.
2. Before generating custom blocks, always inspect existing workspace code with getWorkspaceUCF and getCustomBlocks when the task may involve procedure definitions or calls.
3. If you need to create or call a custom block, prefer the existing procedures_* opcodes and make sure the proccode, argumentids, argumentnames, argumentdefaults, warp, isreporter, and isglobal fields stay consistent between definition and calls.
4. If the workspace already contains a matching custom block definition, reuse its proccode and argument IDs exactly instead of inventing a new one.
5. If you are unsure about an opcode, use searchBlocks, getBlockInfo, or getAllPrimitiveBlocks first.
6. When the user message includes an attachment marked as editable-range, use the provided startBlockId/endBlockId to inspect and replace that exact range instead of rewriting unrelated blocks.
7. If replaceBlocksRangeByUCF reports that boundary reconnection failed, do not assume the edit succeeded. Explain the limitation and avoid repeated blind retries.

STRICT UCF SYNTAX RULES FOR generateCodeFromUCF:
1. Each connected block sequence MUST be separated by a newline (\n). Never use N:next=.
2. Completely disconnected block sequences MUST be separated by double newlines (\n\n).
3. The format per line is: opcode | flags | fields | inputs | mutation
4. Inputs containing sub-blocks (like SUBSTACK) MUST be wrapped in brackets [].
5. Do not include comments or explanations inside the UCF string.
6. VARIABLE, LIST, and BROADCAST_INPUT are FIELDS (F:), not inputs.
7. If a block has multiple inputs or fields, use one prefix and comma-separated entries only, e.g. I:A=[...],B=[...].
8. The R flag is legacy compatibility only. Do not add R to normal reporter inputs unless strictly necessary.
9. For procedures_prototype, argumentids, argumentnames, argumentdefaults MUST use semicolon-separated strings, not JSON arrays.
10. All required inputs for a block must be provided.
11. When an input normally has a text or number slot, keep the slot valid by preserving or allowing a compatible shadow input.

CUSTOM BLOCK CHECKLIST:
- Definition without return: procedures_definition + procedures_prototype + body statements
- Definition with return: procedures_definition + procedures_prototype + procedures_return
- Calls: procedures_call or procedures_call_with_return
- Boolean arguments use argument_reporter_boolean
- String/number arguments use argument_reporter_string_number
- Reuse the same proccode and argumentids across definition, return, and calls

UCF CODE EXAMPLES:

Example 1: Simple event
event_whenflagclicked | C:0:0 |  |  |
motion_movesteps |  |  | I:STEPS=[math_number | S | F:NUM=10] |
looks_say |  |  | I:MESSAGE=[text | S | F:TEXT=Hello!] |

Example 2: Custom block without return
procedures_definition | C:0:0 |  | I:custom_block=[procedures_prototype | S |  |  | M:proccode=测试 %s %b,argumentids=arg1;arg2,argumentnames=文本;布尔,argumentdefaults=;false,warp=true,isreporter=false,isglobal=false] |
control_if |  |  | I:CONDITION=[argument_reporter_boolean |  | F:VALUE=布尔 |  | ],I:SUBSTACK=[
  looks_say |  |  | I:MESSAGE=[argument_reporter_string_number |  | F:VALUE=文本 |  | ] |
] |

event_whenflagclicked | C:0:200 |  |  |
procedures_call |  |  | I:arg1=[text | S | F:TEXT=安卓四点],arg2=[operator_not |  |  |  | ] | M:proccode=测试 %s %b,argumentids=arg1;arg2,warp=true,isreporter=false,isglobal=false

Example 3: Custom block with return
procedures_definition | C:0:0 |  | I:custom_block=[procedures_prototype | S |  |  | M:proccode=积木名称 %s,argumentids=arg1,argumentnames=文本,argumentdefaults=,warp=false,isreporter=true,isglobal=false] |
procedures_return |  |  | I:RETURN=[text | S | F:TEXT=111] | M:proccode=积木名称 %s,argumentids=arg1,warp=false,isreporter=true,isglobal=false

data_addtolist | C:0:200 | F:LIST=ScratchList | I:ITEM=[procedures_call_with_return |  |  | I:arg1=[text | S | F:TEXT=111] | M:proccode=积木名称 %s,argumentids=arg1,warp=false,isreporter=true,isglobal=false] |`;

export function useChat({ messages, currentAgent, updateSessionMessages, vm }: UseChatOptions) {
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
      case "generateCodeFromUCF":
        return aiTools[functionName](args.ucfString, args.targetId, args.x, args.y);
      case "getExtensionBlocks":
        return aiTools[functionName](args.extensionId);
      case "searchBlocks":
        return aiTools[functionName](args.keyword);
      case "getBlockInfo":
        return aiTools[functionName](args.opcode);
      case "cleanUpBlocks":
      case "getWorkspaceUCF":
        return aiTools[functionName](args.targetId);
      case "getCustomBlocks":
        return aiTools[functionName](args.targetId);
      case "getBlocksRangeUCF":
        return aiTools[functionName](args.startBlockId, args.endBlockId);
      case "replaceBlocksRangeByUCF":
        return aiTools[functionName](args.startBlockId, args.endBlockId, args.ucfString);
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
        { role: "assistant", content: "Error: 当前没有可用的 AI Agent，请先在设置中添加或恢复一个 Agent。" },
      ]);
      return;
    }

    if (!isProviderImplemented(currentAgent.provider)) {
      updateSessionMessages([
        ...messages,
        {
          role: "assistant",
          content: `Error: 当前 Provider '${currentAgent.provider}' 暂未接入。请改用 OpenAI、智谱、DeepSeek 或 Custom(OpenAI-compatible)。`,
        },
      ]);
      return;
    }

    const newMessage: ChatMessage = {
      role: "user",
      content: inputText,
      attachments,
    };
    const newMessages = [...messages, newMessage];
    let sessionId = "";

    sessionId = updateSessionMessages(newMessages);
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
        currentMessages = [...currentMessages, { role: "assistant", content: "" }];
        updateSessionMessages(currentMessages, sessionId);

        const data = await providerAdapter.sendChatCompletion({
          agent: currentAgent,
          messages: [{ role: "system", content: SYSTEM_PROMPT }, ...buildRequestMessages(requestMessages)],
          tools: scratchToolSchemas,
          toolChoice: "auto",
          signal: abortControllerRef.current.signal,
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
        });
        const responseMessage = data.choices[0].message as ChatMessage;

        currentMessages = currentMessages.map((message, index) =>
          index === assistantMessageIndex
            ? {
                ...message,
                ...responseMessage,
                content: responseMessage.content || message.content,
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
            !(index === currentMessages.length - 1 && message.role === "assistant" && !message.content),
        );
        updateSessionMessages(trimmedMessages, sessionId);
        return;
      }
      updateSessionMessages([...currentMessages, { role: "assistant", content: `Error: ${err.message}` }], sessionId);
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
