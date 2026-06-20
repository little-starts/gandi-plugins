import * as React from "react";
import ReactDOM from "react-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { SubAgentProfile } from "../types";
import { findSubAgentMentionRanges, renderMessageInlineNodes } from "../mentionUtils";
import chat from "../ui/Chat.module.less";
import { scratchToUCF, ucfToScratch } from "../ucf";
import { normalizeModelUCF } from "../annotatedUcf";
import { blockStatesToXml, getBlocksRangeBlockStates } from "../workspaceRangeTools";
import { callGetBlockInfo } from "../converter";
import { scrollBlockIntoView } from "utils/block-helper";
import {
  AI_ASSISTANT_EXTENSIONS_LOADED_EVENT,
  AI_PREVIEW_FALLBACK_EXTENSION_ID,
  AI_PREVIEW_FALLBACK_BLOCK_MARKER,
  getApprovedExtensionEntry,
  isApprovedExtensionLoaded,
  resolveApprovedExtensionForPreviewOpcode,
} from "../extensionLoadUtils";
import { ExtensionLoadButton } from "./ExtensionLoadButton";
import { BlockReferencePreviewDialog } from "./BlockReferencePreviewDialog";

const CODE_KEYWORDS = new Set([
  "as",
  "async",
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "default",
  "delete",
  "do",
  "else",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "from",
  "function",
  "if",
  "import",
  "in",
  "instanceof",
  "let",
  "new",
  "null",
  "of",
  "return",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "type",
  "typeof",
  "undefined",
  "var",
  "void",
  "while",
  "yield",
]);

const CODE_TOKEN_PATTERN =
  /(\/\/.*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b[A-Za-z_$][\w$]*(?=\s*\()|\b[A-Za-z_$][\w$]*\b|\b\d+(?:\.\d+)?\b|[{}[\]().,;:+\-*/%=<>!&|?]+)/g;

const getCodeTokenClass = (token: string) => {
  if (/^\/\//.test(token) || /^\/\*/.test(token)) return chat.syntaxComment;
  if (/^["'`]/.test(token)) return chat.syntaxString;
  if (/^\d/.test(token)) return chat.syntaxNumber;
  if (CODE_KEYWORDS.has(token)) return chat.syntaxKeyword;
  if (/^[A-Za-z_$][\w$]*$/.test(token) && !CODE_KEYWORDS.has(token)) return chat.syntaxIdentifier;
  return chat.syntaxPunctuation;
};

const renderHighlightedCode = (code: string) => {
  const nodes: React.ReactNode[] = [];
  let cursor = 0;

  code.replace(CODE_TOKEN_PATTERN, (token, _match, offset) => {
    if (offset > cursor) {
      nodes.push(code.slice(cursor, offset));
    }

    nodes.push(
      <span key={`${offset}-${token}`} className={getCodeTokenClass(token)}>
        {token}
      </span>,
    );
    cursor = offset + token.length;
    return token;
  });

  if (cursor < code.length) {
    nodes.push(code.slice(cursor));
  }

  return nodes;
};

interface StreamingAnimationTracker {
  sequence: number;
  states: Map<string, StreamingAnimationState>;
  visited: Set<string>;
  now: number;
}

interface StreamingAnimationState {
  text: string;
  activeFrom: number;
  expiresAt: number;
}

const getRevealStart = (tracker: StreamingAnimationTracker | undefined, value: string) => {
  if (!tracker) return Number.POSITIVE_INFINITY;

  const key = `node:${tracker.sequence}`;
  tracker.sequence += 1;
  tracker.visited.add(key);

  const previousState = tracker.states.get(key);
  if (!previousState) {
    tracker.states.set(key, {
      text: value,
      activeFrom: 0,
      expiresAt: tracker.now + STREAM_REVEAL_ANIMATION_MS,
    });
    return 0;
  }

  const stillAnimating = previousState.expiresAt > tracker.now;
  let activeFrom = stillAnimating ? previousState.activeFrom : Number.POSITIVE_INFINITY;

  if (value !== previousState.text) {
    const newStart = value.startsWith(previousState.text) ? previousState.text.length : 0;
    activeFrom = Math.min(activeFrom, newStart);
    previousState.text = value;
    previousState.activeFrom = activeFrom;
    previousState.expiresAt = tracker.now + STREAM_REVEAL_ANIMATION_MS;
    return activeFrom;
  }

  previousState.activeFrom = activeFrom;
  return activeFrom;
};

const encodeToBase64Unicode = (value: string) => {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary);
};

const createBlockSharingSvgDataUrl = (blocksState: any[]) => {
  const topLevelIndex = blocksState.findIndex((block) => block?.topLevel);
  const orderedBlocksState =
    topLevelIndex > 0
      ? [blocksState[topLevelIndex], ...blocksState.slice(0, topLevelIndex), ...blocksState.slice(topLevelIndex + 1)]
      : blocksState;
  const normalizedBlocksState = orderedBlocksState.map((block, index) => {
    if (index !== 0 && !block?.topLevel) return block;
    if (!block?.topLevel) return block;
    return {
      ...block,
      x: Number.isFinite(Number(block.x)) ? Number(block.x) : 0,
      y: Number.isFinite(Number(block.y)) ? Number(block.y) : 0,
    };
  });
  const blockData = encodeToBase64Unicode(JSON.stringify(normalizedBlocksState));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1" blockdata="${blockData}"></svg>`;
  return `data:image/svg+xml;base64,${encodeToBase64Unicode(svg)}`;
};

const getScratchBlocks = (blockly?: any) =>
  blockly || (window as any)?.Blockly || (window as any)?.ScratchBlocks || null;

const normalizePreviewBlockType = (info: any) =>
  String(info?.blockType || info?.type || "")
    .toLowerCase()
    .replace(/[_\s-]+/g, "");

const getPreviewBlockColour = (scratchBlocks: any, info: any) => {
  if (info?.unknownExtension) return "#8a8f98";
  const colours = scratchBlocks?.Colours;
  const extensionId = String(info?.extensionId || "").toLowerCase();
  if (extensionId === "data" || String(info?.opcode || "").startsWith("data_")) {
    return colours?.data?.primary || "#ff8c1a";
  }
  return colours?.extensions?.primary || colours?.more?.primary || "#0fbd8c";
};

const parsePreviewBlockMessage = (info: any) => {
  const inputs = Object.keys(info?.inputs || {});
  const fields = Object.keys(info?.fields || {});
  const argNames = [...fields, ...inputs];
  let message = String(info?.text || info?.opcode || "extension block")
    .replace(/（[^（）]*$/g, "")
    .replace(/\([^()]*:[^()]*\)\s*$/g, "")
    .trim();

  const args: any[] = [];
  const used = new Set<string>();
  message = message.replace(/\[([^\]]+)\]/g, (_match, rawName) => {
    const name = String(rawName || "").trim();
    const fieldInfo = info?.fields?.[name];
    const inputInfo = info?.inputs?.[name];
    if (!fieldInfo && !inputInfo) return name;
    used.add(name);
    args.push(fieldInfo ? createPreviewFieldArg(name, fieldInfo) : createPreviewInputArg(name, inputInfo));
    return `%${args.length}`;
  });

  argNames.forEach((name) => {
    if (used.has(name)) return;
    const fieldInfo = info?.fields?.[name];
    const inputInfo = info?.inputs?.[name];
    args.push(fieldInfo ? createPreviewFieldArg(name, fieldInfo) : createPreviewInputArg(name, inputInfo));
    message += `${message ? " " : ""}%${args.length}`;
  });

  return {
    message: message || String(info?.opcode || "extension block"),
    args,
  };
};

const getPreviewBlockMap = (blocksState: any[]) => new Map(blocksState.map((block) => [String(block?.id || ""), block]));

const getPreviewBlockParentInputName = (block: any, blocksMap: Map<string, any>) => {
  const blockId = String(block?.id || "");
  const parent = block?.parent ? blocksMap.get(String(block.parent)) : null;
  if (!blockId || !parent?.inputs) return "";

  for (const input of Object.values(parent.inputs) as any[]) {
    if (String(input?.block || "") === blockId || String(input?.shadow || "") === blockId) {
      return String(input?.name || "");
    }
  }
  return "";
};

const inferPreviewBlockType = (block: any, blocksMap: Map<string, any>) => {
  const parentInputName = getPreviewBlockParentInputName(block, blocksMap).toUpperCase();
  if (parentInputName) {
    return /CONDITION|BOOLEAN|PREDICATE|BOOL/.test(parentInputName) ? "boolean" : "reporter";
  }
  if (block?.topLevel && /^when|^on|_when|_on/i.test(String(block?.opcode || ""))) return "hat";
  return "command";
};

const hasPreviewStatementInput = (block: any, inputName: string, blocksMap: Map<string, any>) => {
  if (/^SUBSTACK/i.test(inputName)) return true;
  const input = block?.inputs?.[inputName];
  const child = input?.block ? blocksMap.get(String(input.block)) : null;
  if (!child) return false;
  return !getPreviewBlockParentInputName(child, blocksMap) && !child?.shadow;
};

const buildUnknownPreviewBlockInfo = (opcode: string, block: any, blocksMap: Map<string, any>, blockInfo?: any) => {
  const extension = resolveApprovedExtensionForPreviewOpcode(opcode, blockInfo);
  const extensionId =
    extension?.extensionId ||
    String(blockInfo?.extensionId || blockInfo?.extensionID || blockInfo?.category || "")
      .trim()
      .replace(/^ext_/i, "") ||
    String(opcode || "").split("_")[0] ||
    "unknown";

  const fields = Object.fromEntries(
    Object.keys(block?.fields || {}).map((name) => [name, { type: "field", defaultValue: block.fields?.[name]?.value ?? "" }]),
  );
  const inputs = Object.fromEntries(
    Object.keys(block?.inputs || {}).map((name) => [
      name,
      {
        type: hasPreviewStatementInput(block, name, blocksMap) ? "statement" : "input",
      },
    ]),
  );

  return {
    opcode,
    extensionId,
    unknownExtension: true,
    blockType: inferPreviewBlockType(block, blocksMap),
    text: "未知积木",
    fields,
    inputs,
  };
};

const createPreviewFieldArg = (name: string, meta: any) => {
  const defaultValue =
    meta?.defaultValue ?? meta?.value ?? (Array.isArray(meta?.menuOptions) ? meta.menuOptions[0]?.value ?? meta.menuOptions[0] : "");
  const options = Array.isArray(meta?.menuOptions)
    ? meta.menuOptions.map((item: any) => {
        if (Array.isArray(item)) return [String(item[0] ?? item[1] ?? ""), String(item[1] ?? item[0] ?? "")];
        if (item && typeof item === "object") return [String(item.text ?? item.label ?? item.value ?? ""), String(item.value ?? item.text ?? item.label ?? "")];
        return [String(item ?? ""), String(item ?? "")];
      })
    : [[String(defaultValue ?? name), String(defaultValue ?? name)]];
  return {
    type: "field_dropdown",
    name,
    options,
  };
};

const createPreviewInputArg = (name: string, meta: any) => {
  const type = String(meta?.type || "").toLowerCase();
  if (type === "image") {
    return {
      type: "field_label",
      name,
      text: "",
    };
  }
  if (type === "statement") {
    return {
      type: "input_statement",
      name,
    };
  }
  return {
    type: "input_value",
    name,
  };
};

const registerPreviewFallbackBlock = (scratchBlocks: any, info: any) => {
  const opcode = String(info?.opcode || "");
  if (!opcode) return;
  if (!scratchBlocks?.Blocks) return;
  const existingDefinition = scratchBlocks.Blocks[opcode];
  if (existingDefinition && !(existingDefinition as any)[AI_PREVIEW_FALLBACK_BLOCK_MARKER]) return;

  const { message, args } = parsePreviewBlockMessage(info);
  const blockType = normalizePreviewBlockType(info);
  const json: any = {
    type: opcode,
    message0: message,
    args0: args,
    colour: getPreviewBlockColour(scratchBlocks, info),
  };

  if (blockType.includes("boolean")) {
    json.output = "Boolean";
  } else if (blockType.includes("reporter")) {
    json.output = null;
  } else if (blockType.includes("hat")) {
    json.nextStatement = null;
    json.extensions = ["shape_hat"];
  } else {
    json.previousStatement = null;
    json.nextStatement = null;
  }

  scratchBlocks.Blocks[opcode] = {
    [AI_PREVIEW_FALLBACK_BLOCK_MARKER]: true,
    [AI_PREVIEW_FALLBACK_EXTENSION_ID]: info?.extensionId || "",
    init() {
      this.jsonInit(json);
    },
  };
};

const registerPreviewFallbackBlocks = (blocksState: any[], scratchBlocks: any, vm?: PluginContext["vm"]) => {
  const unknownExtensions = new Set<string>();
  if (!scratchBlocks?.Blocks) return { unknownExtensions: [] };
  const blocksMap = getPreviewBlockMap(blocksState);
  blocksState.forEach((block) => {
    const opcode = String(block?.opcode || "");
    if (!opcode) return;
    const existingDefinition = scratchBlocks.Blocks[opcode];
    if (existingDefinition?.[AI_PREVIEW_FALLBACK_BLOCK_MARKER]) {
      const extensionId = existingDefinition?.[AI_PREVIEW_FALLBACK_EXTENSION_ID];
      if (extensionId && getApprovedExtensionEntry(extensionId)) unknownExtensions.add(extensionId);
      return;
    }
    if (existingDefinition) return;
    let blockInfo: any = null;
    try {
      blockInfo = callGetBlockInfo(opcode, vm?.runtime);
      if (blockInfo?.found) {
        const extension = resolveApprovedExtensionForPreviewOpcode(opcode, blockInfo);
        const shouldTreatAsUnknownExtension = extension && !isApprovedExtensionLoaded(vm, extension.extensionId);
        registerPreviewFallbackBlock(scratchBlocks, {
          ...blockInfo,
          opcode,
          extensionId: extension?.extensionId || blockInfo.extensionId,
          unknownExtension: shouldTreatAsUnknownExtension,
          text: shouldTreatAsUnknownExtension ? "未知积木" : blockInfo.text,
        });
        if (shouldTreatAsUnknownExtension) unknownExtensions.add(extension.extensionId);
        return;
      }
    } catch {
      // Missing fallback metadata should not prevent normal preview rendering.
    }
    const fallbackInfo = buildUnknownPreviewBlockInfo(opcode, block, blocksMap, blockInfo);
    if (!fallbackInfo) return;
    if (getApprovedExtensionEntry(fallbackInfo.extensionId)) unknownExtensions.add(fallbackInfo.extensionId);
    registerPreviewFallbackBlock(scratchBlocks, fallbackInfo);
  });
  return { unknownExtensions: Array.from(unknownExtensions) };
};

const copyTextToClipboard = async (text: string) => {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch (error) {
      console.warn("[AI Assistant Markdown] navigator.clipboard.writeText failed, falling back to execCommand.", error);
    }
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  textarea.remove();
};

interface DslPreviewRenderOptions {
  preserveTopLevelPositions?: boolean;
}

export const serializeBlocksToPreviewSvg = (
  blocksState: any[],
  blockly?: any,
  vm?: PluginContext["vm"],
  options: DslPreviewRenderOptions = {},
) => {
  const scratchBlocks = getScratchBlocks(blockly);
  if (!scratchBlocks?.inject || !scratchBlocks?.Xml?.textToDom || !scratchBlocks?.Xml?.domToWorkspace) {
    throw new Error("Blockly render API is unavailable.");
  }
  const fallbackRegistration = registerPreviewFallbackBlocks(blocksState, scratchBlocks, vm);

  const host = document.createElement("div");
  host.style.position = "fixed";
  host.style.left = "-10000px";
  host.style.top = "-10000px";
  host.style.width = "900px";
  host.style.height = "600px";
  host.style.opacity = "0";
  host.style.pointerEvents = "none";
  document.body.appendChild(host);

  let previewWorkspace: any = null;
  try {
    previewWorkspace = scratchBlocks.inject(host, {
      readOnly: true,
      scrollbars: false,
      comments: false,
      disable: true,
      media: scratchBlocks.mainWorkspace?.options?.pathToMedia,
    });
    const xmlDom = scratchBlocks.Xml.textToDom(blockStatesToXml(blocksState));
    scratchBlocks.Xml.domToWorkspace(xmlDom, previewWorkspace);
    const wrapper = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    wrapper.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    wrapper.style.position = "fixed";
    wrapper.style.left = "0";
    wrapper.style.top = "0";
    wrapper.style.width = "1px";
    wrapper.style.height = "1px";
    wrapper.style.overflow = "visible";
    wrapper.style.opacity = "0";
    wrapper.style.pointerEvents = "none";
    document.body.appendChild(wrapper);

    const topBlocks = previewWorkspace.getTopBlocks?.(true) || [];
    const topBlockRoots = topBlocks.map((block: any) => block?.getSvgRoot?.()).filter(Boolean) as SVGGElement[];
    if (!topBlockRoots.length) throw new Error("No renderable top-level block.");

    const padding = 10;
    const gap = 24;

    if (options.preserveTopLevelPositions && topBlockRoots.length <= 1) {
      const entries = topBlockRoots.map((svgRoot) => {
        const clonedRoot = svgRoot.cloneNode(true) as SVGGElement;
        clonedRoot.innerHTML = clonedRoot.innerHTML.replace(/&nbsp;/g, " ");
        wrapper.appendChild(clonedRoot);
        const bounds = clonedRoot.getBoundingClientRect();
        const fallbackBounds =
          (!bounds.width || !bounds.height) && typeof (clonedRoot as any).getBBox === "function"
            ? (clonedRoot as any).getBBox()
            : null;
        return {
          clonedRoot,
          width: Math.max(1, Math.ceil(bounds.width || fallbackBounds?.width || 1)),
          height: Math.max(1, Math.ceil(bounds.height || fallbackBounds?.height || 1)),
          left: Number.isFinite(bounds.left) ? bounds.left : fallbackBounds?.x || 0,
          top: Number.isFinite(bounds.top) ? bounds.top : fallbackBounds?.y || 0,
        };
      });

      const minLeft = Math.min(...entries.map((entry) => entry.left));
      const minTop = Math.min(...entries.map((entry) => entry.top));
      const maxRight = Math.max(...entries.map((entry) => entry.left + entry.width));
      const maxBottom = Math.max(...entries.map((entry) => entry.top + entry.height));

      entries.forEach((entry) => {
        entry.clonedRoot.remove();
        const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
        group.setAttribute("transform", `translate(${padding - minLeft} ${padding - minTop})`);
        group.appendChild(entry.clonedRoot);
        wrapper.appendChild(group);
      });

      const width = Math.max(1, Math.ceil(maxRight - minLeft + padding * 2));
      const height = Math.max(1, Math.ceil(maxBottom - minTop + padding * 2));
      wrapper.removeAttribute("style");
      wrapper.setAttribute("width", String(width));
      wrapper.setAttribute("height", String(height));
      wrapper.setAttribute("viewBox", `0 0 ${width} ${height}`);

      const svg = new XMLSerializer().serializeToString(wrapper);
      wrapper.remove();
      return { svg, unknownExtensions: fallbackRegistration.unknownExtensions };
    }

    let cursorY = 0;
    let maxWidth = 0;

    topBlockRoots.forEach((svgRoot) => {
      const clonedRoot = svgRoot.cloneNode(true) as SVGGElement;
      clonedRoot.innerHTML = clonedRoot.innerHTML.replace(/&nbsp;/g, " ");
      wrapper.appendChild(clonedRoot);

      const bounds = clonedRoot.getBoundingClientRect();
      const fallbackBounds =
        (!bounds.width || !bounds.height) && typeof (clonedRoot as any).getBBox === "function"
          ? (clonedRoot as any).getBBox()
          : null;
      const width = Math.max(1, Math.ceil(bounds.width || fallbackBounds?.width || 1));
      const height = Math.max(1, Math.ceil(bounds.height || fallbackBounds?.height || 1));
      const left = Number.isFinite(bounds.left) ? bounds.left : fallbackBounds?.x || 0;
      const top = Number.isFinite(bounds.top) ? bounds.top : fallbackBounds?.y || 0;

      clonedRoot.remove();
      const group = document.createElementNS("http://www.w3.org/2000/svg", "g");
      group.setAttribute("transform", `translate(${padding - left} ${padding + cursorY - top})`);
      group.appendChild(clonedRoot);
      wrapper.appendChild(group);

      maxWidth = Math.max(maxWidth, width);
      cursorY += height + gap;
    });

    const contentHeight = Math.max(1, cursorY - gap);
    const width = Math.max(1, Math.ceil(maxWidth + padding * 2));
    const height = Math.max(1, Math.ceil(contentHeight + padding * 2));
    wrapper.removeAttribute("style");
    wrapper.setAttribute("width", String(width));
    wrapper.setAttribute("height", String(height));
    wrapper.setAttribute("viewBox", `0 0 ${width} ${height}`);

    const svg = new XMLSerializer().serializeToString(wrapper);
    wrapper.remove();
    return { svg, unknownExtensions: fallbackRegistration.unknownExtensions };
  } finally {
    try {
      previewWorkspace?.dispose?.();
    } catch {
      // ignore preview workspace disposal failure
    }
    host.remove();
  }
};

const parseDslBlocks = (code: string, vm?: PluginContext["vm"]) =>
  ucfToScratch(normalizeModelUCF(code), {
    runtime: vm?.runtime,
    includeComments: true,
  });

const parseDslPreviewBlocks = (code: string, vm?: PluginContext["vm"]) =>
  ucfToScratch(normalizeModelUCF(code), {
    runtime: vm?.runtime,
    includeComments: true,
    linkTopLevelStatements: true,
  });

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const isDslFenceClosed = (sourceMarkdown: string | undefined, code: string, language?: string) => {
  if (!sourceMarkdown) return true;
  if (!/^dsl$/i.test(String(language || ""))) return true;

  const source = sourceMarkdown.replace(/\r\n?/g, "\n");
  const normalizedCode = code.replace(/\r\n?/g, "\n").trimEnd();
  const fenceStartRe = /(^|\n)(`{3,}|~{3,})[ \t]*DSL[^\n]*\n/gi;
  let match: RegExpExecArray | null;

  while ((match = fenceStartRe.exec(source))) {
    const fence = match[2];
    const bodyStart = match.index + match[0].length;
    const closeRe = new RegExp(`(^|\\n)${escapeRegExp(fence)}[ \\t]*(?=\\n|$)`, "g");
    closeRe.lastIndex = bodyStart;
    const closeMatch = closeRe.exec(source);
    if (!closeMatch) continue;
    const bodyEnd = closeMatch.index + (closeMatch[1] ? 1 : 0);
    const body = source.slice(bodyStart, bodyEnd).trimEnd();
    if (body === normalizedCode || body.includes(normalizedCode)) return true;
  }

  return false;
};

interface PartialDslSyntaxState {
  parentheses: number;
  braces: number;
  hasOpenQuote: boolean;
  invalid: boolean;
  closers: string[];
}

const getPreviousToken = (value: string, index: number) => {
  let cursor = index - 1;
  while (cursor >= 0 && /\s/.test(value[cursor])) cursor -= 1;
  if (cursor < 0) return "";
  if (value[cursor] === ">" && value[cursor - 1] === "=") return "=>";
  return value[cursor];
};

const getPartialDslSyntaxState = (value: string): PartialDslSyntaxState => {
  let parentheses = 0;
  let braces = 0;
  let quote: '"' | "'" | "`" | null = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  let invalid = false;
  const stack: Array<{ char: "(" | "{"; kind?: "block" | "object" }> = [];

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    const next = value[index + 1];

    if (lineComment) {
      if (char === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === quote) quote = null;
      continue;
    }
    if (char === "/" && next === "/") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "(") {
      parentheses += 1;
      stack.push({ char });
    } else if (char === ")") {
      parentheses -= 1;
      if (stack[stack.length - 1]?.char === "(") stack.pop();
      else invalid = true;
    } else if (char === "{") {
      braces += 1;
      stack.push({ char, kind: getPreviousToken(value, index) === "=>" ? "block" : "object" });
    } else if (char === "}") {
      braces -= 1;
      if (stack[stack.length - 1]?.char === "{") stack.pop();
      else invalid = true;
    }
  }

  const closers = [...stack].reverse().map((item) => (item.char === "(" ? ")" : item.kind === "block" ? ";}" : "}"));
  return { parentheses, braces, hasOpenQuote: Boolean(quote || blockComment), invalid, closers };
};

const completePartialDsl = (value: string) => {
  let prepared = value.trimEnd();
  if (!prepared) return "";
  if (/[(:,]\s*$/.test(prepared)) {
    prepared += /:\s*$/.test(prepared) ? '""' : "{}";
  }
  const balance = getPartialDslSyntaxState(prepared);
  if (balance.invalid || balance.hasOpenQuote || balance.parentheses < 0 || balance.braces < 0) return "";
  let completed = prepared;
  completed += balance.closers.join("");
  if (!/[;}]$/.test(completed)) completed += ";";
  return completed;
};

const buildPartialDslCandidates = (code: string) => {
  const lines = code.replace(/\r\n?/g, "\n").split("\n");
  const candidates: string[] = [];
  const seen = new Set<string>();
  const addCandidate = (value: string) => {
    const candidate = value.trimEnd();
    if (!candidate || seen.has(candidate)) return;
    seen.add(candidate);
    candidates.push(candidate);
  };

  for (let end = lines.length; end >= 1; end -= 1) {
    const prefix = lines.slice(0, end).join("\n");
    addCandidate(completePartialDsl(prefix));
    addCandidate(prefix);
  }

  return candidates;
};

export const renderDslPreview = (
  code: string,
  vm: PluginContext["vm"] | undefined,
  blockly: any,
  allowPartial: boolean,
  options: DslPreviewRenderOptions = {},
) => {
  try {
    const blocksState = parseDslPreviewBlocks(code, vm);
    const rendered = serializeBlocksToPreviewSvg(blocksState, blockly, vm, options);
    return {
      blocksState,
      svg: rendered.svg,
      unknownExtensions: rendered.unknownExtensions,
      partial: false,
    };
  } catch (fullError) {
    if (!allowPartial) throw fullError;

    const candidates = buildPartialDslCandidates(code);
    for (const candidate of candidates) {
      if (candidate.trimEnd() === code.trimEnd()) continue;
      try {
        const blocksState = parseDslPreviewBlocks(candidate, vm);
        const rendered = serializeBlocksToPreviewSvg(blocksState, blockly, vm, options);
        return {
          blocksState,
          svg: rendered.svg,
          unknownExtensions: rendered.unknownExtensions,
          partial: true,
        };
      } catch {
        // Try a smaller prefix.
      }
    }

    throw fullError;
  }
};

const DEFAULT_DSL_PREVIEW_SCALE = 0.6;
const MIN_DSL_PREVIEW_SCALE = 0.35;
const MAX_DSL_PREVIEW_SCALE = 1.8;
const DSL_PREVIEW_CACHE_LIMIT = 24;
interface DslPreviewCacheEntry {
  svg: string;
  unknownExtensions: string[];
}

const dslPreviewSvgCache = new Map<string, DslPreviewCacheEntry>();

const clampDslPreviewScale = (value: number) =>
  Math.min(MAX_DSL_PREVIEW_SCALE, Math.max(MIN_DSL_PREVIEW_SCALE, value));

const getDslPreviewCacheKey = (code: string) => {
  const meaningfulPrefix = code
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("//"))
    .slice(0, 2)
    .join("\n");
  return (meaningfulPrefix || code.trim()).slice(0, 180);
};

const getCachedDslPreview = (key: string): DslPreviewCacheEntry => {
  if (!key) return { svg: "", unknownExtensions: [] };
  return dslPreviewSvgCache.get(key) || { svg: "", unknownExtensions: [] };
};

const setCachedDslPreview = (key: string, entry: DslPreviewCacheEntry) => {
  const svg = entry.svg;
  if (!key || !svg) return;
  if (dslPreviewSvgCache.has(key)) {
    dslPreviewSvgCache.delete(key);
  }
  dslPreviewSvgCache.set(key, {
    svg,
    unknownExtensions: Array.from(new Set(entry.unknownExtensions || [])),
  });
  while (dslPreviewSvgCache.size > DSL_PREVIEW_CACHE_LIMIT) {
    const oldestKey = dslPreviewSvgCache.keys().next().value;
    if (!oldestKey) break;
    dslPreviewSvgCache.delete(oldestKey);
  }
};

const getPointerDistance = (points: Array<{ x: number; y: number }>) => {
  if (points.length < 2) return 0;
  const [first, second] = points;
  return Math.hypot(second.x - first.x, second.y - first.y);
};

interface MarkdownBlockReference {
  targetId: string;
  startBlockId: string;
  endBlockId: string;
  startLabel: string;
  endLabel: string;
  path: string;
  startLine: number;
  endLine: number;
  code: string;
  fallbackCode?: string;
  segmentCount: number;
  displayBlocks: MarkdownBlockReferenceDisplayBlock[];
  missing?: boolean;
}

interface MarkdownBlockReferenceDisplayBlock {
  blockId: string;
  label: string;
}

interface MarkdownScriptSection {
  scriptId: string;
  startLine: number;
  endLine: number;
  lineToBlockId: Map<number, string>;
}

interface MarkdownScriptFile {
  path: string;
  targetId: string;
  lines: string[];
  sections: MarkdownScriptSection[];
}

const SCRIPT_REFERENCE_RE =
  /((?:\/?[^\s，。；、（）()<>[\]{}'"`]+\/)*[^\s，。；、（）()<>[\]{}'"`]+\.js)(?:\s*[:：]\s*|\s+)第?(\d+)\s*(?:行)?(?:\s*(?:到|至|-|~|–|—)\s*第?(\d+)\s*(?:行)?)?/g;

const SCRIPT_FILES_COMMENT_RE = /^ai-assistant script-files(?:\s+\d+\/\d+)?$/;

const normalizeVirtualPathForMarkdown = (path: string) => {
  const normalized = String(path || "")
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .trim();
  const withRoot = normalized.startsWith("/") ? normalized : `/${normalized}`;
  return withRoot.replace(/\/+$/g, "") || "/";
};

const splitVirtualPathForMarkdown = (path: string) =>
  normalizeVirtualPathForMarkdown(path).split("/").filter(Boolean);

const getVirtualBaseNameForMarkdown = (path: string) => splitVirtualPathForMarkdown(path).pop() || "";

const getFileStemForMarkdown = (fileName: string) => {
  const index = String(fileName || "").lastIndexOf(".");
  return index > 0 ? fileName.slice(0, index) : fileName;
};

const sanitizePathSegmentForMarkdown = (value: string, fallback: string) => {
  const sanitized = String(value || "")
    .trim()
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ")
    .replace(/\s+/g, "-")
    .replace(/^\.+|\.+$/g, "")
    .slice(0, 80);
  return sanitized || fallback;
};

const sanitizeSpriteFolderNameForMarkdown = (value: string, fallback = "sprite") => {
  const name = sanitizePathSegmentForMarkdown(value, fallback);
  return name.toLowerCase() === "stage" ? `${name}-sprite` : name;
};

const getScriptFileNameForMarkdown = (value: string, fallback = "script") => {
  const compact = String(value || "").replace(/\.[^.]+$/, "");
  const sanitized = sanitizePathSegmentForMarkdown(compact, fallback)
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${sanitized || fallback}.js`;
};

const getRuntimeTargetName = (target: any) =>
  String(target?.getName?.() || target?.sprite?.name || target?.id || "target");

const isRuntimeCloneTarget = (target: any) =>
  Boolean(target && !target.isStage && target.isOriginal === false && target.sprite);

const getProjectIndexTargetsForMarkdown = (vm?: PluginContext["vm"]) => {
  const targets = Array.isArray(vm?.runtime?.targets) ? vm.runtime.targets : [];
  return targets.filter((target: any) => target && !isRuntimeCloneTarget(target));
};

const getRootPathByTargetIdForMarkdown = (targets: any[]) => {
  const nameCounts = new Map<string, number>();
  const nameSeen = new Map<string, number>();

  targets.forEach((target) => {
    if (target?.isStage) return;
    const name = sanitizeSpriteFolderNameForMarkdown(getRuntimeTargetName(target));
    nameCounts.set(name, (nameCounts.get(name) || 0) + 1);
  });

  const result = new Map<string, string>();
  targets.forEach((target) => {
    if (!target?.id) return;
    if (target.isStage) {
      result.set(target.id, "/stage");
      return;
    }
    const name = sanitizeSpriteFolderNameForMarkdown(getRuntimeTargetName(target));
    const index = (nameSeen.get(name) || 0) + 1;
    nameSeen.set(name, index);
    const suffix = (nameCounts.get(name) || 0) > 1 ? `.${index}` : "";
    result.set(target.id, `/${name}${suffix}`);
  });
  return result;
};

const parseScriptFileNameMapForMarkdown = (target: any) => {
  const result = new Map<string, string>();
  const comments = target?.comments && typeof target.comments === "object" ? Object.values(target.comments) : [];
  const lines = comments.flatMap((comment: any) => {
    if (comment?.blockId) return [];
    const commentLines = String(comment?.text || "").split(/\r?\n/);
    if (!SCRIPT_FILES_COMMENT_RE.test(commentLines[0]?.trim() || "")) return [];
    return commentLines.slice(1);
  });

  lines.forEach((line) => {
    const trimmed = String(line || "").trim();
    if (!trimmed || /^#\s*default\s*=/.test(trimmed)) return;
    const separator = trimmed.lastIndexOf("=");
    if (separator <= 0) return;
    const scriptId = trimmed.slice(0, separator).trim();
    const fileName = getScriptFileNameForMarkdown(getFileStemForMarkdown(trimmed.slice(separator + 1).trim()), "script");
    if (scriptId && fileName) result.set(scriptId, fileName);
  });
  return result;
};

const getTopLevelBlocksForMarkdown = (target: any) => {
  const blocks = target?.blocks?._blocks as Record<string, any>;
  if (!blocks) return [];
  return Object.values(blocks)
    .filter((block: any) => block?.topLevel && !block?.parent && !block?.shadow)
    .sort((left: any, right: any) => {
      const leftY = typeof left.y === "number" ? left.y : 0;
      const rightY = typeof right.y === "number" ? right.y : 0;
      if (leftY !== rightY) return leftY - rightY;
      const leftX = typeof left.x === "number" ? left.x : 0;
      const rightX = typeof right.x === "number" ? right.x : 0;
      if (leftX !== rightX) return leftX - rightX;
      return String(left.id).localeCompare(String(right.id));
    });
};

const collectScriptBlocksForMarkdown = (blocks: Record<string, any>, topBlockId: string) => {
  const seen = new Set<string>();
  const result: any[] = [];

  const visit = (blockId?: string | null) => {
    if (!blockId || seen.has(blockId)) return;
    const block = blocks[blockId];
    if (!block) return;
    seen.add(blockId);
    result.push(block);
    Object.values(block.inputs || {}).forEach((input: any) => {
      visit(input?.block);
      visit(input?.shadow);
    });
    visit(block.next);
  };

  visit(topBlockId);
  return result;
};

const buildLineToBlockIdMap = (annotatedCode: string, startLine: number, fallbackBlockId: string) => {
  const lineToBlockId = new Map<number, string>();
  const lines = annotatedCode.split("\n");
  lines.forEach((line, index) => {
    const lineNumber = startLine + index;
    const blockId = line.match(/\/\/\s*blockId:\s*([^\s]+)\s*$/i)?.[1];
    if (blockId) lineToBlockId.set(lineNumber, blockId);
  });
  if (!lineToBlockId.size && fallbackBlockId) {
    lineToBlockId.set(startLine, fallbackBlockId);
  }
  return lineToBlockId;
};

const buildMarkdownScriptFiles = (vm?: PluginContext["vm"]) => {
  const targets = getProjectIndexTargetsForMarkdown(vm);
  const rootPathByTargetId = getRootPathByTargetIdForMarkdown(targets);
  const files: MarkdownScriptFile[] = [];

  targets.forEach((target) => {
    const blocks = target?.blocks?._blocks as Record<string, any>;
    if (!target?.id || !blocks) return;

    const persistedFileNameByScriptId = parseScriptFileNameMapForMarkdown(target);
    const groups = new Map<string, any[]>();
    getTopLevelBlocksForMarkdown(target).forEach((topBlock: any) => {
      const fileName =
        persistedFileNameByScriptId.get(topBlock.id) ||
        getScriptFileNameForMarkdown(String(topBlock.opcode || "script").replace(/_/g, "-"), "script");
      groups.set(fileName, [...(groups.get(fileName) || []), topBlock]);
    });

    const rootPath = rootPathByTargetId.get(target.id) || "/sprite";
    groups.forEach((topBlocks, fileName) => {
      let cursorLine = 1;
      const sections: MarkdownScriptSection[] = [];
      const fileLines: string[] = [];
      const hasMultipleSections = topBlocks.length > 1;

      topBlocks.forEach((topBlock, index) => {
        const scriptBlocks = collectScriptBlocksForMarkdown(blocks, topBlock.id);
        const annotatedCode = scratchToUCF(scriptBlocks, {
          runtime: vm?.runtime,
          includePosition: true,
          includeBlockIds: true,
        }).trimEnd();
        const codeLines = annotatedCode ? annotatedCode.split("\n") : [""];
        const lineCount = Math.max(1, codeLines.length);
        let markerLine = 0;
        if (hasMultipleSections) {
          markerLine = cursorLine;
          fileLines.push(`// @script ${topBlock.id} ${topBlock.opcode || ""}`.trimEnd());
          cursorLine += 1;
        }
        const startLine = cursorLine;
        const endLine = startLine + lineCount - 1;
        const lineToBlockId = buildLineToBlockIdMap(annotatedCode, startLine, topBlock.id);
        if (markerLine) lineToBlockId.set(markerLine, topBlock.id);
        fileLines.push(...codeLines);

        sections.push({
          scriptId: topBlock.id,
          startLine: markerLine || startLine,
          endLine,
          lineToBlockId,
        });
        cursorLine = endLine + 1;
        if (hasMultipleSections && index < topBlocks.length - 1) {
          fileLines.push("");
          fileLines.push("");
          cursorLine += 2;
        }
      });

      files.push({
        path: `${rootPath}/scripts/${fileName}`,
        targetId: target.id,
        lines: fileLines,
        sections,
      });
    });
  });

  return files;
};

const findNearestBlockIdForLine = (section: MarkdownScriptSection, line: number) => {
  const exact = section.lineToBlockId.get(line);
  if (exact) return exact;
  const candidates = [...section.lineToBlockId.entries()]
    .filter(([lineNumber]) => lineNumber >= section.startLine && lineNumber <= section.endLine)
    .sort((left, right) => Math.abs(left[0] - line) - Math.abs(right[0] - line));
  return candidates[0]?.[1] || section.scriptId;
};

const uniqueMarkdownReferenceBlocks = (items: MarkdownBlockReferenceDisplayBlock[]) => {
  const result: MarkdownBlockReferenceDisplayBlock[] = [];
  items.forEach((item) => {
    if (!item.blockId || !item.label) return;
    const previous = result[result.length - 1];
    if (previous?.blockId === item.blockId) return;
    result.push(item);
  });
  return result;
};

const getBlockLabelForMarkdown = (vm: PluginContext["vm"] | undefined, block: any) => {
  const opcode = String(block?.opcode || "");
  if (!opcode) return "未知积木";
  try {
    const info = callGetBlockInfo(opcode, vm?.runtime);
    const label = String(info?.text || opcode);
    if (info?.extensionId) return label;
    return label.replace(/\s*\([^()]*\)\s*$/, "");
  } catch {
    return opcode;
  }
};

const createMissingMarkdownBlockReference = (): MarkdownBlockReference => ({
  targetId: "",
  startBlockId: "",
  endBlockId: "",
  startLabel: "未知积木",
  endLabel: "未知积木",
  path: "",
  startLine: 1,
  endLine: 1,
  code: "",
  fallbackCode: "",
  segmentCount: 1,
  missing: true,
  displayBlocks: [
    {
      blockId: "",
      label: "未知积木",
    },
  ],
});

const stripMarkdownBlockIdComment = (line: string) => line.replace(/\s*\/\/\s*blockId:\s*[^\s]+\s*$/i, "");

const resolveMarkdownBlockReference = (
  vm: PluginContext["vm"] | undefined,
  fileNameOrPath: string,
  startLine: number,
  endLine: number,
): MarkdownBlockReference | null => {
  if (!vm?.runtime) return createMissingMarkdownBlockReference();
  const normalizedReferencePath = normalizeVirtualPathForMarkdown(fileNameOrPath);
  const referenceWithoutRoot = normalizedReferencePath.slice(1);
  const referenceBaseName = getVirtualBaseNameForMarkdown(normalizedReferencePath);
  const files = buildMarkdownScriptFiles(vm);
  const file =
    files.find((item) => normalizeVirtualPathForMarkdown(item.path) === normalizedReferencePath) ||
    files.find((item) => normalizeVirtualPathForMarkdown(item.path).slice(1) === referenceWithoutRoot) ||
    files.find((item) => item.path.endsWith(`/${referenceWithoutRoot}`)) ||
    files.find((item) => getVirtualBaseNameForMarkdown(item.path) === referenceBaseName);
  if (!file) return createMissingMarkdownBlockReference();

  const safeStartLine = Math.max(1, Math.min(startLine, endLine));
  const safeEndLine = Math.max(safeStartLine, Math.max(startLine, endLine));
  const startSection =
    file.sections.find((section) => safeStartLine >= section.startLine && safeStartLine <= section.endLine) ||
    file.sections.find((section) => safeEndLine >= section.startLine && safeEndLine <= section.endLine) ||
    file.sections[0];
  const endSection =
    [...file.sections].reverse().find((section) => safeEndLine >= section.startLine && safeEndLine <= section.endLine) ||
    [...file.sections].reverse().find((section) => safeStartLine >= section.startLine && safeStartLine <= section.endLine) ||
    startSection;
  if (!startSection || !endSection) return createMissingMarkdownBlockReference();

  const startBlockId = findNearestBlockIdForLine(startSection, safeStartLine);
  const endBlockId = findNearestBlockIdForLine(endSection, safeEndLine);
  const target = vm.runtime.getTargetById?.(file.targetId);
  const blocks = target?.blocks?._blocks as Record<string, any>;
  const startBlock = blocks?.[startBlockId] || blocks?.[startSection.scriptId];
  const endBlock = blocks?.[endBlockId] || blocks?.[endSection.scriptId] || startBlock;
  if (!startBlock || !endBlock) return createMissingMarkdownBlockReference();

  const selectedSections = file.sections.filter(
    (section) => section.endLine >= safeStartLine && section.startLine <= safeEndLine,
  );
  const rangeSections = selectedSections.length ? selectedSections : [startSection, endSection].filter(Boolean);
  const selectedCode = file.lines
    .slice(safeStartLine - 1, safeEndLine)
    .filter((line) => !/^\s*\/\/\s*@script\b/.test(line))
    .map(stripMarkdownBlockIdComment)
    .join("\n")
    .trim();
  const fallbackSectionCode = rangeSections
    .flatMap((section) => file.lines.slice(section.startLine - 1, section.endLine))
    .filter((line) => !/^\s*\/\/\s*@script\b/.test(line))
    .map(stripMarkdownBlockIdComment)
    .join("\n")
    .trim();
  const segmentStartBlocks = rangeSections.map((section) => blocks?.[section.scriptId]).filter(Boolean);
  const displayBlocks =
    rangeSections.length > 1
      ? uniqueMarkdownReferenceBlocks([
          ...segmentStartBlocks.map((block) => ({
            blockId: block.id,
            label: getBlockLabelForMarkdown(vm, block),
          })),
          {
            blockId: endBlock.id || endBlockId,
            label: getBlockLabelForMarkdown(vm, endBlock),
          },
        ])
      : uniqueMarkdownReferenceBlocks([
          {
            blockId: startBlock.id || startBlockId,
            label: getBlockLabelForMarkdown(vm, startBlock),
          },
          ...(startBlock.id !== endBlock.id
            ? [
                {
                  blockId: endBlock.id || endBlockId,
                  label: getBlockLabelForMarkdown(vm, endBlock),
                },
              ]
            : []),
        ]);

  return {
    targetId: file.targetId,
    startBlockId: startBlock.id || startBlockId,
    endBlockId: endBlock.id || endBlockId,
    startLabel: getBlockLabelForMarkdown(vm, startBlock),
    endLabel: getBlockLabelForMarkdown(vm, endBlock),
    path: file.path,
    startLine: safeStartLine,
    endLine: safeEndLine,
    code: selectedCode || fallbackSectionCode,
    fallbackCode: fallbackSectionCode && fallbackSectionCode !== selectedCode ? fallbackSectionCode : undefined,
    segmentCount: rangeSections.length,
    displayBlocks,
  };
};

const scrollMarkdownBlockReferenceIntoView = (
  vm: PluginContext["vm"] | undefined,
  workspace: Blockly.WorkspaceSvg | undefined,
  targetId: string,
  blockId: string,
) => {
  if (!vm || !workspace || !targetId || !blockId) return;

  const tryScroll = () => {
    const block =
      (typeof workspace.getBlockById === "function" ? workspace.getBlockById(blockId) : null) ||
      (workspace as any).blockDB_?.[blockId];
    if (!block) return false;
    scrollBlockIntoView(block, workspace);
    return true;
  };

  if (vm.editingTarget?.id === targetId && tryScroll()) return;

  let disposed = false;
  let attempts = 0;
  let timeoutId: number | null = null;
  const cleanup = () => {
    if (disposed) return;
    disposed = true;
    vm.off?.("targetsUpdate", handleTargetsUpdate);
    if (timeoutId !== null) window.clearTimeout(timeoutId);
  };
  const retry = () => {
    if (disposed) return;
    attempts += 1;
    if (tryScroll() || attempts > 20) cleanup();
    else window.requestAnimationFrame(retry);
  };
  const handleTargetsUpdate = () => window.requestAnimationFrame(retry);

  vm.on?.("targetsUpdate", handleTargetsUpdate);
  timeoutId = window.setTimeout(cleanup, 2600);
  vm.setEditingTarget?.(targetId);
  window.requestAnimationFrame(retry);
};

const MarkdownBlockReferenceToken = ({
  reference,
  isRangeReference,
  vm,
  blockly,
  workspace,
}: {
  reference: MarkdownBlockReference;
  isRangeReference: boolean;
  vm?: PluginContext["vm"];
  blockly?: any;
  workspace?: Blockly.WorkspaceSvg;
}) => {
  const [expanded, setExpanded] = React.useState(false);
  const [missingDialogOpen, setMissingDialogOpen] = React.useState(false);
  const [previewDialog, setPreviewDialog] = React.useState<{ svg: string; title: string } | null>(null);
  const shouldCollapse = isRangeReference && reference.segmentCount > 1 && reference.displayBlocks.length > 1;
  const visibleBlocks = shouldCollapse && !expanded ? reference.displayBlocks.slice(0, 1) : reference.displayBlocks;
  const openPreview = (event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (reference.missing || !reference.code) {
      setMissingDialogOpen(true);
      return;
    }
    try {
      const parseBlocks = (code: string) =>
        ucfToScratch(code, {
          runtime: vm?.runtime,
          includeComments: true,
          validate: false,
        });
      let blocks: any[];
      const runtimeRange = getBlocksRangeBlockStates(vm, reference.startBlockId, reference.endBlockId);
      if (runtimeRange.success && Array.isArray((runtimeRange as any).blocks) && (runtimeRange as any).blocks.length) {
        blocks = (runtimeRange as any).blocks;
      } else {
        try {
          blocks = parseBlocks(reference.code);
        } catch (error) {
          if (!reference.fallbackCode) throw error;
          blocks = parseBlocks(reference.fallbackCode);
        }
      }
      const rendered = serializeBlocksToPreviewSvg(blocks, blockly, vm);
      setPreviewDialog({
        svg: rendered.svg,
        title:
          reference.startLine === reference.endLine
            ? `${reference.path} ${reference.startLine}行`
            : `${reference.path} ${reference.startLine}行到${reference.endLine}行`,
      });
    } catch (error) {
      console.warn("[AI Assistant Block Reference Preview] Failed to render markdown block reference", {
        reference,
        error,
      });
    }
  };
  const jumpToBlock = (blockId: string) => (event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (reference.missing || !blockId) {
      setMissingDialogOpen(true);
      return;
    }
    scrollMarkdownBlockReferenceIntoView(vm, workspace, reference.targetId, blockId);
  };
  const jumpToStart = jumpToBlock(reference.startBlockId);

  return (
    <span className={chat.markdownBlockReferenceToken}>
      {visibleBlocks.map((block, index) => (
        <React.Fragment key={`${block.blockId}-${index}`}>
          {index > 0 ? (
            <button type="button" className={chat.markdownBlockReferenceSeparator} onClick={jumpToStart} aria-label="跳转到起始积木">
              ~
            </button>
          ) : null}
          <button type="button" className={chat.markdownBlockReferenceButton} onClick={openPreview}>
            {block.label}
          </button>
        </React.Fragment>
      ))}
      {shouldCollapse && !expanded ? (
        <>
          <button type="button" className={chat.markdownBlockReferenceSeparator} onClick={jumpToStart} aria-label="跳转到起始积木">
            ~
          </button>
          <button
            type="button"
            className={`${chat.markdownBlockReferenceButton} ${chat.markdownBlockReferenceExpandButton}`}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setExpanded(true);
            }}
          >
            展开
          </button>
        </>
      ) : null}
      {missingDialogOpen && typeof document !== "undefined" && document.body
        ? ReactDOM.createPortal(
            <div className={chat.extensionLoadConfirmOverlay} data-no-window-drag="true">
              <div className={chat.extensionLoadConfirmDialog} role="dialog" aria-modal="true">
                <div className={chat.extensionLoadConfirmTitle}>未找到积木</div>
                <div className={chat.extensionLoadConfirmMessage}>未找到积木</div>
                <div className={chat.extensionLoadConfirmActions}>
                  <button
                    type="button"
                    className={chat.extensionLoadConfirmPrimary}
                    onClick={() => setMissingDialogOpen(false)}
                  >
                    知道了
                  </button>
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
      {previewDialog && typeof document !== "undefined" && document.body
        ? ReactDOM.createPortal(
            <BlockReferencePreviewDialog
              title={previewDialog.title}
              svg={previewDialog.svg}
              onClose={() => setPreviewDialog(null)}
              onJump={() => scrollMarkdownBlockReferenceIntoView(vm, workspace, reference.targetId, reference.startBlockId)}
            />,
            document.body,
          )
        : null}
    </span>
  );
};

const MarkdownCodeBlock = ({
  code,
  language,
  vm,
  blockly,
  sourceMarkdown,
  isStreamingMarkdown,
  ...props
}: {
  code: string;
  language?: string;
  vm?: PluginContext["vm"];
  blockly?: any;
  sourceMarkdown?: string;
  isStreamingMarkdown?: boolean;
}) => {
  const isDsl = /^dsl$/i.test(String(language || ""));
  const previewCacheKey = React.useMemo(() => (isDsl ? getDslPreviewCacheKey(code) : ""), [code, isDsl]);
  const initialPreview = React.useMemo(() => getCachedDslPreview(previewCacheKey), [previewCacheKey]);
  const [showText, setShowText] = React.useState(false);
  const [copiedMessage, setCopiedMessage] = React.useState("");
  const [previewSvg, setPreviewSvg] = React.useState(() => initialPreview.svg);
  const [unknownExtensions, setUnknownExtensions] = React.useState<string[]>(() => initialPreview.unknownExtensions);
  const [previewError, setPreviewError] = React.useState("");
  const [showPreviewErrorDetails, setShowPreviewErrorDetails] = React.useState(false);
  const [previewScale, setPreviewScale] = React.useState(DEFAULT_DSL_PREVIEW_SCALE);
  const previewScaleRef = React.useRef(DEFAULT_DSL_PREVIEW_SCALE);
  const [previewRefreshKey, setPreviewRefreshKey] = React.useState(0);
  const parsedBlocksStateRef = React.useRef<any[] | null>(null);
  const previewContainerRef = React.useRef<HTMLDivElement | null>(null);
  const codePreRef = React.useRef<HTMLPreElement | null>(null);
  const pinchRef = React.useRef<{
    pointers: Map<number, { x: number; y: number }>;
    startDistance: number;
    startScale: number;
    startCenter: { x: number; y: number } | null;
    startScrollLeft: number;
    startScrollTop: number;
  }>({
    pointers: new Map(),
    startDistance: 0,
    startScale: DEFAULT_DSL_PREVIEW_SCALE,
    startCenter: null,
    startScrollLeft: 0,
    startScrollTop: 0,
  });

  React.useEffect(() => {
    previewScaleRef.current = previewScale;
  }, [previewScale]);

  React.useEffect(() => {
    if (!isDsl || showText || previewSvg) return;
    const cachedPreview = getCachedDslPreview(previewCacheKey);
    if (cachedPreview.svg) {
      setPreviewSvg(cachedPreview.svg);
      setUnknownExtensions(cachedPreview.unknownExtensions);
    }
  }, [isDsl, previewCacheKey, previewSvg, showText]);

  React.useEffect(() => {
    if (!isDsl) return undefined;
    const handleExtensionsLoaded = () => {
      dslPreviewSvgCache.clear();
      parsedBlocksStateRef.current = null;
      setPreviewSvg("");
      setUnknownExtensions([]);
      setPreviewError("");
      setShowPreviewErrorDetails(false);
      setPreviewRefreshKey((value) => value + 1);
    };

    window.addEventListener(AI_ASSISTANT_EXTENSIONS_LOADED_EVENT, handleExtensionsLoaded);
    return () => {
      window.removeEventListener(AI_ASSISTANT_EXTENSIONS_LOADED_EVENT, handleExtensionsLoaded);
    };
  }, [isDsl]);

  React.useEffect(() => {
    setShowPreviewErrorDetails(false);
    if (!isDsl || showText) return undefined;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      const codeFenceClosed = !isStreamingMarkdown || isDslFenceClosed(sourceMarkdown, code, language);
      try {
        const result = renderDslPreview(code, vm, blockly, !codeFenceClosed, { preserveTopLevelPositions: true });
        if (!cancelled) {
          parsedBlocksStateRef.current = result.blocksState;
          setCachedDslPreview(previewCacheKey, {
            svg: result.svg,
            unknownExtensions: result.unknownExtensions || [],
          });
          setPreviewSvg((previous) => (previous === result.svg ? previous : result.svg));
          setUnknownExtensions(result.unknownExtensions || []);
          setPreviewError("");
        }
      } catch (error: any) {
        console.warn("[AI Assistant DSL Preview] Failed to render DSL block preview", {
          error,
          code,
          codeFenceClosed,
        });
        if (!cancelled) {
          if (codeFenceClosed) {
            parsedBlocksStateRef.current = null;
            setPreviewSvg("");
            setUnknownExtensions([]);
            setPreviewError(error?.message || String(error));
          } else {
            setPreviewError("");
          }
        }
      }
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [blockly, code, isDsl, isStreamingMarkdown, language, previewCacheKey, previewRefreshKey, showText, sourceMarkdown, vm]);

  React.useLayoutEffect(() => {
    if (!isStreamingMarkdown) return undefined;
    const element = isDsl && !showText ? previewContainerRef.current : codePreRef.current;
    if (!element) return undefined;

    const scrollToInternalBottom = () => {
      if (element.scrollHeight <= element.clientHeight) return;
      element.scrollTop = element.scrollHeight;
    };

    scrollToInternalBottom();
    const frameId = window.requestAnimationFrame(scrollToInternalBottom);
    return () => window.cancelAnimationFrame(frameId);
  }, [code, isDsl, isStreamingMarkdown, previewError, previewSvg, showText]);

  const handleCopy = async () => {
    if (isDsl && !showText) {
      let blocksState = parsedBlocksStateRef.current;
      if (!blocksState) {
        try {
          blocksState = parseDslPreviewBlocks(code, vm);
          parsedBlocksStateRef.current = blocksState;
        } catch (error: any) {
          console.warn("[AI Assistant DSL Preview] Failed to parse DSL for copying as blocks", {
            error,
            code,
          });
          setPreviewError((previous) => previous || error?.message || String(error));
          setCopiedMessage("DSL 语法错误");
          window.setTimeout(() => setCopiedMessage(""), 2400);
          return;
        }
      }

      try {
        await copyTextToClipboard(createBlockSharingSvgDataUrl(blocksState));
        setCopiedMessage("复制成功，请到工作区中粘贴");
      } catch (error: any) {
        console.warn("[AI Assistant DSL Preview] Failed to copy block sharing payload", {
          error,
          code,
        });
        setCopiedMessage(error?.message || "复制失败");
      }
      window.setTimeout(() => setCopiedMessage(""), 1800);
      return;
    }

    try {
        await copyTextToClipboard(code);
        setCopiedMessage("复制成功");
      window.setTimeout(() => setCopiedMessage(""), 1800);
    } catch (error: any) {
      setCopiedMessage(error?.message || "复制失败");
      window.setTimeout(() => setCopiedMessage(""), 2400);
    }
  };

  const shellClassName =
    isDsl && !showText
      ? `${chat.markdownCodeBlockShell} ${chat.markdownCodeBlockShellDslPreview}`
      : chat.markdownCodeBlockShell;

  const handleExtensionsLoaded = () => {
    dslPreviewSvgCache.clear();
    parsedBlocksStateRef.current = null;
    setPreviewSvg("");
    setUnknownExtensions([]);
    setPreviewError("");
    setPreviewRefreshKey((value) => value + 1);
  };

  const setPreviewScaleAroundClientPoint = React.useCallback(
    (nextScaleValue: number, clientX: number, clientY: number, baseScale = previewScaleRef.current, baseScroll?: { left: number; top: number }) => {
      const element = previewContainerRef.current;
      const nextScale = clampDslPreviewScale(nextScaleValue);
      if (!element || !Number.isFinite(nextScale) || nextScale <= 0) {
        previewScaleRef.current = nextScale;
        setPreviewScale(nextScale);
        return;
      }

      const bounds = element.getBoundingClientRect();
      const anchorX = clientX - bounds.left;
      const anchorY = clientY - bounds.top;
      const scrollLeft = baseScroll?.left ?? element.scrollLeft;
      const scrollTop = baseScroll?.top ?? element.scrollTop;
      const contentX = (scrollLeft + anchorX) / Math.max(baseScale, 0.0001);
      const contentY = (scrollTop + anchorY) / Math.max(baseScale, 0.0001);

      previewScaleRef.current = nextScale;
      setPreviewScale(nextScale);
      window.requestAnimationFrame(() => {
        element.scrollLeft = Math.max(0, contentX * nextScale - anchorX);
        element.scrollTop = Math.max(0, contentY * nextScale - anchorY);
      });
    },
    [],
  );

  React.useEffect(() => {
    if (!isDsl || showText) return undefined;
    const element = previewContainerRef.current;
    if (!element) return undefined;

    const handleWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      event.stopPropagation();
      const factor = Math.exp(-event.deltaY * 0.001);
      setPreviewScaleAroundClientPoint(previewScaleRef.current * factor, event.clientX, event.clientY);
    };

    element.addEventListener("wheel", handleWheel, { passive: false, capture: true });
    return () => {
      element.removeEventListener("wheel", handleWheel, { capture: true });
    };
  }, [isDsl, setPreviewScaleAroundClientPoint, showText]);

  const updatePinchScale = () => {
    const points = Array.from(pinchRef.current.pointers.values());
    if (points.length < 2 || !pinchRef.current.startDistance) return;
    const distance = getPointerDistance(points);
    if (!distance) return;
    const center = {
      x: (points[0].x + points[1].x) / 2,
      y: (points[0].y + points[1].y) / 2,
    };
    setPreviewScaleAroundClientPoint(
      pinchRef.current.startScale * (distance / pinchRef.current.startDistance),
      center.x,
      center.y,
    );
  };

  const handlePreviewPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    event.currentTarget.focus({ preventScroll: true });
    if (event.pointerType === "mouse") return;
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // ignore pointer capture failures
    }
    pinchRef.current.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const points = Array.from(pinchRef.current.pointers.values());
    if (points.length === 2) {
      pinchRef.current.startDistance = getPointerDistance(points);
      pinchRef.current.startScale = previewScaleRef.current;
      pinchRef.current.startCenter = {
        x: (points[0].x + points[1].x) / 2,
        y: (points[0].y + points[1].y) / 2,
      };
      pinchRef.current.startScrollLeft = event.currentTarget.scrollLeft;
      pinchRef.current.startScrollTop = event.currentTarget.scrollTop;
    }
  };

  const handlePreviewPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!pinchRef.current.pointers.has(event.pointerId)) return;
    pinchRef.current.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pinchRef.current.pointers.size >= 2) {
      event.preventDefault();
      updatePinchScale();
    }
  };

  const handlePreviewPointerEnd = (event: React.PointerEvent<HTMLDivElement>) => {
    pinchRef.current.pointers.delete(event.pointerId);
    if (pinchRef.current.pointers.size < 2) {
      pinchRef.current.startDistance = 0;
      pinchRef.current.startScale = previewScaleRef.current;
      pinchRef.current.startCenter = null;
      pinchRef.current.startScrollLeft = 0;
      pinchRef.current.startScrollTop = 0;
    } else {
      const points = Array.from(pinchRef.current.pointers.values());
      pinchRef.current.startDistance = getPointerDistance(points);
      pinchRef.current.startScale = previewScaleRef.current;
      pinchRef.current.startCenter = {
        x: (points[0].x + points[1].x) / 2,
        y: (points[0].y + points[1].y) / 2,
      };
      pinchRef.current.startScrollLeft = event.currentTarget.scrollLeft;
      pinchRef.current.startScrollTop = event.currentTarget.scrollTop;
    }
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // ignore pointer capture failures
    }
  };

  return (
    <div className={shellClassName}>
      <div className={chat.markdownCodeBlockActions}>
        {isDsl && !showText && unknownExtensions.length ? (
          <ExtensionLoadButton extensionIds={unknownExtensions} vm={vm} blockly={blockly} onLoaded={handleExtensionsLoaded} />
        ) : null}
        {isDsl ? (
          <button type="button" className={chat.markdownCodeButton} onClick={() => setShowText((value) => !value)}>
            {showText ? "积木" : "文本"}
          </button>
        ) : null}
        <button type="button" className={chat.markdownCodeButton} onClick={() => void handleCopy()}>
          复制
        </button>
        {copiedMessage ? <span className={chat.markdownCodeCopyTip}>{copiedMessage}</span> : null}
      </div>
      {isDsl && !showText ? (
        <div
          className={chat.dslBlockPreview}
          ref={previewContainerRef}
          tabIndex={0}
          onPointerDown={handlePreviewPointerDown}
          onPointerMove={handlePreviewPointerMove}
          onPointerUp={handlePreviewPointerEnd}
          onPointerCancel={handlePreviewPointerEnd}
          style={{ "--ai-dsl-preview-scale": previewScale } as React.CSSProperties}
        >
          {previewSvg ? <div className={chat.dslBlockSvg} dangerouslySetInnerHTML={{ __html: previewSvg }} /> : null}
          {!previewSvg && previewError ? (
            <div className={chat.dslBlockPreviewError}>
              <div className={chat.dslBlockPreviewErrorHeader}>
                <span>DSL 语法错误</span>
                <button
                  type="button"
                  className={chat.dslBlockPreviewErrorToggle}
                  onClick={() => setShowPreviewErrorDetails((value) => !value)}
                  aria-expanded={showPreviewErrorDetails}
                >
                  {showPreviewErrorDetails ? "收起" : "展开"}
                </button>
              </div>
              {showPreviewErrorDetails ? <pre className={chat.dslBlockPreviewErrorDetail}>{previewError}</pre> : null}
            </div>
          ) : null}
          {!previewSvg && !previewError ? <pre className={chat.dslBlockPreviewFallback}>正在渲染积木...</pre> : null}
        </div>
      ) : (
        <pre className={chat.markdownPre} ref={codePreRef}>
          <code className={chat.markdownCode} data-language={language || undefined} {...props}>
            {renderHighlightedCode(code)}
          </code>
        </pre>
      )}
    </div>
  );
};

const MarkdownCode = ({ inline, className, children, streamingTracker, vm, blockly, sourceMarkdown, ...props }: any) => {
  const rawCode = String(children ?? "");
  const code = rawCode.replace(/\n$/, "");
  const language = /language-([\w-]+)/.exec(className || "")?.[1];
  const isInline = inline ?? (!className && !rawCode.includes("\n"));
  const contextSourceMarkdown = React.useContext(MarkdownSourceContext);

  if (isInline) {
    const shouldAnimate = getRevealStart(streamingTracker, code) < code.length;
    return (
      <code
        className={`${chat.markdownInlineCode} ${shouldAnimate ? chat.streamingRevealInlineCode : ""}`}
        {...props}
      >
        {children}
      </code>
    );
  }

  return (
    <MarkdownCodeBlock
      code={code}
      language={language}
      vm={vm}
      blockly={blockly}
      sourceMarkdown={sourceMarkdown || contextSourceMarkdown}
      isStreamingMarkdown={Boolean(streamingTracker)}
      {...props}
    />
  );
};

const STREAM_REVEAL_INTERVAL_MS = 10;
const STREAM_REVEAL_BATCH_THRESHOLD = 5;
const STREAM_REVEAL_BATCH_SIZE = 5;
const STREAM_REVEAL_ANIMATION_MS = 560;
const STREAM_REVEAL_RESUME_TAIL_CHARS = 5;
const STREAM_REVEAL_CACHE_LIMIT = 32;
const streamingDisplayTextCache = new Map<string, string>();
const StreamingAnimationContext = React.createContext<StreamingAnimationTracker | undefined>(undefined);
const MarkdownSourceContext = React.createContext<string | undefined>(undefined);
let assistantMarkdownInstanceCounter = 0;

const getStreamingCache = (key?: string) => (key ? streamingDisplayTextCache.get(key) || "" : "");

const setStreamingCache = (key: string | undefined, value: string) => {
  if (!key) return;
  if (streamingDisplayTextCache.has(key)) {
    streamingDisplayTextCache.delete(key);
  }
  streamingDisplayTextCache.set(key, value);
  while (streamingDisplayTextCache.size > STREAM_REVEAL_CACHE_LIMIT) {
    const oldestKey = streamingDisplayTextCache.keys().next().value;
    if (!oldestKey) break;
    streamingDisplayTextCache.delete(oldestKey);
  }
};

const getBacktickRunLength = (value: string, index: number) => {
  let cursor = index;
  while (cursor < value.length && value[cursor] === "`") {
    cursor += 1;
  }
  return cursor - index;
};

const splitStreamingRevealUnits = (value: string) => {
  const units: string[] = [];
  let cursor = 0;

  while (cursor < value.length) {
    if (value[cursor] === "`") {
      const markerLength = getBacktickRunLength(value, cursor);
      if (markerLength < 3) {
        const marker = "`".repeat(markerLength);
        const closingIndex = value.indexOf(marker, cursor + markerLength);
        if (closingIndex >= 0) {
          units.push(value.slice(cursor, closingIndex + markerLength));
          cursor = closingIndex + markerLength;
          continue;
        }
      }
    }

    const next = Array.from(value.slice(cursor))[0] || "";
    units.push(next);
    cursor += next.length;
  }

  return units;
};

const getStreamingRevealBatchSize = (unitCount: number) => {
  if (unitCount <= STREAM_REVEAL_BATCH_THRESHOLD) return 1;
  const bufferedBatch = (Math.floor(unitCount / STREAM_REVEAL_BATCH_SIZE) - 1) * STREAM_REVEAL_BATCH_SIZE;
  return Math.max(STREAM_REVEAL_BATCH_SIZE, bufferedBatch);
};

const getResumeDisplayText = (content: string, streamKey?: string, useTailFallback = false) => {
  if (!useTailFallback) return "";
  const chars = Array.from(content);
  const tailStartText = chars.length <= STREAM_REVEAL_RESUME_TAIL_CHARS
    ? ""
    : chars.slice(0, -STREAM_REVEAL_RESUME_TAIL_CHARS).join("");
  const cached = getStreamingCache(streamKey);
  if (!cached || !content.startsWith(cached)) return useTailFallback ? tailStartText : "";
  return cached.length > tailStartText.length ? tailStartText : cached;
};

const getSafeFootnotePrefix = (streamKey: string | undefined, instanceId: number) => {
  const safeKey = String(streamKey || "message")
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return `ai-md-${safeKey || "message"}-${instanceId}`;
};

const namespaceFootnoteId = (footnoteIdPrefix: string, id: unknown) => {
  if (id === undefined || id === null) return id;
  const rawId = String(id || "");
  if (!rawId) return rawId;
  if (rawId.startsWith(`${footnoteIdPrefix}-`)) return rawId;
  if (rawId === "footnote-label") return `${footnoteIdPrefix}-footnote-label`;
  if (rawId.startsWith("user-content-fn")) return `${footnoteIdPrefix}-${rawId}`;
  return rawId;
};

const namespaceFootnoteHref = (footnoteIdPrefix: string, href: unknown) => {
  if (href === undefined || href === null) return href;
  const rawHref = String(href || "");
  if (!rawHref.startsWith("#")) return rawHref;
  return `#${namespaceFootnoteId(footnoteIdPrefix, rawHref.slice(1))}`;
};

const getComparableHostRoot = (hostname: string) => {
  const normalized = String(hostname || "").trim().toLowerCase();
  if (!normalized) return "";
  if (normalized === "localhost" || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(normalized) || normalized.includes(":")) {
    return normalized;
  }
  const parts = normalized.split(".").filter(Boolean);
  if (parts.length <= 2) return normalized;
  return parts.slice(-2).join(".");
};

const isSameSiteUrl = (url: URL) => {
  const current = new URL(window.location.href);
  return getComparableHostRoot(url.hostname) === getComparableHostRoot(current.hostname);
};

const openUrlInNewWindow = (href: string) => {
  const link = document.createElement("a");
  link.href = href;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  link.remove();
};

const renderFootnoteReference = (id: string, key: string, footnoteIdPrefix: string) => (
  <sup key={key}>
    <a
      href={`#${footnoteIdPrefix}-user-content-fn-${id}`}
      id={`${footnoteIdPrefix}-user-content-fnref-${id}`}
      data-footnote-ref
      aria-describedby={`${footnoteIdPrefix}-footnote-label`}
    >
      {id}
    </a>
  </sup>
);

const renderAssistantMentionText = (text: string, subAgents: SubAgentProfile[]) => {
  const mentionRanges = findSubAgentMentionRanges(text, subAgents);
  return (
    <span className={chat.markdownTextRun}>
      {renderMessageInlineNodes(text, mentionRanges, [], chat.assistantMessageMentionToken, "")}
    </span>
  );
};

const renderAssistantAnimatedText = (
  text: string,
  subAgents: SubAgentProfile[],
  tracker: StreamingAnimationTracker,
) => {
  const mentionRanges = findSubAgentMentionRanges(text, subAgents);
  const nodes: React.ReactNode[] = [];
  let cursor = 0;
  const revealStart = getRevealStart(tracker, text);
  let localOffset = 0;

  const renderChars = (value: string, className?: string) =>
    Array.from(value).map((char) => {
      const offset = localOffset;
      const shouldAnimate = offset >= revealStart;
      localOffset += char.length;
      const visibleChar = char === " " ? "\u00a0" : char;
      return (
        <span key={`stream-char-${offset}-${char}`} className={shouldAnimate ? className || chat.streamingRevealChar : undefined}>
          {visibleChar}
        </span>
      );
    });

  mentionRanges.forEach((range, index) => {
    if (range.start > cursor) {
      nodes.push(...renderChars(text.slice(cursor, range.start)));
    }
    nodes.push(
      <span key={`stream-mention-${range.start}-${index}`} className={chat.assistantMessageMentionToken}>
        {renderChars(text.slice(range.start, range.end), chat.streamingRevealMentionChar)}
      </span>,
    );
    cursor = Math.max(cursor, range.end);
  });

  if (cursor < text.length) {
    nodes.push(...renderChars(text.slice(cursor)));
  }

  return <span className={chat.markdownTextRun}>{nodes}</span>;
};

const renderAssistantTextSegment = (
  text: string,
  subAgents: SubAgentProfile[],
  tracker: StreamingAnimationTracker | undefined,
  vm?: PluginContext["vm"],
  blockly?: any,
  workspace?: Blockly.WorkspaceSvg,
) => {
  if (!text) return null;

  const nodes: React.ReactNode[] = [];
  let cursor = 0;
  SCRIPT_REFERENCE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;

  const renderPlainText = (value: string, key: string) =>
    tracker
      ? <React.Fragment key={key}>{renderAssistantAnimatedText(value, subAgents, tracker)}</React.Fragment>
      : <React.Fragment key={key}>{renderAssistantMentionText(value, subAgents)}</React.Fragment>;

  while ((match = SCRIPT_REFERENCE_RE.exec(text))) {
    const [raw, filePath, startLineText, endLineText] = match;
    const offset = match.index;
    const isRangeReference = Boolean(endLineText);
    const reference = resolveMarkdownBlockReference(
      vm,
      filePath,
      Number(startLineText),
      Number(endLineText || startLineText),
    );
    if (!reference) continue;

    if (offset > cursor) {
      nodes.push(renderPlainText(text.slice(cursor, offset), `text-${cursor}-${offset}`));
    }

    nodes.push(
      <MarkdownBlockReferenceToken
        key={`block-ref-${offset}-${raw}`}
        reference={reference}
        isRangeReference={isRangeReference}
        vm={vm}
        blockly={blockly}
        workspace={workspace}
      />,
    );
    cursor = offset + raw.length;
  }

  if (!nodes.length) return renderPlainText(text, "text-all");
  if (cursor < text.length) {
    nodes.push(renderPlainText(text.slice(cursor), `text-${cursor}-end`));
  }
  return <>{nodes}</>;
};

const findPreviousHighlightableSibling = (node: Node | null) => {
  let cursor = node?.previousSibling || null;
  while (cursor) {
    if (cursor.nodeType === Node.ELEMENT_NODE) {
      return cursor as HTMLElement;
    }
    if (cursor.nodeType === Node.TEXT_NODE && String(cursor.textContent || "").trim()) {
      return node instanceof HTMLElement ? node : null;
    }
    cursor = cursor.previousSibling;
  }
  return null;
};

const getFootnoteJumpHighlightTarget = (targetElement: HTMLElement | null) => {
  if (!targetElement) return null;

  const footnoteReference = targetElement.closest("a[data-footnote-ref]") as HTMLElement | null;
  if (footnoteReference) {
    const referenceWrapper = footnoteReference.closest("sup") as HTMLElement | null;
    return findPreviousHighlightableSibling(referenceWrapper) || referenceWrapper || footnoteReference;
  }

  return (targetElement.closest("li") as HTMLElement | null) || targetElement;
};

const renderAssistantMarkdownChildren = (
  children: React.ReactNode,
  subAgents: SubAgentProfile[],
  footnoteIdPrefix: string,
  tracker?: StreamingAnimationTracker,
  vm?: PluginContext["vm"],
  blockly?: any,
  workspace?: Blockly.WorkspaceSvg,
) =>
  React.Children.map(children, (child) => {
    if (typeof child === "string") {
      const nodes: React.ReactNode[] = [];
      let cursor = 0;
      child.replace(/\[\^([^\]]+)]/g, (match, id, offset) => {
        if (offset > cursor) {
          nodes.push(
            renderAssistantTextSegment(child.slice(cursor, offset), subAgents, tracker, vm, blockly, workspace),
          );
        }
        nodes.push(renderFootnoteReference(id, `footnote-ref-${offset}-${id}`, footnoteIdPrefix));
        cursor = offset + match.length;
        return match;
      });

      if (cursor < child.length) {
        nodes.push(renderAssistantTextSegment(child.slice(cursor), subAgents, tracker, vm, blockly, workspace));
      }

      return nodes;
    }
    return child;
  });

const isFootnotesSection = (props: Record<string, any>) =>
  String(props.className || "").split(/\s+/).includes("footnotes") || Object.prototype.hasOwnProperty.call(props, "data-footnotes");

const createMarkdownComponents = (
  subAgents: SubAgentProfile[],
  footnoteIdPrefix: string,
  footnoteTracker?: StreamingAnimationTracker,
  vm?: PluginContext["vm"],
  blockly?: any,
  workspace?: Blockly.WorkspaceSvg,
) => {
  const MentionContainer = (Tag: keyof JSX.IntrinsicElements) =>
    function MarkdownMentionContainer({ children, ...props }: any) {
      const activeTracker = React.useContext(StreamingAnimationContext);
      const nextProps = { ...props };
      if (nextProps.id) {
        nextProps.id = namespaceFootnoteId(footnoteIdPrefix, nextProps.id);
      }
      return React.createElement(
        Tag,
        nextProps,
        renderAssistantMarkdownChildren(children, subAgents, footnoteIdPrefix, activeTracker, vm, blockly, workspace),
      );
    };

  return {
    code: (props: any) => {
      const activeTracker = React.useContext(StreamingAnimationContext);
      return (
        <MarkdownCode
          {...props}
          streamingTracker={activeTracker}
          vm={vm}
          blockly={blockly}
        />
      );
    },
    pre: ({ children }: any) => <>{children}</>,
    section: ({ children, ...props }: any) => {
      const activeTracker = React.useContext(StreamingAnimationContext);
      if (activeTracker && footnoteTracker && isFootnotesSection(props)) {
        return (
          <StreamingAnimationContext.Provider value={footnoteTracker}>
            <section {...props}>{children}</section>
          </StreamingAnimationContext.Provider>
        );
      }
      return <section {...props}>{children}</section>;
    },
    a: ({ children, ...props }: any) => {
      const activeTracker = React.useContext(StreamingAnimationContext);
      const nextProps = {
        ...props,
        href: namespaceFootnoteHref(footnoteIdPrefix, props.href),
        id: namespaceFootnoteId(footnoteIdPrefix, props.id),
        "aria-describedby": namespaceFootnoteId(footnoteIdPrefix, props["aria-describedby"]),
      };
      return (
        <a {...nextProps}>
          {renderAssistantMarkdownChildren(children, subAgents, footnoteIdPrefix, activeTracker, vm, blockly, workspace)}
        </a>
      );
    },
    p: MentionContainer("p"),
    li: MentionContainer("li"),
    h1: MentionContainer("h1"),
    h2: MentionContainer("h2"),
    h3: MentionContainer("h3"),
    h4: MentionContainer("h4"),
    strong: MentionContainer("strong"),
    em: MentionContainer("em"),
    blockquote: MentionContainer("blockquote"),
    td: MentionContainer("td"),
    th: MentionContainer("th"),
  };
};

const useStreamingDisplayText = (
  content: string,
  isStreaming: boolean,
  streamKey?: string,
  resumeFromTailOnMount = false,
) => {
  const [displayText, setDisplayText] = React.useState(() =>
    isStreaming ? getResumeDisplayText(content, streamKey, resumeFromTailOnMount) : content,
  );
  const [isRevealSettling, setIsRevealSettling] = React.useState(false);
  const displayTextRef = React.useRef(displayText);
  const targetTextRef = React.useRef(content);
  const isStreamingRef = React.useRef(isStreaming);
  const timerRef = React.useRef<number | null>(null);
  const finishTimerRef = React.useRef<number | null>(null);

  const clearTimer = React.useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const clearFinishTimer = React.useCallback(() => {
    if (finishTimerRef.current !== null) {
      window.clearTimeout(finishTimerRef.current);
      finishTimerRef.current = null;
    }
  }, []);

  const commitDisplayText = React.useCallback((nextText: string) => {
    displayTextRef.current = nextText;
    setStreamingCache(streamKey, nextText);
    setDisplayText(nextText);
  }, [streamKey]);

  const scheduleRevealComplete = React.useCallback(() => {
    clearFinishTimer();
    if (isStreamingRef.current) return;

    finishTimerRef.current = window.setTimeout(() => {
      finishTimerRef.current = null;
      setIsRevealSettling(false);
    }, STREAM_REVEAL_ANIMATION_MS);
  }, [clearFinishTimer]);

  const scheduleReveal = React.useCallback(() => {
    clearTimer();
    if (displayTextRef.current.length >= targetTextRef.current.length) {
      scheduleRevealComplete();
      return;
    }

    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      const current = displayTextRef.current;
      const target = targetTextRef.current;
      if (!target.startsWith(current)) {
        commitDisplayText(target);
        scheduleRevealComplete();
        return;
      }

      const pendingUnits = splitStreamingRevealUnits(target.slice(current.length));
      const take = getStreamingRevealBatchSize(pendingUnits.length);
      const nextText = current + pendingUnits.slice(0, take).join("");
      commitDisplayText(nextText);
      if (nextText.length < target.length) {
        scheduleReveal();
      } else {
        scheduleRevealComplete();
      }
    }, STREAM_REVEAL_INTERVAL_MS);
  }, [clearTimer, commitDisplayText, scheduleRevealComplete]);

  React.useEffect(() => {
    isStreamingRef.current = isStreaming;
    targetTextRef.current = content;
    clearFinishTimer();

    if (!isStreaming && displayTextRef.current === content) {
      clearTimer();
      if (isRevealSettling) {
        scheduleRevealComplete();
      }
      return;
    }

    if (!content.startsWith(displayTextRef.current)) {
      if (!isStreaming) {
        clearTimer();
        commitDisplayText(content);
        setIsRevealSettling(false);
        return;
      }
      commitDisplayText(getResumeDisplayText(content, streamKey, resumeFromTailOnMount));
    }

    setIsRevealSettling(true);
    scheduleReveal();
    return () => {
      clearTimer();
      clearFinishTimer();
    };
  }, [
    clearFinishTimer,
    clearTimer,
    commitDisplayText,
    content,
    isRevealSettling,
    isStreaming,
    resumeFromTailOnMount,
    scheduleReveal,
    scheduleRevealComplete,
    streamKey,
  ]);

  return {
    displayText,
    shouldAnimateText: isStreaming || isRevealSettling,
  };
};

export const AssistantMarkdown = ({
  content,
  isStreaming,
  subAgents,
  streamKey,
  resumeFromTailOnMount,
  vm,
  blockly,
  workspace,
  onRequestOpenUrl,
}: {
  content: string;
  isStreaming: boolean;
  subAgents: SubAgentProfile[];
  streamKey?: string;
  resumeFromTailOnMount?: boolean;
  vm?: PluginContext["vm"];
  blockly?: any;
  workspace?: Blockly.WorkspaceSvg;
  onRequestOpenUrl?: (url: string, requiresConfirmation: boolean) => void;
}) => {
  const { displayText, shouldAnimateText } = useStreamingDisplayText(
    content,
    isStreaming,
    streamKey,
    resumeFromTailOnMount,
  );
  const instanceIdRef = React.useRef(0);
  if (!instanceIdRef.current) {
    assistantMarkdownInstanceCounter += 1;
    instanceIdRef.current = assistantMarkdownInstanceCounter;
  }
  const footnoteIdPrefix = React.useMemo(
    () => getSafeFootnotePrefix(streamKey, instanceIdRef.current),
    [streamKey],
  );
  const mainTrackerRef = React.useRef<StreamingAnimationTracker>({
    sequence: 0,
    states: new Map(),
    visited: new Set(),
    now: 0,
  });
  const footnoteTrackerRef = React.useRef<StreamingAnimationTracker>({
    sequence: 0,
    states: new Map(),
    visited: new Set(),
    now: 0,
  });
  const mainTracker = mainTrackerRef.current;
  const footnoteTracker = footnoteTrackerRef.current;
  const markdownComponents = React.useMemo(
    () => createMarkdownComponents(subAgents, footnoteIdPrefix, footnoteTracker, vm, blockly, workspace),
    [blockly, footnoteIdPrefix, footnoteTracker, subAgents, vm, workspace],
  );
  mainTracker.sequence = 0;
  mainTracker.visited = new Set();
  mainTracker.now = Date.now();
  footnoteTracker.sequence = 0;
  footnoteTracker.visited = new Set();
  footnoteTracker.now = mainTracker.now;
  const activeText = shouldAnimateText ? displayText : content;
  const activeComponents = markdownComponents;
  const highlightTimerRef = React.useRef<number | null>(null);
  const highlightedElementRef = React.useRef<HTMLElement | null>(null);

  const handleMarkdownLinkClick = React.useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement | null;
    const anchor = target?.closest?.("a") as HTMLAnchorElement | null;
    if (!anchor) return;

    const rawHref = anchor.getAttribute("href") || "";
    const isFootnoteAnchor =
      anchor.hasAttribute("data-footnote-ref") ||
      anchor.hasAttribute("data-footnote-backref") ||
      /^#.*user-content-fn/.test(rawHref);
    if (!isFootnoteAnchor) {
      if (!rawHref || rawHref.startsWith("#")) return;

      event.preventDefault();
      event.stopPropagation();

      let url: URL;
      try {
        url = new URL(rawHref, window.location.href);
      } catch (error) {
        console.warn("[AI Assistant] Invalid markdown link URL.", rawHref, error);
        return;
      }

      const supportedProtocol = url.protocol === "http:" || url.protocol === "https:" || url.protocol === "mailto:" || url.protocol === "tel:";
      if (!supportedProtocol) {
        console.warn("[AI Assistant] Blocked unsupported markdown link protocol.", url.href);
        return;
      }

      const requiresConfirmation = Boolean(url.hostname && !isSameSiteUrl(url));
      if (onRequestOpenUrl) {
        onRequestOpenUrl(url.href, requiresConfirmation);
      } else if (!requiresConfirmation) {
        openUrlInNewWindow(url.href);
      }
      return;
    }

    const targetId = rawHref.startsWith("#") ? window.decodeURIComponent(rawHref.slice(1)) : "";
    if (!targetId) return;

    if (highlightTimerRef.current !== null) {
      window.clearTimeout(highlightTimerRef.current);
      highlightTimerRef.current = null;
    }
    highlightedElementRef.current?.classList.remove(chat.footnoteJumpTargetHighlight);

    window.setTimeout(() => {
      const destination = document.getElementById(targetId);
      const highlightTarget = getFootnoteJumpHighlightTarget(destination);
      if (!highlightTarget) return;

      highlightedElementRef.current?.classList.remove(chat.footnoteJumpTargetHighlight);
      highlightedElementRef.current = highlightTarget;
      highlightTarget.classList.remove(chat.footnoteJumpTargetHighlight);
      void highlightTarget.offsetWidth;
      highlightTarget.classList.add(chat.footnoteJumpTargetHighlight);
      highlightTimerRef.current = window.setTimeout(() => {
        highlightTarget.classList.remove(chat.footnoteJumpTargetHighlight);
        if (highlightedElementRef.current === highlightTarget) {
          highlightedElementRef.current = null;
        }
        highlightTimerRef.current = null;
      }, 1400);
    }, 0);
  }, [onRequestOpenUrl]);

  React.useLayoutEffect(() => {
    if (shouldAnimateText) {
      mainTracker.states.forEach((_state, key) => {
        if (!mainTracker.visited.has(key)) {
          mainTracker.states.delete(key);
        }
      });
      footnoteTracker.states.forEach((_state, key) => {
        if (!footnoteTracker.visited.has(key)) {
          footnoteTracker.states.delete(key);
        }
      });
      return;
    }

    mainTracker.states.clear();
    footnoteTracker.states.clear();
  }, [activeText, footnoteTracker, mainTracker, shouldAnimateText]);

  React.useEffect(() => () => {
    if (highlightTimerRef.current !== null) {
      window.clearTimeout(highlightTimerRef.current);
    }
    highlightedElementRef.current?.classList.remove(chat.footnoteJumpTargetHighlight);
  }, []);

  return (
    <div className={chat.assistantMarkdownRoot} onClickCapture={handleMarkdownLinkClick}>
      <MarkdownSourceContext.Provider value={activeText}>
        <StreamingAnimationContext.Provider value={shouldAnimateText ? mainTracker : undefined}>
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={activeComponents}>
            {activeText}
          </ReactMarkdown>
        </StreamingAnimationContext.Provider>
      </MarkdownSourceContext.Provider>
    </div>
  );
};
