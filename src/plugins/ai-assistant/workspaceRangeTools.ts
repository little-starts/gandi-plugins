import { scratchToUCF, ucfToScratch } from "./ucf";
import { normalizeModelUCF, toAnnotatedUCF } from "./annotatedUcf";

const resolveTargetForRange = (vm: PluginContext["vm"], startBlockId: string, endBlockId: string) => {
  const target = vm.runtime.targets.find((item) => {
    const blocks = item.blocks?._blocks;
    return blocks && blocks[startBlockId] && blocks[endBlockId];
  });
  return target || null;
};

const getBlockStateById = (target: Scratch.RenderTarget | null, blockId: string) => {
  if (!target?.blocks?._blocks) return null;
  return target.blocks._blocks[blockId] || null;
};

const getTopBlockIdFromState = (target: Scratch.RenderTarget | null, blockId: string) => {
  let current = getBlockStateById(target, blockId);
  while (current?.parent) {
    current = getBlockStateById(target, current.parent);
  }
  return current?.id || null;
};

const getContinuousChainFromState = (target: Scratch.RenderTarget | null, topBlockId: string) => {
  const chain: any[] = [];
  let current = getBlockStateById(target, topBlockId);
  while (current) {
    chain.push(current);
    current = current.next ? getBlockStateById(target, current.next) : null;
  }
  return chain;
};

const getScriptBoundaryIds = (target: Scratch.RenderTarget | null, scriptId: string) => {
  const topBlockId = getTopBlockIdFromState(target, scriptId);
  if (!topBlockId || topBlockId !== scriptId) {
    return { success: false, error: "Script not found or is not a top-level script" };
  }

  const chain = getContinuousChainFromState(target, topBlockId);
  if (!chain.length) {
    return { success: false, error: "Script chain is empty" };
  }

  return {
    success: true,
    startBlockId: chain[0].id,
    endBlockId: chain[chain.length - 1].id,
    blockCount: chain.length,
  };
};

const collectRangeRuntimeBlocks = (target: Scratch.RenderTarget | null, selectedBlocks: any[]) => {
  const requiredBlockIds = new Set<string>();

  const collectReferencedBlocks = (blockId: string) => {
    if (!blockId || requiredBlockIds.has(blockId)) return;
    requiredBlockIds.add(blockId);
    const runtimeBlock = getBlockStateById(target, blockId);
    if (!runtimeBlock?.inputs) return;

    Object.values(runtimeBlock.inputs).forEach((input: any) => {
      if (input.block) collectReferencedBlocks(input.block);
      if (input.shadow) collectReferencedBlocks(input.shadow);
    });
  };

  selectedBlocks.forEach((block) => collectReferencedBlocks(block.id));
  const selectedOrderMap = new Map(selectedBlocks.map((block, index) => [block.id, index]));
  const isWithinSelectedRange = (blockId?: string | null) => Boolean(blockId && selectedOrderMap.has(blockId));

  return Array.from(requiredBlockIds).map((blockId) => {
    const runtimeBlock = getBlockStateById(target, blockId);
    const selectedIndex = selectedOrderMap.get(blockId);
    const isSelectedChainBlock = selectedIndex !== undefined;
    const nextSelectedBlockId =
      isSelectedChainBlock && selectedIndex < selectedBlocks.length - 1 ? selectedBlocks[selectedIndex + 1].id : null;

    return {
      ...runtimeBlock,
      topLevel: selectedIndex === 0,
      parent: isSelectedChainBlock
        ? selectedIndex === 0
          ? null
          : selectedBlocks[selectedIndex - 1].id
        : isWithinSelectedRange(runtimeBlock.parent)
          ? runtimeBlock.parent
          : null,
      next: isSelectedChainBlock
        ? nextSelectedBlockId
        : isWithinSelectedRange(runtimeBlock.next)
          ? runtimeBlock.next
          : null,
    };
  });
};

const getRangeBlocks = (target: Scratch.RenderTarget | null, startBlockId: string, endBlockId: string) => {
  const topBlockId = getTopBlockIdFromState(target, startBlockId);
  if (!topBlockId) {
    return { success: false, error: "Range blocks not found" };
  }

  const chain = getContinuousChainFromState(target, topBlockId);
  const startIndex = chain.findIndex((block) => block.id === startBlockId);
  const endIndex = chain.findIndex((block) => block.id === endBlockId);

  if (startIndex === -1 || endIndex === -1 || startIndex > endIndex) {
    return { success: false, error: "Invalid range order" };
  }

  return {
    success: true,
    rangeBlocks: chain.slice(startIndex, endIndex + 1),
  };
};

const escapeXml = (value: unknown) =>
  String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const mutationToXml = (mutation: Record<string, any>) => {
  const tagName = mutation.tagName || "mutation";
  const attributes = Object.entries(mutation)
    .filter(([key]) => key !== "children" && key !== "tagName")
    .map(([key, value]) => {
      const normalizedValue = key === "blockInfo" ? JSON.stringify(value) : value;
      return ` ${key}="${escapeXml(normalizedValue)}"`;
    })
    .join("");
  const children = Array.isArray(mutation.children)
    ? mutation.children.map((item) => mutationToXml(item)).join("")
    : "";
  return `<${tagName}${attributes}>${children}</${tagName}>`;
};

const blockStateToXml = (blockId: string, blocksMap: Map<string, any>) => {
  const block = blocksMap.get(blockId);
  if (!block) return "";

  const tagName = block.shadow ? "shadow" : "block";
  const position =
    block.topLevel && typeof block.x !== "undefined" && typeof block.y !== "undefined"
      ? ` x="${escapeXml(block.x)}" y="${escapeXml(block.y)}"`
      : "";

  let xml = `<${tagName} id="${escapeXml(block.id)}" type="${escapeXml(block.opcode)}"${position}>`;

  if (block.mutation) {
    xml += mutationToXml(block.mutation);
  }

  if (typeof block.commentText === "string" && block.commentText.trim()) {
    const width = Number(block.commentWidth) || 200;
    const height = Number(block.commentHeight) || 160;
    xml += `<comment pinned="false" h="${escapeXml(height)}" w="${escapeXml(width)}">${escapeXml(
      block.commentText,
    )}</comment>`;
  }

  Object.values(block.inputs || {}).forEach((input: any) => {
    if (!input?.block && !input?.shadow) return;
    xml += `<value name="${escapeXml(input.name)}">`;
    if (input.block) {
      xml += blockStateToXml(input.block, blocksMap);
    }
    if (input.shadow && input.shadow !== input.block) {
      xml += blockStateToXml(input.shadow, blocksMap);
    }
    xml += "</value>";
  });

  Object.values(block.fields || {}).forEach((field: any) => {
    xml += `<field name="${escapeXml(field.name)}"`;
    if (field.id) {
      xml += ` id="${escapeXml(field.id)}"`;
    }
    if (typeof field.variableType === "string") {
      xml += ` variabletype="${escapeXml(field.variableType)}"`;
    }
    xml += `>${escapeXml(field.value ?? "")}</field>`;
  });

  if (block.next) {
    xml += `<next>${blockStateToXml(block.next, blocksMap)}</next>`;
  }

  xml += `</${tagName}>`;
  return xml;
};

export const blockStatesToXml = (blocksState: any[]) => {
  const blocksMap = new Map(blocksState.map((blockState) => [blockState.id, blockState]));
  const topLevelBlocks = blocksState.filter((blockState) => blockState.topLevel);
  return `<xml xmlns="http://www.w3.org/1999/xhtml">${topLevelBlocks
    .map((blockState) => blockStateToXml(blockState.id, blocksMap))
    .join("")}</xml>`;
};

const getTargetVariables = (target: any) => Object.values(target?.variables || {}) as any[];

const repairListVariableValue = (target: any, variable: any) => {
  if (!target || !variable || variable.type !== "list" || Array.isArray(variable.value)) {
    return null;
  }

  const repairedValue =
    variable.value === undefined || variable.value === null || variable.value === "" ? [] : [variable.value];
  const previousValue = variable.value;
  variable.value = repairedValue;
  if ("_value" in variable) {
    variable._value = repairedValue;
  }
  if ("_monitorUpToDate" in variable) {
    variable._monitorUpToDate = false;
  }

  return {
    targetId: target.id,
    variableId: variable.id,
    name: variable.name,
    previousValue,
    repairedValue,
  };
};

export const repairListVariableValues = (vm: PluginContext["vm"], targetId?: string) => {
  const targets = targetId
    ? [vm.runtime?.getTargetById?.(targetId)].filter(Boolean)
    : Array.isArray(vm.runtime?.targets)
      ? vm.runtime.targets
      : [];
  const repairs: any[] = [];

  targets.forEach((target: any) => {
    getTargetVariables(target).forEach((variable) => {
      const repair = repairListVariableValue(target, variable);
      if (repair) {
        repairs.push(repair);
      }
    });
  });

  return repairs;
};

const resolveVariableReferences = (
  vm: PluginContext["vm"],
  workspace: Blockly.WorkspaceSvg | null,
  blocksState: any[],
  blockly?: any,
) => {
  const createScratchFieldId = () =>
    getScratchBlocks(blockly, workspace)?.Utils?.genUid?.() || `ai-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const target = vm.editingTarget;
  const runtimeTargets = Array.isArray(vm.runtime?.targets) ? vm.runtime.targets : [];
  const stageTarget = runtimeTargets.find((item: any) => item?.isStage) || target;
  repairListVariableValues(vm, target?.id);

  const existingVariables = [
    ...runtimeTargets.flatMap((runtimeTarget: any) =>
      getTargetVariables(runtimeTarget).map((item: any) => ({
        id: item.id,
        name: item.name,
        type: item.type || "",
        source: "runtime",
        target: runtimeTarget,
        variable: item,
      })),
    ),
    ...(workspace && typeof (workspace as any).getAllVariables === "function"
      ? workspace.getAllVariables().map((item: any) => ({
          id: item.id_ || item.id,
          name: item.name,
          type: item.type || "",
          source: "workspace",
          target: null,
          variable: item,
        }))
      : []),
  ];

  const createStableVariableId = (name: string, type: string) => {
    const base = String(name || "").trim() || createScratchFieldId();
    const conflictingVariable = existingVariables.find((item) => item.id === base && (item.name !== name || item.type !== type));
    if (!conflictingVariable) return base;

    const suffix = type === "list" ? "list" : type === "broadcast_msg" ? "broadcast" : "var";
    let index = 2;
    let nextId = `${base}-${suffix}`;
    while (existingVariables.some((item) => item.id === nextId && (item.name !== name || item.type !== type))) {
      nextId = `${base}-${suffix}-${index}`;
      index += 1;
    }
    return nextId;
  };

  const ensureWorkspaceVariable = (id: string, name: string, type: string) => {
    if (!workspace) return;
    try {
      const existingById =
        typeof (workspace as any).getVariableById === "function" ? (workspace as any).getVariableById(id) : null;
      if (existingById) return;

      const existingByName =
        typeof (workspace as any).getVariable === "function" ? (workspace as any).getVariable(name, type) : null;
      if (existingByName) return;

      if (typeof (workspace as any).createVariable === "function") {
        (workspace as any).createVariable(name, type, id);
      }
    } catch (error) {
      console.warn("[AI Assistant] Failed to ensure workspace variable", { id, name, type, error });
    }
  };

  const ensureRuntimeVariable = (id: string, name: string, type: string) => {
    let variableRecord = existingVariables.find((item) => item.id === id && item.type === type);
    if (!variableRecord) {
      variableRecord = existingVariables.find((item) => item.name === name && item.type === type);
    }
    if (variableRecord?.source === "runtime") {
      if (type === "list") {
        repairListVariableValue(variableRecord.target, variableRecord.variable);
      }
      ensureWorkspaceVariable(variableRecord.id, variableRecord.name, type);
      return variableRecord;
    }

    const ownerTarget = type === "broadcast_msg" ? stageTarget : stageTarget || target;
    let variable = getTargetVariables(ownerTarget).find((item) => item.id === id || (item.name === name && item.type === type));
    if (!variable) {
      ownerTarget?.createVariable(id, name, type, false);
      variable = ownerTarget?.variables?.[id] || getTargetVariables(ownerTarget).find((item) => item.id === id);
    }
    if (type === "list") {
      repairListVariableValue(ownerTarget, variable);
    }
    ensureWorkspaceVariable(id, name, type);
    existingVariables.push({
      id,
      name,
      type,
      source: "runtime",
      target: ownerTarget,
      variable,
    });
    return existingVariables[existingVariables.length - 1];
  };

  const findVariableReference = (nameOrId: string, type: string) => {
    const byName = existingVariables.find((item) => item.name === nameOrId && item.type === type);
    if (byName) return byName;

    const byId = existingVariables.find((item) => item.id === nameOrId && item.type === type);
    if (byId) return byId;

    return null;
  };

  const normalizeVariableField = (field: any) => {
    const variableType = field.name === "VARIABLE" ? "" : "list";
    const requestedName = String(field.value || "").trim();
    if (!requestedName) {
      return;
    }

    const existingVariable = findVariableReference(requestedName, variableType);
    if (existingVariable) {
      field.id = existingVariable.id;
      field.value = existingVariable.name;
      field.variableType = variableType;
      ensureRuntimeVariable(existingVariable.id, existingVariable.name, variableType);
      return;
    }

    const fieldId = createStableVariableId(requestedName, variableType);
    field.id = fieldId;
    field.value = requestedName;
    field.variableType = variableType;
    ensureRuntimeVariable(fieldId, requestedName, variableType);
  };

  blocksState.forEach((blockState) => {
    Object.values(blockState.fields || {}).forEach((field: any) => {
      if (field.name !== "VARIABLE" && field.name !== "LIST" && field.name !== "LIST_MENU") return;
      normalizeVariableField(field);
    });
  });
};

const collectTopLevelBlockIds = (workspace: Blockly.WorkspaceSvg) =>
  workspace
    .getTopBlocks(false)
    .map((block) => block.id)
    .sort();

const getPageBlockly = () => (typeof window !== "undefined" ? (window as any).Blockly || null : null);

const getRuntimeEditingTarget = (vm: PluginContext["vm"]) => {
  try {
    const runtime = vm.runtime as any;
    return typeof runtime?.getEditingTarget === "function" ? runtime.getEditingTarget() : null;
  } catch {
    return null;
  }
};

const getScratchBlocks = (blockly?: any, workspace?: Blockly.WorkspaceSvg | null) =>
  (workspace as any)?.getScratchBlocks?.() || blockly || getPageBlockly() || null;

const getMainWorkspace = (blockly?: any, workspace?: Blockly.WorkspaceSvg | null) => {
  const scratchBlocks = getScratchBlocks(blockly, workspace);
  return ((scratchBlocks?.getMainWorkspace?.() || getPageBlockly()?.getMainWorkspace?.() || null) as
    | Blockly.WorkspaceSvg
    | null);
};

const getRegisteredWorkspaces = (blockly?: any, workspace?: Blockly.WorkspaceSvg | null) => {
  const scratchBlocks = getScratchBlocks(blockly, workspace);
  const workspaceDb = scratchBlocks?.Workspace?.WorkspaceDB_;
  if (!workspaceDb || typeof workspaceDb !== "object") return [] as Blockly.WorkspaceSvg[];
  return Object.values(workspaceDb).filter(Boolean) as Blockly.WorkspaceSvg[];
};

const isRegisteredWorkspace = (workspace: any, blockly?: any) => {
  if (!workspace?.id) return false;
  const scratchBlocks = getScratchBlocks(blockly, workspace);
  const getById = scratchBlocks?.Workspace?.getById;
  return typeof getById === "function" ? getById(workspace.id) === workspace : true;
};

const isUsableWorkspace = (workspace: any): workspace is Blockly.WorkspaceSvg =>
  Boolean(
    workspace &&
      !workspace.isFlyout &&
      typeof workspace.getTopBlocks === "function" &&
      typeof workspace.getBlockById === "function",
  );

const getTargetTopLevelBlockIds = (target: Scratch.RenderTarget | null) => {
  const blocks = (target as any)?.blocks?._blocks;
  if (!blocks || typeof blocks !== "object") return [];
  return Object.values(blocks)
    .filter((block: any) => block?.topLevel && !block?.parent && !block?.shadow)
    .map((block: any) => String(block.id || ""))
    .filter(Boolean)
    .sort();
};

const workspaceContainsTargetTopBlocks = (workspace: Blockly.WorkspaceSvg, targetTopBlockIds: string[]) => {
  try {
    const workspaceTopBlockIds = collectTopLevelBlockIds(workspace);
    if (workspaceTopBlockIds.length !== targetTopBlockIds.length) return false;
    return targetTopBlockIds.every((blockId, index) => workspaceTopBlockIds[index] === blockId);
  } catch {
    return false;
  }
};

const selectWorkspaceForTarget = (
  target: Scratch.RenderTarget | null,
  candidates: Array<Blockly.WorkspaceSvg | null | undefined>,
  blockly?: any,
) => {
  const usableCandidates = candidates
    .filter(isUsableWorkspace)
    .filter((workspace, index, list) => list.findIndex((candidate) => candidate.id === workspace.id) === index)
    .filter((workspace) => isRegisteredWorkspace(workspace, blockly));
  if (!usableCandidates.length) return null;
  const targetTopBlockIds = getTargetTopLevelBlockIds(target);
  const matchingWorkspace = usableCandidates.find((workspace) =>
    workspaceContainsTargetTopBlocks(workspace, targetTopBlockIds),
  );
  return matchingWorkspace || null;
};

const getWorkspaceCandidateSource = (
  workspace: Blockly.WorkspaceSvg | null,
  sources: Array<{ source: string; workspace: Blockly.WorkspaceSvg | null | undefined }>,
) => {
  if (!workspace) return null;
  const match = sources.find((item) => item.workspace?.id && item.workspace.id === workspace.id);
  return match?.source || null;
};

const resolveWorkspaceForTarget = (
  vm: PluginContext["vm"],
  target: Scratch.RenderTarget | null,
  providedWorkspace?: Blockly.WorkspaceSvg | null,
  blockly?: any,
) => {
  const mainWorkspace = getMainWorkspace(blockly, providedWorkspace);
  const targetWorkspace = ((target as any)?.blocks?._workspace || null) as Blockly.WorkspaceSvg | null;
  const registeredWorkspaces = getRegisteredWorkspaces(blockly, providedWorkspace || mainWorkspace);
  const workspaceSources = [
    { source: "provided", workspace: providedWorkspace },
    { source: "main", workspace: mainWorkspace },
    { source: "target", workspace: targetWorkspace },
    ...registeredWorkspaces.map((workspace, index) => ({ source: `registered:${index}`, workspace })),
  ];
  const workspace = selectWorkspaceForTarget(
    target,
    workspaceSources.map((item) => item.workspace),
    blockly,
  );
  return {
    workspace,
    scratchBlocks: getScratchBlocks(blockly, workspace),
    diagnostics: {
      targetId: target?.id || null,
      editingTargetId: vm.editingTarget?.id || null,
      runtimeEditingTargetId: getRuntimeEditingTarget(vm)?.id || null,
      hasProvidedWorkspace: Boolean(providedWorkspace),
      hasMainWorkspace: Boolean(mainWorkspace),
      hasTargetWorkspace: Boolean(targetWorkspace),
      registeredWorkspaceCount: registeredWorkspaces.length,
      selectedWorkspaceId: (workspace as any)?.id || null,
      selectedWorkspaceSource: getWorkspaceCandidateSource(workspace, workspaceSources),
      targetTopBlockIds: getTargetTopLevelBlockIds(target),
    },
  };
};

const WORKSPACE_DEBUG_HEADER = "[AI Assistant Workspace Debug]";

const getTargetName = (target: any) => {
  try {
    return typeof target?.getName === "function" ? target.getName() : target?.sprite?.name || target?.id || null;
  } catch {
    return target?.id || null;
  }
};

const summarizeWorkspaceCandidate = (workspace: any) => {
  const summary: Record<string, unknown> = {
    exists: Boolean(workspace),
    usable: isUsableWorkspace(workspace),
    constructorName: workspace?.constructor?.name || null,
    id: workspace?.id || workspace?.id_ || null,
    hasGetTopBlocks: typeof workspace?.getTopBlocks === "function",
    hasGetBlockById: typeof workspace?.getBlockById === "function",
    hasIsLocked: typeof workspace?.isLocked === "function",
    hasOptions: Boolean(workspace?.options),
    isFlyout: Boolean(workspace?.isFlyout),
    rendered: Boolean(workspace?.rendered),
  };

  if (workspace && typeof workspace.getTopBlocks === "function") {
    try {
      summary.topBlockCount = workspace.getTopBlocks(false)?.length ?? null;
      summary.topBlockIds = workspace
        .getTopBlocks(false)
        ?.map((block: any) => block?.id)
        .filter(Boolean)
        .slice(0, 20);
    } catch (error) {
      summary.topBlockCountError = getErrorMessage(error, "unknown");
    }
  }

  return summary;
};

const buildWorkspaceDebugDiagnostics = (
  vm: PluginContext["vm"],
  target: Scratch.RenderTarget | null,
  providedWorkspace?: Blockly.WorkspaceSvg | null,
  blockly?: any,
  extra: Record<string, unknown> = {},
) => {
  const scratchBlocks = getScratchBlocks(blockly, providedWorkspace);
  let mainWorkspace: any = null;
  let mainWorkspaceError: string | null = null;
  try {
    mainWorkspace = getMainWorkspace(scratchBlocks, providedWorkspace);
  } catch (error) {
    mainWorkspaceError = getErrorMessage(error, "unknown");
  }

  const targetWorkspace = ((target as any)?.blocks?._workspace || null) as Blockly.WorkspaceSvg | null;
  const registeredWorkspaces = getRegisteredWorkspaces(blockly, providedWorkspace || mainWorkspace);
  const workspaceSources = [
    { source: "provided", workspace: providedWorkspace },
    { source: "main", workspace: mainWorkspace },
    { source: "target", workspace: targetWorkspace },
    ...registeredWorkspaces.map((workspace, index) => ({ source: `registered:${index}`, workspace })),
  ];
  const selectedWorkspace = selectWorkspaceForTarget(
    target,
    workspaceSources.map((item) => item.workspace),
    blockly,
  );
  const runtimeTargets = Array.isArray(vm.runtime?.targets) ? vm.runtime.targets : [];
  const documentRef = typeof document !== "undefined" ? document : null;
  const locationRef = typeof window !== "undefined" ? window.location : null;

  return {
    header: WORKSPACE_DEBUG_HEADER,
    ...extra,
    timestamp: new Date().toISOString(),
    page: {
      href: locationRef?.href || null,
      visibilityState: documentRef?.visibilityState || null,
      hasBlocklySvg: Boolean(documentRef?.querySelector?.(".blocklySvg")),
      blocklySvgCount: documentRef?.querySelectorAll?.(".blocklySvg")?.length ?? null,
      blocklyWorkspaceCount: documentRef?.querySelectorAll?.(".blocklyWorkspace")?.length ?? null,
    },
    blockly: {
      exists: Boolean(scratchBlocks),
      getMainWorkspaceType: typeof scratchBlocks?.getMainWorkspace,
      mainWorkspaceError,
      hasXmlTextToDom: typeof scratchBlocks?.Xml?.textToDom === "function",
      hasXmlDomToWorkspace: typeof scratchBlocks?.Xml?.domToWorkspace === "function",
    },
    target: {
      id: target?.id || null,
      name: getTargetName(target),
      isStage: Boolean((target as any)?.isStage),
      hasBlocks: Boolean((target as any)?.blocks),
      runtimeBlockCount: Object.keys((target as any)?.blocks?._blocks || {}).length,
      runtimeScriptCount: Array.isArray((target as any)?.blocks?._scripts) ? (target as any).blocks._scripts.length : null,
      hasTargetWorkspace: Boolean(targetWorkspace),
    },
    editingTarget: {
      id: vm.editingTarget?.id || null,
      name: getTargetName(vm.editingTarget),
      runtimeId: getRuntimeEditingTarget(vm)?.id || null,
      runtimeName: getTargetName(getRuntimeEditingTarget(vm)),
      isRequestedTarget: Boolean(target?.id && vm.editingTarget?.id === target.id),
    },
    workspaceCandidates: {
      selectedWorkspaceId: (selectedWorkspace as any)?.id || null,
      selectedWorkspaceSource: getWorkspaceCandidateSource(selectedWorkspace, workspaceSources),
      provided: summarizeWorkspaceCandidate(providedWorkspace),
      main: summarizeWorkspaceCandidate(mainWorkspace),
      target: summarizeWorkspaceCandidate(targetWorkspace),
      registered: registeredWorkspaces.slice(0, 8).map(summarizeWorkspaceCandidate),
    },
    runtimeTargets: runtimeTargets.map((runtimeTarget: any) => ({
      id: runtimeTarget?.id || null,
      name: getTargetName(runtimeTarget),
      isStage: Boolean(runtimeTarget?.isStage),
      isEditingTarget: Boolean(runtimeTarget?.id && runtimeTarget.id === vm.editingTarget?.id),
      hasBlocks: Boolean(runtimeTarget?.blocks),
      hasWorkspace: Boolean(runtimeTarget?.blocks?._workspace),
      blockCount: Object.keys(runtimeTarget?.blocks?._blocks || {}).length,
      scriptCount: Array.isArray(runtimeTarget?.blocks?._scripts) ? runtimeTarget.blocks._scripts.length : null,
    })),
  };
};

const logWorkspaceUnavailable = (
  operation: string,
  vm: PluginContext["vm"],
  target: Scratch.RenderTarget | null,
  providedWorkspace?: Blockly.WorkspaceSvg | null,
  blockly?: any,
  extra: Record<string, unknown> = {},
) => {
  const diagnostics = buildWorkspaceDebugDiagnostics(vm, target, providedWorkspace, blockly, { operation, ...extra });
  console.warn(WORKSPACE_DEBUG_HEADER, diagnostics);
  return diagnostics;
};

const logWorkspaceIntegrityWarning = (operation: string, diagnostics: Record<string, unknown>) => {
  const payload = {
    header: WORKSPACE_DEBUG_HEADER,
    operation,
    timestamp: new Date().toISOString(),
    ...diagnostics,
  };
  console.warn(WORKSPACE_DEBUG_HEADER, payload);
  return payload;
};

const findRuntimeBlockOwner = (vm: PluginContext["vm"], blockId: string) => {
  const targets = Array.isArray(vm.runtime?.targets) ? vm.runtime.targets : [];
  return targets.find((item: any) => Boolean(item?.blocks?._blocks?.[blockId])) || null;
};

const waitForRuntimeBlockOwner = async (vm: PluginContext["vm"], blockId: string, timeoutMs = 1000) => {
  const start = Date.now();
  let owner = findRuntimeBlockOwner(vm, blockId);
  while (!owner && Date.now() - start < timeoutMs) {
    await new Promise((resolve) => window.setTimeout(resolve, 50));
    owner = findRuntimeBlockOwner(vm, blockId);
  }
  return owner;
};

const waitForRuntimeBlockRemoval = async (vm: PluginContext["vm"], blockId: string, timeoutMs = 1000) => {
  const start = Date.now();
  let owner = findRuntimeBlockOwner(vm, blockId);
  while (owner && Date.now() - start < timeoutMs) {
    await new Promise((resolve) => window.setTimeout(resolve, 50));
    owner = findRuntimeBlockOwner(vm, blockId);
  }
  return owner;
};

const waitForTimeout = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

const waitForAnimationFrame = () =>
  new Promise((resolve) => {
    if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
      window.requestAnimationFrame(() => resolve(undefined));
    } else {
      window.setTimeout(resolve, 16);
    }
  });

const waitForUiSettle = async () => {
  await waitForAnimationFrame();
  await waitForAnimationFrame();
  await waitForTimeout(0);
};

const waitForWorkspaceUpdate = async (vm: PluginContext["vm"], timeoutMs = 1200) => {
  if (!vm || typeof vm.on !== "function") {
    await waitForTimeout(Math.min(timeoutMs, 80));
    return false;
  }

  return new Promise<boolean>((resolve) => {
    let settled = false;
    const cleanup = () => {
      if (typeof vm.off === "function") {
        vm.off("workspaceUpdate", handler);
      } else if (typeof vm.removeListener === "function") {
        vm.removeListener("workspaceUpdate", handler);
      }
    };
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const handler = () => finish(true);
    vm.on("workspaceUpdate", handler);
    window.setTimeout(() => finish(false), timeoutMs);
  });
};

const waitForEditingTarget = async (vm: PluginContext["vm"], targetId: string, timeoutMs = 1200) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const runtimeEditingTargetId = getRuntimeEditingTarget(vm)?.id || null;
    if (vm.editingTarget?.id === targetId && (!runtimeEditingTargetId || runtimeEditingTargetId === targetId)) {
      return true;
    }
    await waitForTimeout(50);
  }
  const runtimeEditingTargetId = getRuntimeEditingTarget(vm)?.id || null;
  return vm.editingTarget?.id === targetId && (!runtimeEditingTargetId || runtimeEditingTargetId === targetId);
};

const alignRuntimeEditingTarget = (vm: PluginContext["vm"], targetId: string) => {
  const runtimeEditingTargetId = getRuntimeEditingTarget(vm)?.id || null;
  if (!runtimeEditingTargetId || runtimeEditingTargetId === targetId) return false;
  const runtime = vm.runtime as any;
  const target =
    typeof runtime?.getTargetById === "function"
      ? runtime.getTargetById(targetId)
      : (Array.isArray(runtime?.targets) ? runtime.targets.find((item: any) => item?.id === targetId) : null);
  if (!target || typeof runtime?.setEditingTarget !== "function") return false;
  runtime.setEditingTarget(target);
  return true;
};

const ensureEditingTargetWorkspaceRequested = async (
  vm: PluginContext["vm"],
  targetId: string,
  blockly?: any,
  providedWorkspace?: Blockly.WorkspaceSvg | null,
) => {
  let switchedTarget = false;
  let runtimeTargetAligned = false;
  let workspaceUpdateReceived = false;
  const currentWorkspace = getMainWorkspace(blockly, providedWorkspace) || providedWorkspace || null;
  await waitForBlocklyEventFlush(getScratchBlocks(blockly, currentWorkspace));

  if (vm.editingTarget?.id !== targetId) {
    const workspaceUpdatePromise = waitForWorkspaceUpdate(vm);
    vm.setEditingTarget(targetId);
    workspaceUpdateReceived = await workspaceUpdatePromise;
    switchedTarget = true;
  } else {
    runtimeTargetAligned = alignRuntimeEditingTarget(vm, targetId);
  }

  const editingTargetReady = await waitForEditingTarget(vm, targetId);
  await waitForUiSettle();
  return { switchedTarget, runtimeTargetAligned, workspaceUpdateReceived, editingTargetReady };
};

const waitForBlocklyEventFlush = async (scratchBlocks?: any) => {
  const events = scratchBlocks?.Events;
  if (events?.FIRE_QUEUE_?.length && typeof events.fireNow_ === "function") {
    try {
      for (let attempt = 0; attempt < 5 && events.FIRE_QUEUE_?.length; attempt += 1) {
        events.fireNow_();
        await waitForTimeout(0);
      }
    } catch (error) {
      console.warn(WORKSPACE_DEBUG_HEADER, {
        operation: "flushBlocklyEvents",
        error: getErrorMessage(error, "unknown"),
      });
    }
  }
  await waitForTimeout(0);
  await waitForTimeout(20);
};

const waitForResolvedWorkspaceForTarget = async (
  vm: PluginContext["vm"],
  target: Scratch.RenderTarget,
  providedWorkspace?: Blockly.WorkspaceSvg | null,
  blockly?: any,
  timeoutMs = 1600,
) => {
  const start = Date.now();
  let lastResolved = resolveWorkspaceForTarget(vm, target, providedWorkspace, blockly);
  const targetTopBlockIds = getTargetTopLevelBlockIds(target);
  let targetReadyAt = 0;

  while (Date.now() - start < timeoutMs) {
    lastResolved = resolveWorkspaceForTarget(vm, target, providedWorkspace, blockly);
    const { workspace } = lastResolved;
    const runtimeEditingTargetId = getRuntimeEditingTarget(vm)?.id || null;
    const editingTargetReady = vm.editingTarget?.id === target.id && (!runtimeEditingTargetId || runtimeEditingTargetId === target.id);
    const targetBlocksReady = Boolean(workspace && workspaceContainsTargetTopBlocks(workspace, targetTopBlockIds));

    if (editingTargetReady && workspace && targetBlocksReady) {
      if (!targetReadyAt) targetReadyAt = Date.now();
      if (Date.now() - targetReadyAt >= 120) return lastResolved;
    } else {
      targetReadyAt = 0;
    }

    await waitForTimeout(50);
  }

  return lastResolved;
};

const validateWorkspaceReadyForMutation = (
  vm: PluginContext["vm"],
  target: Scratch.RenderTarget,
  workspace: Blockly.WorkspaceSvg,
  blockly?: any,
) => {
  const runtimeEditingTargetId = getRuntimeEditingTarget(vm)?.id || null;
  const targetTopBlockIds = getTargetTopLevelBlockIds(target);
  const workspaceTopBlockIds = collectTopLevelBlockIds(workspace);

  if (vm.editingTarget?.id !== target.id || (runtimeEditingTargetId && runtimeEditingTargetId !== target.id)) {
    return buildFailureResult("Target workspace is not active yet", "validate_workspace_alignment", {
      targetId: target.id,
      editingTargetId: vm.editingTarget?.id || null,
      runtimeEditingTargetId,
      workspaceId: (workspace as any)?.id || null,
      targetTopBlockIds,
      workspaceTopBlockIds,
    });
  }

  if (!isRegisteredWorkspace(workspace, blockly)) {
    return buildFailureResult("Resolved Blockly workspace is no longer registered", "validate_workspace_registered", {
      targetId: target.id,
      workspaceId: (workspace as any)?.id || null,
      targetTopBlockIds,
      workspaceTopBlockIds,
    });
  }

  if (!workspaceContainsTargetTopBlocks(workspace, targetTopBlockIds)) {
    return buildFailureResult("Resolved Blockly workspace does not match the target", "validate_workspace_target", {
      targetId: target.id,
      workspaceId: (workspace as any)?.id || null,
      targetTopBlockIds,
      workspaceTopBlockIds,
    });
  }

  return null;
};

const validateRuntimeBlockOwner = async (
  vm: PluginContext["vm"],
  expectedTarget: Scratch.RenderTarget,
  insertedTopBlockId: string,
  stage: string,
  diagnostics: Record<string, unknown> = {},
) => {
  const owner = await waitForRuntimeBlockOwner(vm, insertedTopBlockId);
  if (owner?.id === expectedTarget.id) return null;

  return {
    success: false,
    error:
      "Inserted Scratch blocks were created in the wrong runtime target after switching workspaces; the change was rejected to avoid corrupting the project.",
    stage,
    diagnostics: {
      expectedTargetId: expectedTarget.id,
      expectedTargetName: typeof (expectedTarget as any).getName === "function" ? (expectedTarget as any).getName() : undefined,
      actualTargetId: owner?.id || null,
      actualTargetName: owner && typeof (owner as any).getName === "function" ? (owner as any).getName() : undefined,
      editingTargetId: vm.editingTarget?.id || null,
      insertedTopBlockId,
      ...diagnostics,
    },
  };
};

const validateRuntimeBlockRemoved = async (
  vm: PluginContext["vm"],
  removedBlockId: string,
  stage: string,
  diagnostics: Record<string, unknown> = {},
) => {
  const owner = await waitForRuntimeBlockRemoval(vm, removedBlockId);
  if (!owner) return null;

  return {
    success: false,
    error:
      "Deleted Scratch blocks are still present in the runtime after Blockly event synchronization; the change was rejected to avoid corrupting the project.",
    stage,
    diagnostics: {
      remainingBlockId: removedBlockId,
      remainingOwnerId: owner?.id || null,
      remainingOwnerName: owner && typeof (owner as any).getName === "function" ? (owner as any).getName() : undefined,
      editingTargetId: vm.editingTarget?.id || null,
      runtimeEditingTargetId: getRuntimeEditingTarget(vm)?.id || null,
      ...diagnostics,
    },
  };
};

const validateRuntimeTopLevelScriptRegistered = (
  expectedTarget: Scratch.RenderTarget,
  topBlockId: string,
  stage: string,
  diagnostics: Record<string, unknown> = {},
) => {
  const blocks = (expectedTarget as any)?.blocks;
  const scripts = Array.isArray(blocks?._scripts) ? blocks._scripts : [];
  const runtimeBlock = blocks?._blocks?.[topBlockId] || null;
  if (scripts.includes(topBlockId) && runtimeBlock?.topLevel === true) return null;

  return {
    success: false,
    error:
      "Inserted Scratch blocks exist in the runtime but are not registered as a top-level script, so they may disappear on the next workspace reload.",
    stage,
    diagnostics: {
      targetId: expectedTarget.id,
      targetName: typeof (expectedTarget as any).getName === "function" ? (expectedTarget as any).getName() : undefined,
      topBlockId,
      runtimeBlockExists: Boolean(runtimeBlock),
      runtimeBlockTopLevel: runtimeBlock?.topLevel ?? null,
      runtimeScriptIds: scripts.slice(0, 40),
      ...diagnostics,
    },
  };
};

const buildFailureResult = (error: string, stage: string, diagnostics: Record<string, unknown> = {}) => ({
  success: false,
  error,
  stage,
  diagnostics,
});

const getErrorMessage = (error: unknown, fallback: string) => {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  return fallback;
};

const getErrorStack = (error: unknown) => (error instanceof Error && error.stack ? error.stack.slice(0, 1600) : null);

const summarizeWorkspaceForGenerationError = (workspace: Blockly.WorkspaceSvg | null, blockly?: any) => {
  const workspaceLike = workspace as any;
  const proto = workspaceLike ? Object.getPrototypeOf(workspaceLike) : null;
  const scratchBlocks = getScratchBlocks(blockly, workspace);
  return {
    workspaceConstructor: workspaceLike?.constructor?.name || null,
    workspaceHasIsLocked: typeof workspaceLike?.isLocked === "function",
    workspaceOwnHasIsLocked: Boolean(workspaceLike && Object.prototype.hasOwnProperty.call(workspaceLike, "isLocked")),
    workspaceProtoHasIsLocked: typeof proto?.isLocked === "function",
    workspaceTargetWorkspaceHasIsLocked: typeof workspaceLike?.targetWorkspace?.isLocked === "function",
    workspaceSourceWorkspaceHasIsLocked: typeof workspaceLike?.sourceWorkspace?.isLocked === "function",
    blocklyWorkspaceProtoHasIsLocked: typeof scratchBlocks?.Workspace?.prototype?.isLocked === "function",
    blocklyWorkspaceSvgProtoHasIsLocked: typeof scratchBlocks?.WorkspaceSvg?.prototype?.isLocked === "function",
    workspaceKeys: workspaceLike ? Object.keys(workspaceLike).slice(0, 40) : [],
  };
};

const buildBlockGenerationFailureResult = (error: unknown, diagnostics: Record<string, unknown> = {}) => {
  const errorMessage = getErrorMessage(error, "Unknown block generation error");
  return buildFailureResult(
    `The converter passed, but Scratch workspace synchronization failed: ${errorMessage}. The submitted DSL was parsed successfully; do not rewrite valid DSL just for this error. Retry after the target workspace is ready, or report the workspace sync failure.`,
    "generate_blocks_exception",
    {
      ...diagnostics,
      syncFailureKind: "workspace_generation",
      aiActionHint:
        "DSL parsing already succeeded. If diagnostics for the preserved draft are valid, do not simplify or rewrite the DSL; treat this as a Scratch workspace synchronization failure.",
      errorStack: getErrorStack(error),
    },
  );
};

const applyBlockCommentsToWorkspace = (workspace: Blockly.WorkspaceSvg, blocksState: any[]) => {
  blocksState.forEach((blockState) => {
    if (typeof blockState.commentText !== "string" || !blockState.commentText.trim()) return;
    const block = workspace.getBlockById(blockState.id) as any;
    if (!block) return;

    if (typeof block.setCommentText === "function") {
      block.setCommentText(blockState.commentText);
    } else if (block.comment && typeof block.comment.setText === "function") {
      block.comment.setText(blockState.commentText);
    }
  });
};

export const getBlocksRangeUCF = (
  vm: PluginContext["vm"],
  _workspace: Blockly.WorkspaceSvg,
  startBlockId: string,
  endBlockId: string,
) => {
  const target = resolveTargetForRange(vm, startBlockId, endBlockId);
  const result = getRangeBlocks(target, startBlockId, endBlockId);
  if (!result.success) {
    return result;
  }

  const blocksArray = collectRangeRuntimeBlocks(target, result.rangeBlocks);
  return {
    success: true,
    ucf: toAnnotatedUCF([
      {
        blocks: blocksArray,
        statementBlockIds: result.rangeBlocks.map((block) => block.id),
      },
    ], vm.runtime),
    blockCount: result.rangeBlocks.length,
    startBlockId,
    endBlockId,
  };
};

export const getBlocksRangeBlockStates = (
  vm: PluginContext["vm"] | undefined,
  startBlockId: string,
  endBlockId: string,
) => {
  if (!vm || !startBlockId || !endBlockId) {
    return { success: false, error: "Range blocks not found" };
  }
  const target = resolveTargetForRange(vm, startBlockId, endBlockId);
  const result = getRangeBlocks(target, startBlockId, endBlockId);
  if (!result.success) {
    return result;
  }

  return {
    success: true,
    blocks: collectRangeRuntimeBlocks(target, result.rangeBlocks),
    blockCount: result.rangeBlocks.length,
    startBlockId,
    endBlockId,
  };
};

export const replaceBlocksRangeByUCF = async (
  vm: PluginContext["vm"],
  _workspace: Blockly.WorkspaceSvg,
  startBlockId: string,
  endBlockId: string,
  ucfString: string,
  options: { includeComments?: boolean; linkTopLevelStatements?: boolean; blockly?: any } = {},
) => {
  const target = resolveTargetForRange(vm, startBlockId, endBlockId);
  if (!target) {
    return buildFailureResult("Range blocks not found in runtime targets", "resolve_target", {
      startBlockId,
      endBlockId,
    });
  }

  const targetAlignment = await ensureEditingTargetWorkspaceRequested(vm, target.id, options.blockly, _workspace);
  if (!targetAlignment.editingTargetReady) {
    return buildFailureResult("Timed out while switching to the target workspace", "switch_editing_target", {
      targetId: target.id,
      editingTargetId: vm.editingTarget?.id || null,
      runtimeEditingTargetId: getRuntimeEditingTarget(vm)?.id || null,
      workspaceUpdateReceived: targetAlignment.workspaceUpdateReceived,
    });
  }

  const { workspace, scratchBlocks, diagnostics: workspaceDiagnostics } = await waitForResolvedWorkspaceForTarget(
    vm,
    target,
    _workspace,
    options.blockly,
  );
  if (!workspace) {
    return buildFailureResult("Blockly workspace is not available for the target", "resolve_workspace", {
      ...workspaceDiagnostics,
      debug: logWorkspaceUnavailable(
        "replaceBlocksRangeByUCF",
        vm,
        target,
        _workspace,
        options.blockly,
        {
          startBlockId,
          endBlockId,
          switchedTarget: targetAlignment.switchedTarget,
          workspaceUpdateReceived: targetAlignment.workspaceUpdateReceived,
          includeComments: options.includeComments === true,
          linkTopLevelStatements: options.linkTopLevelStatements === true,
        },
      ),
    });
  }
  if (!scratchBlocks?.Xml?.textToDom || !scratchBlocks?.Xml?.domToWorkspace || !scratchBlocks?.Events?.setGroup) {
    return buildFailureResult("Blockly XML APIs are not available for the resolved workspace", "resolve_blockly_xml", {
      ...workspaceDiagnostics,
    });
  }
  const alignmentFailure = validateWorkspaceReadyForMutation(vm, target, workspace, options.blockly);
  if (alignmentFailure) {
    return {
      ...alignmentFailure,
      diagnostics: {
        ...(alignmentFailure.diagnostics || {}),
        ...workspaceDiagnostics,
        targetAlignment,
      },
    };
  }
  const topLevelBefore = collectTopLevelBlockIds(workspace);
  const isReplacingTopLevelScript = topLevelBefore.includes(startBlockId);

  const startBlock = workspace.getBlockById(startBlockId) as Blockly.BlockSvg | null;
  const endBlock = workspace.getBlockById(endBlockId) as Blockly.BlockSvg | null;
  if (!startBlock || !endBlock) {
    return buildFailureResult("Range blocks not found in current workspace", "resolve_workspace_blocks", {
      startBlockId,
      endBlockId,
      hasStartBlock: Boolean(startBlock),
      hasEndBlock: Boolean(endBlock),
    });
  }

  const previousBlockId = (startBlock.previousConnection?.targetConnection as any)?.sourceBlock_?.id || null;
  const nextBlockId = (endBlock.nextConnection?.targetConnection as any)?.sourceBlock_?.id || null;
  const startXY = startBlock.getRelativeToSurfaceXY();

  const blocksToDelete: Blockly.BlockSvg[] = [];
  let collecting: Blockly.BlockSvg | null = startBlock;
  while (collecting) {
    blocksToDelete.push(collecting);
    if (collecting.id === endBlockId) break;
    collecting = collecting.getNextBlock() as Blockly.BlockSvg | null;
  }
  if (!blocksToDelete.length || blocksToDelete[blocksToDelete.length - 1]?.id !== endBlockId) {
    return buildFailureResult("Selected range is not a continuous next-chain in workspace", "resolve_range", {
      startBlockId,
      endBlockId,
      visitedBlockIds: blocksToDelete.map((block) => block.id),
      breakAtBlockId: blocksToDelete[blocksToDelete.length - 1]?.id || null,
    });
  }

  let newBlocksState: any[] = [];
  let topLevelBlockState: any = null;
  try {
    newBlocksState = ucfToScratch(normalizeModelUCF(ucfString), {
      runtime: vm.runtime,
      includeComments: options.includeComments === true,
      linkTopLevelStatements: options.linkTopLevelStatements === true,
    });
    if (!newBlocksState.length) {
      return buildFailureResult("Replacement UCF produced no blocks", "parse_replacement", {
        startBlockId,
        endBlockId,
      });
    }
    const topLevelBlocks = newBlocksState.filter((blockState) => blockState.topLevel);
    if (topLevelBlocks.length !== 1) {
      return buildFailureResult(
        "Replacement UCF must contain exactly one top-level stack",
        "validate_replacement_topology",
        {
          startBlockId,
          endBlockId,
          topLevelBlockCount: topLevelBlocks.length,
        },
      );
    }
    topLevelBlockState = topLevelBlocks[0];
    topLevelBlockState.x = startXY.x;
    topLevelBlockState.y = startXY.y;
  } catch (error) {
    return buildFailureResult(getErrorMessage(error, "Failed to parse replacement UCF"), "parse_replacement_exception", {
      startBlockId,
      endBlockId,
    });
  }

  let mutationStarted = false;
  try {
    resolveVariableReferences(vm, workspace, newBlocksState, scratchBlocks);
    const xmlText = blockStatesToXml(newBlocksState);

    scratchBlocks.Events.setGroup(true);
    mutationStarted = true;


    if (startBlock.previousConnection?.isConnected()) {
      startBlock.previousConnection.disconnect();
    }
    if (endBlock.nextConnection?.isConnected()) {
      endBlock.nextConnection.disconnect();
    }
    setTimeout(() => {
      workspace.fireDeletionListeners(startBlock);
    });
    startBlock.dispose(false, true);


    const xmlDom = scratchBlocks.Xml.textToDom(xmlText);
    scratchBlocks.Xml.domToWorkspace(xmlDom, workspace);
    applyBlockCommentsToWorkspace(workspace, newBlocksState);
    repairListVariableValues(vm, target.id);

    let insertedBlock = workspace.getBlockById(topLevelBlockState.id) as Blockly.BlockSvg | null;
    if (!insertedBlock) {
      await new Promise((resolve) => window.setTimeout(resolve, 60));
      insertedBlock = workspace.getBlockById(topLevelBlockState.id) as Blockly.BlockSvg | null;
    }
    if (!insertedBlock) {
      return buildFailureResult("Inserted block not found", "locate_inserted_block", {
        startBlockId,
        endBlockId,
        insertedTopBlockId: topLevelBlockState.id,
      });
    }

    let reconnectedPrevious = false;
    let reconnectedNext = false;
    const previousBlock = previousBlockId ? (workspace.getBlockById(previousBlockId) as Blockly.BlockSvg | null) : null;
    const nextBlock = nextBlockId ? (workspace.getBlockById(nextBlockId) as Blockly.BlockSvg | null) : null;

    if (
      previousBlock?.nextConnection &&
      insertedBlock.previousConnection &&
      previousBlock.nextConnection.checkType_(insertedBlock.previousConnection)
    ) {
      previousBlock.nextConnection.connect(insertedBlock.previousConnection);
      reconnectedPrevious = true;
    }

    let lastInsertedBlock = insertedBlock;
    while (lastInsertedBlock.getNextBlock()) {
      lastInsertedBlock = lastInsertedBlock.getNextBlock() as Blockly.BlockSvg;
    }

    if (
      nextBlock?.previousConnection &&
      lastInsertedBlock.nextConnection &&
      lastInsertedBlock.nextConnection.checkType_(nextBlock.previousConnection)
    ) {
      lastInsertedBlock.nextConnection.connect(nextBlock.previousConnection);
      reconnectedNext = true;
    }


    const requiresPreviousReconnect = Boolean(previousBlockId);
    const requiresNextReconnect = Boolean(nextBlockId);
    if ((requiresPreviousReconnect && !reconnectedPrevious) || (requiresNextReconnect && !reconnectedNext)) {
      insertedBlock.dispose(false, true);
      return buildFailureResult(
        "Replacement inserted new blocks but failed to reconnect the range boundaries safely",
        "reconnect_boundaries",
        {
          startBlockId,
          endBlockId,
          previousBlockId,
          nextBlockId,
          insertedTopBlockId: insertedBlock.id,
          lastInsertedBlockId: lastInsertedBlock.id,
          reconnectedPrevious,
          reconnectedNext,
          visitedDeletedBlockIds: blocksToDelete.map((block) => block.id),
        },
      );
    }

    const topLevelAfter = collectTopLevelBlockIds(workspace);
    const orphanTopLevelBlockIds = topLevelAfter.filter(
      (blockId) => !topLevelBefore.includes(blockId) && blockId !== insertedBlock?.id,
    );

    if (orphanTopLevelBlockIds.length > 0) {
      insertedBlock.dispose(false, true);
      return buildFailureResult(
        "Replacement created unexpected top-level orphan blocks",
        "validate_workspace_after_replace",
        {
          startBlockId,
          endBlockId,
          insertedTopBlockId: insertedBlock.id,
          orphanTopLevelBlockIds,
          topLevelBefore,
          topLevelAfter,
        },
      );
    }

    scratchBlocks.Events.setGroup(false);
    await waitForBlocklyEventFlush(scratchBlocks);

    const ownerFailure = await validateRuntimeBlockOwner(
      vm,
      target,
      insertedBlock.id,
      "validate_runtime_target_after_replace",
      {
        startBlockId,
        endBlockId,
        topLevelBefore,
        topLevelAfter,
      },
    );
    if (ownerFailure) {
      insertedBlock.dispose(false, true);
      await waitForBlocklyEventFlush(scratchBlocks);
      logWorkspaceIntegrityWarning("replaceBlocksRangeByUCF.runtimeOwnerMismatch", ownerFailure.diagnostics || ownerFailure);
      return ownerFailure;
    }

    const scriptRegistrationFailure = isReplacingTopLevelScript
      ? validateRuntimeTopLevelScriptRegistered(target, insertedBlock.id, "validate_runtime_script_after_replace", {
          startBlockId,
          endBlockId,
          insertedTopBlockId: insertedBlock.id,
          topLevelBefore,
          topLevelAfter,
        })
      : null;
    if (scriptRegistrationFailure) {
      insertedBlock.dispose(false, true);
      await waitForBlocklyEventFlush(scratchBlocks);
      logWorkspaceIntegrityWarning(
        "replaceBlocksRangeByUCF.runtimeScriptRegistrationMismatch",
        scriptRegistrationFailure.diagnostics || scriptRegistrationFailure,
      );
      return scriptRegistrationFailure;
    }

    const removalFailure =
      startBlockId !== insertedBlock.id
        ? await validateRuntimeBlockRemoved(vm, startBlockId, "validate_runtime_removed_after_replace", {
            startBlockId,
            endBlockId,
            insertedTopBlockId: insertedBlock.id,
            topLevelBefore,
            topLevelAfter,
          })
        : null;
    if (removalFailure) {
      insertedBlock.dispose(false, true);
      await waitForBlocklyEventFlush(scratchBlocks);
      logWorkspaceIntegrityWarning("replaceBlocksRangeByUCF.runtimeRemovalMismatch", removalFailure.diagnostics || removalFailure);
      return removalFailure;
    }

    return {
      success: true,
      insertedTopBlockId: insertedBlock.id,
      blockCount: newBlocksState.length,
      reconnectedPrevious,
      reconnectedNext,
      diagnostics: {
        previousBlockId,
        nextBlockId,
        lastInsertedBlockId: lastInsertedBlock.id,
        orphanTopLevelBlockIds,
        runtimeOwnerWarning: ownerFailure?.diagnostics || null,
        runtimeScriptRegistrationWarning: scriptRegistrationFailure?.diagnostics || null,
        runtimeRemovalWarning: removalFailure?.diagnostics || null,
        topLevelBefore,
        topLevelAfter,
        targetAlignment,
      },
    };
  } catch (error) {
    return buildBlockGenerationFailureResult(error, {
      startBlockId,
      endBlockId,
      blockCount: newBlocksState.length,
      parsedOpcodes: [...new Set(newBlocksState.map((blockState) => blockState.opcode))].slice(0, 40),
      workspaceGenerationDebug: summarizeWorkspaceForGenerationError(workspace, scratchBlocks),
      ...workspaceDiagnostics,
    });
  } finally {
    scratchBlocks?.Events?.setGroup?.(false);
    if (mutationStarted) {
      await waitForBlocklyEventFlush(scratchBlocks);
    }
  }
};

export const replaceScriptByUCF = async (
  vm: PluginContext["vm"],
  workspace: Blockly.WorkspaceSvg,
  scriptId: string,
  ucfString: string,
  options: { includeComments?: boolean; blockly?: any } = {},
) => {
  const target = vm.runtime.targets.find((item) => item.blocks?._blocks?.[scriptId]) || null;
  if (!target) {
    return buildFailureResult("Script not found in runtime targets", "resolve_script_target", { scriptId });
  }

  const boundary = getScriptBoundaryIds(target, scriptId);
  if (!boundary.success) {
    return buildFailureResult(boundary.error, "resolve_script_boundaries", {
      scriptId,
      targetId: target.id,
    });
  }

  const result = await replaceBlocksRangeByUCF(vm, workspace, boundary.startBlockId, boundary.endBlockId, ucfString, {
    includeComments: options.includeComments === true,
    blockly: options.blockly,
  });
  return {
    ...result,
    diagnostics: {
      scriptId,
      targetId: target.id,
      startBlockId: boundary.startBlockId,
      endBlockId: boundary.endBlockId,
      scriptBlockCount: boundary.blockCount,
      ...(result.diagnostics || {}),
    },
  };
};

export const insertScriptByUCF = async (
  vm: PluginContext["vm"],
  _workspace: Blockly.WorkspaceSvg,
  targetId: string,
  ucfString: string,
  options: { includeComments?: boolean; blockly?: any } = {},
) => {
  const target = targetId ? vm.runtime.getTargetById(targetId) : vm.editingTarget;
  if (!target) {
    return buildFailureResult("Target not found", "resolve_target", { targetId });
  }

  const targetAlignment = await ensureEditingTargetWorkspaceRequested(vm, target.id, options.blockly, _workspace);
  if (!targetAlignment.editingTargetReady) {
    return buildFailureResult("Timed out while switching to the target workspace", "switch_editing_target", {
      targetId: target.id,
      editingTargetId: vm.editingTarget?.id || null,
      runtimeEditingTargetId: getRuntimeEditingTarget(vm)?.id || null,
      workspaceUpdateReceived: targetAlignment.workspaceUpdateReceived,
    });
  }

  const { workspace, scratchBlocks, diagnostics: workspaceDiagnostics } = await waitForResolvedWorkspaceForTarget(
    vm,
    target,
    _workspace,
    options.blockly,
  );
  if (!workspace) {
    return buildFailureResult("Blockly workspace is not available for the target", "resolve_workspace", {
      ...workspaceDiagnostics,
      debug: logWorkspaceUnavailable("insertScriptByUCF", vm, target, _workspace, options.blockly, {
        targetId: target.id,
        requestedTargetId: targetId,
        switchedTarget: targetAlignment.switchedTarget,
        workspaceUpdateReceived: targetAlignment.workspaceUpdateReceived,
        includeComments: options.includeComments === true,
      }),
    });
  }
  if (!scratchBlocks?.Xml?.textToDom || !scratchBlocks?.Xml?.domToWorkspace || !scratchBlocks?.Events?.setGroup) {
    return buildFailureResult("Blockly XML APIs are not available for the resolved workspace", "resolve_blockly_xml", {
      ...workspaceDiagnostics,
    });
  }
  const alignmentFailure = validateWorkspaceReadyForMutation(vm, target, workspace, options.blockly);
  if (alignmentFailure) {
    return {
      ...alignmentFailure,
      diagnostics: {
        ...(alignmentFailure.diagnostics || {}),
        ...workspaceDiagnostics,
        targetAlignment,
      },
    };
  }
  const topLevelBefore = collectTopLevelBlockIds(workspace);
  let parsedBlockDiagnostics: Record<string, unknown> = {};
  let newBlocksState: any[] = [];
  let topLevelBlockState: any = null;

  try {
    newBlocksState = ucfToScratch(normalizeModelUCF(ucfString), {
      runtime: vm.runtime,
      includeComments: options.includeComments === true,
    });
    parsedBlockDiagnostics = {
      parsedBlockCount: newBlocksState.length,
      parsedTopLevelBlocks: newBlocksState.filter((blockState) => blockState.topLevel).map((blockState) => ({
        id: blockState.id,
        opcode: blockState.opcode,
      })),
      parsedOpcodes: [...new Set(newBlocksState.map((blockState) => blockState.opcode))].slice(0, 40),
    };
    if (!newBlocksState.length) {
      return buildFailureResult("Inserted UCF produced no blocks", "parse_insert", { targetId: target.id });
    }

    const topLevelBlocks = newBlocksState.filter((blockState) => blockState.topLevel);
    if (topLevelBlocks.length !== 1) {
      return buildFailureResult("Inserted UCF must contain exactly one top-level stack", "validate_insert_topology", {
        targetId: target.id,
        topLevelBlockCount: topLevelBlocks.length,
      });
    }
    topLevelBlockState = topLevelBlocks[0];
  } catch (error) {
    return buildFailureResult(getErrorMessage(error, "Failed to parse inserted UCF"), "parse_insert_exception", {
      targetId: target.id,
    });
  }

  let mutationStarted = false;
  try {
    resolveVariableReferences(vm, workspace, newBlocksState, scratchBlocks);
    const xmlText = blockStatesToXml(newBlocksState);

    scratchBlocks.Events.setGroup(true);
    mutationStarted = true;
    const xmlDom = scratchBlocks.Xml.textToDom(xmlText);
    scratchBlocks.Xml.domToWorkspace(xmlDom, workspace);
    applyBlockCommentsToWorkspace(workspace, newBlocksState);
    repairListVariableValues(vm, target.id);

    let insertedBlock = workspace.getBlockById(topLevelBlockState.id) as Blockly.BlockSvg | null;
    if (!insertedBlock) {
      await new Promise((resolve) => window.setTimeout(resolve, 60));
      insertedBlock = workspace.getBlockById(topLevelBlockState.id) as Blockly.BlockSvg | null;
    }
    if (!insertedBlock) {
      return buildFailureResult("Inserted top-level block not found in workspace", "locate_inserted_block", {
        targetId: target.id,
        insertedTopBlockId: topLevelBlockState.id,
      });
    }

    const topLevelAfter = collectTopLevelBlockIds(workspace);
    const newTopLevelBlockIds = topLevelAfter.filter((blockId) => !topLevelBefore.includes(blockId));

    if (!newTopLevelBlockIds.includes(insertedBlock.id)) {
      insertedBlock.dispose(false, true);
      return buildFailureResult("Inserted script did not create a visible top-level workspace block", "validate_insert", {
        targetId: target.id,
        insertedTopBlockId: insertedBlock.id,
        topLevelBefore,
        topLevelAfter,
      });
    }

    scratchBlocks.Events.setGroup(false);
    await waitForBlocklyEventFlush(scratchBlocks);

    const ownerFailure = await validateRuntimeBlockOwner(vm, target, insertedBlock.id, "validate_runtime_target_after_insert", {
      topLevelBefore,
      topLevelAfter,
      newTopLevelBlockIds,
    });
    if (ownerFailure) {
      insertedBlock.dispose(false, true);
      await waitForBlocklyEventFlush(scratchBlocks);
      logWorkspaceIntegrityWarning("insertScriptByUCF.runtimeOwnerMismatch", ownerFailure.diagnostics || ownerFailure);
      return ownerFailure;
    }

    const scriptRegistrationFailure = validateRuntimeTopLevelScriptRegistered(
      target,
      insertedBlock.id,
      "validate_runtime_script_after_insert",
      {
        topLevelBefore,
        topLevelAfter,
        newTopLevelBlockIds,
      },
    );
    if (scriptRegistrationFailure) {
      insertedBlock.dispose(false, true);
      await waitForBlocklyEventFlush(scratchBlocks);
      logWorkspaceIntegrityWarning(
        "insertScriptByUCF.runtimeScriptRegistrationMismatch",
        scriptRegistrationFailure.diagnostics || scriptRegistrationFailure,
      );
      return scriptRegistrationFailure;
    }

    return {
      success: true,
      insertedTopBlockId: insertedBlock.id,
      targetId: target.id,
      blockCount: newBlocksState.length,
      diagnostics: {
        topLevelBefore,
        topLevelAfter,
        newTopLevelBlockIds,
        runtimeOwnerWarning: ownerFailure?.diagnostics || null,
        runtimeScriptRegistrationWarning: scriptRegistrationFailure?.diagnostics || null,
        targetAlignment,
      },
    };
  } catch (error) {
    return buildBlockGenerationFailureResult(error, {
      targetId: target.id,
      workspaceGenerationDebug: summarizeWorkspaceForGenerationError(workspace, scratchBlocks),
      ...workspaceDiagnostics,
      ...parsedBlockDiagnostics,
    });
  } finally {
    scratchBlocks?.Events?.setGroup?.(false);
    if (mutationStarted) {
      await waitForBlocklyEventFlush(scratchBlocks);
    }
  }
};

export const deleteScriptById = async (
  vm: PluginContext["vm"],
  _workspace: Blockly.WorkspaceSvg,
  scriptId: string,
  blockly?: any,
) => {
  const target = vm.runtime.targets.find((item) => item.blocks?._blocks?.[scriptId]) || null;
  if (!target) {
    return buildFailureResult("Script not found in runtime targets", "resolve_script_target", { scriptId });
  }

  const boundary = getScriptBoundaryIds(target, scriptId);
  if (!boundary.success) {
    return buildFailureResult(boundary.error, "resolve_script_boundaries", {
      scriptId,
      targetId: target.id,
    });
  }

  const targetAlignment = await ensureEditingTargetWorkspaceRequested(vm, target.id, blockly, _workspace);
  if (!targetAlignment.editingTargetReady) {
    return buildFailureResult("Timed out while switching to the target workspace", "switch_editing_target", {
      targetId: target.id,
      editingTargetId: vm.editingTarget?.id || null,
      runtimeEditingTargetId: getRuntimeEditingTarget(vm)?.id || null,
      workspaceUpdateReceived: targetAlignment.workspaceUpdateReceived,
    });
  }

  const { workspace, scratchBlocks, diagnostics: workspaceDiagnostics } = await waitForResolvedWorkspaceForTarget(
    vm,
    target,
    _workspace,
    blockly,
  );
  if (!workspace) {
    return buildFailureResult("Blockly workspace is not available for the target", "resolve_workspace", {
      ...workspaceDiagnostics,
      debug: logWorkspaceUnavailable("deleteScriptById", vm, target, _workspace, blockly, {
        scriptId,
        targetId: target.id,
        switchedTarget: targetAlignment.switchedTarget,
        workspaceUpdateReceived: targetAlignment.workspaceUpdateReceived,
      }),
    });
  }
  if (!scratchBlocks?.Events?.setGroup) {
    return buildFailureResult("Blockly Events API is not available for the resolved workspace", "resolve_blockly_events", {
      ...workspaceDiagnostics,
    });
  }
  const alignmentFailure = validateWorkspaceReadyForMutation(vm, target, workspace, blockly);
  if (alignmentFailure) {
    return {
      ...alignmentFailure,
      diagnostics: {
        ...(alignmentFailure.diagnostics || {}),
        ...workspaceDiagnostics,
        targetAlignment,
      },
    };
  }
  const topBlock = workspace.getBlockById(scriptId) as Blockly.BlockSvg | null;
  if (!topBlock) {
    return buildFailureResult("Script not found in current workspace", "resolve_workspace_script", {
      scriptId,
      targetId: target.id,
    });
  }

  let mutationStarted = false;
  try {
    scratchBlocks.Events.setGroup(true);
    mutationStarted = true;
    setTimeout(() => {
      workspace.fireDeletionListeners(topBlock);
    });
    topBlock.dispose(false, true);
    scratchBlocks.Events.setGroup(false);
    await waitForBlocklyEventFlush(scratchBlocks);
    const removalFailure = await validateRuntimeBlockRemoved(vm, scriptId, "validate_runtime_removed_after_delete", {
      scriptId,
      targetId: target.id,
      blockCount: boundary.blockCount,
      targetAlignment,
    });
    if (removalFailure) {
      logWorkspaceIntegrityWarning("deleteScriptById.runtimeRemovalMismatch", removalFailure.diagnostics || removalFailure);
      return removalFailure;
    }
    return {
      success: true,
      deletedScriptId: scriptId,
      targetId: target.id,
      blockCount: boundary.blockCount,
      diagnostics: {
        targetAlignment,
      },
    };
  } catch (error) {
    return buildFailureResult(error instanceof Error ? error.message : "Failed to delete script", "exception", {
      scriptId,
      targetId: target.id,
      ...workspaceDiagnostics,
    });
  } finally {
    scratchBlocks?.Events?.setGroup?.(false);
    if (mutationStarted) {
      await waitForBlocklyEventFlush(scratchBlocks);
    }
  }
};
