import { useEffect, useState } from "react";
import useStorageInfo from "hooks/useStorageInfo";
import { Agent } from "../types";
import { PROVIDER_DEFAULT_URLS } from "../constants";

const DEFAULT_AGENTS: Agent[] = [
  {
    id: "default-1",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "",
    modelName: "gpt-3.5-turbo",
    displayName: "Default GPT-3.5",
  },
];

export function useAgents() {
  const [agents, setAgents] = useStorageInfo<Agent[]>("AI_ASSISTANT_AGENTS", DEFAULT_AGENTS);
  const [currentAgentId, setCurrentAgentId] = useStorageInfo<string>("AI_ASSISTANT_CURRENT_AGENT_ID", "default-1");
  const [showSettings, setShowSettings] = useState(false);
  const [editingAgent, setEditingAgent] = useState<Agent | null>(null);

  const currentAgent = agents.find((agent) => agent.id === currentAgentId) || agents[0] || null;

  useEffect(() => {
    if (!agents.length) {
      setAgents(DEFAULT_AGENTS);
      setCurrentAgentId(DEFAULT_AGENTS[0].id);
      return;
    }

    if (!agents.some((agent) => agent.id === currentAgentId)) {
      setCurrentAgentId(agents[0].id);
    }
  }, [agents, currentAgentId, setAgents, setCurrentAgentId]);

  const handleSaveAgent = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    const provider = formData.get("provider") as Agent["provider"];
    let baseUrl = formData.get("baseUrl") as string;

    if (!baseUrl.trim()) {
      baseUrl = PROVIDER_DEFAULT_URLS[provider] || "";
    }

    const newAgent: Agent = {
      id: editingAgent?.id || Date.now().toString(),
      provider: provider,
      baseUrl: baseUrl,
      apiKey: formData.get("apiKey") as string,
      modelName: formData.get("modelName") as string,
      displayName: formData.get("displayName") as string,
    };

    const nextAgents = editingAgent
      ? agents.map((agent) => (agent.id === editingAgent.id ? newAgent : agent))
      : [...agents, newAgent];

    setAgents(nextAgents);
    if (!currentAgentId || editingAgent?.id === currentAgentId) {
      setCurrentAgentId(newAgent.id);
    }
    setEditingAgent(null);
  };

  const handleDeleteAgent = (id: string) => {
    if (agents.length <= 1) {
      return;
    }

    const nextAgents = agents.filter((agent) => agent.id !== id);
    setAgents(nextAgents);

    if (currentAgentId === id) {
      setCurrentAgentId(nextAgents[0]?.id || DEFAULT_AGENTS[0].id);
    }

    if (editingAgent?.id === id) {
      setEditingAgent(null);
    }
  };

  const handleProviderChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const provider = e.target.value;
    const form = e.target.form;
    if (!form) return;

    const baseUrlInput = form.elements.namedItem("baseUrl") as HTMLInputElement;
    const modelNameInput = form.elements.namedItem("modelName") as HTMLInputElement;

    if (provider === "zhipu") {
      if (!baseUrlInput.value || baseUrlInput.value === "https://api.openai.com/v1")
        baseUrlInput.value = "https://open.bigmodel.cn/api/paas/v4";
      if (!modelNameInput.value || modelNameInput.value.startsWith("gpt-")) modelNameInput.value = "glm-4";
    } else if (provider === "deepseek") {
      if (!baseUrlInput.value || baseUrlInput.value === "https://api.openai.com/v1")
        baseUrlInput.value = "https://api.deepseek.com";
      if (!modelNameInput.value || modelNameInput.value.startsWith("gpt-")) modelNameInput.value = "deepseek-chat";
    } else if (provider === "anthropic") {
      if (!baseUrlInput.value || baseUrlInput.value === "https://api.openai.com/v1") {
        baseUrlInput.value = "https://api.anthropic.com/v1";
      }
      if (!modelNameInput.value || modelNameInput.value.startsWith("gpt-") || modelNameInput.value.startsWith("glm-")) {
        modelNameInput.value = "claude-3-5-sonnet-latest";
      }
    } else if (provider === "openai") {
      if (!baseUrlInput.value || baseUrlInput.value.includes("bigmodel") || baseUrlInput.value.includes("deepseek"))
        baseUrlInput.value = "https://api.openai.com/v1";
      if (
        !modelNameInput.value ||
        modelNameInput.value.startsWith("glm-") ||
        modelNameInput.value.startsWith("deepseek")
      )
        modelNameInput.value = "gpt-4o";
    } else if (provider === "custom") {
      if (!modelNameInput.value) modelNameInput.value = "gpt-4o-mini";
    }
  };

  return {
    agents,
    currentAgentId,
    setCurrentAgentId,
    currentAgent,
    showSettings,
    setShowSettings,
    editingAgent,
    setEditingAgent,
    handleSaveAgent,
    handleDeleteAgent,
    handleProviderChange,
  };
}
