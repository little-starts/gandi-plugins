import { GameAgentLimits, GuideCategory, SubAgentIconKey, SubAgentProfile, SubAgentToolGroup } from "./types";

export const SUBAGENT_STORAGE_KEY = "AI_ASSISTANT_SUB_AGENTS";

export const SUBAGENT_ICON_OPTIONS: Array<{ key: SubAgentIconKey; label: string }> = [
  { key: "search", label: "放大镜" },
  { key: "code", label: "代码" },
  { key: "robot", label: "机器人" },
  { key: "spark", label: "星光" },
];

export const READ_BUILTIN_TOOL_NAMES = [
  "listFiles",
  "getProjectOverview",
  "getScratchGuide",
  "searchBlocks",
  "getBlocksHelp",
  "readFile",
  "searchFiles",
  "getDiagnostics",
  "getAllExtensions",
  "getExtensionBlocks",
] as const;

export const GAME_BUILTIN_TOOL_NAMES = ["getProjectOverview", "observeStage", "runStageScript"] as const;

export const EDIT_BUILTIN_TOOL_NAMES = [
  "applyPatch",
  "insertCostume",
  "updateCostume",
  "deleteCostume",
  "runGuideTool",
] as const;

export const BUILTIN_TOOL_GROUPS = [
  { key: "read", title: "阅读", description: "项目概览、文件读取、诊断、积木和指南检索。" },
  { key: "edit", title: "编辑", description: "补丁修改、造型/背景编辑和指南工具执行。" },
  { key: "game", title: "游戏", description: "视觉观察舞台并以玩家方式执行 DOM 输入。" },
] as const;

export const DEFAULT_GAME_AGENT_LIMITS: GameAgentLimits = {
  maxActionsPerScript: 30,
  maxWaitMs: 5000,
  maxScriptDurationMs: 15000,
  maxToolTurns: 12,
  maxScreenshotBytes: 120000,
};

export const DEFAULT_SUBAGENTS: SubAgentProfile[] = [
  {
    id: "default-search-agent",
    name: "search Agent",
    description: "擅长读取、检索和整理上下文，适合查阅项目结构、指南和文档。",
    prompt: "优先检索、阅读、整理信息，输出准确结论和必要引用。",
    avatarBackground: "#2563eb",
    avatarIcon: "search",
    builtinToolGroups: ["read"],
    enabledGuideCategories: ["read"],
    enabledUserGuideIds: [],
    enableExtensionGuides: false,
    enabled: true,
    isDefault: true,
    createdAt: 0,
    updatedAt: 0,
  },
  {
    id: "default-code-agent",
    name: "code Agent",
    description: "擅长修改工程和执行实现任务，适合编写、修复和同步项目内容。",
    prompt: "优先直接完成实现、修改和收口验证。",
    avatarBackground: "#7c3aed",
    avatarIcon: "code",
    builtinToolGroups: ["read", "edit"],
    enabledGuideCategories: ["read", "edit"],
    enabledUserGuideIds: [],
    enableExtensionGuides: true,
    enabled: true,
    isDefault: true,
    createdAt: 0,
    updatedAt: 0,
  },
  {
    id: "default-game-agent",
    name: "Game Agent",
    description: "像玩家一样通过视觉观察舞台并执行鼠标、键盘和等待操作，适合测试 Scratch 游戏流程。",
    prompt:
      "像玩家一样测试 Scratch 舞台。可先用 getProjectOverview 了解舞台比例和项目结构，再用 observeStage 获取截图、runStageScript 执行短小可复现的操作批次；每次关键操作后再次观察。坐标默认使用 Scratch 坐标系，中心为 (0,0)。不要修改项目。最终报告保持简洁精确：测试目标、实际表现、发现的 BUG、复现步骤、期望行为和给父 AI 的线索。",
    avatarBackground: "#dc2626",
    avatarIcon: "spark",
    builtinToolGroups: ["game"],
    enabledGuideCategories: [],
    enabledUserGuideIds: [],
    enableExtensionGuides: false,
    enabled: false,
    gameLimits: DEFAULT_GAME_AGENT_LIMITS,
    isDefault: true,
    createdAt: 0,
    updatedAt: 0,
  },
];

export const DEFAULT_SUBAGENT_IDS = new Set(DEFAULT_SUBAGENTS.map((agent) => agent.id));

export const normalizeGuideCategory = (value: string | undefined): GuideCategory => {
  const normalized = String(value || "read")
    .trim()
    .toLowerCase();
  return normalized || "read";
};

const normalizeToolGroups = (profile: SubAgentProfile): SubAgentToolGroup[] => {
  const groups = Array.isArray(profile.builtinToolGroups) ? profile.builtinToolGroups : [];
  const legacyMode = profile.builtinToolMode;
  const source = groups.length ? groups : legacyMode === "all" ? ["read", "edit"] : ["read"];
  return Array.from(new Set(source.filter((group): group is SubAgentToolGroup => group === "read" || group === "edit" || group === "game")));
};

export const normalizeGameAgentLimits = (limits?: Partial<GameAgentLimits>): GameAgentLimits => ({
  maxActionsPerScript: limits?.maxActionsPerScript ?? DEFAULT_GAME_AGENT_LIMITS.maxActionsPerScript,
  maxWaitMs: limits?.maxWaitMs ?? DEFAULT_GAME_AGENT_LIMITS.maxWaitMs,
  maxScriptDurationMs: limits?.maxScriptDurationMs ?? DEFAULT_GAME_AGENT_LIMITS.maxScriptDurationMs,
  maxToolTurns: limits?.maxToolTurns ?? DEFAULT_GAME_AGENT_LIMITS.maxToolTurns,
  maxScreenshotBytes: limits?.maxScreenshotBytes ?? DEFAULT_GAME_AGENT_LIMITS.maxScreenshotBytes,
});

export const normalizeSubAgentProfile = (profile: SubAgentProfile): SubAgentProfile => ({
  ...profile,
  name: profile.name.trim() || "Custom Agent",
  description: profile.description || "",
  prompt: profile.prompt || "",
  avatarBackground: profile.avatarBackground || "#64748b",
  avatarIcon: profile.avatarIcon || "robot",
  builtinToolGroups: normalizeToolGroups(profile),
  enabledGuideCategories: Array.from(new Set((profile.enabledGuideCategories || []).map(normalizeGuideCategory))),
  enabledUserGuideIds: Array.from(new Set(profile.enabledUserGuideIds || [])),
  enableExtensionGuides: profile.enableExtensionGuides !== false,
  enabled: profile.enabled !== false,
  gameLimits: normalizeGameAgentLimits(profile.gameLimits),
});
