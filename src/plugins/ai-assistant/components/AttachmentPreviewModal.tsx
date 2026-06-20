import * as React from "react";
import styles from "../styles.less";
import { Attachment } from "../types";

interface AttachmentPreviewModalProps {
  attachment: Attachment;
  onClose: () => void;
}

export const AttachmentPreviewModal: React.FC<AttachmentPreviewModalProps> = ({ attachment, onClose }) => {
  const windowRef = React.useRef<HTMLDivElement | null>(null);
  const dragStateRef = React.useRef<{ pointerId: number; offsetX: number; offsetY: number } | null>(null);
  const [position, setPosition] = React.useState<{ x: number; y: number } | null>(null);

  React.useEffect(() => {
    setPosition(null);
    dragStateRef.current = null;
  }, [attachment.id]);

  const clampPosition = React.useCallback((x: number, y: number) => {
    const rect = windowRef.current?.getBoundingClientRect();
    const width = rect?.width || Math.min(680, window.innerWidth - 48);
    const height = rect?.height || Math.min(window.innerHeight * 0.74, 680);
    const margin = 12;
    return {
      x: Math.max(margin, Math.min(x, window.innerWidth - width - margin)),
      y: Math.max(margin, Math.min(y, window.innerHeight - height - margin)),
    };
  }, []);

  const startDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const rect = windowRef.current?.getBoundingClientRect();
    if (!rect) return;
    dragStateRef.current = {
      pointerId: event.pointerId,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
    };
    setPosition({ x: rect.left, y: rect.top });
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  };

  const handleDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const dragState = dragStateRef.current;
    if (!dragState || dragState.pointerId !== event.pointerId) return;
    setPosition(clampPosition(event.clientX - dragState.offsetX, event.clientY - dragState.offsetY));
  };

  const stopDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const dragState = dragStateRef.current;
    if (!dragState || dragState.pointerId !== event.pointerId) return;
    dragStateRef.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
  };

  return (
    <div
      ref={windowRef}
      className={styles.filePreviewWindow}
      role="dialog"
      aria-modal="false"
      aria-label="附件预览"
      style={position ? { left: position.x, top: position.y, transform: "none" } : undefined}
    >
      <div
        className={styles.filePreviewHeader}
        onPointerDown={startDrag}
        onPointerMove={handleDrag}
        onPointerUp={stopDrag}
        onPointerCancel={stopDrag}
      >
        <div className={styles.filePreviewTitle}>
          <strong>{attachment.name}</strong>
          <span>{attachment.kind === "image" ? "图片" : "文件"}</span>
        </div>
        <button
          type="button"
          className={styles.filePreviewCloseButton}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={onClose}
          aria-label="关闭附件预览"
        >
          ×
        </button>
      </div>
      <div className={styles.filePreviewMeta}>
        <span>{attachment.kind}</span>
        <span>{attachment.mimeType || "unknown"}</span>
      </div>
      <div className={styles.filePreviewBody}>
        {attachment.kind === "image" ? (
          <img className={styles.filePreviewImage} src={attachment.preview || attachment.content} alt={attachment.name} />
        ) : (
          <pre className={styles.filePreviewContent}>{attachment.preview || attachment.content}</pre>
        )}
      </div>
    </div>
  );
};
