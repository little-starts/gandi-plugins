import * as React from "react";
import styles from "../styles.less";
import { ChatSession } from "../types";

interface HistoryPanelProps {
  sessions: ChatSession[];
  currentSessionId: string;
  onNewChat: () => void;
  onSelectSession: (id: string) => void;
  onDeleteSession: (id: string, e: React.MouseEvent) => void;
}

export const HistoryPanel: React.FC<HistoryPanelProps> = ({
  sessions,
  currentSessionId,
  onNewChat,
  onSelectSession,
  onDeleteSession,
}) => {
  return (
    <div className={styles.leftPanel}>
      <div className={styles.historyHeader}>
        <span>聊天记录</span>
        <button onClick={onNewChat} className={styles.newChatBtn} title="新对话">
          +
        </button>
      </div>
      <div className={styles.historyList}>
        {sessions.map((s) => (
          <div
            key={s.id}
            className={`${styles.historyItem} ${currentSessionId === s.id ? styles.active : ""}`}
            onClick={() => onSelectSession(s.id)}
          >
            <span className={styles.historyTitle}>{s.title}</span>
            <button className={styles.deleteSessionBtn} onClick={(e) => onDeleteSession(s.id, e)} title="删除对话">
              ×
            </button>
          </div>
        ))}
      </div>
    </div>
  );
};
