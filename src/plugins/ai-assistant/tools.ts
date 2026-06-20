import { scratchToUCF, ucfToScratch } from "./ucf";
import { normalizeModelUCF, toAnnotatedUCF } from "./annotatedUcf";
import {
  deleteScriptById,
  getBlocksRangeUCF,
  insertScriptByUCF,
  repairListVariableValues,
  replaceBlocksRangeByUCF,
  replaceScriptByUCF,
} from "./workspaceRangeTools";
import { CORE_MENU_SHADOWS, getCoreMenuShadowInfo, setGetBlockInfoTool, setRuntime } from "./converter";
import scratchBlocksCatalog from "./scratch_blocks.json";
import { MemoryScope, TodoItem, UserGuide } from "./types";
import {
  executeGuideTool,
  extractGuideTools,
  findGuide,
  getAiReadableExtensionGuides,
  getAllGuides,
  getRuntimeExtensionGuides,
  normalizeGuideName,
} from "./guideRegistry";
import {
  deleteMemoryBlock,
  getMemoryBlock,
  listMemoryBlocks,
  replaceMemoryBlockText,
  setMemoryBlock,
} from "./memoryStore";
import { updateTodoList } from "./todoStore";
import { createProjectSnapshot, restoreProjectSnapshot } from "./projectSnapshot";
import { APPROVED_EXTENSION_INDEX, APPROVED_EXTENSION_INDEX_BY_ID } from "./approvedExtensionIndex";
import {
  APPROVED_EXTENSION_INDEX_GUIDE_TITLE,
  APPROVED_EXTENSION_INDEX_GUIDE_TOPIC,
  buildApprovedExtensionIndexGuideRules,
} from "./extensionIndexGuide";

// This file contains tools for the AI assistant to interact with Scratch.

const NativeScratchBlockCatalog: Record<string, { block: any; menus: Record<string, any> }> = (() => {
  const result: Record<string, { block: any; menus: Record<string, any> }> = {};
  const root = scratchBlocksCatalog as any;

  for (const categoryGroup of Object.values(root?.categories || {})) {
    for (const categoryInfo of Object.values(categoryGroup as Record<string, any>)) {
      const blocks = Array.isArray((categoryInfo as any)?.blocks) ? (categoryInfo as any).blocks : [];
      const menus =
        (categoryInfo as any)?.menus && typeof (categoryInfo as any).menus === "object"
          ? (categoryInfo as any).menus
          : {};
      for (const block of blocks) {
        const opcode = String((block as any)?.opcode || "").trim();
        if (!opcode) continue;
        result[opcode] = { block, menus };
      }
    }
  }

  return result;
})();

type VirtualFileKind = "target" | "script" | "doc" | "dir" | "costume" | "costumeOrder" | "sound" | "variables" | "lists";

interface VirtualFileEntry {
  path: string;
  aliases?: string[];
  kind: VirtualFileKind;
  writable: boolean;
  deletable?: boolean;
  content: string;
  description: string;
  targetId?: string;
  targetName?: string;
  isStage?: boolean;
  aliasPath?: string;
  scriptId?: string;
  scriptIds?: string[];
  scriptLabel?: string;
  hatOpcode?: string;
  syncStatus?: "synced" | "dirty-invalid" | "new";
  diagnostics?: any;
  assetName?: string;
  dataFormat?: string;
  costumeId?: string;
  costumeIndex?: number;
  soundId?: string;
  soundIndex?: number;
  pendingRootPath?: string;
  pendingTargetName?: string;
}

interface VirtualFileBuildOptions {
  includeScriptContent?: boolean;
  includeLegacyTargetContent?: boolean;
  includeDocContent?: boolean;
}

interface PendingImmediateOperation {
  priority: number;
  path?: string;
  type?: string;
  run: () => Promise<any> | any;
}

interface VirtualAssetPathResolution {
  rootPath: string;
  targetId: string;
  targetName?: string;
  isStage: boolean;
  folderName: string;
  fileName: string;
}

interface VirtualScriptSection {
  scriptId: string;
  markerLine: number;
  startLine: number;
  endLine: number;
  code: string;
  normalizedCode: string;
  isNew: boolean;
}

interface ParsedPatchUpdate {
  type: "update";
  path: string;
  moveTo?: string;
  hunks: string[][];
  replacementContent?: string;
  rawReplacementLines?: string[];
}

interface ParsedPatchAdd {
  type: "add";
  path: string;
  content: string;
  rawReplacementLines?: string[];
}

interface ParsedPatchDelete {
  type: "delete";
  path: string;
}

type ParsedPatchOperation = ParsedPatchAdd | ParsedPatchDelete | ParsedPatchUpdate;

interface ProjectRollbackSnapshot {
  projectData?: ArrayBuffer;
  projectJson?: string;
}

const SCRIPT_MARKER_RE = /^\/\/\s*@script\s+([^\s]+)(?:\s+.*)?$/;
const VIRTUAL_STAGE_FOLDER_NAME = "stage";
const VIRTUAL_STAGE_ROOT_PATH = `/${VIRTUAL_STAGE_FOLDER_NAME}`;
const VIRTUAL_STAGE_SCRIPT_PATH = `${VIRTUAL_STAGE_ROOT_PATH}/script.js`;
const VIRTUAL_SCRIPT_FILE_NAME = "script.js";
const VIRTUAL_SCRIPTS_DIR_NAME = "scripts";
const VIRTUAL_COSTUME_DIR_NAME = "custom";
const VIRTUAL_COSTUME_ORDER_FILE_NAME = "order.json";
const VIRTUAL_SOUND_DIR_NAME = "audio";
const VIRTUAL_VARIABLES_FILE_NAME = "variables.json";
const VIRTUAL_LISTS_FILE_NAME = "lists.json";
const VIRTUAL_VARIABLES_FILE_ALIAS = "变量.json";
const VIRTUAL_LISTS_FILE_ALIAS = "列表.json";
const AI_ASSISTANT_SCRIPT_FILES_COMMENT_HEADER = "ai-assistant script-files";
const AI_ASSISTANT_SCRIPT_FILES_COMMENT_MAX_LENGTH = 5000;
const AI_ASSISTANT_SCRIPT_FILES_CHUNK_HEADER_RE = /^ai-assistant script-files(?:\s+(\d+)\/(\d+))?$/;
const DOC_SCRATCH_AGENT_PATH = "/docs/scratch-agent.md";
const DOC_BLOCK_CATALOG_PATH = "/docs/block-catalog.md";
const RESERVED_ROOT_FOLDER_NAMES = new Set(["docs"]);
const RESERVED_SPRITE_FOLDER_NAMES = new Set([...RESERVED_ROOT_FOLDER_NAMES, VIRTUAL_STAGE_FOLDER_NAME]);
const DEFAULT_NEW_TARGET_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96" width="96" height="96">
  <rect x="8" y="8" width="80" height="80" rx="16" fill="#ffd166" stroke="#ef9b20" stroke-width="4"/>
  <circle cx="36" cy="40" r="6" fill="#5c3b00"/>
  <circle cx="60" cy="40" r="6" fill="#5c3b00"/>
  <path d="M32 60 Q48 72 64 60" fill="none" stroke="#5c3b00" stroke-width="5" stroke-linecap="round"/>
</svg>`;
const PREVIEW_MAX_CHARS = 1200;
const COMMON_OPCODE_ALIASES: Record<string, string> = {
  argument_reporter: "argument_reporter_string_number",
  argument_reporter_string_number: "argument_reporter_string_number",
  argument_string_number: "argument_reporter_string_number",
  argument_number: "argument_reporter_string_number",
  argument_boolean: "argument_reporter_boolean",
  argument_reporter_boolean: "argument_reporter_boolean",
  operator_lt: "operator_lt",
  operator_less: "operator_lt",
  operator_lessthan: "operator_lt",
  operator_lower: "operator_lt",
  operator_gt: "operator_gt",
  operator_greater: "operator_gt",
  operator_greaterthan: "operator_gt",
  operator_equal: "operator_equals",
  operator_equals: "operator_equals",
  pen_pen_down: "pen_penDown",
  pen_down: "pen_penDown",
  pen_pendown: "pen_penDown",
  pen_pen_down_block: "pen_penDown",
  pen_pen_up: "pen_penUp",
  pen_up: "pen_penUp",
  pen_penup: "pen_penUp",
  pen_clear_all: "pen_clear",
  pen_erase_all: "pen_clear",
  pen_set_pen_color_param_to: "pen_setPenColorParamTo",
  pen_change_pen_color_param_by: "pen_changePenColorParamBy",
  pen_setpencolourparamto: "pen_setPenColorParamTo",
  pen_setpencolorparamto: "pen_setPenColorParamTo",
  pen_changepencolourparamby: "pen_changePenColorParamBy",
  pen_changepencolorparamby: "pen_changePenColorParamBy",
  data_add: "data_addtolist",
  data_add_to_list: "data_addtolist",
  data_addtolist: "data_addtolist",
  data_deleteall: "data_deletealloflist",
  data_clearlist: "data_deletealloflist",
  data_length_of_list: "data_lengthoflist",
  data_item_of_list: "data_itemoflist",
  sound_play: "sound_play",
  sound_playuntildone: "sound_playuntildone",
};

const SCRATCH_BLOCK_SEARCH_PHRASES: Array<[string, string[]]> = [
  ["motion_gotoxy", ["go to x y", "goto xy", "go x y", "move to x y"]],
  ["motion_goto", ["go to sprite", "go to random", "go to mouse"]],
  ["motion_setx", ["set x", "set x to"]],
  ["motion_changexby", ["change x", "change x by"]],
  ["motion_sety", ["set y", "set y to"]],
  ["motion_changeyby", ["change y", "change y by"]],
  ["motion_ifonedgebounce", ["if on edge bounce", "touching edge bounce"]],
  ["sensing_touchingobject", ["touching edge", "touching object", "touching sprite"]],
  ["sensing_keypressed", ["key pressed", "press key"]],
  ["control_create_clone_of", ["create clone", "clone of"]],
  ["control_delete_this_clone", ["delete clone", "delete this clone"]],
  ["control_start_as_clone", ["when i start as clone", "start as clone"]],
  ["control_wait_until", ["wait until"]],
  ["control_repeat_until", ["repeat until"]],
  ["control_forever", ["forever", "repeat forever"]],
  ["operator_and", ["and"]],
  ["operator_or", ["or"]],
  ["operator_not", ["not"]],
  ["operator_lt", ["less than", "smaller than"]],
  ["operator_gt", ["greater than"]],
  ["operator_equals", ["equals", "equal"]],
  ["data_setvariableto", ["set variable", "set score", "score"]],
  ["data_changevariableby", ["change variable", "change score"]],
  ["looks_switchbackdropto", ["switch backdrop", "change backdrop"]],
  ["looks_nextbackdrop", ["next backdrop"]],
];

const normalizeVirtualPath = (path: string) => {
  const normalized = String(path || "")
    .replace(/\\/g, "/")
    .trim();
  if (!normalized) return "/";
  const absolute = normalized.startsWith("/") ? normalized : `/${normalized}`;
  return absolute === "/" ? absolute : absolute.replace(/\/+$/g, "");
};

const splitVirtualPath = (path: string) => normalizeVirtualPath(path).split("/").filter(Boolean);

const getVirtualParentPath = (path: string) => {
  const segments = splitVirtualPath(path);
  if (segments.length <= 1) return "/";
  return `/${segments.slice(0, -1).join("/")}`;
};

const getVirtualBaseName = (path: string) => splitVirtualPath(path).pop() || "";

const getFileStem = (fileName: string) => {
  const value = String(fileName || "");
  const dotIndex = value.lastIndexOf(".");
  return dotIndex > 0 ? value.slice(0, dotIndex) : value;
};

const getFileExtension = (fileName: string) => {
  const value = String(fileName || "");
  const dotIndex = value.lastIndexOf(".");
  return dotIndex >= 0 ? value.slice(dotIndex + 1).toLowerCase() : "";
};

const isRootSpriteFolderPath = (path: string) => {
  const segments = splitVirtualPath(path);
  return segments.length === 1 && !RESERVED_ROOT_FOLDER_NAMES.has(segments[0]);
};

const getSpriteFolderNameFromPath = (path: string) => {
  if (!isRootSpriteFolderPath(path)) return "";
  return splitVirtualPath(path)[0] || "";
};

const normalizeOpcodeLookupKey = (value: string) =>
  String(value || "")
    .trim()
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .replace(/[.\s-]+/g, "_")
    .replace(/[^a-zA-Z0-9_]/g, "")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();

const escapeRegExp = (value: string) => String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const escapeXmlText = (value: any) =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

const normalizeProcedureSignature = (proccode: string) =>
  String(proccode || "")
    .replace(/%([nsb])\[[^\]]*\]/g, "%$1")
    .replace(/\s+/g, " ")
    .trim();

const extractProcedureArgumentNames = (proccode: string) =>
  [...String(proccode || "").matchAll(/%[nsb]\[([^\]]+)\]/g)]
    .map((match) => String(match[1] || "").trim())
    .filter(Boolean);

const sanitizePathSegment = (value: string, fallback: string) => {
  const sanitized = String(value || "")
    .replace(/[\\/:*?"<>|#]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized || fallback;
};

const sanitizeSpriteFolderName = (value: string, fallback = "sprite") => {
  const name = sanitizePathSegment(value, fallback);
  return RESERVED_SPRITE_FOLDER_NAMES.has(name) ? `${name}-sprite` : name;
};

const getScriptFileNameFromLabel = (value: string, fallback = "script") => {
  const raw = String(value || "").trim();
  const compact = raw.replace(/\s+/g, "-").slice(0, 24);
  const sanitized = sanitizePathSegment(compact, fallback)
    .replace(/[^\p{L}\p{N}_-]+/gu, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${(sanitized || fallback).slice(0, 32)}.js`;
};

const getScriptLabelFromCode = (code: string, fallback: string) => {
  const firstComment = String(code || "").match(/^\s*\/\/\s*(?!@script\b)(.+)$/m)?.[1]?.trim();
  if (firstComment) return firstComment.slice(0, 8);
  return fallback;
};

const isVirtualScriptFilePath = (path: string) => {
  const segments = splitVirtualPath(path);
  return segments.length === 3 && segments[1] === VIRTUAL_SCRIPTS_DIR_NAME && getFileExtension(segments[2]) === "js";
};

const isVirtualScriptsDirPath = (path: string) => {
  const segments = splitVirtualPath(path);
  return segments.length === 2 && segments[1] === VIRTUAL_SCRIPTS_DIR_NAME;
};

const isVirtualAssetFilePath = (path: string) => {
  const segments = splitVirtualPath(path);
  return segments.length === 3 && [VIRTUAL_COSTUME_DIR_NAME, VIRTUAL_SOUND_DIR_NAME].includes(segments[1]);
};

const isVirtualCostumeOrderFilePath = (path: string) => {
  const segments = splitVirtualPath(path);
  return segments.length === 3 && segments[1] === VIRTUAL_COSTUME_DIR_NAME && segments[2] === VIRTUAL_COSTUME_ORDER_FILE_NAME;
};

const isVirtualDataFilePath = (path: string) => {
  const segments = splitVirtualPath(path);
  const fileName = segments[segments.length - 1];
  return (
    (segments.length === 1 || segments.length === 2 || (segments.length === 3 && segments[0] === VIRTUAL_STAGE_FOLDER_NAME)) &&
    [VIRTUAL_VARIABLES_FILE_NAME, VIRTUAL_VARIABLES_FILE_ALIAS, VIRTUAL_LISTS_FILE_NAME, VIRTUAL_LISTS_FILE_ALIAS].includes(fileName)
  );
};

const getVirtualDataKindFromPath = (path: string): "variables" | "lists" | null => {
  const fileName = getVirtualBaseName(path);
  if ([VIRTUAL_VARIABLES_FILE_NAME, VIRTUAL_VARIABLES_FILE_ALIAS].includes(fileName)) return "variables";
  if ([VIRTUAL_LISTS_FILE_NAME, VIRTUAL_LISTS_FILE_ALIAS].includes(fileName)) return "lists";
  return null;
};

const createScratchCommentId = () =>
  (window as any)?.Blockly?.Utils?.genUid?.() || `ai-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

const extractSvgCodeFromText = (value: string) => {
  const text = String(value || "").trim();
  const match = text.match(/<svg[\s\S]*<\/svg>/i);
  if (!match) {
    throw new Error("SVG file content must contain a complete <svg>...</svg> document.");
  }
  return match[0].trim();
};

const SVG_ROTATION_CENTER_X_ATTR = "data-rotation-center-x";
const SVG_ROTATION_CENTER_Y_ATTR = "data-rotation-center-y";

const readSvgNumberAttr = (text: string, name: string) => {
  const match = text.match(new RegExp(`\\b${escapeRegExp(name)}\\s*=\\s*["']?(-?(?:\\d+\\.?\\d*|\\.\\d+)(?:e[+-]?\\d+)?)`, "i"));
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
};

const formatSvgNumberAttr = (value: number) => {
  if (!Number.isFinite(value)) return "0";
  return Number(value.toFixed(6)).toString();
};

const getSvgRootTag = (svgCode: string) => {
  const match = svgCode.match(/<svg\b[^>]*>/i);
  return match ? { tag: match[0], index: match.index || 0 } : null;
};

const readSvgRootNumberAttr = (svgCode: string, name: string) => {
  const root = getSvgRootTag(svgCode);
  return root ? readSvgNumberAttr(root.tag, name) : null;
};

const getSvgSize = (svgCode: string) => {
  const viewBox =
    /viewBox=["']([^"']+)["']/i
      .exec(svgCode)?.[1]
      .split(/[?,]/)
      .map(Number) || [];
  const width = readSvgRootNumberAttr(svgCode, "width") || viewBox[2] || 480;
  const height = readSvgRootNumberAttr(svgCode, "height") || viewBox[3] || 360;
  return { width, height };
};

const getSvgGeometry = (svgCode: string) => {
  const viewBox =
    /viewBox=["']([^"']+)["']/i
      .exec(svgCode)?.[1]
      .split(/[?,]/)
      .map(Number) || [];
  const viewBoxX = Number.isFinite(viewBox[0]) ? viewBox[0] : 0;
  const viewBoxY = Number.isFinite(viewBox[1]) ? viewBox[1] : 0;
  const width = readSvgRootNumberAttr(svgCode, "width") || viewBox[2] || 480;
  const height = readSvgRootNumberAttr(svgCode, "height") || viewBox[3] || 360;
  const defaultRotationCenterX = viewBoxX + width / 2;
  const defaultRotationCenterY = viewBoxY + height / 2;
  const explicitRotationCenterX = readSvgRootNumberAttr(svgCode, SVG_ROTATION_CENTER_X_ATTR);
  const explicitRotationCenterY = readSvgRootNumberAttr(svgCode, SVG_ROTATION_CENTER_Y_ATTR);
  return {
    viewBoxX,
    viewBoxY,
    width,
    height,
    rotationCenterX: explicitRotationCenterX ?? defaultRotationCenterX,
    rotationCenterY: explicitRotationCenterY ?? defaultRotationCenterY,
    defaultRotationCenterX,
    defaultRotationCenterY,
    hasRotationCenterXAttr: explicitRotationCenterX !== null,
    hasRotationCenterYAttr: explicitRotationCenterY !== null,
    hasRotationCenterAttrs: explicitRotationCenterX !== null && explicitRotationCenterY !== null,
  };
};

const ensureSvgRotationCenterAttrs = (svgCode: string) => {
  const geometry = getSvgGeometry(svgCode);
  const root = getSvgRootTag(svgCode);
  if (!root || geometry.hasRotationCenterAttrs) {
    return { svgCode, geometry, changed: false };
  }

  const insertion = `${geometry.hasRotationCenterXAttr ? "" : ` ${SVG_ROTATION_CENTER_X_ATTR}="${formatSvgNumberAttr(geometry.rotationCenterX)}"`}${geometry.hasRotationCenterYAttr ? "" : ` ${SVG_ROTATION_CENTER_Y_ATTR}="${formatSvgNumberAttr(geometry.rotationCenterY)}"`}`;
  const insertAt = root.index + root.tag.length - (root.tag.endsWith("/>") ? 2 : 1);
  const normalizedSvgCode = `${svgCode.slice(0, insertAt)}${insertion}${svgCode.slice(insertAt)}`;
  return { svgCode: normalizedSvgCode, geometry: getSvgGeometry(normalizedSvgCode), changed: true };
};

const normalizePatchContextLine = (line: string) => {
  const raw = String(line || "").trim();
  if (/^path\s*:/i.test(raw)) return "path:<virtual>";
  if (/^targetId\s*:/i.test(raw)) return "targetId:<runtime>";

  let normalized = String(line || "")
    .replace(/\s*\/\/\s*blockId\s*:.*$/i, "")
    .trim()
    .replace(/;+\s*$/g, "")
    .replace(/\s+/g, " ");

  normalized = normalized.replace(
    /event\.(broadcast(?:andwait)?)\(\{\s*BROADCAST_INPUT:\s*event\.broadcast_menu\(\{\s*\$field_BROADCAST_OPTION:\s*("[^"]*"|'[^']*')\s*\}\)\s*\}\)/g,
    "event.$1({ BROADCAST_INPUT: $2 })",
  );

  return normalized;
};

const findLooseHunkLineRange = (content: string, oldText: string) => {
  const contentLines = content.split("\n");
  const oldLines = oldText.split("\n");
  let effectiveOldLines = oldLines;
  while (
    effectiveOldLines.length > 0 &&
    normalizePatchContextLine(effectiveOldLines[effectiveOldLines.length - 1]) === ""
  ) {
    effectiveOldLines = effectiveOldLines.slice(0, -1);
  }
  const normalizedOldLines = effectiveOldLines.map(normalizePatchContextLine);

  if (effectiveOldLines.length === 0 || normalizedOldLines.every((line) => !line)) return null;

  for (let start = 0; start <= contentLines.length - effectiveOldLines.length; start += 1) {
    let matched = true;
    for (let offset = 0; offset < effectiveOldLines.length; offset += 1) {
      if (normalizePatchContextLine(contentLines[start + offset]) !== normalizedOldLines[offset]) {
        matched = false;
        break;
      }
    }
    if (matched) {
      return { start, end: start + effectiveOldLines.length };
    }
  }

  return null;
};

const buildHunkMismatchDetails = (content: string, oldText: string) => {
  const contentLines = content.replace(/\r\n?/g, "\n").split("\n");
  const firstNeedle = oldText
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);
  const normalizedNeedle = firstNeedle ? normalizePatchContextLine(firstNeedle) : "";

  let center = 0;
  if (normalizedNeedle) {
    const found = contentLines.findIndex((line) => {
      const normalizedLine = normalizePatchContextLine(line);
      return normalizedLine.includes(normalizedNeedle) || normalizedNeedle.includes(normalizedLine);
    });
    if (found >= 0) center = found;
  }

  const start = Math.max(0, center - 4);
  const end = Math.min(contentLines.length, center + 5);
  const currentSnippet = contentLines
    .slice(start, end)
    .map((line, index) => `${start + index + 1}: ${line}`)
    .join("\n");

  return {
    firstExpectedLine: firstNeedle || null,
    currentSnippet,
    suggestedAction:
      "Re-read the file or retry using the currentSnippet line content as patch context; Scratch serialization may have normalized strings, menus, or formatting.",
  };
};

const normalizeVirtualCodeForCompare = (value: string) =>
  normalizeModelUCF(value)
    .replace(/[ \t]+$/gm, "")
    .trim();

const getLineCount = (content: string) => (content ? content.split("\n").length : 1);

const buildScratchAgentDoc = () => `# Scratch Agent Virtual Files

Edit Scratch through virtual files and applyPatch. Use getScratchGuide for examples and getBlocksHelp for exact block syntax.

Workflow: getProjectOverview -> read only needed files -> applyPatch stable paths -> getDiagnostics. Use sub agents for non-trivial Scratch tasks when useful; the parent AI remains responsible for final integration.
Paths:
- Code: /<target>/scripts/*.js are feature files. A file may contain multiple // @script <id> sections; each section must produce exactly one top-level stack. /<target>/script.js is a read-only legacy aggregate.
- Assets: /<target>/custom/*.svg for editable vector costumes/backdrops, /<target>/custom/order.json for costume order, /<target>/audio/* for audio reference/deletion.
- Sprites: Add File /新角色名 creates, Move to renames, Delete File deletes. Stage is fixed at /stage.
- Data: /variables.json and /lists.json are global. /stage/... and /<target>/... data paths plus Chinese aliases are compatibility aliases, not private target data.

Key rules:
- Script references auto-create global variables/lists; patch data JSON only for bulk initialization, rename, deletion, or explicit value edits.
- Reorder costumes by reordering the array entries in /<target>/custom/order.json; keep every current costume exactly once.
- SVG root data-rotation-center-x/y controls Scratch pivot; missing values are normalized to the SVG geometric center.
- Invalid script drafts are preserved without changing Scratch blocks; valid sync may return submitted_to_synced normalizedDiffs.
- JS comments immediately before block calls become Scratch comments; top-level $xy positions stacks.
- Fields/selectors use $field_*; inputs use plain keys; Boolean slots need Boolean reporters; substacks use arrow functions; custom block parameters use argument.reporter_* with $field_VALUE, not data.variable.
- Prefer custom blocks with info: ["warp"] for reusable logic, algorithms, and pen rendering; use broadcasts for cross-target orchestration.

Guides: extension-index, quickstart, events, data, control, procedures, custom-args, dynamic-blocks, rendering, menus, pen, patching, debugging.`;

const extractVirtualScriptSections = (content: string): VirtualScriptSection[] => {
  const normalizedContent = String(content || "").replace(/\r\n?/g, "\n");
  const lines = normalizedContent.split("\n");
  const markers: Array<{ index: number; scriptId: string }> = [];

  lines.forEach((line, index) => {
    const match = SCRIPT_MARKER_RE.exec(line);
    if (match) {
      markers.push({
        index,
        scriptId: match[1],
      });
    }
  });

  return markers.map((marker, index) => {
    const nextMarker = markers[index + 1];
    const codeStart = marker.index + 1;
    const codeEndExclusive = nextMarker ? nextMarker.index : lines.length;
    const code = lines.slice(codeStart, codeEndExclusive).join("\n").trim();

    return {
      scriptId: marker.scriptId,
      markerLine: marker.index + 1,
      startLine: codeStart + 1,
      endLine: codeEndExclusive,
      code,
      normalizedCode: normalizeVirtualCodeForCompare(code),
      isNew: /^new(?:[-_:].*)?$/i.test(marker.scriptId),
    };
  });
};

const parseCodexPatch = (patch: string): ParsedPatchOperation[] => {
  const lines = String(patch || "")
    .replace(/\r\n?/g, "\n")
    .split("\n");
  const operations: ParsedPatchOperation[] = [];
  let currentOperation: ParsedPatchOperation | null = null;
  let currentHunk: string[] | null = null;

  const normalizeReplacementContent = (rawLines: string[] = []) => {
    const replacementLines = [...rawLines];
    if (replacementLines[0]?.trim().startsWith("```")) {
      replacementLines.shift();
      if (replacementLines[replacementLines.length - 1]?.trim().startsWith("```")) {
        replacementLines.pop();
      }
    }
    return replacementLines.join("\n");
  };

  const flushHunk = () => {
    if (currentOperation?.type === "update" && currentHunk && currentHunk.length > 0) {
      currentOperation.hunks.push(currentHunk);
    }
    currentHunk = null;
  };

  const flushReplacement = () => {
    if (currentOperation?.type === "update" && currentOperation.rawReplacementLines?.length) {
      currentOperation.replacementContent = normalizeReplacementContent(currentOperation.rawReplacementLines);
    }
    if (currentOperation?.type === "add" && currentOperation.rawReplacementLines?.length) {
      currentOperation.content = normalizeReplacementContent(currentOperation.rawReplacementLines);
    }
  };

  for (const line of lines) {
    if (line === "*** Begin Patch" || line === "*** End Patch") {
      continue;
    }

    if (line.startsWith("*** Add File:")) {
      flushHunk();
      flushReplacement();
      currentOperation = {
        type: "add",
        path: normalizeVirtualPath(line.slice("*** Add File:".length).trim()),
        content: "",
        rawReplacementLines: [],
      };
      operations.push(currentOperation);
      continue;
    }

    if (line.startsWith("*** Delete File:")) {
      flushHunk();
      flushReplacement();
      currentOperation = {
        type: "delete",
        path: normalizeVirtualPath(line.slice("*** Delete File:".length).trim()),
      };
      operations.push(currentOperation);
      continue;
    }

    if (line.startsWith("*** Update File:")) {
      flushHunk();
      flushReplacement();
      currentOperation = {
        type: "update",
        path: normalizeVirtualPath(line.slice("*** Update File:".length).trim()),
        hunks: [],
        rawReplacementLines: [],
      };
      operations.push(currentOperation);
      continue;
    }

    if (line.startsWith("*** Move to:")) {
      if (currentOperation?.type !== "update") {
        throw new Error("Move to appears before an Update File header.");
      }
      currentOperation.moveTo = normalizeVirtualPath(line.slice("*** Move to:".length).trim());
      continue;
    }

    if (line.startsWith("@@")) {
      if (!currentOperation) {
        throw new Error("Patch hunk appears before an Update File header.");
      }
      if (currentOperation.type !== "update") {
        throw new Error(`Patch hunks are only supported for Update File operations: ${currentOperation.path}.`);
      }
      if (currentOperation.rawReplacementLines?.length) {
        throw new Error(`Cannot mix raw replacement content and hunk patch lines in ${currentOperation.path}.`);
      }
      flushHunk();
      currentHunk = [];
      continue;
    }

    if (!currentOperation) {
      if (line.trim()) {
        throw new Error(`Unexpected patch line before file header: ${line}`);
      }
      continue;
    }

    if (line.startsWith("\\ No newline at end of file")) {
      continue;
    }

    if (currentOperation.type === "delete") {
      if (line.trim()) {
        throw new Error(`Unexpected content after Delete File ${currentOperation.path}: ${line}`);
      }
      continue;
    }

    if (currentHunk) {
      if (!line) {
        currentHunk.push(" ");
        continue;
      }
      if (line[0] === " " || line[0] === "-" || line[0] === "+") {
        currentHunk.push(line);
        continue;
      }
      // Be forgiving: models often omit the leading space on context lines after @@.
      currentHunk.push(` ${line}`);
      continue;
    }

    if (currentOperation.type === "add") {
      currentOperation.rawReplacementLines?.push(line.startsWith("+") ? line.slice(1) : line);
    } else {
      currentOperation.rawReplacementLines?.push(line);
    }
  }

  flushHunk();
  flushReplacement();

  if (operations.length === 0) {
    throw new Error("Patch contains no file operations.");
  }

  for (const operation of operations) {
    if (
      operation.type === "update" &&
      !operation.moveTo &&
      operation.hunks.length === 0 &&
      operation.replacementContent === undefined
    ) {
      throw new Error(`Patch update for ${operation.path} has no hunks, replacement content, or move destination.`);
    }
  }

  return operations;
};

const applyTextHunks = (content: string, hunks: string[][]) => {
  let nextContent = content.replace(/\r\n?/g, "\n");
  let cursor = 0;

  for (const hunk of hunks) {
    const oldText = hunk
      .filter((line) => !line.startsWith("+"))
      .map((line) => line.slice(1))
      .join("\n");
    const newText = hunk
      .filter((line) => !line.startsWith("-"))
      .map((line) => line.slice(1))
      .join("\n");
    const index = nextContent.indexOf(oldText, cursor);

    if (index === -1) {
      const looseRange = findLooseHunkLineRange(nextContent, oldText);
      if (!looseRange) {
        throw new Error(
          "Patch hunk did not match current virtual file content. Re-read the file and retry with the current text; Scratch may have normalized it.",
        );
      }

      const currentLines = nextContent.split("\n");
      currentLines.splice(looseRange.start, looseRange.end - looseRange.start, ...newText.split("\n"));
      nextContent = currentLines.join("\n");
      cursor = currentLines.slice(0, looseRange.start).join("\n").length + newText.length;
      continue;
    }

    nextContent = `${nextContent.slice(0, index)}${newText}${nextContent.slice(index + oldText.length)}`;
    cursor = index + newText.length;
  }

  return nextContent;
};

const buildCompactLineDiff = (before: string, after: string, maxLines = 80) => {
  const beforeLines = String(before || "").replace(/\r\n?/g, "\n").split("\n");
  const afterLines = String(after || "").replace(/\r\n?/g, "\n").split("\n");
  if (beforeLines.join("\n") === afterLines.join("\n")) return "";

  let prefix = 0;
  while (prefix < beforeLines.length && prefix < afterLines.length && beforeLines[prefix] === afterLines[prefix]) {
    prefix += 1;
  }

  let suffix = 0;
  while (
    suffix < beforeLines.length - prefix &&
    suffix < afterLines.length - prefix &&
    beforeLines[beforeLines.length - 1 - suffix] === afterLines[afterLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const context = 3;
  const start = Math.max(0, prefix - context);
  const beforeEnd = beforeLines.length - suffix;
  const afterEnd = afterLines.length - suffix;
  const diffLines: string[] = [];
  if (start > 0) diffLines.push("...");
  beforeLines.slice(start, prefix).forEach((line) => diffLines.push(` ${line}`));
  beforeLines.slice(prefix, beforeEnd).forEach((line) => diffLines.push(`-${line}`));
  afterLines.slice(prefix, afterEnd).forEach((line) => diffLines.push(`+${line}`));
  afterLines.slice(afterEnd, Math.min(afterLines.length, afterEnd + context)).forEach((line) => diffLines.push(` ${line}`));
  if (afterEnd + context < afterLines.length) diffLines.push("...");

  return diffLines.slice(0, maxLines).join("\n");
};

const clonePlainObject = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export class AITools {
  static AllBlockInfo: Record<string, string> = {
    control_repeat: "repeat [TIMES] times (TIMES: number)",
    control_repeat_until: "repeat until [CONDITION] (CONDITION: Boolean)",
    control_while: "while [CONDITION] repeat (CONDITION: Boolean)",
    control_for_each: "for each [VARIABLE] in [VALUE] (VARIABLE: string, VALUE: string)",
    control_forever: "forever",
    control_wait: "wait [DURATION] seconds (DURATION: number)",
    control_wait_until: "wait until [CONDITION] (CONDITION: Boolean)",
    control_if: "if [CONDITION] then (CONDITION: Boolean)",
    control_if_else: "if [CONDITION] then else (CONDITION: Boolean)",
    control_stop: "stop [STOP_OPTION] (STOP_OPTION: string)",
    control_start_as_clone: "when I start as a clone",
    control_create_clone_of: "create clone of [CLONE_OPTION] (CLONE_OPTION: string)",
    control_delete_this_clone: "delete this clone",
    control_get_counter: "counter",
    control_incr_counter: "increment counter",
    control_clear_counter: "clear counter",
    control_all_at_once: "all at once",
    event_whenflagclicked: "when green flag clicked",
    event_whenkeypressed: "when [KEY_OPTION] key pressed (KEY_OPTION: string)",
    event_whenbroadcastreceived: "when I receive [BROADCAST_OPTION] (BROADCAST_OPTION: broadcast)",
    event_whentouchingobject: "when touching [TOUCHINGOBJECTMENU] (TOUCHINGOBJECTMENU: string)",
    event_broadcast: "broadcast [BROADCAST_INPUT] (BROADCAST_INPUT: string)",
    event_broadcastandwait: "broadcast [BROADCAST_INPUT] and wait (BROADCAST_INPUT: string)",
    event_whengreaterthan: "when [WHENGREATERTHANMENU] > [VALUE] (WHENGREATERTHANMENU: string, VALUE: number)",
    looks_say: "say [MESSAGE] (MESSAGE: string)",
    looks_sayforsecs: "say [MESSAGE] for [SECS] seconds (MESSAGE: string, SECS: number)",
    looks_think: "think [MESSAGE] (MESSAGE: string)",
    looks_thinkforsecs: "think [MESSAGE] for [SECS] seconds (MESSAGE: string, SECS: number)",
    looks_show: "show",
    looks_hide: "hide",
    looks_hideallsprites: "hide all sprites",
    looks_switchcostumeto: "switch costume to [COSTUME] (COSTUME: string)",
    looks_switchbackdropto: "switch backdrop to [BACKDROP] (BACKDROP: string)",
    looks_switchbackdroptoandwait: "switch backdrop to [BACKDROP] and wait (BACKDROP: string)",
    looks_nextcostume: "next costume",
    looks_nextbackdrop: "next backdrop",
    looks_changeeffectby: "change [EFFECT] effect by [CHANGE] (EFFECT: string, CHANGE: number)",
    looks_seteffectto: "set [EFFECT] effect to [VALUE] (EFFECT: string, VALUE: number)",
    looks_cleargraphiceffects: "clear graphic effects",
    looks_changesizeby: "change size by [CHANGE] (CHANGE: number)",
    looks_setsizeto: "set size to [SIZE] (SIZE: number)",
    looks_changestretchby: "change stretch by [CHANGE] (CHANGE: number)",
    looks_setstretchto: "set stretch to [STRETCH] (STRETCH: number)",
    looks_gotofrontback: "go to [FRONT_BACK] layer (FRONT_BACK: string)",
    looks_goforwardbackwardlayers: "go [FORWARD_BACKWARD] [NUM] layers (FORWARD_BACKWARD: string, NUM: number)",
    looks_size: "size",
    looks_costumenumbername: "costume [NUMBER_NAME] (NUMBER_NAME: string)",
    looks_backdropnumbername: "backdrop [NUMBER_NAME] (NUMBER_NAME: string)",
    motion_movesteps: "move [STEPS] steps (STEPS: number)",
    motion_movegrids: "move [STEPS] grids (STEPS: number)",
    motion_gotoxy: "go to x:[X] y:[Y] (X: number, Y: number)",
    motion_goto: "go to [TO] (TO: string)",
    motion_turnright: "turn right [DEGREES] degrees (DEGREES: number)",
    motion_turnleft: "turn left [DEGREES] degrees (DEGREES: number)",
    motion_pointindirection: "point in direction [DIRECTION] (DIRECTION: number)",
    motion_pointtowards: "point towards [TOWARDS] (TOWARDS: string)",
    motion_glidesecstoxy: "glide [SECS] seconds to x:[X] y:[Y] (SECS: number, X: number, Y: number)",
    motion_glideto: "glide [SECS] seconds to [TO] (SECS: number, TO: string)",
    motion_ifonedgebounce: "if on edge, bounce",
    motion_setrotationstyle: "set rotation style [STYLE] (STYLE: string)",
    motion_changexby: "change x by [DX] (DX: number)",
    motion_setx: "set x to [X] (X: number)",
    motion_changeyby: "change y by [DY] (DY: number)",
    motion_sety: "set y to [Y] (Y: number)",
    motion_xposition: "x position",
    motion_yposition: "y position",
    motion_direction: "direction",
    motion_scroll_right: "scroll right [DISTANCE] (DISTANCE: number)",
    motion_scroll_up: "scroll up [DISTANCE] (DISTANCE: number)",
    motion_align_scene: "align scene [ALIGNMENT] (ALIGNMENT: string)",
    motion_xscroll: "x scroll",
    motion_yscroll: "y scroll",
    operator_add: "[NUM1] + [NUM2] (NUM1: number, NUM2: number)",
    operator_subtract: "[NUM1] - [NUM2] (NUM1: number, NUM2: number)",
    operator_multiply: "[NUM1] * [NUM2] (NUM1: number, NUM2: number)",
    operator_divide: "[NUM1] / [NUM2] (NUM1: number, NUM2: number)",
    operator_lt: "[OPERAND1] < [OPERAND2]",
    operator_equals: "[OPERAND1] = [OPERAND2]",
    operator_gt: "[OPERAND1] > [OPERAND2]",
    operator_and: "[OPERAND1] and [OPERAND2] (OPERAND1: Boolean, OPERAND2: Boolean)",
    operator_or: "[OPERAND1] or [OPERAND2] (OPERAND1: Boolean, OPERAND2: Boolean)",
    operator_not: "not [OPERAND] (OPERAND: Boolean)",
    operator_random: "pick random [FROM] to [TO] (FROM: number, TO: number)",
    operator_join: "join [STRING1] [STRING2] (STRING1: string, STRING2: string)",
    operator_letter_of: "letter [LETTER] of [STRING] (STRING: string, LETTER: number)",
    operator_length: "length of [STRING] (STRING: string)",
    operator_contains: "[STRING1] contains [STRING2] (STRING1: string, STRING2: string)",
    operator_mod: "[NUM1] mod [NUM2] (NUM1: number, NUM2: number)",
    operator_round: "round [NUM] (NUM: number)",
    operator_mathop: "[OPERATOR] of [NUM] (OPERATOR: string, NUM: number)",
    sound_play: "start sound [SOUND_MENU] (SOUND_MENU: string)",
    sound_playuntildone: "play sound [SOUND_MENU] until done (SOUND_MENU: string)",
    sound_stopallsounds: "stop all sounds",
    sound_seteffectto: "set [EFFECT] sound effect to [VALUE] (EFFECT: string, VALUE: number)",
    sound_changeeffectby: "change [EFFECT] sound effect by [VALUE] (EFFECT: string, VALUE: number)",
    sound_cleareffects: "clear sound effects",
    sound_sounds_menu: "sound [SOUND_MENU] (SOUND_MENU: string)",
    sound_beats_menu: "beats [BEATS] (BEATS: number)",
    sound_effects_menu: "sound effect [EFFECT] (EFFECT: string)",
    sound_setvolumeto: "set volume to [VOLUME] (VOLUME: number)",
    sound_changevolumeby: "change volume by [VOLUME] (VOLUME: number)",
    sound_volume: "volume",
    sensing_touchingobject: "touching [TOUCHINGOBJECTMENU] (TOUCHINGOBJECTMENU: string)",
    sensing_touchingcolor: "touching color [COLOR] (COLOR: string)",
    sensing_coloristouchingcolor: "color [COLOR] touching [COLOR2] (COLOR: string, COLOR2: string)",
    sensing_distanceto: "distance to [DISTANCETOMENU] (DISTANCETOMENU: string)",
    sensing_timer: "timer",
    sensing_resettimer: "reset timer",
    sensing_of: "[PROPERTY] of [OBJECT] (OBJECT: string, PROPERTY: string)",
    sensing_mousex: "mouse x",
    sensing_mousey: "mouse y",
    sensing_setdragmode: "set drag mode [DRAG_MODE] (DRAG_MODE: string)",
    sensing_mousedown: "mouse down",
    sensing_keypressed: "key [KEY_OPTION] pressed (KEY_OPTION: string)",
    sensing_current: "current [CURRENTMENU] (CURRENTMENU: string)",
    sensing_dayssince2000: "days since 2000",
    sensing_loudness: "loudness",
    sensing_loud: "loud",
    sensing_askandwait: "ask [QUESTION] and wait (QUESTION: string)",
    sensing_answer: "answer",
    sensing_username: "username",
    sensing_userid: "user id",
    data_variable: "variable [VARIABLE] (VARIABLE: variable)",
    data_setvariableto: "set [VARIABLE] to [VALUE] (VARIABLE: variable, VALUE: string)",
    data_changevariableby: "change [VARIABLE] by [VALUE] (VARIABLE: variable, VALUE: number)",
    data_hidevariable: "hide variable [VARIABLE] (VARIABLE: variable)",
    data_showvariable: "show variable [VARIABLE] (VARIABLE: variable)",
    data_listcontents: "list [LIST] (LIST: list)",
    data_addtolist: "add [ITEM] to [LIST] (ITEM: string, LIST: list)",
    data_deleteoflist: "delete item [INDEX] of [LIST] (LIST: list, INDEX: string)",
    data_deletealloflist: "delete all of [LIST] (LIST: list)",
    data_insertatlist: "insert [ITEM] at [INDEX] of [LIST] (LIST: list, INDEX: string, ITEM: string)",
    data_replaceitemoflist: "replace item [INDEX] of [LIST] with [ITEM] (LIST: list, INDEX: string, ITEM: string)",
    data_itemoflist: "item [INDEX] of [LIST] (LIST: list, INDEX: string)",
    data_itemnumoflist: "item # of [ITEM] in [LIST] (ITEM: string, LIST: list)",
    data_lengthoflist: "length of [LIST] (LIST: list)",
    data_listcontainsitem: "[LIST] contains [ITEM] (LIST: list, ITEM: string)",
    data_hidelist: "hide list [LIST] (LIST: list)",
    data_showlist: "show list [LIST] (LIST: list)",
    procedures_definition: "custom block definition",
    procedures_call: "call custom block [PROCEDURE] (PROCEDURE: string)",
    procedures_call_with_return: "call custom block [PROCEDURE] with return (PROCEDURE: string)",
  };

  static BlockSearchAliases: Record<string, string[]> = {
    event_whenflagclicked: ["green flag", "start"],
    event_whenbroadcastreceived: ["receive broadcast", "broadcast trigger"],
    event_broadcast: ["broadcast", "send broadcast"],
    event_broadcastandwait: ["broadcast and wait"],
    control_forever: ["forever", "repeat forever", "loop forever"],
    control_repeat: ["repeat", "repeat times", "loop"],
    control_repeat_until: ["repeat until"],
    control_wait: ["wait", "wait seconds"],
    control_wait_until: ["wait until"],
    control_if: ["if", "condition"],
    control_if_else: ["if else", "condition branch"],
    control_create_clone_of: ["create clone", "clone"],
    control_delete_this_clone: ["delete clone", "delete this clone"],
    control_start_as_clone: ["when i start as clone", "start as clone"],
    motion_gotoxy: ["go to x y", "goto xy", "move to x y"],
    motion_goto: ["go to random position", "go to mouse pointer", "go to sprite"],
    motion_setx: ["set x", "set x to"],
    motion_changexby: ["change x", "change x by"],
    motion_sety: ["set y", "set y to"],
    motion_changeyby: ["change y", "change y by"],
    motion_ifonedgebounce: ["if on edge bounce", "edge bounce"],
    sensing_touchingobject: ["touching edge", "touching object", "touching sprite"],
    sensing_keypressed: ["key pressed", "press key"],
    sensing_timer: ["timer"],
    sensing_mousedown: ["mouse down", "mousedown"],
    sound_play: ["sound.play", "sound_play", "play sound"],
    sound_playuntildone: ["sound.playuntildone", "sound_playuntildone", "play sound until done"],
    operator_lt: ["less", "operator.less", "operator.lt", "<"],
    operator_gt: ["greater", "operator.greater", "operator.gt", ">"],
    operator_equals: ["equal", "operator.equal", "operator.equals", "=="],
    pen_penDown: ["pen down", "pen.down", "pen.penDown", "pen_penDown"],
    pen_penUp: ["pen up", "pen.up", "pen.penUp", "pen_penUp"],
    argument_reporter_string_number: [
      'argument.reporter_string_number({ $field_VALUE: "highlight" })',
      "custom block argument reporter",
      "$field_VALUE",
    ],
    argument_reporter_boolean: [
      'argument.reporter_boolean({ $field_VALUE: "enabled" })',
      "custom block Boolean argument reporter",
      "$field_VALUE",
    ],
    pen_setPenColorParamTo: [
      'pen.setPenColorParamTo({ $field_COLOR_PARAM: "color", VALUE: 50 })',
      "set pen color parameter",
      "COLOR_PARAM menu values: color, saturation, brightness, transparency",
      "$field_COLOR_PARAM",
    ],
    pen_changePenColorParamBy: [
      'pen.changePenColorParamBy({ $field_COLOR_PARAM: "brightness", VALUE: 10 })',
      "change pen color parameter",
      "COLOR_PARAM menu values: color, saturation, brightness, transparency",
      "$field_COLOR_PARAM",
    ],
    procedures_definition: ["custom block definition", "define block", "define function"],
    procedures_call: ["call custom block", "call function", "run custom block"],
    procedures_call_with_return: ["call custom block with return", "return value block", "return value function"],
  };

  vm: any;

  private userGuides: UserGuide[];

  private workspace?: Blockly.WorkspaceSvg | null;

  private blockly?: any;

  private virtualFileDrafts = new Map<string, { content: string; diagnostics: any; updatedAt: number }>();

  private scriptFileNameByScriptKey = new Map<string, string>();

  private scriptUcfCache = new Map<string, { signature: string; content: string }>();

  private blockInfoCache = new Map<string, any>();

  private guideActions?: {
    createAiGuide?: (guide: Partial<UserGuide>) => UserGuide;
  };

  constructor(
    vm: any,
    userGuides: UserGuide[] = [],
    workspace?: Blockly.WorkspaceSvg | null,
    blockly?: any,
    guideActions?: { createAiGuide?: (guide: Partial<UserGuide>) => UserGuide },
  ) {
    this.vm = vm;
    this.userGuides = userGuides;
    this.workspace = workspace || null;
    this.blockly = blockly || null;
    this.guideActions = guideActions;
    if (vm?.runtime) {
      setRuntime(vm.runtime);
      repairListVariableValues(vm);
      this._repairAiAssistantMetadataRecords();
    }
    const fn = (opcode: string) => this.getBlockInfo(opcode);
    if (typeof fn === "function") {
      setGetBlockInfoTool(fn);
    }
  }

  private _getWorkspace() {
    return (
      this.workspace ||
      this.blockly?.getMainWorkspace?.() ||
      window.Blockly?.getMainWorkspace?.() ||
      null
    ) as Blockly.WorkspaceSvg | null;
  }

  private _repairAiAssistantMetadataRecords() {
    const targets = Array.isArray(this.vm?.runtime?.targets) ? this.vm.runtime.targets : [];
    targets.forEach((target: any) => {
      this._repairAiAssistantScriptFilesComment(target);
      this._repairTargetDataRecords(target);
    });
  }

  private _repairTargetDataRecords(target: any) {
    if (!target?.variables || typeof target.variables !== "object") return;
    Object.entries(target.variables).forEach(([id, variable]: [string, any]) => {
      if (!variable || typeof variable !== "object" || typeof variable.toXML === "function") return;
      target.variables[id] = this._ensureVariableXmlSerializable(target, variable, variable?.type === "list" ? "lists" : "variables");
    });
  }

  private _getTarget(targetId?: string) {
    return targetId ? this.vm.runtime.getTargetById(targetId) : this.vm.editingTarget;
  }

  private _getBlocks(targetId?: string) {
    const target = this._getTarget(targetId);
    if (!target?.blocks?._blocks) {
      return null;
    }

    return {
      target,
      blocks: target.blocks._blocks as Record<string, any>,
    };
  }

  private _getTargetName(target: any) {
    return target?.getName?.() || target?.sprite?.name || target?.id || "target";
  }

  private _getVirtualPathMapForTargets(targets: any[]) {
    const nameCounts = new Map<string, number>();
    const nameSeen = new Map<string, number>();

    targets.forEach((target) => {
      if (target?.isStage) return;
      const name = sanitizeSpriteFolderName(this._getTargetName(target));
      nameCounts.set(name, (nameCounts.get(name) || 0) + 1);
    });

    const pathByTargetId = new Map<string, string>();
    targets.forEach((target) => {
      if (!target?.id) return;
      if (target.isStage) {
        pathByTargetId.set(target.id, VIRTUAL_STAGE_SCRIPT_PATH);
        return;
      }

      const name = sanitizeSpriteFolderName(this._getTargetName(target));
      const index = (nameSeen.get(name) || 0) + 1;
      nameSeen.set(name, index);
      const suffix = (nameCounts.get(name) || 0) > 1 ? `.${index}` : "";
      pathByTargetId.set(target.id, `/${name}${suffix}/${VIRTUAL_SCRIPT_FILE_NAME}`);
    });

    return pathByTargetId;
  }

  private _getVirtualPathForTarget(target: any, pathByTargetId?: Map<string, string>) {
    if (target?.id && pathByTargetId?.has(target.id)) {
      return pathByTargetId.get(target.id) || VIRTUAL_STAGE_SCRIPT_PATH;
    }
    if (target?.isStage) return VIRTUAL_STAGE_SCRIPT_PATH;
    const name = sanitizeSpriteFolderName(this._getTargetName(target));
    return `/${name}/${VIRTUAL_SCRIPT_FILE_NAME}`;
  }

  private _getVirtualRootPathForTarget(target: any, pathByTargetId?: Map<string, string>) {
    return getVirtualParentPath(this._getVirtualPathForTarget(target, pathByTargetId));
  }

  private _getVirtualPathAliasesForTarget(target: any, canonicalPath: string) {
    if (target?.isStage) return [];

    const name = sanitizeSpriteFolderName(this._getTargetName(target));
    const aliases = new Set<string>();
    [target?.id, target?.originalTargetId].filter(Boolean).forEach((id) => {
      aliases.add(`/${name}.${sanitizePathSegment(String(id), "target")}/${VIRTUAL_SCRIPT_FILE_NAME}`);
    });
    aliases.delete(canonicalPath);
    return [...aliases];
  }

  private _getVirtualDirContent(path: string, children: string[]) {
    return [`# ${path}`, "", ...children.map((child) => `- ${child}`)].join("\n").trimEnd();
  }

  private _decodeAssetText(asset: any) {
    if (!asset) return "";
    if (typeof asset.decodeText === "function") {
      return asset.decodeText();
    }
    const data = asset.data || new Uint8Array();
    return new TextDecoder().decode(
      data instanceof Uint8Array ? data : new Uint8Array(Object.values(data) as number[]),
    );
  }

  private _getAssetByteLength(asset: any) {
    const data = asset?.data;
    if (!data) return 0;
    return typeof data.byteLength === "number" ? data.byteLength : Number(data.length || 0);
  }

  private _getTargetCostumes(target: any) {
    return (
      typeof target?.getCostumes === "function" ? target.getCostumes() : target?.sprite?.costumes_ || []
    ) as any[];
  }

  private _getTargetSounds(target: any) {
    return (typeof target?.getSounds === "function" ? target.getSounds() : target?.sprite?.sounds || []) as any[];
  }

  private _getTargetVariables(target: any) {
    return Object.values(target?.variables || {}) as any[];
  }

  private _getTargetDataEntries(target: any, type: "variables" | "lists") {
    const isList = type === "lists";
    return this._getTargetVariables(target)
      .filter((item) => (isList ? Array.isArray(item?.value) || item?.type === "list" : !Array.isArray(item?.value) && item?.type !== "list"))
      .sort((left, right) => String(left?.name || "").localeCompare(String(right?.name || "")) || String(left?.id || "").localeCompare(String(right?.id || "")));
  }

  private _buildTargetDataJson(target: any, type: "variables" | "lists") {
    const items = this._getTargetDataEntries(target, type).map((item) =>
      type === "lists"
        ? {
            name: item?.name || item?.id || "list",
            value: Array.isArray(item?.value) ? item.value : [],
            id: item?.id,
          }
        : {
            name: item?.name || item?.id || "variable",
            value: item?.value ?? "",
            id: item?.id,
            isCloud: Boolean(item?.isCloud),
          },
    );
    return `${JSON.stringify(items, null, 2)}\n`;
  }

  private _parseTargetDataJson(content: string, type: "variables" | "lists") {
    let parsed: any;
    try {
      parsed = JSON.parse(content || "[]");
    } catch (error: any) {
      throw new Error(`Invalid ${type}.json: ${error?.message || String(error)}`);
    }
    if (!Array.isArray(parsed)) {
      throw new Error(`${type}.json must be a JSON array.`);
    }
    return parsed.map((item, index) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        throw new Error(`${type}.json item ${index + 1} must be an object.`);
      }
      const name = String(item.name || "").trim();
      if (!name) {
        throw new Error(`${type}.json item ${index + 1} requires a non-empty name.`);
      }
      return type === "lists"
        ? {
            name,
            value: Array.isArray(item.value) ? item.value : Array.isArray(item.items) ? item.items : [],
            id: item.id ? String(item.id) : null,
          }
        : {
            name,
            value: item.value ?? "",
            id: item.id ? String(item.id) : null,
            isCloud: Boolean(item.isCloud),
          };
    });
  }

  private _findTargetVariableByIdOrName(target: any, item: any, type: "variables" | "lists") {
    const entries = this._getTargetDataEntries(target, type);
    return (
      (item.id ? entries.find((variable) => variable?.id === item.id) : null) ||
      entries.find((variable) => variable?.name === item.name) ||
      null
    );
  }

  private _buildTargetVariableObject(target: any, id: string, item: any, type: "variables" | "lists") {
    const variableType = type === "lists" ? "list" : "";
    const existingVariable = this._getTargetVariables(target).find((variable) => variable?.constructor && typeof variable.constructor === "function");
    if (existingVariable?.constructor) {
      try {
        return new existingVariable.constructor(id, item.name, variableType, Boolean(item.isCloud), target?.id || "");
      } catch {
        // Fall through to the plain object shape used by Scratch variable records.
      }
    }
    const variable = {
      id,
      name: item.name,
      type: variableType,
      value: type === "lists" ? [] : "",
      isCloud: type === "variables" ? Boolean(item.isCloud) : false,
      targetId: target?.id || "",
      _monitorUpToDate: false,
      _name: item.name,
      _value: type === "lists" ? [] : "",
      toXML(isLocal?: boolean) {
        const local = isLocal === true;
        return `<variable type="${escapeXmlText(this.type)}" id="${escapeXmlText(this.id)}" islocal="${local}" iscloud="${Boolean(this.isCloud)}">${escapeXmlText(this.name)}</variable>`;
      },
    };
    return variable;
  }

  private _ensureVariableXmlSerializable(target: any, variable: any, type: "variables" | "lists") {
    const id = String(variable?.id || `${target?.id || "target"}-${type}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
    const name = String(variable?.name || variable?._name || (type === "lists" ? "list" : "variable"));
    const item = { ...variable, id, name, isCloud: Boolean(variable?.isCloud) };
    if (target?.variables?.[id] && typeof target.variables[id]?.toXML !== "function") {
      delete target.variables[id];
    }
    const repaired = this._buildTargetVariableObject(target, id, item, type);
    repaired.name = name;
    repaired.type = type === "lists" ? "list" : "";
    repaired.value = type === "lists" ? (Array.isArray(variable?.value) ? variable.value : []) : (variable?.value ?? "");
    repaired._value = repaired.value;
    repaired._name = repaired.name;
    if (type === "variables") repaired.isCloud = Boolean(variable?.isCloud);
    return repaired;
  }

  private _createTargetVariable(target: any, item: any, type: "variables" | "lists") {
    const id = item.id || `${target?.id || "target"}-${type}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    if (!target.variables || typeof target.variables !== "object") {
      target.variables = {};
    }
    const variable = this._buildTargetVariableObject(target, id, item, type);
    target.variables[id] = variable;
    return target.variables[id] || null;
  }

  private _setTargetVariableValue(variable: any, value: any, type: "variables" | "lists") {
    if (!variable) return;
    variable.type = type === "lists" ? "list" : "";
    variable.value = type === "lists" ? (Array.isArray(value) ? value : []) : value;
    variable._value = variable.value;
    variable._name = variable.name;
    if (type === "variables") {
      variable.isCloud = Boolean(variable.isCloud);
    }
  }

  private _notifyTargetDataChanged(target: any) {
    this.vm?.runtime?.requestTargetsUpdate?.(target);
    this.vm?.runtime?.emitProjectChanged?.();
  }

  private _getUniqueAssetFileNames(
    assets: any[],
    options: { fallbackPrefix: string; getFormat: (asset: any, index: number) => string },
  ) {
    const keys = assets.map((asset, index) => {
      const name = sanitizePathSegment(String(asset?.name || ""), `${options.fallbackPrefix}-${index + 1}`);
      const rawFormat = String(options.getFormat(asset, index) || "dat")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "");
      const dataFormat = rawFormat || "dat";
      return { baseName: name, dataFormat, key: `${name}.${dataFormat}` };
    });
    const counts = new Map<string, number>();
    keys.forEach(({ key }) => counts.set(key, (counts.get(key) || 0) + 1));

    const seen = new Map<string, number>();
    return keys.map(({ baseName, dataFormat, key }) => {
      const index = (seen.get(key) || 0) + 1;
      seen.set(key, index);
      const suffix = (counts.get(key) || 0) > 1 ? `.${index}` : "";
      return `${baseName}${suffix}.${dataFormat}`;
    });
  }

  private _buildCostumeVirtualFile(
    target: any,
    costume: any,
    costumeIndex: number,
    rootPath: string,
    fileName: string,
  ) {
    const dataFormat = String(costume?.dataFormat || getFileExtension(fileName) || "dat").toLowerCase();
    const isSvg = dataFormat === "svg";
    const path = `${rootPath}/${VIRTUAL_COSTUME_DIR_NAME}/${fileName}`;
    const content = isSvg
      ? ensureSvgRotationCenterAttrs(this._decodeAssetText(costume?.asset)).svgCode
      : [
          "/* @scratch-costume",
          `name: ${costume?.name || fileName}`,
          `dataFormat: ${dataFormat}`,
          `assetId: ${costume?.assetId || ""}`,
          `byteLength: ${this._getAssetByteLength(costume?.asset)}`,
          "Binary costume assets are listed for deletion/reference. Only SVG costume files are text-editable.",
          "*/",
        ].join("\n");

    return {
      path,
      aliases: costume?.id
        ? [
            `${rootPath}/${VIRTUAL_COSTUME_DIR_NAME}/${sanitizePathSegment(String(costume.id), "costume")}.${dataFormat}`,
          ]
        : [],
      kind: "costume" as VirtualFileKind,
      writable: isSvg,
      deletable: true,
      targetId: target.id,
      targetName: this._getTargetName(target),
      assetName: costume?.name,
      costumeId: costume?.id,
      costumeIndex,
      dataFormat,
      isStage: Boolean(target.isStage),
      description: `${isSvg ? "Editable SVG" : "Read-only binary"} costume ${costume?.name || fileName}`,
      content,
    };
  }

  private _buildCostumeOrderVirtualFile(target: any, rootPath: string, costumeFileNames: string[]) {
    const costumes = this._getTargetCostumes(target);
    const items = costumes.map((costume: any, index: number) => ({
      id: costume?.id,
      name: costume?.name || costumeFileNames[index] || `costume-${index + 1}`,
      path: `${rootPath}/${VIRTUAL_COSTUME_DIR_NAME}/${costumeFileNames[index]}`,
    }));
    return {
      path: `${rootPath}/${VIRTUAL_COSTUME_DIR_NAME}/${VIRTUAL_COSTUME_ORDER_FILE_NAME}`,
      kind: "costumeOrder" as VirtualFileKind,
      writable: true,
      targetId: target.id,
      targetName: this._getTargetName(target),
      isStage: Boolean(target.isStage),
      description: `Editable costume order for ${this._getTargetName(target)}. Reorder the array entries; keep every costume exactly once.`,
      content: `${JSON.stringify(items, null, 2)}\n`,
    };
  }

  private _buildSoundVirtualFile(target: any, sound: any, soundIndex: number, rootPath: string, fileName: string) {
    const dataFormat = String(sound?.dataFormat || getFileExtension(fileName) || "dat").toLowerCase();
    return {
      path: `${rootPath}/${VIRTUAL_SOUND_DIR_NAME}/${fileName}`,
      aliases: sound?.soundId
        ? [`${rootPath}/${VIRTUAL_SOUND_DIR_NAME}/${sanitizePathSegment(String(sound.soundId), "sound")}.${dataFormat}`]
        : [],
      kind: "sound" as VirtualFileKind,
      writable: false,
      deletable: true,
      targetId: target.id,
      targetName: this._getTargetName(target),
      assetName: sound?.name,
      soundId: sound?.soundId,
      soundIndex,
      dataFormat,
      isStage: Boolean(target.isStage),
      description: `Read-only sound ${sound?.name || fileName}`,
      content: [
        "/* @scratch-sound",
        `name: ${sound?.name || fileName}`,
        `dataFormat: ${dataFormat}`,
        `format: ${sound?.format || ""}`,
        `assetId: ${sound?.assetId || ""}`,
        `byteLength: ${this._getAssetByteLength(sound?.asset)}`,
        "Audio assets are listed for deletion/reference and are not text-editable.",
        "*/",
      ].join("\n"),
    };
  }

  private _buildDataVirtualFile(target: any, rootPath: string, type: "variables" | "lists"): VirtualFileEntry {
    const isVariables = type === "variables";
    const fileName = isVariables ? VIRTUAL_VARIABLES_FILE_NAME : VIRTUAL_LISTS_FILE_NAME;
    const aliasFileName = isVariables ? VIRTUAL_VARIABLES_FILE_ALIAS : VIRTUAL_LISTS_FILE_ALIAS;
    const path = `/${fileName}`;
    const aliases = [
      `/${aliasFileName}`,
      `${VIRTUAL_STAGE_ROOT_PATH}/${fileName}`,
      `${VIRTUAL_STAGE_ROOT_PATH}/${aliasFileName}`,
    ];
    const targets = Array.isArray(this.vm.runtime?.targets) ? this.vm.runtime.targets : [];
    const pathByTargetId = this._getVirtualPathMapForTargets(targets);
    targets
      .filter((item: any) => item && !item.isStage)
      .forEach((item: any) => {
        const spriteRoot = this._getVirtualRootPathForTarget(item, pathByTargetId);
        aliases.push(`${spriteRoot}/${fileName}`, `${spriteRoot}/${aliasFileName}`);
      });
    return {
      path,
      aliases,
      kind: type,
      writable: true,
      deletable: false,
      targetId: target.id,
      targetName: this._getTargetName(target),
      isStage: true,
      description: `Global ${isVariables ? "variables" : "lists"} JSON. Sprite/stage data paths are aliases to this root file; targets do not have private data files.`,
      content: this._buildTargetDataJson(target, type),
    };
  }

  private _buildNewDataFileEntry(path: string, type: "variables" | "lists") {
    const normalizedPath = normalizeVirtualPath(path);
    const segments = splitVirtualPath(normalizedPath);
    const targets = Array.isArray(this.vm.runtime?.targets) ? this.vm.runtime.targets : [];
    const stage = targets.find((target: any) => target?.isStage);
    if (!stage) return null;
    const entry = this._buildDataVirtualFile(stage, "/", type);
    return entry.path === normalizedPath || entry.aliases?.includes(normalizedPath)
      ? { ...entry, aliasPath: entry.path === normalizedPath ? undefined : normalizedPath }
      : null;
  }

  private _getCommentsByBlockId(target: any) {
    const commentsByBlockId: Record<string, any> = {};
    Object.values(target?.comments || {}).forEach((comment: any) => {
      if (!comment?.blockId || typeof comment.text !== "string" || !comment.text.trim()) return;
      commentsByBlockId[comment.blockId] = comment;
    });
    return commentsByBlockId;
  }

  private _isRuntimeCloneTarget(target: any) {
    if (!target || target.isStage) return false;
    return target.isOriginal === false || target.isClone === true || Boolean(target.originalTarget);
  }

  private _getProjectIndexTargets() {
    const targets = Array.isArray(this.vm.runtime?.targets) ? this.vm.runtime.targets : [];
    return targets.filter((target: any) => target && !this._isRuntimeCloneTarget(target));
  }

  private _isAiAssistantScriptFilesComment(comment: any) {
    if (comment?.blockId) return false;
    const firstLine = String(comment?.text || "").split(/\r?\n/)[0]?.trim();
    return AI_ASSISTANT_SCRIPT_FILES_CHUNK_HEADER_RE.test(firstLine);
  }

  private _getAiAssistantScriptFilesComments(target: any) {
    const comments = target?.comments && typeof target.comments === "object" ? target.comments : {};
    const indexed = (Object.values(comments) as any[])
      .filter((comment) => this._isAiAssistantScriptFilesComment(comment))
      .map((comment, order) => {
        const firstLine = String(comment?.text || "").split(/\r?\n/)[0]?.trim();
        const match = AI_ASSISTANT_SCRIPT_FILES_CHUNK_HEADER_RE.exec(firstLine);
        return {
          comment,
          order,
          chunkIndex: match?.[1] ? Number(match[1]) : 1,
          chunkTotal: match?.[2] ? Number(match[2]) : 1,
          legacy: !match?.[1],
        };
      });
    return indexed
      .sort((left, right) => {
        if (left.legacy !== right.legacy) return left.legacy ? -1 : 1;
        if (left.chunkIndex !== right.chunkIndex) return left.chunkIndex - right.chunkIndex;
        return left.order - right.order;
      })
      .map((item) => item.comment);
  }

  private _getAiAssistantScriptFilesComment(target: any) {
    return this._getAiAssistantScriptFilesComments(target)[0] || null;
  }

  private _createVmWorkspaceComment(target: any, comment: any) {
    if (!target) return null;
    if (!target.comments || typeof target.comments !== "object") target.comments = {};
    const id = String(comment?.id || createScratchCommentId());
    const text = String(comment?.text || "");
    const x = Number.isFinite(Number(comment?.x)) ? Number(comment.x) : -240;
    const y = Number.isFinite(Number(comment?.y)) ? Number(comment.y) : -180;
    const width = Number(comment?.width) || 260;
    const height = Number(comment?.height) || 120;
    const minimized = comment?.minimized !== false;
    delete target.comments[id];
    if (typeof target.createComment === "function") {
      target.createComment(id, null, text, x, y, width, height, minimized);
      const created = target.comments[id];
      if (created) {
        created.blockId = null;
        return created;
      }
    }
    target.comments[id] = {
      id,
      text,
      x,
      y,
      width,
      height,
      minimized,
      blockId: null,
      toXML() {
        return `<comment id="${escapeXmlText(this.id)}" x="${Number(this.x) || 0}" y="${Number(this.y) || 0}" w="${Math.max(Number(this.width) || 0, 20)}" h="${Math.max(Number(this.height) || 0, 20)}" pinned="false" minimized="${Boolean(this.minimized)}">${escapeXmlText(this.text)}</comment>`;
      },
    };
    return target.comments[id];
  }

  private _repairAiAssistantScriptFilesComment(target: any) {
    const existing = this._getAiAssistantScriptFilesComment(target);
    if (!existing || typeof existing.toXML === "function") return existing || null;
    return this._createVmWorkspaceComment(target, existing);
  }

  private _repairAiAssistantScriptFilesComments(target: any) {
    return this._getAiAssistantScriptFilesComments(target).map((comment) =>
      typeof comment?.toXML === "function" ? comment : this._createVmWorkspaceComment(target, comment),
    );
  }

  private _parseScriptFileNameMapFromTargetComment(target: any) {
    const result = new Map<string, string>();
    const comments = this._repairAiAssistantScriptFilesComments(target);
    const lines = comments.flatMap((comment) => String(comment?.text || "").split(/\r?\n/).slice(1));
    lines.forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed || /^#\s*default\s*=/.test(trimmed)) return;
      const separator = trimmed.lastIndexOf("=");
      if (separator <= 0) return;
      const scriptId = trimmed.slice(0, separator).trim();
      const fileName = getScriptFileNameFromLabel(getFileStem(trimmed.slice(separator + 1).trim()), "script");
      if (scriptId && fileName) result.set(scriptId, fileName);
    });
    return result;
  }

  private _getDefaultScriptFileNameFromTargetComment(target: any) {
    const comments = this._repairAiAssistantScriptFilesComments(target);
    const lines = comments.flatMap((comment) => String(comment?.text || "").split(/\r?\n/).slice(1));
    const defaultLine = lines.find((line) => /^#\s*default\s*=/.test(line.trim()));
    const raw = defaultLine?.trim().replace(/^#\s*default\s*=/, "").trim();
    return raw ? getScriptFileNameFromLabel(getFileStem(raw), "default") : "default.js";
  }

  private _hasAiAssistantScriptFilesComment(target: any) {
    return this._getAiAssistantScriptFilesComments(target).length > 0;
  }

  private _buildScriptFileNameMapCommentTexts(fileNameByScriptId: Map<string, string>, defaultScriptFileName?: string) {
    const entries = [...fileNameByScriptId.entries()]
      .filter(([scriptId, fileName]) => scriptId && fileName)
      .sort((left, right) => left[0].localeCompare(right[0]));
    const lines = [
      ...(defaultScriptFileName ? [`# default=${getScriptFileNameFromLabel(getFileStem(defaultScriptFileName), "default")}`] : []),
      ...entries.map(([scriptId, fileName]) => `${scriptId}=${fileName}`),
    ];
    let expectedTotal = 1;
    for (let pass = 0; pass < 5; pass += 1) {
      const chunks: string[][] = [[]];
      lines.forEach((line) => {
        const current = chunks[chunks.length - 1];
        const header = `${AI_ASSISTANT_SCRIPT_FILES_COMMENT_HEADER} ${chunks.length}/${expectedTotal}`;
        const currentLength = [header, ...current, line].join("\n").length;
        if (current.length > 0 && currentLength > AI_ASSISTANT_SCRIPT_FILES_COMMENT_MAX_LENGTH) {
          chunks.push([line]);
        } else {
          current.push(line);
        }
        if ([header, line].join("\n").length > AI_ASSISTANT_SCRIPT_FILES_COMMENT_MAX_LENGTH) {
          throw new Error("AI script index line exceeds the Scratch comment length limit.");
        }
      });
      const total = Math.max(chunks.length, 1);
      const texts = chunks.map((chunk, index) => [`${AI_ASSISTANT_SCRIPT_FILES_COMMENT_HEADER} ${index + 1}/${total}`, ...chunk].join("\n"));
      if (texts.every((text) => text.length <= AI_ASSISTANT_SCRIPT_FILES_COMMENT_MAX_LENGTH)) return texts;
      expectedTotal = total;
    }
    throw new Error("Failed to split AI script index into Scratch-sized comments.");
  }

  private _writeScriptFileNameMapToTargetComment(target: any, fileNameByScriptId: Map<string, string>, defaultScriptFileName?: string) {
    if (!target) return;
    if (!target.comments || typeof target.comments !== "object") target.comments = {};
    const texts = this._buildScriptFileNameMapCommentTexts(fileNameByScriptId, defaultScriptFileName);
    const existingComments = this._repairAiAssistantScriptFilesComments(target);
    existingComments.forEach((comment) => {
      if (comment?.id && target.comments) delete target.comments[comment.id];
    });
    texts.forEach((text, index) => {
      this._createVmWorkspaceComment(target, {
        id: createScratchCommentId(),
        text,
        x: -240,
        y: -180 + index * 26,
        width: 260,
        height: 120,
        minimized: true,
        blockId: null,
      });
    });
    this.vm?.emitTargetsUpdate?.();
    this.vm?.runtime?.emitProjectChanged?.();
  }

  private _updateScriptFileNameInTargetComment(targetId: string | undefined, scriptId: string | undefined, fileName: string) {
    if (!targetId || !scriptId) return;
    const target = this.vm.runtime?.getTargetById?.(targetId);
    if (!target) return;
    const map = this._parseScriptFileNameMapFromTargetComment(target);
    map.set(scriptId, getScriptFileNameFromLabel(getFileStem(fileName), "script"));
    this._writeScriptFileNameMapToTargetComment(target, map, this._getDefaultScriptFileNameFromTargetComment(target));
  }

  private _replaceScriptFileNameInTargetComment(
    targetId: string | undefined,
    oldScriptId: string | undefined,
    newScriptId: string | undefined,
    fileName: string,
  ) {
    if (!targetId || !newScriptId) return;
    const target = this.vm.runtime?.getTargetById?.(targetId);
    if (!target) return;
    const map = this._parseScriptFileNameMapFromTargetComment(target);
    if (oldScriptId && oldScriptId !== newScriptId) {
      map.delete(oldScriptId);
    }
    map.set(newScriptId, getScriptFileNameFromLabel(getFileStem(fileName), "script"));
    this._writeScriptFileNameMapToTargetComment(target, map, this._getDefaultScriptFileNameFromTargetComment(target));
  }

  private _deleteScriptFileNameFromTargetComment(targetId: string | undefined, scriptId: string | undefined) {
    if (!targetId || !scriptId) return;
    const target = this.vm.runtime?.getTargetById?.(targetId);
    if (!target) return;
    const map = this._parseScriptFileNameMapFromTargetComment(target);
    if (!map.delete(scriptId)) return;
    this._writeScriptFileNameMapToTargetComment(target, map, this._getDefaultScriptFileNameFromTargetComment(target));
  }

  private _getTargetTopBlocks(target: any) {
    const blocks = target?.blocks?._blocks as Record<string, any>;
    if (!blocks) return [];
    return this._getTopLevelBlocks(blocks).sort((left: any, right: any) => {
      const leftY = typeof left.y === "number" ? left.y : 0;
      const rightY = typeof right.y === "number" ? right.y : 0;
      if (leftY !== rightY) return leftY - rightY;
      const leftX = typeof left.x === "number" ? left.x : 0;
      const rightX = typeof right.x === "number" ? right.x : 0;
      if (leftX !== rightX) return leftX - rightX;
      return String(left.id).localeCompare(String(right.id));
    });
  }

  private _getScriptCacheSignature(scriptBlocks: any[]) {
    return scriptBlocks
      .map((block: any) =>
        [
          block?.id,
          block?.opcode,
          block?.parent || "",
          block?.next || "",
          JSON.stringify(block?.inputs || {}),
          JSON.stringify(block?.fields || {}),
          JSON.stringify(block?.mutation || {}),
          block?.comment || "",
          block?.topLevel ? 1 : 0,
          typeof block?.x === "number" ? block.x : "",
          typeof block?.y === "number" ? block.y : "",
        ].join("\u0001"),
      )
      .join("\u0002");
  }

  private _scratchScriptToUCF(target: any, topBlockId: string, commentsByBlockId?: Record<string, any>) {
    const blocks = target?.blocks?._blocks as Record<string, any>;
    if (!blocks || !topBlockId) return "";
    const { blocks: scriptBlocks } = this._collectStatementBlocks(blocks, topBlockId);
    const signature = this._getScriptCacheSignature(scriptBlocks);
    const cacheKey = `${target?.id || "target"}:${topBlockId}`;
    const cached = this.scriptUcfCache.get(cacheKey);
    if (cached?.signature === signature) return cached.content;
    const content = scratchToUCF(scriptBlocks, {
      runtime: this.vm.runtime,
      includePosition: true,
      commentsByBlockId: commentsByBlockId || this._getCommentsByBlockId(target),
    }).trimEnd();
    this.scriptUcfCache.set(cacheKey, { signature, content });
    return content;
  }

  private _buildTargetVirtualFile(target: any, virtualPath?: string) {
    const blocks = target?.blocks?._blocks as Record<string, any>;
    const commentsByBlockId = this._getCommentsByBlockId(target);
    const header = [
      "/* @scratch-target",
      `path: ${virtualPath || this._getVirtualPathForTarget(target)}`,
      `targetId: ${target.id}`,
      `targetName: ${this._getTargetName(target)}`,
      `targetType: ${target.isStage ? "stage" : "sprite"}`,
      "This is a read-only legacy aggregate view. Edit files under the sibling scripts/ folder instead.",
      "*/",
      "",
    ].join("\n");

    if (!blocks) {
      return header.trimEnd();
    }

    const sections = this._getTargetTopBlocks(target).map((topBlock: any) => {
      const code = this._scratchScriptToUCF(target, topBlock.id, commentsByBlockId);
      return [`// @script ${topBlock.id} ${topBlock.opcode || ""}`, code].join("\n");
    });

    return `${header}${sections.join("\n\n")}`.trimEnd();
  }

  private _getScriptFileName(
    target: any,
    topBlock: any,
    code: string | null | undefined,
    usedNames: Set<string>,
    persistedNames?: Map<string, string>,
  ) {
    const persisted = topBlock?.id ? persistedNames?.get(topBlock.id) : null;
    if (persisted && !usedNames.has(persisted)) {
      usedNames.add(persisted);
      this.scriptFileNameByScriptKey.set(`${target?.id || "target"}:${topBlock?.id || "new"}`, persisted);
      return persisted;
    }

    const key = `${target?.id || "target"}:${topBlock?.id || "new"}`;
    const existing = this.scriptFileNameByScriptKey.get(key);
    if (existing && !usedNames.has(existing)) {
      usedNames.add(existing);
      return existing;
    }

    const fallback = String(topBlock?.opcode || "script").replace(/_/g, "-");
    const label = code ? getScriptLabelFromCode(code, fallback) : fallback;
    const baseName = getScriptFileNameFromLabel(label, fallback);
    const stem = getFileStem(baseName);
    const extension = getFileExtension(baseName) || "js";
    let candidate = baseName;
    let index = 2;
    while (usedNames.has(candidate)) {
      candidate = `${stem}-${index}.${extension}`;
      index += 1;
    }
    usedNames.add(candidate);
    this.scriptFileNameByScriptKey.set(key, candidate);
    return candidate;
  }

  private _resolveTargetForScriptPath(path: string) {
    const segments = splitVirtualPath(path);
    if (segments.length !== 3 || segments[1] !== VIRTUAL_SCRIPTS_DIR_NAME || getFileExtension(segments[2]) !== "js") {
      return null;
    }

    const rootPath = `/${segments[0]}`;
    const targets = Array.isArray(this.vm.runtime?.targets) ? this.vm.runtime.targets : [];
    const pathByTargetId = this._getVirtualPathMapForTargets(targets);
    const target = targets.find(
      (item: any) => this._getVirtualRootPathForTarget(item, pathByTargetId) === rootPath,
    );
    if (!target?.id) return null;

    return {
      rootPath,
      targetId: target.id,
      targetName: this._getTargetName(target),
      isStage: Boolean(target.isStage),
      fileName: segments[2],
    };
  }

  private _buildNewScriptFileEntry(path: string): VirtualFileEntry | null {
    const resolved = this._resolveTargetForScriptPath(path);
    if (!resolved) return null;
    return this._buildNewScriptFileEntryFromResolved(path, resolved);
  }

  private _buildPendingNewScriptFileEntry(path: string): VirtualFileEntry | null {
    const segments = splitVirtualPath(path);
    if (segments.length !== 3 || segments[1] !== VIRTUAL_SCRIPTS_DIR_NAME || getFileExtension(segments[2]) !== "js") {
      return null;
    }
    const rootPath = `/${segments[0]}`;
    return this._buildNewScriptFileEntryFromResolved(path, {
      rootPath,
      targetId: "",
      targetName: segments[0],
      isStage: false,
      fileName: segments[2],
      pendingRootPath: rootPath,
    });
  }

  private _buildNewScriptFileEntryFromPatchEntries(path: string, entries: VirtualFileEntry[]): VirtualFileEntry | null {
    const segments = splitVirtualPath(path);
    if (segments.length !== 3 || segments[1] !== VIRTUAL_SCRIPTS_DIR_NAME || getFileExtension(segments[2]) !== "js") {
      return null;
    }
    const scriptsDirPath = `/${segments[0]}/${VIRTUAL_SCRIPTS_DIR_NAME}`;
    const scriptsDir = entries.find((entry) => entry.kind === "dir" && entry.path === scriptsDirPath && entry.targetId);
    if (!scriptsDir?.targetId) return null;
    return this._buildNewScriptFileEntryFromResolved(path, {
      rootPath: `/${segments[0]}`,
      targetId: scriptsDir.targetId,
      targetName: scriptsDir.targetName || segments[0],
      isStage: Boolean(scriptsDir.isStage),
      fileName: segments[2],
    });
  }

  private _buildNewScriptFileEntryFromResolved(path: string, resolved: any): VirtualFileEntry {
    const normalizedPath = normalizeVirtualPath(path);
    const draft = this.virtualFileDrafts.get(normalizedPath);
    return {
      path: normalizedPath,
      kind: "script",
      writable: true,
      deletable: true,
      targetId: resolved.targetId,
      targetName: resolved.targetName,
      isStage: resolved.isStage,
      scriptLabel: getFileStem(resolved.fileName),
      syncStatus: draft ? "dirty-invalid" : "new",
      diagnostics: draft?.diagnostics,
      description: `New Scratch script ${getFileStem(resolved.fileName)}`,
      content: draft?.content || "",
      pendingRootPath: resolved.pendingRootPath,
      pendingTargetName: resolved.pendingRootPath ? resolved.targetName : undefined,
    };
  }

  private _buildScriptFileContentForTopBlocks(
    target: any,
    topBlocks: any[],
    commentsByBlockId: Record<string, any> = this._getCommentsByBlockId(target),
    includeScriptContent = true,
  ) {
    if (!includeScriptContent) return "";
    if (topBlocks.length === 1) {
      return this._scratchScriptToUCF(target, topBlocks[0].id, commentsByBlockId);
    }
    return topBlocks
      .map((topBlock: any) => {
        const code = this._scratchScriptToUCF(target, topBlock.id, commentsByBlockId);
        return [`// @script ${topBlock.id} ${topBlock.opcode || ""}`, code].join("\n");
      })
      .join("\n\n");
  }

  private _getNormalizedScriptContent(entry: VirtualFileEntry) {
    const target = entry.targetId ? this.vm.runtime?.getTargetById?.(entry.targetId) : null;
    const blocks = target?.blocks?._blocks as Record<string, any>;
    if (target && blocks && entry.scriptIds?.length) {
      const topBlocks = entry.scriptIds.map((scriptId) => blocks[scriptId]).filter(Boolean);
      if (topBlocks.length > 1) return this._buildScriptFileContentForTopBlocks(target, topBlocks);
      if (topBlocks.length === 1) return this._scratchScriptToUCF(target, topBlocks[0].id);
    }
    const scriptId = (() => {
      if (entry.scriptId && blocks?.[entry.scriptId]) return entry.scriptId;
      const persisted = this._parseScriptFileNameMapFromTargetComment(target);
      const persistedMatches = [...persisted.entries()].filter(([, fileName]) => fileName === getVirtualBaseName(entry.path));
      if (persistedMatches.length > 1) {
        const persistedIds = new Set(persistedMatches.map(([id]) => id));
        const topBlocks = this._getTargetTopBlocks(target).filter((topBlock: any) => persistedIds.has(topBlock.id));
        if (topBlocks.length > 1) return this._buildScriptFileContentForTopBlocks(target, topBlocks);
      }
      if (persistedMatches[0] && blocks?.[persistedMatches[0][0]]) return persistedMatches[0][0];
      const mapped = [...this.scriptFileNameByScriptKey.entries()].find(
        ([key, fileName]) => key.startsWith(`${entry.targetId}:`) && fileName === getVirtualBaseName(entry.path),
      );
      return mapped ? mapped[0].slice(String(entry.targetId).length + 1) : null;
    })();
    if (!target || !blocks || !scriptId || !blocks[scriptId]) return null;
    return this._scratchScriptToUCF(target, scriptId);
  }

  private _buildScriptFileEntriesForTarget(
    target: any,
    rootPath: string,
    options: VirtualFileBuildOptions = {},
  ): VirtualFileEntry[] {
    const blocks = target?.blocks?._blocks as Record<string, any>;
    if (!blocks) return [];

    const includeScriptContent = options.includeScriptContent !== false;
    const commentsByBlockId = this._getCommentsByBlockId(target);
    const persistedNames = this._parseScriptFileNameMapFromTargetComment(target);
    const usedNames = new Set<string>([...persistedNames.values()]);
    const groups = new Map<string, any[]>();
    this._getTargetTopBlocks(target).forEach((topBlock: any) => {
      const persisted = topBlock?.id ? persistedNames.get(topBlock.id) : null;
      const code = persisted ? "" : includeScriptContent ? this._scratchScriptToUCF(target, topBlock.id, commentsByBlockId) : "";
      const fileName = persisted || this._getScriptFileName(target, topBlock, code, usedNames, undefined);
      this.scriptFileNameByScriptKey.set(`${target?.id || "target"}:${topBlock?.id || "new"}`, fileName);
      groups.set(fileName, [...(groups.get(fileName) || []), topBlock]);
    });
    return [...groups.entries()].map(([fileName, topBlocks]) => {
      const path = `${rootPath}/${VIRTUAL_SCRIPTS_DIR_NAME}/${fileName}`;
      const draft = this.virtualFileDrafts.get(path);
      const code = this._buildScriptFileContentForTopBlocks(target, topBlocks, commentsByBlockId, includeScriptContent);
      const content = draft?.content ?? code;
      const scriptIds = topBlocks.map((topBlock: any) => topBlock.id);
      const hatOpcodes = [...new Set(topBlocks.map((topBlock: any) => topBlock.opcode).filter(Boolean))];
      return {
        path,
        kind: "script" as VirtualFileKind,
        writable: true,
        deletable: true,
        targetId: target.id,
        targetName: this._getTargetName(target),
        isStage: Boolean(target.isStage),
        scriptId: scriptIds.length === 1 ? scriptIds[0] : undefined,
        scriptIds,
        scriptLabel: getFileStem(fileName),
        hatOpcode: hatOpcodes.length === 1 ? hatOpcodes[0] : undefined,
        syncStatus: draft ? "dirty-invalid" : "synced",
        diagnostics: draft?.diagnostics,
        description:
          scriptIds.length === 1
            ? `Scratch script ${getFileStem(fileName)} (${hatOpcodes[0] || "unknown opcode"})`
            : `Scratch feature script ${getFileStem(fileName)} (${scriptIds.length} top-level scripts)`,
        content,
      };
    });
  }

  private _buildDraftScriptFileEntriesForTarget(
    target: any,
    rootPath: string,
    existingPaths: Set<string>,
  ): VirtualFileEntry[] {
    return [...this.virtualFileDrafts.entries()]
      .filter(([path]) => path.startsWith(`${rootPath}/${VIRTUAL_SCRIPTS_DIR_NAME}/`) && !existingPaths.has(path))
      .map(([path, draft]) => ({
        path,
        kind: "script" as VirtualFileKind,
        writable: true,
        deletable: true,
        targetId: target.id,
        targetName: this._getTargetName(target),
        isStage: Boolean(target.isStage),
        scriptLabel: getFileStem(getVirtualBaseName(path)),
        syncStatus: "dirty-invalid" as const,
        diagnostics: draft.diagnostics,
        description: `Unsynced invalid Scratch script draft ${getFileStem(getVirtualBaseName(path))}`,
        content: draft.content,
      }));
  }

  private _getAssetFileEntriesForTarget(target: any, pathByTargetId?: Map<string, string>) {
    if (!target) return [];
    const rootPath = this._getVirtualRootPathForTarget(target, pathByTargetId);
    const costumes = this._getTargetCostumes(target);
    const sounds = this._getTargetSounds(target);
    const costumeFileNames = this._getUniqueAssetFileNames(costumes, {
      fallbackPrefix: "costume",
      getFormat: (costume) => String(costume?.dataFormat || "dat"),
    });
    const soundFileNames = this._getUniqueAssetFileNames(sounds, {
      fallbackPrefix: "sound",
      getFormat: (sound) => String(sound?.dataFormat || "dat"),
    });

    const entries: VirtualFileEntry[] = [
      {
        path: `${rootPath}/${VIRTUAL_COSTUME_DIR_NAME}`,
        kind: "dir",
        writable: false,
        targetId: target.id,
        targetName: this._getTargetName(target),
        isStage: Boolean(target.isStage),
        description: `${target.isStage ? "Stage" : "Sprite"} costume folder for ${this._getTargetName(target)}`,
        content: this._getVirtualDirContent(`${rootPath}/${VIRTUAL_COSTUME_DIR_NAME}`, [
          VIRTUAL_COSTUME_ORDER_FILE_NAME,
          ...costumeFileNames,
        ]),
      },
      this._buildCostumeOrderVirtualFile(target, rootPath, costumeFileNames),
      ...costumes.map((costume: any, index: number) =>
        this._buildCostumeVirtualFile(target, costume, index, rootPath, costumeFileNames[index]),
      ),
      {
        path: `${rootPath}/${VIRTUAL_SOUND_DIR_NAME}`,
        kind: "dir",
        writable: false,
        targetId: target.id,
        targetName: this._getTargetName(target),
        isStage: Boolean(target.isStage),
        description: `${target.isStage ? "Stage" : "Sprite"} audio folder for ${this._getTargetName(target)}`,
        content: this._getVirtualDirContent(`${rootPath}/${VIRTUAL_SOUND_DIR_NAME}`, soundFileNames),
      },
      ...sounds.map((sound: any, index: number) =>
        this._buildSoundVirtualFile(target, sound, index, rootPath, soundFileNames[index]),
      ),
    ];

    return entries;
  }

  private _getScratchAgentGuideEntry(options: VirtualFileBuildOptions = {}): VirtualFileEntry {
    return {
      path: DOC_SCRATCH_AGENT_PATH,
      kind: "doc",
      writable: false,
      description: "Codex-style Scratch JS DSL and virtual file editing guide.",
      content: options.includeDocContent === false ? "" : buildScratchAgentDoc().trimEnd(),
    };
  }

  private _getDocsDirEntry(): VirtualFileEntry {
    return {
      path: "/docs",
      kind: "dir",
      writable: false,
      description: "Read-only AI assistant docs.",
      content: this._getVirtualDirContent("/docs", [
        getVirtualBaseName(DOC_SCRATCH_AGENT_PATH),
        getVirtualBaseName(DOC_BLOCK_CATALOG_PATH),
      ]),
    };
  }

  private _getBlockCatalogEntry(options: VirtualFileBuildOptions = {}): VirtualFileEntry {
    if (options.includeDocContent === false) {
      return {
        path: DOC_BLOCK_CATALOG_PATH,
        kind: "doc",
        writable: false,
        description: "Searchable native and loaded extension block opcode catalog.",
        content: "",
      };
    }
    const blockLines = Object.entries(this._getAllBlockIds())
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([opcode, text]) => {
        const aliases = AITools.BlockSearchAliases[opcode] || [];
        const aliasText = aliases.length > 0 ? `; aliases: ${aliases.join(", ")}` : "";
        return `- ${opcode}: ${text}${aliasText}`;
      });

    return {
      path: DOC_BLOCK_CATALOG_PATH,
      kind: "doc",
      writable: false,
      description: "Searchable native and loaded extension block opcode catalog.",
      content: [`# Scratch Block Catalog`, "", ...blockLines].join("\n"),
    };
  }

  private _getVirtualFiles(options: VirtualFileBuildOptions = {}) {
    repairListVariableValues(this.vm);
    this._repairAiAssistantMetadataRecords();
    const includeScriptContent = options.includeScriptContent !== false;
    const includeLegacyTargetContent = options.includeLegacyTargetContent === true;
    const targets = Array.isArray(this.vm.runtime?.targets) ? this.vm.runtime.targets : [];
    const pathByTargetId = this._getVirtualPathMapForTargets(targets);
    const entries: VirtualFileEntry[] = [];

    targets.forEach((target: any) => {
      const path = this._getVirtualPathForTarget(target, pathByTargetId);
      const rootPath = this._getVirtualRootPathForTarget(target, pathByTargetId);
      const scriptEntries = this._buildScriptFileEntriesForTarget(target, rootPath, { includeScriptContent });
      const allScriptEntries = [
        ...scriptEntries,
        ...this._buildDraftScriptFileEntriesForTarget(
          target,
          rootPath,
          new Set(scriptEntries.map((entry) => entry.path)),
        ),
      ];

      entries.push({
        path: rootPath,
        kind: "dir",
        writable: !target?.isStage,
        deletable: !target?.isStage,
        targetId: target.id,
        targetName: this._getTargetName(target),
        isStage: Boolean(target?.isStage),
        description: `${target?.isStage ? "Stage" : "Sprite"} folder for ${this._getTargetName(target)}`,
        content: this._getVirtualDirContent(
          rootPath,
          [
            VIRTUAL_SCRIPT_FILE_NAME,
            VIRTUAL_SCRIPTS_DIR_NAME,
            VIRTUAL_COSTUME_DIR_NAME,
            VIRTUAL_SOUND_DIR_NAME,
          ].filter(Boolean) as string[],
        ),
      });

      if (target?.isStage) {
        entries.push(this._buildDataVirtualFile(target, rootPath, "variables"));
        entries.push(this._buildDataVirtualFile(target, rootPath, "lists"));
      }

      entries.push({
        path: `${rootPath}/${VIRTUAL_SCRIPTS_DIR_NAME}`,
        kind: "dir",
        writable: true,
        targetId: target.id,
        targetName: this._getTargetName(target),
        isStage: Boolean(target?.isStage),
        description: `Per-script files for ${this._getTargetName(target)}`,
        content: this._getVirtualDirContent(
          `${rootPath}/${VIRTUAL_SCRIPTS_DIR_NAME}`,
          allScriptEntries.map((entry) => getVirtualBaseName(entry.path)),
        ),
      });

      entries.push(...allScriptEntries);

      if (target?.isStage) {
        entries.push({
          path,
          aliases: this._getVirtualPathAliasesForTarget(target, path),
          kind: "target",
          writable: false,
          targetId: target.id,
          targetName: this._getTargetName(target),
          isStage: true,
          description: `Read-only legacy aggregate stage scripts. Edit files under ${rootPath}/${VIRTUAL_SCRIPTS_DIR_NAME}/ instead.`,
          content: includeLegacyTargetContent ? this._buildTargetVirtualFile(target, path) : "",
        });

        entries.push(...this._getAssetFileEntriesForTarget(target, pathByTargetId));
        return;
      }

      entries.push({
        path,
        aliases: this._getVirtualPathAliasesForTarget(target, path),
        kind: "target",
        writable: false,
        targetId: target.id,
        targetName: this._getTargetName(target),
        isStage: false,
        description: `Read-only legacy aggregate sprite scripts. Edit files under ${rootPath}/${VIRTUAL_SCRIPTS_DIR_NAME}/ instead.`,
        content: includeLegacyTargetContent ? this._buildTargetVirtualFile(target, path) : "",
      });

      entries.push(...this._getAssetFileEntriesForTarget(target, pathByTargetId));
    });

    return [
      ...entries,
      this._getDocsDirEntry(),
      this._getScratchAgentGuideEntry(options),
      this._getBlockCatalogEntry(options),
    ];
  }

  private _findVirtualFileEntry(entries: VirtualFileEntry[], path: string) {
    const normalizedPath = normalizeVirtualPath(path);
    const exact = entries.find((entry) => entry.path === normalizedPath || entry.aliases?.includes(normalizedPath));
    if (exact) return exact.path === normalizedPath ? exact : { ...exact, aliasPath: normalizedPath };

    const pathSegments = splitVirtualPath(normalizedPath);
    if (pathSegments.length === 2 && pathSegments[1] === VIRTUAL_SCRIPT_FILE_NAME) {
      if (pathSegments[0] === VIRTUAL_STAGE_FOLDER_NAME) {
        return entries.find((entry) => entry.kind === "target" && entry.isStage) || null;
      }

      const requestedFolderName = pathSegments[0];
      const matches = entries.filter((entry) => {
        if (entry.kind !== "target" || entry.isStage) return false;
        const stableName = sanitizeSpriteFolderName(entry.targetName || "");
        return stableName === requestedFolderName;
      });
      if (matches.length === 1) {
        return matches[0];
      }
    }

    return null;
  }

  private _getVirtualFile(path: string) {
    const metadataEntry = this._findVirtualFileEntry(
      this._getVirtualFiles({ includeScriptContent: false, includeLegacyTargetContent: false }),
      path,
    );
    if (!metadataEntry) return null;
    return this._materializeVirtualFileEntry(metadataEntry);
  }

  private _materializeVirtualFileEntry(entry: VirtualFileEntry): VirtualFileEntry {
    if (entry.kind === "script") {
      const draft = this.virtualFileDrafts.get(entry.path);
      const content = draft?.content || this._getNormalizedScriptContent(entry) || entry.content || "";
      return { ...entry, content, diagnostics: draft?.diagnostics || entry.diagnostics, syncStatus: draft ? "dirty-invalid" : entry.syncStatus };
    }
    if (entry.kind === "target") {
      const target = entry.targetId ? this.vm.runtime?.getTargetById?.(entry.targetId) : null;
      return target ? { ...entry, content: this._buildTargetVirtualFile(target, entry.path) } : entry;
    }
    if (entry.kind === "doc") {
      if (entry.path === DOC_SCRATCH_AGENT_PATH) return this._getScratchAgentGuideEntry();
      if (entry.path === DOC_BLOCK_CATALOG_PATH) return this._getBlockCatalogEntry();
    }
    return entry;
  }

  private _overlayPatchEntries(entries: VirtualFileEntry[], movedEntries: VirtualFileEntry[]) {
    const next = new Map(entries.map((entry) => [entry.path, entry]));
    const rootReplacements: Array<{ oldRoot: string; newRoot: string }> = [];
    for (const movedEntry of movedEntries) {
      const oldEntry = entries.find(
        (entry) =>
          entry.targetId === movedEntry.targetId &&
          entry.kind === movedEntry.kind &&
          entry.scriptId === movedEntry.scriptId &&
          entry.costumeId === movedEntry.costumeId &&
          entry.soundId === movedEntry.soundId &&
          entry.dataFormat === movedEntry.dataFormat,
      );
      if (oldEntry) {
        next.delete(oldEntry.path);
        if (oldEntry.kind === "dir" && movedEntry.kind === "dir" && splitVirtualPath(oldEntry.path).length === 1) {
          rootReplacements.push({ oldRoot: oldEntry.path, newRoot: movedEntry.path });
        }
      }
    }

    for (const { oldRoot } of rootReplacements) {
      for (const path of [...next.keys()]) {
        if (path === oldRoot || path.startsWith(`${oldRoot}/`)) {
          next.delete(path);
        }
      }
    }
    movedEntries.forEach((entry) => next.set(entry.path, entry));
    return [...next.values()];
  }

  private _getTopLevelBlocks(blocks: Record<string, any>) {
    return Object.values(blocks).filter((block: any) => this._isExportableTopLevelBlock(block));
  }

  private _isExportableTopLevelBlock(block: any) {
    const opcode = String(block?.opcode || "");
    if (!block?.topLevel || block?.parent || !opcode) return false;
    if (block?.shadow) return false;
    if (this._isInternalShadowOpcode(opcode)) return false;
    if (
      opcode === "procedures_prototype" ||
      opcode === "argument_reporter_string_number" ||
      opcode === "argument_reporter_boolean"
    ) {
      return false;
    }
    return true;
  }

  private _collectScriptBlockIds(blocks: Record<string, any>, topBlockId: string) {
    const visited = new Set<string>();
    const order: string[] = [];
    const walkChain = (blockId?: string) => {
      let currentId = blockId;

      while (currentId && !visited.has(currentId)) {
        visited.add(currentId);
        order.push(currentId);
        const block = blocks[currentId];
        if (!block) {
          break;
        }

        if (block.inputs) {
          for (const input of Object.values(block.inputs) as any[]) {
            const inputBlockId = input?.block;
            if (inputBlockId && !visited.has(inputBlockId)) {
              walkChain(inputBlockId);
            }
          }
        }

        currentId = block.next;
      }
    };

    walkChain(topBlockId);
    return order;
  }

  private _collectStatementBlocks(blocks: Record<string, any>, topBlockId: string) {
    const statementBlockIds = this._collectScriptBlockIds(blocks, topBlockId);
    return {
      statementBlockIds,
      blocks: statementBlockIds.map((blockId) => blocks[blockId]).filter(Boolean),
    };
  }

  private _buildScriptSummary(blocks: Record<string, any>, topBlock: any, targetId: string) {
    const blockIds = this._collectScriptBlockIds(blocks, topBlock.id);
    const firstStatements = blockIds
      .slice(0, 6)
      .map((blockId) => blocks[blockId])
      .filter(Boolean)
      .map((block: any) => AITools.AllBlockInfo[block.opcode] || block.opcode);

    return {
      scriptId: topBlock.id,
      targetId,
      hatOpcode: topBlock.opcode,
      blockCount: blockIds.length,
      blockIds,
      summary: firstStatements.join(" -> "),
    };
  }

  private _resolveTopLevelScriptId(blocks: Record<string, any>, blockId?: string) {
    let currentId = blockId;
    while (currentId) {
      const block = blocks[currentId];
      if (!block) {
        break;
      }
      if (block.topLevel || !block.parent) {
        return currentId;
      }
      currentId = block.parent;
    }
    return null;
  }

  private _normalizeBlockText(value: any) {
    if (typeof value === "string") {
      return value;
    }

    if (Array.isArray(value)) {
      return value.join(" ");
    }

    return "";
  }

  private _matchKeyword(candidate: string, keyword?: string) {
    if (!keyword?.trim()) return true;
    const keywords = keyword.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const haystack = candidate.toLowerCase();
    return keywords.every((item) => haystack.includes(item));
  }

  private _getSearchTextForOpcode(opcode: string) {
    return [AITools.AllBlockInfo[opcode] || "", ...(AITools.BlockSearchAliases[opcode] || [])].join(" ");
  }

  private _resolveOpcodeLookup(requestedOpcode: string) {
    const direct = String(requestedOpcode || "").trim();
    if (!direct) return direct;
    if (this._isKnownOpcode(direct)) return direct;

    const normalized = normalizeOpcodeLookupKey(direct);
    const alias = COMMON_OPCODE_ALIASES[normalized];
    if (alias) return alias;

    if (direct.includes(".")) {
      const dottedFallback = direct.replace(/\./g, "_");
      if (this._isKnownOpcode(dottedFallback)) return dottedFallback;
    }

    const allBlockIds = this._getAllBlockIds();
    const normalizedMatch = Object.keys(allBlockIds).find((opcode) => normalizeOpcodeLookupKey(opcode) === normalized);
    return normalizedMatch || direct;
  }

  private _toDslCallName(opcode: string) {
    const normalized = String(opcode || "");
    if (!normalized.includes("_")) return normalized;
    const [namespace, ...rest] = normalized.split("_");
    return `${namespace}.${rest.join("_")}`;
  }

  private _getMenuOptionValue(option: any) {
    if (Array.isArray(option)) return option[1] ?? option[0];
    if (option && typeof option === "object") return option.value ?? option.text ?? option.label;
    return option;
  }

  private _previewContent(content: string, maxChars = PREVIEW_MAX_CHARS) {
    const text = String(content || "");
    if (text.length <= maxChars) return text;
    return `${text.slice(0, maxChars)}\n... <truncated ${text.length - maxChars} chars>`;
  }

  private _getSyncedPreviewForScript(entry: VirtualFileEntry) {
    if (entry.kind !== "script") return null;
    const syncedContent = this._getNormalizedScriptContent(entry) ?? (entry.scriptId ? entry.content : "");
    return this._previewContent(syncedContent);
  }

  private _getScriptRepairHint(entry: VirtualFileEntry, diagnostics?: any) {
    if (entry.kind !== "script") return undefined;
    const errors = Array.isArray(diagnostics?.errors) ? diagnostics.errors : [];
    const topLevelError = errors.find((error: any) => /top-level script; got \d+/.test(String(error?.message || "")));
    if (topLevelError) {
      return `Each // @script section must produce exactly one Scratch top-level stack. To add another independent workspace block/stack to this feature file, add a new // @script new-... section with one top-level call.`;
    }
    if (errors.some((error: any) => /no JavaScript block code/i.test(String(error?.message || "")))) {
      return `This script draft is empty. Add a Scratch DSL call or // @script sections, or call discardDraft({ path: ${JSON.stringify(entry.path)} }) to restore the last synced version.`;
    }
    return `Scratch blocks were not changed. Fix this draft in ${entry.path}, or call discardDraft({ path: ${JSON.stringify(entry.path)} }) to abandon the invalid draft and read the last synced version.`;
  }

  private _buildDraftReport(entry: VirtualFileEntry, content: string, diagnostics?: any) {
    return {
      path: entry.path,
      syncStatus: "dirty-invalid",
      repairHint: this._getScriptRepairHint(entry, diagnostics),
      draftPreview: this._previewContent(content),
      syncedPreview: this._getSyncedPreviewForScript(entry),
      diagnostics,
    };
  }

  private _buildDiagnosticsSummary(diagnostics: any[]) {
    const invalid = diagnostics.filter((item: any) => item && !item.valid);
    const invalidDrafts = invalid.filter((item: any) => item.syncStatus === "dirty-invalid");
    const invalidFiles = invalid.filter((item: any) => item.syncStatus !== "dirty-invalid");
    const warningCount = diagnostics.reduce((sum, item: any) => sum + (Array.isArray(item?.warnings) ? item.warnings.length : 0), 0);
    return {
      valid: invalid.length === 0,
      fileCount: diagnostics.length,
      invalidCount: invalid.length,
      warningCount,
      invalidDrafts: invalidDrafts.map((item: any) => ({
        path: item.path,
        errors: item.errors || [],
        hint: `Fix ${item.path} or call discardDraft({ path: ${JSON.stringify(item.path)} }) to abandon the invalid draft.`,
      })),
      invalidFiles: invalidFiles.map((item: any) => ({ path: item.path, errors: item.errors || [] })),
    };
  }

  private _isDefaultDiagnosticEntry(entry: VirtualFileEntry) {
    if (entry.kind === "script") return true;
    if (entry.kind === "costume" && entry.dataFormat === "svg") return true;
    return false;
  }

  private _buildRollbackChangeSummary(changedEntries: VirtualFileEntry[], requestedChanges: string[]) {
    const uniqueChangedEntries = changedEntries.filter(
      (entry, index, array) => array.findIndex((item) => item.path === entry.path) === index,
    );
    return {
      preservedDrafts: uniqueChangedEntries.filter((entry) => entry.kind === "script").map((entry) => entry.path),
      rolledBackAssetChanges: uniqueChangedEntries
        .filter((entry) => entry.kind === "costume" || entry.kind === "sound")
        .map((entry) => entry.path),
      notAppliedChanges: [...new Set([...uniqueChangedEntries.map((entry) => entry.path), ...requestedChanges])].filter(
        (path) => !uniqueChangedEntries.some((entry) => entry.kind === "script" && entry.path === path),
      ),
    };
  }

  private _sampleFieldValue(fieldName: string, fieldMeta: any) {
    const options = Array.isArray(fieldMeta?.menuOptions) ? fieldMeta.menuOptions : [];
    const firstOption = options.length > 0 ? this._getMenuOptionValue(options[0]) : undefined;
    if (firstOption !== undefined && firstOption !== null && firstOption !== "") return firstOption;
    if (fieldMeta?.defaultValue !== undefined && fieldMeta.defaultValue !== null && fieldMeta.defaultValue !== "") {
      return fieldMeta.defaultValue;
    }

    const upper = String(fieldName || "").toUpperCase();
    if (upper.includes("VARIABLE")) return "score";
    if (upper.includes("LIST")) return "numbers";
    if (upper.includes("BROADCAST")) return "game-start";
    if (upper.includes("SOUND")) return "pop";
    if (upper.includes("KEY")) return "space";
    if (upper.includes("COLOR_PARAM")) return "color";
    if (upper.includes("STOP")) return "all";
    if (upper.includes("CLONE")) return "_myself_";
    return fieldName ? fieldName.toLowerCase() : "value";
  }

  private _sampleInputExpression(inputName: string, inputMeta: any) {
    const name = String(inputName || "");
    const type = String(inputMeta?.type || "").toLowerCase();
    if (name === "CONDITION" || type.includes("boolean") || type === "b" || type === "bool") {
      return 'operator.equals({ OPERAND1: data.variable({ $field_VARIABLE: "ready" }), OPERAND2: 1 })';
    }
    if (name === "BROADCAST_INPUT") return '"game-start"';
    if (name === "MESSAGE" || name === "QUESTION") return '"hello"';
    if (name === "COLOR" || name === "COLOR2") return '"#4a90d9"';
    if (name === "ITEM") return "operator.random({ FROM: 1, TO: 100 })";
    if (name === "INDEX") return 'data.variable({ $field_VARIABLE: "i" })';
    if (name === "VALUE" && inputMeta?.menu) return `"${this._sampleFieldValue(name, inputMeta)}"`;
    if (
      type.includes("number") ||
      type === "n" ||
      /^(X|Y|DX|DY|STEPS|TIMES|DURATION|SECS|SIZE|VALUE|NUM|NUM1|NUM2|FROM|TO)$/.test(name)
    ) {
      return "10";
    }
    return '"value"';
  }

  private _getCoreMenuShadowInfo(opcode: string, inputName: string) {
    return getCoreMenuShadowInfo(opcode, inputName);
  }

  private _usesInternalMenuShadow(opcode: string, inputName: string) {
    const normalizedOpcode = String(opcode || "");
    const normalizedInput = String(inputName || "");
    if (this._getCoreMenuShadowInfo(normalizedOpcode, normalizedInput)) return true;
    return (
      normalizedInput === "SOUND_MENU" &&
      (normalizedOpcode === "sound_play" || normalizedOpcode === "sound_playuntildone")
    );
  }

  private _isCoreMenuShadowOpcode(opcode: string) {
    const value = String(opcode || "");
    return Object.values(CORE_MENU_SHADOWS as Record<string, Record<string, any>>).some((byInput) =>
      Object.values(byInput).some((info: any) => info?.opcode === value),
    );
  }

  private _buildBlockUsage(info: any) {
    const opcode = String(info?.opcode || "");
    if (opcode === "define" || opcode === "procedures_definition") {
      return [
        'define({ proccode: "draw bars %n[highlight1] %n[highlight2]", info: ["warp"], $xy: { x: 80, y: 360 } }, () => {',
        "  pen.clear();",
        '  data.setvariableto({ $field_VARIABLE: "i", VALUE: 1 });',
        '  control.repeat({ TIMES: data.lengthoflist({ $field_LIST: "numbers" }), SUBSTACK: () => {',
        "    // Draw one bar here. Warp makes the whole render finish in one frame.",
        '    data.changevariableby({ $field_VARIABLE: "i", VALUE: 1 });',
        "  } });",
        "});",
      ].join("\n");
    }
    if (opcode === "procedures_call") {
      return 'procedures.call({ $mutation: { proccode: "draw bars %n %n", warp: "true" }, $args: [0, 0] });';
    }
    if (opcode === "argument_reporter_string_number") {
      return 'argument.reporter_string_number({ $field_VALUE: "highlight1" });';
    }
    if (opcode === "argument_reporter_boolean") {
      return 'argument.reporter_boolean({ $field_VALUE: "enabled" });';
    }

    const callName = this._toDslCallName(opcode);
    const fields = Object.entries(info?.fields || {});
    const inputs = Object.entries(info?.inputs || {}).filter(
      ([inputName]) => !String(inputName).startsWith("SUBSTACK"),
    );
    const substacks = Array.isArray(info?.substacks) ? info.substacks : [];
    const blockType = String(info?.type || info?.blockType || "").toLowerCase();
    const isHat = blockType === "hat" || blockType.includes("hat");
    const props: string[] = [];

    fields.forEach(([fieldName, fieldMeta]: [string, any]) => {
      props.push(`$field_${fieldName}: ${JSON.stringify(this._sampleFieldValue(fieldName, fieldMeta))}`);
    });
    inputs.forEach(([inputName, inputMeta]: [string, any]) => {
      if (info?.fields?.[inputName]) return;
      if (this._usesInternalMenuShadow(opcode, inputName)) {
        props.push(`$field_${inputName}: ${JSON.stringify(this._sampleFieldValue(inputName, inputMeta))}`);
        return;
      }
      props.push(`${inputName}: ${this._sampleInputExpression(inputName, inputMeta)}`);
    });
    if (isHat) {
      props.push("$xy: { x: 80, y: 80 }");
    }
    substacks.forEach((substackName: string) => {
      props.push(`${substackName}: () => {\n    looks.say({ MESSAGE: "ok" });\n  }`);
    });

    const argsObject = props.length > 0 ? `{\n  ${props.join(",\n  ")}\n}` : "{}";
    if (isHat || opcode === "procedures_definition") {
      return `${callName}(${argsObject}, () => {\n  looks.say({ MESSAGE: "ok" });\n});`;
    }
    return `${callName}(${argsObject});`;
  }

  private _compactBlockHelp(info: any) {
    const tooltip = this._normalizeBlockTooltip(info?.tooltip);
    const fields = Object.fromEntries(
      Object.entries(info?.fields || {}).map(([name, meta]: [string, any]) => [
        name,
        {
          use: `$field_${name}`,
          type: meta?.type,
          menu: meta?.menu || null,
          options: Array.isArray(meta?.menuOptions)
            ? meta.menuOptions.slice(0, 12).map((option: any) => this._getMenuOptionValue(option))
            : null,
          defaultValue: meta?.defaultValue,
        },
      ]),
    );
    const inputs = Object.fromEntries(
      Object.entries(info?.inputs || {}).map(([name, meta]: [string, any]) => [
        name,
        {
          type: meta?.type,
          menu: meta?.menu || null,
          use: String(name).startsWith("SUBSTACK")
            ? `${name}: () => { ... }`
            : this._usesInternalMenuShadow(info?.opcode, name)
              ? `$field_${name}`
              : name,
        },
      ]),
    );
    const notes = [];
    const type = String(info?.type || info?.blockType || "").toLowerCase();
    if (type === "hat" || type.includes("hat")) {
      notes.push("Hat blocks accept a trailing callback: block({ $xy }, () => { ... });");
    }
    if (info?.opcode === "procedures_definition") {
      notes.push(
        'Prefer the define(...) DSL helper for custom blocks. Add info: ["warp"] for run-without-screen-refresh rendering/math helpers.',
      );
    }
    if (info?.opcode === "procedures_call") {
      notes.push(
        'Call custom blocks with procedures.call({ $mutation: { proccode: "...", warp: "true" }, $args: [...] }).',
      );
    }
    if (info?.opcode === "argument_reporter_string_number" || info?.opcode === "argument_reporter_boolean") {
      notes.push(
        "Use only inside define(...). VALUE is the custom block parameter name and must be written as $field_VALUE.",
      );
      notes.push(
        "Do not read custom block parameters with data.variable; that creates/reads a global variable instead.",
      );
    }
    if (Object.keys(fields).length > 0) {
      notes.push("Menu/dropdown/variable/list selectors use $field_ keys.");
    }
    if (Object.keys(info?.inputs || {}).some((name) => this._getCoreMenuShadowInfo(info?.opcode, name))) {
      notes.push("Core Scratch menu inputs such as keys, touching objects, clone targets, and sprite/backdrop targets use $field_ keys; the converter creates the internal menu shadow blocks automatically.");
      notes.push("Do not write internal menu shadow opcodes such as sensing.keyoptions, sensing.touchingobjectmenu, or control.create_clone_of_menu directly.");
    }
    if (Object.keys(inputs).some((name) => name === "CONDITION")) {
      notes.push("CONDITION must be a Boolean reporter such as operator.equals/operator.gt/operator.lt.");
    }
    if (info?.opcode === "sound_play" || info?.opcode === "sound_playuntildone") {
      notes.push('Use the simple field form for sounds: sound.play({ $field_SOUND_MENU: "sound name" });');
      notes.push("The converter creates the internal sound_sounds_menu shadow block automatically; do not write SOUND_MENU as a reporter input.");
    }
    return {
      opcode: info?.opcode,
      dslCall: this._toDslCallName(info?.opcode),
      text: info?.text,
      ...(tooltip ? { tooltip } : {}),
      type: info?.type || info?.blockType,
      fields,
      inputs,
      substacks: info?.substacks || [],
      menus: info?.menus || {},
      example: this._buildBlockUsage(info),
      notes,
    };
  }

  private _normalizeBlockTooltip(tooltip: any) {
    if (tooltip === undefined || tooltip === null) return null;
    try {
      const value = typeof tooltip === "function" ? tooltip() : tooltip;
      if (typeof value === "string") {
        const trimmed = value.trim();
        return trimmed || null;
      }
      if (typeof value === "number" || typeof value === "boolean") {
        return String(value);
      }
    } catch {
      return null;
    }
    return null;
  }

  private _isBooleanReporterBlock(block: any) {
    if (!block?.opcode) return false;
    try {
      const info = this.getBlockInfo(block.opcode);
      const type = String(info?.type || info?.blockType || "").toLowerCase();
      if (type.includes("boolean") || type.includes("predicate")) return true;
    } catch {
      // Fall through to opcode heuristics.
    }

    return (
      /^operator_(lt|gt|equals|and|or|not)$/.test(String(block.opcode)) ||
      /^sensing_.*(touching|color|keypressed|mousedown|loud)$/.test(String(block.opcode)) ||
      /^data_listcontainsitem$/.test(String(block.opcode))
    );
  }

  private _isBooleanInput(inputName: string, inputMeta: any) {
    const type = String(inputMeta?.type || "").toLowerCase();
    return (
      inputName === "CONDITION" || type === "boolean" || type === "bool" || type === "b" || type.includes("boolean")
    );
  }

  private _isValidColorLiteral(value: any) {
    const text = String(value ?? "").trim();
    return /^#[0-9a-f]{6}$/i.test(text) || /^#[0-9a-f]{3}$/i.test(text);
  }

  private _isInternalShadowOpcode(opcode: any) {
    const normalized = String(opcode || "");
    return (
      this._isCoreMenuShadowOpcode(normalized) ||
      normalized === "text" ||
      normalized === "math_number" ||
      normalized === "math_integer" ||
      normalized === "math_whole_number" ||
      normalized === "math_positive_number" ||
      normalized === "math_angle" ||
      normalized === "colour_picker" ||
      normalized.endsWith("_menu") ||
      normalized.includes("_menu_") ||
      normalized.endsWith("_dropdown")
    );
  }

  private _lineForSourceIndex(section: VirtualScriptSection, index: number) {
    return (
      section.startLine +
      String(section.code || "")
        .slice(0, Math.max(0, index))
        .split("\n").length -
      1
    );
  }

  private _findMatchingBrace(source: string, openIndex: number) {
    if (source[openIndex] !== "{") return -1;
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
      if (char === '"' || char === "'" || char === "`") {
        quote = char;
        continue;
      }
      if (char === "{") {
        depth += 1;
      } else if (char === "}") {
        depth -= 1;
        if (depth === 0) return index;
      }
    }

    return -1;
  }

  private _collectObjectCallBodies(source: string, callPattern: RegExp) {
    const flags = callPattern.flags.includes("g") ? callPattern.flags : `${callPattern.flags}g`;
    const regex = new RegExp(callPattern.source, flags);
    const calls: Array<{ body: string; startIndex: number; endIndex: number }> = [];
    let match: RegExpExecArray | null;
    while ((match = regex.exec(source))) {
      const braceStart = source.indexOf("{", match.index);
      if (braceStart < 0) continue;
      const braceEnd = this._findMatchingBrace(source, braceStart);
      if (braceEnd < 0) continue;
      calls.push({
        body: source.slice(braceStart + 1, braceEnd),
        startIndex: match.index,
        endIndex: braceEnd,
      });
      regex.lastIndex = Math.max(regex.lastIndex, braceEnd + 1);
    }
    return calls;
  }

  private _validateVirtualSourceSemantics(section: VirtualScriptSection) {
    const errors: any[] = [];
    const warnings: any[] = [];
    const source = String(section.code || "");

    const penColorCalls = this._collectObjectCallBodies(
      source,
      /(?:pen\.setPenColorParamTo|pen_setPenColorParamTo|pen\.changePenColorParamBy|pen_changePenColorParamBy)\s*\(\s*\{/g,
    );
    penColorCalls.forEach((call) => {
      if (!/\$field_COLOR_PARAM\s*:/.test(call.body)) {
        errors.push({
          line: this._lineForSourceIndex(section, call.startIndex),
          scriptId: section.scriptId,
          message:
            'pen.setPenColorParamTo/changePenColorParamBy must include the menu field. Use { $field_COLOR_PARAM: "color", VALUE: 50 } or "brightness"/"saturation"/"transparency".',
        });
      }
    });

    const argumentReporterCalls = this._collectObjectCallBodies(
      source,
      /(?:argument\.reporter_(?:string_number|boolean)|argument_reporter_(?:string_number|boolean))\s*\(\s*\{/g,
    );
    argumentReporterCalls.forEach((call) => {
      if (!/\$field_VALUE\s*:/.test(call.body)) {
        errors.push({
          line: this._lineForSourceIndex(section, call.startIndex),
          scriptId: section.scriptId,
          message:
            'Custom block arguments must be read with argument.reporter_string_number({ $field_VALUE: "argName" }) or argument.reporter_boolean({ $field_VALUE: "argName" }). VALUE is a field, not an input.',
        });
      }
    });

    const defineRegex = /define\s*\(\s*\{[\s\S]*?proccode\s*:\s*(["'`])((?:\\.|(?!\1)[\s\S])*)\1/g;
    let defineMatch: RegExpExecArray | null;
    const definedArgumentNames: string[] = [];
    while ((defineMatch = defineRegex.exec(source))) {
      definedArgumentNames.push(...extractProcedureArgumentNames(defineMatch[2]));
    }

    const uniqueArgumentNames = [...new Set(definedArgumentNames)];
    uniqueArgumentNames.forEach((argumentName) => {
      const variableReadPattern = new RegExp(
        `\\bdata(?:\\.|_)variable\\s*\\(\\s*\\{[^}]*\\$field_VARIABLE\\s*:\\s*(["'\`])${escapeRegExp(argumentName)}\\1`,
        "g",
      );
      const variableRead = variableReadPattern.exec(source);
      if (variableRead) {
        errors.push({
          line: this._lineForSourceIndex(section, variableRead.index),
          scriptId: section.scriptId,
          message: `Custom block parameter "${argumentName}" is being read as a global variable. Use argument.reporter_string_number({ $field_VALUE: "${argumentName}" }) inside the define body.`,
        });
      }
    });

    if (uniqueArgumentNames.length > 0 && argumentReporterCalls.length === 0) {
      warnings.push({
        line: section.startLine,
        scriptId: section.scriptId,
        message:
          'This custom block declares parameters but does not use argument.reporter_* reporters. Inside define(...), read parameters with argument.reporter_string_number({ $field_VALUE: "name" }).',
      });
    }

    return { errors, warnings };
  }

  private _validateProcedureCallsInSource(sections: VirtualScriptSection[]) {
    const warnings: any[] = [];
    const definitions = new Set<string>();

    sections.forEach((section) => {
      const defineRegex = /define\s*\(\s*\{[\s\S]*?proccode\s*:\s*(["'`])((?:\\.|(?!\1)[\s\S])*)\1/g;
      let defineMatch: RegExpExecArray | null;
      while ((defineMatch = defineRegex.exec(section.code))) {
        definitions.add(normalizeProcedureSignature(defineMatch[2]));
      }
    });

    if (definitions.size === 0) return warnings;

    sections.forEach((section) => {
      const callRegex =
        /procedures\.call\s*\(\s*\{\s*\$mutation\s*:\s*\{[\s\S]*?proccode\s*:\s*(["'`])((?:\\.|(?!\1)[\s\S])*)\1/g;
      let callMatch: RegExpExecArray | null;
      while ((callMatch = callRegex.exec(section.code))) {
        const normalizedCall = normalizeProcedureSignature(callMatch[2]);
        if (!definitions.has(normalizedCall)) {
          warnings.push({
            line: this._lineForSourceIndex(section, callMatch.index),
            scriptId: section.scriptId,
            message: `No matching define(...) found in this target for procedures.call proccode "${callMatch[2]}". Define proccodes may name arguments like %n[value], but calls should use the same placeholder shape, e.g. "%n".`,
          });
        }
      }
    });

    return warnings;
  }

  private _getDataHealth(targets: any[], pathByTargetId: Map<any, string>, listRepairs: any[] = []) {
    const duplicateVariables: any[] = [];
    const duplicateLists: any[] = [];
    const nonArrayLists: any[] = [];
    const suspiciousGeneratedNames: any[] = [];

    targets.forEach((target: any) => {
      const path = pathByTargetId.get(target?.id) || this._getVirtualPathForTarget(target);
      const values = Object.values(target?.variables || {}) as any[];
      const groups = new Map<string, any[]>();
      const shortNames: any[] = [];

      values.forEach((variable: any) => {
        const type = variable?.type === "list" || Array.isArray(variable?.value) ? "list" : "variable";
        const name = String(variable?.name || "");
        const key = `${type}:${name}`;
        groups.set(key, [...(groups.get(key) || []), variable]);
        if (type === "list" && !Array.isArray(variable?.value)) {
          nonArrayLists.push({ path, id: variable?.id, name, valueType: typeof variable?.value });
        }
        if (/^[a-z]\d?$/i.test(name)) {
          shortNames.push({ id: variable?.id, name, type });
        }
      });

      groups.forEach((items, key) => {
        if (items.length < 2) return;
        const [type, name] = key.split(":");
        const issue = {
          path,
          name,
          ids: items.map((item) => item.id),
        };
        if (type === "list") duplicateLists.push(issue);
        else duplicateVariables.push(issue);
      });

      if (shortNames.length >= 10) {
        suspiciousGeneratedNames.push({
          path,
          count: shortNames.length,
          sample: shortNames.slice(0, 16),
          hint: 'Many one-letter/generated-looking data names exist. Prefer meaningful names and use custom block parameters via argument.reporter_string_number({ $field_VALUE: "param" }) instead of creating variables for parameters.',
        });
      }
    });

    return {
      listRepairs,
      duplicateVariables,
      duplicateLists,
      nonArrayLists,
      suspiciousGeneratedNames,
      healthy:
        listRepairs.length === 0 &&
        duplicateVariables.length === 0 &&
        duplicateLists.length === 0 &&
        nonArrayLists.length === 0 &&
        suspiciousGeneratedNames.length === 0,
    };
  }

  private _validateGeneratedBlocksForRuntime(section: VirtualScriptSection, blocks: any[]) {
    const errors: any[] = [];
    const warnings: any[] = [];
    const blocksById = new Map(blocks.map((block) => [block.id, block]));

    blocks.forEach((block) => {
      let blockInfo: any = null;
      try {
        blockInfo = this.getBlockInfo(block.opcode);
      } catch (error) {
        if (block?.shadow || this._isInternalShadowOpcode(block?.opcode)) {
          return;
        }
        errors.push({
          line: section.startLine,
          scriptId: section.scriptId,
          blockId: block.id,
          opcode: block.opcode,
          message: error instanceof Error ? error.message : `Unknown opcode: ${block.opcode}`,
        });
        return;
      }

      const menuSlots = { ...(blockInfo.fields || {}), ...(blockInfo.inputs || {}) };
      for (const [fieldName, fieldMeta] of Object.entries(menuSlots)) {
        const meta = fieldMeta as any;
        if (!meta?.menu && !meta?.menuType) continue;
        if (block.fields?.[fieldName] || block.inputs?.[fieldName]) continue;
        errors.push({
          line: section.startLine,
          scriptId: section.scriptId,
          blockId: block.id,
          opcode: block.opcode,
          message: `Missing menu value ${fieldName}. Use $field_${fieldName}, for example { $field_${fieldName}: ${JSON.stringify(meta.defaultValue ?? meta.menuOptions?.[0]?.value ?? "")} }.`,
        });
      }

      for (const [inputName, inputMeta] of Object.entries(blockInfo.inputs || {})) {
        if (!this._isBooleanInput(inputName, inputMeta)) continue;
        const childBlock = blocksById.get(block.inputs?.[inputName]?.block);
        if (!childBlock) continue;
        if (!this._isBooleanReporterBlock(childBlock)) {
          errors.push({
            line: section.startLine,
            scriptId: section.scriptId,
            blockId: block.id,
            opcode: block.opcode,
            inputName,
            message: `Input ${inputName} expects a Boolean block, but got ${childBlock.opcode}. Wrap reporters with operator.equals/operator.gt/operator.lt.`,
          });
        }
      }

      if (block.opcode === "pen_setPenColorToColor") {
        const colorBlock = blocksById.get(block.inputs?.COLOR?.block);
        const fieldValue =
          colorBlock?.fields?.COLOUR?.value ??
          colorBlock?.fields?.COLOR?.value ??
          colorBlock?.fields?.TEXT?.value ??
          colorBlock?.fields?.NUM?.value;
        if (
          colorBlock?.opcode === "math_number" ||
          (fieldValue !== undefined && !this._isValidColorLiteral(fieldValue))
        ) {
          errors.push({
            line: section.startLine,
            scriptId: section.scriptId,
            blockId: block.id,
            opcode: block.opcode,
            message:
              'pen.setPenColorToColor expects a hex color like "#4a90d9". For hue/brightness numbers, use pen.setPenColorParamTo({ $field_COLOR_PARAM: "color", VALUE: 50 }).',
          });
        }
      }
    });

    if (blocks.length > 80) {
      warnings.push({
        line: section.startLine,
        scriptId: section.scriptId,
        message: `Large script (${blocks.length} blocks). Prefer splitting into smaller broadcast or custom-block scripts for easier patching and debugging.`,
      });
    }

    return { errors, warnings };
  }

  private _validateVirtualTargetFile(entry: VirtualFileEntry, content: string) {
    const sections = extractVirtualScriptSections(content);
    const diagnostics: any = {
      path: entry.path,
      valid: true,
      scriptCount: sections.length,
      scripts: [] as any[],
      errors: [] as any[],
      warnings: [] as any[],
    };
    if (!sections.length) {
      diagnostics.errors.push({
        line: 1,
        message:
          (entry.scriptIds?.length || 0) > 1
            ? "Feature script files with multiple top-level scripts must keep // @script markers for each section."
            : "Script file has no // @script sections.",
      });
      diagnostics.valid = false;
      return diagnostics;
    }
    const seenScriptIds = new Set<string>();

    sections.forEach((section) => {
      if (seenScriptIds.has(section.scriptId)) {
        diagnostics.errors.push({
          line: section.markerLine,
          scriptId: section.scriptId,
          message: `Duplicate script marker "${section.scriptId}". Use unique // @script ids.`,
        });
      }
      seenScriptIds.add(section.scriptId);

      if (!section.code.trim()) {
        diagnostics.errors.push({
          line: section.startLine,
          scriptId: section.scriptId,
          message: "Script marker has no JavaScript block code.",
        });
        return;
      }

      const sourceDiagnostics = this._validateVirtualSourceSemantics(section);
      diagnostics.errors.push(...sourceDiagnostics.errors);
      diagnostics.warnings.push(...sourceDiagnostics.warnings);

      try {
        const blocks = ucfToScratch(normalizeModelUCF(section.code), {
          runtime: this.vm.runtime,
          includeComments: true,
        });
        const topLevelBlocks = blocks.filter((block: any) => block.topLevel);
        if (topLevelBlocks.length !== 1) {
          diagnostics.errors.push({
            line: section.startLine,
            scriptId: section.scriptId,
            message: `Each // @script section must produce exactly one top-level script; got ${topLevelBlocks.length}.`,
          });
        }
        const runtimeDiagnostics = this._validateGeneratedBlocksForRuntime(section, blocks);
        diagnostics.errors.push(...runtimeDiagnostics.errors);
        diagnostics.warnings.push(...runtimeDiagnostics.warnings);
        diagnostics.scripts.push({
          scriptId: section.scriptId,
          line: section.startLine,
          blockCount: blocks.length,
          commentCount: blocks.filter((block: any) => typeof block.commentText === "string" && block.commentText.trim())
            .length,
          topLevelBlockCount: topLevelBlocks.length,
        });
      } catch (error) {
        diagnostics.errors.push({
          line: section.startLine,
          scriptId: section.scriptId,
          message: error instanceof Error ? error.message : "Failed to parse script section.",
        });
      }
    });

    diagnostics.warnings.push(...this._validateProcedureCallsInSource(sections));

    const sourceText = String(content || "");
    const broadcastCount = (sourceText.match(/\bevent\.broadcast(?:andwait)?\s*\(/g) || []).length;
    const defineCount = (sourceText.match(/\bdefine\s*\(/g) || []).length;
    const hasPenRendering = /\bpen\./.test(sourceText) && /\bcontrol\.repeat/.test(sourceText);
    if (broadcastCount >= 4 && defineCount === 0) {
      diagnostics.warnings.push({
        line: 1,
        message:
          'This file uses many broadcasts but no custom blocks. Prefer define({ proccode: "...", info: ["warp"] }, () => { ... }) for local parameterized logic; keep broadcasts for cross-target events.',
      });
    }
    if (hasPenRendering && defineCount === 0) {
      diagnostics.warnings.push({
        line: 1,
        message:
          'Pen rendering loops should usually live in a warp custom block so the full frame draws without screen refresh. Example: define({ proccode: "draw frame %n[left] %n[right]", info: ["warp"] }, () => { ... }).',
      });
    }

    diagnostics.valid = diagnostics.errors.length === 0;
    return diagnostics;
  }

  private _validateVirtualScriptFile(entry: VirtualFileEntry, content: string) {
    const section: VirtualScriptSection = {
      scriptId: entry.scriptId || "new-script",
      markerLine: 1,
      startLine: 1,
      endLine: getLineCount(content),
      code: String(content || "").trim(),
      normalizedCode: normalizeVirtualCodeForCompare(content),
      isNew: !entry.scriptId,
    };
    const diagnostics: any = {
      path: entry.path,
      valid: true,
      scriptCount: section.code ? 1 : 0,
      scripts: [] as any[],
      errors: [] as any[],
      warnings: [] as any[],
      syncStatus: entry.syncStatus || "synced",
    };

    if (!section.code) {
      diagnostics.errors.push({
        line: 1,
        scriptId: section.scriptId,
        message: "Script file has no JavaScript block code.",
      });
      diagnostics.valid = false;
      return diagnostics;
    }

    const sourceDiagnostics = this._validateVirtualSourceSemantics(section);
    diagnostics.errors.push(...sourceDiagnostics.errors);
    diagnostics.warnings.push(...sourceDiagnostics.warnings);

    try {
      const blocks = ucfToScratch(normalizeModelUCF(section.code), {
        runtime: this.vm.runtime,
        includeComments: true,
      });
      const topLevelBlocks = blocks.filter((block: any) => block.topLevel);
      if (topLevelBlocks.length !== 1) {
        diagnostics.errors.push({
          line: 1,
          scriptId: section.scriptId,
          message: `A script file must produce exactly one top-level script; got ${topLevelBlocks.length}.`,
        });
      }
      const runtimeDiagnostics = this._validateGeneratedBlocksForRuntime(section, blocks);
      diagnostics.errors.push(...runtimeDiagnostics.errors);
      diagnostics.warnings.push(...runtimeDiagnostics.warnings);
      diagnostics.scripts.push({
        scriptId: section.scriptId,
        line: 1,
        blockCount: blocks.length,
        commentCount: blocks.filter((block: any) => typeof block.commentText === "string" && block.commentText.trim())
          .length,
        topLevelBlockCount: topLevelBlocks.length,
        hatOpcode: topLevelBlocks[0]?.opcode,
      });
    } catch (error) {
      diagnostics.errors.push({
        line: 1,
        scriptId: section.scriptId,
        message: error instanceof Error ? error.message : "Failed to parse script file.",
      });
    }

    diagnostics.valid = diagnostics.errors.length === 0;
    return diagnostics;
  }

  private async _insertScriptByUCF(targetId: string, ucfString: string) {
    return insertScriptByUCF(this.vm, this._getWorkspace() as Blockly.WorkspaceSvg, targetId, ucfString, {
      includeComments: true,
      blockly: this.blockly,
    });
  }

  private async _createProjectSnapshot(): Promise<ProjectRollbackSnapshot> {
    const snapshot = await createProjectSnapshot(this.vm);
    if (snapshot) {
      return snapshot;
    }

    return {
      projectJson: typeof this.vm?.toJSON === "function" ? this.vm.toJSON() : "",
    };
  }

  private async _restoreProjectSnapshot(snapshot: ProjectRollbackSnapshot) {
    if (!snapshot || typeof this.vm?.loadProject !== "function") return false;
    if (snapshot.projectData instanceof ArrayBuffer) {
      return restoreProjectSnapshot(this.vm, snapshot);
    }
    if (snapshot.projectJson) {
      try {
        await this.vm.loadProject(JSON.parse(snapshot.projectJson));
        return true;
      } catch (error) {
        console.error("[AI Assistant VFS] Failed to rollback project JSON snapshot", error);
      }
    }
    return false;
  }

  private _formatSyncFailure(action: string, scriptId: string, result: any) {
    const details = {
      stage: result?.stage,
      diagnostics: result?.diagnostics,
    };
    const detailText = Object.values(details).some(Boolean) ? ` ${JSON.stringify(details).slice(0, 800)}` : "";
    return `${action} script ${scriptId}: ${result?.error || "unknown error"}.${detailText}`;
  }

  private _buildEmptySpriteJson(name: string) {
    const defaultCostume = this._buildSvgCostumeObject("造型1", DEFAULT_NEW_TARGET_SVG);
    return {
      isStage: false,
      name,
      variables: {},
      lists: {},
      broadcasts: {},
      blocks: {},
      comments: {},
      currentCostume: 0,
      costumes: [
        {
          assetId: defaultCostume.assetId,
          md5ext: `${defaultCostume.assetId}.${defaultCostume.dataFormat}`,
          asset: defaultCostume.asset,
          name: defaultCostume.name,
          bitmapResolution: defaultCostume.bitmapResolution,
          dataFormat: defaultCostume.dataFormat,
          rotationCenterX: defaultCostume.rotationCenterX,
          rotationCenterY: defaultCostume.rotationCenterY,
        },
      ],
      sounds: [],
      volume: 100,
      visible: true,
      x: 0,
      y: 0,
      size: 100,
      direction: 90,
      draggable: false,
      rotationStyle: "all around",
    };
  }

  private _buildSvgCostumeObject(name: string, svgCode: string) {
    const storage = this.vm?.runtime?.storage;
    if (!storage?.createAsset) {
      throw new Error("Current VM storage does not support creating SVG assets.");
    }
    const asset = storage.createAsset(
      storage.AssetType.ImageVector,
      storage.DataFormat?.SVG || "svg",
      new TextEncoder().encode(svgCode),
      null,
      true,
    );
    const { width, height, rotationCenterX, rotationCenterY } = getSvgGeometry(svgCode);
    return {
      asset,
      assetId: asset.assetId,
      md5: `${asset.assetId}.${asset.dataFormat}`,
      name,
      bitmapResolution: 1,
      dataFormat: asset.dataFormat,
      rotationCenterX,
      rotationCenterY,
      width,
      height,
    };
  }

  private async _createSpriteFromFolderPath(path: string) {
    if (!isRootSpriteFolderPath(path)) {
      throw new Error("New sprite folders must be created at the virtual root, for example *** Add File: /Sprite");
    }
    const spriteName = getSpriteFolderNameFromPath(path).trim();
    if (!spriteName) {
      throw new Error("Sprite folder name cannot be empty.");
    }
    if (typeof this.vm?.addSprite !== "function") {
      throw new Error("Current VM does not support adding sprites.");
    }
    await this.vm.addSprite(this._buildEmptySpriteJson(spriteName));
    const target = this.vm?.editingTarget;
    return {
      type: "addSprite",
      path: normalizeVirtualPath(path),
      targetId: target?.id,
      targetName: target ? this._getTargetName(target) : spriteName,
    };
  }

  private _renameSpriteFolder(entry: VirtualFileEntry, newPath: string) {
    if (entry.kind !== "dir" || entry.isStage || !entry.targetId) {
      throw new Error("Only sprite root folders can be renamed.");
    }
    if (!isRootSpriteFolderPath(newPath)) {
      throw new Error("Sprite folders can only be renamed within the virtual root.");
    }
    const spriteName = getSpriteFolderNameFromPath(newPath).trim();
    if (!spriteName) {
      throw new Error("Sprite folder name cannot be empty.");
    }
    if (typeof this.vm?.renameSprite !== "function") {
      throw new Error("Current VM does not support renaming sprites.");
    }
    this.vm.renameSprite(entry.targetId, spriteName);
    return {
      type: "renameSprite",
      oldPath: entry.path,
      newPath: normalizeVirtualPath(newPath),
      targetId: entry.targetId,
      oldName: entry.targetName,
      newName: spriteName,
    };
  }

  private _deleteSpriteFolder(entry: VirtualFileEntry) {
    if (entry.kind !== "dir" || entry.isStage || !entry.targetId) {
      throw new Error("Only sprite root folders can be deleted.");
    }
    if (typeof this.vm?.deleteSprite !== "function") {
      throw new Error("Current VM does not support deleting sprites.");
    }
    this.vm.deleteSprite(entry.targetId);
    return {
      type: "deleteSprite",
      path: entry.path,
      targetId: entry.targetId,
      targetName: entry.targetName,
    };
  }

  private _resolveTargetForAssetPath(path: string, entries = this._getVirtualFiles()): VirtualAssetPathResolution | null {
    const segments = splitVirtualPath(path);
    if (segments.length !== 3 || ![VIRTUAL_COSTUME_DIR_NAME, VIRTUAL_SOUND_DIR_NAME].includes(segments[1])) {
      return null;
    }

    const rootPath = `/${segments[0]}`;
    const rootEntry = entries.find(
      (entry) => entry.kind === "dir" && entry.path === rootPath && entry.targetId,
    );
    if (!rootEntry?.targetId) return null;

    return {
      rootPath,
      targetId: rootEntry.targetId,
      targetName: segments[0] || rootEntry.targetName,
      isStage: Boolean(rootEntry.isStage),
      folderName: segments[1],
      fileName: segments[2],
    };
  }

  private async _createSvgCostumeFile(path: string, content: string, resolved = this._resolveTargetForAssetPath(path)) {
    if (!resolved || resolved.folderName !== VIRTUAL_COSTUME_DIR_NAME) {
      throw new Error("SVG costumes must be added under /target/custom, for example /stage/custom/backdrop.svg.");
    }
    if (getFileExtension(resolved.fileName) !== "svg") {
      throw new Error("Only SVG costume files can be created directly. Use insertCostume for generated costumes.");
    }
    const submittedSvgCode = extractSvgCodeFromText(content);
    const normalizedSvg = ensureSvgRotationCenterAttrs(submittedSvgCode);
    const svgCode = normalizedSvg.svgCode;
    const costumeName = getFileStem(resolved.fileName).trim() || "costume";
    if (typeof this.vm?.addCostume !== "function") {
      throw new Error("Current VM does not support adding SVG costumes.");
    }
    const costumeObject = this._buildSvgCostumeObject(costumeName, svgCode);
    await this.vm.addCostume(
      `${costumeObject.assetId}.${costumeObject.dataFormat}`,
      costumeObject,
      resolved.targetId,
      undefined,
      false,
    );

    return {
      type: "addCostumeSvg",
      path: normalizeVirtualPath(path),
      targetId: resolved.targetId,
      targetName: resolved.targetName,
      costumeName,
      rotationCenterX: normalizedSvg.geometry.rotationCenterX,
      rotationCenterY: normalizedSvg.geometry.rotationCenterY,
      normalizedContent: normalizedSvg.changed ? svgCode : undefined,
      normalizationReason: normalizedSvg.changed
        ? `${SVG_ROTATION_CENTER_X_ATTR} and ${SVG_ROTATION_CENTER_Y_ATTR} were added with the geometric center because they were missing.`
        : undefined,
    };
  }

  private _setEditingTargetForAssetOperation(targetId?: string) {
    if (!targetId) return null;
    const previousTargetId = this.vm?.editingTarget?.id || null;
    if (previousTargetId !== targetId && typeof this.vm?.setEditingTarget === "function") {
      this.vm.setEditingTarget(targetId);
    }
    return previousTargetId;
  }

  private _restoreEditingTarget(previousTargetId: string | null) {
    if (
      previousTargetId &&
      this.vm?.editingTarget?.id !== previousTargetId &&
      typeof this.vm?.setEditingTarget === "function"
    ) {
      this.vm.setEditingTarget(previousTargetId);
    }
  }

  private _resolveCostumeForEntry(entry: VirtualFileEntry) {
    if (entry.kind !== "costume" || !entry.targetId) {
      throw new Error("Only costume files can be synced as costumes.");
    }
    const target = this.vm.runtime?.getTargetById?.(entry.targetId);
    const costumes = this._getTargetCostumes(target);
    const matchesEntry = (costume: any) => {
      if (!costume) return false;
      if (entry.costumeId && costume?.id === entry.costumeId) return true;
      if (entry.assetName && costume?.name !== entry.assetName) return false;
      if (entry.dataFormat && String(costume?.dataFormat || "").toLowerCase() !== entry.dataFormat) return false;
      return Boolean(entry.assetName || entry.dataFormat);
    };
    let index = entry.costumeId ? costumes.findIndex((costume) => costume?.id === entry.costumeId) : -1;
    if (index < 0 && typeof entry.costumeIndex === "number" && matchesEntry(costumes[entry.costumeIndex])) {
      index = entry.costumeIndex;
    }
    if (index < 0) {
      const matchingIndexes = costumes.map((costume, itemIndex) => (matchesEntry(costume) ? itemIndex : -1)).filter((itemIndex) => itemIndex >= 0);
      if (matchingIndexes.length === 1) index = matchingIndexes[0];
    }
    if (index < 0 || !costumes[index]) {
      throw new Error(`Costume not found while syncing ${entry.path}. Re-read listFiles and retry with the current costume path.`);
    }
    return { target, costumes, costume: costumes[index], index, oldIndex: entry.costumeIndex };
  }

  private _resolveSoundForEntry(entry: VirtualFileEntry) {
    if (entry.kind !== "sound" || !entry.targetId) {
      throw new Error("Only audio files can be synced as sounds.");
    }
    const target = this.vm.runtime?.getTargetById?.(entry.targetId);
    const sounds = this._getTargetSounds(target);
    const matchesEntry = (sound: any) => {
      if (!sound) return false;
      if (entry.soundId && sound?.soundId === entry.soundId) return true;
      if (entry.assetName && sound?.name !== entry.assetName) return false;
      if (entry.dataFormat && String(sound?.dataFormat || "").toLowerCase() !== entry.dataFormat) return false;
      return Boolean(entry.assetName || entry.dataFormat);
    };
    let index = entry.soundId ? sounds.findIndex((sound) => sound?.soundId === entry.soundId) : -1;
    if (index < 0 && typeof entry.soundIndex === "number" && matchesEntry(sounds[entry.soundIndex])) {
      index = entry.soundIndex;
    }
    if (index < 0) {
      const matchingIndexes = sounds.map((sound, itemIndex) => (matchesEntry(sound) ? itemIndex : -1)).filter((itemIndex) => itemIndex >= 0);
      if (matchingIndexes.length === 1) index = matchingIndexes[0];
    }
    if (index < 0 || !sounds[index]) {
      throw new Error(`Sound not found while syncing ${entry.path}. Re-read listFiles and retry with the current sound path.`);
    }
    return { target, sounds, sound: sounds[index], index, oldIndex: entry.soundIndex };
  }

  private _getCostumeOrderSnapshot(target: any) {
    const costumes = this._getTargetCostumes(target);
    const rootPath = this._getVirtualRootPathForTarget(target);
    const fileNames = this._getUniqueAssetFileNames(costumes, {
      fallbackPrefix: "costume",
      getFormat: (costume) => String(costume?.dataFormat || "dat"),
    });
    return costumes.map((costume: any, index: number) => ({
      costume,
      index,
      id: costume?.id,
      name: costume?.name || fileNames[index] || `costume-${index + 1}`,
      path: `${rootPath}/${VIRTUAL_COSTUME_DIR_NAME}/${fileNames[index]}`,
      fileName: fileNames[index],
    }));
  }

  private _parseCostumeOrderJson(content: string) {
    let value: any;
    try {
      value = JSON.parse(content || "[]");
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : "Invalid costume order JSON.");
    }
    if (!Array.isArray(value)) {
      throw new Error("Costume order must be a JSON array.");
    }
    return value.map((item, index) => {
      if (typeof item === "string") {
        const text = item.trim();
        if (!text) throw new Error(`Costume order item ${index + 1} is empty.`);
        return { raw: item, id: text, path: text, name: text, fileName: getVirtualBaseName(text) };
      }
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        throw new Error(`Costume order item ${index + 1} must be an object or string.`);
      }
      const id = typeof item.id === "string" ? item.id.trim() : "";
      const path = typeof item.path === "string" ? normalizeVirtualPath(item.path) : "";
      const name = typeof item.name === "string" ? item.name.trim() : "";
      const fileName = path ? getVirtualBaseName(path) : typeof item.fileName === "string" ? item.fileName.trim() : "";
      if (!id && !path && !name && !fileName) {
        throw new Error(`Costume order item ${index + 1} must include id, path, name, or fileName.`);
      }
      return { raw: item, id, path, name, fileName };
    });
  }

  private _resolveCostumeOrder(entry: VirtualFileEntry, content: string) {
    if (entry.kind !== "costumeOrder" || !entry.targetId) {
      throw new Error("Only custom/order.json files can sync costume order.");
    }
    const target = this.vm.runtime?.getTargetById?.(entry.targetId);
    if (!target) throw new Error(`Target not found while syncing ${entry.path}.`);

    const current = this._getCostumeOrderSnapshot(target);
    const desired = this._parseCostumeOrderJson(content);
    if (desired.length !== current.length) {
      throw new Error(`Costume order must include every current costume exactly once (${current.length} items).`);
    }

    const used = new Set<number>();
    const findCandidates = (item: any) => {
      const available = current.map((costume, index) => ({ costume, index })).filter(({ index }) => !used.has(index));
      const matchers = [
        item.id ? (candidate: any) => candidate.id === item.id : null,
        item.path ? (candidate: any) => candidate.path === item.path : null,
        item.fileName ? (candidate: any) => candidate.fileName === item.fileName : null,
        item.name ? (candidate: any) => candidate.name === item.name : null,
      ].filter(Boolean) as Array<(candidate: any) => boolean>;

      for (const matches of matchers) {
        const candidates = available.filter(({ costume }) => matches(costume));
        if (candidates.length > 0) return candidates;
      }
      return [];
    };

    const ordered = desired.map((item, desiredIndex) => {
      const candidates = findCandidates(item);
      if (candidates.length !== 1) {
        const label = item.id || item.path || item.fileName || item.name || `item ${desiredIndex + 1}`;
        throw new Error(
          candidates.length === 0
            ? `Costume order item not found: ${label}. Re-read ${entry.path} and keep current id/path values.`
            : `Costume order item is ambiguous: ${label}. Use costume id values from ${entry.path}.`,
        );
      }
      used.add(candidates[0].index);
      return candidates[0].costume;
    });

    return { target, current, ordered };
  }

  private _deleteCostumeFile(entry: VirtualFileEntry) {
    const resolved = this._resolveCostumeForEntry(entry);
    const { target, costumes, index } = resolved;
    if (costumes.length <= 1) {
      throw new Error("Cannot delete the only costume of a sprite.");
    }
    const previousTargetId = this._setEditingTargetForAssetOperation(entry.targetId);
    try {
      if (typeof this.vm?.deleteCostume === "function") {
        this.vm.deleteCostume(index);
      } else {
        target?.deleteCostume?.(index);
        this.vm?.runtime?.emitProjectChanged?.();
        this.vm?.emitTargetsUpdate?.();
      }
    } finally {
      this._restoreEditingTarget(previousTargetId);
    }
    return {
      type: "deleteCostume",
      path: entry.path,
      targetId: entry.targetId,
      costumeId: entry.costumeId,
      oldIndex: resolved.oldIndex,
      resolvedIndex: index,
      costumeName: entry.assetName,
    };
  }

  private _deleteSoundFile(entry: VirtualFileEntry) {
    const resolved = this._resolveSoundForEntry(entry);
    const { target, index } = resolved;
    const previousTargetId = this._setEditingTargetForAssetOperation(entry.targetId);
    try {
      if (typeof this.vm?.deleteSound === "function") {
        this.vm.deleteSound(index);
      } else {
        target?.deleteSound?.(index);
        this.vm?.runtime?.emitProjectChanged?.();
        this.vm?.emitTargetsUpdate?.();
      }
    } finally {
      this._restoreEditingTarget(previousTargetId);
    }
    return {
      type: "deleteSound",
      path: entry.path,
      targetId: entry.targetId,
      soundId: entry.soundId,
      oldIndex: resolved.oldIndex,
      resolvedIndex: index,
      soundName: entry.assetName,
    };
  }

  private _reorderCostumeFile(entry: VirtualFileEntry, content: string) {
    const { target, current, ordered } = this._resolveCostumeOrder(entry, content);
    const operations: any[] = [];
    const previousTargetId = this._setEditingTargetForAssetOperation(entry.targetId);
    try {
      if (typeof this.vm?.reorderCostume === "function") {
        for (let newIndex = 0; newIndex < ordered.length; newIndex += 1) {
          const currentCostumes = this._getTargetCostumes(target);
          const costume = ordered[newIndex].costume;
          const currentIndex = currentCostumes.findIndex((item: any) => item === costume || (costume?.id && item?.id === costume.id));
          if (currentIndex < 0) throw new Error(`Costume disappeared while reordering ${entry.path}.`);
          if (currentIndex === newIndex) continue;
          const ok = this.vm.reorderCostume(entry.targetId, currentIndex, newIndex);
          if (ok === false) throw new Error(`Scratch VM rejected costume reorder from ${currentIndex} to ${newIndex}.`);
          operations.push({ type: "moveCostume", id: costume?.id, name: costume?.name, from: currentIndex, to: newIndex });
        }
      } else if (Array.isArray(target?.sprite?.costumes_)) {
        const currentCostume = target.sprite.costumes_[target.currentCostume || 0];
        target.sprite.costumes_ = ordered.map((item) => item.costume);
        if (currentCostume) {
          const currentIndex = target.sprite.costumes_.indexOf(currentCostume);
          target.currentCostume = currentIndex >= 0 ? currentIndex : Math.min(Math.max(target.currentCostume || 0, 0), target.sprite.costumes_.length - 1);
        }
        this.vm?.runtime?.emitProjectChanged?.();
        this.vm?.emitTargetsUpdate?.();
        operations.push({ type: "setCostumeOrder", count: ordered.length });
      } else {
        throw new Error("Current VM does not support reordering costumes.");
      }
    } finally {
      this._restoreEditingTarget(previousTargetId);
    }

    return {
      path: entry.path,
      targetId: entry.targetId,
      operationCount: operations.length || 1,
      operations: operations.length ? operations : [{ type: "costumeOrderUnchanged", count: ordered.length }],
      previousOrder: current.map((item) => ({ id: item.id, name: item.name, index: item.index })),
      newOrder: ordered.map((item, index) => ({ id: item.id, name: item.name, index })),
    };
  }

  private _renameCostumeFile(entry: VirtualFileEntry, newPath: string) {
    const resolved = this._resolveCostumeForEntry(entry);
    const { target, index } = resolved;
    if (getVirtualParentPath(newPath) !== getVirtualParentPath(entry.path)) {
      throw new Error("Costume files can only be renamed inside the same custom folder.");
    }
    const newName = sanitizePathSegment(getFileStem(getVirtualBaseName(newPath)), entry.assetName || "costume");
    const previousTargetId = this._setEditingTargetForAssetOperation(entry.targetId);
    try {
      if (typeof this.vm?.renameCostume === "function") {
        this.vm.renameCostume(index, newName);
      } else {
        target?.renameCostume?.(index, newName);
        this.vm?.emitTargetsUpdate?.();
      }
    } finally {
      this._restoreEditingTarget(previousTargetId);
    }
    return {
      type: "renameCostume",
      oldPath: entry.path,
      newPath: normalizeVirtualPath(newPath),
      targetId: entry.targetId,
      costumeId: entry.costumeId,
      oldIndex: resolved.oldIndex,
      resolvedIndex: index,
      oldName: entry.assetName,
      newName,
    };
  }

  private _renameSoundFile(entry: VirtualFileEntry, newPath: string) {
    const resolved = this._resolveSoundForEntry(entry);
    const { target, index } = resolved;
    if (getVirtualParentPath(newPath) !== getVirtualParentPath(entry.path)) {
      throw new Error("Audio files can only be renamed inside the same audio folder.");
    }
    const newName = sanitizePathSegment(getFileStem(getVirtualBaseName(newPath)), entry.assetName || "sound");
    const previousTargetId = this._setEditingTargetForAssetOperation(entry.targetId);
    try {
      if (typeof this.vm?.renameSound === "function") {
        this.vm.renameSound(index, newName);
      } else {
        target?.renameSound?.(index, newName);
        this.vm?.emitTargetsUpdate?.();
      }
    } finally {
      this._restoreEditingTarget(previousTargetId);
    }
    return {
      type: "renameSound",
      oldPath: entry.path,
      newPath: normalizeVirtualPath(newPath),
      targetId: entry.targetId,
      soundId: entry.soundId,
      oldIndex: resolved.oldIndex,
      resolvedIndex: index,
      oldName: entry.assetName,
      newName,
    };
  }

  private _renameScriptFile(entry: VirtualFileEntry, newPath: string) {
    if (entry.kind !== "script" || !isVirtualScriptFilePath(newPath)) {
      throw new Error("Only script files under /<target>/scripts/*.js can be renamed as scripts.");
    }
    if (getVirtualParentPath(newPath) !== getVirtualParentPath(entry.path)) {
      throw new Error("Script files can only be renamed inside the same scripts folder.");
    }
    const scriptIds = entry.scriptIds?.length ? entry.scriptIds : entry.scriptId ? [entry.scriptId] : [];
    if (entry.targetId && scriptIds.length) {
      scriptIds.forEach((scriptId) => {
        this.scriptFileNameByScriptKey.set(`${entry.targetId}:${scriptId}`, getVirtualBaseName(newPath));
        this._updateScriptFileNameInTargetComment(entry.targetId, scriptId, getVirtualBaseName(newPath));
      });
    }
    const draft = this.virtualFileDrafts.get(entry.path);
    if (draft) {
      this.virtualFileDrafts.delete(entry.path);
      this.virtualFileDrafts.set(normalizeVirtualPath(newPath), draft);
    }
    if (!scriptIds.length && !draft) {
      this.virtualFileDrafts.set(normalizeVirtualPath(newPath), {
        content: entry.content,
        diagnostics: null,
        updatedAt: Date.now(),
      });
    }
    return {
      type: "renameScript",
      oldPath: entry.path,
      newPath: normalizeVirtualPath(newPath),
      targetId: entry.targetId,
      scriptId: entry.scriptId,
      scriptIds,
    };
  }

  private async _deleteScriptFile(entry: VirtualFileEntry) {
    if (entry.kind !== "script") {
      throw new Error("Only script files can be deleted as scripts.");
    }
    this.virtualFileDrafts.delete(entry.path);
    const scriptIds = entry.scriptIds?.length ? entry.scriptIds : entry.scriptId ? [entry.scriptId] : [];
    if (!scriptIds.length) {
      return {
        type: "deleteScriptDraft",
        path: entry.path,
        targetId: entry.targetId,
      };
    }
    const results = [];
    for (const scriptId of scriptIds) {
      const result: any = await deleteScriptById(
        this.vm,
        this._getWorkspace() as Blockly.WorkspaceSvg,
        scriptId,
        this.blockly,
      );
      if (!result.success) {
        throw new Error(this._formatSyncFailure("Failed to delete", scriptId, result));
      }
      if (entry.targetId) {
        this.scriptFileNameByScriptKey.delete(`${entry.targetId}:${scriptId}`);
        this._deleteScriptFileNameFromTargetComment(entry.targetId, scriptId);
      }
      results.push({ scriptId, result });
    }
    return {
      type: "deleteScript",
      path: entry.path,
      targetId: entry.targetId,
      scriptId: entry.scriptId,
      scriptIds,
      results,
    };
  }

  private _updateSvgCostumeFile(entry: VirtualFileEntry, content: string) {
    if (entry.kind !== "costume" || entry.dataFormat !== "svg" || !entry.targetId) {
      throw new Error("Only SVG costume files can be updated.");
    }
    const submittedSvgCode = extractSvgCodeFromText(content);
    const normalizedSvg = ensureSvgRotationCenterAttrs(submittedSvgCode);
    const svgCode = normalizedSvg.svgCode;
    const resolved = this._resolveCostumeForEntry(entry);
    const { costume, index } = resolved;
    const { width, height, rotationCenterX, rotationCenterY } = normalizedSvg.geometry;

    if (typeof this.vm?.updateSvg === "function") {
      const previousTargetId = this._setEditingTargetForAssetOperation(entry.targetId);
      try {
        this.vm.updateSvg(
          index,
          svgCode,
          rotationCenterX,
          rotationCenterY,
        );
      } finally {
        this._restoreEditingTarget(previousTargetId);
      }
    } else if (this.vm.runtime?.storage) {
      costume.rotationCenterX = rotationCenterX;
      costume.rotationCenterY = rotationCenterY;
      costume.dataFormat = "svg";
      costume.bitmapResolution = 1;
      costume.asset = this.vm.runtime.storage.createAsset(
        this.vm.runtime.storage.AssetType.ImageVector,
        this.vm.runtime.storage.DataFormat?.SVG || "svg",
        new TextEncoder().encode(svgCode),
        null,
        true,
      );
      costume.assetId = costume.asset.assetId;
      costume.md5 = `${costume.assetId}.${costume.dataFormat}`;
      costume.size = [width, height];
      this.vm?.emitTargetsUpdate?.();
    } else {
      throw new Error("Current VM does not support updating SVG costumes.");
    }

    return {
      type: "updateCostumeSvg",
      path: entry.path,
      targetId: entry.targetId,
      costumeId: entry.costumeId,
      oldIndex: resolved.oldIndex,
      resolvedIndex: index,
      costumeName: entry.assetName,
      rotationCenterX,
      rotationCenterY,
      normalizedContent: normalizedSvg.changed ? svgCode : undefined,
      normalizationReason: normalizedSvg.changed
        ? `${SVG_ROTATION_CENTER_X_ATTR} and ${SVG_ROTATION_CENTER_Y_ATTR} were added with the geometric center because they were missing.`
        : undefined,
    };
  }

  private _syncTargetDataFile(entry: VirtualFileEntry, content: string) {
    if ((entry.kind !== "variables" && entry.kind !== "lists") || !entry.targetId) {
      throw new Error("Only variables.json or lists.json files can sync target data.");
    }
    const target = this.vm.runtime?.getTargetById?.(entry.targetId);
    if (!target) {
      throw new Error(`Target not found while syncing ${entry.path}.`);
    }
    const type = entry.kind;
    const desired = this._parseTargetDataJson(content, type);
    const existing = this._getTargetDataEntries(target, type);
    const operations: any[] = [];

    for (const variable of existing) {
      const keep = desired.some((item) => (item.id && item.id === variable?.id) || (!item.id && item.name === variable?.name));
      if (!keep) {
        if (target.variables && variable?.id) {
          delete target.variables[variable.id];
        }
        operations.push({ type: type === "lists" ? "deleteList" : "deleteVariable", id: variable.id, name: variable.name });
      }
    }

    for (const item of desired) {
      let variable = this._findTargetVariableByIdOrName(target, item, type);
      if (!variable) {
        variable = this._createTargetVariable(target, item, type);
        operations.push({ type: type === "lists" ? "createList" : "createVariable", id: variable?.id || item.id, name: item.name });
      } else if (variable.name !== item.name) {
        variable.name = item.name;
        variable._name = item.name;
        operations.push({ type: type === "lists" ? "renameList" : "renameVariable", id: variable.id, name: item.name });
      }
      this._setTargetVariableValue(variable, item.value, type);
      operations.push({ type: type === "lists" ? "setListValue" : "setVariableValue", id: variable?.id || item.id, name: item.name });
    }

    this._notifyTargetDataChanged(target);
    return {
      path: entry.path,
      aliasPath: entry.aliasPath,
      canonicalPath: entry.path,
      targetId: entry.targetId,
      operationCount: operations.length,
      hint: entry.aliasPath
        ? `${entry.aliasPath} is an alias for global ${entry.path}. Targets do not have private variables/lists; prefer editing ${entry.path} directly.`
        : undefined,
      operations,
    };
  }

  private _getEntriesForNewPathAfterMove(entry: VirtualFileEntry, newPath: string) {
    const targets = Array.isArray(this.vm.runtime?.targets) ? this.vm.runtime.targets : [];
    const target = targets.find((item: any) => item?.id === entry.targetId);
    if (!target) return [];
    const oldRootPath = entry.kind === "dir" ? entry.path : entry.isStage ? "/" : getVirtualParentPath(entry.path);
    const normalizedNewPath = normalizeVirtualPath(newPath);
    const rootPath = entry.kind === "dir" ? normalizedNewPath : getVirtualParentPath(normalizedNewPath);
    const scriptPath = entry.kind === "target" ? normalizedNewPath : `${rootPath}/${VIRTUAL_SCRIPT_FILE_NAME}`;
    const syntheticPathByTargetId = new Map<string, string>();
    targets.forEach((item: any) => {
      if (!item?.id) return;
      if (item.id === target.id) syntheticPathByTargetId.set(item.id, scriptPath);
      else syntheticPathByTargetId.set(item.id, this._getVirtualPathForTarget(item));
    });
    const scriptEntries = this._buildScriptFileEntriesForTarget(target, rootPath);
    const allScriptEntries = [
      ...scriptEntries,
      ...this._buildDraftScriptFileEntriesForTarget(
        target,
        rootPath,
        new Set(scriptEntries.map((scriptEntry) => scriptEntry.path)),
      ),
    ];
    return [
      {
        path: rootPath,
        kind: "dir" as VirtualFileKind,
        writable: true,
        deletable: true,
        targetId: target.id,
        targetName: this._getTargetName(target),
        isStage: false,
        description: `Sprite folder for ${this._getTargetName(target)}`,
        content: this._getVirtualDirContent(rootPath, [
          VIRTUAL_SCRIPT_FILE_NAME,
          VIRTUAL_SCRIPTS_DIR_NAME,
          VIRTUAL_COSTUME_DIR_NAME,
          VIRTUAL_SOUND_DIR_NAME,
        ]),
      },
      {
        path: `${rootPath}/${VIRTUAL_SCRIPTS_DIR_NAME}`,
        kind: "dir" as VirtualFileKind,
        writable: true,
        targetId: target.id,
        targetName: this._getTargetName(target),
        isStage: Boolean(target?.isStage),
        description: `Per-script files for ${this._getTargetName(target)}`,
        content: this._getVirtualDirContent(
          `${rootPath}/${VIRTUAL_SCRIPTS_DIR_NAME}`,
          allScriptEntries.map((scriptEntry) => getVirtualBaseName(scriptEntry.path)),
        ),
      },
      ...allScriptEntries,
      {
        ...entry,
        path: scriptPath,
        aliases: (entry.aliases || []).map((alias) => alias.replace(oldRootPath, rootPath)),
        targetName: this._getTargetName(target),
        content: this._buildTargetVirtualFile(target, scriptPath),
      },
      ...this._getAssetFileEntriesForTarget(target, syntheticPathByTargetId),
    ];
  }

  private _findEntryForSpriteFolderOperation(entries: VirtualFileEntry[], path: string) {
    const normalizedPath = normalizeVirtualPath(path);
    const entry = entries.find((item) => item.path === normalizedPath || item.aliases?.includes(normalizedPath));
    if (entry) return entry;
    if (!isRootSpriteFolderPath(path)) return null;
    const requestedFolderName = getSpriteFolderNameFromPath(path);
    const matches = entries
      .filter(
        (item) => item.kind === "dir" && !item.isStage && item.targetId && splitVirtualPath(item.path).length === 1,
      )
      .filter((item) => {
        const stableName = sanitizeSpriteFolderName(item.targetName || "");
        return stableName === requestedFolderName;
      });
    return matches.length === 1 ? matches[0] : null;
  }

  private _validatePatchFileChange(entry: VirtualFileEntry, content: string) {
    if (entry.kind === "script") {
      if ((entry.scriptIds?.length || 0) > 1 || extractVirtualScriptSections(content).length > 0) {
        return this._validateVirtualTargetFile(entry, content);
      }
      return this._validateVirtualScriptFile(entry, content);
    }
    if (entry.kind === "target") {
      return this._validateVirtualTargetFile(entry, content);
    }
    if (entry.kind === "costume" && entry.dataFormat === "svg") {
      const diagnostics: any = {
        path: entry.path,
        valid: true,
        scriptCount: 0,
        scripts: [],
        errors: [] as any[],
        warnings: [] as any[],
      };
      try {
        extractSvgCodeFromText(content);
      } catch (error) {
        diagnostics.valid = false;
        diagnostics.errors.push({ line: 1, message: error instanceof Error ? error.message : "Invalid SVG content." });
      }
      return diagnostics;
    }
    if (entry.kind === "costumeOrder") {
      const diagnostics: any = {
        path: entry.path,
        valid: true,
        errors: [] as any[],
        warnings: [] as any[],
      };
      try {
        this._resolveCostumeOrder(entry, content);
      } catch (error) {
        diagnostics.valid = false;
        diagnostics.errors.push({ line: 1, message: error instanceof Error ? error.message : "Invalid costume order." });
      }
      return diagnostics;
    }
    if (entry.kind === "variables" || entry.kind === "lists") {
      const diagnostics: any = {
        path: entry.path,
        valid: true,
        dataKind: entry.kind,
        errors: [] as any[],
        warnings: [] as any[],
      };
      try {
        this._parseTargetDataJson(content, entry.kind);
      } catch (error) {
        diagnostics.valid = false;
        diagnostics.errors.push({ line: 1, message: error instanceof Error ? error.message : `Invalid ${entry.kind}.json.` });
      }
      return diagnostics;
    }
    return {
      path: entry.path,
      valid: true,
      readOnly: !entry.writable,
      errors: [],
      warnings: [],
    };
  }

  private _preserveScriptDraft(entry: VirtualFileEntry, content: string, diagnostics: any) {
    if (entry.kind !== "script") return;
    const scriptIds = entry.scriptIds?.length ? entry.scriptIds : entry.scriptId ? [entry.scriptId] : [];
    if (entry.targetId && scriptIds.length) {
      scriptIds.forEach((scriptId) => {
        this.scriptFileNameByScriptKey.set(`${entry.targetId}:${scriptId}`, getVirtualBaseName(entry.path));
      });
    }
    this.virtualFileDrafts.set(entry.path, {
      content,
      diagnostics,
      updatedAt: Date.now(),
    });
  }

  private _bindPendingScriptEntry(entry: VirtualFileEntry, immediateResults: any[]): VirtualFileEntry {
    if (entry.kind !== "script" || entry.targetId || !entry.pendingRootPath) return entry;
    const addSpriteResult = immediateResults.find(
      (item) => item?.type === "addSprite" && normalizeVirtualPath(item.path) === entry.pendingRootPath,
    );
    if (!addSpriteResult?.targetId) {
      return entry;
    }
    return {
      ...entry,
      targetId: addSpriteResult.targetId,
      targetName: addSpriteResult.targetName || entry.pendingTargetName || entry.targetName,
      pendingRootPath: undefined,
      pendingTargetName: undefined,
    };
  }

  private _bindPendingTargetDataEntry(entry: VirtualFileEntry, immediateResults: any[]): VirtualFileEntry {
    if ((entry.kind !== "variables" && entry.kind !== "lists") || entry.targetId || !entry.pendingRootPath) return entry;
    const addSpriteResult = immediateResults.find(
      (item) => item?.type === "addSprite" && normalizeVirtualPath(item.path) === entry.pendingRootPath,
    );
    if (!addSpriteResult?.targetId) return entry;
    return {
      ...entry,
      targetId: addSpriteResult.targetId,
      targetName: addSpriteResult.targetName || entry.pendingTargetName || entry.targetName,
      pendingRootPath: undefined,
      pendingTargetName: undefined,
    };
  }

  private _resolveLatestEntryForSync(entry: VirtualFileEntry, immediateResults: any[]): VirtualFileEntry {
    const pendingBoundEntry = this._bindPendingScriptEntry(entry, immediateResults);
    const pendingDataEntry = this._bindPendingTargetDataEntry(pendingBoundEntry, immediateResults);
    const renameResult = immediateResults.find(
      (item) => item?.type === "renameSprite" && item?.targetId && item.targetId === pendingDataEntry.targetId,
    );
    const movedEntry = (() => {
      if (!renameResult || pendingDataEntry.isStage) return pendingDataEntry;
      const oldRoot = String(renameResult.oldPath || "");
      if (!oldRoot || !pendingDataEntry.path.startsWith(oldRoot)) return pendingDataEntry;
      return {
        ...pendingDataEntry,
        path: `${String(renameResult.newPath)}${pendingDataEntry.path.slice(oldRoot.length)}`,
      };
    })();
    if (movedEntry.kind !== "script" || !movedEntry.scriptId) return movedEntry;

    const latestEntry = this._findVirtualFileEntry(this._getVirtualFiles(), movedEntry.path);
    if (latestEntry?.kind === "script") {
      return latestEntry;
    }
    return movedEntry;
  }

  private async _syncVirtualFileChange(entry: VirtualFileEntry, oldContent: string, newContent: string) {
    if (entry.kind === "script") {
      return this._syncVirtualScriptFile(entry, oldContent, newContent);
    }
    if (entry.kind === "target") {
      return this._syncVirtualTargetFile(entry, oldContent, newContent);
    }
    if (entry.kind === "costume" && entry.dataFormat === "svg") {
      const result = this._updateSvgCostumeFile(entry, newContent);
      return {
        path: entry.path,
        targetId: entry.targetId,
        operationCount: 1,
        operations: [result],
      };
    }
    if (entry.kind === "costumeOrder") {
      return this._reorderCostumeFile(entry, newContent);
    }
    if (entry.kind === "variables" || entry.kind === "lists") {
      return this._syncTargetDataFile(entry, newContent);
    }
    return {
      path: entry.path,
      targetId: entry.targetId,
      operationCount: 0,
      operations: [],
    };
  }

  private async _syncVirtualScriptFile(entry: VirtualFileEntry, _oldContent: string, newContent: string) {
    if ((entry.scriptIds?.length || 0) > 1 || extractVirtualScriptSections(newContent).length > 0 || extractVirtualScriptSections(_oldContent).length > 0) {
      return this._syncVirtualTargetFile(entry, _oldContent, newContent);
    }
    const results = [];
    if (entry.scriptId) {
      const result: any = await replaceScriptByUCF(
        this.vm,
        this._getWorkspace() as Blockly.WorkspaceSvg,
        entry.scriptId,
        newContent,
        {
          includeComments: true,
          blockly: this.blockly,
        },
      );
      if (!result.success) {
        throw new Error(this._formatSyncFailure("Failed to replace", entry.scriptId, result));
      }
      if (result.insertedTopBlockId && entry.targetId) {
        if (entry.scriptId && entry.scriptId !== result.insertedTopBlockId) {
          this.scriptFileNameByScriptKey.delete(`${entry.targetId}:${entry.scriptId}`);
        }
        this.scriptFileNameByScriptKey.set(`${entry.targetId}:${result.insertedTopBlockId}`, getVirtualBaseName(entry.path));
        this._replaceScriptFileNameInTargetComment(
          entry.targetId,
          entry.scriptId,
          result.insertedTopBlockId,
          getVirtualBaseName(entry.path),
        );
      }
      results.push({ type: "replace", scriptId: entry.scriptId, result });
    } else {
      const result: any = await this._insertScriptByUCF(entry.targetId || "", newContent);
      if (!result.success) {
        throw new Error(this._formatSyncFailure("Failed to insert", entry.path, result));
      }
      if (result.insertedTopBlockId && entry.targetId) {
        this.scriptFileNameByScriptKey.set(`${entry.targetId}:${result.insertedTopBlockId}`, getVirtualBaseName(entry.path));
        this._updateScriptFileNameInTargetComment(entry.targetId, result.insertedTopBlockId, getVirtualBaseName(entry.path));
      }
      results.push({ type: "insert", scriptId: result.insertedTopBlockId || entry.scriptId || null, result });
    }

    return {
      path: entry.path,
      targetId: entry.targetId,
      operationCount: results.length,
      operations: results,
    };
  }

  private async _syncVirtualTargetFile(entry: VirtualFileEntry, oldContent: string, newContent: string) {
    let oldSections = extractVirtualScriptSections(oldContent);
    let newSections = extractVirtualScriptSections(newContent);
    if (!oldSections.length && entry.scriptId && String(oldContent || "").trim()) {
      oldSections = [{
        scriptId: entry.scriptId,
        markerLine: 1,
        startLine: 1,
        endLine: getLineCount(oldContent),
        code: String(oldContent || "").trim(),
        normalizedCode: normalizeVirtualCodeForCompare(oldContent),
        isNew: false,
      }];
    }
    if (!newSections.length && entry.scriptId && String(newContent || "").trim()) {
      newSections = [{
        scriptId: entry.scriptId,
        markerLine: 1,
        startLine: 1,
        endLine: getLineCount(newContent),
        code: String(newContent || "").trim(),
        normalizedCode: normalizeVirtualCodeForCompare(newContent),
        isNew: false,
      }];
    }
    const oldById = new Map(oldSections.map((section) => [section.scriptId, section]));
    const newById = new Map(newSections.map((section) => [section.scriptId, section]));
    const operations: any[] = [];

    for (const oldSection of oldSections) {
      if (!newById.has(oldSection.scriptId)) {
        operations.push({ type: "delete", section: oldSection });
      }
    }

    for (const newSection of newSections) {
      const oldSection = newSection.isNew ? undefined : oldById.get(newSection.scriptId);
      if (!oldSection) {
        operations.push({ type: "insert", section: newSection });
      } else if (oldSection.normalizedCode !== newSection.normalizedCode) {
        operations.push({ type: "replace", oldSection, section: newSection });
      }
    }

    const results = [];
    for (const operation of operations) {
      if (operation.type === "replace") {
        const result: any = await replaceScriptByUCF(
          this.vm,
          this._getWorkspace() as Blockly.WorkspaceSvg,
          operation.oldSection.scriptId,
          operation.section.code,
          {
            includeComments: true,
            blockly: this.blockly,
          },
        );
        if (!result.success) {
          throw new Error(this._formatSyncFailure("Failed to replace", operation.oldSection.scriptId, result));
        }
        if (entry.targetId && result.insertedTopBlockId) {
          this.scriptFileNameByScriptKey.delete(`${entry.targetId}:${operation.oldSection.scriptId}`);
          this.scriptFileNameByScriptKey.set(`${entry.targetId}:${result.insertedTopBlockId}`, getVirtualBaseName(entry.path));
          this._replaceScriptFileNameInTargetComment(
            entry.targetId,
            operation.oldSection.scriptId,
            result.insertedTopBlockId,
            getVirtualBaseName(entry.path),
          );
        }
        results.push({ type: "replace", scriptId: operation.oldSection.scriptId, result });
      } else if (operation.type === "delete") {
        const result: any = await deleteScriptById(
          this.vm,
          this._getWorkspace() as Blockly.WorkspaceSvg,
          operation.section.scriptId,
          this.blockly,
        );
        if (!result.success) {
          throw new Error(this._formatSyncFailure("Failed to delete", operation.section.scriptId, result));
        }
        if (entry.targetId) {
          this.scriptFileNameByScriptKey.delete(`${entry.targetId}:${operation.section.scriptId}`);
          this._deleteScriptFileNameFromTargetComment(entry.targetId, operation.section.scriptId);
        }
        results.push({ type: "delete", scriptId: operation.section.scriptId, result });
      } else if (operation.type === "insert") {
        const result: any = await this._insertScriptByUCF(entry.targetId || "", operation.section.code);
        if (!result.success) {
          throw new Error(this._formatSyncFailure("Failed to insert", operation.section.scriptId, result));
        }
        if (entry.targetId && result.insertedTopBlockId) {
          this.scriptFileNameByScriptKey.set(`${entry.targetId}:${result.insertedTopBlockId}`, getVirtualBaseName(entry.path));
          this._updateScriptFileNameInTargetComment(entry.targetId, result.insertedTopBlockId, getVirtualBaseName(entry.path));
        }
        results.push({ type: "insert", scriptId: result.insertedTopBlockId || operation.section.scriptId, result });
      }
    }

    return {
      path: entry.path,
      targetId: entry.targetId,
      operationCount: results.length,
      operations: results,
    };
  }

  getProjectIndexStatus() {
    const targets = this._getProjectIndexTargets();
    const targetStatuses = targets.map((target: any) => {
      const topBlocks = this._getTargetTopBlocks(target);
      const map = this._parseScriptFileNameMapFromTargetComment(target);
      const mappedIds = new Set(map.keys());
      const missingScriptIds = topBlocks.map((block: any) => block.id).filter((scriptId) => !mappedIds.has(scriptId));
      const hasIndexComment = this._hasAiAssistantScriptFilesComment(target);
      const required = topBlocks.length > 0;
      const built = !required || (hasIndexComment && missingScriptIds.length === 0);
      return {
        targetId: target.id,
        targetName: this._getTargetName(target),
        isStage: Boolean(target.isStage),
        required,
        built,
        hasIndexComment,
        scriptCount: topBlocks.length,
        mappedScriptCount: topBlocks.length - missingScriptIds.length,
        missingScriptIds,
        commentChunkCount: this._getAiAssistantScriptFilesComments(target).length,
        defaultScriptFileName: this._getDefaultScriptFileNameFromTargetComment(target),
      };
    });
    const requiredTargets = targetStatuses.filter((target) => target.required);
    const missingTargets = requiredTargets.filter((target) => !target.built);
    return {
      success: true,
      required: requiredTargets.length > 0,
      built: missingTargets.length === 0,
      blocked: missingTargets.length > 0,
      totalScriptCount: targetStatuses.reduce((sum, target) => sum + target.scriptCount, 0),
      mappedScriptCount: targetStatuses.reduce((sum, target) => sum + target.mappedScriptCount, 0),
      targets: targetStatuses,
      missingTargets,
    };
  }

  getProjectIndexSnapshot() {
    const targets = this._getProjectIndexTargets();
    const pathByTargetId = this._getVirtualPathMapForTargets(targets);
    const snapshotTargets = targets.map((target: any) => {
      const commentsByBlockId = this._getCommentsByBlockId(target);
      const rootPath = this._getVirtualRootPathForTarget(target, pathByTargetId);
      const topBlocks = this._getTargetTopBlocks(target);
      const persistedMap = this._parseScriptFileNameMapFromTargetComment(target);
      const hasIndexComment = this._hasAiAssistantScriptFilesComment(target);
      const topBlockIds = new Set(topBlocks.map((topBlock: any) => String(topBlock.id)));
      const missingScriptIds = topBlocks
        .map((topBlock: any) => String(topBlock.id))
        .filter((scriptId) => !persistedMap.has(scriptId));
      const existingFilesByName = new Map<string, string[]>();
      persistedMap.forEach((fileName, scriptId) => {
        if (!topBlockIds.has(String(scriptId))) return;
        existingFilesByName.set(fileName, [...(existingFilesByName.get(fileName) || []), String(scriptId)]);
      });
      const scripts = topBlocks.map((topBlock: any) => {
        const code = this._scratchScriptToUCF(target, topBlock.id, commentsByBlockId);
        const existingFileName = persistedMap.get(String(topBlock.id));
        return {
          scriptId: topBlock.id,
          hatOpcode: topBlock.opcode,
          x: typeof topBlock.x === "number" ? topBlock.x : undefined,
          y: typeof topBlock.y === "number" ? topBlock.y : undefined,
          blockCount: this._collectScriptBlockIds(target.blocks?._blocks || {}, topBlock.id).length,
          suggestedFileName: getScriptFileNameFromLabel(getScriptLabelFromCode(code, String(topBlock.opcode || "script")), "script"),
          indexed: Boolean(existingFileName),
          needsIndex: !existingFileName,
          existingFileName,
          code,
        };
      });
      return {
        targetId: target.id,
        targetName: this._getTargetName(target),
        isStage: Boolean(target.isStage),
        rootPath,
        hasIndexComment,
        missingScriptIds,
        mappedScriptCount: topBlocks.length - missingScriptIds.length,
        defaultScriptFileName: this._getDefaultScriptFileNameFromTargetComment(target),
        existingFiles: [...existingFilesByName.entries()].map(([fileName, scriptIds]) => ({ fileName, scriptIds })),
        scripts,
      };
    });
    return {
      success: true,
      targetCount: snapshotTargets.length,
      scriptCount: snapshotTargets.reduce((sum, target) => sum + target.scripts.length, 0),
      targets: snapshotTargets,
    };
  }

  applyProjectScriptIndex(indexPlan: any) {
    const targets = this._getProjectIndexTargets();
    const incremental = indexPlan?.incremental === true;
    const partial = indexPlan?.partial === true;
    const targetPlans = Array.isArray(indexPlan?.targets)
      ? indexPlan.targets
      : Array.isArray(indexPlan?.files)
        ? [{ files: indexPlan.files, defaultScriptFileName: indexPlan.defaultScriptFileName }]
        : [];
    if (!targetPlans.length) {
      throw new Error("Project index plan must include a targets array.");
    }

    const preparedWrites: Array<{
      target: any;
      topBlocks: any[];
      fileNameByScriptId: Map<string, string>;
      defaultScriptFileName: string;
    }> = [];
    targets.forEach((target: any) => {
      const topBlocks = this._getTargetTopBlocks(target);
      if (!topBlocks.length) return;
      const targetPlan =
        targetPlans.find((plan: any) => String(plan?.targetId || "") === String(target.id)) ||
        targetPlans.find((plan: any) => String(plan?.targetName || "") === this._getTargetName(target));
      if (!targetPlan && partial) return;
      const files = Array.isArray(targetPlan?.files) ? targetPlan.files : [];
      const defaultScriptFileName = getScriptFileNameFromLabel(
        getFileStem(targetPlan?.defaultScriptFileName || files[0]?.fileName || "default.js"),
        "default",
      );

      const expectedScriptIds = new Set(topBlocks.map((block: any) => String(block.id)));
      const seenScriptIds = new Set<string>();
      const seenFileNames = new Set<string>();
      const fileNameByScriptId = incremental
        ? new Map(
            [...this._parseScriptFileNameMapFromTargetComment(target).entries()].filter(([scriptId]) =>
              expectedScriptIds.has(String(scriptId)),
            ),
          )
        : new Map<string, string>();
      files.forEach((file: any, fileIndex: number) => {
        const rawFileName = String(file?.fileName || file?.path || `feature-${fileIndex + 1}.js`).split("/").filter(Boolean).pop() || "";
        const fileName = getScriptFileNameFromLabel(getFileStem(rawFileName), `feature-${fileIndex + 1}`);
        if (seenFileNames.has(fileName)) {
          throw new Error(`Project index has duplicate fileName after normalization: ${fileName}`);
        }
        seenFileNames.add(fileName);
        const scriptIds = Array.isArray(file?.scriptIds) ? file.scriptIds.map((scriptId: any) => String(scriptId)) : [];
        if (!scriptIds.length) {
          throw new Error(`Project index file ${fileName} has no scriptIds.`);
        }
        scriptIds.forEach((scriptId) => {
          if (!expectedScriptIds.has(scriptId)) {
            throw new Error(`Project index file ${fileName} references unknown scriptId: ${scriptId}`);
          }
          if (seenScriptIds.has(scriptId)) {
            throw new Error(`Project index references scriptId more than once: ${scriptId}`);
          }
          seenScriptIds.add(scriptId);
          fileNameByScriptId.set(scriptId, fileName);
        });
      });
      const missing = [...expectedScriptIds].filter((scriptId) => !fileNameByScriptId.has(scriptId));
      missing.forEach((scriptId) => {
        fileNameByScriptId.set(scriptId, defaultScriptFileName);
      });
      const commentTexts = this._buildScriptFileNameMapCommentTexts(fileNameByScriptId, defaultScriptFileName);
      const oversizedComment = commentTexts.find((text) => text.length > AI_ASSISTANT_SCRIPT_FILES_COMMENT_MAX_LENGTH);
      if (oversizedComment) {
        throw new Error(`Project index comment for ${this._getTargetName(target)} exceeds ${AI_ASSISTANT_SCRIPT_FILES_COMMENT_MAX_LENGTH} characters.`);
      }
      preparedWrites.push({
        target,
        topBlocks,
        fileNameByScriptId,
        defaultScriptFileName,
      });
    });

    const results: any[] = [];
    preparedWrites.forEach(({ target, topBlocks, fileNameByScriptId, defaultScriptFileName }) => {
      this._writeScriptFileNameMapToTargetComment(target, fileNameByScriptId, defaultScriptFileName);
      results.push({
        targetId: target.id,
        targetName: this._getTargetName(target),
        scriptCount: topBlocks.length,
        fileCount: new Set(fileNameByScriptId.values()).size,
        defaultScriptFileName,
        commentChunkCount: this._getAiAssistantScriptFilesComments(target).length,
      });
    });

    let status = this.getProjectIndexStatus();
    let repair: any = null;
    if (status?.blocked) {
      repair = this.completeProjectScriptIndexWithDefaultFiles();
      status = repair?.status || this.getProjectIndexStatus();
    }

    return {
      success: true,
      targets: results,
      scriptCount: results.reduce((sum, target) => sum + target.scriptCount, 0),
      fileCount: results.reduce((sum, target) => sum + target.fileCount, 0),
      status,
      repair,
    };
  }

  completeProjectScriptIndexWithDefaultFiles() {
    const targets = this._getProjectIndexTargets();
    const repairedTargets: any[] = [];
    let repairedScriptCount = 0;

    targets.forEach((target: any) => {
      const topBlocks = this._getTargetTopBlocks(target);
      if (!topBlocks.length) return;
      const map = this._parseScriptFileNameMapFromTargetComment(target);
      const defaultScriptFileName = this._getDefaultScriptFileNameFromTargetComment(target);
      let changed = !this._hasAiAssistantScriptFilesComment(target);
      let targetRepairedScriptCount = 0;

      topBlocks.forEach((topBlock: any) => {
        const scriptId = String(topBlock.id || "");
        if (!scriptId || map.has(scriptId)) return;
        map.set(scriptId, defaultScriptFileName);
        changed = true;
        repairedScriptCount += 1;
        targetRepairedScriptCount += 1;
      });

      if (!changed) return;
      this._writeScriptFileNameMapToTargetComment(target, map, defaultScriptFileName);
      repairedTargets.push({
        targetId: target.id,
        targetName: this._getTargetName(target),
        scriptCount: topBlocks.length,
        repairedScriptCount: targetRepairedScriptCount,
        defaultScriptFileName,
        commentChunkCount: this._getAiAssistantScriptFilesComments(target).length,
      });
    });

    return {
      success: true,
      repairedScriptCount,
      targets: repairedTargets,
      status: this.getProjectIndexStatus(),
    };
  }

  listFiles() {
    return this._getVirtualFiles({
      includeScriptContent: false,
      includeLegacyTargetContent: false,
      includeDocContent: false,
    }).map((entry) => ({
      path: entry.path,
      aliases: entry.kind === "variables" || entry.kind === "lists" ? undefined : entry.aliases,
      kind: entry.kind,
      writable: entry.writable,
      targetId: entry.targetId,
      targetName: entry.targetName,
      isStage: entry.isStage,
      assetName: entry.assetName,
      dataFormat: entry.dataFormat,
      costumeId: entry.costumeId,
      costumeIndex: entry.costumeIndex,
      soundId: entry.soundId,
      soundIndex: entry.soundIndex,
      scriptId: entry.scriptId,
      scriptIds: entry.scriptIds,
      scriptLabel: entry.scriptLabel,
      hatOpcode: entry.hatOpcode,
      syncStatus: entry.syncStatus,
      deletable: Boolean(entry.deletable),
      description: entry.description,
      lineCount: entry.content ? getLineCount(entry.content) : undefined,
      size: entry.content ? entry.content.length : undefined,
    }));
  }

  updateTodoList(options?: { todos?: Array<Partial<TodoItem>> }) {
    return updateTodoList(options?.todos || []);
  }

  listMemoryBlocks(options?: { scope?: MemoryScope }) {
    return listMemoryBlocks(this.vm, options?.scope);
  }

  getMemoryBlock(id: string, scope?: MemoryScope) {
    return getMemoryBlock(this.vm, id, scope);
  }

  setMemoryBlock(options?: { id?: string; scope?: MemoryScope; content?: string; description?: string }) {
    return setMemoryBlock(this.vm, options || {});
  }

  replaceMemoryBlockText(options?: { id?: string; oldText?: string; newText?: string; scope?: MemoryScope }) {
    return replaceMemoryBlockText(
      this.vm,
      options?.id || "",
      options?.oldText || "",
      options?.newText || "",
      options?.scope,
    );
  }

  deleteMemoryBlock(id: string, scope?: MemoryScope) {
    return deleteMemoryBlock(this.vm, id, scope);
  }

  readFile(path: string, startLine?: number, endLine?: number) {
    const entry = this._getVirtualFile(path);
    if (!entry) {
      return {
        success: false,
        error: `Virtual file not found: ${path}`,
      };
    }

    const lines = entry.content.split("\n");
    const start = Math.max(1, Math.floor(startLine || 1));
    const end = Math.min(lines.length, Math.floor(endLine || lines.length));

    return {
      success: true,
      path: entry.path,
      writable: entry.writable,
      kind: entry.kind,
      syncStatus: entry.syncStatus,
      diagnostics: entry.diagnostics,
      startLine: start,
      endLine: end,
      totalLines: lines.length,
      content: lines.slice(start - 1, end).join("\n"),
    };
  }

  discardDraft(path: string) {
    const normalizedPath = normalizeVirtualPath(path);
    const draft = this.virtualFileDrafts.get(normalizedPath);
    if (!draft) {
      return {
        success: false,
        error: `No invalid script draft exists at ${normalizedPath}`,
      };
    }

    this.virtualFileDrafts.delete(normalizedPath);
    const entry = this._getVirtualFile(normalizedPath);
    return {
      success: true,
      path: normalizedPath,
      discarded: true,
      syncStatus: entry?.syncStatus || "synced",
      content: entry ? this._previewContent(entry.content) : "",
      message: entry
        ? "Invalid draft discarded. readFile now returns the last synced script content."
        : "Invalid draft discarded. The draft-only new script no longer exists.",
    };
  }

  searchFiles(options?: { query?: string; path?: string; maxResults?: number }) {
    const query = String(options?.query || "")
      .trim()
      .toLowerCase();
    if (!query) {
      return {
        success: false,
        error: "searchFiles requires a non-empty query.",
      };
    }

    const maxResults = Math.max(1, Math.min(200, Number(options?.maxResults || 50)));
    const allEntries = this._getVirtualFiles({ includeLegacyTargetContent: Boolean(options?.path) });
    const requestedEntry = options?.path ? this._findVirtualFileEntry(allEntries, options.path) : null;
    if (options?.path && !requestedEntry) {
      return {
        success: false,
        error: `Virtual file not found: ${options.path}`,
      };
    }
    const entries = requestedEntry
      ? requestedEntry.kind === "dir"
        ? allEntries.filter((entry) => entry.kind !== "dir" && entry.path.startsWith(`${requestedEntry.path}/`))
        : [requestedEntry]
      : allEntries.filter((entry) => entry.kind !== "target");
    const matches: any[] = [];

    for (const entry of entries) {
      const lines = entry.content.split("\n");
      lines.forEach((line, index) => {
        if (matches.length >= maxResults) return;
        if (line.toLowerCase().includes(query)) {
          matches.push({
            path: entry.path,
            lineNumber: index + 1,
            line,
          });
        }
      });
      if (matches.length >= maxResults) break;
    }

    return {
      success: true,
      query: options?.query,
      matchCount: matches.length,
      matches,
    };
  }

  getDiagnostics(path?: string, options?: { verbose?: boolean }) {
    const requestedEntry = path ? this._getVirtualFile(path) : null;
    if (path && !requestedEntry) {
      return {
        success: false,
        valid: false,
        error: `Virtual file not found: ${path}`,
        diagnostics: [],
      };
    }

    const entries = path
      ? [requestedEntry as VirtualFileEntry]
      : this._getVirtualFiles({ includeLegacyTargetContent: Boolean(options?.verbose) }).filter(
          (entry) => options?.verbose || this._isDefaultDiagnosticEntry(entry),
        );
    const diagnostics = entries.map((entry) => {
      if (!entry) return null;
      if (entry.kind === "script" || (entry.kind === "costume" && entry.dataFormat === "svg")) {
        return this._validatePatchFileChange(entry, entry.content);
      }
      if (entry.kind !== "target") {
        return {
          path: entry.path,
          valid: true,
          readOnly: !entry.writable,
          errors: [],
        };
      }
      return this._validateVirtualTargetFile(entry, entry.content);
    });
    const filteredDiagnostics = diagnostics.filter(Boolean);
    const valid = filteredDiagnostics.every((item: any) => item.valid);

    const summary = this._buildDiagnosticsSummary(filteredDiagnostics as any[]);

    return {
      success: valid,
      valid,
      summary,
      diagnostics: filteredDiagnostics,
      omittedReadOnlyLegacyViews:
        path || options?.verbose ? 0 : (Array.isArray(this.vm.runtime?.targets) ? this.vm.runtime.targets.length : 0),
      hint: !path && !options?.verbose ? "Default diagnostics focus on writable /scripts/*.js files and editable SVG costumes. Pass verbose:true to include legacy aggregate views and directories." : undefined,
    };
  }

  async applyPatch(patch: string) {
    const operations = parseCodexPatch(patch);
    const entries = this._getVirtualFiles({
      includeScriptContent: false,
      includeLegacyTargetContent: false,
      includeDocContent: false,
    });
    let patchEntries = entries;
    const nextContentByPath = new Map<string, string>();
    const materializedEntryByPath = new Map<string, VirtualFileEntry>();
    const materializeForPatch = (entry: VirtualFileEntry) => {
      const cacheKey = entry.aliasPath || entry.path;
      const cached = materializedEntryByPath.get(cacheKey);
      if (cached) return cached;
      const materialized = this._materializeVirtualFileEntry(entry);
      materializedEntryByPath.set(cacheKey, materialized);
      return materialized;
    };
    const getNextContent = (entry: VirtualFileEntry) =>
      nextContentByPath.get(entry.path) ?? materializeForPatch(entry).content;
    const spriteFoldersAddedInPatch = new Set(
      operations
        .filter((operation) => operation.type === "add" && isRootSpriteFolderPath(operation.path))
        .map((operation) => normalizeVirtualPath(operation.path)),
    );
    const resolvedUpdates: Array<{
      update: ParsedPatchUpdate;
      entry: VirtualFileEntry;
      syncEntry: VirtualFileEntry;
    }> = [];
    const pendingImmediateOperations: PendingImmediateOperation[] = [];
    const requestedChanges: string[] = [];
    const queueImplicitSpriteFolderCreate = (rootPath: string) => {
      const normalizedRootPath = normalizeVirtualPath(rootPath);
      if (
        normalizedRootPath === VIRTUAL_STAGE_ROOT_PATH ||
        !isRootSpriteFolderPath(normalizedRootPath) ||
        this._findEntryForSpriteFolderOperation(patchEntries, normalizedRootPath) ||
        spriteFoldersAddedInPatch.has(normalizedRootPath)
      ) {
        return false;
      }
      spriteFoldersAddedInPatch.add(normalizedRootPath);
      pendingImmediateOperations.push({
        priority: 0,
        type: "addSprite",
        path: normalizedRootPath,
        run: () => this._createSpriteFromFolderPath(normalizedRootPath),
      });
      requestedChanges.push(normalizedRootPath);
      return true;
    };

    for (const operation of operations) {
      if (operation.type === "add") {
        const existingEntry = patchEntries.find(
          (entry) => entry.path === normalizeVirtualPath(operation.path) || entry.aliases?.includes(normalizeVirtualPath(operation.path)),
        );
        if (existingEntry) {
          return { success: false, error: `Virtual file already exists: ${operation.path}` };
        }

        if (isVirtualScriptsDirPath(operation.path)) {
          if (operation.content.trim()) {
            return {
              success: false,
              error: `/${VIRTUAL_SCRIPTS_DIR_NAME} is a virtual directory and cannot contain text. Add script files such as ${normalizeVirtualPath(operation.path)}/start.js instead.`,
            };
          }
          const rootPath = getVirtualParentPath(operation.path);
          const targetExists = patchEntries.some((entry) => entry.kind === "dir" && entry.path === rootPath && entry.targetId);
          if (!targetExists && !spriteFoldersAddedInPatch.has(rootPath)) {
            queueImplicitSpriteFolderCreate(rootPath);
          }
          if (!targetExists && !spriteFoldersAddedInPatch.has(rootPath)) {
            return {
              success: false,
              error: `${normalizeVirtualPath(operation.path)} is a virtual directory. Create the sprite folder first, then add script files such as ${normalizeVirtualPath(operation.path)}/start.js.`,
            };
          }
          pendingImmediateOperations.push({
            priority: 1,
            path: normalizeVirtualPath(operation.path),
            type: "noopScriptsDir",
            run: () => ({
              type: "noopScriptsDir",
              path: normalizeVirtualPath(operation.path),
              message: `Virtual scripts directory ${normalizeVirtualPath(operation.path)} does not need to be created. Add /<target>/${VIRTUAL_SCRIPTS_DIR_NAME}/*.js files inside it.`,
            }),
          });
          requestedChanges.push(normalizeVirtualPath(operation.path));
          continue;
        }

        const assetTarget = this._resolveTargetForAssetPath(operation.path, patchEntries);
        const assetSegments = splitVirtualPath(operation.path);
        if (
          !assetTarget &&
          assetSegments.length === 3 &&
          assetSegments[0] !== VIRTUAL_STAGE_FOLDER_NAME &&
          assetSegments[1] === VIRTUAL_COSTUME_DIR_NAME &&
          getFileExtension(assetSegments[2]) === "svg"
        ) {
          queueImplicitSpriteFolderCreate(`/${assetSegments[0]}`);
        }
        const isSvgCostumeUnderNewSprite =
          assetSegments.length === 3 &&
          assetSegments[1] === VIRTUAL_COSTUME_DIR_NAME &&
          getFileExtension(assetSegments[2]) === "svg" &&
          spriteFoldersAddedInPatch.has(`/${assetSegments[0]}`);
        if (
          (assetTarget?.folderName === VIRTUAL_COSTUME_DIR_NAME && getFileExtension(assetTarget.fileName) === "svg") ||
          isSvgCostumeUnderNewSprite
        ) {
          const resolvedAssetTarget = assetTarget;
          pendingImmediateOperations.push({
            priority: resolvedAssetTarget ? 2 : 1,
            run: () => this._createSvgCostumeFile(operation.path, operation.content, resolvedAssetTarget || undefined),
          });
          requestedChanges.push(operation.path);
          continue;
        }

        if (isVirtualDataFilePath(operation.path)) {
          const dataKind = getVirtualDataKindFromPath(operation.path);
          if (!dataKind) {
            return { success: false, error: `Unsupported data file path: ${operation.path}` };
          }
          const dataEntry = this._buildNewDataFileEntry(operation.path, dataKind);
          if (!dataEntry) {
            return {
              success: false,
            error: `Data JSON files must be added as /${VIRTUAL_VARIABLES_FILE_NAME}, /${VIRTUAL_LISTS_FILE_NAME}, /stage/${VIRTUAL_VARIABLES_FILE_NAME}, /stage/${VIRTUAL_LISTS_FILE_NAME}, /<target>/${VIRTUAL_VARIABLES_FILE_NAME}, or /<target>/${VIRTUAL_LISTS_FILE_NAME}: ${operation.path}. Target data paths are aliases to the root global files; targets do not have private variables/lists. Chinese aliases such as /变量.json and /<target>/变量.json are accepted.`,
            };
          }
          resolvedUpdates.push({
            update: {
              type: "update",
              path: operation.path,
              hunks: [],
              replacementContent: operation.content,
            },
            entry: dataEntry,
            syncEntry: dataEntry,
          });
          nextContentByPath.set(dataEntry.path, operation.content);
          requestedChanges.push(dataEntry.path);
          continue;
        }

        if (isVirtualScriptFilePath(operation.path)) {
          queueImplicitSpriteFolderCreate(`/${splitVirtualPath(operation.path)[0]}`);
          const scriptEntry = this._buildNewScriptFileEntry(operation.path) ||
            this._buildNewScriptFileEntryFromPatchEntries(operation.path, patchEntries) ||
            (spriteFoldersAddedInPatch.has(`/${splitVirtualPath(operation.path)[0]}`)
              ? this._buildPendingNewScriptFileEntry(operation.path)
              : null);
          if (!scriptEntry) {
            return {
              success: false,
              error: `Script files must be added under an existing /<target>/${VIRTUAL_SCRIPTS_DIR_NAME}/ folder: ${operation.path}`,
            };
          }
          resolvedUpdates.push({
            update: {
              type: "update",
              path: operation.path,
              hunks: [],
              replacementContent: operation.content,
            },
            entry: scriptEntry,
            syncEntry: scriptEntry,
          });
          nextContentByPath.set(scriptEntry.path, operation.content);
          requestedChanges.push(scriptEntry.path);
          continue;
        }

        if (!isRootSpriteFolderPath(operation.path)) {
          return {
            success: false,
            error: `Only sprite root folders, script files, or SVG costume files can be added. Use /Sprite, /<target>/scripts/name.js, or /<target>/custom/costume.svg. Reorder existing costumes by updating /<target>/custom/order.json, not adding it. Invalid add path: ${operation.path}.`,
          };
        }
        if (operation.content.trim()) {
          return {
            success: false,
            error: `Sprite folder creation does not accept file content. Use only *** Add File: ${operation.path}.`,
          };
        }
        if (this._findEntryForSpriteFolderOperation(patchEntries, operation.path)) {
          return { success: false, error: `Virtual folder already exists: ${operation.path}` };
        }
        pendingImmediateOperations.push({
          priority: 0,
          type: "addSprite",
          path: normalizeVirtualPath(operation.path),
          run: () => this._createSpriteFromFolderPath(operation.path),
        });
        requestedChanges.push(operation.path);
        continue;
      }

      if (operation.type === "delete") {
        const entry = this._findVirtualFileEntry(patchEntries, operation.path) || this._findEntryForSpriteFolderOperation(patchEntries, operation.path);
        if (!entry) {
          return { success: false, error: `Virtual file not found: ${operation.path}` };
        }
        if (entry.kind === "dir" && entry.isStage && splitVirtualPath(entry.path).length === 1) {
          return { success: false, error: "The stage folder cannot be deleted." };
        }
        if (entry.kind === "dir" && !entry.isStage && entry.targetId && splitVirtualPath(entry.path).length === 1) {
          pendingImmediateOperations.push({ priority: 10, run: () => this._deleteSpriteFolder(entry) });
          [...this.virtualFileDrafts.keys()].forEach((draftPath) => {
            if (draftPath.startsWith(`${entry.path}/${VIRTUAL_SCRIPTS_DIR_NAME}/`)) this.virtualFileDrafts.delete(draftPath);
          });
        } else if (entry.kind === "script") {
          pendingImmediateOperations.push({ priority: 5, run: () => this._deleteScriptFile(entry) });
        } else if (entry.kind === "costume") {
          pendingImmediateOperations.push({ priority: 10, run: () => this._deleteCostumeFile(entry) });
        } else if (entry.kind === "sound") {
          pendingImmediateOperations.push({ priority: 10, run: () => this._deleteSoundFile(entry) });
        } else if (entry.kind === "variables" || entry.kind === "lists") {
          resolvedUpdates.push({
            update: {
              type: "update",
              path: entry.path,
              hunks: [],
              replacementContent: "[]\n",
            },
            entry,
            syncEntry: entry,
          });
          nextContentByPath.set(entry.path, "[]\n");
        } else {
          return { success: false, error: `Virtual file cannot be deleted: ${operation.path}` };
        }
        requestedChanges.push(entry.path);
        continue;
      }

      const update = operation;
      let entry = this._findVirtualFileEntry(patchEntries, update.path);
      const isDirectoryRenameOnly =
        update.moveTo && update.hunks.length === 0 && update.replacementContent === undefined;
      if (!entry && !update.moveTo && isVirtualScriptFilePath(update.path)) {
        queueImplicitSpriteFolderCreate(`/${splitVirtualPath(update.path)[0]}`);
        entry = this._buildNewScriptFileEntry(update.path) ||
          this._buildNewScriptFileEntryFromPatchEntries(update.path, patchEntries) ||
          (spriteFoldersAddedInPatch.has(`/${splitVirtualPath(update.path)[0]}`)
            ? this._buildPendingNewScriptFileEntry(update.path)
            : null);
      }
      if (!entry && !update.moveTo) {
        const updateSegments = splitVirtualPath(update.path);
        const canCreateSvgCostume =
          updateSegments.length === 3 &&
          updateSegments[1] === VIRTUAL_COSTUME_DIR_NAME &&
          getFileExtension(updateSegments[2]) === "svg";
        if (canCreateSvgCostume) {
          const assetTarget = this._resolveTargetForAssetPath(update.path, patchEntries);
          if (!assetTarget && updateSegments[0] !== VIRTUAL_STAGE_FOLDER_NAME) {
            queueImplicitSpriteFolderCreate(`/${updateSegments[0]}`);
          }
          if (update.replacementContent === undefined) {
            return {
              success: false,
              error: `Virtual file not found: ${update.path}. Use full replacement content to create this SVG costume.`,
            };
          }
          pendingImmediateOperations.push({
            priority: assetTarget ? 2 : 1,
            run: () => this._createSvgCostumeFile(update.path, update.replacementContent || "", assetTarget || undefined),
          });
          requestedChanges.push(update.path);
          continue;
        }
      }
        if (!entry) {
          return {
            success: false,
            error: `Virtual file not found: ${update.path}. Re-read listFiles or use Add File for a new file.`,
          };
        }

      if (update.moveTo) {
        if (entry.kind === "dir" && entry.isStage && splitVirtualPath(entry.path).length === 1) {
          return { success: false, error: "The stage folder cannot be moved or renamed." };
        }
        if (entry.kind === "dir" && !entry.isStage && entry.targetId && splitVirtualPath(entry.path).length === 1) {
          pendingImmediateOperations.push({
            priority: 10,
            run: () => this._renameSpriteFolder(entry, update.moveTo || ""),
          });
          const movedEntries = this._getEntriesForNewPathAfterMove(entry, update.moveTo);
          movedEntries.forEach((item) => nextContentByPath.set(item.path, item.content));
          patchEntries = this._overlayPatchEntries(patchEntries, movedEntries);
          requestedChanges.push(entry.path, update.moveTo);
          continue;
        }
        if (entry.kind === "costume") {
          pendingImmediateOperations.push({
            priority: 10,
            run: () => this._renameCostumeFile(entry, update.moveTo || ""),
          });
          requestedChanges.push(entry.path, update.moveTo);
          continue;
        }
        if (entry.kind === "sound") {
          pendingImmediateOperations.push({
            priority: 10,
            run: () => this._renameSoundFile(entry, update.moveTo || ""),
          });
          requestedChanges.push(entry.path, update.moveTo);
          continue;
        }
        if (entry.kind === "script") {
          const normalizedMoveTo = normalizeVirtualPath(update.moveTo || "");
          if (!isVirtualScriptFilePath(normalizedMoveTo)) {
            return { success: false, error: "Script files must stay under /<target>/scripts/*.js." };
          }
          if (
            patchEntries.find((item) => item.path === normalizedMoveTo || item.aliases?.includes(normalizedMoveTo)) ||
            this.virtualFileDrafts.has(normalizedMoveTo)
          ) {
            return { success: false, error: `Virtual file already exists: ${normalizedMoveTo}` };
          }
          pendingImmediateOperations.push({
            priority: 2,
            run: () => this._renameScriptFile(entry, update.moveTo || ""),
          });
          nextContentByPath.set(normalizedMoveTo, getNextContent(entry));
          requestedChanges.push(entry.path, normalizedMoveTo);
          if (update.hunks.length === 0 && update.replacementContent === undefined) {
            continue;
          }
        } else if (entry.kind === "target") {
          if (entry.isStage && update.moveTo !== VIRTUAL_STAGE_SCRIPT_PATH) {
            return { success: false, error: "The stage script must stay at /stage/script.js." };
          }
          if (!entry.isStage && getVirtualBaseName(update.moveTo) !== VIRTUAL_SCRIPT_FILE_NAME) {
            return {
              success: false,
              error: `Sprite script files must stay named ${VIRTUAL_SCRIPT_FILE_NAME}. Rename the root folder instead.`,
            };
          }
          const targetRoot = getVirtualParentPath(entry.path);
          const newRoot = getVirtualParentPath(update.moveTo);
          if (!entry.isStage && newRoot !== targetRoot) {
            pendingImmediateOperations.push({
              priority: 10,
              run: () =>
                this._renameSpriteFolder(
                  {
                    path: targetRoot,
                    kind: "dir",
                    writable: true,
                    deletable: true,
                    content: "",
                    description: "Sprite folder",
                    targetId: entry.targetId,
                    targetName: entry.targetName,
                    isStage: false,
                  },
                  newRoot,
                ),
            });
            const movedEntries = this._getEntriesForNewPathAfterMove(entry, update.moveTo);
            movedEntries.forEach((item) => nextContentByPath.set(item.path, item.content));
            patchEntries = this._overlayPatchEntries(patchEntries, movedEntries);
            requestedChanges.push(entry.path, update.moveTo);
          }
        } else {
          return { success: false, error: `Virtual file cannot be moved: ${update.path}` };
        }
      }

      if (!entry.writable) {
        return {
          success: false,
          error: `Virtual file is read-only: ${update.path}`,
        };
      }
      if (entry.kind === "dir" && !isDirectoryRenameOnly) {
        return {
          success: false,
          error: "Virtual directories can only be added, moved, or deleted; edit files inside them instead.",
        };
      }
      if (entry.kind === "dir" && isDirectoryRenameOnly) {
        continue;
      }
      const syncEntry =
        update.moveTo && entry.kind === "target" && !entry.isStage
          ? { ...entry, path: update.moveTo, content: nextContentByPath.get(update.moveTo) ?? entry.content }
        : update.moveTo && entry.kind === "script"
            ? { ...entry, path: normalizeVirtualPath(update.moveTo), content: nextContentByPath.get(update.moveTo) ?? entry.content }
          : entry;
      resolvedUpdates.push({ update, entry, syncEntry });

      try {
        nextContentByPath.set(
          syncEntry.path,
          update.replacementContent !== undefined
            ? update.replacementContent
            : applyTextHunks(getNextContent(syncEntry), update.hunks),
        );
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "Patch failed",
          path: update.path,
        };
      }
    }

    const changedEntries = resolvedUpdates
      .map(({ syncEntry }) => syncEntry)
      .filter((entry, index, array) => array.findIndex((item) => item.path === entry.path) === index)
      .filter((entry) => materializeForPatch(entry).content !== getNextContent(entry));
    const validationResults = changedEntries.map((entry) =>
      this._validatePatchFileChange(entry, getNextContent(entry)),
    );
    const invalidValidation = validationResults.find((item) => !item.valid);
    if (invalidValidation) {
      changedEntries.forEach((entry, index) => {
        if (entry.kind !== "script") return;
        this._preserveScriptDraft(entry, getNextContent(entry), validationResults[index]);
      });
      const scriptDraftReports = changedEntries
        .map((entry, index) =>
          entry.kind === "script" && !validationResults[index]?.valid
            ? this._buildDraftReport(entry, getNextContent(entry), validationResults[index])
            : null,
        )
        .filter(Boolean);
      const hasNonScriptInvalid = validationResults.some((item, index) => !item.valid && changedEntries[index]?.kind !== "script");
      return {
        success: false,
        error:
          changedEntries.some((entry) => entry.kind === "script") && !hasNonScriptInvalid
            ? "Patched script has diagnostics errors. Scratch blocks were not changed, but invalid script drafts were saved for repair."
            : "Patched virtual file has diagnostics errors. No Scratch blocks were changed.",
        changeState: this._buildRollbackChangeSummary(changedEntries, requestedChanges),
        preservedDrafts: changedEntries.filter((entry) => entry.kind === "script").map((entry) => entry.path),
        draftReports: scriptDraftReports,
        repairHints: scriptDraftReports.map((report: any) => report.repairHint).filter(Boolean),
        diagnostics: validationResults,
      };
    }

    const snapshot = await this._createProjectSnapshot();
    const syncResults = [];
    const normalizedDiffs: any[] = [];

    try {
      const immediateResults = [];
      const sortedImmediateOperations = [...pendingImmediateOperations].sort(
        (left, right) => left.priority - right.priority,
      );
      for (const operation of sortedImmediateOperations) {
        const result = await operation.run();
        immediateResults.push(result);
        if (result?.normalizedContent && result?.path) {
          const submittedAddOperation = operations.find(
            (item): item is ParsedPatchAdd => item.type === "add" && item.path === result.path,
          );
          const submittedContent = submittedAddOperation?.content || "";
          normalizedDiffs.push({
            path: result.path,
            normalizedChanged: true,
            direction: "submitted_to_synced",
            severity: "info",
            message: result.normalizationReason || "SVG content was normalized before syncing to Scratch.",
            submittedPreview: this._previewContent(submittedContent),
            syncedPreview: this._previewContent(result.normalizedContent),
            diff: buildCompactLineDiff(submittedContent, result.normalizedContent),
          });
        }
        syncResults.push({
          path: result?.path || result?.newPath,
          targetId: result?.targetId,
          operationCount: result?.type === "noopScriptsDir" ? 0 : 1,
          operations: [result],
        });
      }
      for (const entry of changedEntries) {
        const latestEntry = this._resolveLatestEntryForSync(entry, immediateResults);
        if (latestEntry.kind === "script" && !latestEntry.targetId) {
          throw new Error(`Could not resolve target for script file ${latestEntry.path}. Create the sprite folder first or use an existing target path.`);
        }
        const result = await this._syncVirtualFileChange(
          latestEntry,
          materializeForPatch(entry).content,
          getNextContent(entry),
        );
        syncResults.push(result);
        const normalizedSvgContent = result?.operations?.find((operation: any) => operation?.normalizedContent)?.normalizedContent;
        if (normalizedSvgContent && latestEntry.kind === "costume") {
          const draftContent = getNextContent(entry);
          normalizedDiffs.push({
            path: latestEntry.path,
            normalizedChanged: true,
            direction: "submitted_to_synced",
            severity: "info",
            message:
              result?.operations?.find((operation: any) => operation?.normalizationReason)?.normalizationReason ||
              "SVG content was normalized before syncing to Scratch.",
            submittedPreview: this._previewContent(draftContent),
            syncedPreview: this._previewContent(normalizedSvgContent),
            diff: buildCompactLineDiff(draftContent, normalizedSvgContent),
          });
        }
        if (latestEntry.kind === "script") {
          this.virtualFileDrafts.delete(latestEntry.path);
          const syncedScriptId =
            result?.operations?.find((operation: any) => operation?.result?.insertedTopBlockId)?.result?.insertedTopBlockId ||
            result?.operations?.find((operation: any) => operation?.scriptId)?.scriptId ||
            latestEntry.scriptId;
          const normalizedContent = this._getNormalizedScriptContent({
            ...latestEntry,
            scriptId: syncedScriptId,
          });
          const draftContent = getNextContent(entry);
          if (normalizedContent !== null) {
            const diff = buildCompactLineDiff(draftContent, normalizedContent);
            if (diff) {
              normalizedDiffs.push({
                path: latestEntry.path,
                normalizedChanged: true,
                direction: "submitted_to_synced",
                severity: "info",
                message: "Scratch serializer normalized the submitted JS; sync succeeded.",
                submittedPreview: this._previewContent(draftContent),
                syncedPreview: this._previewContent(normalizedContent),
                diff,
              });
            }
          }
        }
      }
      } catch (error) {
      const draftReports: any[] = [];
      changedEntries.forEach((entry) => {
        if (entry.kind !== "script") return;
        const content = getNextContent(entry);
        const diagnostics = this._validatePatchFileChange(entry, content);
        this._preserveScriptDraft(entry, content, diagnostics);
        draftReports.push({
          ...this._buildDraftReport(entry, content, diagnostics),
          syncStatus: diagnostics?.valid ? "dirty-valid" : "dirty-invalid",
          repairHint: diagnostics?.valid
            ? `Scratch blocks were rolled back after a workspace sync failure. This draft is valid and was preserved at ${entry.path}; do not rewrite the DSL for this error. Retry after the target workspace is ready, or report the workspace sync failure.`
            : this._getScriptRepairHint(entry, diagnostics),
        });
      });
      const rolledBack = await this._restoreProjectSnapshot(snapshot);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Failed to apply virtual file changes",
        rolledBack,
        changeState: this._buildRollbackChangeSummary(changedEntries, requestedChanges),
        preservedDrafts: changedEntries.filter((entry) => entry.kind === "script").map((entry) => entry.path),
        draftReports,
        repairHints: draftReports.map((report: any) => report.repairHint).filter(Boolean),
        syncResults,
      };
    }

    const operationCount = syncResults.reduce((sum, item) => sum + item.operationCount, 0);
    if (changedEntries.length > 0 && operationCount === 0 && pendingImmediateOperations.length === 0) {
      return {
        success: false,
        error:
          "Patch changed virtual file text but did not add, delete, or modify any script or asset content. Header-only changes are ignored.",
        changedFiles: changedEntries.map((entry) => entry.path),
        changeState: this._buildRollbackChangeSummary(changedEntries, requestedChanges),
        syncResults,
        diagnostics: validationResults,
      };
    }

    const latestEntries = this._getVirtualFiles();
    const latestDiagnostics = [...new Set([...changedEntries.map((entry) => entry.path), ...requestedChanges])]
      .map((path) => this._findVirtualFileEntry(latestEntries, path))
      .filter(Boolean)
      .filter((entry: any) => entry.kind === "script" || entry.kind === "target" || (entry.kind === "costume" && entry.dataFormat === "svg"))
      .map((entry: any) => this._validatePatchFileChange(entry, entry.content));

    return {
      success: true,
      changedFiles: [...new Set([...changedEntries.map((entry) => entry.path), ...requestedChanges])],
      fileCount: changedEntries.length + pendingImmediateOperations.length,
      scriptOperationCount: operationCount,
      operationCount,
      syncResults,
      diagnostics: latestDiagnostics.length > 0 ? latestDiagnostics : validationResults,
      diagnosticsSummary: this._buildDiagnosticsSummary((latestDiagnostics.length > 0 ? latestDiagnostics : validationResults) as any[]),
      normalizedDiffs,
    };
  }

  listTargets() {
    const targets = Array.isArray(this.vm.runtime?.targets) ? this.vm.runtime.targets : [];
    return targets.map((target: any) => ({
      id: target.id,
      originalTargetId: target.originalTargetId || target.id,
      name: target.getName?.() || target.sprite?.name || target.id,
      isStage: Boolean(target.isStage),
      isEditingTarget: this.vm.editingTarget?.id === target.id,
    }));
  }

  getTopLevelScripts(targetId?: string) {
    const result = this._getBlocks(targetId);
    if (!result) return [];

    return this._getTopLevelBlocks(result.blocks)
      .map((block: any) => this._buildScriptSummary(result.blocks, block, result.target.id))
      .sort((left: any, right: any) => left.scriptId.localeCompare(right.scriptId));
  }

  getScriptUCF(scriptId: string, targetId?: string) {
    const result = this._getBlocks(targetId);
    if (!result) {
      return {
        found: false,
        error: "Target not found",
      };
    }

    const topBlock = result.blocks[scriptId];
    if (!topBlock) {
      return {
        found: false,
        error: "Script not found",
      };
    }

    const scriptBlockIds = this._collectScriptBlockIds(result.blocks, scriptId);
    const scriptBlocks = scriptBlockIds.map((blockId) => result.blocks[blockId]).filter(Boolean);

    return {
      found: true,
      scriptId,
      targetId: result.target.id,
      hatOpcode: topBlock.opcode,
      blockCount: scriptBlocks.length,
      ucf: toAnnotatedUCF(
        [
          {
            blocks: scriptBlocks,
            statementBlockIds: scriptBlockIds,
          },
        ],
        this.vm.runtime,
      ),
    };
  }

  findBlocks(options?: { targetId?: string; opcode?: string; keyword?: string; scriptId?: string; limit?: number }) {
    const { targetId, opcode, keyword, scriptId, limit = 50 } = options || {};
    const targets = targetId
      ? [this._getTarget(targetId)].filter(Boolean)
      : this.listTargets().map((item) => this._getTarget(item.id));
    const matches: any[] = [];

    for (const target of targets) {
      if (!target?.blocks?._blocks) {
        continue;
      }

      const blocks = target.blocks._blocks as Record<string, any>;
      for (const block of Object.values(blocks) as any[]) {
        if (!block?.id || !block.opcode) {
          continue;
        }

        const topLevelScriptId = this._resolveTopLevelScriptId(blocks, block.id);
        if (scriptId && topLevelScriptId !== scriptId) {
          continue;
        }

        if (opcode && block.opcode !== opcode) {
          continue;
        }

        const fieldsText = Object.values(block.fields || {})
          .map((field: any) => this._normalizeBlockText(field?.value))
          .filter(Boolean)
          .join(" ");
        const procedureText = [
          block.mutation?.proccode,
          block.mutation?.argumentnames,
          block.mutation?.argumentdefaults,
        ]
          .map((value: any) => this._normalizeBlockText(value))
          .filter(Boolean)
          .join(" ");
        const textCandidate = [
          block.opcode,
          this._getSearchTextForOpcode(block.opcode),
          fieldsText,
          procedureText,
        ].join(" ");
        if (!this._matchKeyword(textCandidate, keyword)) {
          continue;
        }

        matches.push({
          blockId: block.id,
          opcode: block.opcode,
          targetId: target.id,
          targetName: target.getName?.() || target.sprite?.name || target.id,
          topLevelScriptId,
          parentId: block.parent || null,
          nextId: block.next || null,
          isTopLevel: Boolean(block.topLevel),
          fields: Object.fromEntries(
            Object.entries(block.fields || {}).map(([fieldName, fieldValue]: [string, any]) => [
              fieldName,
              fieldValue?.value,
            ]),
          ),
          text: AITools.AllBlockInfo[block.opcode] || block.opcode,
        });

        if (matches.length >= limit) {
          return matches;
        }
      }
    }

    return matches;
  }

  getAllExtensions() {
    const extensionGuides = getRuntimeExtensionGuides(this.vm?.runtime);
    const guideByExtensionId = new Map(extensionGuides.map((guide) => [guide.extensionId, guide]));
    const result = [];
    if (this.vm.runtime._blockInfo) {
      for (const extInfo of this.vm.runtime._blockInfo) {
        const guide = guideByExtensionId.get(extInfo.id);
        const dynamicBlocks = Array.isArray(extInfo.blocks)
          ? extInfo.blocks
              .filter((block: any) => block?.info?.dynamicArgsInfo)
              .map((block: any) => `${extInfo.id}_${block.info.opcode}`)
          : [];
        result.push({
          id: extInfo.id,
          name: extInfo.name,
          hasGuide: Boolean(guide),
          guide: guide
            ? {
                topic: guide.name,
                title: guide.title,
                tools: guide.tools,
              }
            : null,
          hasDynamicBlocks: dynamicBlocks.length > 0,
          dynamicBlocks,
          dynamicBlocksGuideHint:
            dynamicBlocks.length > 0
              ? 'This extension has dynamic argument blocks. Read getScratchGuide({ topic: "dynamic-blocks" }) before writing DSL for these opcodes.'
              : undefined,
        });
      }
    }
    return result;
  }

  searchExtensions(options: { query?: string; limit?: number; includeDisabled?: boolean } = {}) {
    const query = String(options?.query || "").trim().toLowerCase();
    const limit = Math.max(1, Math.min(50, Number(options?.limit) || 10));
    const loadedExtensionIds = new Set(
      Array.from((this.vm?.extensionManager?._loadedExtensions as Map<string, string> | undefined)?.keys?.() || []).map((id) =>
        String(id).toLowerCase(),
      ),
    );

    const scored = APPROVED_EXTENSION_INDEX.filter((extension) => options.includeDisabled || !extension.disabled)
      .map((extension) => {
        const fields = [
          extension.extensionId,
          extension.name,
          extension.description,
          extension.doc || "",
          ...(extension.tags || []),
        ].map((value) => String(value || "").toLowerCase());
        const exactId = query && extension.extensionId.toLowerCase() === query;
        const exactName = query && extension.name.toLowerCase() === query;
        const startsWith = query && fields.some((value) => value.startsWith(query));
        const includes = !query || fields.some((value) => value.includes(query));
        if (!includes && !exactId && !exactName && !startsWith) return null;
        const score =
          (exactId ? 100 : 0) +
          (exactName ? 80 : 0) +
          (startsWith ? 30 : 0) +
          (extension.featured ? 5 : 0) +
          (extension.disabled ? -20 : 0);
        return { extension, score };
      })
      .filter(Boolean) as Array<{ extension: (typeof APPROVED_EXTENSION_INDEX)[number]; score: number }>;

    const extensions = scored
      .sort((left, right) => right.score - left.score || left.extension.name.localeCompare(right.extension.name))
      .slice(0, limit)
      .map(({ extension }) => ({
        extensionId: extension.extensionId,
        name: extension.name,
        description: extension.description,
        disabled: Boolean(extension.disabled),
        featured: Boolean(extension.featured),
        tags: extension.tags || [],
        doc: extension.doc,
        loaded: loadedExtensionIds.has(extension.extensionId.toLowerCase()),
      }));

    return {
      success: true,
      query,
      count: extensions.length,
      totalApproved: APPROVED_EXTENSION_INDEX.length,
      extensions,
    };
  }

  async addExtension(extensionId: string) {
    const requestedId = String(extensionId || "").trim().replace(/^ext_/, "");
    if (!requestedId) {
      throw new Error("addExtension: extensionId is required.");
    }

    const extension =
      APPROVED_EXTENSION_INDEX_BY_ID.get(requestedId.toLowerCase()) ||
      APPROVED_EXTENSION_INDEX.find((item) => item.extensionId.toLowerCase().replace(/^ext_/, "") === requestedId.toLowerCase());
    if (!extension) {
      return {
        success: false,
        extensionId: requestedId,
        error: `Extension is not in the approved index: ${requestedId}`,
      };
    }
    if (extension.disabled) {
      return {
        success: false,
        extensionId: extension.extensionId,
        name: extension.name,
        error: `Extension is currently disabled in the approved index: ${extension.extensionId}`,
      };
    }

    const extensionManager = this.vm?.extensionManager;
    if (!extensionManager?.loadExternalExtensionById) {
      throw new Error("Current VM does not support loading approved extensions by id.");
    }

    const wasLoaded =
      Boolean(extensionManager.isExtensionLoaded?.(extension.extensionId)) ||
      Boolean(extensionManager._loadedExtensions?.has?.(extension.extensionId));
    if (wasLoaded) {
      return {
        success: true,
        alreadyLoaded: true,
        extensionId: extension.extensionId,
        name: extension.name,
        description: extension.description,
      };
    }

    const loadResult = extensionManager.loadExternalExtensionById(extension.extensionId);
    if (!loadResult || typeof (loadResult as Promise<unknown>).then !== "function") {
      return {
        success: false,
        extensionId: extension.extensionId,
        name: extension.name,
        error: `Extension manager did not start loading extension: ${extension.extensionId}`,
      };
    }

    await loadResult;
    const loaded =
      Boolean(extensionManager.isExtensionLoaded?.(extension.extensionId)) ||
      Boolean(extensionManager._loadedExtensions?.has?.(extension.extensionId));

    return {
      success: loaded,
      alreadyLoaded: false,
      extensionId: extension.extensionId,
      name: extension.name,
      description: extension.description,
      loaded,
      loadedExtensions: Array.from((extensionManager._loadedExtensions as Map<string, string> | undefined)?.keys?.() || []),
      error: loaded ? undefined : `Extension load finished but ${extension.extensionId} is not marked as loaded.`,
    };
  }

  getExtensionBlocks(extensionId: string) {
    const result = [];
    const requestedExtensionId = String(extensionId || "").replace(/^ext_/, "");
    const extensionGuides = getRuntimeExtensionGuides(this.vm?.runtime);
    const guide = extensionGuides.find(
      (item) => item.extensionId === extensionId || item.extensionId === requestedExtensionId,
    );
    if (this.vm.runtime._blockInfo) {
      for (const extInfo of this.vm.runtime._blockInfo) {
        if ((extInfo.id === extensionId || extInfo.id === requestedExtensionId) && extInfo.blocks) {
          for (const block of extInfo.blocks) {
            if (block.info) {
              const dynamicArgsInfo = this._summarizeDynamicArgsInfo(block.info.dynamicArgsInfo);
              result.push({
                opcode: `${extInfo.id}_${block.info.opcode}`,
                text: block.info.text,
                blockType: block.info.blockType,
                arguments: this._sanitizeBlockArgumentsForModel(block.info.arguments || {}),
                dynamicArgsInfo,
                dynamicBlocksGuideHint: dynamicArgsInfo
                  ? 'This opcode uses dynamic argument inputs. Read getScratchGuide({ topic: "dynamic-blocks" }) before writing or patching DSL for it.'
                  : undefined,
              });
            }
          }
        }
      }
    }
    const dynamicBlocks = result.filter((block: any) => block.dynamicArgsInfo).map((block: any) => block.opcode);
    return {
      extensionId,
      hasDynamicBlocks: dynamicBlocks.length > 0,
      dynamicBlocks,
      dynamicBlocksGuideHint:
        dynamicBlocks.length > 0
          ? 'This extension has dynamic argument blocks. Read getScratchGuide({ topic: "dynamic-blocks" }) before writing DSL for these opcodes.'
          : undefined,
      guide: guide
        ? {
            topic: guide.name,
            title: guide.title,
            content: guide.content,
            tools: guide.tools,
          }
        : null,
      blocks: result,
    };
  }

  private _getAllBlockIds() {
    const resultMap = new Map<string, string>();
    for (const [opcode, entry] of Object.entries(NativeScratchBlockCatalog)) {
      resultMap.set(opcode, AITools.AllBlockInfo[opcode] || String(entry?.block?.text || opcode));
    }
    for (const opcode of Object.keys(AITools.BlockSearchAliases)) {
      if (!resultMap.has(opcode)) {
        resultMap.set(opcode, AITools.AllBlockInfo[opcode] || opcode);
      }
    }

    if (this.vm.runtime._primitives) {
      for (const [opcode, text] of Object.entries(AITools.AllBlockInfo)) {
        resultMap.set(opcode, text);
      }
    }

    if (this.vm.runtime._blockInfo) {
      for (const extInfo of this.vm.runtime._blockInfo) {
        const extId = extInfo.id;
        if (extInfo.blocks) {
          for (const block of extInfo.blocks) {
            if (block.info && block.info.opcode) {
              const fullOpcode = `${extId}_${block.info.opcode}`;
              const text = block.info.text || "";
              const args: string[] = [];
              if (block.info.arguments) {
                for (const [argName, argInfo] of Object.entries(block.info.arguments)) {
                  args.push(`${argName}: ${(argInfo as any).type}`);
                }
              }
              const argsStr = args.length > 0 ? ` (${args.join(", ")})` : "";
              resultMap.set(fullOpcode, `${text}${argsStr}`);
            }
          }
        }
      }
    }
    return Object.fromEntries(resultMap);
  }

  private _normalizeBlockType(value: any) {
    const raw = String(value || "").toLowerCase();
    if (raw === "hat" || raw === "event") return "hat";
    if (raw === "reporter" || raw === "value") return "reporter";
    if (raw === "boolean" || raw === "predicate") return "boolean";
    if (raw === "command" || raw === "statement" || raw === "loop" || raw === "conditional") return "command";
    return "command";
  }

  private _normalizeArgumentReporterInfo(opcode: string, result: any) {
    if (opcode !== "argument_reporter_string_number" && opcode !== "argument_reporter_boolean") return;

    result.found = true;
    result.blockType = opcode === "argument_reporter_boolean" ? "boolean" : "reporter";
    result.type = result.blockType;
    result.text =
      opcode === "argument_reporter_boolean"
        ? "custom block Boolean parameter [VALUE] (VALUE: parameter name)"
        : "custom block parameter [VALUE] (VALUE: parameter name)";
    result.fields = {
      ...(result.fields || {}),
      VALUE: {
        type: "string",
        menu: null,
        defaultValue: "argumentName",
      },
    };
    if (result.inputs) {
      delete result.inputs.VALUE;
    }
    result.substacks = [];
  }

  private _getArgumentTypeMeta(typeValue: any) {
    const raw = String(typeValue || "").toLowerCase();
    if (!raw) return { inferred: undefined, asField: false };
    if (raw === "variable") return { inferred: "variable", asField: true };
    if (raw === "list") return { inferred: "list", asField: true };
    if (raw === "broadcast") return { inferred: "broadcast", asField: true };
    if (raw === "number" || raw === "n") return { inferred: "number", asField: false };
    if (raw === "boolean" || raw === "bool" || raw === "b") return { inferred: "boolean", asField: false };
    if (raw === "string" || raw === "s") return { inferred: "string", asField: false };
    return { inferred: raw, asField: false };
  }

  private _inferFieldType(fieldName: string, field: any) {
    const upperName = String(fieldName || "").toUpperCase();
    if (upperName.includes("VARIABLE")) return "variable";
    if (upperName.includes("LIST")) return "list";
    if (upperName.includes("BROADCAST")) return "broadcast";

    const ctorName = String(field?.constructor?.name || "").toLowerCase();
    if (ctorName.includes("variable")) return "variable";
    if (ctorName.includes("dropdown")) return "string";
    if (ctorName.includes("number")) return "number";
    return undefined;
  }

  private _normalizeMenuOptions(rawOptions: any) {
    if (!Array.isArray(rawOptions)) return null;
    const normalized = [];
    for (const item of rawOptions) {
      if (Array.isArray(item)) {
        normalized.push({ text: String(item[0] ?? ""), value: item[1] });
        continue;
      }
      if (item && typeof item === "object") {
        const text = (item as any).text ?? (item as any).label ?? (item as any).name ?? (item as any).value ?? "";
        const value = (item as any).value ?? text;
        normalized.push({ text: String(text), value });
        continue;
      }
      normalized.push({ text: String(item ?? ""), value: item });
    }
    return normalized;
  }

  private _readFieldMenuOptions(field: any) {
    if (!field || typeof field.getOptions !== "function") return null;
    try {
      return this._normalizeMenuOptions(field.getOptions(false));
    } catch {
      try {
        return this._normalizeMenuOptions(field.getOptions());
      } catch {
        return null;
      }
    }
  }

  private _createScratchWorkspace(scratchBlocks: any) {
    const mainWorkspace = scratchBlocks?.getMainWorkspace?.();
    if (mainWorkspace) {
      return { workspace: mainWorkspace, ownsWorkspace: false };
    }
    if (typeof scratchBlocks?.Workspace === "function") {
      return { workspace: new scratchBlocks.Workspace(), ownsWorkspace: true };
    }
    return { workspace: null, ownsWorkspace: false };
  }

  private _readMenuFieldMetaFromBlockOpcode(blockOpcode: string, preferredFieldName?: string) {
    const scratchBlocks = (window as any)?.Blockly || (window as any)?.ScratchBlocks || this.vm?.runtime?.scratchBlocks;
    if (!blockOpcode || !scratchBlocks?.Blocks?.[blockOpcode]) return null;

    const { workspace, ownsWorkspace } = this._createScratchWorkspace(scratchBlocks);
    if (!workspace || typeof workspace.newBlock !== "function") return null;

    let block: any = null;
    try {
      block = workspace.newBlock(blockOpcode);
      const inputList = Array.isArray(block?.inputList) ? block.inputList : [];
      let firstMeta: any = null;

      for (const input of inputList) {
        const fieldRow = Array.isArray(input?.fieldRow) ? input.fieldRow : [];
        for (const field of fieldRow) {
          if (typeof field?.getOptions !== "function") continue;

          let defaultValue: any;
          try {
            defaultValue = typeof field.getValue === "function" ? field.getValue() : undefined;
          } catch {
            defaultValue = undefined;
          }

          const fieldName = String(field?.name || preferredFieldName || "");
          const meta = {
            fieldName,
            type: this._inferFieldType(fieldName, field) || "string",
            menu: fieldName || preferredFieldName || null,
            defaultValue,
            menuOptions: this._readFieldMenuOptions(field),
          };
          if (preferredFieldName && fieldName === preferredFieldName) {
            return meta;
          }
          firstMeta = firstMeta || meta;
        }
      }
      return firstMeta;
    } catch {
      return null;
    } finally {
      try {
        block?.dispose?.();
      } catch {
        // ignore temp block disposal failures
      }
      if (ownsWorkspace) {
        try {
          workspace.dispose?.();
        } catch {
          // ignore temp workspace disposal failures
        }
      }
    }
  }

  private _menuConfigToOptions(menuConfig: any) {
    if (!menuConfig) return null;
    if (Array.isArray(menuConfig)) return this._normalizeMenuOptions(menuConfig);
    if (typeof menuConfig === "object") {
      if (Array.isArray((menuConfig as any).items)) {
        return this._normalizeMenuOptions((menuConfig as any).items);
      }
      if (Array.isArray((menuConfig as any).options)) {
        return this._normalizeMenuOptions((menuConfig as any).options);
      }
    }
    return null;
  }

  private _getNativeBlockCatalogEntry(opcode: string) {
    return NativeScratchBlockCatalog[opcode] || null;
  }

  private _sanitizeBlockArgumentsForModel(argumentsMap: any) {
    if (!argumentsMap || typeof argumentsMap !== "object") return {};

    const sanitized: Record<string, any> = {};
    for (const [argName, argInfo] of Object.entries(argumentsMap)) {
      if (!argInfo || typeof argInfo !== "object" || Array.isArray(argInfo)) {
        sanitized[argName] = argInfo;
        continue;
      }

      const copied: Record<string, any> = { ...(argInfo as Record<string, any>) };
      const rawType = String(copied.type || "").toLowerCase();
      if (rawType === "image") {
        for (const key of Object.keys(copied)) {
          const lowerKey = key.toLowerCase();
          const value = copied[key];
          if (
            lowerKey === "data" ||
            lowerKey === "datauri" ||
            lowerKey === "dataurl" ||
            (typeof value === "string" && value.trim().toLowerCase().startsWith("data:image"))
          ) {
            delete copied[key];
          }
        }
      }

      sanitized[argName] = copied;
    }

    return sanitized;
  }

  private _summarizeDynamicArgsInfo(dynamicArgsInfo: any) {
    if (!dynamicArgsInfo || typeof dynamicArgsInfo !== "object") return null;
    const result: any = {
      enabled: true,
      inputPattern: "DYNAMIC_ARGS<number>",
    };

    const types = Array.isArray(dynamicArgsInfo.dynamicArgTypes)
      ? dynamicArgsInfo.dynamicArgTypes.map((item: any) => String(item || "s")).filter(Boolean)
      : ["s"];
    result.dynamicArgTypes = types.length > 0 ? types : ["s"];

    if (typeof dynamicArgsInfo.afterArg === "string" && dynamicArgsInfo.afterArg) {
      result.afterArg = dynamicArgsInfo.afterArg;
    }
    if (
      typeof dynamicArgsInfo.paramsIncrement === "number" ||
      typeof dynamicArgsInfo.paramsIncrement === "string" ||
      Array.isArray(dynamicArgsInfo.paramsIncrement)
    ) {
      result.paramsIncrement = dynamicArgsInfo.paramsIncrement;
    }
    if (dynamicArgsInfo.preText !== undefined) {
      result.hasPreText = true;
    }
    if (dynamicArgsInfo.endText !== undefined) {
      result.hasEndText = true;
    }
    if (dynamicArgsInfo.joinCh !== undefined) {
      result.hasJoinText = true;
    }
    if (dynamicArgsInfo.defaultValues !== undefined) {
      result.hasDefaultValues = true;
    }

    return result;
  }

  private _fillFromNativeCatalog(opcode: string, result: any) {
    const entry = this._getNativeBlockCatalogEntry(opcode);
    if (!entry) return;

    result.found = true;
    result.extensionId = null;
    if (!result.blockType) {
      result.blockType = this._normalizeBlockType(entry.block?.blockType);
    }
    if (!result.text) {
      result.text = AITools.AllBlockInfo[opcode] || entry.block?.text || "";
    }

    const argumentsMap =
      entry.block?.arguments && typeof entry.block.arguments === "object" ? entry.block.arguments : {};
    for (const [argName, argInfo] of Object.entries(argumentsMap)) {
      const typedArg = argInfo as any;
      const typeMeta = this._getArgumentTypeMeta(typedArg?.type);
      const isExplicitField = typedArg?.field === true;
      const normalized = {
        type:
          isExplicitField && argName === "VARIABLE"
            ? "variable"
            : isExplicitField && argName === "LIST"
              ? "list"
              : typeMeta.inferred,
        defaultValue: typedArg?.defaultValue,
        menu: typedArg?.menu || null,
      };

      if (String(argName).startsWith("SUBSTACK")) {
        result.inputs[argName] = {
          ...normalized,
          type: normalized.type || "substack",
        };
        if (!result.substacks.includes(argName)) {
          result.substacks.push(argName);
        }
        continue;
      }

      const menuConfig = typedArg?.menu ? entry.menus?.[typedArg.menu] : null;
      const hasCoreMenuShadow = Boolean(this._getCoreMenuShadowInfo(opcode, argName));
      const shouldUseField = Boolean(
        isExplicitField || typeMeta.asField || (typedArg?.menu && !menuConfig?.acceptReporters && !hasCoreMenuShadow),
      );
      const target = shouldUseField ? result.fields : result.inputs;
      target[argName] = normalized;

      if (typedArg?.menu && entry.menus?.[typedArg.menu]) {
        result.menus = result.menus || {};
        result.menus[typedArg.menu] = {
          menuType: entry.menus[typedArg.menu]?.acceptReporters ? "placeable" : "non_placeable",
          options: this._menuConfigToOptions(entry.menus[typedArg.menu]),
          sources: [{ sourceType: shouldUseField ? "field" : "input", sourceName: argName }],
        };

        if (shouldUseField) {
          target[argName] = {
            ...target[argName],
            menuType: result.menus[typedArg.menu].menuType,
            menuOptions: result.menus[typedArg.menu].options,
          };
        }
      }
    }

    const menuNameByNormalizedName = new Map<string, string>();
    Object.keys(entry.menus || {}).forEach((menuName) => {
      menuNameByNormalizedName.set(
        String(menuName)
          .replace(/[^a-z0-9]/gi, "")
          .toLowerCase(),
        menuName,
      );
    });
    const placeholderNames = [...String(entry.block?.text || "").matchAll(/\[([A-Z0-9_]+)\]/g)].map(
      (match) => match[1],
    );
    placeholderNames.forEach((argName) => {
      if (result.fields[argName] || result.inputs[argName]) return;
      const normalizedArgName = String(argName)
        .replace(/[^a-z0-9]/gi, "")
        .toLowerCase();
      const menuName = menuNameByNormalizedName.get(normalizedArgName) || null;
      const menuConfig = menuName ? entry.menus?.[menuName] : null;
      const meta: any = {
        type: "string",
        defaultValue: undefined,
        menu: menuName,
      };
      if (menuName && menuConfig) {
        result.menus = result.menus || {};
        result.menus[menuName] = {
          menuType: menuConfig?.acceptReporters ? "placeable" : "non_placeable",
          options: this._menuConfigToOptions(menuConfig),
          sources: [{ sourceType: menuConfig?.acceptReporters ? "input" : "field", sourceName: argName }],
        };
        meta.menuType = result.menus[menuName].menuType;
        meta.menuOptions = result.menus[menuName].options;
      }
      const shouldUseField = Boolean(menuName && menuConfig && !menuConfig.acceptReporters && !this._getCoreMenuShadowInfo(opcode, argName));
      const target = shouldUseField ? result.fields : result.inputs;
      target[argName] = meta;
    });
  }

  private _hasMenuShadowBlock(opcode: string, menuName: string, activeRuntime: any) {
    const namespace = String(opcode || "").includes("_") ? String(opcode).split("_")[0] : "";
    const coreMenuOpcodes = Object.values((CORE_MENU_SHADOWS as Record<string, Record<string, any>>)[opcode] || {}).map(
      (info: any) => info?.opcode,
    );
    const candidates = [
      ...coreMenuOpcodes,
      `${opcode}_menu`,
      namespace ? `${namespace}_menu_${menuName}` : "",
      menuName,
      `${menuName}_menu`,
    ].filter(Boolean);
    return candidates.some((candidate) =>
      Boolean(
        (activeRuntime?._primitives && activeRuntime._primitives[candidate]) ||
        (activeRuntime?.scratchBlocks?.Blocks && activeRuntime.scratchBlocks.Blocks[candidate]) ||
        ((window as any)?.ScratchBlocks?.Blocks && (window as any).ScratchBlocks.Blocks[candidate]) ||
        ((window as any)?.Blockly?.Blocks && (window as any).Blockly.Blocks[candidate]),
      ),
    );
  }

  private _readMenuOptionsFromShadowBlock(opcode: string, menuName: string, activeRuntime: any) {
    const scratchBlocks = activeRuntime?.scratchBlocks || (window as any)?.Blockly || (window as any)?.ScratchBlocks;
    if (!scratchBlocks?.Blocks) return null;

    const namespace = String(opcode || "").includes("_") ? String(opcode).split("_")[0] : "";
    const coreMenuOpcodes = Object.values((CORE_MENU_SHADOWS as Record<string, Record<string, any>>)[opcode] || {}).map(
      (info: any) => info?.opcode,
    );
    const candidates = [
      ...coreMenuOpcodes,
      `${opcode}_menu`,
      namespace ? `${namespace}_menu_${menuName}` : "",
      menuName,
      `${menuName}_menu`,
    ].filter((candidate) => scratchBlocks.Blocks[candidate]);
    if (candidates.length === 0) return null;
    const meta = this._readMenuFieldMetaFromBlockOpcode(candidates[0], menuName);
    return meta?.menuOptions || null;
  }

  private _readMenuFieldMetaFromInput(inputName: string, input: any) {
    const targetBlock =
      (typeof input?.connection?.targetBlock === "function" ? input.connection.targetBlock() : null) ||
      input?.connection?.targetConnection?.sourceBlock_ ||
      null;
    if (!targetBlock) return null;

    const inputList = Array.isArray(targetBlock.inputList) ? targetBlock.inputList : [];
    for (const targetInput of inputList) {
      const fieldRow = Array.isArray(targetInput?.fieldRow) ? targetInput.fieldRow : [];
      for (const field of fieldRow) {
        if (typeof field?.getOptions !== "function") continue;

        let defaultValue: any;
        try {
          defaultValue = typeof field.getValue === "function" ? field.getValue() : undefined;
        } catch {
          defaultValue = undefined;
        }

        return {
          type: this._inferFieldType(inputName, field) || "string",
          menu: String(field?.name || inputName),
          defaultValue,
          menuOptions: this._readFieldMenuOptions(field),
        };
      }
    }
    return null;
  }

  private _promoteNativeMenuInputsToFields(opcode: string, result: any) {
    const menuOpcode = `${opcode}_menu`;
    const menuMeta = this._readMenuFieldMetaFromBlockOpcode(menuOpcode);
    const fieldName = String(menuMeta?.fieldName || "").trim();
    if (!fieldName || !result.inputs[fieldName] || result.substacks.includes(fieldName)) {
      return;
    }

    const inputMeta = result.inputs[fieldName];
    result.fields[fieldName] = {
      ...(result.fields[fieldName] || {}),
      type: menuMeta?.type || inputMeta?.type || "string",
      menu: menuMeta?.menu || fieldName,
      defaultValue: menuMeta?.defaultValue,
      menuOptions: menuMeta?.menuOptions || null,
      menuType: "non_placeable",
    };
    delete result.inputs[fieldName];
  }

  private _moveMenuInputsToFields(result: any) {
    for (const [inputName, inputMeta] of Object.entries({ ...(result.inputs || {}) })) {
      const opcode = String(result?.opcode || "");
      if (
        inputName === "INDEX" &&
        (opcode === "data_deleteoflist" ||
          opcode === "data_insertatlist" ||
          opcode === "data_replaceitemoflist" ||
          opcode === "data_itemoflist")
      ) {
        continue;
      }
      const menuName = typeof (inputMeta as any)?.menu === "string" ? (inputMeta as any).menu : null;
      if (!menuName || result.substacks.includes(inputName)) {
        continue;
      }
      if ((inputMeta as any)?.menuType === "placeable" || this._getCoreMenuShadowInfo(opcode, inputName)) {
        continue;
      }

      result.fields[inputName] = {
        ...(result.fields[inputName] || {}),
        ...(inputMeta as any),
      };
      delete result.inputs[inputName];
    }
  }

  private _dedupeFieldAndInputNames(result: any) {
    const fieldNames = new Set(Object.keys(result.fields || {}));
    for (const inputName of Object.keys({ ...(result.inputs || {}) })) {
      if (fieldNames.has(inputName)) {
        delete result.inputs[inputName];
      }
    }
  }

  private _isKnownOpcode(opcode: string) {
    if (!opcode) return false;
    if (this._getNativeBlockCatalogEntry(opcode)) return true;
    if (this.vm?.runtime?._primitives?.[opcode]) return true;
    if (AITools.AllBlockInfo[opcode]) return true;

    const scratchBlocks = (window as any)?.Blockly || (window as any)?.ScratchBlocks || this.vm?.runtime?.scratchBlocks;
    if (scratchBlocks?.Blocks && typeof scratchBlocks.Blocks[opcode] !== "undefined") {
      return true;
    }

    for (const extInfo of this.vm?.runtime?._blockInfo || []) {
      for (const block of extInfo?.blocks || []) {
        const fullOpcode = `${extInfo.id}_${block.info?.opcode}`;
        if (fullOpcode === opcode || block.info?.opcode === opcode) {
          return true;
        }
      }
    }
    return false;
  }

  private _enrichMenuMeta(opcode: string, result: any, extMenus: any, activeRuntime: any) {
    const menuSummary: Record<string, any> = result.menus && typeof result.menus === "object" ? result.menus : {};
    const ensureMeta = (entry: any, sourceType: "field" | "input", sourceName: string) => {
      if (!entry || typeof entry !== "object") return;
      const menuName = typeof entry.menu === "string" ? entry.menu : null;
      if (!menuName) return;

      const existingOptions = Array.isArray(entry.menuOptions) ? entry.menuOptions : null;
      const preDefinedMenuType = menuSummary[menuName]?.menuType || null;
      const existingMenuType = typeof entry.menuType === "string" ? entry.menuType : preDefinedMenuType;
      const fromExt = this._menuConfigToOptions(extMenus?.[menuName]);
      const fromShadow = this._readMenuOptionsFromShadowBlock(opcode, menuName, activeRuntime);
      const menuOptions = existingOptions || fromExt || fromShadow || null;
      const isSoundFieldMenu =
        menuName === "SOUND_MENU" &&
        (opcode === "sound_play" || opcode === "sound_playuntildone") &&
        sourceType === "field";
      const isCoreMenuShadow = Boolean(this._getCoreMenuShadowInfo(opcode, sourceName));

      const placeable =
        !isSoundFieldMenu &&
        (isCoreMenuShadow ||
          existingMenuType === "placeable" ||
          (existingMenuType !== "non_placeable" &&
            (sourceType === "input" || this._hasMenuShadowBlock(opcode, menuName, activeRuntime))));

      entry.menuType = placeable ? "placeable" : "non_placeable";
      entry.menuOptions = menuOptions;

      if (!menuSummary[menuName]) {
        menuSummary[menuName] = {
          menuType: entry.menuType,
          options: menuOptions,
          sources: [],
        };
      } else {
        if (!menuSummary[menuName].options && menuOptions) {
          menuSummary[menuName].options = menuOptions;
        }
        if (isSoundFieldMenu) {
          menuSummary[menuName].menuType = "non_placeable";
        } else if (menuSummary[menuName].menuType !== "placeable" && entry.menuType === "placeable") {
          menuSummary[menuName].menuType = "placeable";
        }
      }
      const hasSameSource = menuSummary[menuName].sources.some(
        (source: any) => source?.sourceType === sourceType && source?.sourceName === sourceName,
      );
      if (!hasSameSource) {
        menuSummary[menuName].sources.push({ sourceType, sourceName });
      }
    };

    for (const [fieldName, fieldMeta] of Object.entries(result.fields || {})) {
      ensureMeta(fieldMeta, "field", fieldName);
    }
    for (const [inputName, inputMeta] of Object.entries(result.inputs || {})) {
      ensureMeta(inputMeta, "input", inputName);
    }

    if (Object.keys(menuSummary).length > 0) {
      result.menus = menuSummary;
    }
  }

  private _fillFromScratchBlocks(opcode: string, result: any) {
    const scratchBlocks = (window as any)?.Blockly || (window as any)?.ScratchBlocks || this.vm?.runtime?.scratchBlocks;
    if (!scratchBlocks?.Blocks || typeof scratchBlocks?.Blocks?.[opcode] === "undefined") {
      return;
    }

    const mainWorkspace = scratchBlocks?.getMainWorkspace?.();
    let workspace = mainWorkspace;
    let ownsWorkspace = false;
    if (!workspace && typeof scratchBlocks?.Workspace === "function") {
      workspace = new scratchBlocks.Workspace();
      ownsWorkspace = true;
    }
    if (!workspace || typeof workspace.newBlock !== "function") {
      return;
    }

    let block: any = null;
    try {
      block = workspace.newBlock(opcode);
    } catch {
      return;
    }
    if (!block) return;

    try {
      if (!result.blockType) {
        if (block.outputConnection) {
          const outputChecks = block.outputConnection.check_ as string[] | null | undefined;
          const hasBooleanOutput = Array.isArray(outputChecks)
            ? outputChecks.some((v) => String(v).toLowerCase() === "boolean")
            : false;
          result.blockType = hasBooleanOutput ? "boolean" : "reporter";
        } else if (!block.previousConnection && block.nextConnection) {
          result.blockType = "hat";
        } else {
          result.blockType = "command";
        }
      }

      const inputList = Array.isArray(block.inputList) ? block.inputList : [];
      for (const input of inputList) {
        const inputName = input?.name ? String(input.name) : "";
        const fieldRow = Array.isArray(input?.fieldRow) ? input.fieldRow : [];

        for (const field of fieldRow) {
          const fieldName = field?.name ? String(field.name) : "";
          if (!fieldName) continue;

          let defaultValue: any;
          try {
            defaultValue = typeof field.getValue === "function" ? field.getValue() : undefined;
          } catch {
            defaultValue = undefined;
          }

          const hasMenu = typeof field?.getOptions === "function";
          result.fields[fieldName] = {
            type: this._inferFieldType(fieldName, field),
            menu: hasMenu ? fieldName : null,
            defaultValue,
            menuOptions: hasMenu ? this._readFieldMenuOptions(field) : null,
            menuType: hasMenu ? "non_placeable" : undefined,
          };
        }

        if (!inputName) continue;
        const existingFieldMeta = result.fields[inputName];
        if (existingFieldMeta && typeof existingFieldMeta === "object" && existingFieldMeta.menu) {
          delete result.inputs[inputName];
          continue;
        }

        const menuFieldMeta = this._readMenuFieldMetaFromInput(inputName, input);
        if (menuFieldMeta) {
          result.fields[inputName] = {
            ...(result.fields[inputName] || {}),
            ...menuFieldMeta,
          };
          delete result.inputs[inputName];
          continue;
        }

        const inputMeta: any = result.inputs[inputName] || { type: undefined, menu: null, defaultValue: undefined };
        const statementInputType =
          typeof scratchBlocks?.NEXT_STATEMENT === "number" ? scratchBlocks.NEXT_STATEMENT : undefined;
        const inputTypeText = String(input?.type ?? "").toLowerCase();
        const isStatementInput =
          inputName.startsWith("SUBSTACK") ||
          (statementInputType !== undefined && input?.type === statementInputType) ||
          inputTypeText.includes("statement");
        if (isStatementInput) {
          inputMeta.type = inputMeta.type || "substack";
          if (!result.substacks.includes(inputName)) {
            result.substacks.push(inputName);
          }
        } else {
          const check = input?.connection?.check_;
          if (Array.isArray(check) && check.length > 0) {
            inputMeta.type = check.join("|");
          } else if (!inputMeta.type) {
            inputMeta.type = "string|number";
          }
        }
        result.inputs[inputName] = inputMeta;
      }

      if (Object.keys(result.fields).length > 0 || Object.keys(result.inputs).length > 0) {
        result.found = true;
      }
    } finally {
      try {
        block.dispose?.();
      } catch {
        // ignore temp block disposal failures
      }
      if (ownsWorkspace) {
        try {
          workspace.dispose?.();
        } catch {
          // ignore temp workspace disposal failures
        }
      }
    }
  }

  private _fillFromAllBlockInfo(opcode: string, result: any) {
    const text = AITools.AllBlockInfo[opcode];
    if (!text) return;
    result.text = text;
    result.found = true;
    if (!result.blockType) {
      result.blockType = "command";
    }

    const matches = [...text.matchAll(/\(([^)]*)\)/g)];
    if (matches.length === 0) return;
    const inside = String(matches[matches.length - 1]?.[1] ?? "").trim();
    if (!inside) return;

    const parts = inside
      .split(/[,，]/)
      .map((x) => x.trim())
      .filter(Boolean);
    for (const part of parts) {
      const kv = part.split(/[:：]/);
      if (kv.length !== 2) continue;
      const argName = kv[0].trim();
      const typeMeta = this._getArgumentTypeMeta(kv[1].trim());
      const target = typeMeta.asField ? result.fields : result.inputs;
      if (typeMeta.asField) {
        delete result.inputs[argName];
      } else {
        const existingField = result.fields[argName];
        if (!existingField?.menu) {
          delete result.fields[argName];
        }
      }
      target[argName] = {
        type: typeMeta.inferred,
        menu: typeMeta.asField ? argName : null,
        defaultValue: undefined,
      };
    }
  }

  private _applyNativeSubstackFallback(opcode: string, result: any) {
    const fallback: Record<string, string[]> = {
      control_repeat: ["SUBSTACK"],
      control_repeat_until: ["SUBSTACK"],
      control_while: ["SUBSTACK"],
      control_forever: ["SUBSTACK"],
      control_for_each: ["SUBSTACK"],
      control_if: ["SUBSTACK"],
      control_if_else: ["SUBSTACK", "SUBSTACK2"],
    };
    const names = fallback[opcode];
    if (!names) return;
    for (const name of names) {
      if (!result.substacks.includes(name)) {
        result.substacks.push(name);
      }
      result.inputs[name] = {
        ...(result.inputs[name] || {}),
        type: result.inputs[name]?.type || "substack",
        menu: result.inputs[name]?.menu ?? null,
      };
    }
  }

  getProjectOverview() {
    const listRepairs = repairListVariableValues(this.vm);
    const targets = Array.isArray(this.vm.runtime?.targets) ? this.vm.runtime.targets : [];
    const allFiles = this._getVirtualFiles({
      includeScriptContent: false,
      includeLegacyTargetContent: false,
      includeDocContent: false,
    });
    const files = allFiles.filter((entry) => entry.kind === "target");
    const scriptFiles = allFiles.filter((entry) => entry.kind === "script");
    const health = this._getDataHealth(targets, new Map(files.map((entry) => [entry.targetId, entry.path])), listRepairs);
    const costumeFiles = allFiles.filter((entry) => entry.kind === "costume");
    const soundFiles = allFiles.filter((entry) => entry.kind === "sound");
    const stageVariablesPath = allFiles.find((file) => file.kind === "variables" && file.isStage)?.path;
    const stageListsPath = allFiles.find((file) => file.kind === "lists" && file.isStage)?.path;

    return {
      success: true,
      stage: {
        width: this.vm.runtime?.stageWidth,
        height: this.vm.runtime?.stageHeight,
        coordinateSystem: {
          origin: "The stage center is (0, 0).",
          xAxis: "x increases to the right and decreases to the left.",
          yAxis: "y increases upward and decreases downward.",
        },
      },
      files: files.map((entry) => {
        const target = targets.find((item: any) => item?.id === entry.targetId) as any;
        const targetScriptFiles = scriptFiles.filter((file) => file.targetId === entry.targetId);
        const scriptCount = targetScriptFiles.reduce(
          (sum, file) => sum + (file.scriptIds?.length || (file.scriptId ? 1 : 0)),
          0,
        );
        return {
          path: entry.path,
          targetId: entry.targetId,
          targetName: entry.targetName,
          isStage: entry.isStage,
          scriptFileCount: targetScriptFiles.length,
          scriptCount,
          scriptDirectory: `${getVirtualParentPath(entry.path)}/${VIRTUAL_SCRIPTS_DIR_NAME}`,
          defaultScriptFilePath: `${getVirtualParentPath(entry.path)}/${VIRTUAL_SCRIPTS_DIR_NAME}/${this._getDefaultScriptFileNameFromTargetComment(target)}`,
          costumeOrderPath: `${getVirtualParentPath(entry.path)}/${VIRTUAL_COSTUME_DIR_NAME}/${VIRTUAL_COSTUME_ORDER_FILE_NAME}`,
          variablesPath: entry.isStage ? stageVariablesPath : undefined,
          listsPath: entry.isStage ? stageListsPath : undefined,
          costumeCount: costumeFiles.filter((file) => file.targetId === entry.targetId).length,
          soundCount: soundFiles.filter((file) => file.targetId === entry.targetId).length,
        };
      }),
      totals: {
        targetCount: files.length,
        scriptFileCount: scriptFiles.length,
        scriptCount: scriptFiles.reduce((sum, file) => sum + (file.scriptIds?.length || (file.scriptId ? 1 : 0)), 0),
        costumeCount: costumeFiles.length,
        soundCount: soundFiles.length,
      },
      dataPaths: {
        variablesPath: stageVariablesPath,
        listsPath: stageListsPath,
      },
      health,
      nextSteps: [
        "Use listFiles/searchFiles to inspect precise virtual files instead of relying on project overview details.",
        "Use readFile only for the specific files needed by the user request.",
        "Use getScratchGuide for concise DSL patterns.",
        "Use searchBlocks for candidate opcodes.",
        "Use getBlocksHelp before writing unfamiliar blocks.",
        'For features outside core Scratch blocks, check installed extensions with getAllExtensions and approved extensions with getScratchGuide({ topic: "extension-index" }) before proposing implementation details.',
        'For rendering, algorithms, or reusable parameterized logic, use getScratchGuide({ topic: "procedures" }) and prefer warp custom blocks over broadcast-only flows.',
      ],
    };
  }

  getScratchGuide(topic?: string) {
    const requestedTopic = String(topic || "quickstart")
      .trim()
      .toLowerCase();
    const topicAliases: Record<string, string> = {
      procedure: "procedures",
      procedures: "procedures",
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
      extension: APPROVED_EXTENSION_INDEX_GUIDE_TOPIC,
      extensions: APPROVED_EXTENSION_INDEX_GUIDE_TOPIC,
      "extension-index": APPROVED_EXTENSION_INDEX_GUIDE_TOPIC,
      "approved-extension": APPROVED_EXTENSION_INDEX_GUIDE_TOPIC,
      "approved-extensions": APPROVED_EXTENSION_INDEX_GUIDE_TOPIC,
      "extension-list": APPROVED_EXTENSION_INDEX_GUIDE_TOPIC,
    };
    const normalizedTopic = topicAliases[requestedTopic] || requestedTopic;
    const guides: Record<string, any> = {
      [APPROVED_EXTENSION_INDEX_GUIDE_TOPIC]: {
        title: APPROVED_EXTENSION_INDEX_GUIDE_TITLE,
        rules: buildApprovedExtensionIndexGuideRules(),
        examples: [
          'searchExtensions({ query: "camera" });',
          'addExtension({ extensionId: "GandiKamera" });',
        ],
      },
      quickstart: {
        title: "Scratch JS DSL quickstart",
        rules: [
          "Patch /stage/scripts/*.js or /<target>/scripts/*.js with applyPatch. SVG costumes are editable at /<target>/custom/costume.svg. Variables/lists default to root English JSON paths /variables.json and /lists.json; /stage/... and /<target>/... data paths are aliases to the same global files. Targets do not have private variables/lists.",
          "SVG root attributes data-rotation-center-x and data-rotation-center-y control the Scratch costume/backdrop rotation center in SVG coordinates. If missing, applyPatch adds them with the SVG geometric center.",
          "Create, rename, and delete sprites by adding, moving, and deleting root sprite folders.",
          "Every // @script section in /<target>/scripts/*.js must produce exactly one top-level script; feature files may contain multiple sections.",
          "Hat blocks use a trailing callback: event.whenflagclicked({ $xy }, () => { ... });",
          "C-block bodies use SUBSTACK/SUBSTACK2 arrow functions.",
          "Menus, variables, and lists use $field_ keys.",
          'Inside custom blocks, parameters are read with argument.reporter_string_number({ $field_VALUE: "param" }), not data.variable.',
        ],
        examples: [
          'event.whenflagclicked({ $xy: { x: 80, y: 80 } }, () => { looks.say({ MESSAGE: "hello" }); });',
          "control.repeat({ TIMES: 10, SUBSTACK: () => { motion.movesteps({ STEPS: 5 }); } });",
          'data.setvariableto({ $field_VARIABLE: "score", VALUE: 0 });',
          'data.addtolist({ $field_LIST: "numbers", ITEM: operator.random({ FROM: 1, TO: 100 }) });',
        ],
      },
      events: {
        title: "Events and hats",
        examples: [
          'event.whenflagclicked({ $xy: { x: 80, y: 80 } }, () => { looks.say({ MESSAGE: "start" }); });',
          'event.whenkeypressed({ $field_KEY_OPTION: "space", $xy: { x: 80, y: 220 } }, () => { event.broadcast({ BROADCAST_INPUT: "step" }); });',
          'event.whenbroadcastreceived({ $field_BROADCAST_OPTION: "step", $xy: { x: 80, y: 360 } }, () => { looks.say({ MESSAGE: "step" }); });',
          "control.start_as_clone({ $xy: { x: 80, y: 500 } }, () => { looks.show(); });",
        ],
      },
      data: {
        title: "Variables and lists",
        rules: [
          "Always use $field_VARIABLE and $field_LIST selectors.",
          'Read variables with data.variable({ $field_VARIABLE: "name" }).',
          'Read list items with data.itemoflist({ $field_LIST: "numbers", INDEX: ... }).',
        ],
        examples: [
          'data.setvariableto({ $field_VARIABLE: "i", VALUE: 1 });',
          'data.changevariableby({ $field_VARIABLE: "i", VALUE: 1 });',
          'data.deletealloflist({ $field_LIST: "numbers" });',
          'data.replaceitemoflist({ $field_LIST: "numbers", INDEX: data.variable({ $field_VARIABLE: "i" }), ITEM: data.variable({ $field_VARIABLE: "temp" }) });',
        ],
      },
      control: {
        title: "Control flow",
        examples: [
          'control.if({ CONDITION: operator.gt({ OPERAND1: data.variable({ $field_VARIABLE: "a" }), OPERAND2: 10 }), SUBSTACK: () => { looks.say({ MESSAGE: "big" }); } });',
          'control.if_else({ CONDITION: sensing.keypressed({ $field_KEY_OPTION: "space" }), SUBSTACK: () => { looks.say({ MESSAGE: "yes" }); }, SUBSTACK2: () => { looks.say({ MESSAGE: "no" }); } });',
          'control.repeat_until({ CONDITION: operator.gt({ OPERAND1: data.variable({ $field_VARIABLE: "i" }), OPERAND2: 10 }), SUBSTACK: () => { data.changevariableby({ $field_VARIABLE: "i", VALUE: 1 }); } });',
        ],
      },
      procedures: {
        title: "Custom blocks / functions",
        rules: [
          "Use custom blocks for reusable logic, render helpers, math helpers, list algorithms, and any operation that needs parameters.",
          'Use info: ["warp"] for helpers that should run without screen refresh, such as drawing a whole chart in one frame.',
          "Use broadcasts for cross-target events only. Do not use broadcasts as local function calls when a custom block can pass parameters.",
          "Define custom blocks in the same target that uses the visual/pen/motion behavior.",
          "Inside define(...), read parameters with argument.reporter_string_number / argument.reporter_boolean and $field_VALUE.",
        ],
        examples: [
          'define({ proccode: "draw bars %n[highlight1] %n[highlight2]", info: ["warp"], $xy: { x: 80, y: 360 } }, () => {',
          "  pen.clear();",
          '  data.setvariableto({ $field_VARIABLE: "i", VALUE: 1 });',
          '  control.repeat({ TIMES: data.lengthoflist({ $field_LIST: "numbers" }), SUBSTACK: () => {',
          '    control.if({ CONDITION: operator.equals({ OPERAND1: data.variable({ $field_VARIABLE: "i" }), OPERAND2: argument.reporter_string_number({ $field_VALUE: "highlight1" }) }), SUBSTACK: () => {',
          '      pen.setPenColorToColor({ COLOR: "#ff4d4f" });',
          "    } });",
          "    // draw bar i here",
          '    data.changevariableby({ $field_VARIABLE: "i", VALUE: 1 });',
          "  } });",
          "});",
          'procedures.call({ $mutation: { proccode: "draw bars %n %n", warp: "true" }, $args: [0, 0] });',
        ],
      },
      "custom-args": {
        title: "Custom block parameters",
        rules: [
          "Define named parameters with placeholders like %n[highlight] or %b[enabled].",
          'Read number/string parameters with argument.reporter_string_number({ $field_VALUE: "highlight" }).',
          'Read boolean parameters with argument.reporter_boolean({ $field_VALUE: "enabled" }).',
          "Do not use data.variable for custom block parameters; that reads a global Scratch variable and can silently break logic.",
          'The call proccode uses placeholder shapes without names, e.g. "draw frame %n" and $args: [1].',
        ],
        examples: [
          'define({ proccode: "draw frame %n[highlight]", info: ["warp"], $xy: { x: 80, y: 360 } }, () => {',
          '  control.if({ CONDITION: operator.equals({ OPERAND1: data.variable({ $field_VARIABLE: "i" }), OPERAND2: argument.reporter_string_number({ $field_VALUE: "highlight" }) }), SUBSTACK: () => {',
          '    pen.setPenColorToColor({ COLOR: "#ff4d4f" });',
          "  } });",
          "});",
          'procedures.call({ $mutation: { proccode: "draw frame %n", warp: "true" }, $args: [data.variable({ $field_VARIABLE: "j" })] });',
        ],
      },
      "dynamic-blocks": {
        title: "Dynamic extension blocks",
        rules: [
          'Write dynamic inputs with $dynamicArgs: [...].',
          'Put $dynamicArgs items in the same order they should appear in the block.',
          'Each item can be a literal value or a reporter block.',
          'For key/value object blocks, write key and value items in order, for example ["name", "Alex", "age", 12].',
          'Use $dynamicArgTypes only when an item needs a non-default input shape: s for text, n for number, b for Boolean.',
          'After editing a script with dynamic inputs, run getDiagnostics on that script.',
        ],
        examples: [
          'moreDataTypes.getNewObject({ $dynamicArgs: ["name", "Alex", "age", 12] });',
          'moreDataTypes.getNewList({ $dynamicArgs: ["apple", "banana"] });',
          'someExtension.dynamicBlock({ $dynamicArgs: [operator.add({ NUM1: 1, NUM2: 2 })], $dynamicArgTypes: ["n"] });',
        ],
      },
      rendering: {
        title: "Fast pen rendering pattern",
        rules: [
          "For charts, games, and visualizations, prefer one broadcast/event to trigger rendering, then call a warp custom block to draw the full frame.",
          "A warp custom block prevents Scratch from showing every intermediate pen move, so the frame appears complete immediately.",
          "Use custom block parameters for highlight index, colors, offsets, scale, and list length.",
        ],
        examples: [
          'event.whenbroadcastreceived({ $field_BROADCAST_OPTION: "render", $xy: { x: 60, y: 80 } }, () => {',
          '  procedures.call({ $mutation: { proccode: "draw frame %n %n", warp: "true" }, $args: [data.variable({ $field_VARIABLE: "left" }), data.variable({ $field_VARIABLE: "right" })] });',
          "});",
          'define({ proccode: "draw frame %n[left] %n[right]", info: ["warp"], $xy: { x: 60, y: 260 } }, () => {',
          "  pen.clear();",
          '  // Use argument.reporter_string_number({ $field_VALUE: "left" }) and "right" for highlights.',
          "  // Draw the whole frame here.",
          "});",
        ],
      },
      menus: {
        title: "Menu / dropdown fields",
        rules: [
          "Dropdowns, variables, lists, keys, broadcasts, and pen COLOR_PARAM use $field_ keys.",
          "If a block has a menu field, do not omit it. getDiagnostics rejects missing required menu fields.",
          'Pen COLOR_PARAM values are "color", "saturation", "brightness", and "transparency".',
        ],
        examples: [
          'event.whenkeypressed({ $field_KEY_OPTION: "space", $xy: { x: 80, y: 80 } }, () => { looks.say({ MESSAGE: "space" }); });',
          'event.whenbroadcastreceived({ $field_BROADCAST_OPTION: "render", $xy: { x: 80, y: 220 } }, () => { looks.say({ MESSAGE: "render" }); });',
          'data.setvariableto({ $field_VARIABLE: "score", VALUE: 0 });',
          'data.deletealloflist({ $field_LIST: "numbers" });',
          'pen.setPenColorParamTo({ $field_COLOR_PARAM: "color", VALUE: 50 });',
          'pen.changePenColorParamBy({ $field_COLOR_PARAM: "brightness", VALUE: 10 });',
        ],
      },
      pen: {
        title: "Pen drawing",
        rules: [
          "Use pen.setPenColorToColor for hex colors.",
          "Use pen.setPenColorParamTo / changePenColorParamBy for hue/brightness/saturation/transparency numbers.",
          "COLOR_PARAM is a menu field and must be written as $field_COLOR_PARAM.",
        ],
        examples: [
          "pen.clear();",
          "pen.setPenSizeTo({ SIZE: 18 });",
          'pen.setPenColorToColor({ COLOR: "#4a90d9" });',
          'pen.setPenColorParamTo({ $field_COLOR_PARAM: "color", VALUE: 50 });',
          'pen.changePenColorParamBy({ $field_COLOR_PARAM: "brightness", VALUE: 10 });',
        ],
      },
      patching: {
        title: "Patch workflow",
        rules: [
          "For a new empty script file, full replacement after *** Update File is safest.",
          "Use *** Add File: /SpriteName to create a sprite folder, *** Move to: /SpriteName to rename one, and *** Delete File: /SpriteName to delete one. The stage stays at /stage.",
          "Use *** Add File: /SpriteName to create a sprite folder, *** Move to: /SpriteName to rename one, and *** Delete File: /SpriteName to delete one. The stage stays at /stage.",
          "Set data-rotation-center-x and data-rotation-center-y on the root <svg> to control the Scratch rotation center/pivot. Omit them only if the geometric center is correct; the tool will add them automatically.",
          "Delete costumes or sounds by deleting files under /<target>/custom or /<target>/audio.",
          "For existing generated scripts, readFile the specific /<target>/scripts/*.js file first.",
          "Patch one feature script file at a time, then getDiagnostics.",
        ],
        example:
          '*** Begin Patch\n*** Add File: /角色1/scripts/hello.js\nevent.whenflagclicked({ $xy: { x: 80, y: 80 } }, () => {\n  looks.say({ MESSAGE: "hello" });\n});\n*** End Patch',
      },
      debugging: {
        title: "Diagnostics-first debugging",
        rules: [
          "After every applyPatch, call getDiagnostics on changed files.",
          "If a block help call fails, call searchBlocks with the natural name; aliases such as operator.less and pen.down are supported.",
          "Missing menu fields, custom-argument-as-variable mistakes, non-Boolean CONDITIONS, and bad pen colors are reported before Scratch blocks are changed.",
          "Use getProjectOverview to inspect files, scripts, variables, lists, and data health.",
        ],
        examples: [
          'getBlocksHelp({ opcodes: ["operator.less"] }) -> returns operator.lt/operator_lt help.',
          'getScratchGuide({ topic: "custom-args" }) before writing parameterized custom blocks.',
          'getScratchGuide({ topic: "menus" }) before using pen/key/broadcast dropdowns.',
        ],
      },
    };

    const extensionGuides = getAiReadableExtensionGuides(this.vm?.runtime);
    const availableTopics = () =>
      getAllGuides(this.userGuides, extensionGuides)
        .filter((item) => item.enabled || item.source === "default" || item.readOnly)
        .map((item) => item.name);
    if (/^(topics|topic-list|list|index|目录|指南目录)$/i.test(requestedTopic)) {
      return {
        success: true,
        topic: "topics",
        availableTopics: availableTopics(),
      };
    }
    const userGuideResult = findGuide(this.userGuides, normalizedTopic, extensionGuides);
    if (
      userGuideResult.guide?.source === "user" ||
      userGuideResult.guide?.source === "ai" ||
      userGuideResult.guide?.source === "extension"
    ) {
      return {
        success: true,
        topic: userGuideResult.topic,
        title: userGuideResult.guide.title,
        source: userGuideResult.guide.source,
        extensionId: userGuideResult.guide.extensionId,
        extensionName: userGuideResult.guide.extensionName,
        readOnly: userGuideResult.guide.readOnly,
        content: userGuideResult.guide.content,
        tools: userGuideResult.guide.tools.map((tool) => tool.name),
      };
    }

    const guide = guides[normalizedTopic] || guides.quickstart;
    return {
      success: true,
      topic: guides[normalizedTopic] ? normalizedTopic : "quickstart",
      ...guide,
    };
  }

  runGuideTool(options: { tool?: string; args?: Record<string, unknown> }) {
    const tool = String(options?.tool || "").trim();
    return executeGuideTool(this.userGuides, tool, options?.args || {}, {
      vm: this.vm,
      workspace: this._getWorkspace(),
    });
  }

  createAiGuide(options: {
    name?: string;
    title?: string;
    description?: string;
    content?: string;
    indexJs?: string;
  }) {
    if (!this.guideActions?.createAiGuide) {
      return { success: false, error: "Guide creation is not available in this context." };
    }
    const name = normalizeGuideName(String(options?.name || options?.title || "ai-guide"));
    const description = String(options?.description || "").trim();
    const content = String(options?.content || "").trim();
    const indexJs = String(options?.indexJs || "");
    if (!name) {
      return { success: false, error: "createAiGuide requires a guide name." };
    }
    if (!description) {
      return { success: false, error: "createAiGuide requires a short description explaining when to use it and what it helps with." };
    }
    if (!content) {
      return { success: false, error: "createAiGuide requires Markdown guide content." };
    }
    const guide = this.guideActions.createAiGuide({
      name,
      title: String(options?.title || name).trim() || name,
      description,
      content,
      indexJs,
      category: "ai",
      createdBy: "ai",
      enabled: true,
    });
    const parsedTools = extractGuideTools(name, guide.indexJs);
    const hasIndexJs = Boolean(guide.indexJs?.trim());
    return {
      success: true,
      id: guide.id,
      name: guide.name,
      title: guide.title,
      description: guide.description || description,
      category: guide.category || "ai",
      hasTools: parsedTools.length > 0,
      tools: parsedTools.map((tool) => tool.name),
      warning: hasIndexJs && !parsedTools.length
        ? "indexJs was saved, but no callable guide tools were detected. Use top-level async functions or export default { tools: { toolName: { execute(args) { ... } } } }."
        : undefined,
    };
  }

  searchBlocks(options: string | { query?: string; maxResults?: number; includeExamples?: boolean }) {
    const query = typeof options === "string" ? options : String(options?.query || "");
    const queryLower = query.trim().toLowerCase();
    const keywords = queryLower.split(/\s+/).filter(Boolean);
    if (keywords.length === 0) {
      return { success: false, error: "searchBlocks requires a non-empty query.", matches: [] };
    }

    const maxResults = typeof options === "object" ? Math.max(1, Math.min(50, Number(options?.maxResults || 12))) : 12;
    const includeExamples = typeof options !== "object" || options?.includeExamples !== false;
    const blockIds = this._getAllBlockIds();
    const matches: any[] = [];
    const scoredMatches: Array<{ opcode: string; rawText: string; score: number; matchedTerms: string[] }> = [];
    const seenOpcodes = new Set<string>();
    const queryText = keywords.join(" ");
    const normalizedQueryText = normalizeOpcodeLookupKey(queryText).replace(/_/g, " ");
    const wantsProcedures =
      /(自定义|函数|function|procedure|procedures|custom|warp|不刷新|渲染|render|frame|helper)/i.test(queryText);

    if (wantsProcedures) {
      const defineHelp = this._compactBlockHelp({
        opcode: "define",
        text: "Define custom block",
        type: "hat",
        blockType: "hat",
        fields: {},
        inputs: {},
        substacks: [],
        menus: {},
      });
      matches.push({
        opcode: "define",
        dslCall: "define",
        text: '定义自定义积木；use info: ["warp"] to run without screen refresh',
        type: "hat",
        fields: {},
        inputs: {},
        substacks: [],
        example: includeExamples ? defineHelp.example : undefined,
        notes: [
          'Use define({ proccode: "...", info: ["warp"] }, () => { ... }) for reusable/fast helpers.',
          "Prefer custom blocks over broadcasts for local parameterized logic.",
        ],
      });
      seenOpcodes.add("define");
    }

    for (const [opcode, rawText] of Object.entries(blockIds)) {
      if (seenOpcodes.has(opcode)) continue;
      const searchParts = [opcode, this._toDslCallName(opcode), String(rawText || ""), ...(AITools.BlockSearchAliases[opcode] || [])];
      const searchText = searchParts.join(" ").toLowerCase();
      const normalizedSearchText = searchParts.map((part) => normalizeOpcodeLookupKey(part).replace(/_/g, " ")).join(" ");
      const directMatch = keywords.every((keyword) => {
        const normalizedKeyword = normalizeOpcodeLookupKey(keyword);
        return (
          searchText.includes(keyword) ||
          Boolean(normalizedKeyword && normalizedSearchText.includes(normalizedKeyword.replace(/_/g, " ")))
        );
      });

      const phraseMatches = SCRATCH_BLOCK_SEARCH_PHRASES
        .filter(([phraseOpcode]) => phraseOpcode === opcode)
        .flatMap(([, phrases]) => phrases)
        .filter((phrase) => {
          const normalizedPhrase = normalizeOpcodeLookupKey(phrase).replace(/_/g, " ");
          return queryLower.includes(phrase.toLowerCase()) || normalizedQueryText.includes(normalizedPhrase);
        });

      let score = directMatch ? 100 : 0;
      const matchedTerms: string[] = [];
      for (const keyword of keywords) {
        const normalizedKeyword = normalizeOpcodeLookupKey(keyword).replace(/_/g, " ");
        if (searchText.includes(keyword) || (normalizedKeyword && normalizedSearchText.includes(normalizedKeyword))) {
          score += 4;
          matchedTerms.push(keyword);
        }
      }
      if (phraseMatches.length > 0) {
        score += 80 + phraseMatches.length * 8;
        matchedTerms.push(...phraseMatches);
      }
      if (score === 0) continue;

      scoredMatches.push({ opcode, rawText, score, matchedTerms });
    }

    scoredMatches.sort((left, right) => right.score - left.score || left.opcode.localeCompare(right.opcode));

    for (const { opcode, rawText, score, matchedTerms } of scoredMatches) {
      if (seenOpcodes.has(opcode)) continue;

      try {
        const info = this.getBlockInfo(opcode);
        const help = this._compactBlockHelp(info);
        matches.push({
          opcode,
          dslCall: help.dslCall,
          text: rawText,
          type: help.type,
          fields: help.fields,
          inputs: help.inputs,
          substacks: help.substacks,
          example: includeExamples ? help.example : undefined,
          notes: help.notes,
          searchScore: score,
          matchedTerms,
        });
        seenOpcodes.add(opcode);
      } catch {
        matches.push({ opcode, dslCall: this._toDslCallName(opcode), text: rawText, searchScore: score, matchedTerms });
        seenOpcodes.add(opcode);
      }

      if (matches.length >= maxResults) break;
    }

    return {
      success: true,
      query,
      matchCount: matches.length,
      searchMode: matches.length > 0 ? "scored-token-phrase" : "scored-token-phrase-no-match",
      matches,
    };
  }

  private _getSingleBlockHelp(opcode: string) {
    const requested = String(opcode || "")
      .trim()
      .toLowerCase();
    if (/^(define|custom|custom[-_ ]?block|function|procedure|warp|自定义|函数)$/.test(requested)) {
      const help = this._compactBlockHelp({
        opcode: "define",
        text: "Define custom block",
        type: "hat",
        blockType: "hat",
        fields: {},
        inputs: {},
        substacks: [],
        menus: {},
      });
      return {
        success: true,
        ...help,
        notes: [
          'Use info: ["warp"] to enable run without screen refresh.',
          "Use procedures.call with $args to pass parameters.",
          "Use custom blocks for render helpers and algorithms; use broadcasts for cross-target orchestration.",
        ],
        callExample: 'procedures.call({ $mutation: { proccode: "draw bars %n %n", warp: "true" }, $args: [0, 0] });',
      };
    }

    try {
      const info = this.getBlockInfo(opcode);
      return {
        success: true,
        ...this._compactBlockHelp(info),
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Failed to read block help.",
        suggestions: this.searchBlocks({ query: opcode, maxResults: 8, includeExamples: true }).matches,
      };
    }
  }

  getBlocksHelp(options: { opcodes?: string[]; includeSuggestions?: boolean }) {
    const opcodes = Array.from(
      new Set(
        (Array.isArray(options?.opcodes) ? options.opcodes : [])
          .map((opcode) => String(opcode || "").trim())
          .filter(Boolean),
      ),
    ).slice(0, 40);
    if (!opcodes.length) {
      return { success: false, error: "getBlocksHelp requires non-empty opcodes.", blocks: [] };
    }
    const includeSuggestions = options?.includeSuggestions !== false;
    const blocks = opcodes.map((opcode) => {
      const help = this._getSingleBlockHelp(opcode);
      if (help.success || includeSuggestions) return { requested: opcode, ...help };
      const { suggestions: _suggestions, ...compact } = help as any;
      return { requested: opcode, ...compact };
    });
    return {
      success: blocks.every((block: any) => block.success),
      requestedCount: opcodes.length,
      blocks,
    };
  }

  getAllPrimitiveBlocks() {
    // Return the whole native primitive blocks directly
    const result = [];
    for (const [opcode, text] of Object.entries(AITools.AllBlockInfo)) {
      result.push({ opcode, text });
    }
    return result;
  }

  getBlockInfo(opcode: string) {
    const requestedOpcode = String(opcode ?? "").trim();
    if (!requestedOpcode) {
      throw new Error("getBlockInfo: opcode 不能为空");
    }

    const cached = this.blockInfoCache.get(requestedOpcode);
    if (cached) return clonePlainObject(cached);

    let resolvedOpcode = this._resolveOpcodeLookup(requestedOpcode);
    if (requestedOpcode.includes(".") && !this._isKnownOpcode(requestedOpcode)) {
      const fallbackOpcode = requestedOpcode.replace(/\./g, "_");
      if (fallbackOpcode !== requestedOpcode && this._isKnownOpcode(fallbackOpcode)) {
        resolvedOpcode = fallbackOpcode;
      }
    }

    const result: any = {
      opcode: resolvedOpcode,
      found: false,
      type: null,
      blockType: null,
      fields: {},
      inputs: {},
      substacks: [],
      text: null,
      tooltip: null,
      extensionId: null,
    };

    if (this.vm.runtime._primitives && this.vm.runtime._primitives[resolvedOpcode]) {
      result.found = true;
    }

    this._fillFromNativeCatalog(resolvedOpcode, result);
    this._fillFromAllBlockInfo(resolvedOpcode, result);

    if (this.vm.runtime._blockInfo) {
      for (const extInfo of this.vm.runtime._blockInfo) {
        if (extInfo.blocks) {
          for (const block of extInfo.blocks) {
            const fullOpcode = `${extInfo.id}_${block.info?.opcode}`;
            if (fullOpcode === resolvedOpcode || block.info?.opcode === resolvedOpcode) {
              result.found = true;
              result.blockType = this._normalizeBlockType(block.info?.blockType);
              result.extensionId = extInfo.id || null;
              result.text = block.info?.text || "";
              result.tooltip = this._normalizeBlockTooltip(block.info?.tooltip);
              const dynamicArgsInfo = this._summarizeDynamicArgsInfo(block.info?.dynamicArgsInfo);
              if (dynamicArgsInfo) {
                result.dynamicArgsInfo = dynamicArgsInfo;
              }
              const menuInfoSource = extInfo?.menuInfo || extInfo?.menus;

              if (block.info?.arguments) {
                for (const [argName, argInfo] of Object.entries(block.info.arguments)) {
                  const typedArg = argInfo as any;
                  const typeMeta = this._getArgumentTypeMeta(typedArg?.type);
                  const isExplicitField = typedArg?.field === true;
                  const normalized = {
                    type:
                      isExplicitField && argName === "VARIABLE"
                        ? "variable"
                        : isExplicitField && argName === "LIST"
                          ? "list"
                          : typeMeta.inferred,
                    defaultValue: typedArg?.defaultValue,
                    menu: typedArg?.menu || null,
                  };
                  if (String(argName).startsWith("SUBSTACK")) {
                    result.inputs[argName] = {
                      ...normalized,
                      type: normalized.type || "substack",
                    };
                    if (!result.substacks.includes(argName)) {
                      result.substacks.push(argName);
                    }
                  } else {
                    const menuConfig = typedArg?.menu ? menuInfoSource?.[typedArg.menu] : null;
                    const hasCoreMenuShadow = Boolean(this._getCoreMenuShadowInfo(resolvedOpcode, argName));
                    const shouldUseField = Boolean(
                      isExplicitField || typeMeta.asField || (typedArg?.menu && !menuConfig?.acceptReporters && !hasCoreMenuShadow),
                    );
                    const target = shouldUseField ? result.fields : result.inputs;
                    target[argName] = normalized;
                  }
                }
              }

              if (menuInfoSource && typeof menuInfoSource === "object") {
                const usedMenuNames = new Set<string>();
                for (const meta of Object.values(result.fields)) {
                  const menuName = (meta as any)?.menu;
                  if (typeof menuName === "string" && menuName) usedMenuNames.add(menuName);
                }
                for (const meta of Object.values(result.inputs)) {
                  const menuName = (meta as any)?.menu;
                  if (typeof menuName === "string" && menuName) usedMenuNames.add(menuName);
                }
                for (const menuName of usedMenuNames) {
                  const hasMenuConfig = !Array.isArray(menuInfoSource) ? menuInfoSource[menuName] !== undefined : false;
                  if (hasMenuConfig) {
                    // Try to find outputShape from the corresponding block json in extInfo.menus array
                    let acceptReporters = menuInfoSource[menuName]?.acceptReporters;
                    if (acceptReporters === undefined && Array.isArray(extInfo.menus)) {
                      const menuBlockType = `${extInfo.id}_menu_${menuName}`;
                      const menuBlock = extInfo.menus.find((m: any) => m.json && m.json.type === menuBlockType);
                      if (menuBlock && menuBlock.json) {
                        // outputShape 2 is round (placeable), 3 is rectangular (non_placeable)
                        if (menuBlock.json.outputShape === 2) acceptReporters = true;
                        else if (menuBlock.json.outputShape === 3) acceptReporters = false;
                      }
                    }

                    result.menus = result.menus || {};
                    result.menus[menuName] = {
                      options: this._menuConfigToOptions(menuInfoSource[menuName]),
                      menuType: acceptReporters ? "placeable" : "non_placeable",
                      sources: [],
                    };
                  }
                }
              }

              this._enrichMenuMeta(resolvedOpcode, result, menuInfoSource, this.vm.runtime);
              break;
            }
          }
        }
      }
    }

    if (result.found && !result.extensionId) {
      this._fillFromScratchBlocks(resolvedOpcode, result);
      this._promoteNativeMenuInputsToFields(resolvedOpcode, result);
      this._applyNativeSubstackFallback(resolvedOpcode, result);
      this._moveMenuInputsToFields(result);
      this._enrichMenuMeta(resolvedOpcode, result, null, this.vm.runtime);
    }

    this._moveMenuInputsToFields(result);
    this._dedupeFieldAndInputNames(result);
    this._normalizeArgumentReporterInfo(resolvedOpcode, result);

    if (!result.found) {
      if (resolvedOpcode !== requestedOpcode) {
        throw new Error(`getBlockInfo: block opcode "${requestedOpcode}" was not found; also tried "${resolvedOpcode}"`);
      }
      throw new Error(`getBlockInfo: block opcode "${requestedOpcode}" was not found`);
    }

    result.type = result.found ? result.blockType : null;
    this.blockInfoCache.set(requestedOpcode, clonePlainObject(result));
    if (resolvedOpcode !== requestedOpcode) {
      this.blockInfoCache.set(resolvedOpcode, clonePlainObject(result));
    }
    return result;
  }

  cleanUpBlocks(targetId?: string) {
    const target = targetId ? this.vm.runtime.getTargetById(targetId) : this.vm.editingTarget;
    if (!target) return false;

    const workspace = this._getWorkspace();
    if (workspace && typeof workspace.cleanUp === "function") {
      try {
        workspace.cleanUp();
        return true;
      } catch (e) {
        console.error("Cleanup error:", e);
        return false;
      }
    }
    return false;
  }

  getWorkspaceUCF(targetId?: string) {
    const target = targetId ? this.vm.runtime.getTargetById(targetId) : this.vm.editingTarget;
    if (!target) return "";

    const blocks = target.blocks?._blocks as Record<string, any>;
    if (!blocks) return "";

    const sequences = this._getTopLevelBlocks(blocks).map((block: any) =>
      this._collectStatementBlocks(blocks, block.id),
    );
    return toAnnotatedUCF(sequences, this.vm.runtime);
  }

  getCustomBlocks(targetId?: string) {
    const target = targetId ? this.vm.runtime.getTargetById(targetId) : this.vm.editingTarget;
    if (!target) return [];

    const result = [];
    for (const block of Object.values(target.blocks._blocks) as any[]) {
      if (block.opcode !== "procedures_prototype") continue;

      result.push({
        opcode: block.opcode,
        proccode: block.mutation?.proccode || "",
        argumentids: (() => {
          try {
            return JSON.parse(block.mutation?.argumentids || "[]");
          } catch {
            return [];
          }
        })(),
        argumentnames: (() => {
          try {
            return JSON.parse(block.mutation?.argumentnames || "[]");
          } catch {
            return [];
          }
        })(),
        argumentdefaults: (() => {
          try {
            return JSON.parse(block.mutation?.argumentdefaults || "[]");
          } catch {
            return [];
          }
        })(),
        warp: String(block.mutation?.warp) === "true",
        isreporter: String(block.mutation?.isreporter) === "true",
        isglobal: String(block.mutation?.isglobal) === "true",
      });
    }

    return result;
  }

  getBlocksRangeUCF(startBlockId: string, endBlockId: string) {
    return getBlocksRangeUCF(
      this.vm,
      this._getWorkspace() as Blockly.WorkspaceSvg,
      startBlockId,
      endBlockId,
    );
  }

  async replaceBlocksRangeByUCF(startBlockId: string, endBlockId: string, ucfString: string) {
    return replaceBlocksRangeByUCF(
      this.vm,
      this._getWorkspace() as Blockly.WorkspaceSvg,
      startBlockId,
      endBlockId,
      ucfString,
      { blockly: this.blockly },
    );
  }

  async replaceScriptByUCF(scriptId: string, ucfString: string) {
    return replaceScriptByUCF(this.vm, this._getWorkspace() as Blockly.WorkspaceSvg, scriptId, ucfString, {
      blockly: this.blockly,
    });
  }

  async generateCodeFromUCF(ucfString: string, targetId?: string, x?: number, y?: number) {
    const target = targetId ? this.vm.runtime.getTargetById(targetId) : this.vm.editingTarget;
    if (!target) {
      return {
        success: false,
        error: "Target not found",
      };
    }

    let newBlocks;
    try {
      newBlocks = ucfToScratch(normalizeModelUCF(ucfString), { runtime: this.vm.runtime, includeComments: true });
    } catch (e) {
      console.error("[AI Tool Call] Error parsing UCF string:", e);
      return {
        success: false,
        error: e instanceof Error ? e.message : "Failed to parse UCF string",
      };
    }

    const result = await insertScriptByUCF(
      this.vm,
      this._getWorkspace() as Blockly.WorkspaceSvg,
      target.id,
      normalizeModelUCF(ucfString),
      { includeComments: true, blockly: this.blockly },
    );

    return {
      ...result,
      ignoredPosition: x !== undefined || y !== undefined,
    };
  }
}
