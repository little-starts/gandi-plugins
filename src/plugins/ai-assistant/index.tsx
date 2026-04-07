import * as React from "react";
import ReactDOM from "react-dom";
import styles from "./styles.less";
import Tooltip from "components/Tooltip";
import ExpansionBox, { ExpansionRect } from "components/ExpansionBox";
import useStorageInfo from "hooks/useStorageInfo";
import { registerContextMenu } from "./contextMenu";
import { AIAssistantIcon } from "./components/AIAssistantIcon";
import { HistoryPanel } from "./components/HistoryPanel";
import { SettingsModal } from "./components/SettingsModal";
import { ChatArea } from "./components/ChatArea";
import { InputArea } from "./components/InputArea";
import { AttachmentInteractionLayer } from "./components/AttachmentInteractionLayer";
import { SelectionHint } from "./components/SelectionHint";
import { useAgents } from "./hooks/useAgents";
import { useAttachmentInteraction } from "./hooks/useAttachmentInteraction";
import { useBlockRangeSelection } from "./hooks/useBlockRangeSelection";
import { useChatSessions } from "./hooks/useChatSessions";
import { useChat } from "./hooks/useChat";
import { Attachment } from "./types";
import { getAttachmentDisplayName } from "./attachmentUtils";

const DEFAULT_CONTAINER_INFO = {
  width: 800,
  height: 600,
  translateX: 100,
  translateY: 50,
};

const AIAssistant: React.FC<PluginContext> = ({ vm, workspace }) => {
  const [visible, setVisible] = React.useState(false);
  const [isAgentMenuOpen, setIsAgentMenuOpen] = React.useState(false);
  const containerRef = React.useRef(null);
  const agentMenuRef = React.useRef<HTMLDivElement | null>(null);

  const [containerInfo, setContainerInfo] = useStorageInfo<ExpansionRect>(
    "AI_ASSISTANT_CONTAINER_INFO",
    DEFAULT_CONTAINER_INFO,
  );

  const containerInfoRef = React.useRef(containerInfo);
  const isNarrow = containerInfo.width < 600;

  // Use custom hooks for complex logic
  const {
    agents,
    setCurrentAgentId,
    currentAgent,
    showSettings,
    setShowSettings,
    editingAgent,
    setEditingAgent,
    handleSaveAgent,
    handleDeleteAgent,
    handleProviderChange,
  } = useAgents();

  const {
    sessions,
    currentSessionId,
    messages,
    isLeftPanelOpen,
    setIsLeftPanelOpen,
    showHistoryModal,
    setShowHistoryModal,
    handleNewChat,
    handleSelectSession,
    handleDeleteSession,
    updateSessionMessages,
  } = useChatSessions(isNarrow);

  const { inputText, setInputText, isGenerating, attachments, setAttachments, handleSend, handleStopGenerating } =
    useChat({
      messages,
      currentAgent,
      updateSessionMessages,
      vm,
    });

  const { previewAttachment, setPreviewAttachment, handleOpenAttachment } = useAttachmentInteraction(vm, workspace);
  const { isSelecting, startSelecting, cancelSelecting } = useBlockRangeSelection({
    workspace,
    vm,
    onRangeSelected: (attachment) => setAttachments((prev) => [...prev, attachment]),
    onSelectionError: (message) => window.alert(message),
  });

  const getContainerPosition = React.useCallback(() => {
    const windowWidth = window.innerWidth;
    const windowHeight = window.innerHeight;
    const x = (windowWidth - containerInfoRef.current.width) / 2;
    const y = (windowHeight - containerInfoRef.current.height) / 2;
    return {
      translateX: x,
      translateY: y,
    };
  }, []);

  const handleShow = React.useCallback(() => {
    setContainerInfo({
      ...containerInfoRef.current,
      ...getContainerPosition(),
    });
    setVisible(true);
  }, [getContainerPosition, setContainerInfo]);

  const handleClose = () => {
    setVisible(false);
  };

  const handleSizeChange = React.useCallback((value: ExpansionRect) => {
    containerInfoRef.current = value;
  }, []);

  const pluginsWrapper = document.querySelector(".plugins-wrapper");

  React.useEffect(() => {
    if (!isAgentMenuOpen) return;

    const handlePointerDown = (event: MouseEvent) => {
      if (agentMenuRef.current?.contains(event.target as Node)) return;
      setIsAgentMenuOpen(false);
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsAgentMenuOpen(false);
      }
    };

    window.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("keydown", handleEscape);

    return () => {
      window.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("keydown", handleEscape);
    };
  }, [isAgentMenuOpen]);

  React.useEffect(() => {
    const contextMenuRegistration = registerContextMenu(vm);

    const handleAddContext = (e: Event) => {
      const customEvent = e as CustomEvent<{
        content: string;
        targetId?: string;
        blockId?: string;
        name?: string;
      }>;
      if (customEvent.detail?.content) {
        const attachment: Attachment = {
          id: `${Date.now()}-${customEvent.detail.blockId || "workspace"}`,
          name: customEvent.detail.name || "workspace-ucf",
          kind: "workspace-ucf",
          mimeType: "text/plain",
          content: customEvent.detail.content,
          preview: customEvent.detail.content,
          meta: {
            source: "workspace",
            targetId: customEvent.detail.targetId,
            blockId: customEvent.detail.blockId,
          },
        };
        attachment.name = getAttachmentDisplayName(attachment, vm);
        console.log("[AI Assistant Jump][index] attachment added to chat", attachment);
        setAttachments((prev) => [...prev, attachment]);
        handleShow();
      }
    };

    window.addEventListener("ai-assistant-add-context", handleAddContext);

    return () => {
      contextMenuRegistration.dispose();
      window.removeEventListener("ai-assistant-add-context", handleAddContext);
    };
  }, [vm, handleShow, setAttachments]);

  if (!pluginsWrapper) return null;

  return ReactDOM.createPortal(
    <section className={styles.aiAssistantRoot} ref={containerRef}>
      <Tooltip className={styles.icon} icon={<AIAssistantIcon />} onClick={handleShow} tipText={"AI Assistant"} />
      {visible &&
        ReactDOM.createPortal(
          <ExpansionBox
            id="ai-assistant"
            title={"AI Assistant"}
            containerInfo={containerInfo}
            onClose={handleClose}
            onSizeChange={handleSizeChange}
            minWidth={400}
            minHeight={300}
            borderRadius={8}
          >
            <div className={styles.container}>
              {/* Left Panel */}
              {!isNarrow && isLeftPanelOpen && (
                <HistoryPanel
                  sessions={sessions}
                  currentSessionId={currentSessionId}
                  onNewChat={handleNewChat}
                  onSelectSession={handleSelectSession}
                  onDeleteSession={handleDeleteSession}
                />
              )}

              {/* Right Panel */}
              <div className={styles.rightPanel}>
                <div className={styles.header}>
                  <div className={styles.headerMain}>
                    <div className={styles.headerLeft}>
                      {!isNarrow && (
                        <button
                          type="button"
                          className={styles.togglePanelBtn}
                          onClick={() => setIsLeftPanelOpen(!isLeftPanelOpen)}
                          title={isLeftPanelOpen ? "折叠侧边栏" : "展开侧边栏"}
                        >
                          {isLeftPanelOpen ? "收起" : "展开"}
                        </button>
                      )}
                      {isNarrow && (
                        <button
                          type="button"
                          className={styles.togglePanelBtn}
                          onClick={() => setShowHistoryModal(true)}
                          title="查看历史对话"
                        >
                          历史
                        </button>
                      )}

                      <div className={styles.headerTitleGroup}>
                        <div className={styles.headerTitleRow}>
                          <h3 className={styles.headerTitle}>AI Assistant</h3>
                          <span className={styles.headerMeta}>{sessions.length} 个会话</span>
                        </div>
                      </div>
                    </div>
                  </div>
                  <div className={styles.headerActions}>
                    <div className={styles.agentSelector} ref={agentMenuRef}>
                      <button
                        type="button"
                        className={`${styles.agentSelectorTrigger} ${isAgentMenuOpen ? styles.agentSelectorTriggerActive : ""}`}
                        onClick={() => setIsAgentMenuOpen((open) => !open)}
                        aria-haspopup="listbox"
                        aria-expanded={isAgentMenuOpen}
                        title={currentAgent?.displayName || "选择模型"}
                      >
                        <span className={styles.agentSelectorText}>
                          <span className={styles.agentSelectorPrimary}>
                            {currentAgent?.displayName || "未选择模型"}
                          </span>
                        </span>
                        <span className={styles.agentSelectorChevron}>{isAgentMenuOpen ? "▴" : "▾"}</span>
                      </button>
                      {isAgentMenuOpen ? (
                        <div className={styles.agentMenu} role="listbox" aria-label="选择模型">
                          {agents.map((agent) => (
                            <button
                              key={agent.id}
                              type="button"
                              className={`${styles.agentMenuItem} ${agent.id === currentAgent?.id ? styles.agentMenuItemActive : ""}`}
                              onClick={() => {
                                setCurrentAgentId(agent.id);
                                setIsAgentMenuOpen(false);
                              }}
                              role="option"
                              aria-selected={agent.id === currentAgent?.id}
                              title={`${agent.displayName} (${agent.modelName})`}
                            >
                              <span className={styles.agentMenuPrimary}>{agent.displayName}</span>
                            </button>
                          ))}
                        </div>
                      ) : null}
                    </div>
                    <button type="button" className={styles.secondaryButton} onClick={() => setShowSettings(true)}>
                      设置
                    </button>
                  </div>
                </div>

                <ChatArea
                  messages={messages}
                  isGenerating={isGenerating}
                  vm={vm}
                  onOpenWorkspaceAttachment={handleOpenAttachment}
                />

                <SelectionHint visible={isSelecting} />

                <InputArea
                  inputText={inputText}
                  setInputText={setInputText}
                  attachments={attachments}
                  setAttachments={setAttachments}
                  onSend={handleSend}
                  onStopGenerating={handleStopGenerating}
                  onStartBlockSelection={startSelecting}
                  onCancelBlockSelection={cancelSelecting}
                  isSelectingBlocks={isSelecting}
                  onOpenAttachment={handleOpenAttachment}
                  isGenerating={isGenerating}
                  vm={vm}
                />

                {/* Settings Modal */}
                {showSettings && (
                  <SettingsModal
                    agents={agents}
                    editingAgent={editingAgent}
                    onSaveAgent={handleSaveAgent}
                    onDeleteAgent={handleDeleteAgent}
                    onEditAgent={setEditingAgent}
                    onClose={() => {
                      setShowSettings(false);
                      setEditingAgent(null);
                    }}
                    onProviderChange={handleProviderChange}
                  />
                )}

                <AttachmentInteractionLayer
                  previewAttachment={previewAttachment}
                  onClosePreview={() => setPreviewAttachment(null)}
                />

                {/* History Modal for Narrow Screen */}
                {showHistoryModal && isNarrow && (
                  <div className={styles.settingsModalOverlay} onClick={() => setShowHistoryModal(false)}>
                    <div className={styles.settingsModal} onClick={(e) => e.stopPropagation()}>
                      <div className={styles.modalHeader}>
                        <div>
                          <h3>历史对话</h3>
                          <p>继续之前的上下文，或快速开始一个新会话。</p>
                        </div>
                        <button onClick={handleNewChat} className={styles.newChatBtn} title="新对话">
                          +
                        </button>
                      </div>
                      <div className={styles.modalHistoryList}>
                        {sessions.length === 0 && <div className={styles.emptyTip}>暂无历史对话</div>}
                        {sessions.map((s) => (
                          <div
                            key={s.id}
                            className={`${styles.historyItem} ${currentSessionId === s.id ? styles.active : ""}`}
                            onClick={() => handleSelectSession(s.id)}
                          >
                            <span className={styles.historyTitle}>{s.title}</span>
                            <button
                              className={styles.deleteSessionBtn}
                              onClick={(e) => handleDeleteSession(s.id, e)}
                              title="删除对话"
                            >
                              ×
                            </button>
                          </div>
                        ))}
                      </div>
                      <button className={styles.closeBtn} onClick={() => setShowHistoryModal(false)}>
                        关闭
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </ExpansionBox>,
          document.body,
        )}
    </section>,
    pluginsWrapper,
  );
};

AIAssistant.displayName = "AIAssistant";

export default AIAssistant;
