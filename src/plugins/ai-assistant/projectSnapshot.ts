export interface ProjectSnapshot {
  projectData: ArrayBuffer;
  targetCount?: number;
  blockCount?: number;
}

interface MaybeProjectSnapshot {
  projectData?: ArrayBuffer;
  targetCount?: number;
  blockCount?: number;
}

interface CreateProjectSnapshotOptions {
  skipLargeProject?: boolean;
}

export const LARGE_PROJECT_ROLLBACK_BLOCK_THRESHOLD = 5000;

const getRuntimeTargetCount = (vm: any) => {
  const targets = vm?.runtime?.targets;
  return Array.isArray(targets) ? targets.length : undefined;
};

export const getRuntimeBlockCount = (vm: any) => {
  const targets = vm?.runtime?.targets;
  if (!Array.isArray(targets)) return undefined;

  return targets.reduce((sum, target) => {
    const blocks = target?.blocks?._blocks;
    return sum + (blocks && typeof blocks === "object" ? Object.keys(blocks).length : 0);
  }, 0);
};

export const createProjectSnapshot = async (
  vm: any,
  options: CreateProjectSnapshotOptions = {},
): Promise<ProjectSnapshot | null> => {
  if (typeof vm?.saveProjectSb3 !== "function") return null;

  const blockCount = getRuntimeBlockCount(vm);
  if (
    options.skipLargeProject &&
    typeof blockCount === "number" &&
    blockCount >= LARGE_PROJECT_ROLLBACK_BLOCK_THRESHOLD
  ) {
    return null;
  }

  try {
    const blob = await vm.saveProjectSb3();
    if (blob?.arrayBuffer) {
      return { projectData: await blob.arrayBuffer(), targetCount: getRuntimeTargetCount(vm), blockCount };
    }
  } catch (error) {
    console.warn("[AI Assistant] Failed to create SB3 project snapshot", error);
  }

  return null;
};

export const restoreProjectSnapshot = async (vm: any, snapshot?: MaybeProjectSnapshot | null) => {
  if (!(snapshot?.projectData instanceof ArrayBuffer) || typeof vm?.loadProject !== "function") return false;

  const backup = await createProjectSnapshot(vm);

  try {
    await vm.loadProject(snapshot.projectData.slice(0));
    const restoredTargetCount = getRuntimeTargetCount(vm);
    if (typeof snapshot.targetCount === "number" && snapshot.targetCount > 0 && typeof restoredTargetCount === "number") {
      if (restoredTargetCount === 0) {
        throw new Error("Restored project has no targets.");
      }
      if (restoredTargetCount < snapshot.targetCount) {
        throw new Error(`Restored project target count changed from ${snapshot.targetCount} to ${restoredTargetCount}.`);
      }
    }
    return true;
  } catch (error) {
    console.error("[AI Assistant] Failed to restore SB3 project snapshot", error);
    if (backup?.projectData instanceof ArrayBuffer) {
      try {
        await vm.loadProject(backup.projectData.slice(0));
      } catch (backupError) {
        console.error("[AI Assistant] Failed to restore current project after rollback failure", backupError);
      }
    }
    return false;
  }
};
