import { useState, useMemo, useEffect } from "react";
import useStorageInfo from "hooks/useStorageInfo";
import { ChatMessage, ChatSession } from "../types";

const getSessionTitle = (messages: ChatMessage[]) => {
  const firstUserMessage = messages.find((message) => message.role === "user");
  const rawTitle =
    firstUserMessage?.content ||
    firstUserMessage?.attachments?.map((attachment) => attachment.name).join(", ") ||
    "新对话";
  return rawTitle.length > 20 ? `${rawTitle.substring(0, 20)}...` : rawTitle;
};

export function useChatSessions(isNarrow: boolean) {
  const [sessions, setSessions] = useStorageInfo<ChatSession[]>("AI_ASSISTANT_SESSIONS", []);
  const [currentSessionId, setCurrentSessionId] = useStorageInfo<string>("AI_ASSISTANT_CURRENT_SESSION_ID", "");
  const [isLeftPanelOpen, setIsLeftPanelOpen] = useState(true);
  const [showHistoryModal, setShowHistoryModal] = useState(false);

  useEffect(() => {
    if (isNarrow) {
      setIsLeftPanelOpen(false);
    } else {
      setIsLeftPanelOpen(true);
      setShowHistoryModal(false);
    }
  }, [isNarrow]);

  const currentSession = useMemo(() => {
    return sessions.find((s) => s.id === currentSessionId);
  }, [sessions, currentSessionId]);

  const messages = currentSession?.messages || [];

  useEffect(() => {
    if (!currentSessionId) return;
    if (!sessions.some((session) => session.id === currentSessionId)) {
      setCurrentSessionId("");
    }
  }, [currentSessionId, sessions, setCurrentSessionId]);

  const handleNewChat = () => {
    setCurrentSessionId("");
    if (isNarrow) setShowHistoryModal(false);
  };

  const handleSelectSession = (id: string) => {
    setCurrentSessionId(id);
    if (isNarrow) setShowHistoryModal(false);
  };

  const handleDeleteSession = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const newSessions = sessions.filter((s) => s.id !== id);
    setSessions(newSessions);
    if (currentSessionId === id) {
      setCurrentSessionId("");
    }
  };

  const updateSessionMessages = (newMessages: ChatMessage[]) => {
    let sessionId = currentSessionId;
    const newSessions = [...sessions];
    const updatedAt = Date.now();

    if (!sessionId) {
      sessionId = updatedAt.toString();
      setCurrentSessionId(sessionId);
      const title = getSessionTitle(newMessages);

      newSessions.unshift({
        id: sessionId,
        title,
        messages: newMessages,
        updatedAt,
      });
    } else {
      const sessionIndex = newSessions.findIndex((s) => s.id === sessionId);
      if (sessionIndex > -1) {
        newSessions[sessionIndex] = {
          ...newSessions[sessionIndex],
          messages: newMessages,
          updatedAt,
        };
        // Move to top
        const session = newSessions.splice(sessionIndex, 1)[0];
        newSessions.unshift(session);
      } else {
        const title = getSessionTitle(newMessages);
        newSessions.unshift({
          id: sessionId,
          title,
          messages: newMessages,
          updatedAt,
        });
      }
    }
    setSessions(newSessions);
  };

  return {
    sessions,
    currentSessionId,
    currentSession,
    messages,
    isLeftPanelOpen,
    setIsLeftPanelOpen,
    showHistoryModal,
    setShowHistoryModal,
    handleNewChat,
    handleSelectSession,
    handleDeleteSession,
    updateSessionMessages,
  };
}
