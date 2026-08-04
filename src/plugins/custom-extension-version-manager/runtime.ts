import { ManagedCustomExtension } from "./types";

type CustomExtensionInfo = Extension & {
  replaceable?: boolean;
  url?: string;
};

type VersionManagerExtensionManager = Scratch.ExtensionManager & {
  _customExtensionInfo: Record<string, CustomExtensionInfo>;
  getLoadedExtensionURLs(): Record<string, string>;
};

const normalizeLoadResult = (result: unknown): string[] => {
  if (typeof result === "string") return [result];
  if (!Array.isArray(result)) return [];

  const flattened: string[] = [];
  const append = (items: unknown[]) => {
    items.forEach((item) => {
      if (typeof item === "string") {
        flattened.push(item);
      } else if (Array.isArray(item)) {
        append(item);
      }
    });
  };
  append(result);
  return flattened;
};

export const getLoadedCustomExtensions = (vm: PluginContext["vm"]): ManagedCustomExtension[] => {
  const manager = vm.extensionManager as VersionManagerExtensionManager;
  const loadedUrls = manager.getLoadedExtensionURLs?.() || {};
  const wildExtensions = vm.runtime.gandi?.wildExtensions || {};

  return Object.entries(manager._customExtensionInfo || {})
    .filter(([extensionId]) => manager.isExtensionLoaded(extensionId))
    .map(([extensionId, extension]) => ({
      id: extensionId,
      name: extension.info?.name || extensionId,
      currentUrl: loadedUrls[extensionId] || extension.url || wildExtensions[extensionId]?.url || "",
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
};

const refreshWorkspace = (vm: PluginContext["vm"], workspace: PluginContext["workspace"]) => {
  setTimeout(() => {
    const flyout = workspace?.getFlyout?.();
    const previousRefreshState = workspace?.toolboxRefreshEnabled_;

    try {
      flyout?.setRecyclingEnabled?.(false);
      if (workspace) {
        workspace.toolboxRefreshEnabled_ = true;
        workspace.refreshToolboxSelection_?.();
        workspace.toolboxRefreshEnabled_ = previousRefreshState;
      }
    } finally {
      flyout?.setRecyclingEnabled?.(true);
    }

    vm.emitWorkspaceUpdate?.();
  }, 0);
};

const restorePreviousMetadata = async (
  manager: VersionManagerExtensionManager,
  extensionId: string,
  previousInfo: CustomExtensionInfo | undefined,
  previousUrl: string,
) => {
  if (previousUrl) {
    try {
      await manager.loadExternalExtensionToLibrary(previousUrl, true, true);
    } catch {
      // The running service remains the old one when replacement validation fails.
      // Restoring its cached constructor is best-effort; metadata is restored below.
    }
  }

  if (previousInfo) {
    manager._customExtensionInfo[extensionId] = previousInfo;
  }
  if (previousUrl) {
    manager.saveWildExtensionsURL(extensionId, previousUrl);
  }
};

export const switchCustomExtensionVersion = async (
  vm: PluginContext["vm"],
  workspace: PluginContext["workspace"],
  extensionId: string,
  url: string,
) => {
  const manager = vm.extensionManager as VersionManagerExtensionManager;
  const previousInfo = manager._customExtensionInfo[extensionId];
  const previousUrl = manager.getLoadedExtensionURLs?.()?.[extensionId] || previousInfo?.url || "";
  const loadedBefore = new Set(manager._loadedExtensions.keys());

  try {
    const result = await manager.loadExtensionURL(url, true);
    const loadedIds = normalizeLoadResult(result);
    const newlyLoadedIds = Array.from(manager._loadedExtensions.keys()).filter((id) => !loadedBefore.has(id));
    const unexpectedIds = Array.from(new Set([...loadedIds, ...newlyLoadedIds])).filter(
      (id) => id !== extensionId && !loadedBefore.has(id),
    );

    unexpectedIds.forEach((id) => {
      if (manager.isExtensionLoaded(id)) {
        manager.deleteExtensionById(id);
      }
    });

    const currentInfo = manager.getExtensionInfoById(extensionId) as CustomExtensionInfo | undefined;
    const currentUrl = manager.getLoadedExtensionURLs?.()?.[extensionId] || currentInfo?.url || "";
    const loadedExpectedExtension = manager.isExtensionLoaded(extensionId);
    const resultMatches = loadedIds.length === 0 || loadedIds.includes(extensionId);

    if (!loadedExpectedExtension || !resultMatches || currentUrl !== url) {
      const error = new Error("EXTENSION_ID_MISMATCH") as Error & {
        expectedId?: string;
        loadedIds?: string[];
      };
      error.expectedId = extensionId;
      error.loadedIds = loadedIds;
      throw error;
    }

    manager.saveWildExtensionsURL(extensionId, url);
    vm.runtime.emitProjectChanged?.();
    vm.emit("DEV_EXTENSION_LOAD_SUCCESS", [extensionId]);
    refreshWorkspace(vm, workspace);

    return {
      extensionId,
      url,
    };
  } catch (error) {
    await restorePreviousMetadata(manager, extensionId, previousInfo, previousUrl);
    throw error;
  }
};
