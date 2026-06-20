export interface ExamplePromptSet {
  chat: string[];
  code: string[];
}

export const DEFAULT_CHAT_EXAMPLE_PROMPTS = [
  "帮我快速看懂这个作品的主要玩法和交互流程",
  "分析一下当前作品还有哪些可以优化的体验问题",
  "帮我规划下一步要做的功能，但先不要修改作品",
  "解释一下我选中的积木/脚本在做什么",
  "帮我检查这个作品可能有哪些隐藏 bug",
  "根据当前作品，给我 3 个适合继续扩展的创意方向",
  "帮我整理当前作品的角色、变量和广播关系",
  "如果我要把这个作品做得更适合手机玩，应该先改哪里？",
];

export const DEFAULT_CODE_EXAMPLE_PROMPTS = [
  "帮我给当前角色新增一个基础控制脚本",
  "修复这个作品里可能导致流程卡住的问题",
  "给游戏添加一个开始界面和重新开始逻辑",
  "帮我把重复的脚本整理成更清晰的功能文件",
  "新增一个得分或计时系统，并接到现有流程里",
  "给角色添加受伤反馈和短暂无敌时间",
  "帮我把当前选中的逻辑改成更稳定的写法",
  "给作品添加一个简单的新关卡或难度变化",
];

export const PROJECT_EXAMPLE_PROMPTS_MARKER_START = "<ai-assistant-example-prompts>";
export const PROJECT_EXAMPLE_PROMPTS_MARKER_END = "</ai-assistant-example-prompts>";

const hashString = (value: string) => {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
};

const seededRandom = (seed: number) => {
  let state = seed || 1;
  return () => {
    state = Math.imul(1664525, state) + 1013904223;
    return (state >>> 0) / 4294967296;
  };
};

export const pickExamplePrompts = (pool: string[], seedText: string, count = 4) => {
  const items = pool.filter(Boolean);
  const random = seededRandom(hashString(seedText));
  const shuffled = items
    .map((text) => ({ text, rank: random() }))
    .sort((left, right) => left.rank - right.rank)
    .map((item) => item.text);
  return shuffled.slice(0, Math.min(count, shuffled.length));
};

export const normalizeExamplePromptSet = (value: any): ExamplePromptSet | null => {
  const normalizeList = (list: any) =>
    (Array.isArray(list) ? list : [])
      .map((item) => String(item || "").trim())
      .filter(Boolean)
      .slice(0, 6);
  const chat = normalizeList(value?.chat || value?.chatExampleRequests);
  const code = normalizeList(value?.code || value?.codeExampleRequests);
  if (!chat.length && !code.length) return null;
  return { chat, code };
};

export const serializeProjectExamplePrompts = (prompts: ExamplePromptSet | null) => {
  const normalized = normalizeExamplePromptSet(prompts);
  if (!normalized) return "";
  return [
    PROJECT_EXAMPLE_PROMPTS_MARKER_START,
    JSON.stringify(normalized, null, 2),
    PROJECT_EXAMPLE_PROMPTS_MARKER_END,
  ].join("\n");
};

export const parseProjectExamplePrompts = (content: string): ExamplePromptSet | null => {
  const text = String(content || "");
  const start = text.indexOf(PROJECT_EXAMPLE_PROMPTS_MARKER_START);
  const end = text.indexOf(PROJECT_EXAMPLE_PROMPTS_MARKER_END);
  if (start < 0 || end < 0 || end <= start) return null;
  const jsonText = text.slice(start + PROJECT_EXAMPLE_PROMPTS_MARKER_START.length, end).trim();
  try {
    return normalizeExamplePromptSet(JSON.parse(jsonText));
  } catch {
    return null;
  }
};
