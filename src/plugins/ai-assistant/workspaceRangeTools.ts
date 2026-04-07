import { scratchToUCF, ucfToScratch } from "./ucf";

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

const blockStatesToXml = (blocksState: any[]) => {
  const blocksMap = new Map(blocksState.map((blockState) => [blockState.id, blockState]));
  const topLevelBlocks = blocksState.filter((blockState) => blockState.topLevel);
  return `<xml xmlns="http://www.w3.org/1999/xhtml">${topLevelBlocks
    .map((blockState) => blockStateToXml(blockState.id, blocksMap))
    .join("")}</xml>`;
};

const resolveVariableReferences = (vm: PluginContext["vm"], workspace: Blockly.WorkspaceSvg, blocksState: any[]) => {
  const existingVariables = workspace.getAllVariables().map((item: any) => ({
    id: item.id_ || item.id,
    name: item.name,
    type: item.type || "",
  }));

  blocksState.forEach((blockState) => {
    Object.values(blockState.fields || {}).forEach((field: any) => {
      if (field.name !== "VARIABLE" && field.name !== "LIST" && field.name !== "LIST_MENU") return;

      const variableType = field.name === "VARIABLE" ? "" : "list";
      const existingVariable = existingVariables.find(
        (item) => item.name === field.value && item.type === variableType,
      );
      if (existingVariable) {
        field.id = existingVariable.id;
        field.variableType = variableType;
        return;
      }

      vm.editingTarget?.createVariable(field.id, field.value, variableType, false);
      existingVariables.push({
        id: field.id,
        name: field.value,
        type: variableType,
      });
      field.variableType = variableType;
    });
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
    ucf: scratchToUCF(blocksArray),
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
) => {
  const target = resolveTargetForRange(vm, startBlockId, endBlockId);
  console.log("[AI Assistant Range Replace] resolved runtime target", {
    startBlockId,
    endBlockId,
    targetId: target?.id || null,
    editingTargetId: vm.editingTarget?.id || null,
  });
  if (!target) {
    return { success: false, error: "Range blocks not found in runtime targets" };
  }

  if (vm.editingTarget?.id !== target.id) {
    console.log("[AI Assistant Range Replace] switching editing target", { from: vm.editingTarget?.id, to: target.id });
    vm.setEditingTarget(target.id);
    await new Promise((resolve) => window.setTimeout(resolve, 60));
  }

  const workspace = _workspace || (window.Blockly.getMainWorkspace() as Blockly.WorkspaceSvg);

  const startBlock = workspace.getBlockById(startBlockId) as Blockly.BlockSvg | null;
  const endBlock = workspace.getBlockById(endBlockId) as Blockly.BlockSvg | null;
  if (!startBlock || !endBlock) {
    return { success: false, error: "Range blocks not found in current workspace" };
  }

  const previousBlockId = startBlock.previousConnection?.targetConnection?.sourceBlock_?.id || null;
  const nextBlockId = endBlock.nextConnection?.targetConnection?.sourceBlock_?.id || null;
  const startXY = startBlock.getRelativeToSurfaceXY();

  const blocksToDelete: Blockly.BlockSvg[] = [];
  let collecting: Blockly.BlockSvg | null = startBlock;
  while (collecting) {
    blocksToDelete.push(collecting);
    if (collecting.id === endBlockId) break;
    collecting = collecting.getNextBlock() as Blockly.BlockSvg | null;
  }
  if (!blocksToDelete.length || blocksToDelete[blocksToDelete.length - 1]?.id !== endBlockId) {
    return { success: false, error: "Selected range is not a continuous next-chain in workspace" };
  }

  try {
    const newBlocksState = ucfToScratch(ucfString);
    if (!newBlocksState.length) {
      return { success: false, error: "Replacement UCF produced no blocks" };
    }
    const topLevelBlocks = newBlocksState.filter((blockState) => blockState.topLevel);
    if (topLevelBlocks.length !== 1) {
      return { success: false, error: "Replacement UCF must contain exactly one top-level stack" };
    }
    const topLevelBlockState = topLevelBlocks[0];
    topLevelBlockState.x = startXY.x;
    topLevelBlockState.y = startXY.y;
    resolveVariableReferences(vm, workspace, newBlocksState);
    const xmlText = blockStatesToXml(newBlocksState);

    window.Blockly.Events.setGroup(true);

    console.log("[AI Assistant Range Replace] before delete", {
      startBlockId,
      endBlockId,
      blocksToDelete: blocksToDelete.map((block) => block.id),
      previousBlockId,
      nextBlockId,
    });

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

    console.log("[AI Assistant Range Replace] after delete", {
      remainingStart: workspace.getBlockById(startBlockId)?.id || null,
      remainingEnd: workspace.getBlockById(endBlockId)?.id || null,
    });

    const xmlDom = window.Blockly.Xml.textToDom(xmlText);
    window.Blockly.Xml.domToWorkspace(xmlDom, workspace);

    let insertedBlock = workspace.getBlockById(topLevelBlockState.id) as Blockly.BlockSvg | null;
    if (!insertedBlock) {
      await new Promise((resolve) => window.setTimeout(resolve, 60));
      insertedBlock = workspace.getBlockById(topLevelBlockState.id) as Blockly.BlockSvg | null;
    }
    if (!insertedBlock) {
      return { success: false, error: "Inserted block not found" };
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

    console.log("[AI Assistant Range Replace] reconnect result", {
      insertedTopBlockId: insertedBlock.id,
      lastInsertedBlockId: lastInsertedBlock.id,
      reconnectedPrevious,
      reconnectedNext,
    });

    const requiresPreviousReconnect = Boolean(previousBlockId);
    const requiresNextReconnect = Boolean(nextBlockId);
    if ((requiresPreviousReconnect && !reconnectedPrevious) || (requiresNextReconnect && !reconnectedNext)) {
      return {
        success: false,
        error: "Replacement inserted new blocks but failed to reconnect the range boundaries safely",
      };
    }

    return {
      success: true,
      insertedTopBlockId: insertedBlock.id,
      blockCount: newBlocksState.length,
      reconnectedPrevious,
      reconnectedNext,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to replace block range",
    };
  } finally {
    window.Blockly.Events.setGroup(false);
  }
};
