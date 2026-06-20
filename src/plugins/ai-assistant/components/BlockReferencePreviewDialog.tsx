import * as React from "react";
import styles from "../styles.less";

interface BlockReferencePreviewDialogProps {
  title?: string;
  svg: string;
  onClose: () => void;
  onJump?: () => void;
}

export const BlockReferencePreviewDialog: React.FC<BlockReferencePreviewDialogProps> = ({
  title = "积木预览",
  svg,
  onClose,
  onJump,
}) => {
  const dialogRef = React.useRef<HTMLDivElement | null>(null);
  const dragStateRef = React.useRef<{ pointerId: number; offsetX: number; offsetY: number } | null>(null);
  const [position, setPosition] = React.useState<{ x: number; y: number } | null>(null);

  React.useEffect(() => {
    setPosition(null);
    dragStateRef.current = null;
  }, [title]);

  const clampPosition = React.useCallback((x: number, y: number) => {
    const rect = dialogRef.current?.getBoundingClientRect();
    const width = rect?.width || Math.min(760, window.innerWidth - 36);
    const height = rect?.height || Math.min(680, window.innerHeight - 36);
    const margin = 12;
    return {
      x: Math.max(margin, Math.min(x, window.innerWidth - width - margin)),
      y: Math.max(margin, Math.min(y, window.innerHeight - height - margin)),
    };
  }, []);

  const startDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const rect = dialogRef.current?.getBoundingClientRect();
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
      ref={dialogRef}
      className={`${styles.filePreviewWindow} ${styles.blockReferencePreviewWindow}`}
      data-no-window-drag="true"
      role="dialog"
      aria-modal="false"
      aria-label={title}
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
          <strong>{title}</strong>
          <span>积木预览</span>
        </div>
        <div className={styles.blockReferencePreviewActions} onPointerDown={(event) => event.stopPropagation()}>
          {onJump ? (
            <button type="button" className={styles.blockReferencePreviewJumpButton} onClick={onJump}>
              跳转
            </button>
          ) : null}
          <button type="button" className={styles.filePreviewCloseButton} onClick={onClose} aria-label="关闭积木预览">
            ×
          </button>
        </div>
      </div>
      <div className={styles.filePreviewBody}>
        <div className={styles.blockReferencePreviewContent}>
          <div className={styles.blockReferencePreviewSvg} dangerouslySetInnerHTML={{ __html: svg }} />
        </div>
      </div>
    </div>
  );
};
