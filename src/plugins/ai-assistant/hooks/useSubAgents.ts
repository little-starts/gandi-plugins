import { useMemo, useState } from "react";
import { SubAgentProfile } from "../types";
import {
  DEFAULT_SUBAGENT_IDS,
  DEFAULT_SUBAGENTS,
  normalizeSubAgentProfile,
  SUBAGENT_STORAGE_KEY,
} from "../subAgentConfig";
import { useStoredState } from "./useStoredState";

const createEmptySubAgent = (): SubAgentProfile => ({
  id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
  name: "Custom Agent",
  description: "",
  prompt: "",
  avatarBackground: "#64748b",
  avatarIcon: "robot",
  builtinToolGroups: ["read"],
  enabledGuideCategories: ["read"],
  enabledUserGuideIds: [],
  enableExtensionGuides: false,
  enabled: true,
  createdAt: Date.now(),
  updatedAt: Date.now(),
});

export const useSubAgents = () => {
  const [storedSubAgents, setStoredSubAgents] = useStoredState<SubAgentProfile[]>(SUBAGENT_STORAGE_KEY, []);
  const [editingSubAgent, setEditingSubAgent] = useState<SubAgentProfile | null>(null);

  const subAgents = useMemo(() => {
    const storedById = new Map(storedSubAgents.map((agent) => [agent.id, agent]));
    const defaultAgents = DEFAULT_SUBAGENTS.map((agent) =>
      normalizeSubAgentProfile({
        ...agent,
        ...(storedById.get(agent.id) || {}),
        id: agent.id,
        name: agent.name,
        isDefault: true,
        createdAt: agent.createdAt,
      }),
    );
    const customAgents = storedSubAgents
      .filter((agent) => !DEFAULT_SUBAGENT_IDS.has(agent.id))
      .map((agent) => normalizeSubAgentProfile(agent));
    return [...defaultAgents, ...customAgents];
  }, [storedSubAgents]);

  const handleSaveSubAgent = (profile: SubAgentProfile) => {
    const normalized = normalizeSubAgentProfile({
      ...profile,
      createdAt: profile.createdAt || Date.now(),
      updatedAt: Date.now(),
    });

    setStoredSubAgents((previous) => {
      const filtered = previous.filter((item) => item.id !== normalized.id);
      const existingIndex = filtered.findIndex((item) => item.id === normalized.id);
      const stored = DEFAULT_SUBAGENT_IDS.has(normalized.id)
        ? normalized
        : { ...normalized, isDefault: false };
      if (existingIndex < 0) {
        return [...filtered, stored];
      }
      return filtered.map((item, index) =>
        index === existingIndex ? { ...stored, createdAt: item.createdAt } : item,
      );
    });
    setEditingSubAgent(null);
  };

  const handleDeleteSubAgent = (id: string) => {
    if (DEFAULT_SUBAGENT_IDS.has(id)) {
      return;
    }
    setStoredSubAgents((previous) => previous.filter((agent) => agent.id !== id));
    if (editingSubAgent?.id === id) {
      setEditingSubAgent(null);
    }
  };

  return {
    subAgents,
    editingSubAgent,
    setEditingSubAgent,
    handleSaveSubAgent,
    handleDeleteSubAgent,
    createEmptySubAgent,
  };
};
