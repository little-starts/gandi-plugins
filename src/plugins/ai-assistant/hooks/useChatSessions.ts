import { useState, useMemo, useEffect, useRef, useCallback, type MouseEvent } from "react";
import { Attachment, ChatMessage, ChatSession, SessionSnapshot } from "../types";
import { useStoredState } from "./useStoredState";
import { loadPersistedChatSessions, savePersistedChatSessions } from "../sessionStorage";
import { deleteProjectMemories } from "../memoryStore";

const SESSION_SAVE_DEBOUNCE_MS = 500;
const EMPTY_MESSAGES: ChatMessage[] = [];

const normalizeProjectCompareText = (value: string) => String(value || "").trim().replace(/\s+/g, " ");

const getSessionTitle = (messages: ChatMessage[]) => {
  const firstUserMessage = messages.find(
    (message) => !message.hidden && !message.excludeFromModel && !message.kind && message.role === "user",
  );
  const rawTitle =
    firstUserMessage?.content ||
    firstUserMessage?.attachments?.map((attachment) => attachment.name).join(", ") ||
    "新对话";
  return rawTitle.length > 20 ? `${rawTitle.substring(0, 20)}...` : rawTitle;
};

export function useChatSessions(shouldAutoCollapseHistory: boolean, currentProjectId = "", currentProjectName = "") {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [currentSessionId, setCurrentSessionId] = useStoredState<string>("AI_ASSISTANT_CURRENT_SESSION_ID", "");
  const [isLeftPanelOpen, setIsLeftPanelOpen] = useState(true);
  const currentSessionIdRef = useRef(currentSessionId);
  const currentProjectIdRef = useRef(currentProjectId);
  const currentProjectNameRef = useRef(currentProjectName);
  const sessionsLoadedRef = useRef(false);
  const snapshotsRef = useRef<Record<string, SessionSnapshot[]>>({});
  const autoResolvedProjectKeyRef = useRef<string | null>(null);
  const crossProjectSessionIdRef = useRef<string | null>(null);
  const unassignedSessionIdRef = useRef<string | null>(null);

  const isSessionInCurrentProject = useCallback(
    (session: ChatSession | undefined) => {
      if (!session) return false;
      const projectId = currentProjectIdRef.current.trim();
      const projectName = normalizeProjectCompareText(currentProjectNameRef.current);
      const sessionProjectId = String(session.projectId || "").trim();
      if (projectId && sessionProjectId === projectId) return true;
      if (projectId && sessionProjectId) {
        const sessionProjectName = normalizeProjectCompareText(session.projectName || "");
        return Boolean(projectName && sessionProjectName && sessionProjectName === projectName);
      }
      return !projectId && !sessionProjectId;
    },
    [],
  );

  useEffect(() => {
    let cancelled = false;
    loadPersistedChatSessions()
      .then((persistedSessions) => {
        if (cancelled) return;
        sessionsLoadedRef.current = true;
        setSessions(persistedSessions);
      })
      .catch((error) => {
        console.warn("[AI Assistant] Failed to load chat sessions from IndexedDB.", error);
        sessionsLoadedRef.current = true;
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!sessionsLoadedRef.current) return;
    const timeout = window.setTimeout(() => {
      savePersistedChatSessions(sessions).catch((error) => {
        console.warn("[AI Assistant] Failed to save chat sessions to IndexedDB.", error);
      });
    }, SESSION_SAVE_DEBOUNCE_MS);
    return () => window.clearTimeout(timeout);
  }, [sessions]);

  useEffect(() => {
    currentSessionIdRef.current = currentSessionId;
  }, [currentSessionId]);

  useEffect(() => {
    currentProjectIdRef.current = currentProjectId;
  }, [currentProjectId]);

  useEffect(() => {
    currentProjectNameRef.current = currentProjectName;
  }, [currentProjectName]);

  useEffect(() => {
    const projectId = currentProjectId.trim();
    const projectName = currentProjectName.trim();
    if (!projectId || !projectName) return;
    setSessions((previousSessions) => {
      let changed = false;
      const nextSessions = previousSessions.map((session) => {
        if (session.projectId !== projectId || session.projectName === projectName) return session;
        changed = true;
        return {
          ...session,
          projectName,
        };
      });
      return changed ? nextSessions : previousSessions;
    });
  }, [currentProjectId, currentProjectName]);

  const setActiveSessionId = useCallback(
    (id: string) => {
      currentSessionIdRef.current = id;
      setCurrentSessionId(id);
    },
    [setCurrentSessionId],
  );

  useEffect(() => {
    if (shouldAutoCollapseHistory) {
      setIsLeftPanelOpen((previous) => (previous ? false : previous));
    }
  }, [shouldAutoCollapseHistory]);

  const currentSession = useMemo(() => {
    return sessions.find((s) => s.id === currentSessionId);
  }, [sessions, currentSessionId]);

  const messages = currentSession?.messages || EMPTY_MESSAGES;

  useEffect(() => {
    if (!sessionsLoadedRef.current) return;
    const projectKey = currentProjectId.trim() || "__unassigned__";
    const hasResolvedCurrentProject = autoResolvedProjectKeyRef.current === projectKey;
    const activeSession = sessions.find((session) => session.id === currentSessionId);
    if (activeSession && crossProjectSessionIdRef.current === activeSession.id) {
      return;
    }
    if (
      activeSession &&
      unassignedSessionIdRef.current === activeSession.id &&
      !String(activeSession.projectId || "").trim()
    ) {
      return;
    }
    if (activeSession && isSessionInCurrentProject(activeSession)) {
      crossProjectSessionIdRef.current = null;
      unassignedSessionIdRef.current = null;
      autoResolvedProjectKeyRef.current = projectKey;
      return;
    }

    if (!currentSessionId && hasResolvedCurrentProject) {
      return;
    }

    const latestProjectSession = sessions.find((session) => isSessionInCurrentProject(session));
    const nextSessionId = latestProjectSession?.id || "";
    autoResolvedProjectKeyRef.current = projectKey;
    if (nextSessionId !== currentSessionId) {
      setActiveSessionId(nextSessionId);
    }
  }, [currentProjectId, currentSessionId, isSessionInCurrentProject, sessions, setActiveSessionId]);

  const handleNewChat = () => {
    crossProjectSessionIdRef.current = null;
    unassignedSessionIdRef.current = null;
    setActiveSessionId("");
    if (shouldAutoCollapseHistory) setIsLeftPanelOpen(false);
  };

  const handleSelectSession = (id: string, options?: { allowCrossProject?: boolean; allowUnassigned?: boolean }) => {
    crossProjectSessionIdRef.current = options?.allowCrossProject ? id : null;
    unassignedSessionIdRef.current = options?.allowUnassigned ? id : null;
    setActiveSessionId(id);
    if (shouldAutoCollapseHistory) setIsLeftPanelOpen(false);
  };

  const handleDeleteSession = (id: string, e?: { stopPropagation?: () => void; preventDefault?: () => void }) => {
    e?.preventDefault?.();
    e?.stopPropagation?.();
    setSessions((previousSessions) => previousSessions.filter((session) => session.id !== id));
    delete snapshotsRef.current[id];
    if (currentSessionId === id) {
      setActiveSessionId("");
    }
  };

  const handleRenameSession = useCallback((id: string, title: string) => {
    const nextTitle = title.trim();
    if (!nextTitle) return;
    setSessions((previousSessions) =>
      previousSessions.map((session) =>
        session.id === id
          ? {
              ...session,
              title: nextTitle,
              updatedAt: Date.now(),
            }
          : session,
      ),
    );
  }, []);

  const handleDeleteProjects = useCallback(
    (projectIds: Array<string | undefined>) => {
      const normalizedProjectIds = new Set(projectIds.map((projectId) => String(projectId || "").trim()));
      if (!normalizedProjectIds.size) return;

      setSessions((previousSessions) => {
        const removedSessionIds = new Set(
          previousSessions
            .filter((session) => normalizedProjectIds.has(String(session.projectId || "").trim()))
            .map((session) => session.id),
        );
        if (!removedSessionIds.size) return previousSessions;

        removedSessionIds.forEach((sessionId) => {
          delete snapshotsRef.current[sessionId];
        });
        if (removedSessionIds.has(currentSessionIdRef.current)) {
          setActiveSessionId("");
        }
        return previousSessions.filter((session) => !removedSessionIds.has(session.id));
      });
      normalizedProjectIds.forEach((projectId) => {
        if (projectId) deleteProjectMemories(projectId);
      });
    },
    [setActiveSessionId],
  );

  const handleDeleteProject = useCallback(
    (projectId?: string) => {
      handleDeleteProjects([projectId]);
    },
    [handleDeleteProjects],
  );

  const updateSessionMessages = useCallback(
    (newMessages: ChatMessage[], targetSessionId?: string) => {
      let sessionId = targetSessionId || currentSessionIdRef.current;
      const updatedAt = Date.now();
      const title = getSessionTitle(newMessages);
      const projectId = currentProjectIdRef.current.trim();
      const projectName = currentProjectNameRef.current.trim();

      if (!sessionId) {
        sessionId = updatedAt.toString();
        setActiveSessionId(sessionId);
      }

      setSessions((previousSessions) => {
        const nextSessions = [...previousSessions];
        const sessionIndex = nextSessions.findIndex((session) => session.id === sessionId);
        const nextTitle = title === "新对话" && sessionIndex > -1 ? nextSessions[sessionIndex].title : title;

        if (sessionIndex > -1) {
          const existingSession = nextSessions[sessionIndex];
          nextSessions[sessionIndex] = {
            ...existingSession,
            title: nextTitle,
            messages: newMessages,
            updatedAt,
            projectId: existingSession.projectId || projectId || undefined,
            projectName:
              (existingSession.projectId || projectId) === projectId && projectName
                ? projectName
                : existingSession.projectName || undefined,
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
          projectId: projectId || undefined,
          projectName: projectId && projectName ? projectName : undefined,
        });

        return nextSessions;
      });

      return sessionId;
    },
    [setActiveSessionId, setSessions],
  );

  const createChatSession = useCallback(
    (newMessages: ChatMessage[], title?: string) => {
      const updatedAt = Date.now();
      const sessionId = `${updatedAt}-${Math.random().toString(36).slice(2, 8)}`;
      const projectId = currentProjectIdRef.current.trim();
      const projectName = currentProjectNameRef.current.trim();
      setActiveSessionId(sessionId);
      setSessions((previousSessions) => [
        {
          id: sessionId,
          title: title || getSessionTitle(newMessages),
          messages: newMessages,
          updatedAt,
          projectId: projectId || undefined,
          projectName: projectId && projectName ? projectName : undefined,
        },
        ...previousSessions,
      ]);
      return sessionId;
    },
    [setActiveSessionId],
  );

  const appendSessionSnapshot = useCallback((snapshot: SessionSnapshot, targetSessionId?: string) => {
    const sessionId = targetSessionId || currentSessionIdRef.current;
    if (!sessionId) return;

    const existingSnapshots = snapshotsRef.current[sessionId] || [];
    snapshotsRef.current[sessionId] = [
      ...existingSnapshots.filter((item) => item.messageId !== snapshot.messageId),
      snapshot,
    ];
  }, []);

  const hasSnapshot = useCallback((messageId: string) => {
    const sessionId = currentSessionIdRef.current;
    if (!sessionId) return false;
    return Boolean((snapshotsRef.current[sessionId] || []).some((item) => item.messageId === messageId));
  }, []);

  const rollbackToMessage = useCallback(
    (messageId: string, nextInputText: string, nextAttachments: Attachment[]) => {
      const session = sessions.find((item) => item.id === currentSessionIdRef.current);
      const sessionId = currentSessionIdRef.current;
      if (!session) {
        return null;
      }

      const messageIndex = session.messages.findIndex((message) => message.id === messageId);
      if (messageIndex === -1) {
        return null;
      }

      const snapshot = [...(snapshotsRef.current[sessionId] || [])]
        .reverse()
        .find((item) => item.messageId === messageId);
      return {
        snapshot,
        inputText: nextInputText,
        attachments: nextAttachments,
      };
    },
    [sessions],
  );

  const commitRollbackToMessage = useCallback(
    (messageId: string) => {
      const session = sessions.find((item) => item.id === currentSessionIdRef.current);
      const sessionId = currentSessionIdRef.current;
      if (!session) return false;

      const messageIndex = session.messages.findIndex((message) => message.id === messageId);
      if (messageIndex === -1) return false;

      const keptMessages = session.messages.slice(0, messageIndex);
      const updatedAt = Date.now();

      setSessions((previousSessions) =>
        previousSessions.map((item) =>
          item.id === session.id
            ? {
                ...item,
                title: getSessionTitle(keptMessages),
                messages: keptMessages,
                updatedAt,
              }
            : item,
        ),
      );

      if (sessionId) {
        snapshotsRef.current[sessionId] = (snapshotsRef.current[sessionId] || []).filter((entry) =>
          keptMessages.some((message) => message.id === entry.messageId),
        );
      }

      return true;
    },
    [sessions],
  );

  return {
    sessions,
    currentSessionId,
    currentSession,
    messages,
    isLeftPanelOpen,
    setIsLeftPanelOpen,
    handleNewChat,
    handleSelectSession,
    handleDeleteSession,
    handleRenameSession,
    handleDeleteProject,
    handleDeleteProjects,
    updateSessionMessages,
    createChatSession,
    appendSessionSnapshot,
    hasSnapshot,
    rollbackToMessage,
    commitRollbackToMessage,
  };
}
