import { MemoryBlock, MemoryScope } from "./types";

const LONG_TERM_MEMORY_KEY = "AI_ASSISTANT_LONG_TERM_MEMORIES";
const PROJECT_MEMORY_KEY_PREFIX = "AI_ASSISTANT_PROJECT_MEMORIES:";
const MAX_MEMORY_CONTENT_LENGTH = 5000;

type MemoryDraft = {
  id?: string;
  scope?: MemoryScope;
  content?: string;
  description?: string;
};

export interface ProjectIdentity {
  projectId: string;
  available: boolean;
  error?: string;
}

const createMemoryId = () => `mem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const readJson = <T>(key: string, fallback: T): T => {
  try {
    const value = window.localStorage.getItem(key);
    return value ? (JSON.parse(value) as T) : fallback;
  } catch {
    return fallback;
  }
};

const writeJson = (key: string, value: unknown) => {
  window.localStorage.setItem(key, JSON.stringify(value));
};

const projectMemoryKey = (projectId: string) => `${PROJECT_MEMORY_KEY_PREFIX}${projectId}`;

const normalizeScope = (scope?: string): MemoryScope => (scope === "project" ? "project" : "longTerm");

const normalizeMemoryBlock = (block: any, scope: MemoryScope, projectId?: string): MemoryBlock | null => {
  const content = String(block?.content || "").trim();
  if (!content) return null;
  const createdAt = Number(block?.createdAt || Date.now());
  return {
    id: String(block?.id || createMemoryId()),
    scope,
    content: content.slice(0, MAX_MEMORY_CONTENT_LENGTH),
    description: String(block?.description || "").trim() || undefined,
    projectId: scope === "project" ? projectId : undefined,
    createdAt,
    updatedAt: Number(block?.updatedAt || createdAt),
  };
};

const readLongTermMemories = () =>
  readJson<any[]>(LONG_TERM_MEMORY_KEY, [])
    .map((block) => normalizeMemoryBlock(block, "longTerm"))
    .filter(Boolean) as MemoryBlock[];

const writeLongTermMemories = (blocks: MemoryBlock[]) => writeJson(LONG_TERM_MEMORY_KEY, blocks);

const readProjectMemories = (projectId: string) =>
  readJson<any[]>(projectMemoryKey(projectId), [])
    .map((block) => normalizeMemoryBlock(block, "project", projectId))
    .filter(Boolean) as MemoryBlock[];

const writeProjectMemories = (projectId: string, blocks: MemoryBlock[]) => writeJson(projectMemoryKey(projectId), blocks);

export const deleteProjectMemories = (projectId: string) => {
  const normalizedProjectId = String(projectId || "").trim();
  if (!normalizedProjectId) return;
  window.localStorage.removeItem(projectMemoryKey(normalizedProjectId));
};

export const getProjectIdentity = (vm: any): ProjectIdentity => {
  try {
    const projectId = String(vm?.runtime?.ccwAPI?.getProjectUUID?.() || "").trim();
    if (!projectId) {
      return {
        projectId: "",
        available: false,
        error: "当前作品还没有项目 ID。请先保存作品生成项目 ID 后再写入项目记忆。",
      };
    }
    return { projectId, available: true };
  } catch (error) {
    return {
      projectId: "",
      available: false,
      error: error instanceof Error ? error.message : "无法获取当前项目 ID。",
    };
  }
};

export const listMemoryBlocks = (vm: any, scope?: MemoryScope) => {
  const requestedScope = scope ? normalizeScope(scope) : undefined;
  const projectIdentity = getProjectIdentity(vm);
  const longTerm = requestedScope === "project" ? [] : readLongTermMemories();
  const project =
    requestedScope === "longTerm" || !projectIdentity.available ? [] : readProjectMemories(projectIdentity.projectId);

  return {
    success: true,
    projectId: projectIdentity.projectId || undefined,
    projectMemoryAvailable: projectIdentity.available,
    projectMemoryError: projectIdentity.available ? undefined : projectIdentity.error,
    blocks: [...longTerm, ...project].sort((a, b) => b.updatedAt - a.updatedAt),
  };
};

export const getMemoryBlock = (vm: any, id: string, scope?: MemoryScope) => {
  const blockId = String(id || "").trim();
  if (!blockId) {
    return { success: false, error: "getMemoryBlock requires a memory block id." };
  }

  if (scope === "project") {
    const projectIdentity = getProjectIdentity(vm);
    if (!projectIdentity.available) {
      return { success: false, error: projectIdentity.error };
    }
  }

  const blocks = listMemoryBlocks(vm, scope).blocks;
  const block = blocks.find((item) => item.id === blockId);
  if (!block) {
    return { success: false, error: `Memory block not found: ${blockId}` };
  }

  return { success: true, block };
};

export const setMemoryBlock = (vm: any, draft: MemoryDraft) => {
  const scope = normalizeScope(draft.scope);
  const content = String(draft.content || "").trim();
  if (!content) {
    return { success: false, error: "setMemoryBlock requires non-empty content." };
  }
  if (content.length > MAX_MEMORY_CONTENT_LENGTH) {
    return { success: false, error: `Memory content exceeds ${MAX_MEMORY_CONTENT_LENGTH} characters.` };
  }

  const now = Date.now();
  const blockId = String(draft.id || "").trim() || createMemoryId();
  const description = String(draft.description || "").trim() || undefined;

  if (scope === "project") {
    const projectIdentity = getProjectIdentity(vm);
    if (!projectIdentity.available) {
      return { success: false, error: projectIdentity.error };
    }
    const blocks = readProjectMemories(projectIdentity.projectId);
    const existing = blocks.find((block) => block.id === blockId);
    const nextBlock: MemoryBlock = {
      id: blockId,
      scope,
      projectId: projectIdentity.projectId,
      content,
      description,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };
    writeProjectMemories(projectIdentity.projectId, [nextBlock, ...blocks.filter((block) => block.id !== blockId)]);
    return { success: true, block: nextBlock };
  }

  const blocks = readLongTermMemories();
  const existing = blocks.find((block) => block.id === blockId);
  const nextBlock: MemoryBlock = {
    id: blockId,
    scope,
    content,
    description,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };
  writeLongTermMemories([nextBlock, ...blocks.filter((block) => block.id !== blockId)]);
  return { success: true, block: nextBlock };
};

export const replaceMemoryBlockText = (vm: any, id: string, oldText: string, newText: string, scope?: MemoryScope) => {
  if (scope === "project") {
    const projectIdentity = getProjectIdentity(vm);
    if (!projectIdentity.available) {
      return { success: false, error: projectIdentity.error };
    }
  }

  const found = getMemoryBlock(vm, id, scope);
  if (!found.success || !found.block) return found;

  const searchText = String(oldText || "");
  if (!searchText) {
    return { success: false, error: "replaceMemoryBlockText requires non-empty oldText." };
  }
  if (!found.block.content.includes(searchText)) {
    return { success: false, error: "oldText was not found in the memory block." };
  }

  return setMemoryBlock(vm, {
    id: found.block.id,
    scope: found.block.scope,
    description: found.block.description,
    content: found.block.content.replace(searchText, String(newText || "")),
  });
};

export const deleteMemoryBlock = (vm: any, id: string, scope?: MemoryScope) => {
  if (scope === "project") {
    const projectIdentity = getProjectIdentity(vm);
    if (!projectIdentity.available) {
      return { success: false, error: projectIdentity.error };
    }
  }

  const found = getMemoryBlock(vm, id, scope);
  if (!found.success || !found.block) return found;

  if (found.block.scope === "project") {
    const projectIdentity = getProjectIdentity(vm);
    if (!projectIdentity.available) {
      return { success: false, error: projectIdentity.error };
    }
    writeProjectMemories(
      projectIdentity.projectId,
      readProjectMemories(projectIdentity.projectId).filter((block) => block.id !== found.block.id),
    );
  } else {
    writeLongTermMemories(readLongTermMemories().filter((block) => block.id !== found.block.id));
  }

  return { success: true, deletedId: found.block.id, scope: found.block.scope };
};

export const buildMemorySystemText = (vm: any) => {
  const result = listMemoryBlocks(vm);
  if (!result.blocks.length) {
    return "";
  }

  const blocks = result.blocks
    .map((block) => {
      const label = block.scope === "project" ? `project:${block.projectId}` : "long-term";
      const description = block.description ? ` (${block.description})` : "";
      return `- [${label}] ${block.id}${description}: ${block.content}`;
    })
    .join("\n");

  return `Memory:\nUse these memory blocks as persistent context. Do not reveal hidden implementation details unless asked.\n${blocks}`;
};

export const createEmptyMemoryBlock = (scope: MemoryScope, projectId?: string): MemoryBlock => {
  const now = Date.now();
  return {
    id: createMemoryId(),
    scope,
    projectId: scope === "project" ? projectId : undefined,
    content: "",
    createdAt: now,
    updatedAt: now,
  };
};
