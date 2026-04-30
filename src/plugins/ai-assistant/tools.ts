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
import { setGetBlockInfoTool, setRuntime } from "./converter";
import scratchBlocksCatalog from "./scratch_blocks.json";

// This file contains tools for the AI assistant to interact with Scratch.

const NativeScratchBlockCatalog: Record<string, { block: any; menus: Record<string, any> }> = (() => {
  const result: Record<string, { block: any; menus: Record<string, any> }> = {};
  const root = scratchBlocksCatalog as any;

  for (const categoryGroup of Object.values(root?.categories || {})) {
    for (const categoryInfo of Object.values(categoryGroup as Record<string, any>)) {
      const blocks = Array.isArray((categoryInfo as any)?.blocks) ? (categoryInfo as any).blocks : [];
      const menus = (categoryInfo as any)?.menus && typeof (categoryInfo as any).menus === "object" ? (categoryInfo as any).menus : {};
      for (const block of blocks) {
        const opcode = String((block as any)?.opcode || "").trim();
        if (!opcode) continue;
        result[opcode] = { block, menus };
      }
    }
  }

  return result;
})();

type VirtualFileKind = "target" | "doc";

interface VirtualFileEntry {
  path: string;
  aliases?: string[];
  kind: VirtualFileKind;
  writable: boolean;
  content: string;
  description: string;
  targetId?: string;
  targetName?: string;
  isStage?: boolean;
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
  path: string;
  hunks: string[][];
  replacementContent?: string;
  rawReplacementLines?: string[];
}

const SCRIPT_MARKER_RE = /^\/\/\s*@script\s+([^\s]+)(?:\s+.*)?$/;
const DOC_SCRATCH_AGENT_PATH = "/docs/scratch-agent.md";
const DOC_BLOCK_CATALOG_PATH = "/docs/block-catalog.md";
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
};

const normalizeVirtualPath = (path: string) => {
  const normalized = String(path || "").replace(/\\/g, "/").trim();
  if (!normalized) return "/";
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
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

const getSpriteNameFromVirtualPath = (path: string) => {
  const normalizedPath = normalizeVirtualPath(path);
  if (!normalizedPath.startsWith("/sprites/") || !normalizedPath.endsWith(".js")) return "";
  const fileName = normalizedPath.slice("/sprites/".length, -".js".length);
  if (!fileName) return "";
  const lastDotIndex = fileName.lastIndexOf(".");
  return lastDotIndex > 0 ? fileName.slice(0, lastDotIndex) : fileName;
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
  const normalizedOldLines = oldLines.map(normalizePatchContextLine);

  if (oldLines.length === 0 || normalizedOldLines.every((line) => !line)) return null;

  for (let start = 0; start <= contentLines.length - oldLines.length; start += 1) {
    let matched = true;
    for (let offset = 0; offset < oldLines.length; offset += 1) {
      if (normalizePatchContextLine(contentLines[start + offset]) !== normalizedOldLines[offset]) {
        matched = false;
        break;
      }
    }
    if (matched) {
      return { start, end: start + oldLines.length };
    }
  }

  return null;
};

const normalizeVirtualCodeForCompare = (value: string) =>
  normalizeModelUCF(value)
    .replace(/[ \t]+$/gm, "")
    .trim();

const getLineCount = (content: string) => (content ? content.split("\n").length : 1);

const buildScratchAgentDoc = () => `# Scratch Agent Virtual Files

You edit Scratch by patching virtual JavaScript files.

Workflow:
1. Call getProjectOverview.
2. Use getScratchGuide/searchBlocks/getBlockHelp for syntax and block details.
3. Call readFile only for the target you will edit.
4. Patch only the needed stable path such as /stage.js or /sprites/<name>.js with applyPatch.
5. Call getDiagnostics after edits.

Rules:
- Sprite paths are stable and name-based. Use /sprites/<name>.js from listFiles; do not invent target-id paths.
- Keep every // @script marker for existing scripts.
- Add new scripts with a unique marker such as // @script new-score-loop.
- Ordinary JS comments immediately before a block call become Scratch block comments.
- Metadata comments like // @script and // blockId are not Scratch comments.
- Use $xy on top-level scripts to control block position.
- Hat blocks accept a trailing callback: block({ $xy }, () => { ... }). This includes event.whenflagclicked and control.start_as_clone.
- Stage scripts are best for orchestration, variables, lists, broadcasts, backdrop/sound.
- Use sprite files for visual behavior that needs motion, pen drawing, clones, size, position, or speech bubbles.
- Prefer custom blocks over broadcasts for local reusable logic, algorithms, and parameterized rendering.
- Add info: ["warp"] to custom blocks that should run without screen refresh, especially full-frame pen rendering.
- Use broadcasts for cross-target orchestration; use procedures.call with $args for function-like parameter passing.
- Use $field_VARIABLE for variable selectors and $field_LIST for list selectors. Use data.variable({ $field_VARIABLE: "name" }) to read a variable value.
- Inside custom blocks, read parameters with argument.reporter_string_number({ $field_VALUE: "param" }) or argument.reporter_boolean({ $field_VALUE: "flag" }). Do not use data.variable for custom block parameters.
- Dropdown/menu selectors also use $field_ keys. For example, pen.setPenColorParamTo({ $field_COLOR_PARAM: "color", VALUE: 50 }); Valid pen COLOR_PARAM values include "color", "saturation", "brightness", "transparency".
- If you are unsure about a dropdown/menu or custom block argument, call getScratchGuide with topic "menus" or "custom-args".
- Boolean slots such as CONDITION must contain Boolean blocks. Wrap values with operator.equals/operator.gt/operator.lt instead of using data.variable directly.
- Use control.if_else for an else branch. control.if supports only SUBSTACK.
- For large programs, patch one small script at a time, run getDiagnostics, then continue.
- Preferred patch format uses @@ plus lines prefixed with space, +, or -.
- For a brand-new/empty target file, you may put the full replacement file directly after *** Update File.
- Do not wrap applyPatch content in Markdown fences.

Patch examples:
*** Begin Patch
*** Update File: /sprites/Cat.js
@@
 */
+// @script new-hello
+event.whenflagclicked({ $xy: { x: 80, y: 80 } }, () => {
+  looks.say({ MESSAGE: "Hello" });
+});
*** End Patch

DSL examples:
event.whenflagclicked({ $xy: { x: 80, y: 80 } }, () => {
  // Scratch comment attached to the next block.
  looks.say({ MESSAGE: "Hello" });
});

event.whenbroadcastreceived({ $field_BROADCAST_OPTION: "game-start", $xy: { x: 80, y: 180 } }, () => {
  looks.say({ MESSAGE: "received" });
});
control.start_as_clone({ $xy: { x: 80, y: 300 } }, () => {
  looks.show();
});

control.repeat({ TIMES: 10, SUBSTACK: () => {
  motion.movesteps({ STEPS: 5 });
} });

control.if_else({
  CONDITION: sensing.keypressed({ $field_KEY_OPTION: "space" }),
  SUBSTACK: () => { looks.say({ MESSAGE: "space" }); },
  SUBSTACK2: () => { looks.say({ MESSAGE: "waiting" }); }
});

control.repeat_until({
  CONDITION: operator.equals({ OPERAND1: data.variable({ $field_VARIABLE: "done" }), OPERAND2: 1 }),
  SUBSTACK: () => { looks.say({ MESSAGE: "looping" }); }
});

data.setvariableto({ $field_VARIABLE: "score", VALUE: 0 });
data.deletealloflist({ $field_LIST: "numbers" });
data.addtolist({ $field_LIST: "numbers", ITEM: operator.random({ FROM: 1, TO: 100 }) });
event.broadcast({ BROADCAST_INPUT: "game-start" });
pen.setPenColorParamTo({ $field_COLOR_PARAM: "color", VALUE: 50 });
pen.changePenColorParamBy({ $field_COLOR_PARAM: "brightness", VALUE: 10 });

Custom block:
define({ proccode: "jump %n[height]", info: ["warp"] }, () => {
  motion.changeyby({ DY: argument.reporter_string_number({ $field_VALUE: "height" }) });
});
procedures.call({ $mutation: { proccode: "jump %n" }, $args: [10] });

Fast render pattern:
event.whenbroadcastreceived({ $field_BROADCAST_OPTION: "render", $xy: { x: 80, y: 420 } }, () => {
  procedures.call({ $mutation: { proccode: "draw frame %n %n", warp: "true" }, $args: [0, 0] });
});
define({ proccode: "draw frame %n[left] %n[right]", info: ["warp"], $xy: { x: 80, y: 580 } }, () => {
  pen.clear();
  control.if({ CONDITION: operator.equals({ OPERAND1: data.variable({ $field_VARIABLE: "i" }), OPERAND2: argument.reporter_string_number({ $field_VALUE: "left" }) }), SUBSTACK: () => {
    pen.setPenColorToColor({ COLOR: "#ff4d4f" });
  } });
  // Draw the whole frame here.
});
`;

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

const parseCodexPatch = (patch: string): ParsedPatchUpdate[] => {
  const lines = String(patch || "").replace(/\r\n?/g, "\n").split("\n");
  const updates: ParsedPatchUpdate[] = [];
  let currentUpdate: ParsedPatchUpdate | null = null;
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
    if (currentUpdate && currentHunk && currentHunk.length > 0) {
      currentUpdate.hunks.push(currentHunk);
    }
    currentHunk = null;
  };

  const flushReplacement = () => {
    if (currentUpdate?.rawReplacementLines?.length) {
      currentUpdate.replacementContent = normalizeReplacementContent(currentUpdate.rawReplacementLines);
    }
  };

  for (const line of lines) {
    if (line === "*** Begin Patch" || line === "*** End Patch") {
      continue;
    }

    if (line.startsWith("*** Add File:") || line.startsWith("*** Delete File:")) {
      throw new Error("Virtual Scratch patches may only update existing writable files.");
    }

    if (line.startsWith("*** Update File:")) {
      flushHunk();
      flushReplacement();
      currentUpdate = {
        path: normalizeVirtualPath(line.slice("*** Update File:".length).trim()),
        hunks: [],
        rawReplacementLines: [],
      };
      updates.push(currentUpdate);
      continue;
    }

    if (line.startsWith("@@")) {
      if (!currentUpdate) {
        throw new Error("Patch hunk appears before an Update File header.");
      }
      if (currentUpdate.rawReplacementLines?.length) {
        throw new Error(`Cannot mix raw replacement content and hunk patch lines in ${currentUpdate.path}.`);
      }
      flushHunk();
      currentHunk = [];
      continue;
    }

    if (!currentUpdate) {
      if (line.trim()) {
        throw new Error(`Unexpected patch line before file header: ${line}`);
      }
      continue;
    }

    if (line.startsWith("\\ No newline at end of file")) {
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

    currentUpdate.rawReplacementLines?.push(line);
  }

  flushHunk();
  flushReplacement();

  if (updates.length === 0) {
    throw new Error("Patch contains no file updates.");
  }

  for (const update of updates) {
    if (update.hunks.length === 0 && update.replacementContent === undefined) {
      throw new Error(`Patch update for ${update.path} has no hunks or replacement content.`);
    }
  }

  return updates;
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
        throw new Error(`Patch hunk did not match current virtual file content:\n${oldText.slice(0, 500)}`);
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

export class AITools {
  static AllBlockInfo: Record<string, string> = {
    control_repeat: "重复执行 [TIMES] 次（TIMES：number）",
    control_repeat_until: "重复执行直到 [CONDITION]（CONDITION：Boolean）",
    control_while: "当 [CONDITION] 重复执行（CONDITION：Boolean）",
    control_for_each: "对 [VARIABLE] 遍历 [VALUE]（VARIABLE：string, VALUE：string）",
    control_forever: "重复执行",
    control_wait: "等待 [DURATION] 秒（DURATION：number）",
    control_wait_until: "等待直到 [CONDITION]（CONDITION：Boolean）",
    control_if: "如果 [CONDITION] 那么（CONDITION：Boolean）",
    control_if_else: "如果 [CONDITION] 那么 否则（CONDITION：Boolean）",
    control_stop: "停止 [STOP_OPTION]（STOP_OPTION：string）",
    control_start_as_clone: "当作为克隆体启动时",
    control_create_clone_of: "克隆 [CLONE_OPTION]（CLONE_OPTION：string）",
    control_delete_this_clone: "删除此克隆体",
    control_get_counter: "计数器",
    control_incr_counter: "计数器加 1",
    control_clear_counter: "计数器归零",
    control_all_at_once: "一口气执行",
    event_whenflagclicked: "当绿旗被点击",
    event_whenkeypressed: "当按下 [KEY_OPTION] 键（KEY_OPTION：string）",
    event_whenbroadcastreceived: "当接收到广播 [BROADCAST_OPTION]（BROADCAST_OPTION：broadcast）",
    event_whentouchingobject: "当碰到 [TOUCHINGOBJECTMENU]（TOUCHINGOBJECTMENU：string）",
    event_broadcast: "广播 [BROADCAST_INPUT]（BROADCAST_INPUT：string）",
    event_broadcastandwait: "广播 [BROADCAST_INPUT] 并等待（BROADCAST_INPUT：string）",
    event_whengreaterthan: "当 [WHENGREATERTHANMENU] > [VALUE]（WHENGREATERTHANMENU：string, VALUE：number）",
    looks_say: "说 [MESSAGE]（MESSAGE：string）",
    looks_sayforsecs: "说 [MESSAGE] [SECS] 秒（MESSAGE：string, SECS：number）",
    looks_think: "思考 [MESSAGE]（MESSAGE：string）",
    looks_thinkforsecs: "思考 [MESSAGE] [SECS] 秒（MESSAGE：string, SECS：number）",
    looks_show: "显示",
    looks_hide: "隐藏",
    looks_hideallsprites: "隐藏所有角色",
    looks_switchcostumeto: "换成造型 [COSTUME]（COSTUME：string）",
    looks_switchbackdropto: "换成背景 [BACKDROP]（BACKDROP：string）",
    looks_switchbackdroptoandwait: "换成背景 [BACKDROP] 并等待（BACKDROP：string）",
    looks_nextcostume: "下一个造型",
    looks_nextbackdrop: "下一个背景",
    looks_changeeffectby: "将 [EFFECT] 特效增加 [CHANGE]（EFFECT：string, CHANGE：number）",
    looks_seteffectto: "将 [EFFECT] 特效设为 [VALUE]（EFFECT：string, VALUE：number）",
    looks_cleargraphiceffects: "清除图形特效",
    looks_changesizeby: "将大小增加 [CHANGE]（CHANGE：number）",
    looks_setsizeto: "将大小设为 [SIZE]（SIZE：number）",
    looks_changestretchby: "将伸缩增加 [CHANGE]（CHANGE：number）",
    looks_setstretchto: "将伸缩设为 [STRETCH]（STRETCH：number）",
    looks_gotofrontback: "移到最 [FRONT_BACK]（FRONT_BACK：string）",
    looks_goforwardbackwardlayers: "向 [FORWARD_BACKWARD] 移动 [NUM] 层（FORWARD_BACKWARD：string, NUM：number）",
    looks_size: "大小",
    looks_costumenumbername: "造型 [NUMBER_NAME]（NUMBER_NAME：string）",
    looks_backdropnumbername: "背景 [NUMBER_NAME]（NUMBER_NAME：string）",
    motion_movesteps: "移动 [STEPS] 步（STEPS：number）",
    motion_movegrids: "移动 [STEPS] 格（STEPS：number）",
    motion_gotoxy: "移到 x:[X] y:[Y]（X：number, Y：number）",
    motion_goto: "移到 [TO]（TO：string）",
    motion_turnright: "右转 [DEGREES] 度（DEGREES：number）",
    motion_turnleft: "左转 [DEGREES] 度（DEGREES：number）",
    motion_pointindirection: "面向 [DIRECTION] 度（DIRECTION：number）",
    motion_pointtowards: "面向 [TOWARDS]（TOWARDS：string）",
    motion_glidesecstoxy: "在 [SECS] 秒内滑行到 x:[X] y:[Y]（SECS：number, X：number, Y：number）",
    motion_glideto: "在 [SECS] 秒内滑行到 [TO]（SECS：number, TO：string）",
    motion_ifonedgebounce: "碰到边缘就反弹",
    motion_setrotationstyle: "将旋转方式设为 [STYLE]（STYLE：string）",
    motion_changexby: "将 x 增加 [DX]（DX：number）",
    motion_setx: "将 x 设为 [X]（X：number）",
    motion_changeyby: "将 y 增加 [DY]（DY：number）",
    motion_sety: "将 y 设为 [Y]（Y：number）",
    motion_xposition: "x 坐标",
    motion_yposition: "y 坐标",
    motion_direction: "方向",
    motion_scroll_right: "向右滚动 [DISTANCE]（DISTANCE：number）",
    motion_scroll_up: "向上滚动 [DISTANCE]（DISTANCE：number）",
    motion_align_scene: "对齐场景 [ALIGNMENT]（ALIGNMENT：string）",
    motion_xscroll: "场景 x 滚动",
    motion_yscroll: "场景 y 滚动",
    operator_add: "[NUM1] + [NUM2]（NUM1：number, NUM2：number）",
    operator_subtract: "[NUM1] - [NUM2]（NUM1：number, NUM2：number）",
    operator_multiply: "[NUM1] * [NUM2]（NUM1：number, NUM2：number）",
    operator_divide: "[NUM1] / [NUM2]（NUM1：number, NUM2：number）",
    operator_lt: "[OPERAND1] < [OPERAND2]（OPERAND1：null, OPERAND2：null）",
    operator_equals: "[OPERAND1] = [OPERAND2]（OPERAND1：null, OPERAND2：null）",
    operator_gt: "[OPERAND1] > [OPERAND2]（OPERAND1：null, OPERAND2：null）",
    operator_and: "[OPERAND1] 且 [OPERAND2]（OPERAND1：Boolean, OPERAND2：Boolean）",
    operator_or: "[OPERAND1] 或 [OPERAND2]（OPERAND1：Boolean, OPERAND2：Boolean）",
    operator_not: "不成立 [OPERAND]（OPERAND：Boolean）",
    operator_random: "在 [FROM] 到 [TO] 之间取随机数（FROM：number, TO：number）",
    operator_join: "连接 [STRING1] 和 [STRING2]（STRING1：string, STRING2：string）",
    operator_letter_of: "[STRING] 的第 [LETTER] 个字符（STRING：string, LETTER：number）",
    operator_length: "[STRING] 的长度（STRING：string）",
    operator_contains: "[STRING1] 包含 [STRING2]？（STRING1：string, STRING2：string）",
    operator_mod: "[NUM1] 除以 [NUM2] 的余数（NUM1：number, NUM2：number）",
    operator_round: "四舍五入 [NUM]（NUM：number）",
    operator_mathop: "[OPERATOR] [NUM]（OPERATOR：string, NUM：number）",
    sound_play: "播放声音 [SOUND_MENU]（SOUND_MENU：string）",
    sound_playuntildone: "播放声音 [SOUND_MENU] 等待播放完成（SOUND_MENU：string）",
    sound_stopallsounds: "停止所有声音",
    sound_seteffectto: "将 [EFFECT] 音效设为 [VALUE]（EFFECT：string, VALUE：number）",
    sound_changeeffectby: "将 [EFFECT] 音效增加 [VALUE]（EFFECT：string, VALUE：number）",
    sound_cleareffects: "清除音效",
    sound_sounds_menu: "声音 [SOUND_MENU]（SOUND_MENU：string）",
    sound_beats_menu: "节拍 [BEATS]（BEATS：number）",
    sound_effects_menu: "音效 [EFFECT]（EFFECT：string）",
    sound_setvolumeto: "将音量设为 [VOLUME]（VOLUME：number）",
    sound_changevolumeby: "将音量增加 [VOLUME]（VOLUME：number）",
    sound_volume: "音量",
    sensing_touchingobject: "碰到 [TOUCHINGOBJECTMENU]？（TOUCHINGOBJECTMENU：string）",
    sensing_touchingcolor: "碰到颜色 [COLOR]？（COLOR：string）",
    sensing_coloristouchingcolor: "颜色 [COLOR] 碰到 [COLOR2]？（COLOR：string, COLOR2：string）",
    sensing_distanceto: "到 [DISTANCETOMENU] 的距离（DISTANCETOMENU：string）",
    sensing_timer: "计时器",
    sensing_resettimer: "计时器归零",
    sensing_of: "[OBJECT] 的 [PROPERTY]（OBJECT：string, PROPERTY：string）",
    sensing_mousex: "鼠标 x",
    sensing_mousey: "鼠标 y",
    sensing_setdragmode: "将拖动方式设为 [DRAG_MODE]（DRAG_MODE：string）",
    sensing_mousedown: "鼠标按下？",
    sensing_keypressed: "按下 [KEY_OPTION] 键？（KEY_OPTION：string）",
    sensing_current: "当前 [CURRENTMENU]（CURRENTMENU：string）",
    sensing_dayssince2000: "距 2000 年的天数",
    sensing_loudness: "响度",
    sensing_loud: "响吗？",
    sensing_askandwait: "询问 [QUESTION] 并等待（QUESTION：string）",
    sensing_answer: "回答",
    sensing_username: "用户名",
    sensing_userid: "用户 id",
    data_variable: "变量 [VARIABLE]（VARIABLE：variable）",
    data_setvariableto: "将 [VARIABLE] 设为 [VALUE]（VARIABLE：variable, VALUE：string）",
    data_changevariableby: "将 [VARIABLE] 增加 [VALUE]（VARIABLE：variable, VALUE：number）",
    data_hidevariable: "隐藏变量 [VARIABLE]（VARIABLE：variable）",
    data_showvariable: "显示变量 [VARIABLE]（VARIABLE：variable）",
    data_listcontents: "列表 [LIST]（LIST：list）",
    data_addtolist: "将 [ITEM] 加入列表 [LIST]（ITEM：string, LIST：list）",
    data_deleteoflist: "删除列表 [LIST] 的第 [INDEX] 项（LIST：list, INDEX：string）",
    data_deletealloflist: "删除列表 [LIST] 的全部项目（LIST：list）",
    data_insertatlist: "在列表 [LIST] 的第 [INDEX] 项前插入 [ITEM]（LIST：list, INDEX：string, ITEM：string）",
    data_replaceitemoflist: "将列表 [LIST] 的第 [INDEX] 项替换为 [ITEM]（LIST：list, INDEX：string, ITEM：string）",
    data_itemoflist: "列表 [LIST] 的第 [INDEX] 项（LIST：list, INDEX：string）",
    data_itemnumoflist: "[ITEM] 在列表 [LIST] 中的编号（ITEM：string, LIST：list）",
    data_lengthoflist: "列表 [LIST] 的长度（LIST：list）",
    data_listcontainsitem: "列表 [LIST] 包含 [ITEM]？（LIST：list, ITEM：string）",
    data_hidelist: "隐藏列表 [LIST]（LIST：list）",
    data_showlist: "显示列表 [LIST]（LIST：list）",
    procedures_definition: "自定义积木定义",
    procedures_call: "调用自定义积木 [PROCEDURE]（PROCEDURE：string）",
    procedures_call_with_return: "调用自定义积木 [PROCEDURE] 并返回（PROCEDURE：string）",
  };

  static BlockSearchAliases: Record<string, string[]> = {
    event_whenflagclicked: ["当绿旗被点击", "绿旗", "开始", "启动"],
    event_whenbroadcastreceived: ["当接收到广播", "接收到广播", "收到广播", "广播触发"],
    event_broadcast: ["广播", "发送广播", "广播消息"],
    event_broadcastandwait: ["广播并等待", "发送广播并等待"],
    operator_lt: ["小于", "less", "operator.less", "operator.lt", "<"],
    operator_gt: ["大于", "greater", "operator.greater", "operator.gt", ">"],
    operator_equals: ["等于", "equal", "operator.equal", "operator.equals", "=="],
    pen_penDown: ["落笔", "下笔", "pen.down", "pen.penDown", "pen_penDown"],
    pen_penUp: ["抬笔", "停笔", "pen.up", "pen.penUp", "pen_penUp"],
    argument_reporter_string_number: [
      'argument.reporter_string_number({ $field_VALUE: "highlight" })',
      "自定义积木参数",
      "读取函数参数",
      "custom block argument reporter",
      "$field_VALUE",
    ],
    argument_reporter_boolean: [
      'argument.reporter_boolean({ $field_VALUE: "enabled" })',
      "自定义积木布尔参数",
      "读取布尔函数参数",
      "$field_VALUE",
    ],
    pen_setPenColorParamTo: [
      'pen.setPenColorParamTo({ $field_COLOR_PARAM: "color", VALUE: 50 })',
      "将笔的颜色/饱和度/亮度/透明度设为",
      "COLOR_PARAM menu values: color, saturation, brightness, transparency",
      "$field_COLOR_PARAM",
    ],
    pen_changePenColorParamBy: [
      'pen.changePenColorParamBy({ $field_COLOR_PARAM: "brightness", VALUE: 10 })',
      "将笔的颜色/饱和度/亮度/透明度增加",
      "COLOR_PARAM menu values: color, saturation, brightness, transparency",
      "$field_COLOR_PARAM",
    ],
    procedures_definition: ["自定义积木定义", "定义积木", "定义函数"],
    procedures_call: ["调用自定义积木", "调用函数", "执行自定义积木"],
    procedures_call_with_return: ["调用自定义积木并返回", "返回值积木", "返回值函数"],
  };

  vm: any;

  constructor(vm: any) {
    this.vm = vm;
    if (vm && vm.runtime) {
      setRuntime(vm.runtime);
      repairListVariableValues(vm);
    }
    setGetBlockInfoTool((opcode: string) => this.getBlockInfo(opcode));
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
      const name = sanitizePathSegment(this._getTargetName(target), "sprite");
      nameCounts.set(name, (nameCounts.get(name) || 0) + 1);
    });

    const pathByTargetId = new Map<string, string>();
    targets.forEach((target) => {
      if (!target?.id) return;
      if (target.isStage) {
        pathByTargetId.set(target.id, "/stage.js");
        return;
      }

      const name = sanitizePathSegment(this._getTargetName(target), "sprite");
      const index = (nameSeen.get(name) || 0) + 1;
      nameSeen.set(name, index);
      const suffix = (nameCounts.get(name) || 0) > 1 ? `.${index}` : "";
      pathByTargetId.set(target.id, `/sprites/${name}${suffix}.js`);
    });

    return pathByTargetId;
  }

  private _getVirtualPathForTarget(target: any, pathByTargetId?: Map<string, string>) {
    if (target?.id && pathByTargetId?.has(target.id)) {
      return pathByTargetId.get(target.id) || "/stage.js";
    }
    if (target?.isStage) return "/stage.js";
    const name = sanitizePathSegment(this._getTargetName(target), "sprite");
    return `/sprites/${name}.js`;
  }

  private _getVirtualPathAliasesForTarget(target: any, canonicalPath: string) {
    if (target?.isStage) return [];

    const name = sanitizePathSegment(this._getTargetName(target), "sprite");
    const aliases = new Set<string>();
    [target?.id, target?.originalTargetId].filter(Boolean).forEach((id) => {
      aliases.add(`/sprites/${name}.${sanitizePathSegment(String(id), "target")}.js`);
    });
    aliases.delete(canonicalPath);
    return [...aliases];
  }

  private _getCommentsByBlockId(target: any) {
    const commentsByBlockId: Record<string, any> = {};
    Object.values(target?.comments || {}).forEach((comment: any) => {
      if (!comment?.blockId || typeof comment.text !== "string" || !comment.text.trim()) return;
      commentsByBlockId[comment.blockId] = comment;
    });
    return commentsByBlockId;
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

  private _buildTargetVirtualFile(target: any, virtualPath?: string) {
    const blocks = target?.blocks?._blocks as Record<string, any>;
    const commentsByBlockId = this._getCommentsByBlockId(target);
    const header = [
      "/* @scratch-target",
      `path: ${virtualPath || this._getVirtualPathForTarget(target)}`,
      `targetId: ${target.id}`,
      `targetName: ${this._getTargetName(target)}`,
      `targetType: ${target.isStage ? "stage" : "sprite"}`,
      "This is a virtual Scratch file. Edit with applyPatch and keep // @script markers.",
      "*/",
      "",
    ].join("\n");

    if (!blocks) {
      return header.trimEnd();
    }

    const sections = this._getTargetTopBlocks(target).map((topBlock: any) => {
      const { statementBlockIds, blocks: scriptBlocks } = this._collectStatementBlocks(blocks, topBlock.id);
      const code = scratchToUCF(scriptBlocks, {
        runtime: this.vm.runtime,
        includeBlockIds: true,
        includePosition: true,
        commentsByBlockId,
      });
      return [`// @script ${topBlock.id} ${topBlock.opcode || ""}`, code].join("\n");
    });

    return `${header}${sections.join("\n\n")}`.trimEnd();
  }

  private _getScratchAgentGuideEntry(): VirtualFileEntry {
    return {
      path: DOC_SCRATCH_AGENT_PATH,
      kind: "doc",
      writable: false,
      description: "Codex-style Scratch JS DSL and virtual file editing guide.",
      content: buildScratchAgentDoc().trimEnd(),
    };
  }

  private _getBlockCatalogEntry(): VirtualFileEntry {
    const blockLines = Object.entries(this._getAllBlockIds())
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([opcode, text]) => {
        const aliases = AITools.BlockSearchAliases[opcode] || [];
        const aliasText = aliases.length > 0 ? `；用法/别名：${aliases.join("；")}` : "";
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

  private _getVirtualFiles() {
    repairListVariableValues(this.vm);
    const targets = Array.isArray(this.vm.runtime?.targets) ? this.vm.runtime.targets : [];
    const pathByTargetId = this._getVirtualPathMapForTargets(targets);
    const entries: VirtualFileEntry[] = targets.map((target: any) => {
      const path = this._getVirtualPathForTarget(target, pathByTargetId);
      return {
        path,
        aliases: this._getVirtualPathAliasesForTarget(target, path),
        kind: "target",
        writable: true,
        targetId: target.id,
        targetName: this._getTargetName(target),
        isStage: Boolean(target.isStage),
        description: `${target.isStage ? "Stage" : "Sprite"} scripts for ${this._getTargetName(target)}`,
        content: this._buildTargetVirtualFile(target, path),
      };
    });

    return [...entries, this._getScratchAgentGuideEntry(), this._getBlockCatalogEntry()];
  }

  private _findVirtualFileEntry(entries: VirtualFileEntry[], path: string) {
    const normalizedPath = normalizeVirtualPath(path);
    const exact = entries.find((entry) => entry.path === normalizedPath || entry.aliases?.includes(normalizedPath));
    if (exact) return exact;

    const requestedSpriteName = getSpriteNameFromVirtualPath(normalizedPath);
    if (requestedSpriteName) {
      const matches = entries.filter((entry) => {
        if (entry.kind !== "target" || entry.isStage) return false;
        const stableName = sanitizePathSegment(entry.targetName || "", "sprite");
        return stableName === requestedSpriteName;
      });
      if (matches.length === 1) {
        return matches[0];
      }
    }

    return null;
  }

  private _getVirtualFile(path: string) {
    return this._findVirtualFileEntry(this._getVirtualFiles(), path);
  }

  private _getTopLevelBlocks(blocks: Record<string, any>) {
    return Object.values(blocks).filter((block: any) => block?.topLevel && !block?.parent);
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
    if (name === "ITEM") return 'operator.random({ FROM: 1, TO: 100 })';
    if (name === "INDEX") return 'data.variable({ $field_VARIABLE: "i" })';
    if (name === "VALUE" && inputMeta?.menu) return `"${this._sampleFieldValue(name, inputMeta)}"`;
    if (type.includes("number") || type === "n" || /^(X|Y|DX|DY|STEPS|TIMES|DURATION|SECS|SIZE|VALUE|NUM|NUM1|NUM2|FROM|TO)$/.test(name)) {
      return "10";
    }
    return '"value"';
  }

  private _buildBlockUsage(info: any) {
    const opcode = String(info?.opcode || "");
    if (opcode === "define" || opcode === "procedures_definition") {
      return [
        'define({ proccode: "draw bars %n[highlight1] %n[highlight2]", info: ["warp"], $xy: { x: 80, y: 360 } }, () => {',
        '  pen.clear();',
        '  data.setvariableto({ $field_VARIABLE: "i", VALUE: 1 });',
        '  control.repeat({ TIMES: data.lengthoflist({ $field_LIST: "numbers" }), SUBSTACK: () => {',
        '    // Draw one bar here. Warp makes the whole render finish in one frame.',
        '    data.changevariableby({ $field_VARIABLE: "i", VALUE: 1 });',
        '  } });',
        '});',
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
          use: String(name).startsWith("SUBSTACK") ? `${name}: () => { ... }` : name,
        },
      ]),
    );
    const notes = [];
    const type = String(info?.type || info?.blockType || "").toLowerCase();
    if (type === "hat" || type.includes("hat")) {
      notes.push("Hat blocks accept a trailing callback: block({ $xy }, () => { ... });");
    }
    if (info?.opcode === "procedures_definition") {
      notes.push('Prefer the define(...) DSL helper for custom blocks. Add info: ["warp"] for run-without-screen-refresh rendering/math helpers.');
    }
    if (info?.opcode === "procedures_call") {
      notes.push('Call custom blocks with procedures.call({ $mutation: { proccode: "...", warp: "true" }, $args: [...] }).');
    }
    if (info?.opcode === "argument_reporter_string_number" || info?.opcode === "argument_reporter_boolean") {
      notes.push('Use only inside define(...). VALUE is the custom block parameter name and must be written as $field_VALUE.');
      notes.push("Do not read custom block parameters with data.variable; that creates/reads a global variable instead.");
    }
    if (Object.keys(fields).length > 0) {
      notes.push("Menu/dropdown/variable/list selectors use $field_ keys.");
    }
    if (Object.keys(inputs).some((name) => name === "CONDITION")) {
      notes.push("CONDITION must be a Boolean reporter such as operator.equals/operator.gt/operator.lt.");
    }
    return {
      opcode: info?.opcode,
      dslCall: this._toDslCallName(info?.opcode),
      text: info?.text,
      type: info?.type || info?.blockType,
      fields,
      inputs,
      substacks: info?.substacks || [],
      menus: info?.menus || {},
      example: this._buildBlockUsage(info),
      notes,
    };
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
      inputName === "CONDITION" ||
      type === "boolean" ||
      type === "bool" ||
      type === "b" ||
      type.includes("boolean")
    );
  }

  private _isValidColorLiteral(value: any) {
    const text = String(value ?? "").trim();
    return /^#[0-9a-f]{6}$/i.test(text) || /^#[0-9a-f]{3}$/i.test(text);
  }

  private _isInternalShadowOpcode(opcode: any) {
    const normalized = String(opcode || "");
    return (
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
    return section.startLine + String(section.code || "").slice(0, Math.max(0, index)).split("\n").length - 1;
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
        `\\bdata(?:\\.|_)variable\\s*\\(\\s*\\{[^}]*\\$field_VARIABLE\\s*:\\s*(["'\`])${escapeRegExp(
          argumentName,
        )}\\1`,
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
          hint:
            'Many one-letter/generated-looking data names exist. Prefer meaningful names and use custom block parameters via argument.reporter_string_number({ $field_VALUE: "param" }) instead of creating variables for parameters.',
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

      for (const [fieldName, fieldMeta] of Object.entries(blockInfo.fields || {})) {
        const meta = fieldMeta as any;
        if (!meta?.menu && !meta?.menuType) continue;
        if (block.fields?.[fieldName] || block.inputs?.[fieldName]) continue;
        errors.push({
          line: section.startLine,
          scriptId: section.scriptId,
          blockId: block.id,
          opcode: block.opcode,
          message: `Missing menu field ${fieldName}. Use $field_${fieldName}, for example { $field_${fieldName}: ${JSON.stringify(meta.defaultValue ?? meta.menuOptions?.[0]?.value ?? "")} }.`,
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
        if (colorBlock?.opcode === "math_number" || (fieldValue !== undefined && !this._isValidColorLiteral(fieldValue))) {
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

  private async _insertScriptByUCF(targetId: string, ucfString: string) {
    return insertScriptByUCF(this.vm, window.Blockly.getMainWorkspace() as Blockly.WorkspaceSvg, targetId, ucfString, {
      includeComments: true,
    });
  }

  private async _restoreProjectSnapshot(snapshot: string) {
    if (!snapshot || typeof this.vm?.loadProject !== "function") return;
    try {
      await this.vm.loadProject(JSON.parse(snapshot));
    } catch (error) {
      console.error("[AI Assistant VFS] Failed to rollback project snapshot", error);
    }
  }

  private _formatSyncFailure(action: string, scriptId: string, result: any) {
    const details = {
      stage: result?.stage,
      diagnostics: result?.diagnostics,
    };
    const detailText = Object.values(details).some(Boolean) ? ` ${JSON.stringify(details).slice(0, 800)}` : "";
    return `${action} script ${scriptId}: ${result?.error || "unknown error"}.${detailText}`;
  }

  private async _syncVirtualTargetFile(entry: VirtualFileEntry, oldContent: string, newContent: string) {
    const oldSections = extractVirtualScriptSections(oldContent);
    const newSections = extractVirtualScriptSections(newContent);
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
          window.Blockly.getMainWorkspace() as Blockly.WorkspaceSvg,
          operation.oldSection.scriptId,
          operation.section.code,
          {
            includeComments: true,
          },
        );
        if (!result.success) {
          throw new Error(this._formatSyncFailure("Failed to replace", operation.oldSection.scriptId, result));
        }
        results.push({ type: "replace", scriptId: operation.oldSection.scriptId, result });
      } else if (operation.type === "delete") {
        const result: any = await deleteScriptById(
          this.vm,
          window.Blockly.getMainWorkspace() as Blockly.WorkspaceSvg,
          operation.section.scriptId,
        );
        if (!result.success) {
          throw new Error(this._formatSyncFailure("Failed to delete", operation.section.scriptId, result));
        }
        results.push({ type: "delete", scriptId: operation.section.scriptId, result });
      } else if (operation.type === "insert") {
        const result: any = await this._insertScriptByUCF(entry.targetId || "", operation.section.code);
        if (!result.success) {
          throw new Error(this._formatSyncFailure("Failed to insert", operation.section.scriptId, result));
        }
        results.push({ type: "insert", scriptId: operation.section.scriptId, result });
      }
    }

    return {
      path: entry.path,
      targetId: entry.targetId,
      operationCount: results.length,
      operations: results,
    };
  }

  listFiles() {
    return this._getVirtualFiles().map((entry) => ({
      path: entry.path,
      aliases: entry.aliases,
      kind: entry.kind,
      writable: entry.writable,
      targetId: entry.targetId,
      targetName: entry.targetName,
      isStage: entry.isStage,
      description: entry.description,
      lineCount: getLineCount(entry.content),
      size: entry.content.length,
    }));
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
      startLine: start,
      endLine: end,
      totalLines: lines.length,
      content: lines.slice(start - 1, end).join("\n"),
    };
  }

  searchFiles(options?: { query?: string; path?: string; maxResults?: number }) {
    const query = String(options?.query || "").trim().toLowerCase();
    if (!query) {
      return {
        success: false,
        error: "searchFiles requires a non-empty query.",
      };
    }

    const maxResults = Math.max(1, Math.min(200, Number(options?.maxResults || 50)));
    const allEntries = this._getVirtualFiles();
    const requestedEntry = options?.path ? this._findVirtualFileEntry(allEntries, options.path) : null;
    if (options?.path && !requestedEntry) {
      return {
        success: false,
        error: `Virtual file not found: ${options.path}`,
      };
    }
    const entries = requestedEntry ? [requestedEntry] : allEntries;
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

  getDiagnostics(path?: string) {
    const requestedEntry = path ? this._getVirtualFile(path) : null;
    if (path && !requestedEntry) {
      return {
        success: false,
        valid: false,
        error: `Virtual file not found: ${path}`,
        diagnostics: [],
      };
    }

    const entries = path ? [requestedEntry as VirtualFileEntry] : this._getVirtualFiles();
    const diagnostics = entries.map((entry) => {
      if (!entry) return null;
      if (entry.kind !== "target") {
        return {
          path: entry.path,
          valid: true,
          readOnly: true,
          errors: [],
        };
      }
      return this._validateVirtualTargetFile(entry, entry.content);
    });
    const filteredDiagnostics = diagnostics.filter(Boolean);
    const valid = filteredDiagnostics.every((item: any) => item.valid);

    return {
      success: valid,
      valid,
      diagnostics: filteredDiagnostics,
    };
  }

  async applyPatch(patch: string) {
    const updates = parseCodexPatch(patch);
    const entries = this._getVirtualFiles();
    const nextContentByPath = new Map(entries.map((entry) => [entry.path, entry.content]));
    const resolvedUpdates: Array<{ update: ParsedPatchUpdate; entry: VirtualFileEntry }> = [];

    for (const update of updates) {
      const entry = this._findVirtualFileEntry(entries, update.path);
      if (!entry) {
        return {
          success: false,
          error: `Virtual file not found: ${update.path}. Call listFiles and use the stable path such as /stage.js or /sprites/<name>.js.`,
        };
      }
      if (!entry.writable) {
        return {
          success: false,
          error: `Virtual file is read-only: ${update.path}`,
        };
      }
      resolvedUpdates.push({ update, entry });

      try {
        nextContentByPath.set(
          entry.path,
          update.replacementContent !== undefined
            ? update.replacementContent
            : applyTextHunks(nextContentByPath.get(entry.path) || "", update.hunks),
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
      .map(({ entry }) => entry)
      .filter((entry, index, array) => array.findIndex((item) => item.path === entry.path) === index)
      .filter((entry) => entry.content !== nextContentByPath.get(entry.path));
    const validationResults = changedEntries.map((entry) =>
      this._validateVirtualTargetFile(entry, nextContentByPath.get(entry.path) || ""),
    );
    const invalidValidation = validationResults.find((item) => !item.valid);
    if (invalidValidation) {
      return {
        success: false,
        error: "Patched virtual file has diagnostics errors. No Scratch blocks were changed.",
        diagnostics: validationResults,
      };
    }

    const snapshot = typeof this.vm?.toJSON === "function" ? this.vm.toJSON() : "";
    const syncResults = [];

    try {
      for (const entry of changedEntries) {
        const result = await this._syncVirtualTargetFile(entry, entry.content, nextContentByPath.get(entry.path) || "");
        syncResults.push(result);
      }
    } catch (error) {
      await this._restoreProjectSnapshot(snapshot);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Failed to apply virtual file changes",
        rolledBack: Boolean(snapshot),
        syncResults,
      };
    }

    const scriptOperationCount = syncResults.reduce((sum, item) => sum + item.operationCount, 0);
    if (changedEntries.length > 0 && scriptOperationCount === 0) {
      return {
        success: false,
        error:
          "Patch changed virtual file text but did not add, delete, or modify any // @script sections. Header-only changes are ignored.",
        changedFiles: changedEntries.map((entry) => entry.path),
        syncResults,
        diagnostics: validationResults,
      };
    }

    return {
      success: true,
      changedFiles: changedEntries.map((entry) => entry.path),
      fileCount: changedEntries.length,
      scriptOperationCount,
      syncResults,
      diagnostics: validationResults,
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
      ucf: toAnnotatedUCF([
        {
          blocks: scriptBlocks,
          statementBlockIds: scriptBlockIds,
        },
      ], this.vm.runtime),
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
    const result = [];
    if (this.vm.runtime._blockInfo) {
      for (const extInfo of this.vm.runtime._blockInfo) {
        result.push({
          id: extInfo.id,
          name: extInfo.name,
        });
      }
    }
    return result;
  }

  getExtensionBlocks(extensionId: string) {
    const result = [];
    if (this.vm.runtime._blockInfo) {
      for (const extInfo of this.vm.runtime._blockInfo) {
        if (extInfo.id === extensionId && extInfo.blocks) {
          for (const block of extInfo.blocks) {
            if (block.info) {
              result.push({
                opcode: `${extInfo.id}_${block.info.opcode}`,
                text: block.info.text,
                blockType: block.info.blockType,
                arguments: block.info.arguments || {},
              });
            }
          }
        }
      }
    }
    return result;
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
                  args.push(`${argName}：${(argInfo as any).type}`);
                }
              }
              const argsStr = args.length > 0 ? `（${args.join(", ")}）` : "";
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
        ? "自定义积木布尔参数 [VALUE]（VALUE：parameter name）"
        : "自定义积木参数 [VALUE]（VALUE：parameter name）";
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

    const argumentsMap = entry.block?.arguments && typeof entry.block.arguments === "object" ? entry.block.arguments : {};
    for (const [argName, argInfo] of Object.entries(argumentsMap)) {
      const typedArg = argInfo as any;
      const typeMeta = this._getArgumentTypeMeta(typedArg?.type);
      const normalized = {
        type: typeMeta.inferred,
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

      const shouldUseField = Boolean(typedArg?.menu || typeMeta.asField);
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
      menuNameByNormalizedName.set(String(menuName).replace(/[^a-z0-9]/gi, "").toLowerCase(), menuName);
    });
    const placeholderNames = [...String(entry.block?.text || "").matchAll(/\[([A-Z0-9_]+)\]/g)].map((match) => match[1]);
    placeholderNames.forEach((argName) => {
      if (result.fields[argName] || result.inputs[argName]) return;
      const normalizedArgName = String(argName).replace(/[^a-z0-9]/gi, "").toLowerCase();
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
      const shouldUseField = Boolean(menuName && menuConfig && !menuConfig.acceptReporters);
      const target = shouldUseField ? result.fields : result.inputs;
      target[argName] = meta;
    });
  }

  private _hasMenuShadowBlock(opcode: string, menuName: string, activeRuntime: any) {
    const namespace = String(opcode || "").includes("_") ? String(opcode).split("_")[0] : "";
    const candidates = [`${opcode}_menu`, namespace ? `${namespace}_menu_${menuName}` : "", menuName, `${menuName}_menu`].filter(Boolean);
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
    const scratchBlocks =
      activeRuntime?.scratchBlocks || (window as any)?.Blockly || (window as any)?.ScratchBlocks;
    if (!scratchBlocks?.Blocks) return null;

    const namespace = String(opcode || "").includes("_") ? String(opcode).split("_")[0] : "";
    const candidates = [`${opcode}_menu`, namespace ? `${namespace}_menu_${menuName}` : "", menuName, `${menuName}_menu`].filter(
      (candidate) => scratchBlocks.Blocks[candidate],
    );
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
      const menuName = typeof (inputMeta as any)?.menu === "string" ? (inputMeta as any).menu : null;
      if (!menuName || result.substacks.includes(inputName)) {
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
      const existingMenuType = typeof entry.menuType === "string" ? entry.menuType : null;
      const fromExt = this._menuConfigToOptions(extMenus?.[menuName]);
      const fromShadow = this._readMenuOptionsFromShadowBlock(opcode, menuName, activeRuntime);
      const menuOptions = existingOptions || fromExt || fromShadow || null;
      const placeable =
        existingMenuType === "placeable" ||
        (existingMenuType !== "non_placeable" &&
          (sourceType === "input" || this._hasMenuShadowBlock(opcode, menuName, activeRuntime)));

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
        if (menuSummary[menuName].menuType !== "placeable" && entry.menuType === "placeable") {
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

    const matches = [...text.matchAll(/[（(]([^）)]*)[）)]/g)];
    if (matches.length === 0) return;
    const inside = String(matches[matches.length - 1]?.[1] ?? "").trim();
    if (!inside) return;

    const parts = inside.split(/[，,]/).map((x) => x.trim()).filter(Boolean);
    for (const part of parts) {
      const kv = part.split(/[：:]/);
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
    const files = this._getVirtualFiles().filter((entry) => entry.kind === "target");
    const pathByTargetId = new Map(files.map((entry) => [entry.targetId, entry.path]));
    const health = this._getDataHealth(targets, pathByTargetId, listRepairs);

    return {
      success: true,
      files: files.map((entry) => {
        const sections = extractVirtualScriptSections(entry.content);
        return {
          path: entry.path,
          targetId: entry.targetId,
          targetName: entry.targetName,
          isStage: entry.isStage,
          lineCount: getLineCount(entry.content),
          scriptCount: sections.length,
          scripts: sections.map((section) => ({
            scriptId: section.scriptId,
            line: section.markerLine,
            preview: section.code
              .split("\n")
              .map((line) => line.trim())
              .find((line) => line && !line.startsWith("//")),
          })),
        };
      }),
      data: targets.map((target: any) => {
        const values = Object.values(target?.variables || {}) as any[];
        return {
          path: pathByTargetId.get(target?.id) || this._getVirtualPathForTarget(target),
          targetName: this._getTargetName(target),
          variables: values
            .filter((item) => !Array.isArray(item?.value) && item?.type !== "list")
            .map((item) => ({
              id: item.id,
              name: item.name,
              value: item.value,
              isCloud: Boolean(item.isCloud),
            })),
          lists: values
            .filter((item) => Array.isArray(item?.value) || item?.type === "list")
            .map((item) => ({
              id: item.id,
              name: item.name,
              length: Array.isArray(item.value) ? item.value.length : 0,
              preview: Array.isArray(item.value) ? item.value.slice(0, 10) : [],
          })),
        };
      }),
      health,
      nextSteps: [
        "Use getScratchGuide for concise DSL patterns.",
        "Use searchBlocks for candidate opcodes.",
        "Use getBlockHelp before writing unfamiliar blocks.",
        'For rendering, algorithms, or reusable parameterized logic, use getScratchGuide({ topic: "procedures" }) and prefer warp custom blocks over broadcast-only flows.',
      ],
    };
  }

  getScratchGuide(topic?: string) {
    const requestedTopic = String(topic || "quickstart").trim().toLowerCase();
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
      menu: "menus",
      dropdown: "menus",
      fields: "menus",
      debug: "debugging",
      diagnostics: "debugging",
      render: "rendering",
      drawing: "rendering",
      draw: "rendering",
    };
    const normalizedTopic = topicAliases[requestedTopic] || requestedTopic;
    const guides: Record<string, any> = {
      quickstart: {
        title: "Scratch JS DSL quickstart",
        rules: [
          "Patch /stage.js or /sprites/<name>.js with applyPatch.",
          "Every // @script section must produce exactly one top-level script.",
          "Hat blocks use a trailing callback: event.whenflagclicked({ $xy }, () => { ... });",
          "C-block bodies use SUBSTACK/SUBSTACK2 arrow functions.",
          "Menus, variables, and lists use $field_ keys.",
          'Inside custom blocks, parameters are read with argument.reporter_string_number({ $field_VALUE: "param" }), not data.variable.',
        ],
        examples: [
          'event.whenflagclicked({ $xy: { x: 80, y: 80 } }, () => { looks.say({ MESSAGE: "hello" }); });',
          'control.repeat({ TIMES: 10, SUBSTACK: () => { motion.movesteps({ STEPS: 5 }); } });',
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
          'control.start_as_clone({ $xy: { x: 80, y: 500 } }, () => { looks.show(); });',
        ],
      },
      data: {
        title: "Variables and lists",
        rules: [
          "Always use $field_VARIABLE and $field_LIST selectors.",
          "Read variables with data.variable({ $field_VARIABLE: \"name\" }).",
          "Read list items with data.itemoflist({ $field_LIST: \"numbers\", INDEX: ... }).",
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
          '  pen.clear();',
          '  data.setvariableto({ $field_VARIABLE: "i", VALUE: 1 });',
          '  control.repeat({ TIMES: data.lengthoflist({ $field_LIST: "numbers" }), SUBSTACK: () => {',
          '    control.if({ CONDITION: operator.equals({ OPERAND1: data.variable({ $field_VARIABLE: "i" }), OPERAND2: argument.reporter_string_number({ $field_VALUE: "highlight1" }) }), SUBSTACK: () => {',
          '      pen.setPenColorToColor({ COLOR: "#ff4d4f" });',
          '    } });',
          '    // draw bar i here',
          '    data.changevariableby({ $field_VARIABLE: "i", VALUE: 1 });',
          '  } });',
          '});',
          'procedures.call({ $mutation: { proccode: "draw bars %n %n", warp: "true" }, $args: [0, 0] });',
        ],
      },
      "custom-args": {
        title: "Custom block parameters",
        rules: [
          'Define named parameters with placeholders like %n[highlight] or %b[enabled].',
          'Read number/string parameters with argument.reporter_string_number({ $field_VALUE: "highlight" }).',
          'Read boolean parameters with argument.reporter_boolean({ $field_VALUE: "enabled" }).',
          "Do not use data.variable for custom block parameters; that reads a global Scratch variable and can silently break logic.",
          'The call proccode uses placeholder shapes without names, e.g. "draw frame %n" and $args: [1].',
        ],
        examples: [
          'define({ proccode: "draw frame %n[highlight]", info: ["warp"], $xy: { x: 80, y: 360 } }, () => {',
          '  control.if({ CONDITION: operator.equals({ OPERAND1: data.variable({ $field_VARIABLE: "i" }), OPERAND2: argument.reporter_string_number({ $field_VALUE: "highlight" }) }), SUBSTACK: () => {',
          '    pen.setPenColorToColor({ COLOR: "#ff4d4f" });',
          '  } });',
          '});',
          'procedures.call({ $mutation: { proccode: "draw frame %n", warp: "true" }, $args: [data.variable({ $field_VARIABLE: "j" })] });',
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
          '});',
          'define({ proccode: "draw frame %n[left] %n[right]", info: ["warp"], $xy: { x: 60, y: 260 } }, () => {',
          '  pen.clear();',
          '  // Use argument.reporter_string_number({ $field_VALUE: "left" }) and "right" for highlights.',
          '  // Draw the whole frame here.',
          '});',
        ],
      },
      menus: {
        title: "Menu / dropdown fields",
        rules: [
          "Dropdowns, variables, lists, keys, broadcasts, and pen COLOR_PARAM use $field_ keys.",
          'If a block has a menu field, do not omit it. getDiagnostics rejects missing required menu fields.',
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
          'pen.clear();',
          'pen.setPenSizeTo({ SIZE: 18 });',
          'pen.setPenColorToColor({ COLOR: "#4a90d9" });',
          'pen.setPenColorParamTo({ $field_COLOR_PARAM: "color", VALUE: 50 });',
          'pen.changePenColorParamBy({ $field_COLOR_PARAM: "brightness", VALUE: 10 });',
        ],
      },
      patching: {
        title: "Patch workflow",
        rules: [
          "For a new empty file, full replacement after *** Update File is safest.",
          "For existing generated scripts, readFile first and preserve // blockId comments when possible.",
          "Patch one script at a time, then getDiagnostics.",
        ],
        example: "*** Begin Patch\n*** Update File: /sprites/角色1.js\n@@\n */\n+// @script new-hello\n+event.whenflagclicked({ $xy: { x: 80, y: 80 } }, () => {\n+  looks.say({ MESSAGE: \"hello\" });\n+});\n*** End Patch",
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
          'getBlockHelp({ opcode: "operator.less" }) -> returns operator.lt/operator_lt help.',
          'getScratchGuide({ topic: "custom-args" }) before writing parameterized custom blocks.',
          'getScratchGuide({ topic: "menus" }) before using pen/key/broadcast dropdowns.',
        ],
      },
    };

    const guide = guides[normalizedTopic] || guides.quickstart;
    return {
      success: true,
      topic: guides[normalizedTopic] ? normalizedTopic : "quickstart",
      availableTopics: Object.keys(guides),
      ...guide,
    };
  }

  searchBlocks(options: string | { query?: string; maxResults?: number; includeExamples?: boolean }) {
    const query = typeof options === "string" ? options : String(options?.query || "");
    const keywords = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (keywords.length === 0) {
      return { success: false, error: "searchBlocks requires a non-empty query.", matches: [] };
    }

    const maxResults =
      typeof options === "object" ? Math.max(1, Math.min(50, Number(options?.maxResults || 12))) : 12;
    const includeExamples = typeof options !== "object" || options?.includeExamples !== false;
    const blockIds = this._getAllBlockIds();
    const matches: any[] = [];
    const seenOpcodes = new Set<string>();
    const queryText = keywords.join(" ");
    const wantsProcedures = /(自定义|函数|function|procedure|procedures|custom|warp|不刷新|渲染|render|frame|helper)/i.test(
      queryText,
    );

    if (wantsProcedures) {
      const defineHelp = this._compactBlockHelp({
        opcode: "define",
        text: "Define custom block / 自定义积木定义",
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
        text: "定义自定义积木；use info: [\"warp\"] to run without screen refresh",
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
      const searchText = [opcode, String(rawText || ""), ...(AITools.BlockSearchAliases[opcode] || [])]
        .join(" ")
        .toLowerCase();
      const isMatch = keywords.every((keyword) => searchText.includes(keyword));
      if (!isMatch) continue;

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
        });
        seenOpcodes.add(opcode);
      } catch {
        matches.push({ opcode, dslCall: this._toDslCallName(opcode), text: rawText });
        seenOpcodes.add(opcode);
      }

      if (matches.length >= maxResults) break;
    }

    return {
      success: true,
      query,
      matchCount: matches.length,
      matches,
    };
  }

  getBlockHelp(opcode: string) {
    const requested = String(opcode || "").trim().toLowerCase();
    if (/^(define|custom|custom[-_ ]?block|function|procedure|warp|自定义|函数)$/.test(requested)) {
      const help = this._compactBlockHelp({
        opcode: "define",
        text: "Define custom block / 自定义积木定义",
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
        callExample:
          'procedures.call({ $mutation: { proccode: "draw bars %n %n", warp: "true" }, $args: [0, 0] });',
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

              if (block.info?.arguments) {
                for (const [argName, argInfo] of Object.entries(block.info.arguments)) {
                  const typedArg = argInfo as any;
                  const typeMeta = this._getArgumentTypeMeta(typedArg?.type);
                  const normalized = {
                    type: typeMeta.inferred,
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
                    const shouldUseField = Boolean(typedArg?.menu || typeMeta.asField);
                    const target = shouldUseField ? result.fields : result.inputs;
                    target[argName] = normalized;
                  }
                }
              }

              if (extInfo?.menus && typeof extInfo.menus === "object") {
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
                  if (extInfo.menus[menuName] !== undefined) {
                    result.menus = result.menus || {};
                    result.menus[menuName] = extInfo.menus[menuName];
                  }
                }
              }

              this._enrichMenuMeta(resolvedOpcode, result, extInfo?.menus, this.vm.runtime);
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
        throw new Error(`getBlockInfo: 未找到积木 opcode "${requestedOpcode}"，已自动尝试 "${resolvedOpcode}"`);
      }
      throw new Error(`getBlockInfo: 未找到积木 opcode "${requestedOpcode}"`);
    }

    result.type = result.found ? result.blockType : null;
    return result;
  }

  cleanUpBlocks(targetId?: string) {
    const target = targetId ? this.vm.runtime.getTargetById(targetId) : this.vm.editingTarget;
    if (!target) return false;

    const workspace = window.Blockly.getMainWorkspace() as Blockly.WorkspaceSvg | null;
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
      window.Blockly.getMainWorkspace() as Blockly.WorkspaceSvg,
      startBlockId,
      endBlockId,
    );
  }

  async replaceBlocksRangeByUCF(startBlockId: string, endBlockId: string, ucfString: string) {
    return replaceBlocksRangeByUCF(
      this.vm,
      window.Blockly.getMainWorkspace() as Blockly.WorkspaceSvg,
      startBlockId,
      endBlockId,
      ucfString,
    );
  }

  async replaceScriptByUCF(scriptId: string, ucfString: string) {
    return replaceScriptByUCF(this.vm, window.Blockly.getMainWorkspace() as Blockly.WorkspaceSvg, scriptId, ucfString);
  }

  async generateCodeFromUCF(ucfString: string, targetId?: string, x?: number, y?: number) {
    const target = targetId ? this.vm.runtime.getTargetById(targetId) : this.vm.editingTarget;
    if (!target) {
      return {
        success: false,
        error: "Target not found",
      };
    }

    console.log("[AI Tool Call] generateCodeFromUCF started. UCF String:", ucfString);
    let newBlocks;
    try {
      newBlocks = ucfToScratch(normalizeModelUCF(ucfString), { runtime: this.vm.runtime, includeComments: true });
      console.log("[AI Tool Call] Parsed blocks array:", newBlocks);
    } catch (e) {
      console.error("[AI Tool Call] Error parsing UCF string:", e);
      return {
        success: false,
        error: e instanceof Error ? e.message : "Failed to parse UCF string",
      };
    }

    const result = await insertScriptByUCF(
      this.vm,
      window.Blockly.getMainWorkspace() as Blockly.WorkspaceSvg,
      target.id,
      normalizeModelUCF(ucfString),
      { includeComments: true },
    );

    return {
      ...result,
      ignoredPosition: x !== undefined || y !== undefined,
    };
  }
}
