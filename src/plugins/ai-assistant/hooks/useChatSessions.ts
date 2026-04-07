import { useState, useMemo, useEffect, useRef, useCallback } from "react";
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
  const currentSessionIdRef = useRef(currentSessionId);

  useEffect(() => {
    currentSessionIdRef.current = currentSessionId;
  }, [currentSessionId]);

  const setActiveSessionId = useCallback(
    (id: string) => {
      currentSessionIdRef.current = id;
      setCurrentSessionId(id);
    },
    [setCurrentSessionId],
  );

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
      setActiveSessionId("");
    }
  }, [currentSessionId, sessions, setActiveSessionId]);

  const handleNewChat = () => {
    setActiveSessionId("");
    if (isNarrow) setShowHistoryModal(false);
  };

  const handleSelectSession = (id: string) => {
    setActiveSessionId(id);
    if (isNarrow) setShowHistoryModal(false);
  };

  const handleDeleteSession = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setSessions((previousSessions) => previousSessions.filter((session) => session.id !== id));
    if (currentSessionId === id) {
      setActiveSessionId("");
    }
  };

  const updateSessionMessages = useCallback(
    (newMessages: ChatMessage[], targetSessionId?: string) => {
      let sessionId = targetSessionId || currentSessionIdRef.current;
      const updatedAt = Date.now();
      const title = getSessionTitle(newMessages);

      if (!sessionId) {
        sessionId = updatedAt.toString();
        setActiveSessionId(sessionId);
      }

      setSessions((previousSessions) => {
        const nextSessions = [...previousSessions];
        const sessionIndex = nextSessions.findIndex((session) => session.id === sessionId);

        if (sessionIndex > -1) {
          nextSessions[sessionIndex] = {
            ...nextSessions[sessionIndex],
            title,
            messages: newMessages,
            updatedAt,
          };

          const session = nextSessions.splice(sessionIndex, 1)[0];
          nextSessions.unshift(session);
          return nextSessions;
        }

        nextSessions.unshift({
          id: sessionId,
          title,
          messages: newMessages,
          updatedAt,
        });

        return nextSessions;
      });

      return sessionId;
    },
    [setActiveSessionId, setSessions],
  );

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
