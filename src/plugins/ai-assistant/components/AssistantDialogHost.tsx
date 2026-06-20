import * as React from "react";
import ReactDOM from "react-dom";
import styles from "../styles.less";

type AssistantDialogKind = "alert" | "confirm";

interface AssistantDialogRequest {
  id: number;
  kind: AssistantDialogKind;
  title?: string;
  message: React.ReactNode;
  detail?: React.ReactNode;
  confirmText?: string;
  cancelText?: string;
  resolve: (value: boolean) => void;
}

interface AssistantDialogOptions {
  title?: string;
  detail?: React.ReactNode;
  confirmText?: string;
  cancelText?: string;
}

let nextDialogId = 1;
let dialogQueue: AssistantDialogRequest[] = [];
const listeners = new Set<(dialogs: AssistantDialogRequest[]) => void>();

const notifyDialogListeners = () => {
  const snapshot = [...dialogQueue];
  listeners.forEach((listener) => listener(snapshot));
};

const enqueueAssistantDialog = (
  kind: AssistantDialogKind,
  message: React.ReactNode,
  options: AssistantDialogOptions = {},
) =>
  new Promise<boolean>((resolve) => {
    dialogQueue = [
      ...dialogQueue,
      {
        id: nextDialogId,
        kind,
        message,
        resolve,
        ...options,
      },
    ];
    nextDialogId += 1;
    notifyDialogListeners();
  });

export const showAssistantAlert = async (message: React.ReactNode, options: AssistantDialogOptions = {}) => {
  await enqueueAssistantDialog("alert", message, {
    title: options.title || "提示",
    confirmText: options.confirmText || "知道了",
    ...options,
  });
};

export const showAssistantConfirm = (
  message: React.ReactNode,
  options: AssistantDialogOptions = {},
) =>
  enqueueAssistantDialog("confirm", message, {
    title: options.title || "确认",
    confirmText: options.confirmText || "确定",
    cancelText: options.cancelText || "取消",
    ...options,
  });

export const AssistantDialogHost: React.FC = () => {
  const [dialogs, setDialogs] = React.useState<AssistantDialogRequest[]>(() => [...dialogQueue]);
  const activeDialog = dialogs[0];

  React.useEffect(() => {
    const listener = (nextDialogs: AssistantDialogRequest[]) => setDialogs(nextDialogs);
    listeners.add(listener);
    listener(dialogQueue);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  const closeDialog = React.useCallback((result: boolean) => {
    const dialog = dialogQueue[0];
    if (!dialog) return;
    dialog.resolve(result);
    dialogQueue = dialogQueue.slice(1);
    notifyDialogListeners();
  }, []);

  if (!activeDialog || typeof document === "undefined" || !document.body) return null;

  const isConfirm = activeDialog.kind === "confirm";
  return ReactDOM.createPortal(
    <div className={styles.assistantGlobalConfirmOverlay} data-no-window-drag="true">
      <div className={styles.assistantGlobalConfirmDialog} role="dialog" aria-modal="true">
        <div className={styles.assistantGlobalConfirmMessage}>{activeDialog.title || (isConfirm ? "确认" : "提示")}</div>
        <div className={styles.assistantGlobalConfirmUrl}>{activeDialog.message}</div>
        {activeDialog.detail ? <div className={styles.assistantGlobalConfirmUrl}>{activeDialog.detail}</div> : null}
        <div className={styles.assistantGlobalConfirmActions}>
          {isConfirm ? (
            <button
              type="button"
              className={styles.assistantGlobalConfirmSecondary}
              onClick={() => closeDialog(false)}
            >
              {activeDialog.cancelText || "取消"}
            </button>
          ) : null}
          <button
            type="button"
            className={styles.assistantGlobalConfirmPrimary}
            onClick={() => closeDialog(true)}
          >
            {activeDialog.confirmText || (isConfirm ? "确定" : "知道了")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
};
