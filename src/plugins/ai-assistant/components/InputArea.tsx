import * as React from "react";
import composer from "../ui/Composer.module.less";
import { parseLocalAttachment } from "../attachments";
import { Attachment, ChatMessage, PendingUserQuestion, ReasoningEffort, SubAgentProfile, UserQuestionOption } from "../types";
import type { GuideSummary } from "../guideRegistry";
import { TodoProgressDock } from "./TodoProgressDock";
import { UserQuestionDock } from "./UserQuestionDock";
import {
  findAttachmentReferenceRanges,
  findGuideReferenceRanges,
  findSubAgentMentionRanges,
  getActiveGuideQuery,
  getActiveMentionQuery,
  applyMentionAtomicDelete,
  insertAttachmentReference,
  renderComposerInlineNodes,
  replaceActiveGuideQuery,
  replaceActiveMentionQuery,
} from "../mentionUtils";
import SendIcon from "../assets/icon-send.svg";
import StopIcon from "../assets/icon-stop.svg";
import ChevronRightIcon from "../assets/icon-chevron-right.svg";
import ComposeExpandIcon from "../assets/icon-compose-expand.svg";
import { createPortal } from "react-dom";
import {
  findVirtualBlockLineReferenceRanges,
  resolveVirtualBlockLineReference,
  ResolvedVirtualBlockLineReference,
} from "../blockReferenceUtils";
import { ucfToScratch } from "../ucf";
import { serializeBlocksToPreviewSvg } from "./AssistantMarkdown";
import { scrollBlockIntoView } from "utils/block-helper";
import { BlockReferencePreviewDialog } from "./BlockReferencePreviewDialog";
import { getBlocksRangeBlockStates } from "../workspaceRangeTools";

const REASONING_EFFORT_OPTIONS: Array<{ value: ReasoningEffort; label: string }> = [
  { value: "minimal", label: "极低" },
  { value: "low", label: "低" },
  { value: "medium", label: "中" },
  { value: "high", label: "高" },
  { value: "max", label: "超高" },
];

const getReasoningEffortLabel = (effort: ReasoningEffort) =>
  REASONING_EFFORT_OPTIONS.find((option) => option.value === effort)?.label || "中";

interface InputAreaProps {
  inputText: string;
  setInputText: (text: string) => void;
  subAgents: SubAgentProfile[];
  guides: GuideSummary[];
  messages: ChatMessage[];
  attachments: Attachment[];
  setAttachments: React.Dispatch<React.SetStateAction<Attachment[]>>;
  onSend: () => void;
  onStopGenerating: () => void;
  queuedUserMessages?: Array<{ id: string; content: string; attachments?: Attachment[] }>;
  onStartBlockSelection: () => void;
  onCancelBlockSelection: () => void;
  isSelectingBlocks: boolean;
  enableReasoning: boolean;
  reasoningEffort: ReasoningEffort;
  onToggleReasoning: () => void;
  onSelectReasoningEffort: (effort: ReasoningEffort) => void;
  onOpenAttachment: (attachment: Attachment) => void;
  onPreviewAttachment: (attachment: Attachment) => void;
  onInlineAttachmentAdded?: (handler: (attachment: Attachment) => void) => void;
  isGenerating: boolean;
  pendingUserQuestion: PendingUserQuestion | null;
  onAnswerUserQuestion: (answer: string, selectedOption?: UserQuestionOption | null) => void;
  onGoBackUserQuestion: () => void;
  isExpanded: boolean;
  onToggleExpanded: () => void;
  vm: PluginContext["vm"];
  workspace?: Blockly.WorkspaceSvg;
  blockly?: any;
  variant?: "dock" | "floating";
  autoFocus?: boolean;
  hideInputHint?: boolean;
  conversationMode?: "chat" | "code";
}

export const InputArea: React.FC<InputAreaProps> = ({
  inputText,
  setInputText,
  subAgents,
  guides,
  messages,
  attachments,
  setAttachments,
  onSend,
  onStopGenerating,
  queuedUserMessages = [],
  onStartBlockSelection,
  onCancelBlockSelection,
  isSelectingBlocks,
  enableReasoning,
  reasoningEffort,
  onToggleReasoning,
  onSelectReasoningEffort,
  onOpenAttachment,
  onPreviewAttachment,
  onInlineAttachmentAdded,
  isGenerating,
  pendingUserQuestion,
  onAnswerUserQuestion,
  onGoBackUserQuestion,
  isExpanded,
  onToggleExpanded,
  vm,
  workspace,
  blockly,
  variant = "dock",
  autoFocus = false,
  hideInputHint = false,
  conversationMode = "code",
}) => {
  const fileInputRef = React.useRef<HTMLInputElement | null>(null);
  const textareaRef = React.useRef<HTMLTextAreaElement | null>(null);
  const highlightRef = React.useRef<HTMLDivElement | null>(null);
  const highlightContentRef = React.useRef<HTMLDivElement | null>(null);
  const mentionPanelRef = React.useRef<HTMLDivElement | null>(null);
  const guidePanelRef = React.useRef<HTMLDivElement | null>(null);
  const reasoningControlRef = React.useRef<HTMLDivElement | null>(null);
  const reasoningMenuRef = React.useRef<HTMLDivElement | null>(null);
  const pendingSelectionRef = React.useRef<{ start: number; end: number } | null>(null);
  const deferredTokenSelectionRef = React.useRef<number | null>(null);
  const [textareaMetrics, setTextareaMetrics] = React.useState({ scrollbarWidth: 0, bottomSpacer: 0 });
  const [isReasoningMenuOpen, setIsReasoningMenuOpen] = React.useState(false);
  const [blockPreviewDialog, setBlockPreviewDialog] = React.useState<{
    reference: ResolvedVirtualBlockLineReference;
    svg: string;
  } | null>(null);
  const [reasoningMenuPosition, setReasoningMenuPosition] = React.useState<{
    left: number;
    top: number;
    placement: "above" | "below";
  }>({ left: 0, top: 0, placement: "above" });
  const textareaMetricsRef = React.useRef(textareaMetrics);
  const [selectionRange, setSelectionRange] = React.useState({ start: inputText.length, end: inputText.length });
  const [activeMentionIndex, setActiveMentionIndex] = React.useState(0);
  const [activeGuideIndex, setActiveGuideIndex] = React.useState(0);
  const isFloating = variant === "floating";
  const hasDraftContent = inputText.trim().length > 0 || attachments.length > 0;
  const showSendButton = !isGenerating || hasDraftContent;
  const textareaPlaceholder =
    conversationMode === "chat" ? "输入消息、规划接下来的行动..." : "输入消息、修改需求或粘贴上下文...";

  const mentionRanges = React.useMemo(() => findSubAgentMentionRanges(inputText, subAgents), [inputText, subAgents]);
  const fileReferenceRanges = React.useMemo(() => findAttachmentReferenceRanges(inputText, attachments), [inputText, attachments]);
  const virtualBlockReferenceRanges = React.useMemo(() => findVirtualBlockLineReferenceRanges(inputText), [inputText]);
  const virtualBlockReferenceFileRanges = React.useMemo(
    () =>
      virtualBlockReferenceRanges.map((range) => ({
        start: range.start,
        end: range.end,
        name: range.text,
        attachmentName: range.text,
        nameStart: range.start,
        nameEnd: range.end,
      })),
    [virtualBlockReferenceRanges],
  );
  const guideReferenceRanges = React.useMemo(() => findGuideReferenceRanges(inputText, guides), [inputText, guides]);
  const visibleFileReferenceRanges = React.useMemo(
    () => [...fileReferenceRanges, ...virtualBlockReferenceFileRanges].sort((left, right) => left.start - right.start || left.end - right.end),
    [fileReferenceRanges, virtualBlockReferenceFileRanges],
  );
  const highlightRanges = React.useMemo(
    () =>
      [...mentionRanges, ...visibleFileReferenceRanges, ...guideReferenceRanges].sort(
        (left, right) => left.start - right.start || left.end - right.end,
      ),
    [mentionRanges, visibleFileReferenceRanges, guideReferenceRanges],
  );
  const activeMentionQuery = getActiveMentionQuery(inputText, selectionRange.start, selectionRange.end);
  const activeGuideQuery = getActiveGuideQuery(inputText, selectionRange.start, selectionRange.end);
  const mentionKeyword = String(activeMentionQuery?.query || "").trim().toLowerCase();
  const guideKeyword = String(activeGuideQuery?.query || "").trim().toLowerCase();
  const mentionCandidates = React.useMemo(
    () =>
      activeMentionQuery
        ? subAgents
            .filter((agent) => agent.enabled !== false)
            .filter((agent) => agent.name.toLowerCase().includes(mentionKeyword))
            .slice(0, 6)
        : [],
    [Boolean(activeMentionQuery), mentionKeyword, subAgents],
  );
  const guideCandidates = React.useMemo(
    () =>
      activeGuideQuery
        ? guides
            .filter((guide) => guide.enabled !== false)
            .filter((guide) => `${guide.title} ${guide.name} ${guide.category}`.toLowerCase().includes(guideKeyword))
            .slice(0, 8)
        : [],
    [Boolean(activeGuideQuery), guideKeyword, guides],
  );

  React.useEffect(() => {
    setActiveMentionIndex(0);
  }, [mentionKeyword, mentionCandidates.length]);

  React.useEffect(() => {
    if (!mentionCandidates.length) return;
    setActiveMentionIndex((previous) => Math.min(Math.max(previous, 0), mentionCandidates.length - 1));
  }, [mentionCandidates.length]);

  React.useEffect(() => {
    setActiveGuideIndex(0);
  }, [guideKeyword, guideCandidates.length]);

  React.useEffect(() => {
    if (!guideCandidates.length) return;
    setActiveGuideIndex((previous) => Math.min(Math.max(previous, 0), guideCandidates.length - 1));
  }, [guideCandidates.length]);

  const keepActiveOptionVisible = React.useCallback((panel: HTMLDivElement | null) => {
    if (!panel) return;
    const activeOption = panel.querySelector<HTMLElement>('[role="option"][aria-selected="true"]');
    if (!activeOption) return;

    const optionTop = activeOption.offsetTop;
    const optionBottom = optionTop + activeOption.offsetHeight;
    const visibleTop = panel.scrollTop;
    const visibleBottom = visibleTop + panel.clientHeight;
    const panelPadding = 8;

    if (optionTop < visibleTop + panelPadding) {
      panel.scrollTop = Math.max(0, optionTop - panelPadding);
      return;
    }
    if (optionBottom > visibleBottom - panelPadding) {
      panel.scrollTop = optionBottom - panel.clientHeight + panelPadding;
    }
  }, []);

  React.useLayoutEffect(() => {
    if (!mentionCandidates.length) return;
    keepActiveOptionVisible(mentionPanelRef.current);
  }, [activeMentionIndex, mentionCandidates.length, keepActiveOptionVisible]);

  React.useLayoutEffect(() => {
    if (!guideCandidates.length) return;
    keepActiveOptionVisible(guidePanelRef.current);
  }, [activeGuideIndex, guideCandidates.length, keepActiveOptionVisible]);

  const getTextareaSelectionRange = React.useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return selectionRange;
    return {
      start: textarea.selectionStart ?? selectionRange.start,
      end: textarea.selectionEnd ?? selectionRange.end,
    };
  }, [selectionRange]);

  const syncHighlightScroll = React.useCallback(() => {
    const textarea = textareaRef.current;
    const highlight = highlightRef.current;
    if (!textarea || !highlight) return;
    highlight.scrollTop = textarea.scrollTop;
    highlight.scrollLeft = textarea.scrollLeft;
  }, []);

  const syncTextareaMetrics = React.useCallback(() => {
    const textarea = textareaRef.current;
    const highlightContent = highlightContentRef.current;
    if (!textarea || !highlightContent) return;

    const scrollbarWidth = Math.max(0, textarea.offsetWidth - textarea.clientWidth);
    const highlightBaseScrollHeight = Math.max(0, highlightContent.scrollHeight - textareaMetricsRef.current.bottomSpacer);
    const bottomSpacer = Math.max(0, textarea.scrollHeight - highlightBaseScrollHeight);
    setTextareaMetrics((previous) =>
      previous.scrollbarWidth === scrollbarWidth && previous.bottomSpacer === bottomSpacer
        ? previous
        : { scrollbarWidth, bottomSpacer },
    );
  }, []);

  React.useEffect(() => {
    textareaMetricsRef.current = textareaMetrics;
  }, [textareaMetrics]);

  const syncSelectionFromTextarea = React.useCallback(() => {
    const nextSelection = getTextareaSelectionRange();
    setSelectionRange(nextSelection);
    syncHighlightScroll();
    return nextSelection;
  }, [getTextareaSelectionRange, syncHighlightScroll]);

  const pruneAttachmentsForText = React.useCallback(
    (text: string) => {
      setAttachments((previous) => {
        if (!previous.length) return previous;
        const referencedAttachmentIds = new Set(
          findAttachmentReferenceRanges(text, previous)
            .map((range) => range.attachmentId)
            .filter(Boolean) as string[],
        );
        const next = previous.filter((attachment) => referencedAttachmentIds.has(attachment.id));
        return next.length === previous.length ? previous : next;
      });
    },
    [setAttachments],
  );

  const setTextareaSelection = React.useCallback((start: number, end = start) => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const nextStart = Math.max(0, Math.min(start, textarea.value.length));
    const nextEnd = Math.max(0, Math.min(end, textarea.value.length));
    textarea.focus({ preventScroll: true });
    textarea.setSelectionRange(nextStart, nextEnd);
    setSelectionRange({ start: nextStart, end: nextEnd });
  }, []);

  const clearDeferredTokenSelection = React.useCallback(() => {
    if (deferredTokenSelectionRef.current === null) return;
    window.clearTimeout(deferredTokenSelectionRef.current);
    deferredTokenSelectionRef.current = null;
  }, []);

  const scheduleTokenSelection = React.useCallback(
    (selection: { start: number; end: number }) => {
      clearDeferredTokenSelection();
      if (selection.start !== selection.end) return;

      const range = highlightRanges.find((item) => selection.start > item.start && selection.start < item.end);
      if (!range) return;

      deferredTokenSelectionRef.current = window.setTimeout(() => {
        deferredTokenSelectionRef.current = null;
        const currentSelection = getTextareaSelectionRange();
        if (currentSelection.start !== selection.start || currentSelection.end !== selection.end) return;
        setTextareaSelection(range.start, range.end);
      }, 320);
    },
    [clearDeferredTokenSelection, getTextareaSelectionRange, highlightRanges, setTextareaSelection],
  );

  const updateInputText = React.useCallback(
    (text: string, cursor?: number) => {
      clearDeferredTokenSelection();
      setInputText(text);
      pruneAttachmentsForText(text);
      if (typeof cursor === "number") {
        const nextCursor = Math.max(0, Math.min(cursor, text.length));
        const nextSelection = { start: nextCursor, end: nextCursor };
        pendingSelectionRef.current = nextSelection;
        setSelectionRange(nextSelection);
      }
    },
    [clearDeferredTokenSelection, pruneAttachmentsForText, setInputText],
  );

  React.useEffect(() => clearDeferredTokenSelection, [clearDeferredTokenSelection]);

  const updateReasoningMenuPosition = React.useCallback(() => {
    const anchor = reasoningControlRef.current;
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    const menuWidth = reasoningMenuRef.current?.offsetWidth || 164;
    const menuHeight = reasoningMenuRef.current?.offsetHeight || 190;
    const viewportPadding = 8;
    const opensAbove = rect.top >= menuHeight + viewportPadding + 8;
    setReasoningMenuPosition({
      left: Math.min(Math.max(viewportPadding, rect.left), Math.max(viewportPadding, window.innerWidth - menuWidth - viewportPadding)),
      top: opensAbove ? rect.top - 8 : rect.bottom + 8,
      placement: opensAbove ? "above" : "below",
    });
  }, []);

  React.useLayoutEffect(() => {
    if (!isReasoningMenuOpen) return undefined;
    updateReasoningMenuPosition();
    window.addEventListener("resize", updateReasoningMenuPosition);
    window.addEventListener("scroll", updateReasoningMenuPosition, true);
    return () => {
      window.removeEventListener("resize", updateReasoningMenuPosition);
      window.removeEventListener("scroll", updateReasoningMenuPosition, true);
    };
  }, [isReasoningMenuOpen, updateReasoningMenuPosition]);

  React.useEffect(() => {
    if (!isReasoningMenuOpen) return undefined;
    const handlePointerDown = (event: PointerEvent) => {
      if (reasoningControlRef.current?.contains(event.target as Node)) return;
      if (reasoningMenuRef.current?.contains(event.target as Node)) return;
      setIsReasoningMenuOpen(false);
    };
    document.addEventListener("pointerdown", handlePointerDown, true);
    return () => document.removeEventListener("pointerdown", handlePointerDown, true);
  }, [isReasoningMenuOpen]);

  React.useLayoutEffect(() => {
    const pendingSelection = pendingSelectionRef.current;
    if (!pendingSelection || document.activeElement !== textareaRef.current) return;
    pendingSelectionRef.current = null;
    setTextareaSelection(pendingSelection.start, pendingSelection.end);
    syncTextareaMetrics();
    syncHighlightScroll();
  }, [inputText, setTextareaSelection, syncHighlightScroll, syncTextareaMetrics]);

  React.useLayoutEffect(() => {
    syncTextareaMetrics();
    syncHighlightScroll();
  }, [inputText, isExpanded, syncHighlightScroll, syncTextareaMetrics]);

  React.useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      syncTextareaMetrics();
      syncHighlightScroll();
    });
    observer.observe(textarea);
    return () => observer.disconnect();
  }, [syncHighlightScroll, syncTextareaMetrics]);

  React.useEffect(() => {
    if (!autoFocus) return;
    window.requestAnimationFrame(() => textareaRef.current?.focus());
  }, [autoFocus]);

  const replaceSelectionText = React.useCallback(
    (text: string, selection = getTextareaSelectionRange()) => {
      const nextText = `${inputText.slice(0, selection.start)}${text}${inputText.slice(selection.end)}`;
      updateInputText(nextText, selection.start + text.length);
    },
    [getTextareaSelectionRange, inputText, updateInputText],
  );

  const insertSubAgentMention = (name: string) => {
    if (!activeMentionQuery) return;
    const nextValue = replaceActiveMentionQuery(inputText, activeMentionQuery, name);
    updateInputText(nextValue.text, nextValue.cursor);
  };

  const insertGuideReference = (guide: GuideSummary) => {
    if (!activeGuideQuery) return;
    const nextValue = replaceActiveGuideQuery(inputText, activeGuideQuery, guide);
    updateInputText(nextValue.text, nextValue.cursor);
  };

  const insertAttachmentsAtRange = React.useCallback(
    (parsedAttachments: Attachment[], insertionRange: { start: number; end: number }) => {
      if (!parsedAttachments.length) return;
      setAttachments((previous) => [...previous, ...parsedAttachments]);
      const nextValue = parsedAttachments.reduce(
        (draft, attachment) => {
          const inserted = insertAttachmentReference(draft.text, draft.cursor, draft.cursor, attachment);
          return { text: inserted.text, cursor: inserted.cursor };
        },
        { text: inputText, cursor: insertionRange.start },
      );
      updateInputText(nextValue.text, nextValue.cursor);
    },
    [inputText, setAttachments, updateInputText],
  );

  const insertAttachmentIntoInput = React.useCallback(
    (attachment: Attachment, insertionRange?: { start: number; end: number }) => {
      insertAttachmentsAtRange([attachment], insertionRange || getTextareaSelectionRange());
    },
    [getTextareaSelectionRange, insertAttachmentsAtRange],
  );

  React.useEffect(() => {
    onInlineAttachmentAdded?.(insertAttachmentIntoInput);
  }, [insertAttachmentIntoInput, onInlineAttachmentAdded]);

  const syncSelectionAndScheduleTokenSelection = React.useCallback(() => {
    const selection = syncSelectionFromTextarea();
    scheduleTokenSelection(selection);
    return selection;
  }, [scheduleTokenSelection, syncSelectionFromTextarea]);

  const getFileRangeFromSelection = React.useCallback(
    (selection: { start: number; end: number }) =>
      fileReferenceRanges.find((range) =>
        selection.start === selection.end
          ? selection.start > range.start && selection.start < range.end
          : selection.start < range.end && selection.end > range.start,
      ) || null,
    [fileReferenceRanges],
  );

  const getVirtualBlockRangeFromSelection = React.useCallback(
    (selection: { start: number; end: number }) =>
      virtualBlockReferenceRanges.find((range) =>
        selection.start === selection.end
          ? selection.start > range.start && selection.start < range.end
          : selection.start < range.end && selection.end > range.start,
      ) || null,
    [virtualBlockReferenceRanges],
  );

  const openVirtualBlockPreview = React.useCallback(
    (range: ReturnType<typeof getVirtualBlockRangeFromSelection>) => {
      if (!range) return;
      const resolved = resolveVirtualBlockLineReference(vm, range);
      if (!resolved) return;
      try {
        const parseBlocks = (code: string) =>
          ucfToScratch(code, {
            runtime: vm?.runtime,
            includeComments: true,
            validate: false,
          });
        let blocks: any[];
        const runtimeRange = getBlocksRangeBlockStates(vm, resolved.startBlockId, resolved.endBlockId);
        if (runtimeRange.success && Array.isArray((runtimeRange as any).blocks) && (runtimeRange as any).blocks.length) {
          blocks = (runtimeRange as any).blocks;
        } else {
          try {
            blocks = parseBlocks(resolved.code);
          } catch (error) {
            if (!resolved.fallbackCode) throw error;
            blocks = parseBlocks(resolved.fallbackCode);
          }
        }
        const rendered = serializeBlocksToPreviewSvg(blocks, blockly, vm);
        setBlockPreviewDialog({ reference: resolved, svg: rendered.svg });
      } catch (error) {
        console.warn("[AI Assistant Block Reference Preview] Failed to render block reference", {
          reference: range,
          error,
        });
      }
    },
    [blockly, getVirtualBlockRangeFromSelection, vm],
  );

  const jumpToPreviewBlock = React.useCallback(() => {
    const reference = blockPreviewDialog?.reference;
    if (!reference || !workspace || !vm || !reference.targetId || !reference.startBlockId) return;

    const tryScroll = () => {
      const block =
        (typeof workspace.getBlockById === "function" ? workspace.getBlockById(reference.startBlockId) : null) ||
        (workspace as any).blockDB_?.[reference.startBlockId];
      if (!block) return false;
      scrollBlockIntoView(block, workspace);
      return true;
    };

    if (vm.editingTarget?.id === reference.targetId && tryScroll()) return;
    let attempts = 0;
    const retry = () => {
      attempts += 1;
      if (tryScroll() || attempts > 20) return;
      window.requestAnimationFrame(retry);
    };
    vm.setEditingTarget?.(reference.targetId);
    window.requestAnimationFrame(retry);
  }, [blockPreviewDialog?.reference, vm, workspace]);

  const handleTextareaDoubleClick = (event: React.MouseEvent<HTMLTextAreaElement>) => {
    clearDeferredTokenSelection();
    const selection = syncSelectionFromTextarea();
    const virtualBlockRange = getVirtualBlockRangeFromSelection(selection);
    if (virtualBlockRange) {
      event.preventDefault();
      setTextareaSelection(virtualBlockRange.start, virtualBlockRange.end);
      openVirtualBlockPreview(virtualBlockRange);
      return;
    }

    const fileRange = getFileRangeFromSelection(selection);
    if (fileRange) {
      const attachment =
        attachments.find((item) => item.id === fileRange.attachmentId) ||
        attachments.find((item) => item.name === fileRange.attachmentName || item.name === fileRange.name);

      if (attachment) {
        event.preventDefault();
        setTextareaSelection(fileRange.start, fileRange.end);
        if (attachment.kind === "workspace-ucf" || attachment.kind === "workspace-ucf-range") {
          onOpenAttachment(attachment);
          return;
        }
        onPreviewAttachment(attachment);
        return;
      }
    }

    const touchedRange = highlightRanges.find((range) =>
      selection.start === selection.end
        ? selection.start > range.start && selection.start < range.end
        : selection.start < range.end && selection.end > range.start,
    );
    if (touchedRange) setTextareaSelection(touchedRange.start, touchedRange.end);
  };

  const handleTextareaChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    clearDeferredTokenSelection();
    const nextText = event.currentTarget.value;
    setInputText(nextText);
    pruneAttachmentsForText(nextText);
    setSelectionRange({
      start: event.currentTarget.selectionStart,
      end: event.currentTarget.selectionEnd,
    });
    window.requestAnimationFrame(() => {
      syncTextareaMetrics();
      syncHighlightScroll();
    });
  };

  const handleTextareaKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    clearDeferredTokenSelection();

    if (mentionCandidates.length > 0 && !(event.nativeEvent as KeyboardEvent).isComposing) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActiveMentionIndex((previous) => (previous + 1) % mentionCandidates.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setActiveMentionIndex((previous) => (previous - 1 + mentionCandidates.length) % mentionCandidates.length);
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        const selectedAgent = mentionCandidates[Math.min(activeMentionIndex, mentionCandidates.length - 1)];
        if (selectedAgent) {
          insertSubAgentMention(selectedAgent.name);
        }
        return;
      }
    }

    if (guideCandidates.length > 0 && !(event.nativeEvent as KeyboardEvent).isComposing) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActiveGuideIndex((previous) => (previous + 1) % guideCandidates.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setActiveGuideIndex((previous) => (previous - 1 + guideCandidates.length) % guideCandidates.length);
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        const selectedGuide = guideCandidates[Math.min(activeGuideIndex, guideCandidates.length - 1)];
        if (selectedGuide) {
          insertGuideReference(selectedGuide);
        }
        return;
      }
    }

    if (event.key === "Backspace" || event.key === "Delete") {
      const selection = getTextareaSelectionRange();
      const nextValue = applyMentionAtomicDelete(inputText, highlightRanges, selection.start, selection.end, event.key);
      if (nextValue) {
        event.preventDefault();
        updateInputText(nextValue.text, nextValue.cursor);
        return;
      }
    }

    if (isExpanded) {
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        onSend();
      }
      return;
    }

    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      onSend();
    }
  };

  const parseDroppedFiles = async (files: File[]) =>
    Promise.all(
      files.map(async (file) => {
        try {
          return await parseLocalAttachment(file);
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : "解析失败";
          return {
            id: `${Date.now()}-${file.name}`,
            name: file.name,
            kind: "text-file" as const,
            mimeType: file.type || "application/octet-stream",
            content: `解析文件失败：${message}`,
            preview: `解析文件失败：${message}`,
            meta: {
              source: "local-file",
            },
          };
        }
      }),
    );

  const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files || []);
    if (!files.length) return;

    const parsedAttachments = await parseDroppedFiles(files);
    insertAttachmentsAtRange(parsedAttachments, getTextareaSelectionRange());
    event.target.value = "";
  };

  const handleTextareaDragOver = (event: React.DragEvent<HTMLElement>) => {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  };

  const handleTextareaDrop = async (event: React.DragEvent<HTMLElement>) => {
    const files = Array.from(event.dataTransfer.files || []);
    if (!files.length) return;

    event.preventDefault();
    event.stopPropagation();
    const insertionRange = getTextareaSelectionRange();
    const parsedAttachments = await parseDroppedFiles(files);
    insertAttachmentsAtRange(parsedAttachments, insertionRange);
  };

  const handlePaste = async (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.clipboardData?.files || []).filter((file) => file.type.startsWith("image/"));
    if (!files.length) return;

    event.preventDefault();
    const insertionRange = getTextareaSelectionRange();
    const parsedAttachments = await Promise.all(
      files.map(async (file, index) => {
        const imageFile = file.name
          ? file
          : new File([file], `pasted-image-${Date.now()}-${index + 1}.png`, { type: file.type || "image/png" });
        try {
          return await parseLocalAttachment(imageFile);
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : "解析失败";
          return {
            id: `${Date.now()}-${index}`,
            name: imageFile.name,
            kind: "text-file" as const,
            mimeType: imageFile.type || "application/octet-stream",
            content: `解析文件失败：${message}`,
            preview: `解析文件失败：${message}`,
            meta: {
              source: "clipboard-image",
            },
          };
        }
      }),
    );

    insertAttachmentsAtRange(parsedAttachments, insertionRange);
  };

  const reasoningMenuPortalHost =
    isReasoningMenuOpen && typeof document !== "undefined"
      ? ((reasoningControlRef.current?.closest('[data-ai-assistant-ui-root="true"]') as HTMLElement | null) || document.body)
      : null;

  return (
    <>
      <div
        className={`${composer.inputArea} ${isExpanded ? composer.inputAreaExpanded : ""} ${
          isFloating ? composer.inputAreaFloating : ""
        }`}
      >
      {!isFloating ? <TodoProgressDock messages={messages} isGenerating={isGenerating} /> : null}
      {queuedUserMessages.length > 0 ? (
        <div className={composer.queuedMessageDock} title={queuedUserMessages.map((item) => item.content).join("\n") || "等待发送"}>
          <span className={composer.queuedMessageBadge}>等待发送</span>
          <span className={composer.queuedMessageText}>
            {queuedUserMessages
              .map((item) => item.content.trim() || (item.attachments?.length ? `附件 ${item.attachments.length} 个` : "空消息"))
              .join(" / ")}
          </span>
        </div>
      ) : null}
      {!isFloating ? (
        <UserQuestionDock
          question={pendingUserQuestion}
          onAnswer={onAnswerUserQuestion}
          onGoBack={onGoBackUserQuestion}
        />
      ) : null}
      <div
        className={`${composer.conversationModeDock} ${isGenerating ? composer.conversationModeDockHidden : ""}`}
        data-no-window-drag="true"
      >
        <button
          type="button"
          className={composer.conversationModeSwitch}
          data-mode={conversationMode}
          role="switch"
          aria-checked={conversationMode === "code"}
          aria-label={`当前模式：${conversationMode === "code" ? "Code" : "Chat"}`}
          title={conversationMode === "code" ? "Code 模式：编写代码、修改脚本和处理工作区内容" : "Chat 模式：阅读项目、讨论想法和规划方案，不直接修改项目"}
        >
          <span className={`${composer.conversationModeLabel} ${composer.conversationModeLabelChat}`}>Chat</span>
          <span className={`${composer.conversationModeLabel} ${composer.conversationModeLabelCode}`}>Code</span>
          <span className={composer.conversationModeThumb} aria-hidden="true">
            <span className={`${composer.conversationModeIcon} ${composer.conversationModeIconChat}`}>
              <svg viewBox="0 0 20 20" focusable="false">
                <path d="M4.2 5.2h11.6c.8 0 1.5.7 1.5 1.5v6.2c0 .8-.7 1.5-1.5 1.5H9.1l-3.2 2.2c-.5.3-1.1 0-1.1-.6v-1.6h-.6c-.8 0-1.5-.7-1.5-1.5V6.7c0-.8.7-1.5 1.5-1.5Z" />
                <path d="M6.2 8.5h7.6M6.2 11.2h4.9" />
              </svg>
            </span>
            <span className={`${composer.conversationModeIcon} ${composer.conversationModeIconCode}`}>
              <svg viewBox="0 0 20 20" focusable="false">
                <path d="m7.4 6.4-3.2 3.5 3.2 3.6M12.6 6.4l3.2 3.5-3.2 3.6" />
                <path d="m11 5.4-2 9.2" />
              </svg>
            </span>
          </span>
        </button>
      </div>
      <div className={composer.inputBox}>
        <div
          className={composer.composerTextareaWrap}
          onDragOver={handleTextareaDragOver}
          onDrop={handleTextareaDrop}
        >
          <div
            ref={highlightRef}
            className={`${composer.composerTextarea} ${composer.composerHighlightLayer} ${
              isExpanded ? composer.composerTextareaExpanded : ""
            }`}
            style={
              {
                "--ai-composer-scrollbar-width": `${textareaMetrics.scrollbarWidth}px`,
                "--ai-composer-bottom-spacer": `${textareaMetrics.bottomSpacer}px`,
              } as React.CSSProperties
            }
            aria-hidden="true"
          >
            <div className={composer.composerHighlightContent} ref={highlightContentRef}>
              {inputText
                ? renderComposerInlineNodes(
                    inputText.endsWith("\n") ? `${inputText} ` : inputText,
                    mentionRanges,
                    visibleFileReferenceRanges,
                    composer.agentMentionToken,
                    composer.fileReferenceToken,
                    undefined,
                    undefined,
                    guideReferenceRanges,
                    composer.guideReferenceToken,
                  )
                : null}
            </div>
          </div>
          <textarea
            ref={textareaRef}
            className={`${composer.composerTextarea} ${composer.composerPlainTextarea} ${
              isExpanded ? composer.composerTextareaExpanded : ""
            }`}
            value={inputText}
            placeholder={textareaPlaceholder}
            aria-label="输入消息"
            onChange={handleTextareaChange}
            onPaste={handlePaste}
            onKeyDown={handleTextareaKeyDown}
            onSelect={syncSelectionAndScheduleTokenSelection}
            onClick={syncSelectionAndScheduleTokenSelection}
            onDoubleClick={handleTextareaDoubleClick}
            onKeyUp={syncSelectionAndScheduleTokenSelection}
            onScroll={syncHighlightScroll}
            onDragOver={handleTextareaDragOver}
            onDrop={handleTextareaDrop}
          />
          {mentionCandidates.length > 0 ? (
            <div ref={mentionPanelRef} className={composer.agentMentionPanel} role="listbox" aria-label="选择子智能体">
              {mentionCandidates.map((agent, index) => (
                <button
                  key={agent.id}
                  type="button"
                  role="option"
                  aria-selected={index === activeMentionIndex}
                  className={`${composer.agentMentionItem} ${
                    index === activeMentionIndex ? composer.agentMentionItemActive : ""
                  }`}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => setActiveMentionIndex(index)}
                  onClick={() => insertSubAgentMention(agent.name)}
                >
                  <strong>{agent.name}</strong>
                  <span>{agent.description || "子智能体"}</span>
                </button>
              ))}
            </div>
          ) : null}
          {guideCandidates.length > 0 ? (
            <div
              ref={guidePanelRef}
              className={`${composer.agentMentionPanel} ${composer.guideMentionPanel}`}
              role="listbox"
              aria-label="选择指南"
            >
              {guideCandidates.map((guide, index) => (
                <button
                  key={guide.id}
                  type="button"
                  role="option"
                  aria-selected={index === activeGuideIndex}
                  className={`${composer.agentMentionItem} ${composer.guideMentionItem} ${
                    index === activeGuideIndex ? composer.agentMentionItemActive : ""
                  }`}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseEnter={() => setActiveGuideIndex(index)}
                  onClick={() => insertGuideReference(guide)}
                >
                  <strong>{guide.title}</strong>
                  <span>{guide.source === "user" ? "用户指南" : guide.source === "extension" ? "扩展指南" : "内置指南"} · {guide.category}</span>
                </button>
              ))}
            </div>
          ) : null}
          {!isFloating ? (
            <button
              type="button"
              className={composer.composerExpandButton}
              onClick={onToggleExpanded}
              title={isExpanded ? "退出全屏输入" : "展开输入框"}
              aria-label={isExpanded ? "退出全屏输入" : "展开输入框"}
            >
              <ComposeExpandIcon aria-hidden="true" />
            </button>
          ) : null}
        </div>
        <div className={composer.inputBottomRow}>
          <div className={composer.inputToolsScroller}>
            <div className={composer.inputTools}>
              <div
                className={`${composer.reasoningControl} ${enableReasoning ? composer.reasoningControlActive : ""}`}
                ref={reasoningControlRef}
              >
                <button
                  type="button"
                  className={`${composer.toolButton} ${composer.reasoningMainButton}`}
                  onClick={onToggleReasoning}
                  title="开启或关闭思考"
                >
                  思考
                </button>
                <button
                  type="button"
                  className={`${composer.toolButton} ${composer.reasoningMenuButton}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    setIsReasoningMenuOpen((previous) => !previous);
                  }}
                  title="选择思考程度"
                  aria-haspopup="menu"
                  aria-expanded={isReasoningMenuOpen}
                >
                  <span>{getReasoningEffortLabel(reasoningEffort)}</span>
                  <ChevronRightIcon aria-hidden="true" />
                </button>
              </div>
              <button
                type="button"
                className={composer.toolButton}
                onClick={isSelectingBlocks ? onCancelBlockSelection : onStartBlockSelection}
                title="选择积木片段"
              >
                {isSelectingBlocks ? "取消框选" : "选择积木"}
              </button>
              <button
                type="button"
                className={composer.toolButton}
                onClick={() => fileInputRef.current?.click()}
                title="导入本地附件"
              >
                添加文件
              </button>
            </div>
          </div>
          <div className={composer.inputComposerActions}>
            {!hideInputHint ? (
              <div className={composer.inputHint}>
                <span>{isExpanded ? "Ctrl+Enter 发送，Enter 换行" : "Enter 发送，Shift + Enter 换行"}</span>
                <span className={composer.inputHintChevron}>
                  <ChevronRightIcon />
                </span>
              </div>
            ) : null}
            {!showSendButton ? (
              <button
                type="button"
                onClick={onStopGenerating}
                className={`${composer.primaryButton} ${isExpanded ? composer.expandedComposerSendButton : composer.iconButton} ${composer.stopButton}`}
                title="停止生成"
                aria-label="停止生成"
              >
                <StopIcon />
              </button>
            ) : (
              <button
                type="button"
                onClick={onSend}
                className={`${composer.primaryButton} ${isExpanded ? composer.expandedComposerSendButton : composer.iconButton}`}
                title="发送"
                aria-label="发送"
              >
                <SendIcon />
              </button>
            )}
          </div>
        </div>
      </div>
      <input
        ref={fileInputRef}
        type="file"
        accept=".txt,.md,.markdown,.json,.js,.ts,.tsx,.jsx,.css,.less,.html,.xml,.yaml,.yml,.csv,.log,.ucf,.docx,.xls,.xlsx,.xlsm,.xlsb,.ods,image/*"
        multiple
        className={composer.fileInput}
        onChange={handleFileChange}
      />
      </div>
      {reasoningMenuPortalHost
        ? createPortal(
            <div
              ref={reasoningMenuRef}
              className={composer.reasoningMenu}
              role="menu"
              style={
                {
                  left: reasoningMenuPosition.left,
                  top: reasoningMenuPosition.top,
                  "--ai-reasoning-menu-transform":
                    reasoningMenuPosition.placement === "above" ? "translateY(-100%)" : "translateY(0)",
                } as React.CSSProperties
              }
            >
              <div className={composer.reasoningMenuTitle}>推理</div>
              {REASONING_EFFORT_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  role="menuitemradio"
                  aria-checked={reasoningEffort === option.value}
                  className={`${composer.reasoningMenuItem} ${
                    reasoningEffort === option.value ? composer.reasoningMenuItemActive : ""
                  }`}
                  onClick={() => {
                    onSelectReasoningEffort(option.value);
                    setIsReasoningMenuOpen(false);
                  }}
                >
                  <span>{option.label}</span>
                  {reasoningEffort === option.value ? <span className={composer.reasoningMenuCheck}>✓</span> : null}
                </button>
              ))}
            </div>,
            reasoningMenuPortalHost,
          )
        : null}
      {blockPreviewDialog && typeof document !== "undefined" && document.body
        ? createPortal(
            <BlockReferencePreviewDialog
              title={blockPreviewDialog.reference.path}
              svg={blockPreviewDialog.svg}
              onClose={() => setBlockPreviewDialog(null)}
              onJump={jumpToPreviewBlock}
            />,
            document.body,
          )
        : null}
    </>
  );
};
