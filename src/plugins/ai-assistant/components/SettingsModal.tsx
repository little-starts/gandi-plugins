import * as React from "react";
import styles from "../styles.less";
import { Agent, AgentModel } from "../types";
import { PROVIDER_DEFAULT_URLS } from "../constants";

interface SettingsModalProps {
  agents: Agent[];
  editingAgent: Agent | null;
  onSaveAgent: (agent: Agent) => void;
  onDeleteAgent: (id: string) => void;
  onExportAgent: (id: string) => void;
  onImportAgent: (file: File) => Promise<void>;
  onEditAgent: (agent: Agent | null) => void;
  onClose: () => void;
  isFullScreen?: boolean;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({
  agents,
  editingAgent,
  onSaveAgent,
  onDeleteAgent,
  onExportAgent,
  onImportAgent,
  onEditAgent,
  onClose,
  isFullScreen,
}) => {
  const fileInputRef = React.useRef<HTMLInputElement | null>(null);

  const [formData, setFormData] = React.useState<Partial<Agent>>({ provider: "openai" });
  const [models, setModels] = React.useState<AgentModel[]>([]);

  React.useEffect(() => {
    if (editingAgent) {
      setFormData({
        provider: editingAgent.provider,
        name: editingAgent.name || (editingAgent as any).displayName || "",
        baseUrl: editingAgent.baseUrl,
        apiKey: editingAgent.apiKey,
      });
      setModels(editingAgent.models || [
        {
          id: `${editingAgent.id}-model`,
          name: (editingAgent as any).displayName || "Default Model",
          modelId: (editingAgent as any).modelName || "gpt-3.5-turbo",
          maxTokens: (editingAgent as any).maxTokens,
        }
      ]);
    } else {
      setFormData({ provider: "openai" });
      setModels([{ id: Date.now().toString(), name: "My GPT-4o", modelId: "gpt-4o" }]);
    }
  }, [editingAgent]);

  const handleProviderChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const provider = e.target.value as Agent["provider"];
    let baseUrl = formData.baseUrl || "";
    
    let defaultModelId = "gpt-4o";
    let defaultModelName = "My Model";

    if (provider === "zhipu") {
      if (!baseUrl || baseUrl === "https://api.openai.com/v1") baseUrl = "https://open.bigmodel.cn/api/paas/v4";
      defaultModelId = "glm-4";
      defaultModelName = "GLM-4";
    } else if (provider === "deepseek") {
      if (!baseUrl || baseUrl === "https://api.openai.com/v1") baseUrl = "https://api.deepseek.com";
      defaultModelId = "deepseek-chat";
      defaultModelName = "DeepSeek Chat";
    } else if (provider === "anthropic") {
      if (!baseUrl || baseUrl === "https://api.openai.com/v1") baseUrl = "https://api.anthropic.com/v1";
      defaultModelId = "claude-3-5-sonnet-latest";
      defaultModelName = "Claude 3.5 Sonnet";
    } else if (provider === "openai") {
      if (!baseUrl || baseUrl.includes("bigmodel") || baseUrl.includes("deepseek")) baseUrl = "https://api.openai.com/v1";
      defaultModelId = "gpt-4o";
      defaultModelName = "GPT-4o";
    } else if (provider === "custom" || provider === "custom_anthropic") {
      defaultModelId = provider === "custom_anthropic" ? "claude-3-5-sonnet-latest" : "gpt-4o-mini";
      defaultModelName = "Custom Model";
    }

    setFormData((prev) => ({ ...prev, provider, baseUrl }));
    if (models.length === 1 && (!models[0].modelId || models[0].modelId.startsWith("gpt-") || models[0].modelId.startsWith("glm-") || models[0].modelId.startsWith("deepseek"))) {
      setModels([{ id: models[0].id, name: defaultModelName, modelId: defaultModelId, maxTokens: models[0].maxTokens }]);
    }
  };

  const handleSave = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const provider = formData.provider as Agent["provider"];
    let baseUrl = formData.baseUrl || "";

    if (!baseUrl.trim()) {
      baseUrl = PROVIDER_DEFAULT_URLS[provider] || "";
    }

    const newAgent: Agent = {
      id: editingAgent?.id || Date.now().toString(),
      provider: provider,
      baseUrl: baseUrl,
      apiKey: formData.apiKey || "",
      name: formData.name || "",
      models: models.filter(m => m.name.trim() && m.modelId.trim()),
    };

    if (newAgent.models.length === 0) {
      window.alert("请至少添加一个有效的模型");
      return;
    }

    onSaveAgent(newAgent);
  };

  const addModel = () => {
    setModels([...models, { id: Date.now().toString(), name: "", modelId: "" }]);
  };

  const updateModel = (id: string, field: keyof AgentModel, value: string | number | undefined) => {
    setModels(models.map(m => m.id === id ? { ...m, [field]: value } : m));
  };

  const removeModel = (id: string) => {
    setModels(models.filter(m => m.id !== id));
  };

  const [isWideScreen, setIsWideScreen] = React.useState(false);

  React.useEffect(() => {
    const handleResize = () => {
      // Assuming parent container logic updates something, we can use window or just rely on CSS
      // But since we need dynamic class based on width > 600px
      const modalElement = document.getElementById('ai-assistant-settings-modal');
      if (modalElement) {
        setIsWideScreen(modalElement.clientWidth > 500);
      }
    };
    
    handleResize();
    window.addEventListener('resize', handleResize);
    // Also set up a ResizeObserver for the specific modal
    const observer = new ResizeObserver(() => {
      handleResize();
    });
    
    // Will observe when rendered
    setTimeout(() => {
      const modalElement = document.getElementById('ai-assistant-settings-modal');
      if (modalElement) observer.observe(modalElement);
    }, 100);

    return () => {
      window.removeEventListener('resize', handleResize);
      observer.disconnect();
    };
  }, []);

  return (
    <div className={styles.settingsModalOverlay} style={isFullScreen ? { padding: 0, background: '#fff' } : {}}>
      <div id="ai-assistant-settings-modal" className={`${styles.settingsModal} ${isFullScreen ? styles.settingsModalFullScreen : ""}`}>
        <div className={styles.settingsModalHeader}>
          <h3>AI Agent 管理</h3>
          <div className={styles.actions}>
            <button type="button" onClick={() => fileInputRef.current?.click()} style={{ background: '#e9edf8', color: '#31405e', border: 'none', fontWeight: 'bold' }}>
              导入 Agent
            </button>
          </div>
        </div>

        <input
          ref={fileInputRef}
          type="file"
          accept="application/json,.json"
          className={styles.fileInput}
          onChange={async (event) => {
            const file = event.target.files?.[0];
            if (!file) return;
            try {
              await onImportAgent(file);
            } catch (error) {
              const message = error instanceof Error ? error.message : "导入失败";
              window.alert(message);
            } finally {
              event.target.value = "";
            }
          }}
        />

        <div className={`${styles.settingsModalContent} ${isWideScreen ? styles.settingsModalContentHorizontal : ""}`}>
          <form key={editingAgent?.id || "new"} className={styles.agentForm} onSubmit={handleSave}>
            <input
              name="name"
              placeholder="提供商名称 (如: 我的 OpenAI)"
              value={formData.name || ""}
              onChange={(e) => setFormData({ ...formData, name: e.target.value })}
              required
            />
            <select
              name="provider"
              value={formData.provider || "openai"}
              onChange={handleProviderChange}
              required
            >
              <option value="openai">OpenAI</option>
              <option value="zhipu">智谱清言 (Zhipu AI)</option>
              <option value="anthropic">Anthropic (Claude)</option>
              <option value="deepseek">DeepSeek</option>
              <option value="custom">自定义 OpenAI 兼容接口</option>
              <option value="custom_anthropic">自定义 Anthropic 兼容接口</option>
            </select>
            <input 
              name="baseUrl" 
              placeholder="Base URL (留空使用官方默认)" 
              value={formData.baseUrl || ""} 
              onChange={(e) => setFormData({ ...formData, baseUrl: e.target.value })}
            />
            <input 
              name="apiKey" 
              placeholder="API Key" 
              type="password" 
              value={formData.apiKey || ""} 
              onChange={(e) => setFormData({ ...formData, apiKey: e.target.value })}
            />
            
            <div style={{ marginTop: '8px', marginBottom: '4px', fontWeight: 'bold', fontSize: '13px', color: '#1e2942' }}>
              子模型列表
            </div>
            {models.map((model, index) => (
              <div key={model.id} style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
                <input
                  placeholder="显示名称 (如: GPT-4o)"
                  value={model.name}
                  onChange={(e) => updateModel(model.id, 'name', e.target.value)}
                  required
                  style={{ flex: 1, minWidth: '120px' }}
                />
                <input
                  placeholder="模型 ID (如: gpt-4o)"
                  value={model.modelId}
                  onChange={(e) => updateModel(model.id, 'modelId', e.target.value)}
                  required
                  style={{ flex: 1, minWidth: '120px' }}
                />
                <input
                  type="number"
                  placeholder="Max Tokens (留空默认)"
                  value={model.maxTokens || ""}
                  onChange={(e) => updateModel(model.id, 'maxTokens', e.target.value ? parseInt(e.target.value, 10) : undefined as any)}
                  min={2048}
                  max={1000000}
                  style={{ flex: 1, minWidth: '120px' }}
                  title="上下文 Token 上限 (2048 - 1000000)"
                />
                {models.length > 1 && (
                  <button type="button" onClick={() => removeModel(model.id)} style={{ padding: '0 8px', minHeight: '42px' }}>
                    删
                  </button>
                )}
              </div>
            ))}
            <button type="button" onClick={addModel} style={{ alignSelf: 'flex-start', padding: '0 12px', minHeight: '32px', fontSize: '13px' }}>
              + 添加模型
            </button>

            <div style={{ display: 'flex', gap: '8px', marginTop: '12px' }}>
              <button type="submit" style={{ flex: 1 }}>{editingAgent ? "保存修改" : "添加 Agent"}</button>
              {editingAgent ? (
                <button type="button" onClick={() => onEditAgent(null)} style={{ flex: 1 }}>
                  取消编辑
                </button>
              ) : null}
            </div>
          </form>

          <div className={styles.agentList}>
            {agents.map((a) => (
              <div key={a.id} className={styles.agentItem}>
                <div className={styles.agentItemHeader}>
                  <span>{a.name || (a as any).displayName} ({a.provider})</span>
                  <div className={styles.actions}>
                    <button onClick={() => onEditAgent(a)}>编辑</button>
                    <button onClick={() => onExportAgent(a.id)}>导出</button>
                    <button onClick={() => onDeleteAgent(a.id)}>删除</button>
                  </div>
                </div>
                {a.models && a.models.length > 0 && (
                  <div className={styles.agentModelsList}>
                    {a.models.map(m => (
                      <div key={m.id} className={styles.agentModelItem}>
                        <span>{m.name}</span>
                        <span style={{ color: '#71809b' }}>{m.modelId}{m.maxTokens ? ` (${m.maxTokens} tokens)` : ''}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>

        <button className={styles.closeBtn} onClick={onClose} style={{ flexShrink: 0 }}>
          关闭
        </button>
      </div>
    </div>
  );
};
