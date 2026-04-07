import * as React from "react";
import styles from "../styles.less";
import { Agent } from "../types";

interface SettingsModalProps {
  agents: Agent[];
  editingAgent: Agent | null;
  onSaveAgent: (e: React.FormEvent<HTMLFormElement>) => void;
  onDeleteAgent: (id: string) => void;
  onEditAgent: (agent: Agent | null) => void;
  onClose: () => void;
  onProviderChange: (e: React.ChangeEvent<HTMLSelectElement>) => void;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({
  agents,
  editingAgent,
  onSaveAgent,
  onDeleteAgent,
  onEditAgent,
  onClose,
  onProviderChange,
}) => {
  return (
    <div className={styles.settingsModalOverlay}>
      <div className={styles.settingsModal}>
        <h3>AI Agent 管理</h3>

        <form key={editingAgent?.id || "new"} className={styles.agentForm} onSubmit={onSaveAgent}>
          <input
            name="displayName"
            placeholder="显示名称 (如: My GPT-4)"
            defaultValue={editingAgent?.displayName || ""}
            required
          />
          <select
            name="provider"
            defaultValue={editingAgent?.provider || "openai"}
            onChange={onProviderChange}
            required
          >
            <option value="openai">OpenAI</option>
            <option value="zhipu">智谱清言 (Zhipu AI)</option>
            <option value="anthropic">Anthropic (Claude)</option>
            <option value="deepseek">DeepSeek</option>
            <option value="custom">自定义 OpenAI 兼容接口</option>
          </select>
          <input name="baseUrl" placeholder="Base URL (留空使用官方默认)" defaultValue={editingAgent?.baseUrl || ""} />
          <input name="apiKey" placeholder="API Key" type="password" defaultValue={editingAgent?.apiKey || ""} />
          <input
            name="modelName"
            placeholder="模型名称 (如: gpt-4)"
            defaultValue={editingAgent?.modelName || ""}
            required
          />
          <button type="submit">{editingAgent ? "保存修改" : "添加 Agent"}</button>
          {editingAgent ? (
            <button type="button" onClick={() => onEditAgent(null)}>
              取消编辑
            </button>
          ) : null}
        </form>

        <div className={styles.agentList}>
          {agents.map((a) => (
            <div key={a.id} className={styles.agentItem}>
              <span>
                {a.displayName} ({a.modelName})
              </span>
              <div className={styles.actions}>
                <button onClick={() => onEditAgent(a)}>编辑</button>
                <button onClick={() => onDeleteAgent(a.id)}>删除</button>
              </div>
            </div>
          ))}
        </div>

        <button className={styles.closeBtn} onClick={onClose}>
          关闭
        </button>
      </div>
    </div>
  );
};
