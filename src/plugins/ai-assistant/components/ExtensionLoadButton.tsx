import * as React from "react";
import ReactDOM from "react-dom";
import chat from "../ui/Chat.module.less";
import {
  clearPreviewFallbackBlocksForExtensions,
  formatLoadExtensionsConfirmMessage,
  getApprovedExtensionEntry,
  getApprovedExtensionDisplayName,
  loadApprovedExtensions,
  notifyApprovedExtensionsLoaded,
} from "../extensionLoadUtils";

interface ExtensionLoadButtonProps {
  extensionIds: string[];
  vm?: PluginContext["vm"];
  blockly?: any;
  className?: string;
  onLoaded?: () => void;
}

export const ExtensionLoadButton: React.FC<ExtensionLoadButtonProps> = ({
  extensionIds,
  vm,
  blockly,
  className,
  onLoaded,
}) => {
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState("");
  const uniqueIds = React.useMemo(() => Array.from(new Set(extensionIds.filter(Boolean))), [extensionIds]);
  const extensionDetails = React.useMemo(
    () =>
      uniqueIds.map((extensionId) => {
        const entry = getApprovedExtensionEntry(extensionId);
        return {
          id: extensionId,
          name: entry?.name || getApprovedExtensionDisplayName(extensionId),
          description: entry?.description || "暂无扩展描述",
        };
      }),
    [uniqueIds],
  );

  if (!uniqueIds.length) return null;

  const handleConfirm = async () => {
    setLoading(true);
    setError("");
    try {
      clearPreviewFallbackBlocksForExtensions(uniqueIds, blockly);
      const result = await loadApprovedExtensions(vm, uniqueIds);
      if (!result.success) {
        setError(result.results.find((item) => !item.success)?.error || "扩展加载失败。");
        return;
      }
      setConfirmOpen(false);
      notifyApprovedExtensionsLoaded(uniqueIds);
      onLoaded?.();
    } catch (loadError: any) {
      setError(loadError?.message || String(loadError));
    } finally {
      setLoading(false);
    }
  };

  const modal =
    confirmOpen && typeof document !== "undefined" && document.body
      ? ReactDOM.createPortal(
          <div className={chat.extensionLoadConfirmOverlay} data-no-window-drag="true">
            <div className={chat.extensionLoadConfirmDialog} role="dialog" aria-modal="true">
              <div className={chat.extensionLoadConfirmTitle}>加载扩展</div>
              <div className={chat.extensionLoadConfirmMessage}>
                {formatLoadExtensionsConfirmMessage(uniqueIds)}
              </div>
              <div className={chat.extensionLoadConfirmList}>
                {extensionDetails.map((extension) => (
                  <div key={extension.id} className={chat.extensionLoadConfirmListItem}>
                    <strong>{extension.name}</strong>
                    <span>：{extension.description}</span>
                  </div>
                ))}
              </div>
              {error ? <div className={chat.extensionLoadConfirmError}>{error}</div> : null}
              <div className={chat.extensionLoadConfirmActions}>
                <button
                  type="button"
                  className={chat.extensionLoadConfirmSecondary}
                  onClick={() => {
                    if (loading) return;
                    setConfirmOpen(false);
                    setError("");
                  }}
                >
                  取消
                </button>
                <button
                  type="button"
                  className={chat.extensionLoadConfirmPrimary}
                  onClick={() => void handleConfirm()}
                  disabled={loading}
                >
                  {loading ? "加载中..." : "确认加载"}
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )
      : null;

  return (
    <>
      <button
        type="button"
        className={className || chat.markdownCodeButton}
        onClick={() => {
          setError("");
          setConfirmOpen(true);
        }}
      >
        加载扩展
      </button>
      {modal}
    </>
  );
};
