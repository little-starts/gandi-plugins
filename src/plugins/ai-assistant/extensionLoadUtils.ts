import { APPROVED_EXTENSION_INDEX, APPROVED_EXTENSION_INDEX_BY_ID, ApprovedExtensionIndexEntry } from "./approvedExtensionIndex";

export const AI_PREVIEW_FALLBACK_BLOCK_MARKER = "__aiAssistantPreviewFallbackBlock";
export const AI_PREVIEW_FALLBACK_EXTENSION_ID = "__aiAssistantPreviewFallbackExtensionId";
export const AI_ASSISTANT_EXTENSIONS_LOADED_EVENT = "ai-assistant:extensions-loaded";

export const normalizeApprovedExtensionId = (extensionId: string) => String(extensionId || "").trim().replace(/^ext_/i, "");

export const getApprovedExtensionEntry = (extensionId: string) => {
  const requestedId = normalizeApprovedExtensionId(extensionId);
  if (!requestedId) return null;
  return (
    APPROVED_EXTENSION_INDEX_BY_ID.get(requestedId.toLowerCase()) ||
    APPROVED_EXTENSION_INDEX.find((item) => item.extensionId.toLowerCase().replace(/^ext_/, "") === requestedId.toLowerCase()) ||
    null
  );
};

export const isApprovedExtensionLoaded = (vm: PluginContext["vm"] | undefined, extensionId: string) => {
  const requestedId = normalizeApprovedExtensionId(extensionId);
  if (!requestedId) return false;
  const extension = getApprovedExtensionEntry(requestedId);
  const candidates = Array.from(new Set([requestedId, extension?.extensionId].filter(Boolean) as string[]));
  const extensionManager = vm?.extensionManager;
  return candidates.some(
    (id) =>
      Boolean(extensionManager?.isExtensionLoaded?.(id)) ||
      Boolean(extensionManager?._loadedExtensions?.has?.(id)),
  );
};

export const resolveApprovedExtensionForPreviewOpcode = (
  opcode: string,
  blockInfo?: any,
): ApprovedExtensionIndexEntry | null => {
  const candidates = [
    blockInfo?.extensionId,
    blockInfo?.extensionID,
    blockInfo?.category,
    String(opcode || "").split("_")[0],
  ]
    .map((item) => normalizeApprovedExtensionId(String(item || "")))
    .filter(Boolean);

  for (const candidate of candidates) {
    const entry = getApprovedExtensionEntry(candidate);
    if (entry) return entry;
  }

  return null;
};

export const getApprovedExtensionDisplayName = (extensionId: string) => {
  const entry = getApprovedExtensionEntry(extensionId);
  return entry?.name || normalizeApprovedExtensionId(extensionId);
};

export const formatLoadExtensionsConfirmMessage = (extensionIds: string[]) => {
  const names = Array.from(new Set(extensionIds.map(getApprovedExtensionDisplayName).filter(Boolean))).join("、");
  return `确认加载扩展 ${names} 吗？`;
};

export const loadApprovedExtensions = async (vm: PluginContext["vm"] | undefined, extensionIds: string[]) => {
  const extensionManager = vm?.extensionManager;
  if (!extensionManager?.loadExternalExtensionById) {
    throw new Error("当前 VM 不支持加载扩展。");
  }

  const uniqueIds = Array.from(new Set(extensionIds.map(normalizeApprovedExtensionId).filter(Boolean)));
  const results = [];
  for (const requestedId of uniqueIds) {
    const extension = getApprovedExtensionEntry(requestedId);
    if (!extension) {
      results.push({
        success: false,
        extensionId: requestedId,
        name: requestedId,
        error: `扩展不在可用列表中：${requestedId}`,
      });
      continue;
    }
    if (extension.disabled) {
      results.push({
        success: false,
        extensionId: extension.extensionId,
        name: extension.name,
        error: `扩展当前不可用：${extension.name}`,
      });
      continue;
    }

    const wasLoaded =
      Boolean(extensionManager.isExtensionLoaded?.(extension.extensionId)) ||
      Boolean(extensionManager._loadedExtensions?.has?.(extension.extensionId));
    if (!wasLoaded) {
      const loadResult = extensionManager.loadExternalExtensionById(extension.extensionId);
      if (loadResult && typeof (loadResult as Promise<unknown>).then === "function") {
        await loadResult;
      }
    }

    const loaded =
      Boolean(extensionManager.isExtensionLoaded?.(extension.extensionId)) ||
      Boolean(extensionManager._loadedExtensions?.has?.(extension.extensionId));
    results.push({
      success: loaded,
      extensionId: extension.extensionId,
      name: extension.name,
      error: loaded ? undefined : `扩展加载完成后仍未标记为已加载：${extension.name}`,
    });
  }

  return {
    success: results.every((result) => result.success),
    results,
  };
};

export const clearPreviewFallbackBlocksForExtensions = (extensionIds: string[], blockly?: any) => {
  const scratchBlocks = blockly || (window as any)?.Blockly || (window as any)?.ScratchBlocks || null;
  const blocks = scratchBlocks?.Blocks;
  if (!blocks) return;

  const normalizedIds = new Set(extensionIds.map(normalizeApprovedExtensionId).map((id) => id.toLowerCase()).filter(Boolean));
  Object.keys(blocks).forEach((opcode) => {
    const definition = blocks[opcode];
    if (!definition?.[AI_PREVIEW_FALLBACK_BLOCK_MARKER]) return;
    const extensionId = normalizeApprovedExtensionId(definition?.[AI_PREVIEW_FALLBACK_EXTENSION_ID] || opcode.split("_")[0] || "").toLowerCase();
    if (normalizedIds.has(extensionId)) {
      delete blocks[opcode];
    }
  });
};

export const notifyApprovedExtensionsLoaded = (extensionIds: string[]) => {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent(AI_ASSISTANT_EXTENSIONS_LOADED_EVENT, {
      detail: {
        extensionIds: Array.from(new Set(extensionIds.map(normalizeApprovedExtensionId).filter(Boolean))),
      },
    }),
  );
};
