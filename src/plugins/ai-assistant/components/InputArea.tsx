import * as React from "react";
import styles from "../styles.less";
import { parseLocalAttachment } from "../attachments";
import { Attachment } from "../types";
import { AttachmentPreviewModal } from "./AttachmentPreviewModal";
import { getAttachmentDisplayName } from "../attachmentUtils";

interface InputAreaProps {
  inputText: string;
  setInputText: (text: string) => void;
  attachments: Attachment[];
  setAttachments: React.Dispatch<React.SetStateAction<Attachment[]>>;
  onSend: () => void;
  onStopGenerating: () => void;
  onStartBlockSelection: () => void;
  onCancelBlockSelection: () => void;
  isSelectingBlocks: boolean;
  onOpenAttachment: (attachment: Attachment) => void;
  isGenerating: boolean;
  vm: PluginContext["vm"];
}

export const InputArea: React.FC<InputAreaProps> = ({
  inputText,
  setInputText,
  attachments,
  setAttachments,
  onSend,
  onStopGenerating,
  onStartBlockSelection,
  onCancelBlockSelection,
  isSelectingBlocks,
  onOpenAttachment,
  isGenerating,
  vm,
}) => {
  const fileInputRef = React.useRef<HTMLInputElement | null>(null);
  const [previewAttachment, setPreviewAttachment] = React.useState<Attachment | null>(null);
  const [expandedId, setExpandedId] = React.useState<string | null>(null);

  const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || []);
    if (!files.length) return;

    const parsedAttachments = await Promise.all(
      files.map(async (file) => {
        try {
          return await parseLocalAttachment(file);
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : "未知错误";
          return {
            id: `${Date.now()}-${file.name}`,
            name: file.name,
            kind: "text-file" as const,
            mimeType: file.type || "application/octet-stream",
            content: `导入失败：${message}`,
            preview: `导入失败：${message}`,
            meta: {
              source: "local-file",
            },
          };
        }
      }),
    );

    setAttachments((prev) => [...prev, ...parsedAttachments]);
    event.target.value = "";
  };

  return (
    <div className={styles.inputArea}>
      {attachments.length > 0 ? (
        <div className={styles.attachments}>
          {attachments.map((attachment) => (
            <div key={attachment.id} className={styles.attachmentItem}>
              <span>
                {attachment.kind === "workspace-ucf-range"
                  ? "片段"
                  : attachment.kind === "workspace-ucf"
                    ? "积木"
                    : "文件"}
              </span>
              <button
                className={styles.inlineTextButton}
                onClick={() => {
                  if (attachment.kind === "workspace-ucf" || attachment.kind === "workspace-ucf-range") {
                    onOpenAttachment(attachment);
                    return;
                  }
                  setPreviewAttachment(attachment);
                }}
                title={getAttachmentDisplayName(attachment, vm)}
              >
                <span className={styles.attachmentName}>{getAttachmentDisplayName(attachment, vm)}</span>
              </button>
              {(attachment.kind === "workspace-ucf" || attachment.kind === "workspace-ucf-range") &&
              attachment.preview ? (
                <button
                  className={styles.attachmentExpandButton}
                  onClick={() => setExpandedId((prev) => (prev === attachment.id ? null : attachment.id))}
                >
                  {expandedId === attachment.id ? "收起" : "展开"}
                </button>
              ) : null}
              <button onClick={() => setAttachments((prev) => prev.filter((item) => item.id !== attachment.id))}>
                x
              </button>
              {expandedId === attachment.id && attachment.preview ? (
                <pre className={styles.attachmentPreviewBlock}>{attachment.preview}</pre>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
      <div className={styles.inputBox}>
        <button onClick={isSelectingBlocks ? onCancelBlockSelection : onStartBlockSelection} title="选择积木片段">
          {isSelectingBlocks ? "取消选择" : "选择积木"}
        </button>
        <button onClick={() => fileInputRef.current?.click()} title="导入本地附件">
          文件
        </button>
        <textarea
          placeholder="输入消息..."
          value={inputText}
          onChange={(event) => setInputText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              onSend();
            }
          }}
        />
        {isGenerating ? (
          <button onClick={onStopGenerating} className={styles.stopButton}>
            停止
          </button>
        ) : (
          <button onClick={onSend}>发送</button>
        )}
      </div>
      <input
        ref={fileInputRef}
        type="file"
        accept=".txt,.md,.markdown,.json,.js,.ts,.tsx,.jsx,.css,.less,.html,.xml,.yaml,.yml,.csv,.log,.ucf,.docx,.xls,.xlsx,.xlsm,.xlsb,.ods"
        multiple
        className={styles.fileInput}
        onChange={handleFileChange}
      />
      {previewAttachment ? (
        <AttachmentPreviewModal attachment={previewAttachment} onClose={() => setPreviewAttachment(null)} />
      ) : null}
    </div>
  );
};
