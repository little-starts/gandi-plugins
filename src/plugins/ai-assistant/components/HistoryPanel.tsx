import * as React from "react";
import shell from "../ui/Shell.module.less";
import { ChatSession } from "../types";
import { showAssistantConfirm } from "./AssistantDialogHost";

interface HistoryPanelProps {
  sessions: ChatSession[];
  currentSessionId: string;
  currentProjectId: string;
  currentProjectName: string;
  onNewChat: () => void;
  onSelectSession: (id: string) => void;
  onDeleteSession: (id: string, e?: React.MouseEvent | React.KeyboardEvent) => void;
  onRenameSession: (id: string, title: string) => void;
  onDeleteProject: (projectId?: string) => void;
  onDeleteProjects: (projectIds: Array<string | undefined>) => void;
}

interface ProjectSessionGroup {
  key: string;
  projectId?: string;
  displayName: string;
  sessions: ChatSession[];
  updatedAt: number;
}

const UNNAMED_PROJECT_KEY = "__unnamed_project__";
const UNNAMED_PROJECT_NAME = "未命名项目";

const getProjectDisplayName = (session: ChatSession) => {
  const projectName = String(session.projectName || "").trim();
  if (projectName) return projectName;
  const projectId = String(session.projectId || "").trim();
  return projectId || UNNAMED_PROJECT_NAME;
};

const normalizeProjectCompareText = (value: string) => String(value || "").trim().replace(/\s+/g, " ");

const groupSessionsByProject = (sessions: ChatSession[]): ProjectSessionGroup[] => {
  const groups = new Map<string, ProjectSessionGroup>();

  sessions.forEach((session) => {
    const projectId = String(session.projectId || "").trim();
    const key = projectId || UNNAMED_PROJECT_KEY;
    const existing = groups.get(key);
    if (existing) {
      existing.sessions.push(session);
      existing.updatedAt = Math.max(existing.updatedAt, session.updatedAt || 0);
      if (existing.displayName === projectId && session.projectName) {
        existing.displayName = getProjectDisplayName(session);
      }
      return;
    }

    groups.set(key, {
      key,
      projectId: projectId || undefined,
      displayName: getProjectDisplayName(session),
      sessions: [session],
      updatedAt: session.updatedAt || 0,
    });
  });

  return Array.from(groups.values())
    .map((group) => ({
      ...group,
      sessions: group.sessions.slice().sort((left, right) => (right.updatedAt || 0) - (left.updatedAt || 0)),
    }))
    .sort((left, right) => right.updatedAt - left.updatedAt);
};

const formatRelativeTime = (updatedAt?: number) => {
  if (!updatedAt) return "";
  const diffMs = Math.max(0, Date.now() - updatedAt);
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;

  if (diffMs < minute) return "刚刚";
  if (diffMs < hour) return `${Math.max(1, Math.floor(diffMs / minute))} 分`;
  if (diffMs < day) return `${Math.max(1, Math.floor(diffMs / hour))} 时`;
  if (diffMs < 30 * day) return `${Math.max(1, Math.floor(diffMs / day))} 天`;
  return `${Math.max(1, Math.floor(diffMs / (30 * day)))} 月`;
};

const isHistoryRowActionEvent = (event: React.SyntheticEvent) =>
  Boolean((event.target as HTMLElement | null)?.closest?.("[data-history-row-action='true']"));

const stopHistoryRowActionEvent = (event: React.SyntheticEvent) => {
  event.preventDefault();
  event.stopPropagation();
};

export const HistoryPanel: React.FC<HistoryPanelProps> = ({
  sessions,
  currentSessionId,
  currentProjectId,
  currentProjectName,
  onNewChat,
  onSelectSession,
  onDeleteSession,
  onRenameSession,
  onDeleteProject,
  onDeleteProjects,
}) => {
  const [editingSessionId, setEditingSessionId] = React.useState("");
  const [editingTitle, setEditingTitle] = React.useState("");
  const [isProjectListOpen, setIsProjectListOpen] = React.useState(false);
  const [selectedProjectKeys, setSelectedProjectKeys] = React.useState<Set<string>>(() => new Set());
  const [pendingDeleteSessionId, setPendingDeleteSessionId] = React.useState("");
  const groups = React.useMemo(() => groupSessionsByProject(sessions), [sessions]);
  const isCurrentProjectGroup = React.useCallback(
    (group: ProjectSessionGroup) => {
      const groupProjectId = String(group.projectId || "").trim();
      const normalizedCurrentProjectId = String(currentProjectId || "").trim();
      if (groupProjectId && normalizedCurrentProjectId && groupProjectId === normalizedCurrentProjectId) return true;
      if (!groupProjectId) return false;
      const groupName = normalizeProjectCompareText(group.displayName || "");
      const currentName = normalizeProjectCompareText(currentProjectName || "");
      return Boolean(groupName && currentName && groupName === currentName);
    },
    [currentProjectId, currentProjectName],
  );
  const selectedProjectCount = selectedProjectKeys.size;
  const allProjectsSelected = groups.length > 0 && selectedProjectCount === groups.length;

  const finishRename = React.useCallback(() => {
    if (!editingSessionId) return;
    onRenameSession(editingSessionId, editingTitle);
    setEditingSessionId("");
    setEditingTitle("");
  }, [editingSessionId, editingTitle, onRenameSession]);

  const startRename = React.useCallback((session: ChatSession) => {
    setPendingDeleteSessionId("");
    setEditingSessionId(session.id);
    setEditingTitle(session.title || "");
  }, []);

  const requestSessionDelete = React.useCallback(
    (sessionId: string, event: React.MouseEvent | React.KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (pendingDeleteSessionId === sessionId) {
        setPendingDeleteSessionId("");
        onDeleteSession(sessionId, event);
        return;
      }
      setPendingDeleteSessionId(sessionId);
    },
    [onDeleteSession, pendingDeleteSessionId],
  );

  React.useEffect(() => {
    setSelectedProjectKeys((previous) => {
      const availableKeys = new Set(groups.map((group) => group.key));
      let changed = false;
      const next = new Set<string>();
      previous.forEach((key) => {
        if (availableKeys.has(key)) {
          next.add(key);
        } else {
          changed = true;
        }
      });
      return changed ? next : previous;
    });
  }, [groups]);

  const toggleProjectSelection = React.useCallback((projectKey: string) => {
    setSelectedProjectKeys((previous) => {
      const next = new Set(previous);
      if (next.has(projectKey)) {
        next.delete(projectKey);
      } else {
        next.add(projectKey);
      }
      return next;
    });
  }, []);

  const toggleSelectAllProjects = React.useCallback(() => {
    setSelectedProjectKeys((previous) => {
      if (groups.length > 0 && previous.size === groups.length) {
        return new Set();
      }
      return new Set(groups.map((group) => group.key));
    });
  }, [groups]);

  const deleteSelectedProjects = React.useCallback(async () => {
    if (!selectedProjectKeys.size) return;
    const selectedGroups = groups.filter((group) => selectedProjectKeys.has(group.key));
    if (!selectedGroups.length) return;
    const sessionCount = selectedGroups.reduce((sum, group) => sum + group.sessions.length, 0);
    const confirmed = await showAssistantConfirm(
      `删除所选 ${selectedGroups.length} 个项目会删除 ${sessionCount} 条历史记录以及对应项目记忆，确认删除？`,
      { title: "删除项目", confirmText: "确认删除", cancelText: "取消" },
    );
    if (!confirmed) {
      return;
    }
    onDeleteProjects(selectedGroups.map((group) => group.projectId));
    setSelectedProjectKeys(new Set());
  }, [groups, onDeleteProjects, selectedProjectKeys]);

  return (
    <div className={shell.sidebar}>
      <div className={shell.sidebarHeader}>
        <div className={shell.sidebarBrand}>
          <span className={shell.sidebarBrandMark}>AI</span>
          <div>
            <span className={shell.sidebarBrandTitle}>Scratch Agent</span>
            <div className={shell.sidebarBrandSubtitle}>项目会话</div>
          </div>
        </div>
      </div>
      <button onClick={onNewChat} className={shell.sidebarNewChat} title="新对话">
        <span className={shell.navIcon}>+</span>
        <span>新对话</span>
      </button>
      <div className={shell.sidebarSectionLabel}>历史记录</div>
      <div className={shell.historyModeBar}>
        <span className={shell.sidebarSectionLabel}>历史记录</span>
        <button
          type="button"
          className={`${shell.historyModeButton} ${isProjectListOpen ? shell.historyModeButtonActive : ""}`}
          onClick={() => setIsProjectListOpen((previous) => !previous)}
        >
          项目列表
        </button>
      </div>
      {isProjectListOpen ? (
        <div className={shell.projectListPanel}>
          <div className={shell.projectListToolbar}>
            <button type="button" className={shell.projectListGhostButton} onClick={toggleSelectAllProjects}>
              {allProjectsSelected ? "取消全选" : "全选"}
            </button>
            <button
              type="button"
              className={shell.projectListDangerButton}
              onClick={deleteSelectedProjects}
              disabled={!selectedProjectCount}
            >
              删除所选{selectedProjectCount ? ` (${selectedProjectCount})` : ""}
            </button>
          </div>
          <div className={shell.projectList}>
            {groups.length === 0 ? <div className={shell.historyEmpty}>还没有可管理的项目。</div> : null}
            {groups.map((group) => {
              const selected = selectedProjectKeys.has(group.key);
              const isCurrentProject = isCurrentProjectGroup(group);
              return (
                <label
                  key={group.key}
                  className={`${shell.projectListItem} ${selected ? shell.projectListItemSelected : ""} ${
                    isCurrentProject ? shell.projectListItemCurrent : ""
                  }`}
                >
                  <input type="checkbox" checked={selected} onChange={() => toggleProjectSelection(group.key)} />
                  <span className={shell.projectListItemMain}>
                    <strong title={group.displayName}>{group.displayName}</strong>
                    <small>
                      {group.sessions.length} 条会话 · {formatRelativeTime(group.updatedAt) || "未知时间"}
                    </small>
                  </span>
                </label>
              );
            })}
          </div>
        </div>
      ) : null}
      <div className={shell.historyList}>
        {sessions.length === 0 ? <div className={shell.historyEmpty}>还没有会话，开始一个新的提问吧。</div> : null}
        {groups.map((group) => (
          <section
            key={group.key}
            className={`${shell.historyProjectGroup} ${isCurrentProjectGroup(group) ? shell.historyProjectActive : ""}`}
          >
            <div className={shell.historyProjectHeader}>
              <div className={shell.historyProjectTitle} title={group.displayName}>
                <span className={shell.historyFolderIcon}>▱</span>
                <span>{group.displayName}</span>
              </div>
              <button
                type="button"
                className={shell.deleteProjectButton}
                onClick={async (event) => {
                  event.stopPropagation();
                  const confirmed = await showAssistantConfirm("删除项目会删除项目的所有历史记录以及记忆，确认删除？", {
                    title: "删除项目",
                    confirmText: "确认删除",
                    cancelText: "取消",
                  });
                  if (!confirmed) return;
                  onDeleteProject(group.projectId);
                }}
                title="删除项目"
                aria-label={`删除项目 ${group.displayName}`}
              >
                ×
              </button>
            </div>
            <div className={shell.historyProjectSessions}>
              {group.sessions.map((session) => {
                const isEditing = editingSessionId === session.id;
                const isPendingDelete = pendingDeleteSessionId === session.id;
                return (
                  <div
                    key={session.id}
                    className={`${shell.historyItem} ${currentSessionId === session.id ? shell.historyItemActive : ""} ${
                      isPendingDelete ? shell.historyItemDeletePending : ""
                    }`}
                    role="button"
                    tabIndex={0}
                    onClick={(event) => {
                      if (isHistoryRowActionEvent(event)) return;
                      setPendingDeleteSessionId("");
                      if (!isEditing) onSelectSession(session.id);
                    }}
                    onDoubleClick={() => startRename(session)}
                    onKeyDown={(event) => {
                      if (isHistoryRowActionEvent(event)) return;
                      if (event.key === "Enter" && !isEditing) {
                        setPendingDeleteSessionId("");
                        onSelectSession(session.id);
                      }
                    }}
                  >
                    <span className={shell.historyItemMain}>
                      {isEditing ? (
                        <input
                          className={shell.historyTitleInput}
                          value={editingTitle}
                          autoFocus
                          onChange={(event) => setEditingTitle(event.target.value)}
                          onClick={(event) => event.stopPropagation()}
                          onBlur={finishRename}
                          onKeyDown={(event) => {
                            event.stopPropagation();
                            if (event.key === "Enter") finishRename();
                            if (event.key === "Escape") {
                              setEditingSessionId("");
                              setEditingTitle("");
                            }
                          }}
                        />
                      ) : (
                        <span className={shell.historyTitle} title="双击重命名">
                          {session.title}
                        </span>
                      )}
                    </span>
                    <span className={shell.historyMeta}>{formatRelativeTime(session.updatedAt)}</span>
                    <button
                      type="button"
                      className={shell.renameSessionButton}
                      data-history-row-action="true"
                      onPointerDown={stopHistoryRowActionEvent}
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        startRename(session);
                      }}
                      title="重命名"
                      aria-label="重命名会话"
                    >
                      ✎
                    </button>
                    <button
                      type="button"
                      className={`${shell.deleteSessionButton} ${isPendingDelete ? shell.deleteSessionButtonConfirm : ""}`}
                      data-history-row-action="true"
                      onPointerDown={stopHistoryRowActionEvent}
                      onMouseDown={stopHistoryRowActionEvent}
                      onClick={(event) => requestSessionDelete(session.id, event)}
                      onMouseLeave={() => {
                        if (isPendingDelete) {
                          setPendingDeleteSessionId("");
                        }
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          requestSessionDelete(session.id, event);
                        }
                      }}
                      title="删除对话"
                      aria-label={`删除对话 ${session.title || ""}`}
                    >
                      {isPendingDelete ? "确认" : "×"}
                    </button>
                  </div>
                );
              })}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
};
