import { GuideCategory, UserGuide } from "./types";
import { GENERATED_BUILTIN_EXTENSION_GUIDES } from "./builtinExtensionGuides.generated";
import {
  APPROVED_EXTENSION_INDEX_GUIDE_TITLE,
  APPROVED_EXTENSION_INDEX_GUIDE_TOPIC,
  buildApprovedExtensionIndexGuideContent,
} from "./extensionIndexGuide";

export interface GuideToolDefinition {
  name: string;
  skillName: string;
  toolName: string;
  implementation: string;
}

export interface GuideSummary {
  id: string;
  name: string;
  title: string;
  content: string;
  description?: string;
  category: GuideCategory;
  source: "default" | "user" | "ai" | "extension";
  enabled: boolean;
  readOnly: boolean;
  extensionId?: string;
  extensionName?: string;
  tools: GuideToolDefinition[];
}

export interface GuideToolRuntimeContext {
  vm: any;
  workspace: any;
}

const BUILTIN_EXTENSION_GUIDES = [
  ...GENERATED_BUILTIN_EXTENSION_GUIDES,
];

const createDefaultGuide = (name: string, title: string, content: string, category: GuideCategory): GuideSummary => ({
  id: `default-${name}`,
  name,
  title,
  content,
  category,
  source: "default",
  enabled: true,
  readOnly: true,
  tools: [],
});

export const DEFAULT_GUIDES: GuideSummary[] = [
  createDefaultGuide(
    APPROVED_EXTENSION_INDEX_GUIDE_TOPIC,
    APPROVED_EXTENSION_INDEX_GUIDE_TITLE,
    buildApprovedExtensionIndexGuideContent(),
    "read",
  ),
  createDefaultGuide(
    "quickstart",
    "Scratch JS DSL quickstart",
    [
      "# Scratch JS DSL quickstart",
      "",
      "Patch feature files like `/stage/scripts/events.js` or `/<sprite>/scripts/movement.js` with `applyPatch`. Target assets live under `/<target>/custom` and `/<target>/audio`; reorder costumes via `/<target>/custom/order.json`.",
      "`/<target>/scripts/*.js` files are feature files. They may contain multiple `// @script <id>` sections, and each section must produce exactly one top-level script.",
      "Hat blocks use a trailing callback, for example `event.whenflagclicked({ $xy }, () => { ... })`.",
      "C-block bodies use `SUBSTACK` arrow functions.",
      "Menus, variables, and lists use `$field_` keys.",
      "Inside custom blocks, parameters are read with `argument.reporter_string_number` or `argument.reporter_boolean`, not `data.variable`.",
    ].join("\n"),
    "read",
  ),
  createDefaultGuide(
    "events",
    "Events and hats",
    [
      "# Events and hats",
      "",
      "Use event hat blocks as top-level scripts with `$xy` positions.",
      "",
      "```js",
      'event.whenflagclicked({ $xy: { x: 80, y: 80 } }, () => { looks.say({ MESSAGE: "start" }); });',
      'event.whenkeypressed({ $field_KEY_OPTION: "space", $xy: { x: 80, y: 220 } }, () => { event.broadcast({ BROADCAST_INPUT: "step" }); });',
      'event.whenbroadcastreceived({ $field_BROADCAST_OPTION: "step", $xy: { x: 80, y: 360 } }, () => { looks.say({ MESSAGE: "step" }); });',
      "control.start_as_clone({ $xy: { x: 80, y: 500 } }, () => { looks.show(); });",
      "```",
    ].join("\n"),
    "read",
  ),
  createDefaultGuide(
    "data",
    "Variables and lists",
    [
      "# Variables and lists",
      "",
      "Always use `$field_VARIABLE` and `$field_LIST` selectors.",
      'Read variables with `data.variable({ $field_VARIABLE: "name" })`.',
      'Read list items with `data.itemoflist({ $field_LIST: "numbers", INDEX: ... })`.',
      "",
      "```js",
      'data.setvariableto({ $field_VARIABLE: "i", VALUE: 1 });',
      'data.changevariableby({ $field_VARIABLE: "i", VALUE: 1 });',
      'data.deletealloflist({ $field_LIST: "numbers" });',
      "```",
    ].join("\n"),
    "read",
  ),
  createDefaultGuide(
    "procedures",
    "Custom blocks / functions",
    [
      "# Custom blocks / functions",
      "",
      "Use custom blocks for reusable logic, render helpers, math helpers, list algorithms, and operations that need parameters.",
      'Use `info: ["warp"]` for helpers that should run without screen refresh.',
      "Inside `define(...)`, read parameters with `argument.reporter_string_number` / `argument.reporter_boolean` and `$field_VALUE`.",
    ].join("\n"),
    "edit",
  ),
  createDefaultGuide(
    "custom-args",
    "Custom block parameters",
    [
      "# Custom block parameters",
      "",
      "Define named parameters with placeholders like `%n[highlight]` or `%b[enabled]`.",
      "The call proccode uses placeholder shapes without names, e.g. `draw frame %n` and `$args: [1]`.",
    ].join("\n"),
    "edit",
  ),
  createDefaultGuide(
    "dynamic-blocks",
    "Dynamic extension blocks",
    [
      "# Dynamic extension blocks",
      "",
      "Write dynamic inputs with `$dynamicArgs: [...]`.",
      "Put `$dynamicArgs` items in the same order they should appear in the block.",
      "Each item can be a literal value or a reporter block.",
      "For key/value object blocks, write key and value items in order, for example `[\"name\", \"Alex\", \"age\", 12]`.",
      "Use `$dynamicArgTypes` only when an item needs a non-default input shape: `s` for text, `n` for number, `b` for Boolean.",
      "After editing a script with dynamic inputs, run diagnostics on that script.",
      "",
      "```js",
      'moreDataTypes.getNewObject({ $dynamicArgs: ["name", "Alex", "age", 12] });',
      'moreDataTypes.getNewList({ $dynamicArgs: ["apple", "banana"] });',
      'someExtension.dynamicBlock({ $dynamicArgs: [operator.add({ NUM1: 1, NUM2: 2 })], $dynamicArgTypes: ["n"] });',
      "```",
    ].join("\n"),
    "edit",
  ),
  createDefaultGuide(
    "rendering",
    "Fast pen rendering pattern",
    [
      "# Fast pen rendering pattern",
      "",
      "For charts, games, and visualizations, prefer one broadcast/event to trigger rendering, then call one warp custom block to draw the full frame.",
      "Pass highlights, colors, offsets, scale, and list length through custom block arguments.",
    ].join("\n"),
    "edit",
  ),
  createDefaultGuide(
    "menus",
    "Menu / dropdown fields",
    [
      "# Menu / dropdown fields",
      "",
      "Dropdowns, variables, lists, keys, broadcasts, and pen `COLOR_PARAM` use `$field_` keys.",
      "If a block has a menu field, do not omit it.",
      "Pen `COLOR_PARAM` values are `color`, `saturation`, `brightness`, and `transparency`.",
    ].join("\n"),
    "read",
  ),
  createDefaultGuide(
    "pen",
    "Pen drawing",
    [
      "# Pen drawing",
      "",
      "Use `pen.setPenColorToColor` for hex colors.",
      "Use `pen.setPenColorParamTo` / `pen.changePenColorParamBy` for hue, brightness, saturation, and transparency numbers.",
      "`COLOR_PARAM` is a menu field and must be written as `$field_COLOR_PARAM`.",
    ].join("\n"),
    "edit",
  ),
  createDefaultGuide(
    "patching",
    "Patch workflow",
    [
      "# Patch workflow",
      "",
      "For a new empty file, full replacement after `*** Update File` is safest.",
      "For existing generated scripts, readFile the specific `/<target>/scripts/*.js` file first.",
      "Patch one script at a time, then call `getDiagnostics`.",
    ].join("\n"),
    "read",
  ),
  createDefaultGuide(
    "debugging",
    "Diagnostics-first debugging",
    [
      "# Diagnostics-first debugging",
      "",
      "After every `applyPatch`, call `getDiagnostics` on changed files.",
      "If block help lookup fails, call `searchBlocks` with the natural name.",
      "Missing menu fields, custom-argument-as-variable mistakes, non-Boolean conditions, and bad pen colors are reported before Scratch blocks are changed.",
    ].join("\n"),
    "read",
  ),
];

export const normalizeGuideName = (value: string) =>
  value
    .trim()
    .replace(/\.md$/i, "")
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "guide";

const normalizeExtensionIdForGuide = (value: string) => String(value || "").replace(/^ext_/, "").replace(/\.zip$/i, "");

const getRuntimeExtensionEntries = (runtime: any) => {
  const entries = new Map<string, { id: string; name: string }>();
  const blockInfoList = Array.isArray(runtime?._blockInfo) ? runtime._blockInfo : [];

  for (const extInfo of blockInfoList) {
    const id = String(extInfo?.id || "").trim();
    if (!id) continue;
    entries.set(id, { id, name: String(extInfo?.name || id) });
  }

  if (runtime && typeof runtime === "object") {
    for (const key of Object.keys(runtime)) {
      if (!key.startsWith("ext_")) continue;
      const id = key.slice(4);
      if (!id) continue;
      const existing = entries.get(id);
      const runtimeExtension = runtime[key];
      entries.set(id, {
        id,
        name: existing?.name || String(runtimeExtension?.getInfo?.()?.name || id),
      });
    }
  }

  return Array.from(entries.values());
};

export const getExtensionAiAssistant = (runtime: any, extensionId: string) => {
  const id = String(extensionId || "").trim();
  if (!runtime || !id) return null;
  const normalizedId = id.replace(/^ext_/, "");
  const candidates = Array.from(new Set([`ext_${id}`, `ext_${normalizedId}`, id]));
  const extensionCandidates = new Set<any>();

  for (const key of candidates) {
    extensionCandidates.add(runtime?.[key]);
    extensionCandidates.add(runtime?.ext?.[key]);
    extensionCandidates.add(runtime?.ext?.[key.replace(/^ext_/, "")]);
    extensionCandidates.add(runtime?.peripheralExtensions?.[key]);
    extensionCandidates.add(runtime?.peripheralExtensions?.[key.replace(/^ext_/, "")]);
  }

  for (const extensionInstance of extensionCandidates) {
    if (!extensionInstance || typeof extensionInstance !== "object") continue;
    const infoAiAssistant =
      typeof extensionInstance.getInfo === "function" ? extensionInstance.getInfo()?.aiAssistant : null;
    const value = extensionInstance.aiAssistant || infoAiAssistant;
    if (value && typeof value === "object") {
      return { aiAssistant: value as Record<string, any>, extensionInstance };
    }
  }

  return null;
};

const findRuntimeExtensionEntry = (extensions: Array<{ id: string; name: string }>, aliases: string[]) => {
  const normalizedAliases = new Set(aliases.map(normalizeExtensionIdForGuide));
  return extensions.find((extension) => normalizedAliases.has(normalizeExtensionIdForGuide(extension.id)));
};

const createBuiltinExtensionGuideSummary = (
  builtinGuide: (typeof BUILTIN_EXTENSION_GUIDES)[number],
  extensionName?: string,
): GuideSummary | null => {
  if (!builtinGuide.content.trim()) return null;
  const name = normalizeGuideName(`extension-${builtinGuide.extensionId}`);
  return {
    id: `extension-guide-${normalizeGuideName(builtinGuide.extensionId)}`,
    name,
    title: builtinGuide.title || `${extensionName || builtinGuide.extensionId} 扩展指南`,
    content: builtinGuide.content,
    category: "edit" as GuideCategory,
    source: "extension" as const,
    enabled: true,
    readOnly: true,
    extensionId: builtinGuide.extensionId,
    extensionName: extensionName || builtinGuide.extensionId,
    tools: [],
  };
};

const getExtensionGuideContent = (aiAssistant: Record<string, any>) => {
  const value =
    aiAssistant.docx ??
    aiAssistant.docs ??
    aiAssistant.doc ??
    aiAssistant.guide ??
    aiAssistant.content ??
    aiAssistant.markdown;
  return typeof value === "string" ? value : "";
};

const getExtensionGuideTitle = (aiAssistant: Record<string, any>, extensionName: string) =>
  typeof aiAssistant.title === "string" && aiAssistant.title.trim()
    ? aiAssistant.title.trim()
    : `${extensionName} 扩展指南`;

const extractExtensionGuideTools = (skillName: string, toolsSource: unknown): GuideToolDefinition[] => {
  if (!toolsSource || typeof toolsSource !== "object") return [];

  return Object.entries(toolsSource as Record<string, unknown>)
    .filter(([toolName, value]) => Boolean(toolName) && !toolName.includes(".") && typeof value === "function")
    .map(([toolName, value]) => ({
      name: `${skillName}.${toolName}`,
      skillName,
      toolName,
      implementation: String(value),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
};

export const getRuntimeExtensionGuideSignature = (runtime: any) =>
  getRuntimeExtensionGuides(runtime)
    .map(
      (guide) =>
        `${guide.extensionId}:${guide.title}:${guide.content.length}:${guide.tools.map((tool) => tool.name).join(",")}`,
    )
    .join("|");

export const getRuntimeExtensionGuides = (runtime: any): GuideSummary[] => {
  const runtimeExtensionEntries = getRuntimeExtensionEntries(runtime);
  const guides = runtimeExtensionEntries
    .map((extension) => {
      const aiAssistantEntry = getExtensionAiAssistant(runtime, extension.id);
      if (!aiAssistantEntry) return null;
      const { aiAssistant } = aiAssistantEntry;
      const name = normalizeGuideName(`extension-${extension.id}`);
      const content = getExtensionGuideContent(aiAssistant);
      const tools = extractExtensionGuideTools(name, aiAssistant.tools);
      if (!content.trim() && tools.length === 0) return null;

      return {
        id: `extension-guide-${normalizeGuideName(extension.id)}`,
        name,
        title: getExtensionGuideTitle(aiAssistant, extension.name),
        content,
        category: "edit" as GuideCategory,
        source: "extension" as const,
        enabled: true,
        readOnly: true,
        extensionId: extension.id,
        extensionName: extension.name,
        tools,
      };
    })
    .filter(Boolean) as GuideSummary[];

  for (const builtinGuide of BUILTIN_EXTENSION_GUIDES) {
    const extensionEntry = findRuntimeExtensionEntry(runtimeExtensionEntries, builtinGuide.extensionIdAliases);
    if (!extensionEntry) continue;
    const normalizedBuiltinId = normalizeExtensionIdForGuide(builtinGuide.extensionId);
    if (guides.some((guide) => normalizeExtensionIdForGuide(guide.extensionId || "") === normalizedBuiltinId)) continue;
    const summary = createBuiltinExtensionGuideSummary(builtinGuide, extensionEntry.name || builtinGuide.extensionId);
    if (summary) {
      guides.push(summary);
      continue;
    }
    const name = normalizeGuideName(`extension-${builtinGuide.extensionId}`);
    if (!builtinGuide.content.trim()) continue;
    guides.push({
      id: `extension-guide-${normalizeGuideName(builtinGuide.extensionId)}`,
      name,
      title: builtinGuide.title || `${extensionEntry?.name || builtinGuide.extensionId} 扩展指南`,
      content: builtinGuide.content,
      category: "edit" as GuideCategory,
      source: "extension" as const,
      enabled: true,
      readOnly: true,
      extensionId: builtinGuide.extensionId,
      extensionName: extensionEntry.name || builtinGuide.extensionId,
      tools: [],
    });
  }

  return guides;
};

export const getBuiltinExtensionGuides = (): GuideSummary[] =>
  BUILTIN_EXTENSION_GUIDES.map((builtinGuide) => createBuiltinExtensionGuideSummary(builtinGuide, builtinGuide.title))
    .filter(Boolean) as GuideSummary[];

export const getAiReadableExtensionGuides = (runtime: any): GuideSummary[] => {
  const runtimeGuides = getRuntimeExtensionGuides(runtime);
  const result = [...runtimeGuides];
  const existingExtensionIds = new Set(
    runtimeGuides.map((guide) => normalizeExtensionIdForGuide(guide.extensionId || "")).filter(Boolean),
  );

  for (const guide of getBuiltinExtensionGuides()) {
    const normalizedExtensionId = normalizeExtensionIdForGuide(guide.extensionId || "");
    if (normalizedExtensionId && existingExtensionIds.has(normalizedExtensionId)) continue;
    result.push(guide);
    if (normalizedExtensionId) existingExtensionIds.add(normalizedExtensionId);
  }

  return result;
};

export const createUserGuideId = () => `guide-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

export const normalizeUserGuide = (guide: UserGuide): UserGuide => {
  const name = normalizeGuideName(guide.name || guide.title || "guide");
  const createdBy = guide.createdBy === "ai" || guide.category === "ai" ? "ai" : "user";
  return {
    id: guide.id || createUserGuideId(),
    name,
    title: guide.title?.trim() || name,
    content: guide.content || "",
    description: guide.description?.trim() || "",
    category: createdBy === "ai" ? "ai" : guide.category || "read",
    createdBy,
    enabled: guide.enabled !== false,
    createdAt: guide.createdAt || Date.now(),
    updatedAt: Date.now(),
    indexJs: guide.indexJs,
  };
};

export const getAllGuides = (userGuides: UserGuide[] = [], extensionGuides: GuideSummary[] = []): GuideSummary[] => [
  ...DEFAULT_GUIDES,
  ...userGuides.map((guide) => {
    const name = normalizeGuideName(guide.name);
    const isAiGuide = guide.createdBy === "ai" || guide.category === "ai";
    return {
      id: guide.id,
      name,
      title: guide.title || name,
      content: guide.content || "",
      description: guide.description || "",
      category: guide.category || "read",
      source: isAiGuide ? ("ai" as const) : ("user" as const),
      enabled: guide.enabled !== false,
      readOnly: isAiGuide,
      tools: extractGuideTools(name, guide.indexJs),
    };
  }),
  ...extensionGuides.map((guide) => ({
    ...guide,
    source: "extension" as const,
    enabled: true,
    readOnly: true,
  })),
];

export const extractGuideTools = (skillName: string, indexJs?: string): GuideToolDefinition[] => {
  if (!indexJs?.trim()) return [];
  const tools = new Map<string, GuideToolDefinition>();
  const runtimeSource = normalizeGuideIndexJsForRuntime(indexJs);
  const patterns = [
    /(?:let|const|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>\s*\{/g,
    /(?:let|const|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?function\s*\([^)]*\)\s*\{/g,
    /function\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/g,
    /exports\.([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\s*)?\(?/g,
    /module\.exports\.([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\s*)?\(?/g,
  ];

  patterns.forEach((pattern) => {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(runtimeSource))) {
      const toolName = match[1];
      if (!toolName || toolName === "default") continue;
      tools.set(toolName, {
        name: `${skillName}.${toolName}`,
        skillName,
        toolName,
        implementation: extractFunctionSnippet(runtimeSource, match.index),
      });
    }
  });

  extractObjectGuideTools(runtimeSource).forEach((tool) => {
    if (tools.has(tool.toolName)) return;
    tools.set(tool.toolName, {
      name: `${skillName}.${tool.toolName}`,
      skillName,
      toolName: tool.toolName,
      implementation: tool.implementation,
    });
  });

  return Array.from(tools.values()).sort((a, b) => a.name.localeCompare(b.name));
};

const normalizeGuideIndexJsForRuntime = (source: string) =>
  source
    .replace(/\bexport\s+default\s+/g, "module.exports = ")
    .replace(/\bexport\s+(async\s+function\s+[A-Za-z_$][\w$]*\s*\()/g, "$1")
    .replace(/\bexport\s+(function\s+[A-Za-z_$][\w$]*\s*\()/g, "$1")
    .replace(/\bexport\s+(const|let|var)\s+/g, "$1 ");

const findMatchingBrace = (source: string, openIndex: number) => {
  let depth = 0;
  let quote: string | null = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let index = openIndex; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];

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
      if (char === quote) {
        quote = null;
      }
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
    if (char === "\"" || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "{") {
      depth += 1;
      continue;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }

  return -1;
};

const extractObjectGuideTools = (source: string) => {
  const results: Array<{ toolName: string; implementation: string }> = [];
  const toolsMatch = /\btools\s*:\s*\{/.exec(source);
  if (!toolsMatch) return results;

  const toolsOpenIndex = source.indexOf("{", toolsMatch.index);
  const toolsCloseIndex = findMatchingBrace(source, toolsOpenIndex);
  if (toolsOpenIndex < 0 || toolsCloseIndex < 0) return results;

  const toolsSource = source.slice(toolsOpenIndex + 1, toolsCloseIndex);
  const propertyPattern = /(?:^|,)\s*([A-Za-z_$][\w$]*)\s*:\s*\{/g;
  let match: RegExpExecArray | null;
  while ((match = propertyPattern.exec(toolsSource))) {
    const toolName = match[1];
    if (!toolName) continue;
    const relativeOpen = toolsSource.indexOf("{", match.index);
    const relativeClose = findMatchingBrace(toolsSource, relativeOpen);
    if (relativeOpen < 0 || relativeClose < 0) continue;
    const implementation = `${toolName}: ${toolsSource.slice(relativeOpen, relativeClose + 1)}`;
    if (/\bexecute\s*(?:[:(]|=\s*)/.test(implementation)) {
      results.push({ toolName, implementation });
    }
    propertyPattern.lastIndex = relativeClose + 1;
  }

  return results;
};

const extractFunctionSnippet = (source: string, start: number) => {
  const lineStart = source.lastIndexOf("\n", start) + 1;
  const braceStart = findFunctionBodyOpenBrace(source, start);
  if (braceStart < 0) return source.slice(lineStart, Math.min(source.length, lineStart + 300));
  const braceEnd = findMatchingBrace(source, braceStart);
  if (braceEnd >= 0) {
    return source.slice(lineStart, Math.min(source.length, braceEnd + 1));
  }
  return source.slice(lineStart, Math.min(source.length, lineStart + 800));
};

const findFunctionBodyOpenBrace = (source: string, start: number) => {
  let quote: string | null = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  let parenDepth = 0;

  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];

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
      if (char === quote) {
        quote = null;
      }
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
    if (char === "\"" || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "(" || char === "[" ) {
      parenDepth += 1;
      continue;
    }
    if ((char === ")" || char === "]") && parenDepth > 0) {
      parenDepth -= 1;
      continue;
    }
    if (char === "{" && parenDepth === 0) {
      return index;
    }
  }

  return -1;
};

export const getEnabledGuideSystemText = (userGuides: UserGuide[] = [], extensionGuides: GuideSummary[] = []) => {
  const enabledGuides = getAllGuides(userGuides, extensionGuides).filter((guide) => guide.enabled);
  const formatGuide = (guide: GuideSummary) =>
    `- ${guide.name}: ${guide.title}${guide.tools.length ? `; tools: ${guide.tools.map((tool) => tool.name).join(", ")}` : ""}`;
  const defaultTopics = DEFAULT_GUIDES.map((guide) => guide.name).join(", ");
  const aiGuideIndex = userGuides
    .filter((guide) => guide.createdBy === "ai" || guide.category === "ai")
    .map((guide) => {
      const name = normalizeGuideName(guide.name || guide.title || "guide");
      const description = guide.description?.trim() || guide.title?.trim() || "No description provided.";
      return `- ${name}: ${description}`;
    })
    .join("\n");
  const externalGuides = enabledGuides.filter(
    (guide) => guide.source === "user" || guide.source === "ai" || guide.source === "extension",
  );
  const externalGuideList = externalGuides.map(formatGuide).join("\n");

  const toolGuidance = enabledGuides.flatMap((guide) => guide.tools.map((tool) => tool.name));

  return [
    `Guides: getScratchGuide topics: ${defaultTopics}; plus enabled user/AI/extension guides by name.`,
    aiGuideIndex ? `AI-created guide index:\n${aiGuideIndex}` : "AI-created guide index: none.",
    externalGuideList ? `External guides:\n${externalGuideList}` : "External guides: none.",
    toolGuidance.length
      ? `Guide tools via runGuideTool: ${toolGuidance.slice(0, 5).join(", ")}.`
      : "Guide tools: none.",
  ].join("\n");
};

export const findGuide = (userGuides: UserGuide[], topic?: string, extensionGuides: GuideSummary[] = []) => {
  const requestedTopic = normalizeGuideName(String(topic || "quickstart").toLowerCase());
  const aliases: Record<string, string> = {
    procedure: "procedures",
    function: "procedures",
    functions: "procedures",
    "custom-block": "procedures",
    "custom-blocks": "procedures",
    custom: "procedures",
    args: "custom-args",
    argument: "custom-args",
    arguments: "custom-args",
    parameter: "custom-args",
    parameters: "custom-args",
    params: "custom-args",
    dynamic: "dynamic-blocks",
    dynamics: "dynamic-blocks",
    "dynamic-block": "dynamic-blocks",
    "dynamic-blocks": "dynamic-blocks",
    "dynamic-arg": "dynamic-blocks",
    "dynamic-args": "dynamic-blocks",
    "dynamic-input": "dynamic-blocks",
    "dynamic-inputs": "dynamic-blocks",
    menu: "menus",
    dropdown: "menus",
    fields: "menus",
    debug: "debugging",
    diagnostics: "debugging",
    render: "rendering",
    drawing: "rendering",
    draw: "rendering",
    extension: "extension-index",
    extensions: "extension-index",
    "extension-index": "extension-index",
    "approved-extension": "extension-index",
    "approved-extensions": "extension-index",
    "extension-list": "extension-index",
  };
  const normalizedTopic = aliases[requestedTopic] || requestedTopic;
  const guides = getAllGuides(userGuides, extensionGuides).filter(
    (guide) => guide.enabled || guide.source === "default" || guide.readOnly,
  );
  const guide =
    guides.find((item) => {
      const guideName = normalizeGuideName(item.name).toLowerCase();
      const extensionId = normalizeGuideName(item.extensionId || "").toLowerCase();
      const extensionName = normalizeGuideName(item.extensionName || "").toLowerCase();
      const title = normalizeGuideName(item.title || "").toLowerCase();
      return (
        guideName === normalizedTopic ||
        (item.source === "extension" &&
          (extensionId === normalizedTopic || extensionName === normalizedTopic || title === normalizedTopic))
      );
    }) || guides[0];
  return { guide, topic: guide?.name || "quickstart", availableTopics: guides.map((item) => item.name) };
};

export const executeGuideTool = async (
  userGuides: UserGuide[],
  fullName: string,
  args: Record<string, unknown>,
  context: GuideToolRuntimeContext,
) => {
  const [skillName, toolName] = fullName.split(".");
  if (!skillName || !toolName) {
    return { success: false, error: "Guide tool name must use skillName.toolName format." };
  }

  const normalizedSkillName = normalizeGuideName(skillName);
  const guide = userGuides.find(
    (item) => item.enabled !== false && normalizeGuideName(item.name) === normalizedSkillName && item.indexJs?.trim(),
  );

  if (guide) {
    const availableTools = extractGuideTools(normalizeGuideName(guide.name), guide.indexJs);
    if (!availableTools.some((tool) => tool.toolName === toolName)) {
      return {
        success: false,
        error: `Guide tool not found: ${fullName}`,
        availableTools: availableTools.map((tool) => tool.name),
      };
    }

    try {
      const module = { exports: {} as Record<string, unknown> };
      const exports = module.exports;
      const availableToolNames = availableTools.map((tool) => tool.toolName);
      const factory = new Function(
        "module",
        "exports",
        "vm",
        "workspace",
        `${normalizeGuideIndexJsForRuntime(guide.indexJs || "")}
const exported = { ...module.exports, ...exports };
${availableToolNames.map((name) => `try { if (typeof ${name} === "function") exported[${JSON.stringify(name)}] = ${name}; } catch {}`).join("\n")}
const guideToolObjects = (exported.default && exported.default.tools) || exported.tools || {};
Object.entries(guideToolObjects).forEach(([key, value]) => {
  if (typeof value === "function") {
    exported[key] = value;
    return;
  }
  if (value && typeof value.execute === "function") {
    exported[key] = value.execute.bind(value);
  }
});
return exported;`,
      );
      const exported = factory(module, exports, context.vm, context.workspace) as Record<string, unknown>;
      const fn = exported[toolName];
      if (typeof fn !== "function") {
        return { success: false, error: `Guide tool is not callable: ${fullName}` };
      }
      const result = await (fn as (input: Record<string, unknown>) => unknown)(args || {});
      return { success: true, tool: fullName, source: "user", result };
    } catch (error) {
      return {
        success: false,
        tool: fullName,
        source: "user",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  const extensionGuide = getRuntimeExtensionGuides(context.vm?.runtime).find(
    (item) => normalizeGuideName(item.name) === normalizedSkillName,
  );
  if (extensionGuide?.extensionId) {
    const aiAssistantEntry = getExtensionAiAssistant(context.vm?.runtime, extensionGuide.extensionId);
    const fn = aiAssistantEntry?.aiAssistant?.tools?.[toolName];
    if (typeof fn !== "function") {
      return {
        success: false,
        error: `Extension guide tool not found: ${fullName}`,
        availableTools: extensionGuide.tools.map((tool) => tool.name),
      };
    }

    try {
      const result = await fn.call(aiAssistantEntry?.extensionInstance, args || {}, context);
      return {
        success: true,
        tool: fullName,
        source: "extension",
        extensionId: extensionGuide.extensionId,
        extensionName: extensionGuide.extensionName,
        result,
      };
    } catch (error) {
      return {
        success: false,
        tool: fullName,
        source: "extension",
        extensionId: extensionGuide.extensionId,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  const availableTools = [
    ...userGuides.flatMap((item) =>
      extractGuideTools(normalizeGuideName(item.name), item.indexJs).map((tool) => tool.name),
    ),
    ...getRuntimeExtensionGuides(context.vm?.runtime).flatMap((item) => item.tools.map((tool) => tool.name)),
  ];

  return { success: false, error: `Guide skill not found or disabled: ${skillName}`, availableTools };
};
