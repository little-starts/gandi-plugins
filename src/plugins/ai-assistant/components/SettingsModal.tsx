import * as React from "react";
import settings from "../ui/Settings.module.less";
import {
  Agent,
  AgentModel,
  AiGuideVerificationMode,
  DefaultCostumeType,
  GameAgentLimitValue,
  MemoryBlock,
  MemoryScope,
  StageScreenshotMode,
  SubAgentProfile,
  SubAgentToolGroup,
  UserGuide,
} from "../types";
import { PROVIDER_DEFAULT_URLS } from "../constants";
import { getAllGuides, type GuideSummary } from "../guideRegistry";
import { deleteMemoryBlock, listMemoryBlocks, setMemoryBlock } from "../memoryStore";
import { BUILTIN_TOOL_GROUPS, DEFAULT_GAME_AGENT_LIMITS, SUBAGENT_ICON_OPTIONS } from "../subAgentConfig";
import { SubAgentIcon } from "../subAgentIcons";
import { showAssistantAlert, showAssistantConfirm } from "./AssistantDialogHost";

type SettingsSection = "general" | "security" | "subagents" | "models" | "guides" | "memory" | "appearance" | "about";
type ThemeMode = "gandi" | "system" | "dark" | "light";

const THEME_CHOICES: Array<{ mode: ThemeMode; title: string; description: string }> = [
  { mode: "gandi", title: "跟随 Gandi", description: "根据 Gandi 当前界面主题自动切换。" },
  { mode: "system", title: "跟随系统", description: "根据操作系统外观设置自动切换。" },
  { mode: "dark", title: "深色", description: "使用深色界面。" },
  { mode: "light", title: "浅色", description: "使用浅色界面。" },
];

interface SettingsModalProps {
  agents: Agent[];
  editingAgent: Agent | null;
  onSaveAgent: (agent: Agent) => void;
  onDeleteAgent: (id: string) => void;
  onExportAgent: (id: string) => void;
  onImportAgent: (file: File) => Promise<void>;
  onEditAgent: (agent: Agent | null) => void;
  imageModelId: string;
  onImageModelIdChange: (modelId: string) => void;
  subAgents: SubAgentProfile[];
  editingSubAgent: SubAgentProfile | null;
  onCreateSubAgent: () => SubAgentProfile;
  onEditSubAgent: (agent: SubAgentProfile | null) => void;
  onSaveSubAgent: (agent: SubAgentProfile) => void;
  onDeleteSubAgent: (id: string) => void;
  allowSubAgents: boolean;
  onAllowSubAgentsChange: (enabled: boolean) => void;
  defaultCostumeType: DefaultCostumeType;
  onDefaultCostumeTypeChange: (type: DefaultCostumeType) => void;
  aiGuideVerificationMode: AiGuideVerificationMode;
  onAiGuideVerificationModeChange: (mode: AiGuideVerificationMode) => void;
  stageScreenshotMode: StageScreenshotMode;
  onStageScreenshotModeChange: (mode: StageScreenshotMode) => void;
  themeMode: ThemeMode;
  onThemeModeChange: (theme: ThemeMode) => void;
  onClose: () => void;
  isCompact?: boolean;
  userGuides: UserGuide[];
  extensionGuides?: GuideSummary[];
  onSaveGuide: (guide: Partial<UserGuide>) => UserGuide;
  onDeleteGuide: (id: string) => void;
  onToggleGuide: (id: string, enabled: boolean) => void;
  onImportGuide: (file: File) => Promise<UserGuide>;
  vm: any;
}

const PROVIDER_LABELS: Record<Agent["provider"], string> = {
  openai: "OpenAI",
  zhipu: "智谱清言",
  deepseek: "DeepSeek",
  anthropic: "Anthropic",
  google: "Google",
  azure: "Azure",
  custom: "自定义 OpenAI",
  custom_anthropic: "自定义 Anthropic",
};

const createDefaultModel = (): AgentModel => ({
  id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
  name: "My GPT-4o",
  modelId: "gpt-4o",
});

const getDefaultModelForProvider = (provider: Agent["provider"]) => {
  if (provider === "zhipu") return { name: "GLM-4", modelId: "glm-4" };
  if (provider === "deepseek") return { name: "DeepSeek Chat", modelId: "deepseek-chat" };
  if (provider === "anthropic" || provider === "custom_anthropic") {
    return { name: "Claude 3.5 Sonnet", modelId: "claude-3-5-sonnet-latest" };
  }
  return { name: "GPT-4o", modelId: "gpt-4o" };
};

const formatGameLimitInputValue = (value: GameAgentLimitValue | undefined, fallback: GameAgentLimitValue) =>
  value === "infinite" ? "infinite" : String(value ?? fallback);

const parseGameLimitInputValue = (value: string): GameAgentLimitValue => {
  const trimmed = value.trim().toLowerCase();
  if (trimmed === "infinite") return "infinite";
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
};

const formatByteLimitInputValue = (value: GameAgentLimitValue | undefined, fallback: GameAgentLimitValue) => {
  const resolved = value ?? fallback;
  if (resolved === "infinite") return "infinite";
  if (resolved % 1073741824 === 0) return `${resolved / 1073741824}GB`;
  if (resolved % 1048576 === 0) return `${resolved / 1048576}MB`;
  if (resolved % 1024 === 0) return `${resolved / 1024}KB`;
  return `${resolved}B`;
};

const parseByteLimitInputValue = (value: string): GameAgentLimitValue => {
  const trimmed = value.trim().toLowerCase();
  if (trimmed === "infinite") return "infinite";
  const match = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?$/.exec(trimmed);
  if (!match) return 1;
  const amount = Number.parseFloat(match[1]);
  const unit = match[2] || "b";
  const multiplier = unit === "gb" ? 1073741824 : unit === "mb" ? 1048576 : unit === "kb" ? 1024 : 1;
  const bytes = Math.round(amount * multiplier);
  return Number.isFinite(bytes) && bytes > 0 ? bytes : 1;
};

const hasInfiniteGameLimit = (agent: SubAgentProfile) =>
  Object.values(agent.gameLimits || {}).some((value) => value === "infinite");

const formatToolGroups = (agent: SubAgentProfile) => {
  const groups = agent.builtinToolGroups || [];
  return BUILTIN_TOOL_GROUPS.filter((group) => groups.includes(group.key)).map((group) => group.title).join("、") || "无";
};

export const SettingsModal: React.FC<SettingsModalProps> = ({
  agents,
  editingAgent,
  onSaveAgent,
  onDeleteAgent,
  onExportAgent,
  onImportAgent,
  onEditAgent,
  imageModelId,
  onImageModelIdChange,
  subAgents,
  editingSubAgent,
  onCreateSubAgent,
  onEditSubAgent,
  onSaveSubAgent,
  onDeleteSubAgent,
  allowSubAgents,
  onAllowSubAgentsChange,
  defaultCostumeType,
  onDefaultCostumeTypeChange,
  aiGuideVerificationMode,
  onAiGuideVerificationModeChange,
  stageScreenshotMode,
  onStageScreenshotModeChange,
  themeMode,
  onThemeModeChange,
  onClose,
  isCompact,
  userGuides,
  extensionGuides = [],
  onSaveGuide,
  onDeleteGuide,
  onToggleGuide,
  onImportGuide,
  vm,
}) => {
  const fileInputRef = React.useRef<HTMLInputElement | null>(null);
  const guideFileInputRef = React.useRef<HTMLInputElement | null>(null);
  const [activeSection, setActiveSection] = React.useState<SettingsSection>("general");
  const [formData, setFormData] = React.useState<Partial<Agent>>({ provider: "openai" });
  const [models, setModels] = React.useState<AgentModel[]>([createDefaultModel()]);
  const defaultAndUserGuides = React.useMemo(() => getAllGuides(userGuides), [userGuides]);
  const allGuides = React.useMemo(() => getAllGuides(userGuides, extensionGuides), [extensionGuides, userGuides]);
  const [selectedGuideId, setSelectedGuideId] = React.useState<string>(() => allGuides[0]?.id || "");
  const selectedGuide = allGuides.find((guide) => guide.id === selectedGuideId) || allGuides[0];
  const [guideDraft, setGuideDraft] = React.useState<Partial<UserGuide>>({});
  const [memoryBlocks, setMemoryBlocks] = React.useState<MemoryBlock[]>([]);
  const [memoryDrafts, setMemoryDrafts] = React.useState<Record<string, { description: string; content: string }>>({});
  const [newMemoryScope, setNewMemoryScope] = React.useState<MemoryScope>("longTerm");
  const [newMemoryDescription, setNewMemoryDescription] = React.useState("");
  const [newMemoryContent, setNewMemoryContent] = React.useState("");
  const [activeMemoryScope, setActiveMemoryScope] = React.useState<MemoryScope>("longTerm");
  const [projectMemoryAvailable, setProjectMemoryAvailable] = React.useState(false);
  const [projectMemoryError, setProjectMemoryError] = React.useState("");
  const [projectMemoryId, setProjectMemoryId] = React.useState("");
  const [subAgentForm, setSubAgentForm] = React.useState<SubAgentProfile | null>(null);
  const newMemoryContentLength = newMemoryContent.length;

  const refreshMemories = React.useCallback(() => {
    const result = listMemoryBlocks(vm);
    setMemoryBlocks(result.blocks);
    setProjectMemoryAvailable(result.projectMemoryAvailable);
    setProjectMemoryError(result.projectMemoryError || "");
    setProjectMemoryId(result.projectId || "");
    setMemoryDrafts(
      result.blocks.reduce<Record<string, { description: string; content: string }>>((drafts, block) => {
        drafts[block.id] = {
          description: block.description || "",
          content: block.content,
        };
        return drafts;
      }, {}),
    );
  }, [vm]);

  React.useEffect(() => {
    if (!selectedGuideId && allGuides[0]) {
      setSelectedGuideId(allGuides[0].id);
      return;
    }
    if (selectedGuideId && !allGuides.some((guide) => guide.id === selectedGuideId)) {
      setSelectedGuideId(allGuides[0]?.id || "");
    }
  }, [allGuides, selectedGuideId]);

  React.useEffect(() => {
    if (selectedGuide?.source === "user") {
      setGuideDraft({
        id: selectedGuide.id,
        name: selectedGuide.name,
        title: selectedGuide.title,
        content: selectedGuide.content,
        category: selectedGuide.category,
        enabled: selectedGuide.enabled,
        indexJs: userGuides.find((guide) => guide.id === selectedGuide.id)?.indexJs,
      });
      return;
    }
    setGuideDraft({});
  }, [selectedGuide, userGuides]);

  React.useEffect(() => {
    if (editingAgent) {
      setActiveSection("models");
      setFormData({
        provider: editingAgent.provider,
        name: editingAgent.name || (editingAgent as any).displayName || "",
        baseUrl: editingAgent.baseUrl,
        apiKey: editingAgent.apiKey,
      });
      setModels(
        editingAgent.models || [
          {
            id: `${editingAgent.id}-model`,
            name: (editingAgent as any).displayName || "Default Model",
            modelId: (editingAgent as any).modelName || "gpt-3.5-turbo",
            maxTokens: (editingAgent as any).maxTokens,
          },
        ],
      );
      return;
    }

    setFormData({ provider: "openai", baseUrl: PROVIDER_DEFAULT_URLS.openai });
    setModels([createDefaultModel()]);
  }, [editingAgent]);

  React.useEffect(() => {
    if (editingSubAgent) {
      setActiveSection("subagents");
      setSubAgentForm(editingSubAgent);
      return;
    }
    setSubAgentForm(null);
  }, [editingSubAgent]);

  React.useEffect(() => {
    if (activeSection === "memory") {
      refreshMemories();
    }
  }, [activeSection, refreshMemories]);

  const handleProviderChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
    const provider = event.target.value as Agent["provider"];
    const defaults = getDefaultModelForProvider(provider);
    const baseUrl = PROVIDER_DEFAULT_URLS[provider] || "";
    setFormData((previous) => ({ ...previous, provider, baseUrl }));

    if (models.length === 1) {
      setModels([{ ...models[0], ...defaults }]);
    }
  };

  const updateModel = (id: string, field: keyof AgentModel, value: string | number | undefined) => {
    setModels((previous) => previous.map((model) => (model.id === id ? { ...model, [field]: value } : model)));
  };

  const removeModel = (id: string) => {
    setModels((previous) => previous.filter((model) => model.id !== id));
  };

  const addModel = () => {
    setModels((previous) => [...previous, createDefaultModel()]);
  };

  const imageModelOptions = React.useMemo(
    () =>
      agents.flatMap((agent) =>
        (agent.models || [])
          .filter((model) => model.name.trim() && model.modelId.trim())
          .map((model) => ({
            id: model.id,
            label: `${agent.name || PROVIDER_LABELS[agent.provider] || "未命名服务"} / ${model.name}（${model.modelId}）`,
          })),
      ),
    [agents],
  );

  const handleSave = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const provider = formData.provider || "openai";
    const validModels = models.filter((model) => model.name.trim() && model.modelId.trim());

    if (validModels.length === 0) {
      void showAssistantAlert("请至少添加一个有效模型");
      return;
    }

    onSaveAgent({
      id: editingAgent?.id || `${Date.now()}`,
      provider,
      baseUrl: formData.baseUrl?.trim() || PROVIDER_DEFAULT_URLS[provider] || "",
      apiKey: formData.apiKey || "",
      name: formData.name?.trim() || PROVIDER_LABELS[provider] || "Custom Agent",
      models: validModels,
    });
  };

  const handleImport = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    try {
      await onImportAgent(file);
      setActiveSection("models");
    } catch (error) {
      await showAssistantAlert(error instanceof Error ? error.message : "导入失败");
    } finally {
      event.target.value = "";
    }
  };

  const handleImportGuide = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    try {
      const guide = await onImportGuide(file);
      setSelectedGuideId(guide.id);
      setActiveSection("guides");
    } catch (error) {
      await showAssistantAlert(error instanceof Error ? error.message : "导入失败");
    } finally {
      event.target.value = "";
    }
  };

  const handleCreateGuide = () => {
    const guide = onSaveGuide({
      name: "my-guide",
      title: "我的指南",
      content: "# 我的指南\n\n在这里编写给 AI 阅读的指南内容。\n",
      category: "read",
      enabled: true,
    });
    setSelectedGuideId(guide.id);
    setActiveSection("guides");
  };

  const handleSaveGuide = () => {
    if (selectedGuide?.readOnly) {
      return;
    }
    if (!guideDraft.name?.trim()) {
      void showAssistantAlert("请填写指南名称");
      return;
    }
    const guide = onSaveGuide(guideDraft);
    setSelectedGuideId(guide.id);
  };

  const updateMemoryDraft = (id: string, field: "description" | "content", value: string) => {
    setMemoryDrafts((previous) => ({
      ...previous,
      [id]: {
        description: previous[id]?.description || "",
        content: previous[id]?.content || "",
        [field]: value,
      },
    }));
  };

  const handleCreateMemory = () => {
    const result = setMemoryBlock(vm, {
      scope: newMemoryScope,
      description: newMemoryDescription,
      content: newMemoryContent,
    });
    if (!result.success) {
      void showAssistantAlert(result.error || "保存记忆失败");
      return;
    }
    setNewMemoryDescription("");
    setNewMemoryContent("");
    refreshMemories();
  };

  const handleSaveMemory = (block: MemoryBlock) => {
    const draft = memoryDrafts[block.id];
    const result = setMemoryBlock(vm, {
      id: block.id,
      scope: block.scope,
      description: draft?.description || "",
      content: draft?.content || "",
    });
    if (!result.success) {
      void showAssistantAlert(result.error || "保存记忆失败");
      return;
    }
    refreshMemories();
  };

  const handleCreateSubAgent = () => {
    const created = onCreateSubAgent();
    onEditSubAgent(created);
    setSubAgentForm(created);
    setActiveSection("subagents");
  };

  const handleSaveCurrentSubAgent = () => {
    if (!subAgentForm) return;
    if (!subAgentForm.name.trim()) {
      void showAssistantAlert("请填写智能体名称");
      return;
    }
    if (!subAgentForm.builtinToolGroups.length) {
      void showAssistantAlert("请至少选择一个基础能力分组");
      return;
    }
    onSaveSubAgent(subAgentForm);
  };

  const handleToggleSubAgentEnabled = (agent: SubAgentProfile, enabled: boolean) => {
    const nextAgent = { ...agent, enabled };
    onSaveSubAgent(nextAgent);
    setSubAgentForm((current) => (current?.id === agent.id ? { ...current, enabled } : current));
  };

  const handleDeleteMemory = async (block: MemoryBlock) => {
    const confirmed = await showAssistantConfirm(`确定删除记忆 ${block.description || block.id} 吗？`, {
      title: "删除记忆",
      confirmText: "确认删除",
      cancelText: "取消",
    });
    if (!confirmed) return;
    const result = deleteMemoryBlock(vm, block.id, block.scope);
    if (!result.success) {
      await showAssistantAlert(("error" in result && result.error) || "删除记忆失败");
      return;
    }
    refreshMemories();
  };

  const sectionTitle =
    activeSection === "general"
      ? "常规"
      : activeSection === "security"
        ? "安全"
      : activeSection === "subagents"
      ? "智能体"
      : activeSection === "models"
        ? "模型服务"
        : activeSection === "guides"
          ? "指南"
          : activeSection === "memory"
            ? "记忆"
            : activeSection === "appearance"
              ? "外观"
              : "关于";
  const sectionDescription =
    activeSection === "general"
      ? "管理基础行为和默认偏好。"
      : activeSection === "security"
        ? "控制 AI 自动创建指南时的审查方式。"
      : activeSection === "subagents"
      ? "管理子智能体、头像、提示词和可用指南分类。"
      : activeSection === "models"
        ? "管理供应商、API Key、Base URL 和可选模型。"
        : activeSection === "guides"
          ? "管理默认指南、用户指南与扩展指南。"
          : activeSection === "memory"
            ? "管理长期记忆和当前项目记忆。"
            : activeSection === "appearance"
              ? "切换插件界面的主题外观。"
              : "查看插件作者、授权协议与开源信息。";
  const groupedGuides = React.useMemo(
    () => [
      { key: "default", title: "默认指南", guides: defaultAndUserGuides.filter((guide) => guide.source === "default") },
      { key: "user", title: "用户指南", guides: defaultAndUserGuides.filter((guide) => guide.source === "user") },
      { key: "extension", title: "扩展指南", guides: extensionGuides },
    ],
    [defaultAndUserGuides, extensionGuides],
  );
  const guideCategories = React.useMemo(
    () => Array.from(new Set(allGuides.map((guide) => String(guide.category || "read")))).sort(),
    [allGuides],
  );
  const displayedGuideGroups = React.useMemo(
    () => [
      ...groupedGuides.filter((group) => group.key !== "extension"),
      { key: "ai", title: "AI 指南", guides: defaultAndUserGuides.filter((guide) => guide.source === "ai") },
      ...groupedGuides.filter((group) => group.key === "extension"),
    ],
    [defaultAndUserGuides, groupedGuides],
  );
  const editableGuideCategories = React.useMemo(
    () => guideCategories.filter((category) => category !== "ai"),
    [guideCategories],
  );
  const longTermMemories = React.useMemo(
    () => memoryBlocks.filter((block) => block.scope === "longTerm"),
    [memoryBlocks],
  );
  const projectMemories = React.useMemo(
    () => memoryBlocks.filter((block) => block.scope === "project"),
    [memoryBlocks],
  );
  const visibleMemoryBlocks = activeMemoryScope === "project" ? projectMemories : longTermMemories;
  const activeMemoryTitle = activeMemoryScope === "project" ? "项目记忆" : "长期记忆";
  const activeMemoryDescription =
    activeMemoryScope === "project"
      ? projectMemoryAvailable
        ? `当前项目：${projectMemoryId}`
        : projectMemoryError || "项目 ID 不存在，无法储存项目记忆。"
      : "跨项目共享的用户偏好、常用背景和长期上下文。";

  return (
    <div className={settings.overlay} onClick={onClose}>
      <div
        className={`${settings.modal} ${isCompact ? settings.modalCompact : ""}`}
        onClick={(event) => event.stopPropagation()}
      >
        <aside className={settings.settingsNav}>
          <div className={settings.settingsTitle}>
            <h3>设置</h3>
            <p>AI Assistant 配置管理</p>
          </div>
          <nav className={settings.navList} aria-label="设置分类">
            {[
              ["general", "常规", "•"],
              ["security", "安全", "!"],
              ["subagents", "智能体", "◌"],
              ["models", "模型", "◈"],
              ["guides", "指南", "#"],
              ["memory", "记忆", "◎"],
              ["appearance", "外观", "◐"],
              ["about", "关于", "i"],
            ].map(([id, label, icon]) => (
              <button
                key={id}
                type="button"
                className={`${settings.navItem} ${activeSection === id ? settings.navItemActive : ""}`}
                onClick={() => setActiveSection(id as SettingsSection)}
              >
                <span className={settings.navIcon}>{icon}</span>
                <span>{label}</span>
              </button>
            ))}
          </nav>
          <input
            ref={fileInputRef}
            type="file"
            accept="application/json,.json"
            className={settings.fileInput}
            onChange={(event) => void handleImport(event)}
          />
          <input
            ref={guideFileInputRef}
            type="file"
            accept=".md,.zip,text/markdown,application/zip"
            className={settings.fileInput}
            onChange={(event) => void handleImportGuide(event)}
          />
        </aside>

        <main className={settings.settingsMain}>
          <header className={settings.settingsHeader}>
            <div>
              <h4>{sectionTitle}</h4>
              <p>{sectionDescription}</p>
            </div>
            <button
              type="button"
              className={settings.iconButton}
              onClick={onClose}
              aria-label="关闭设置"
              title="关闭设置"
            >
              ×
            </button>
          </header>

          <div
            className={`${settings.settingsContent} ${
              activeSection === "guides" ? settings.settingsContentGuides : ""
            }`}
          >
            {activeSection === "general" ? (
              <div className={settings.sectionStack}>
                <section className={settings.card}>
                  <div className={settings.cardHeader}>
                    <div>
                      <h5>子智能体</h5>
                      <p>控制 AI 是否可以调用子智能体协作。</p>
                    </div>
                  </div>
                  <div className={settings.cardBody}>
                    <label className={settings.checkboxItem}>
                      <input
                        type="checkbox"
                        checked={allowSubAgents}
                        onChange={(event) => onAllowSubAgentsChange(event.target.checked)}
                      />
                      <span>
                        <strong>允许子智能体</strong>
                        <small>
                          关闭后 AI 将无法使用 runSubAgent 工具。
                        </small>
                      </span>
                    </label>
                  </div>
                </section>
                <section className={settings.card}>
                  <div className={settings.cardHeader}>
                    <div>
                      <h5>舞台截图方式</h5>
                      <p>控制 Game Agent 观察舞台时使用的截图方式。</p>
                    </div>
                  </div>
                  <div className={settings.cardBody}>
                    <label className={settings.field}>
                      <span className={settings.label}>截图模式</span>
                      <select
                        className={settings.select}
                        value={stageScreenshotMode}
                        onChange={(event) => onStageScreenshotModeChange(event.target.value as StageScreenshotMode)}
                      >
                        <option value="fast">快速读取 Canvas</option>
                        <option value="full">完整截图 DOM</option>
                      </select>
                      <small className={settings.hint}>
                        快速模式直接读取 Scratch 舞台 Canvas；完整模式使用 html2canvas，适合调试遮罩或叠层。
                      </small>
                    </label>
                  </div>
                </section>
                <section className={settings.card}>
                  <div className={settings.cardHeader}>
                    <div>
                      <h5>默认造型类型</h5>
                      <p>控制新增造型时的默认生成类型。</p>
                    </div>
                  </div>
                  <div className={settings.cardBody}>
                    <label className={settings.field}>
                      <span className={settings.label}>造型类型</span>
                      <select
                        className={settings.select}
                        value={defaultCostumeType}
                        onChange={(event) => onDefaultCostumeTypeChange(event.target.value as DefaultCostumeType)}
                      >
                        <option value="ask">每次询问</option>
                        <option value="vector">矢量图</option>
                        <option value="bitmap">位图</option>
                      </select>
                      <small className={settings.hint}>选择每次询问时，新增或更新造型前会让用户确认类型。</small>
                    </label>
                  </div>
                </section>
              </div>
            ) : null}

            {activeSection === "security" ? (
              <div className={settings.sectionStack}>
                <section className={settings.card}>
                  <div className={settings.cardHeader}>
                    <div>
                      <h5>安全</h5>
                      <p>控制 AI 自动创建指南时的审查方式。</p>
                    </div>
                  </div>
                  <div className={settings.cardBody}>
                    <label className={settings.field}>
                      <span className={settings.label}>AI指南审查</span>
                      <select
                        className={settings.select}
                        value={aiGuideVerificationMode}
                        onChange={(event) =>
                          onAiGuideVerificationModeChange(event.target.value as AiGuideVerificationMode)
                        }
                      >
                        <option value="review_all">全部审核</option>
                        <option value="review_code">仅审核代码</option>
                        <option value="no_review">不审核</option>
                        <option value="auto_review_all">自动审核</option>
                        <option value="auto_review_code">仅代码自动审核</option>
                      </select>
                      {aiGuideVerificationMode === "auto_review_all" ||
                      aiGuideVerificationMode === "auto_review_code" ? (
                        <small className={settings.warningText}>
                          AI 审核可能误判恶意或高风险代码；建议仅在信任当前模型与提示词时启用。
                        </small>
                      ) : null}
                    </label>
                  </div>
                </section>
              </div>
            ) : null}

            {activeSection === "subagents" ? (
              <div className={settings.sectionStack}>
                <section className={settings.card}>
                  <div className={settings.cardHeader}>
                    <div>
                      <h5>{editingSubAgent ? "编辑智能体" : "新增智能体"}</h5>
                      <p>配置子智能体的名称、提示词、头像和可用能力。</p>
                    </div>
                    <div className={settings.actions}>
                      <button type="button" className={settings.button} onClick={handleCreateSubAgent}>
                        新建智能体
                      </button>
                    </div>
                  </div>
                  {subAgentForm ? (
                    <div className={`${settings.cardBody} ${settings.sectionStack}`}>
                      <div className={`${settings.formGrid} ${settings.subAgentFormGrid}`}>
                        <label className={settings.field}>
                          <span className={settings.label}>名称</span>
                          <input
                            className={settings.input}
                            value={subAgentForm.name}
                            onChange={(event) => setSubAgentForm({ ...subAgentForm, name: event.target.value })}
                            disabled={Boolean(subAgentForm.isDefault)}
                          />
                        </label>
                        <label className={`${settings.field} ${settings.fieldFull}`}>
                          <span className={settings.label}>描述</span>
                          <textarea
                            className={`${settings.textarea} ${settings.subAgentTextarea}`}
                            value={subAgentForm.description}
                            onChange={(event) => setSubAgentForm({ ...subAgentForm, description: event.target.value })}
                            disabled={Boolean(subAgentForm.isDefault)}
                          />
                        </label>
                        <label className={`${settings.field} ${settings.fieldFull}`}>
                          <span className={settings.label}>提示词</span>
                          <textarea
                            className={`${settings.textarea} ${settings.subAgentTextarea}`}
                            value={subAgentForm.prompt}
                            onChange={(event) => setSubAgentForm({ ...subAgentForm, prompt: event.target.value })}
                            disabled={Boolean(subAgentForm.isDefault)}
                          />
                        </label>
                      </div>

                      <div className={settings.subAgentVisualRow}>
                        <div className={settings.subAgentAvatarPreviewWrap}>
                          <span className={settings.label}>头像预览</span>
                          <div
                            className={settings.subAgentAvatarPreview}
                            style={{ backgroundColor: subAgentForm.avatarBackground }}
                          >
                            <SubAgentIcon
                              icon={subAgentForm.avatarIcon}
                              className={settings.subAgentAvatarPreviewIcon}
                            />
                          </div>
                        </div>
                        <label className={settings.field}>
                          <span className={settings.label}>头像背景</span>
                          <input
                            className={settings.input}
                            type="color"
                            value={subAgentForm.avatarBackground}
                            onChange={(event) =>
                              setSubAgentForm({ ...subAgentForm, avatarBackground: event.target.value })
                            }
                            disabled={Boolean(subAgentForm.isDefault)}
                          />
                        </label>
                        <div className={settings.field}>
                          <span className={settings.label}>头像图标</span>
                          <div className={settings.subAgentIconPicker}>
                            {SUBAGENT_ICON_OPTIONS.map((option) => (
                              <button
                                key={option.key}
                                type="button"
                                className={`${settings.subAgentIconOption} ${
                                  subAgentForm.avatarIcon === option.key ? settings.subAgentIconOptionActive : ""
                                }`}
                                onClick={() => setSubAgentForm({ ...subAgentForm, avatarIcon: option.key })}
                                disabled={Boolean(subAgentForm.isDefault)}
                              >
                                <SubAgentIcon icon={option.key} className={settings.subAgentIconOptionIcon} />
                                <span>{option.label}</span>
                              </button>
                            ))}
                          </div>
                        </div>
                      </div>

                        <div className={settings.subAgentGuideGroups}>
                          <div className={settings.subAgentGuideGroupCard}>
                            <h6>基础能力分组</h6>
                            <div className={settings.subAgentCategoryList}>
                              {BUILTIN_TOOL_GROUPS.map((group) => {
                                const selected = subAgentForm.builtinToolGroups.includes(group.key);
                                return (
                                  <label key={group.key} className={settings.subAgentCategoryItem}>
                                    <input
                                      type="checkbox"
                                      checked={selected}
                                      onChange={(event) => {
                                        const nextGroups = event.target.checked
                                          ? [...subAgentForm.builtinToolGroups, group.key]
                                          : subAgentForm.builtinToolGroups.filter((item) => item !== group.key);
                                        setSubAgentForm({
                                          ...subAgentForm,
                                          builtinToolGroups: Array.from(new Set(nextGroups)) as SubAgentToolGroup[],
                                        });
                                      }}
                                    />
                                    <span>
                                      {group.title}
                                      <small>{group.description}</small>
                                    </span>
                                  </label>
                                );
                              })}
                            </div>
                          </div>
                        <div className={settings.subAgentGuideGroupCard}>
                          <h6>指南权限</h6>
                          <div className={settings.subAgentCategoryList}>
                            <label className={settings.subAgentCategoryItem}>
                              <input
                                type="checkbox"
                                checked={subAgentForm.enableExtensionGuides}
                                disabled={Boolean(subAgentForm.isDefault)}
                                onChange={(event) =>
                                  setSubAgentForm({
                                    ...subAgentForm,
                                    enableExtensionGuides: event.target.checked,
                                  })
                                }
                              />
                              <span>扩展指南</span>
                            </label>
                            {userGuides.map((guide) => (
                              <label key={guide.id} className={settings.subAgentCategoryItem}>
                                <input
                                  type="checkbox"
                                  checked={subAgentForm.enabledUserGuideIds.includes(guide.id)}
                                  disabled={Boolean(subAgentForm.isDefault) || guide.enabled === false}
                                  onChange={(event) =>
                                    setSubAgentForm({
                                      ...subAgentForm,
                                      enabledUserGuideIds: event.target.checked
                                        ? [...subAgentForm.enabledUserGuideIds, guide.id]
                                        : subAgentForm.enabledUserGuideIds.filter((item) => item !== guide.id),
                                    })
                                  }
                                />
                                <span>{guide.title}</span>
                              </label>
                            ))}
                          </div>
                          <p className={settings.hint}>
                            默认智能体不可修改；自定义智能体可选择独立指南权限。
                          </p>
                        </div>
                      </div>

                      {subAgentForm.builtinToolGroups.includes("game") ? (
                        <div className={settings.subAgentGuideGroupCard}>
                          <h6>Game Agent 限制</h6>
                          <div className={settings.formGrid}>
                            {(
                              [
                                ["maxActionsPerScript", "单次脚本最多动作数"],
                                ["maxWaitMs", "单次等待毫秒数"],
                                ["maxScriptDurationMs", "单次脚本最长运行毫秒数"],
                                ["maxToolTurns", "最大工具轮数"],
                                ["maxScreenshotBytes", "截图大小上限"],
                              ] as const
                            ).map(([key, label]) => (
                              <label key={key} className={settings.field}>
                                <span className={settings.label}>{label}</span>
                                <input
                                  className={settings.input}
                                  value={
                                    key === "maxScreenshotBytes"
                                      ? formatByteLimitInputValue(subAgentForm.gameLimits?.[key], DEFAULT_GAME_AGENT_LIMITS[key])
                                      : formatGameLimitInputValue(subAgentForm.gameLimits?.[key], DEFAULT_GAME_AGENT_LIMITS[key])
                                  }
                                  onChange={(event) =>
                                    setSubAgentForm({
                                      ...subAgentForm,
                                      gameLimits: {
                                        ...(subAgentForm.gameLimits || DEFAULT_GAME_AGENT_LIMITS),
                                        [key]: key === "maxScreenshotBytes" ? parseByteLimitInputValue(event.target.value) : parseGameLimitInputValue(event.target.value),
                                      },
                                    })
                                  }
                                />
                              </label>
                            ))}
                          </div>
                          <p className={settings.hint}>数值可填写正整数或 infinite；字节限制支持 120KB、1MB、500B 等格式，用于限制 DOM 截图大小。</p>
                          {hasInfiniteGameLimit(subAgentForm) ? (
                            <p className={settings.warningText}>已配置 infinite，请注意 Token 消耗。</p>
                          ) : null}
                        </div>
                      ) : null}

                      <div className={`${settings.toolbar} ${settings.formActions}`}>
                        <div className={settings.hint}>
                          保存后会立即应用到 @ 面板和子智能体工具调用。
                        </div>
                        <div className={settings.actions}>
                          <button type="button" className={settings.button} onClick={() => onEditSubAgent(null)}>
                            取消编辑
                          </button>
                          <button
                            type="button"
                            className={settings.primaryButton}
                            onClick={handleSaveCurrentSubAgent}
                          >
                            保存智能体
                          </button>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className={settings.cardBody}>
                      <p className={settings.hint}>请选择一个智能体开始编辑，或新建智能体。</p>
                    </div>
                  )}
                </section>

                <section className={settings.card}>
                  <div className={settings.cardHeader}>
                    <div>
                      <h5>智能体列表</h5>
                      <p>启用的智能体会显示在 @ 面板中，可快速切换开启状态。</p>
                    </div>
                  </div>
                  <div className={`${settings.cardBody} ${settings.subAgentList}`}>
                    {subAgents.map((agent) => (
                      <article key={agent.id} className={settings.subAgentItem}>
                        <div className={settings.subAgentItemHeader}>
                          <div className={settings.subAgentItemMeta}>
                            <span
                              className={settings.subAgentAvatarPreview}
                              style={{ backgroundColor: agent.avatarBackground }}
                            >
                              <SubAgentIcon icon={agent.avatarIcon} className={settings.subAgentAvatarPreviewIcon} />
                            </span>
                            <div>
                              <div className={settings.agentName}>{agent.name}</div>
                              <div className={settings.agentProvider}>
                                {agent.isDefault ? "默认智能体" : "自定义智能体"} · {agent.enabled === false ? "已禁用" : "已启用"} · 能力 {formatToolGroups(agent)}
                              </div>
                              {hasInfiniteGameLimit(agent) ? (
                                <div className={settings.warningText}>已配置 infinite，请注意 Token 消耗。</div>
                              ) : null}
                            </div>
                          </div>
                          <div className={`${settings.actions} ${settings.subAgentItemActions}`}>
                            <label
                              className={settings.subAgentSwitch}
                              title={agent.enabled === false ? "启用智能体" : "禁用智能体"}
                              aria-label={agent.enabled === false ? `启用 ${agent.name}` : `禁用 ${agent.name}`}
                            >
                              <input
                                type="checkbox"
                                checked={agent.enabled !== false}
                                onChange={(event) => handleToggleSubAgentEnabled(agent, event.target.checked)}
                              />
                              <span aria-hidden="true" />
                            </label>
                            <button
                              type="button"
                              className={settings.button}
                              onClick={() => onEditSubAgent(agent)}
                            >
                              编辑
                            </button>
                            <button
                              type="button"
                              className={settings.dangerButton}
                              onClick={() => onDeleteSubAgent(agent.id)}
                              disabled={Boolean(agent.isDefault)}
                            >
                              删除
                            </button>
                          </div>
                        </div>
                        <div className={settings.subAgentItemBody}>
                          <p>{agent.description || "暂无描述"}</p>
                          <div className={settings.subAgentCategoryPills}>
                            {agent.enabled === false ? (
                              <span className={settings.subAgentCategoryPill}>disabled</span>
                            ) : null}
                            {agent.builtinToolGroups.map((group) => (
                              <span key={group} className={settings.subAgentCategoryPill}>
                                {group}
                              </span>
                            ))}
                            {agent.enabledGuideCategories.map((category) => (
                              <span key={category} className={settings.subAgentCategoryPill}>
                                {category}
                              </span>
                            ))}
                          </div>
                        </div>
                      </article>
                    ))}
                  </div>
                </section>
              </div>
            ) : null}

            {activeSection === "models" ? (
              <div className={settings.sectionStack}>
                <section className={settings.card}>
                  <div className={settings.cardHeader}>
                    <div>
                      <h5>图片生成模型</h5>
                      <p>选择新增或更新造型时使用的图片生成模型。</p>
                    </div>
                  </div>
                  <div className={settings.cardBody}>
                    <label className={`${settings.field} ${settings.fieldFull}`}>
                      <span className={settings.label}>用于生成图片的模型</span>
                      <select
                        className={settings.select}
                        value={imageModelId}
                        onChange={(event) => onImageModelIdChange(event.target.value)}
                      >
                        <option value="">不配置</option>
                        {imageModelOptions.map((model) => (
                          <option key={model.id} value={model.id}>
                            {model.label}
                          </option>
                        ))}
                      </select>
                      <small className={settings.hint}>
                        可复用下方已配置的 Base URL 和 API Key；不配置时使用默认模型。
                      </small>
                    </label>
                  </div>
                </section>

                <section className={settings.card}>
                  <div className={settings.cardHeader}>
                    <div>
                      <h5>{editingAgent ? "编辑模型服务" : "添加模型服务"}</h5>
                      <p>配置供应商、Base URL、API Key 和模型列表。</p>
                    </div>
                    <div className={settings.actions}>
                      <button type="button" className={settings.button} onClick={() => fileInputRef.current?.click()}>
                        导入配置
                      </button>
                    </div>
                  </div>
                  <form className={settings.cardBody} onSubmit={handleSave}>
                    <div className={settings.formGrid}>
                      <label className={settings.field}>
                        <span className={settings.label}>名称</span>
                        <input
                          className={settings.input}
                          value={formData.name || ""}
                          onChange={(event) => setFormData({ ...formData, name: event.target.value })}
                          placeholder="例如：我的 OpenAI"
                          required
                        />
                      </label>
                      <label className={settings.field}>
                        <span className={settings.label}>供应商</span>
                        <select
                          className={settings.select}
                          value={formData.provider || "openai"}
                          onChange={handleProviderChange}
                        >
                          <option value="openai">OpenAI</option>
                          <option value="zhipu">智谱清言</option>
                          <option value="anthropic">Anthropic</option>
                          <option value="deepseek">DeepSeek</option>
                          <option value="custom">自定义 OpenAI 兼容接口</option>
                          <option value="custom_anthropic">自定义 Anthropic 兼容接口</option>
                        </select>
                      </label>
                      <label className={`${settings.field} ${settings.fieldFull}`}>
                        <span className={settings.label}>Base URL</span>
                        <input
                          className={settings.input}
                          value={formData.baseUrl || ""}
                          onChange={(event) => setFormData({ ...formData, baseUrl: event.target.value })}
                          placeholder="留空使用供应商默认地址"
                        />
                      </label>
                      <label className={`${settings.field} ${settings.fieldFull}`}>
                        <span className={settings.label}>API Key</span>
                        <input
                          className={settings.input}
                          type="password"
                          value={formData.apiKey || ""}
                          onChange={(event) => setFormData({ ...formData, apiKey: event.target.value })}
                          placeholder="sk-..."
                        />
                      </label>
                    </div>

                    <div className={settings.cardHeader}>
                      <div>
                        <h5>模型列表</h5>
                        <p>填写显示名称、模型 ID 和可选上下文上限。</p>
                      </div>
                      <button type="button" className={settings.button} onClick={addModel}>
                        添加模型
                      </button>
                    </div>
                    <div className={settings.modelsTable}>
                      {models.map((model) => (
                        <div key={model.id} className={settings.modelRow}>
                          <input
                            className={settings.input}
                            value={model.name}
                            onChange={(event) => updateModel(model.id, "name", event.target.value)}
                            placeholder="显示名称"
                            required
                          />
                          <input
                            className={settings.input}
                            value={model.modelId}
                            onChange={(event) => updateModel(model.id, "modelId", event.target.value)}
                            placeholder="模型 ID"
                            required
                          />
                          <input
                            className={settings.input}
                            type="number"
                            min={2048}
                            max={1000000}
                            value={model.maxTokens || ""}
                            onChange={(event) =>
                              updateModel(
                                model.id,
                                "maxTokens",
                                event.target.value ? Number(event.target.value) : undefined,
                              )
                            }
                            placeholder="Max Tokens"
                          />
                          <button
                            type="button"
                            className={settings.dangerButton}
                            onClick={() => removeModel(model.id)}
                            disabled={models.length <= 1}
                          >
                            删除
                          </button>
                        </div>
                      ))}
                    </div>

                    <div className={`${settings.toolbar} ${settings.formActions}`}>
                      <div className={settings.hint}>配置只保存在本地插件存储中。</div>
                      <div className={settings.actions}>
                        {editingAgent ? (
                          <button type="button" className={settings.button} onClick={() => onEditAgent(null)}>
                            取消编辑
                          </button>
                        ) : null}
                        <button type="submit" className={settings.primaryButton}>
                          {editingAgent ? "保存修改" : "添加模型服务"}
                        </button>
                      </div>
                    </div>
                  </form>
                </section>

                <section className={settings.card}>
                  <div className={settings.cardHeader}>
                    <div>
                      <h5>已配置模型服务</h5>
                      <p>管理当前可用的模型供应商配置。</p>
                    </div>
                  </div>
                  <div className={`${settings.cardBody} ${settings.agentList}`}>
                    {agents.map((agent) => (
                      <article key={agent.id} className={settings.agentItem}>
                        <div className={settings.agentItemHeader}>
                          <div>
                            <div className={settings.agentName}>{agent.name || (agent as any).displayName}</div>
                            <div className={settings.agentProvider}>
                              {PROVIDER_LABELS[agent.provider] || agent.provider}
                            </div>
                          </div>
                          <div className={settings.actions}>
                            <button type="button" className={settings.button} onClick={() => onEditAgent(agent)}>
                              编辑
                            </button>
                            <button type="button" className={settings.button} onClick={() => onExportAgent(agent.id)}>
                              导出
                            </button>
                            <button
                              type="button"
                              className={settings.dangerButton}
                              onClick={() => onDeleteAgent(agent.id)}
                            >
                              删除
                            </button>
                          </div>
                        </div>
                        <div className={settings.modelList}>
                          {(agent.models || []).map((model) => (
                            <div key={model.id} className={settings.modelItem}>
                              <strong>{model.name}</strong>
                              <span>
                                {model.modelId}
                                {model.maxTokens ? ` · ${model.maxTokens}` : ""}
                              </span>
                            </div>
                          ))}
                        </div>
                      </article>
                    ))}
                  </div>
                </section>
              </div>
            ) : null}

            {activeSection === "guides" ? (
              <div className={`${settings.sectionStack} ${settings.guidesSection}`}>
                <section className={`${settings.card} ${settings.guidesCard}`}>
                  <div className={settings.cardHeader}>
                    <div>
                      <h5>指南</h5>
                      <p>管理内置指南、用户指南、AI 指南和扩展指南。</p>
                    </div>
                    <div className={settings.actions}>
                      <button type="button" className={settings.button} onClick={handleCreateGuide}>
                        新建指南
                      </button>
                      <button
                        type="button"
                        className={settings.button}
                        onClick={() => guideFileInputRef.current?.click()}
                      >
                        导入指南
                      </button>
                    </div>
                  </div>
                  <div className={`${settings.cardBody} ${settings.guideLayout}`}>
                    <div className={settings.guideList}>
                      {displayedGuideGroups.map((group) => (
                        <div key={group.key} className={settings.guideSection}>
                          <div className={settings.guideSectionTitle}>{group.title}</div>
                          {group.guides.length ? (
                            group.guides.map((guide) => (
                              <button
                                key={guide.id}
                                type="button"
                                className={`${settings.guideItem} ${selectedGuide?.id === guide.id ? settings.guideItemActive : ""}`}
                                onClick={() => setSelectedGuideId(guide.id)}
                              >
                                <span className={settings.guideItemTitle}>{guide.title}</span>
                                <span className={settings.guideItemMeta}>
                                  {guide.source === "default"
                                    ? "默认只读"
                                    : guide.source === "extension"
                                      ? `扩展只读${guide.extensionName ? ` · ${guide.extensionName}` : ""}`
                                      : guide.enabled
                                        ? "已启用"
                                        : "已禁用"}
                                  {guide.tools.length ? ` · ${guide.tools.length} 个工具` : ""}
                                </span>
                              </button>
                            ))
                          ) : (
                            <div className={settings.guideEmpty}>暂无{group.title}</div>
                          )}
                        </div>
                      ))}
                    </div>

                    {selectedGuide ? (
                      <div className={settings.guideDetail}>
                        <div className={settings.toolbar}>
                          <div>
                            <div className={settings.agentName}>{selectedGuide.title}</div>
                            <div className={settings.agentProvider}>
                              {selectedGuide.name}.md ·{" "}
                              {selectedGuide.source === "default"
                                ? "默认只读"
                                : selectedGuide.source === "extension"
                                  ? `扩展只读${selectedGuide.extensionName ? ` · ${selectedGuide.extensionName}` : ""}`
                                  : selectedGuide.source === "ai" ? "AI 指南" : "用户指南"}
                            </div>
                          </div>
                          <div className={settings.actions}>
                            {selectedGuide.source === "user" ? (
                              <>
                                <button
                                  type="button"
                                  className={settings.button}
                                  onClick={() => onToggleGuide(selectedGuide.id, !selectedGuide.enabled)}
                                >
                                  {selectedGuide.enabled ? "禁用" : "启用"}
                                </button>
                                <button type="button" className={settings.primaryButton} onClick={handleSaveGuide}>
                                  保存
                                </button>
                                <button
                                  type="button"
                                  className={settings.dangerButton}
                                  onClick={() => {
                                    onDeleteGuide(selectedGuide.id);
                                    setSelectedGuideId(allGuides[0]?.id || "");
                                  }}
                                >
                                  删除
                                </button>
                              </>
                            ) : selectedGuide.source === "ai" ? (
                              <button
                                type="button"
                                className={settings.dangerButton}
                                onClick={() => {
                                  onDeleteGuide(selectedGuide.id);
                                  setSelectedGuideId(allGuides[0]?.id || "");
                                }}
                              >
                                删除
                              </button>
                            ) : null}
                          </div>
                        </div>

                        {selectedGuide.source === "user" ? (
                          <div className={settings.formGrid}>
                            <label className={settings.field}>
                              <span className={settings.label}>指南名称 / skillName</span>
                              <input
                                className={settings.input}
                                value={guideDraft.name || ""}
                                onChange={(event) =>
                                  setGuideDraft((previous) => ({ ...previous, name: event.target.value }))
                                }
                              />
                            </label>
                            <label className={settings.field}>
                              <span className={settings.label}>标题</span>
                              <input
                                className={settings.input}
                                value={guideDraft.title || ""}
                                onChange={(event) =>
                                  setGuideDraft((previous) => ({ ...previous, title: event.target.value }))
                                }
                              />
                            </label>
                            <label className={settings.field}>
                              <span className={settings.label}>指南分类</span>
                              <select
                                className={settings.select}
                                value={String(guideDraft.category || "read")}
                                onChange={(event) =>
                                  setGuideDraft((previous) => ({ ...previous, category: event.target.value }))
                                }
                              >
                                {editableGuideCategories.map((category) => (
                                  <option key={category} value={category}>
                                    {category}
                                  </option>
                                ))}
                              </select>
                            </label>
                            <label className={`${settings.field} ${settings.fieldFull}`}>
                              <span className={settings.label}>Markdown 内容</span>
                              <textarea
                                className={settings.textarea}
                                value={guideDraft.content || ""}
                                onChange={(event) =>
                                  setGuideDraft((previous) => ({ ...previous, content: event.target.value }))
                                }
                              />
                            </label>
                            <label className={`${settings.field} ${settings.fieldFull}`}>
                              <span className={settings.label}>index.js 工具实现</span>
                              <textarea
                                className={settings.textarea}
                                value={guideDraft.indexJs || ""}
                                onChange={(event) =>
                                  setGuideDraft((previous) => ({ ...previous, indexJs: event.target.value }))
                                }
                                placeholder={'let toolName = (input) => { return ""; }'}
                              />
                            </label>
                          </div>
                        ) : (
                          <pre className={settings.markdownPreview}>{selectedGuide.content}</pre>
                        )}

                        <div className={settings.guideToolsPanel}>
                          <div className={settings.cardHeader}>
                            <div>
                              <h5>工具</h5>
                              <p>智能体可通过 runGuideTool 调用指南工具，名称格式为 skillName.toolName。</p>
                            </div>
                          </div>
                          <div className={settings.toolList}>
                            {selectedGuide.tools.length ? (
                              selectedGuide.tools.map((tool) => (
                                <article key={tool.name} className={settings.toolItem}>
                                  <strong>{tool.name}</strong>
                                  <pre>{tool.implementation}</pre>
                                </article>
                              ))
                            ) : (
                              <p className={settings.hint}>此指南未提供工具实现。</p>
                            )}
                          </div>
                        </div>
                      </div>
                    ) : null}
                  </div>
                </section>
              </div>
            ) : null}

            {activeSection === "memory" ? (
              <div className={settings.sectionStack}>
                <section className={settings.card}>
                  <div className={settings.cardHeader}>
                    <div>
                      <h5>新建记忆</h5>
                      <p>长期记忆跨项目生效；项目记忆仅对当前已保存作品生效。</p>
                    </div>
                    <div className={settings.actions}>
                      <button type="button" className={settings.button} onClick={refreshMemories}>
                        刷新
                      </button>
                      <button
                        type="button"
                        className={settings.primaryButton}
                        onClick={handleCreateMemory}
                        disabled={!newMemoryContent.trim() || (newMemoryScope === "project" && !projectMemoryAvailable)}
                      >
                        + 新建记忆
                      </button>
                    </div>
                  </div>
                  <div className={`${settings.cardBody} ${settings.memoryNewGrid}`}>
                    <label className={settings.field}>
                      <span className={settings.label}>范围</span>
                      <select
                        className={settings.select}
                        value={newMemoryScope}
                        onChange={(event) => setNewMemoryScope(event.target.value as MemoryScope)}
                      >
                        <option value="longTerm">长期记忆</option>
                        <option value="project" disabled={!projectMemoryAvailable}>
                          {`项目记忆${projectMemoryAvailable ? ` · ${projectMemoryId}` : " · 需要先保存作品"}`}
                        </option>
                      </select>
                    </label>
                    <label className={settings.field}>
                      <span className={settings.label}>描述</span>
                      <input
                        className={settings.input}
                        value={newMemoryDescription}
                        onChange={(event) => setNewMemoryDescription(event.target.value)}
                        placeholder="例如：user_info / project_rules"
                      />
                    </label>
                    <label className={`${settings.field} ${settings.fieldFull}`}>
                      <span className={settings.label}>内容</span>
                      <textarea
                        className={`${settings.textarea} ${settings.memoryTextarea}`}
                        value={newMemoryContent}
                        onChange={(event) => setNewMemoryContent(event.target.value.slice(0, 5000))}
                        placeholder="写入希望 AI 长期记住的信息。"
                      />
                    </label>
                    <div className={`${settings.toolbar} ${settings.fieldFull}`}>
                      <div className={settings.hint}>
                        {projectMemoryAvailable
                          ? `当前项目 ID：${projectMemoryId}`
                          : projectMemoryError || "当前作品未保存，无法写入项目记忆。"}
                      </div>
                      <div className={settings.memoryCharCount}>{newMemoryContentLength}/5000 字符</div>
                    </div>
                  </div>
                </section>

                <section className={settings.card}>
                  <div className={settings.cardHeader}>
                    <div>
                      <h5>记忆列表</h5>
                      <p>{activeMemoryDescription}</p>
                    </div>
                  </div>
                  <div className={`${settings.cardBody} ${settings.memoryManagerBody}`}>
                    <div className={settings.memoryTabs} role="tablist" aria-label="记忆类型">
                      <button
                        type="button"
                        role="tab"
                        aria-selected={activeMemoryScope === "longTerm"}
                        className={`${settings.memoryTab} ${activeMemoryScope === "longTerm" ? settings.memoryTabActive : ""}`}
                        onClick={() => setActiveMemoryScope("longTerm")}
                      >
                        <span>长期记忆</span>
                        <em>{longTermMemories.length}</em>
                      </button>
                      <button
                        type="button"
                        role="tab"
                        aria-selected={activeMemoryScope === "project"}
                        className={`${settings.memoryTab} ${activeMemoryScope === "project" ? settings.memoryTabActive : ""}`}
                        onClick={() => setActiveMemoryScope("project")}
                      >
                        <span>项目记忆</span>
                        <em>{projectMemories.length}</em>
                      </button>
                    </div>

                    <div className={settings.memoryBlockList}>
                      {visibleMemoryBlocks.length ? (
                        visibleMemoryBlocks.map((block) => {
                          const draft = memoryDrafts[block.id] || {
                            description: block.description || "",
                            content: block.content,
                          };
                          const changed =
                            draft.description !== (block.description || "") || draft.content !== block.content;
                          return (
                            <article key={block.id} className={settings.memoryBlockItem}>
                              <div className={settings.memoryBlockHeader}>
                                <div className={settings.memoryBlockTitleWrap}>
                                  <strong>{block.description || block.id}</strong>
                                  <span>
                                    {block.id} · {draft.content.length}/5000 字符
                                  </span>
                                </div>
                                <div className={settings.actions}>
                                  <button
                                    type="button"
                                    className={settings.button}
                                    onClick={() => handleSaveMemory(block)}
                                    disabled={!changed || !draft.content.trim()}
                                  >
                                    保存
                                  </button>
                                  <button
                                    type="button"
                                    className={settings.dangerButton}
                                    onClick={() => handleDeleteMemory(block)}
                                  >
                                    删除
                                  </button>
                                </div>
                              </div>
                              <div className={settings.memoryRowFields}>
                                <label className={settings.field}>
                                  <span className={settings.label}>描述</span>
                                  <input
                                    className={settings.input}
                                    value={draft.description}
                                    onChange={(event) => updateMemoryDraft(block.id, "description", event.target.value)}
                                  />
                                </label>
                                <label className={settings.field}>
                                  <span className={settings.label}>内容</span>
                                  <textarea
                                    className={`${settings.textarea} ${settings.memoryTextarea}`}
                                    value={draft.content}
                                    onChange={(event) =>
                                      updateMemoryDraft(block.id, "content", event.target.value.slice(0, 5000))
                                    }
                                  />
                                </label>
                              </div>
                            </article>
                          );
                        })
                      ) : (
                        <div className={settings.memoryEmpty}>暂无{activeMemoryTitle}。</div>
                      )}
                    </div>
                  </div>
                </section>
              </div>
            ) : null}

            {activeSection === "appearance" ? (
              <section className={settings.card}>
                <div className={settings.cardHeader}>
                  <div>
                    <h5>主题模式</h5>
                    <p>支持切换主题。</p>
                  </div>
                </div>
                <div className={settings.cardBody}>
                  <div className={settings.themeChoices}>
                    {THEME_CHOICES.map((choice) => (
                      <button
                        key={choice.mode}
                        type="button"
                        className={`${settings.themeChoice} ${
                          themeMode === choice.mode ? settings.themeChoiceActive : ""
                        }`}
                        onClick={() => onThemeModeChange(choice.mode)}
                      >
                        <strong>{choice.title}</strong>
                        <span>{choice.description}</span>
                      </button>
                    ))}
                  </div>
                </div>
              </section>
            ) : null}

            {activeSection === "about" ? (
              <section className={settings.card}>
                <div className={settings.cardHeader}>
                  <div>
                    <h5>关于 AI Assistant</h5>
                    <p>插件作者、授权协议与源码仓库信息。</p>
                  </div>
                </div>
                <div className={`${settings.cardBody} ${settings.sectionStack}`}>
                  <div className={settings.toolbar}>
                    <strong>作者</strong>
                    <div className={settings.actions}>
                      <a
                        className={settings.button}
                        href="https://www.ccw.site/student/6173f57f48cf8f4796fc860e"
                        target="_blank"
                        rel="noreferrer"
                      >
                        白猫
                      </a>
                      <a
                        className={settings.button}
                        href="https://www.ccw.site/student/610b508176415b2f27e0f851"
                        target="_blank"
                        rel="noreferrer"
                      >
                        酷可mc
                      </a>
                    </div>
                  </div>
                  <div className={settings.toolbar}>
                    <strong>开源协议</strong>
                    <span className={settings.hint}>GNU Affero General Public License v3.0 or later（AGPL-3.0-or-later）</span>
                  </div>
                  <div className={settings.toolbar}>
                    <strong>开源地址</strong>
                    <a
                      className={settings.button}
                      href="https://github.com/little-starts/gandi-plugins/tree/main/src/plugins/ai-assistant"
                      target="_blank"
                      rel="noreferrer"
                    >
                      GitHub 仓库
                    </a>
                  </div>
                </div>
              </section>
            ) : null}
          </div>
        </main>
      </div>
    </div>
  );
};
