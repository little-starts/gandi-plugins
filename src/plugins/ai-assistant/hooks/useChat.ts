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
- listFiles: list the virtual Scratch project files.
- getProjectOverview: compact project/file/script/variable/list overview.
- getScratchGuide: concise task-oriented DSL patterns; prefer this over reading long docs.
- searchBlocks: search block docs and return exact JS DSL examples, fields, inputs, menus, and notes.
- getBlockHelp: exact help for one opcode or dotted DSL call.
- readFile: read /stage.js, /sprites/*.js, or docs.
- searchFiles: search code and raw Scratch DSL/block docs.
- applyPatch: edit writable virtual JS files with a Codex-style patch; successful patches immediately sync to Scratch blocks.
- getDiagnostics: validate current virtual JS files.

Workflow:
1) Start with getProjectOverview, then readFile only for the stage/sprite files you will edit.
2) Use getScratchGuide for common patterns, searchBlocks for candidate blocks, and getBlockHelp before using unfamiliar opcodes/menus.
3) For rendering, algorithms, or repeated logic, call getScratchGuide with topic "procedures", "custom-args", or "rendering" and prefer custom blocks over broadcast-only designs.
4) For non-trivial programs, patch one small script at a time, then call getDiagnostics before continuing.
5) Edit by applyPatch only. Do not ask the user to paste code.
6) After applyPatch, call getDiagnostics for the changed file.
7) Keep existing // @script <scriptId> markers. Add new scripts with unique markers like // @script new-score-loop.
8) Ordinary JS comments immediately before a block call become Scratch comments. Metadata comments like // @script and // blockId do not.
9) Use stable paths from listFiles, such as /stage.js or /sprites/<name>.js. Do not invent sprite paths with target ids.

applyPatch format:
- Do not wrap the patch in Markdown code fences.
- Preferred format is:
  *** Begin Patch
  *** Update File: /sprites/Cat.js
  @@
   existing context line
  +new line
  *** End Patch
- If the target virtual file is empty or you are replacing it completely, you may put the full replacement file directly after *** Update File without + prefixes.

Virtual JS DSL:
- Program sections contain expression statements only; each statement is one Scratch block call.
- Block call: namespace.method({ args }) or identifier({ args }).
- Block catalog opcodes like data_deletealloflist map to dotted DSL calls like data.deletealloflist(...). The underscore identifier form also works, but prefer dotted calls for readability.
- Fields use "$field_" keys, for example { $field_VARIABLE: "score" }. Always use $field_VARIABLE for variables and $field_LIST for lists; use data.variable({ $field_VARIABLE: "score" }) to read a variable.
- Dropdown/menu selectors also use "$field_" keys. Example: pen.setPenColorParamTo({ $field_COLOR_PARAM: "color", VALUE: 50 }); Valid pen COLOR_PARAM values are "color", "saturation", "brightness", "transparency".
- Custom block parameters are not variables. Inside define(...), read them with argument.reporter_string_number({ $field_VALUE: "paramName" }) or argument.reporter_boolean({ $field_VALUE: "flagName" }). Never use data.variable to read a custom block parameter.
- Inputs use plain keys, for example { MESSAGE: "hi", VALUE: 1 }.
- Boolean slots such as CONDITION must contain Boolean blocks. Wrap values with operator.equals/operator.gt/operator.lt instead of using data.variable directly.
- Substacks use arrow functions, for example SUBSTACK: () => { ... }.
- Reserved meta keys: $mutation, $args, $xy.
- Use $xy on top-level scripts to place stacks: { $xy: { x: 80, y: 120 } }.
- Keep // blockId comments when editing existing code; they help the sync layer map changes.
- Stage scripts should orchestrate variables, lists, broadcasts, backdrop, and sound. Put visual behavior that needs motion, pen, clones, position, size, or speech bubbles in sprite files.
- Use broadcasts for cross-target orchestration. Do not use broadcasts as local function calls when a custom block can pass parameters.
- Use custom blocks for reusable logic, sorting steps, math helpers, and pen rendering. Add info: ["warp"] when the helper should run without screen refresh.
- For pen rendering, prefer: event/broadcast receives "render" -> calls one warp custom block -> custom block clears and draws the full frame. Pass highlights/scale/offsets through $args and read them with argument.reporter_*.
- control.if only has SUBSTACK. Use control.if_else when you need SUBSTACK2 / else.
- Arithmetic operators use NUM1/NUM2. Comparison operators use OPERAND1/OPERAND2.
- If searchFiles cannot find an extension block such as pen.*, avoid relying on that extension unless an existing project already uses it.

Canonical patterns:
- Hat/event with body:
  event.whenflagclicked({ $xy: { x: 80, y: 80 } }, () => { ... });
  event.whenkeypressed({ $field_KEY_OPTION: "space", $xy: { x: 80, y: 240 } }, () => { ... });
  event.whenbroadcastreceived({ $field_BROADCAST_OPTION: "game-start", $xy: { x: 80, y: 400 } }, () => { ... });
  control.start_as_clone({ $xy: { x: 80, y: 560 } }, () => { ... });

- If/else:
  control.if_else({
    CONDITION: sensing.keypressed({ $field_KEY_OPTION: "space" }),
    SUBSTACK: () => { looks.say({ MESSAGE: "space" }); },
    SUBSTACK2: () => { looks.say({ MESSAGE: "waiting" }); }
  });
  control.repeat_until({
    CONDITION: operator.equals({ OPERAND1: data.variable({ $field_VARIABLE: "done" }), OPERAND2: 1 }),
    SUBSTACK: () => { looks.say({ MESSAGE: "looping" }); }
  });

- Variables and lists:
  data.setvariableto({ $field_VARIABLE: "score", VALUE: 0 });
  data.changevariableby({ $field_VARIABLE: "score", VALUE: 1 });
  data.deletealloflist({ $field_LIST: "numbers" });
  data.addtolist({ $field_LIST: "numbers", ITEM: operator.random({ FROM: 1, TO: 100 }) });
  data.itemoflist({ $field_LIST: "numbers", INDEX: data.variable({ $field_VARIABLE: "score" }) });

- Menus:
  pen.setPenColorParamTo({ $field_COLOR_PARAM: "color", VALUE: 50 });
  pen.changePenColorParamBy({ $field_COLOR_PARAM: "brightness", VALUE: 10 });
  event.whenkeypressed({ $field_KEY_OPTION: "space", $xy: { x: 80, y: 240 } }, () => { ... });

- Custom block / warp function:
  define({ proccode: "draw frame %n[left] %n[right]", info: ["warp"], $xy: { x: 80, y: 520 } }, () => {
    pen.clear();
    control.if({ CONDITION: operator.equals({ OPERAND1: data.variable({ $field_VARIABLE: "i" }), OPERAND2: argument.reporter_string_number({ $field_VALUE: "left" }) }), SUBSTACK: () => {
      pen.setPenColorToColor({ COLOR: "#ff4d4f" });
    } });
    // Draw the whole frame here.
  });
  procedures.call({ $mutation: { proccode: "draw frame %n %n", warp: "true" }, $args: [0, 0] });

Minimum example:
// @script new-hello
event.whenflagclicked({ $xy: { x: 80, y: 80 } }, () => {
  // This becomes a Scratch block comment.
  control.repeat({ TIMES: 3, SUBSTACK: () => { looks.say({ MESSAGE: "ok" }); } });
  event.broadcast({ BROADCAST_INPUT: "msg1" });
});`;

const REQUIRED_TOOL_ARGUMENTS: Record<string, string[]> = {
  readFile: ["path"],
  searchFiles: ["query"],
  searchBlocks: ["query"],
  getBlockHelp: ["opcode"],
  applyPatch: ["patch"],
};

const isMissingToolArgument = (value: unknown) =>
  value === undefined || value === null || (typeof value === "string" && value.trim() === "");

const validateToolArguments = (functionName: string, args: Record<string, unknown>) => {
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
      case "readFile":
        return aiTools[functionName](args.path, args.startLine, args.endLine);
      case "searchFiles":
        return aiTools[functionName](args);
      case "searchBlocks":
        return aiTools[functionName](args);
      case "getBlockHelp":
        return aiTools[functionName](args.opcode);
      case "getScratchGuide":
        return aiTools[functionName](args.topic);
      case "getProjectOverview":
        return aiTools[functionName]();
      case "applyPatch":
        return aiTools[functionName](args.patch);
      case "getDiagnostics":
        return aiTools[functionName](args.path);
      case "listFiles":
        return aiTools[functionName]();
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
                const parsedArgs = toolCall.function.arguments ? JSON.parse(toolCall.function.arguments) : {};
                if (!parsedArgs || typeof parsedArgs !== "object" || Array.isArray(parsedArgs)) {
                  throw new Error("Tool arguments must be a JSON object");
                }
                args = parsedArgs;
              } catch (parseError: any) {
                throw new Error(`Invalid tool arguments: ${parseError.message}`);
              }

              validateToolArguments(functionName, args);
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
