import { scratchToUCF } from "./ucf";

const SCRIPT_FILES_COMMENT_RE = /^ai-assistant script-files(?:\s+\d+\/\d+)?$/;

const sanitizeSpriteFolderName = (value: string) =>
  String(value || "sprite")
    .trim()
    .replace(/[\\/:*?"<>|#\[\]]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/^-+|-+$/g, "") || "sprite";

const getFileStem = (fileName: string) => String(fileName || "").replace(/\.[^.]+$/, "");

const getScriptFileName = (value: string, fallback = "script") => {
  const raw = getFileStem(value || fallback)
    .trim()
    .replace(/[\\/:*?"<>|#\[\]]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `${raw || fallback}.js`;
};

const getRuntimeTargetName = (target: any) => String(target?.getName?.() || target?.sprite?.name || target?.id || "target");

const isRuntimeCloneTarget = (target: any) =>
  Boolean(target && !target.isStage && (target.isOriginal === false || target.isClone === true || target.originalTarget));

const getProjectIndexTargets = (vm?: PluginContext["vm"]) => {
  const targets = Array.isArray(vm?.runtime?.targets) ? vm.runtime.targets : [];
  return targets.filter((target: any) => target && !isRuntimeCloneTarget(target));
};

const getTopLevelBlocks = (target: any) => {
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

const parseScriptFileNameMap = (target: any) => {
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
    const fileName = getScriptFileName(trimmed.slice(separator + 1).trim(), "script");
    if (scriptId && fileName) result.set(scriptId, fileName);
  });
  return result;
};

const getRootPathByTargetId = (targets: any[]) => {
  const nameCounts = new Map<string, number>();
  const nameSeen = new Map<string, number>();

  targets.forEach((target) => {
    if (target?.isStage) return;
    const name = sanitizeSpriteFolderName(getRuntimeTargetName(target));
    nameCounts.set(name, (nameCounts.get(name) || 0) + 1);
  });

  const result = new Map<string, string>();
  targets.forEach((target) => {
    if (!target?.id) return;
    if (target.isStage) {
      result.set(target.id, "/stage");
      return;
    }
    const name = sanitizeSpriteFolderName(getRuntimeTargetName(target));
    const index = (nameSeen.get(name) || 0) + 1;
    nameSeen.set(name, index);
    result.set(target.id, `/${name}${(nameCounts.get(name) || 0) > 1 ? `.${index}` : ""}`);
  });
  return result;
};

const findBlockOwnerTarget = (vm: PluginContext["vm"] | undefined, blockId?: string | null) => {
  if (!blockId) return null;
  return getProjectIndexTargets(vm).find((target: any) => Boolean(target?.blocks?._blocks?.[blockId])) || null;
};

const getTopBlockIdFromState = (target: any, blockId?: string | null) => {
  const blocks = target?.blocks?._blocks as Record<string, any>;
  let current = blockId ? blocks?.[blockId] : null;
  if (!current) return "";
  while (current?.parent && blocks?.[current.parent]) {
    current = blocks[current.parent];
  }
  return String(current?.id || "");
};

const collectScriptBlocks = (blocks: Record<string, any>, topBlockId: string) => {
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

export const isProjectIndexCompleteForBlockReferences = (vm?: PluginContext["vm"]) => {
  const targets = getProjectIndexTargets(vm);
  return targets.every((target: any) => {
    const topBlocks = getTopLevelBlocks(target);
    if (!topBlocks.length) return true;
    const map = parseScriptFileNameMap(target);
    return map.size > 0 && topBlocks.every((block: any) => map.has(String(block.id)));
  });
};

export const createVirtualBlockLineReference = (
  vm: PluginContext["vm"],
  startBlockId: string,
  endBlockId?: string,
): { text?: string; reason?: string; path?: string; startLine?: number; endLine?: number } => {
  if (!isProjectIndexCompleteForBlockReferences(vm)) {
    return { reason: "请先构建项目索引，再添加积木引用。" };
  }

  const target = findBlockOwnerTarget(vm, startBlockId);
  if (!target) return { reason: "未找到选中的积木。" };
  const blocks = target?.blocks?._blocks as Record<string, any>;
  if (!blocks) return { reason: "未找到积木数据。" };

  const startTopBlockId = getTopBlockIdFromState(target, startBlockId);
  const endTopBlockId = getTopBlockIdFromState(target, endBlockId || startBlockId);
  if (!startTopBlockId || !endTopBlockId || startTopBlockId !== endTopBlockId) {
    return { reason: "只能添加同一段脚本内的积木引用。" };
  }

  const targets = getProjectIndexTargets(vm);
  const rootPath = getRootPathByTargetId(targets).get(target.id) || "/sprite";
  const persistedMap = parseScriptFileNameMap(target);
  const fileName = persistedMap.get(startTopBlockId);
  if (!fileName) return { reason: "选中的脚本尚未写入项目索引，请先更新项目索引。" };

  const groupedTopBlocks = getTopLevelBlocks(target).filter((topBlock: any) => persistedMap.get(String(topBlock.id)) === fileName);
  const hasMultipleSections = groupedTopBlocks.length > 1;
  let cursorLine = 1;
  let startLine = 0;
  let endLine = 0;

  for (const topBlock of groupedTopBlocks) {
    const scriptBlocks = collectScriptBlocks(blocks, String(topBlock.id));
    const annotatedCode = scratchToUCF(scriptBlocks, {
      runtime: vm?.runtime,
      includePosition: true,
      includeBlockIds: true,
    }).trimEnd();
    const lines = annotatedCode.split("\n");
    const codeStartLine = hasMultipleSections ? cursorLine + 1 : cursorLine;
    const codeEndLine = codeStartLine + Math.max(1, lines.length) - 1;

    if (String(topBlock.id) === startTopBlockId) {
      lines.forEach((line, index) => {
        const blockId = line.match(/\/\/\s*blockId:\s*([^\s]+)\s*$/i)?.[1];
        const lineNumber = codeStartLine + index;
        if (blockId === startBlockId) startLine = lineNumber;
        if (blockId === (endBlockId || startBlockId)) endLine = lineNumber;
      });
      if (!startLine) startLine = codeStartLine;
      if (!endLine) endLine = startLine;
      break;
    }

    cursorLine = codeEndLine + (hasMultipleSections ? 3 : 1);
  }

  if (!startLine || !endLine) return { reason: "无法解析选中积木在虚拟文件中的行号。" };
  const normalizedStart = Math.min(startLine, endLine);
  const normalizedEnd = Math.max(startLine, endLine);
  const path = `${rootPath}/scripts/${fileName}`;
  return {
    path,
    startLine: normalizedStart,
    endLine: normalizedEnd,
    text: normalizedStart === normalizedEnd ? `${path} ${normalizedStart}行` : `${path} ${normalizedStart}行到${normalizedEnd}行`,
  };
};

export interface VirtualBlockLineReferenceRange {
  start: number;
  end: number;
  text: string;
  path: string;
  startLine: number;
  endLine: number;
}

export interface ResolvedVirtualBlockLineReference {
  path: string;
  targetId: string;
  startLine: number;
  endLine: number;
  code: string;
  fallbackCode?: string;
  startBlockId: string;
  endBlockId: string;
}

const VIRTUAL_BLOCK_REFERENCE_RE = /(^|\s)((?:\/[^\s]+)?\/scripts\/[^\s]+?\.js)\s+(\d+)行(?:到(\d+)行)?/g;

export const findVirtualBlockLineReferenceRanges = (text: string): VirtualBlockLineReferenceRange[] => {
  const ranges: VirtualBlockLineReferenceRange[] = [];
  if (!text) return ranges;
  let match: RegExpExecArray | null;
  while ((match = VIRTUAL_BLOCK_REFERENCE_RE.exec(text))) {
    const prefix = match[1] || "";
    const start = match.index + prefix.length;
    const rawText = match[0].slice(prefix.length);
    const startLine = Number(match[3]);
    const endLine = Number(match[4] || match[3]);
    ranges.push({
      start,
      end: start + rawText.length,
      text: rawText,
      path: match[2],
      startLine: Math.min(startLine, endLine),
      endLine: Math.max(startLine, endLine),
    });
  }
  return ranges;
};

const stripBlockIdComment = (line: string) => line.replace(/\s*\/\/\s*blockId:\s*[^\s]+\s*$/i, "");

export const resolveVirtualBlockLineReference = (
  vm: PluginContext["vm"],
  reference: Pick<VirtualBlockLineReferenceRange, "path" | "startLine" | "endLine">,
): ResolvedVirtualBlockLineReference | null => {
  const targets = getProjectIndexTargets(vm);
  const rootPathByTargetId = getRootPathByTargetId(targets);
  const target = targets.find((item: any) => {
    const rootPath = rootPathByTargetId.get(item.id);
    return Boolean(rootPath && reference.path.startsWith(`${rootPath}/scripts/`));
  });
  if (!target?.id) return null;

  const blocks = target?.blocks?._blocks as Record<string, any>;
  if (!blocks) return null;
  const fileName = reference.path.split("/").pop() || "";
  const persistedMap = parseScriptFileNameMap(target);
  const groupedTopBlocks = getTopLevelBlocks(target).filter((topBlock: any) => persistedMap.get(String(topBlock.id)) === fileName);
  if (!groupedTopBlocks.length) return null;

  const hasMultipleSections = groupedTopBlocks.length > 1;
  let cursorLine = 1;
  const fileLines: string[] = [];
  const lineToBlockId = new Map<number, string>();
  const sections: Array<{ startLine: number; endLine: number; lines: string[] }> = [];

  groupedTopBlocks.forEach((topBlock: any, index: number) => {
    if (hasMultipleSections) {
      const marker = `// @script ${topBlock.id} ${topBlock.opcode || ""}`;
      fileLines.push(marker);
      lineToBlockId.set(cursorLine, String(topBlock.id));
      cursorLine += 1;
    }

    const scriptBlocks = collectScriptBlocks(blocks, String(topBlock.id));
    const annotatedCode = scratchToUCF(scriptBlocks, {
      runtime: vm?.runtime,
      includePosition: true,
      includeBlockIds: true,
    }).trimEnd();
    const lines = annotatedCode.split("\n");
    const sectionStartLine = cursorLine;
    lines.forEach((line) => {
      const blockId = line.match(/\/\/\s*blockId:\s*([^\s]+)\s*$/i)?.[1];
      if (blockId) lineToBlockId.set(cursorLine, blockId);
      fileLines.push(line);
      cursorLine += 1;
    });
    sections.push({
      startLine: sectionStartLine,
      endLine: cursorLine - 1,
      lines,
    });

    if (hasMultipleSections && index < groupedTopBlocks.length - 1) {
      fileLines.push("");
      fileLines.push("");
      cursorLine += 2;
    }
  });

  const startLine = Math.max(1, Math.min(reference.startLine, fileLines.length));
  const endLine = Math.max(startLine, Math.min(reference.endLine, fileLines.length));
  const selectedLines = fileLines.slice(startLine - 1, endLine).filter((line) => !/^\s*\/\/\s*@script\b/.test(line));
  const code = selectedLines.map(stripBlockIdComment).join("\n").trim();
  if (!code) return null;
  const fallbackCode = sections
    .filter((section) => section.endLine >= startLine && section.startLine <= endLine)
    .flatMap((section) => section.lines)
    .map(stripBlockIdComment)
    .join("\n")
    .trim();

  const nearestBlockId = (line: number) => {
    const exact = lineToBlockId.get(line);
    if (exact) return exact;
    const candidates = [...lineToBlockId.entries()].sort((left, right) => Math.abs(left[0] - line) - Math.abs(right[0] - line));
    return candidates[0]?.[1] || "";
  };

  return {
    path: reference.path,
    targetId: target.id,
    startLine,
    endLine,
    code,
    fallbackCode: fallbackCode && fallbackCode !== code ? fallbackCode : undefined,
    startBlockId: nearestBlockId(startLine),
    endBlockId: nearestBlockId(endLine),
  };
};
