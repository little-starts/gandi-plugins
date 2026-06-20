import * as React from "react";
import toolStyles from "../ui/ToolCalls.module.less";
import { ChatMessage, ToolCall } from "../types";
import ChevronRightIcon from "../assets/icon-chevron-right.svg";
import { scratchToolSchemas } from "../toolSchemas";
import { renderDslPreview } from "./AssistantMarkdown";
import { ExtensionLoadButton } from "./ExtensionLoadButton";
import { AI_ASSISTANT_EXTENSIONS_LOADED_EVENT } from "../extensionLoadUtils";

interface ToolCallViewerProps {
  toolCalls: ToolCall[];
  toolResults?: ChatMessage[];
  isGenerating?: boolean;
  vm?: PluginContext["vm"];
  blockly?: any;
}

type ToolCallStatus = "running" | "success" | "error" | "terminated";
type DiffLineKind = "add" | "delete" | "context" | "meta";

interface DiffLine {
  kind: DiffLineKind;
  text: string;
  oldLine?: number;
  newLine?: number;
}

interface DiffFile {
  path: string;
  added: number;
  deleted: number;
  lines: DiffLine[];
  truncated: boolean;
}

interface ToolEntry {
  id: string;
  name: string;
  args?: any;
  rawArguments: string;
  result?: any;
  stageObservation?: ChatMessage["stageObservation"];
  stageObservations?: ChatMessage["stageObservations"];
  rawResult: string;
  status: ToolCallStatus;
  summary: string;
}

const MAX_DIFF_LINES = 180;
const MAX_EAGER_JSON_PARSE_CHARS = 30000;

const safeParseJson = (value: string, maxLength = Number.POSITIVE_INFINITY) => {
  if (!value) return undefined;
  if (value.length > maxLength) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
};

const tryFormatJson = (value: string) => {
  if (!value) return "";
  const parsed = safeParseJson(value);
  return parsed === undefined ? value : JSON.stringify(parsed, null, 2);
};

const getLazyToolEntryData = (entry: ToolEntry) => {
  const args = entry.args ?? safeParseJson(entry.rawArguments) ?? {};
  const result = entry.result ?? safeParseJson(entry.rawResult);
  return {
    args,
    result,
    formattedArguments: tryFormatJson(entry.rawArguments),
    formattedResult: tryFormatJson(entry.rawResult),
  };
};

const getPreviewToolEntryData = (entry: ToolEntry) => ({
  args: entry.args ?? safeParseJson(entry.rawArguments, MAX_EAGER_JSON_PARSE_CHARS) ?? {},
  result: entry.result ?? safeParseJson(entry.rawResult, MAX_EAGER_JSON_PARSE_CHARS),
});

const stringifyCompact = (value: unknown) => {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const getToolCallStatus = (result?: ChatMessage): ToolCallStatus => {
  if (!result || !result.content.trim()) return "running";
  if (result.content.startsWith("Error:")) return "error";

  const parsed = safeParseJson(result.content, MAX_EAGER_JSON_PARSE_CHARS);
  if (!parsed && result.content.length > MAX_EAGER_JSON_PARSE_CHARS) return "success";
  if (parsed && typeof parsed === "object" && (parsed.terminated || parsed.cancelled)) {
    return "terminated";
  }
  if (parsed && typeof parsed === "object" && "success" in parsed) {
    return parsed.success ? "success" : "error";
  }

  return "success";
};

const asArray = (value: any) => (Array.isArray(value) ? value : []);

const MEMORY_TOOL_NAMES = new Set([
  "listMemoryBlocks",
  "getMemoryBlock",
  "setMemoryBlock",
  "replaceMemoryBlockText",
  "deleteMemoryBlock",
]);

const isMemoryTool = (name: string) => MEMORY_TOOL_NAMES.has(name);

const getMemoryScopeLabel = (scope?: string) => (scope === "project" ? "项目记忆" : "长期记忆");

const getToolSummary = (name: string, args: any, result: any, status: ToolCallStatus) => {
  if (status === "running") return "正在执行";
  if (status === "terminated") return "已终止";
  if (status === "error") {
    return result?.error || result?.message || "执行失败";
  }

  switch (name) {
    case "updateTodoList":
      return `更新 ${asArray(args?.todos).length} 个任务`;
    case "askUser":
      return args?.question || asArray(args?.questions)[0]?.question || "等待用户确认";
    case "listMemoryBlocks":
      return `查看${args?.scope ? getMemoryScopeLabel(args.scope) : "全部记忆"}`;
    case "getMemoryBlock":
      return `读取记忆 ${args?.id || ""}`.trim();
    case "setMemoryBlock":
      return `${args?.id ? "更新" : "新增"}${getMemoryScopeLabel(args?.scope)}${args?.description ? ` · ${args.description}` : ""}`;
    case "replaceMemoryBlockText":
      return `替换记忆内容 ${args?.id || ""}`.trim();
    case "deleteMemoryBlock":
      return `删除记忆 ${args?.id || ""}`.trim();
    case "applyPatch": {
      const files = asArray(result?.changedFiles);
      const operationCount = Number(result?.operationCount ?? result?.scriptOperationCount ?? 0);
      if (files.length > 0) {
        return `已同步 ${files.length} 个文件，${operationCount} 个操作`;
      }
      return "补丁已应用";
    }
    case "getDiagnostics":
      return result?.valid ? "诊断通过" : "发现诊断问题";
    case "runSubAgent":
      return result?.success
        ? `${result?.name || args?.name || "子AI"} 已完成`
        : result?.error || result?.summary || "子任务执行失败";
    case "readFile":
      return `${result?.path || args?.path || "文件"} · ${result?.startLine || 1}-${result?.endLine || result?.totalLines || "?"} 行`;
    case "searchFiles":
    case "searchBlocks":
      return `找到 ${result?.matchCount ?? asArray(result?.matches).length ?? 0} 条结果`;
    case "getBlocksHelp": {
      const blocks = asArray(result?.blocks);
      return result?.success
        ? `${blocks.length || asArray(args?.opcodes).length} 个积木用法已读取`
        : result?.error || "积木帮助读取失败";
    }
    case "getScratchGuide":
      return `${result?.title || result?.topic || args?.topic || "指南"} 已读取`;
    case "runGuideTool":
      return result?.success
        ? `${args?.name || "指南工具"} 已执行`
        : result?.error || `${args?.name || "指南工具"} 执行失败`;
    case "createAiGuide":
      return result?.success
        ? `已创建指南 ${result?.title || result?.name || args?.title || args?.name || ""}`.trim()
        : result?.error || "创建指南失败";
    case "insertCostume":
      return result?.success
        ? `已新增造型 ${result?.costumeName || args?.costumeName || ""}`.trim()
        : result?.error || "新增造型失败";
    case "updateCostume":
      return result?.success
        ? `已更新造型 ${result?.costumeName || args?.costumeName || ""}`.trim()
        : result?.error || "更新造型失败";
    case "deleteCostume":
      return result?.success
        ? `已删除造型 ${result?.deletedCostumeName || args?.costumeName || ""}`.trim()
        : result?.error || "删除造型失败";
    case "getProjectOverview":
      return `项目概览 · ${asArray(result?.files).length} 个文件`;
    case "listFiles":
      return `列出 ${Array.isArray(result) ? result.length : asArray(result?.files).length} 个文件`;
    case "discardDraft":
      return result?.success
        ? `已丢弃草稿 ${result?.path || args?.path || ""}`.trim()
        : result?.error || "丢弃草稿失败";
    case "getAllExtensions":
      return `发现 ${Array.isArray(result) ? result.length : asArray(result?.extensions).length} 个扩展`;
    case "searchExtensions":
      return `找到 ${asArray(result?.extensions).length} 个可用扩展`;
    case "addExtension":
      return result?.success
        ? `${result?.alreadyLoaded ? "扩展已加载" : "已添加扩展"} ${result?.name || result?.extensionId || args?.extensionId || ""}`.trim()
        : result?.error || `添加扩展失败 ${args?.extensionId || ""}`.trim();
    case "getExtensionBlocks":
      return status === "success"
        ? `${result?.extensionName || result?.extensionId || args?.extensionId || "扩展"} 积木已读取`
        : result?.error || "扩展积木读取失败";
    default:
      return "执行完成";
  }
};

const buildEntries = (toolCalls: ToolCall[], toolResults: ChatMessage[]): ToolEntry[] =>
  toolCalls.map((toolCall) => {
    const resultMessage = toolResults.find((item) => item.tool_call_id === toolCall.id);
    const args = safeParseJson(toolCall.function.arguments, MAX_EAGER_JSON_PARSE_CHARS) ?? undefined;
    const result = safeParseJson(resultMessage?.content || "", MAX_EAGER_JSON_PARSE_CHARS);
    const status = getToolCallStatus(resultMessage);
    return {
      id: toolCall.id,
      name: toolCall.function.name,
      args,
      rawArguments: toolCall.function.arguments,
      result,
      stageObservation: resultMessage?.stageObservationForDisplay || resultMessage?.stageObservation,
      stageObservations: resultMessage?.stageObservationsForDisplay || resultMessage?.stageObservations,
      rawResult: resultMessage?.content || "",
      status,
      summary: getToolSummary(toolCall.function.name, args || {}, result, status),
    };
  });

const STATUS_LABELS: Record<ToolCallStatus, string> = {
  running: "执行中",
  success: "完成",
  error: "失败",
  terminated: "已终止",
};

const TOOL_LABELS: Record<string, string> = {
  updateTodoList: "更新任务列表",
  askUser: "询问用户",
  listMemoryBlocks: "查看记忆列表",
  getMemoryBlock: "读取记忆",
  setMemoryBlock: "更新记忆",
  replaceMemoryBlockText: "替换记忆内容",
  deleteMemoryBlock: "删除记忆",
  applyPatch: "修改文件",
  runSubAgent: "分派子任务",
  observeStage: "观察舞台",
  runStageScript: "操作舞台",
  insertCostume: "新增造型",
  updateCostume: "更新造型",
  deleteCostume: "删除造型",
  getDiagnostics: "运行诊断",
  readFile: "读取文件",
  searchFiles: "搜索文件",
  searchBlocks: "搜索积木",
  getBlocksHelp: "查看积木",
  getScratchGuide: "读取指南",
  runGuideTool: "运行指南工具",
  getProjectOverview: "项目概览",
  listFiles: "列出文件",
  discardDraft: "丢弃草稿",
  getAllExtensions: "查看扩展列表",
  searchExtensions: "查找扩展",
  addExtension: "添加扩展",
  getExtensionBlocks: "查看扩展积木",
};

TOOL_LABELS.createAiGuide = "创建指南";

if (process.env.NODE_ENV !== "production") {
  const missingToolLabels = scratchToolSchemas
    .map((schema) => schema?.function?.name)
    .filter((name): name is string => Boolean(name) && !TOOL_LABELS[name]);
  if (missingToolLabels.length) {
    // Keep tool-call UI localized when new tools are added.
    console.warn("[ai-assistant] Missing Chinese tool labels:", missingToolLabels.join(", "));
  }
}

const renderTextPreview = (value: unknown) => {
  const text = String(value ?? "").trim();
  return text ? (
    <pre className={toolStyles.memoryValueText}>{text}</pre>
  ) : (
    <span className={toolStyles.toolCallMuted}>未提供</span>
  );
};

const renderMemoryArguments = (entry: ToolEntry) => {
  if (!isMemoryTool(entry.name)) return null;

  const rows: Array<{ label: string; value: React.ReactNode }> = [];
  const { args } = getLazyToolEntryData(entry);

  if (entry.name === "listMemoryBlocks") {
    rows.push({ label: "范围", value: args.scope ? getMemoryScopeLabel(args.scope) : "全部记忆" });
  }

  if (entry.name === "getMemoryBlock" || entry.name === "deleteMemoryBlock") {
    rows.push({ label: "记忆 ID", value: args.id || "未提供" });
    rows.push({ label: "范围", value: args.scope ? getMemoryScopeLabel(args.scope) : "自动查找" });
  }

  if (entry.name === "setMemoryBlock") {
    rows.push({ label: "操作", value: args.id ? "更新已有记忆" : "新增记忆" });
    rows.push({ label: "范围", value: getMemoryScopeLabel(args.scope) });
    if (args.id) rows.push({ label: "记忆 ID", value: args.id });
    rows.push({ label: "描述", value: args.description || "未填写" });
    rows.push({ label: "内容", value: renderTextPreview(args.content) });
  }

  if (entry.name === "replaceMemoryBlockText") {
    rows.push({ label: "记忆 ID", value: args.id || "未提供" });
    rows.push({ label: "范围", value: args.scope ? getMemoryScopeLabel(args.scope) : "自动查找" });
    rows.push({ label: "替换前", value: renderTextPreview(args.oldText) });
    rows.push({ label: "替换后", value: renderTextPreview(args.newText) });
  }

  return (
    <div className={toolStyles.memoryArgList}>
      {rows.map((row) => (
        <div key={row.label} className={toolStyles.memoryArgRow}>
          <span>{row.label}</span>
          <strong>{row.value}</strong>
        </div>
      ))}
    </div>
  );
};

const parsePatchDiff = (patch: string): DiffFile[] => {
  const files: DiffFile[] = [];
  let current: DiffFile | null = null;
  let oldLine = 0;
  let newLine = 0;

  String(patch || "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .forEach((line) => {
      if (line.startsWith("*** Update File:")) {
        current = {
          path: line.slice("*** Update File:".length).trim(),
          added: 0,
          deleted: 0,
          lines: [],
          truncated: false,
        };
        files.push(current);
        oldLine = 0;
        newLine = 0;
        return;
      }

      if (line.startsWith("*** Add File:")) {
        current = {
          path: line.slice("*** Add File:".length).trim(),
          added: 1,
          deleted: 0,
          lines: [{ kind: "meta", text: line }],
          truncated: false,
        };
        files.push(current);
        oldLine = 0;
        newLine = 0;
        return;
      }

      if (line.startsWith("*** Delete File:")) {
        current = {
          path: line.slice("*** Delete File:".length).trim(),
          added: 0,
          deleted: 1,
          lines: [{ kind: "meta", text: line }],
          truncated: false,
        };
        files.push(current);
        oldLine = 0;
        newLine = 0;
        return;
      }

      if (!current || line === "*** Begin Patch" || line === "*** End Patch") return;

      if (current.lines.length >= MAX_DIFF_LINES) {
        current.truncated = true;
        return;
      }

      const hunkMatch = /^@@(?:\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?)?/.exec(line);
      if (hunkMatch) {
        oldLine = Number(hunkMatch[1] || 0);
        newLine = Number(hunkMatch[2] || 0);
        current.lines.push({ kind: "meta", text: line || "@@" });
        return;
      }

      if (line.startsWith("+")) {
        current.added += 1;
        current.lines.push({ kind: "add", text: line.slice(1), newLine: newLine || undefined });
        if (newLine) newLine += 1;
        return;
      }

      if (line.startsWith("-")) {
        current.deleted += 1;
        current.lines.push({ kind: "delete", text: line.slice(1), oldLine: oldLine || undefined });
        if (oldLine) oldLine += 1;
        return;
      }

      if (line.startsWith(" ")) {
        current.lines.push({
          kind: "context",
          text: line.slice(1),
          oldLine: oldLine || undefined,
          newLine: newLine || undefined,
        });
        if (oldLine) oldLine += 1;
        if (newLine) newLine += 1;
        return;
      }

      if (line.startsWith("*** Move to:") || line.startsWith("*** ")) {
        current.lines.push({ kind: "meta", text: line });
        return;
      }

      current.added += 1;
      current.lines.push({ kind: "add", text: line, newLine: newLine || undefined });
      if (newLine) newLine += 1;
    });

  return files.filter((file) => file.path);
};

const collectChangedFiles = (entries: ToolEntry[]) => {
  const byPath = new Map<string, { path: string; added: number; deleted: number; operations: number }>();

  entries.forEach((entry) => {
    if (entry.name !== "applyPatch") return;
    const { args, result } = getPreviewToolEntryData(entry);
    if (args?.patch && String(args.patch).length <= MAX_EAGER_JSON_PARSE_CHARS) {
      const diffFiles = parsePatchDiff(args.patch || "");
      diffFiles.forEach((file) => {
        const existing = byPath.get(file.path) || { path: file.path, added: 0, deleted: 0, operations: 0 };
        existing.added += file.added;
        existing.deleted += file.deleted;
        byPath.set(file.path, existing);
      });
    }
    asArray(result?.syncResults).forEach((syncResult: any) => {
      const path = syncResult?.path || syncResult?.operations?.[0]?.newPath || syncResult?.operations?.[0]?.path;
      if (!path) return;
      const existing = byPath.get(path) || { path, added: 0, deleted: 0, operations: 0 };
      existing.operations += Number(syncResult?.operationCount || 0);
      byPath.set(path, existing);
    });
    asArray(result?.changedFiles).forEach((path: string) => {
      if (!path) return;
      byPath.set(path, byPath.get(path) || { path, added: 0, deleted: 0, operations: 0 });
    });
  });

  return [...byPath.values()];
};

const countDiagnostics = (entries: ToolEntry[]) =>
  entries.reduce(
    (acc, entry) => {
      const { result } = getPreviewToolEntryData(entry);
      const diagnostics = asArray(result?.diagnostics);
      diagnostics.forEach((item: any) => {
        acc.errors += asArray(item?.errors).length;
        acc.warnings += asArray(item?.warnings).length;
      });
      return acc;
    },
    { errors: 0, warnings: 0 },
  );

const ToolIcon = ({ status }: { status: ToolCallStatus }) => (
  <span className={`${toolStyles.toolCallGlyph} ${toolStyles[`toolCallGlyph${status}`]}`}>
    {status === "running" ? "" : status === "success" ? "✓" : "!"}
  </span>
);

const ToolChevron = ({ expanded }: { expanded: boolean }) => (
  <span className={`${toolStyles.toolCallChevron} ${expanded ? toolStyles.toolCallChevronExpanded : ""}`}>
    <ChevronRightIcon aria-hidden="true" />
  </span>
);

type DiffPreviewKind = "add" | "delete" | "context";

interface DiffBlockPreviewGroup {
  key: string;
  svg: string;
  unknownExtensions: string[];
}

interface DiffPreviewRenderGroup {
  key: string;
  lines: Array<Pick<DiffLine, "kind" | "text">>;
}

const hasDslCallShape = (content: string) => /[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?\s*\(/.test(content);

const getDiffPreviewSourceKey = (file: DiffFile) =>
  file.lines.map((line) => `${line.kind}:${line.oldLine || ""}:${line.newLine || ""}:${line.text}`).join("\n");

const buildDiffPreviewGroups = (file: DiffFile): DiffPreviewRenderGroup[] => {
  const groups: Array<Array<Pick<DiffLine, "kind" | "text">>> = [];
  let currentGroup: Array<Pick<DiffLine, "kind" | "text">> = [];

  const flushGroup = () => {
    if (!currentGroup.some((line) => line.kind === "add" || line.kind === "delete")) {
      currentGroup = [];
      return;
    }
    groups.push(currentGroup);
    currentGroup = [];
  };

  file.lines.forEach((line) => {
    if (line.kind === "meta") {
      if (/^@@/.test(line.text || "")) flushGroup();
      return;
    }
    currentGroup.push(line);
  });
  flushGroup();

  return groups
    .map((group, groupIndex) => ({
      key: `${file.path}-${groupIndex}`,
      lines: group.filter((line) => line.kind === "add" || line.kind === "delete" || line.kind === "context"),
    }))
    .filter((group) => group.lines.some((line) => hasDslCallShape(line.text)));
};

const DIFF_BLOCK_COLORS: Record<DiffPreviewKind, { stroke: string; width: string }> = {
  add: { stroke: "#16a34a", width: "4.6px" },
  delete: { stroke: "#dc2626", width: "4.6px" },
  context: { stroke: "#ffffff", width: "4px" },
};

const ARGUMENT_BLOCK_OPCODES = new Set([
  "text",
  "math_number",
  "math_integer",
  "math_whole_number",
  "math_positive_number",
  "math_angle",
  "note",
  "colour_picker",
]);

const isArgumentBlock = (block: any) => {
  const opcode = String(block?.opcode || "");
  return ARGUMENT_BLOCK_OPCODES.has(opcode);
};

const MENU_LIKE_OPCODE_PARTS = [
  "_menu",
  "menu_",
  "menu",
  "keyoptions",
  "touchingobject",
  "distanceto",
  "clone_of",
];

const isMenuBlock = (block: any) => {
  const opcode = String(block?.opcode || "").toLowerCase();
  return MENU_LIKE_OPCODE_PARTS.some((part) => opcode.includes(part));
};

const hasNestedReporterInput = (block: any, blocksById?: Map<string, any>) => {
  if (!block?.inputs || typeof block.inputs !== "object") return false;
  return Object.values(block.inputs).some((input: any) => {
    const childId = String(input?.block || "");
    if (!childId || childId === String(input?.shadow || "")) return false;
    const child = blocksById?.get(childId);
    if (!child) return true;
    return !child.shadow && !isArgumentBlock(child) && !isMenuBlock(child);
  });
};

const hasOnlyShadowOrArgumentInputs = (block: any, blocksById?: Map<string, any>) => {
  const inputValues = block?.inputs && typeof block.inputs === "object" ? Object.values(block.inputs) as any[] : [];
  return inputValues.every((input) => {
    if (!input?.block) return true;
    const child = blocksById?.get(String(input.block));
    return Boolean(input.block === input.shadow || child?.shadow || isArgumentBlock(child) || isMenuBlock(child));
  });
};

const isMenuBlockWithoutReporterInput = (block: any, blocksById?: Map<string, any>) => {
  if (!block || !isMenuBlock(block) || hasNestedReporterInput(block, blocksById)) return false;
  return hasOnlyShadowOrArgumentInputs(block, blocksById);
};

const isFieldOnlyMenuShadowBlock = (block: any, blocksById?: Map<string, any>) => {
  if (!block?.shadow || hasNestedReporterInput(block, blocksById)) return false;
  const fieldCount = block.fields && typeof block.fields === "object" ? Object.keys(block.fields).length : 0;
  const inputValues = block.inputs && typeof block.inputs === "object" ? Object.values(block.inputs) as any[] : [];
  if (!fieldCount && !inputValues.length) return false;
  return hasOnlyShadowOrArgumentInputs(block, blocksById);
};

const shouldSkipDiffBlockDecoration = (block: any, blocksById?: Map<string, any>) => {
  if (isArgumentBlock(block)) return true;
  if (isMenuBlockWithoutReporterInput(block, blocksById)) return true;
  if (isFieldOnlyMenuShadowBlock(block, blocksById)) return true;
  const opcode = String(block?.opcode || "");
  const inputCount = block?.inputs && typeof block.inputs === "object" ? Object.keys(block.inputs).length : 0;
  return Boolean(
    ARGUMENT_BLOCK_OPCODES.has(opcode) &&
      block?.topLevel &&
      !block?.parent &&
      !block?.next &&
      inputCount === 0,
  );
};

const appendDiffPreviewMarkers = (
  svgRoot: SVGSVGElement,
  markerTargets: Array<{ group: SVGGElement; color: string }>,
) => {
  if (!markerTargets.length || typeof document === "undefined" || !document.body) return;

  const host = document.createElement("div");
  host.style.position = "fixed";
  host.style.left = "-10000px";
  host.style.top = "-10000px";
  host.style.width = "1px";
  host.style.height = "1px";
  host.style.overflow = "visible";
  host.style.opacity = "0";
  host.style.pointerEvents = "none";
  document.body.appendChild(host);

  try {
    host.appendChild(svgRoot);
    markerTargets.forEach(({ group, color }) => {
      if (typeof group.getBBox !== "function") return;
      const bounds = group.getBBox();
      if (!Number.isFinite(bounds.x) || !Number.isFinite(bounds.y) || bounds.width <= 0 || bounds.height <= 0) return;

      const marker = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      marker.setAttribute("x", String(Math.floor(bounds.x - 9)));
      marker.setAttribute("y", String(Math.floor(bounds.y + 5)));
      marker.setAttribute("width", "7");
      marker.setAttribute("height", String(Math.max(8, Math.min(22, Math.floor(bounds.height - 4)))));
      marker.setAttribute("rx", "3");
      marker.setAttribute("fill", color);
      marker.setAttribute("stroke", "#ffffff");
      marker.setAttribute("stroke-width", "1.6");
      marker.setAttribute("pointer-events", "none");
      group.appendChild(marker);
    });
  } finally {
    host.remove();
  }
};

const buildBlockStateMap = (blocksState: any[]): Map<string, any> => {
  const entries: Array<[string, any]> = [];
  blocksState.forEach((block) => {
    const id = String(block?.id || block?.blockId || "");
    if (id) entries.push([id, block]);
  });
  return new Map(entries);
};

const isDecoratableDiffBlock = (block: any, blocksById?: Map<string, any>) => !shouldSkipDiffBlockDecoration(block, blocksById);

const isOpenWrapperDiffLine = (line: string) => {
  const trimmed = String(line || "").trim();
  return /=>\s*\{\s*$/.test(trimmed) || /,\s*function\s*\([^)]*\)\s*\{\s*$/.test(trimmed);
};

const countDecoratableBlocksForDiffLine = (
  line: string,
  vm?: PluginContext["vm"],
  blockly?: any,
) => {
  const trimmed = String(line || "").trim();
  if (!trimmed || isOpenWrapperDiffLine(trimmed) || !hasDslCallShape(trimmed)) return 0;
  try {
    const result = renderDslPreview(trimmed, vm, blockly, false);
    const blocksById = buildBlockStateMap(result.blocksState || []);
    return Math.max(1, (result.blocksState || []).filter((block) => isDecoratableDiffBlock(block, blocksById)).length);
  } catch {
    return 1;
  }
};

const buildDiffKindByBlockId = (
  blocksState: any[],
  lines: Array<Pick<DiffLine, "kind" | "text">>,
  vm?: PluginContext["vm"],
  blockly?: any,
) => {
  const kindByBlockId = new Map<string, DiffPreviewKind>();
  const blocksById = buildBlockStateMap(blocksState);
  const decoratableBlocks = blocksState.filter((block) => isDecoratableDiffBlock(block, blocksById));
  let cursor = 0;

  lines.forEach((line) => {
    if (line.kind !== "add" && line.kind !== "delete" && line.kind !== "context") return;
    const count = countDecoratableBlocksForDiffLine(line.text, vm, blockly);
    if (!count) return;
    for (let index = 0; index < count && cursor < decoratableBlocks.length; index += 1) {
      const id = String(decoratableBlocks[cursor]?.id || decoratableBlocks[cursor]?.blockId || "");
      if (id) kindByBlockId.set(id, line.kind);
      cursor += 1;
    }
  });

  decoratableBlocks.forEach((block) => {
    const id = String(block?.id || block?.blockId || "");
    if (id && !kindByBlockId.has(id)) {
      kindByBlockId.set(id, "context");
    }
  });

  return kindByBlockId;
};

const colorizeDiffPreviewSvg = (svg: string, blocksState: any[], kindByBlockId: Map<string, DiffPreviewKind>) => {
  if (!svg || !blocksState.length || !kindByBlockId.size || typeof DOMParser === "undefined") return svg;

  try {
    const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
    const svgRoot = doc.documentElement as unknown as SVGSVGElement;
    const idToBlock = buildBlockStateMap(blocksState);

    const markerTargets: Array<{ group: SVGGElement; color: string }> = [];
    const groups = Array.from(doc.querySelectorAll<SVGGElement>("g[data-id]"));
    groups.forEach((group) => {
      const id = group.getAttribute("data-id") || "";
      const kind = id ? kindByBlockId.get(id) : null;
      const color = kind ? DIFF_BLOCK_COLORS[kind] : null;
      const block = id ? idToBlock.get(id) : null;
      if (!color || !block) return;

      if (shouldSkipDiffBlockDecoration(block, idToBlock)) return;

      const shapes = Array.from(group.children).filter((child): child is SVGElement => {
        const tagName = child.tagName.toLowerCase();
        return tagName === "path" || tagName === "rect";
      });
      if (!shapes.length) return;

      shapes.forEach((shape) => {
        const outline = shape.cloneNode(false) as SVGElement;
        outline.setAttribute("fill", "none");
        outline.setAttribute("stroke", color.stroke);
        outline.setAttribute("stroke-width", color.width);
        outline.setAttribute("pointer-events", "none");
        group.appendChild(outline);
      });

      markerTargets.push({ group, color: color.stroke });
    });

    appendDiffPreviewMarkers(svgRoot, markerTargets);
    return new XMLSerializer().serializeToString(svgRoot);
  } catch (error) {
    console.warn("[AI Assistant Tool Diff Preview] Failed to colorize DSL diff preview SVG.", error);
    return svg;
  }
};

const renderDiffLines = (file: DiffFile) => (
  <div className={toolStyles.diffBody}>
    {file.lines.map((line, index) => (
      <div
        key={`${file.path}-${index}`}
        className={`${toolStyles.diffLine} ${toolStyles[`diffLine${line.kind}`]}`}
      >
        <span className={toolStyles.diffLineNumber}>{line.oldLine ?? ""}</span>
        <span className={toolStyles.diffLineNumber}>{line.newLine ?? ""}</span>
        <span className={toolStyles.diffMarker}>
          {line.kind === "add" ? "+" : line.kind === "delete" ? "-" : line.kind === "meta" ? "·" : " "}
        </span>
        <code>{line.text || " "}</code>
      </div>
    ))}
    {file.truncated ? <div className={toolStyles.diffTruncated}>已截断较长 diff</div> : null}
  </div>
);

const DiffFilePreview: React.FC<{ file: DiffFile; vm?: PluginContext["vm"]; blockly?: any }> = ({ file, vm, blockly }) => {
  const [showDsl, setShowDsl] = React.useState(false);
  const [previewGroups, setPreviewGroups] = React.useState<DiffBlockPreviewGroup[]>([]);
  const [previewFailed, setPreviewFailed] = React.useState(false);
  const [previewRefreshKey, setPreviewRefreshKey] = React.useState(0);
  const previewSourceKey = React.useMemo(() => getDiffPreviewSourceKey(file), [file]);
  const previewRenderGroups = React.useMemo(() => buildDiffPreviewGroups(file), [file.path, previewSourceKey]);
  const unknownExtensions = React.useMemo(
    () => Array.from(new Set(previewGroups.flatMap((group) => group.unknownExtensions || []))),
    [previewGroups],
  );

  React.useEffect(() => {
    let cancelled = false;
    setShowDsl(false);
    setPreviewGroups([]);
    setPreviewFailed(false);
    if (!previewRenderGroups.length) {
      setPreviewFailed(true);
      return undefined;
    }

    window.setTimeout(() => {
      if (cancelled) return;
      try {
        const nextGroups = previewRenderGroups.map((group) => {
          const combinedCode = group.lines.map((line) => line.text).join("\n").trim();
          let combinedResult;
          try {
            combinedResult = renderDslPreview(combinedCode, vm, blockly, false);
          } catch {
            combinedResult = renderDslPreview(combinedCode, vm, blockly, true);
          }
          const kindByBlockId = buildDiffKindByBlockId(combinedResult.blocksState || [], group.lines, vm, blockly);
          return {
            key: group.key,
            svg: colorizeDiffPreviewSvg(combinedResult.svg, combinedResult.blocksState || [], kindByBlockId),
            unknownExtensions: combinedResult.unknownExtensions || [],
          };
        });
        if (!cancelled) setPreviewGroups(nextGroups);
      } catch (error) {
        console.warn("[AI Assistant Tool Diff Preview] Failed to render DSL diff as blocks.", {
          path: file.path,
          error,
        });
        if (!cancelled) setPreviewFailed(true);
      }
    }, 0);

    return () => {
      cancelled = true;
    };
  }, [blockly, file.path, previewRenderGroups, previewRefreshKey, vm]);

  React.useEffect(() => {
    const handleExtensionsLoaded = () => {
      setPreviewGroups([]);
      setPreviewFailed(false);
      setPreviewRefreshKey((value) => value + 1);
    };

    window.addEventListener(AI_ASSISTANT_EXTENSIONS_LOADED_EVENT, handleExtensionsLoaded);
    return () => {
      window.removeEventListener(AI_ASSISTANT_EXTENSIONS_LOADED_EVENT, handleExtensionsLoaded);
    };
  }, []);

  if (previewFailed || !previewGroups.length) {
    return renderDiffLines(file);
  }

  return (
    <div className={toolStyles.diffPreviewShell}>
      <div className={toolStyles.diffPreviewToolbar}>
        <span>{showDsl ? "DSL 变化" : "积木预览"}</span>
        <span className={toolStyles.diffPreviewActions}>
          {!showDsl && unknownExtensions.length ? (
            <ExtensionLoadButton
              extensionIds={unknownExtensions}
              vm={vm}
              blockly={blockly}
              className={toolStyles.diffPreviewToggle}
              onLoaded={() => {
                setPreviewGroups([]);
                setPreviewFailed(false);
                setPreviewRefreshKey((value) => value + 1);
              }}
            />
          ) : null}
          <button type="button" className={toolStyles.diffPreviewToggle} onClick={() => setShowDsl((value) => !value)}>
            {showDsl ? "查看积木" : "查看 DSL"}
          </button>
        </span>
      </div>
      {showDsl ? (
        renderDiffLines(file)
      ) : (
        <div className={toolStyles.diffBlockPreview}>
          <div className={toolStyles.diffBlockCanvas}>
            {previewGroups.map((group) => (
              <div key={group.key} className={toolStyles.diffBlockSegment}>
                <div className={toolStyles.diffBlockSvg} dangerouslySetInnerHTML={{ __html: group.svg }} />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

const renderDiff = (entry: ToolEntry, vm?: PluginContext["vm"], blockly?: any) => {
  const { args } = getLazyToolEntryData(entry);
  const diffFiles = parsePatchDiff(args?.patch || "");
  if (diffFiles.length === 0) return null;

  return (
    <div className={toolStyles.diffStack}>
      {diffFiles.map((file) => (
        <details key={file.path} className={toolStyles.diffFile} open={diffFiles.length <= 2}>
          <summary className={toolStyles.diffFileHeader}>
            <span className={toolStyles.diffFilePath}>{file.path}</span>
            <span className={toolStyles.diffStats}>
              <span className={toolStyles.diffAdded}>+{file.added}</span>
              <span className={toolStyles.diffDeleted}>-{file.deleted}</span>
            </span>
          </summary>
          <DiffFilePreview file={file} vm={vm} blockly={blockly} />
        </details>
      ))}
    </div>
  );
};

const renderResultPreview = (entry: ToolEntry) => {
  const { args, result } = getPreviewToolEntryData(entry);
  if (entry.status === "running") {
    return <div className={toolStyles.toolCallMuted}>工具仍在运行...</div>;
  }

  if (entry.status === "error") {
    return <div className={toolStyles.toolErrorBox}>{result?.error || entry.rawResult || "工具调用失败"}</div>;
  }

  if (entry.name === "applyPatch") {
    return (
      <div className={toolStyles.toolResultGrid}>
        <span>文件</span>
        <strong>
          {asArray(result?.changedFiles).length ||
            (args?.patch && String(args.patch).length <= MAX_EAGER_JSON_PARSE_CHARS
              ? parsePatchDiff(args.patch || "").length
              : "待展开")}
        </strong>
        <span>同步操作</span>
        <strong>{result?.operationCount ?? result?.scriptOperationCount ?? 0}</strong>
      </div>
    );
  }

  if (entry.name === "getDiagnostics") {
    const diagnostics = countDiagnostics([entry]);
    return (
      <div className={toolStyles.toolResultGrid}>
        <span>状态</span>
        <strong>{result?.valid ? "通过" : "需修复"}</strong>
        <span>错误</span>
        <strong>{diagnostics.errors}</strong>
        <span>警告</span>
        <strong>{diagnostics.warnings}</strong>
      </div>
    );
  }

  if (entry.name === "readFile") {
    return (
      <div className={toolStyles.toolResultGrid}>
        <span>路径</span>
        <strong>{result?.path || args?.path}</strong>
        <span>行数</span>
        <strong>{result?.totalLines ?? "?"}</strong>
      </div>
    );
  }

  if (entry.name === "observeStage") {
    const image = entry.stageObservation || result?.image;
    const message = result?.success === false ? result?.error || "舞台截图失败" : "未获取到舞台截图";
    return image?.dataUrl ? (
      <img className={toolStyles.stageObservationImage} src={image.dataUrl} alt="舞台截图" />
    ) : (
      <div className={toolStyles.toolCallMuted}>{message}</div>
    );
  }

  if (entry.name === "runStageScript") {
    const screenshots = entry.stageObservations?.length ? entry.stageObservations : result?.screenshots || [];
    const screenshotCount = Array.isArray(screenshots) ? screenshots.length : Number(screenshots || 0);
    return (
      <>
        {result?.success === false ? (
          <div className={toolStyles.toolErrorMessage}>
            {result?.error || "操作舞台失败"}
            {result?.failedActionIndex ? `（第 ${result.failedActionIndex} 个动作：${result.failedAction || "未知"}）` : ""}
          </div>
        ) : null}
        <div className={toolStyles.toolResultGrid}>
          <span>动作数</span>
          <strong>{result?.actions ?? 0}</strong>
          <span>耗时</span>
          <strong>{result?.elapsedMs ?? 0}ms</strong>
          <span>截图</span>
          <strong>{screenshotCount || 0}</strong>
        </div>
        {Array.isArray(screenshots) && screenshots.length ? (
          <div className={toolStyles.stageObservationGrid}>
            {screenshots.map((image: any, index: number) =>
              image?.dataUrl ? (
                <img
                  key={`${index}-${image.dataUrl.slice(0, 32)}`}
                  className={toolStyles.stageObservationImage}
                  src={image.dataUrl}
                  alt={`舞台截图 ${index + 1}`}
                />
              ) : null,
            )}
          </div>
        ) : null}
      </>
    );
  }

  if (isMemoryTool(entry.name)) {
    const block = result?.block;
    if (entry.name === "listMemoryBlocks") {
      return (
        <div className={toolStyles.toolResultGrid}>
          <span>数量</span>
          <strong>{asArray(result?.blocks).length}</strong>
          <span>项目记忆</span>
          <strong>{result?.projectMemoryAvailable ? "可用" : "不可用"}</strong>
        </div>
      );
    }
    if (block) {
      return (
        <div className={toolStyles.memoryArgList}>
          <div className={toolStyles.memoryArgRow}>
            <span>范围</span>
            <strong>{getMemoryScopeLabel(block.scope)}</strong>
          </div>
          <div className={toolStyles.memoryArgRow}>
            <span>记忆 ID</span>
            <strong>{block.id}</strong>
          </div>
          <div className={toolStyles.memoryArgRow}>
            <span>描述</span>
            <strong>{block.description || "未填写"}</strong>
          </div>
          <div className={toolStyles.memoryArgRow}>
            <span>内容</span>
            <strong>{renderTextPreview(block.content)}</strong>
          </div>
        </div>
      );
    }
    if (entry.name === "deleteMemoryBlock") {
      return (
        <div className={toolStyles.toolResultGrid}>
          <span>已删除</span>
          <strong>{result?.deletedId || args?.id}</strong>
          <span>范围</span>
          <strong>{getMemoryScopeLabel(result?.scope || args?.scope)}</strong>
        </div>
      );
    }
  }

  return <pre className={toolStyles.toolCompactJson}>{entry.rawResult || "无返回内容"}</pre>;
};

export const ToolCallViewer: React.FC<ToolCallViewerProps> = ({
  toolCalls,
  toolResults = [],
  isGenerating = false,
  vm,
  blockly,
}) => {
  const [expanded, setExpanded] = React.useState(true);
  const [expandedDetails, setExpandedDetails] = React.useState<Record<string, boolean>>({});

  const entries = React.useMemo(() => buildEntries(toolCalls, toolResults), [toolCalls, toolResults]);
  const runningCount = entries.filter((entry) => entry.status === "running").length;
  const successCount = entries.filter((entry) => entry.status === "success").length;
  const errorCount = entries.filter((entry) => entry.status === "error").length;
  const changedFiles = React.useMemo(() => collectChangedFiles(entries), [entries]);
  const diagnostics = React.useMemo(() => countDiagnostics(entries), [entries]);
  const hasRunning = runningCount > 0;

  const toggleDetail = (id: string) => {
    setExpandedDetails((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  return (
    <div className={`${toolStyles.toolCallSummary} ${hasRunning ? toolStyles.toolCallSummaryRunning : ""}`}>
      <button type="button" className={toolStyles.toolCallSummaryHeader} onClick={() => setExpanded((prev) => !prev)}>
        <span className={`${toolStyles.toolCallPulse} ${hasRunning ? toolStyles.toolCallPulseActive : ""}`} />
        <span className={toolStyles.toolCallSummaryTitle}>
          {hasRunning ? "正在执行工具" : errorCount > 0 ? "工具调用完成，有失败项" : "工具调用完成"}
        </span>
        <span className={toolStyles.toolCallSummaryMeta}>
          {entries.length} 个工具 · {successCount} 成功{errorCount ? ` · ${errorCount} 失败` : ""}
        </span>
        <ToolChevron expanded={expanded} />
      </button>

      {expanded ? (
        <div className={toolStyles.toolCallBody}>
          {changedFiles.length > 0 || diagnostics.errors > 0 || diagnostics.warnings > 0 ? (
            <div className={toolStyles.toolRunSummary}>
              {changedFiles.length > 0 ? (
                <div className={toolStyles.changedFilesPanel}>
                  <div className={toolStyles.changedFilesHeader}>
                    <strong>{changedFiles.length} 个文件已更改</strong>
                    <span>
                      +{changedFiles.reduce((sum, file) => sum + file.added, 0)} -
                      {changedFiles.reduce((sum, file) => sum + file.deleted, 0)}
                    </span>
                  </div>
                  <div className={toolStyles.changedFileList}>
                    {changedFiles.map((file) => (
                      <div key={file.path} className={toolStyles.changedFileItem}>
                        <span>{file.path}</span>
                        <span>
                          <b className={toolStyles.diffAdded}>+{file.added}</b>{" "}
                          <b className={toolStyles.diffDeleted}>-{file.deleted}</b>
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
              {diagnostics.errors > 0 || diagnostics.warnings > 0 ? (
                <div className={toolStyles.diagnosticPills}>
                  <span
                    className={diagnostics.errors > 0 ? toolStyles.diagnosticPillError : toolStyles.diagnosticPillOk}
                  >
                    {diagnostics.errors} 个错误
                  </span>
                  <span
                    className={diagnostics.warnings > 0 ? toolStyles.diagnosticPillWarn : toolStyles.diagnosticPillOk}
                  >
                    {diagnostics.warnings} 个警告
                  </span>
                </div>
              ) : null}
            </div>
          ) : null}

          <div className={toolStyles.toolCallList}>
            {entries.map((entry) => (
              <div
                key={entry.id}
                className={`${toolStyles.toolCallItem} ${
                  entry.status === "running" ? toolStyles.toolCallItemRunning : ""
                }`}
              >
                <button type="button" className={toolStyles.toolCallItemHeader} onClick={() => toggleDetail(entry.id)}>
                  <ToolIcon status={entry.status} />
                  <span className={toolStyles.toolCallName}>{TOOL_LABELS[entry.name] || entry.name}</span>
                  <span className={toolStyles.toolCallSummaryLine}>{entry.summary}</span>
                  <span className={`${toolStyles.toolCallStatus} ${toolStyles[`toolCallStatus${entry.status}`]}`}>
                    {STATUS_LABELS[entry.status]}
                  </span>
                </button>
                {expandedDetails[entry.id] ? (
                  <div className={toolStyles.toolCallDetail}>
                    {(() => {
                      const { formattedArguments, formattedResult } = getLazyToolEntryData(entry);
                      return (
                        <>
                    {renderDiff(entry, vm, blockly)}
                    {isMemoryTool(entry.name) ? (
                      <div className={toolStyles.toolCallSection}>
                        <div className={toolStyles.toolCallSectionTitle}>调用内容</div>
                        {renderMemoryArguments(entry)}
                      </div>
                    ) : null}
                    <div className={toolStyles.toolCallSection}>
                      <div className={toolStyles.toolCallSectionTitle}>结果</div>
                      {renderResultPreview(entry)}
                    </div>
                    <details className={toolStyles.rawToolDetails}>
                      <summary>原始参数 / 返回</summary>
                      <div className={toolStyles.toolCallRawGrid}>
                        <div className={toolStyles.toolCallSection}>
                          <div className={toolStyles.toolCallSectionTitle}>参数</div>
                          <pre>{formattedArguments || "{}"}</pre>
                        </div>
                        <div className={toolStyles.toolCallSection}>
                          <div className={toolStyles.toolCallSectionTitle}>返回</div>
                          <pre>
                            {entry.name === "observeStage"
                              ? "舞台截图已获取；图片仅在历史记录中展示，不作为文本返回。"
                              : formattedResult || stringifyCompact(entry.rawResult) || "无返回内容"}
                          </pre>
                        </div>
                      </div>
                    </details>
                        </>
                      );
                    })()}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
};
