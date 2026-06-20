import * as React from "react";
import ReactDOM from "react-dom";
import styles from "./styles.less";
import themeStyles from "./ui/Theme.module.less";
import shell from "./ui/Shell.module.less";
import Tooltip from "components/Tooltip";
import { useStoredState } from "./hooks/useStoredState";
import { registerContextMenu } from "./contextMenu";
import { AIAssistantIcon } from "./components/AIAssistantIcon";
import { HistoryPanel } from "./components/HistoryPanel";
import { SettingsModal } from "./components/SettingsModal";
import { ChatArea } from "./components/ChatArea";
import { AssistantMarkdown } from "./components/AssistantMarkdown";
import { InputArea } from "./components/InputArea";
import { getLatestTodoSnapshot } from "./components/TodoProgressDock";
import { UserQuestionDock } from "./components/UserQuestionDock";
import { AttachmentInteractionLayer } from "./components/AttachmentInteractionLayer";
import { SelectionHint } from "./components/SelectionHint";
import { AssistantDialogHost, showAssistantAlert } from "./components/AssistantDialogHost";
import { useAgents } from "./hooks/useAgents";
import { useGuides } from "./hooks/useGuides";
import { useSubAgents } from "./hooks/useSubAgents";
import { getAllGuides, getRuntimeExtensionGuideSignature, getRuntimeExtensionGuides } from "./guideRegistry";
import { useAttachmentInteraction } from "./hooks/useAttachmentInteraction";
import { useBlockRangeSelection } from "./hooks/useBlockRangeSelection";
import { useChatSessions } from "./hooks/useChatSessions";
import { useChat } from "./hooks/useChat";
import {
  Attachment,
  ChatMessage,
  ChatSession,
  DefaultCostumeType,
  AiGuideVerificationMode,
  ReasoningEffort,
  StageScreenshotMode,
} from "./types";
import { getAttachmentDisplayName } from "./attachmentUtils";
import { callGetBlockInfo, setRuntime } from "./converter";
import { exportConversationText } from "./conversationExport";
import {
  getRuntimeBlockCount,
  LARGE_PROJECT_ROLLBACK_BLOCK_THRESHOLD,
  restoreProjectSnapshot,
} from "./projectSnapshot";
import { getProjectIdentity } from "./memoryStore";
import { DEFAULT_CHAT_EXAMPLE_PROMPTS, DEFAULT_CODE_EXAMPLE_PROMPTS, pickExamplePrompts } from "./examplePrompts";
import userQuestionSoundUrl from "./assets/userQuestionSound";
import streamErrorSoundUrl from "./assets/streamErrorSound";
import ChevronRightIcon from "./assets/icon-chevron-right.svg";
import { ConverterDebugger } from "./components/ConverterDebugger";

interface AssistantWindowRect {
  width: number;
  height: number;
  translateX: number;
  translateY: number;
}

interface FloatingPosition {
  translateX: number;
  translateY: number;
}

interface AssistantMorphTarget {
  targetX: number;
  targetY: number;
  targetWidth: number;
  targetHeight: number;
}

type ConversationMode = "chat" | "code";

const DEFAULT_CONTAINER_INFO = {
  width: 800,
  height: 600,
  translateX: 100,
  translateY: 50,
};

const MIN_WINDOW_WIDTH = 240;
const MIN_WINDOW_HEIGHT = 360;
const COMPACT_WINDOW_CONTENT_WIDTH = 620;
const COMPACT_WINDOW_CONTENT_HEIGHT = 460;
const MIN_COMPACT_WINDOW_SCALE = 0.58;

const shouldShowConverterDebugger = () => {
  try {
    const params = new URLSearchParams(window.location.search);
    return params.get("aiDebug") === "1" || window.localStorage.getItem("ai-assistant-debugger") === "1";
  } catch {
    return false;
  }
};
const WINDOW_MARGIN = 12;
const FLOATING_PANEL_HEIGHT_ESTIMATE = 320;
const FLOATING_BUTTON_SIZE_ESTIMATE = 56;
const FLOATING_BUTTON_HEIGHT = 52;
const WINDOW_TRANSITION_MS = 360;
const FLOATING_REPLY_COLLAPSE_MS = 240;
const FLOATING_REPLY_STICKY_BOTTOM_DISTANCE = 8;
const soundObjectUrlCache = new Map<string, string>();

type ThemeMode = "gandi" | "system" | "dark" | "light";
type ResolvedThemeMode = "dark" | "light";
type FloatingPlacement = "above" | "below";
type FloatingPanelAlignment = "left" | "center" | "right";
type AssistantTransition = "idle" | "minimizing" | "restoring";
type ResizeDirection = "n" | "e" | "s" | "w" | "ne" | "nw" | "se" | "sw";
const THEME_STORAGE_KEY = "AI_ASSISTANT_THEME_MODE";
const STAGE_SCREENSHOT_MODE_STORAGE_KEY_PREFIX = "AI_ASSISTANT_STAGE_SCREENSHOT_MODE:";
const PROJECT_TITLE_SELECTOR = ".gandi_project-title-input_title-text_So7ot";

const normalizeColorValue = (value: string) => value.trim().replace(/\s+/g, "").toLowerCase();

const resolveGandiThemeMode = (): ResolvedThemeMode => {
  const rootTextColor = normalizeColorValue(
    window.getComputedStyle(document.documentElement).getPropertyValue("--theme-text-primary"),
  );
  return rootTextColor === "#262b33" || rootTextColor === "rgb(38,43,51)" ? "light" : "dark";
};

const resolveThemeMode = (themeMode: ThemeMode): ResolvedThemeMode => {
  if (themeMode === "dark" || themeMode === "light") return themeMode;
  if (themeMode === "system") {
    return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
  }
  return resolveGandiThemeMode();
};

const isThemeMode = (value: string | null): value is ThemeMode =>
  value === "gandi" || value === "system" || value === "dark" || value === "light";

const isStageScreenshotMode = (value: string | null): value is StageScreenshotMode =>
  value === "fast" || value === "full";

const getSoundSource = (soundDataUrl: string) => {
  const cached = soundObjectUrlCache.get(soundDataUrl);
  if (cached) return cached;
  const dataUrl = soundDataUrl.trim();
  const match = dataUrl.match(/^data:([^;,]+)?(;base64)?,([\s\S]*)$/);
  if (!match) return dataUrl;

  const mimeType = match[1] || "audio/mpeg";
  const isBase64 = Boolean(match[2]);
  const payload = match[3].replace(/\s/g, "");
  const binary = isBase64 ? window.atob(payload) : window.decodeURIComponent(payload);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  const objectUrl = window.URL.createObjectURL(new Blob([bytes], { type: mimeType }));
  soundObjectUrlCache.set(soundDataUrl, objectUrl);
  return objectUrl;
};

const getLatestStreamErrorSoundKey = (messages: ChatMessage[]) => {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === "assistant" && message.status === "error") {
      return `${message.id}:${message.error || message.content}`;
    }
  }
  return "";
};

const readStageScreenshotMode = (storageKey: string): StageScreenshotMode => {
  try {
    const stored = window.localStorage.getItem(storageKey);
    const parsed = stored ? JSON.parse(stored) : null;
    return isStageScreenshotMode(parsed) ? parsed : "fast";
  } catch {
    return "fast";
  }
};

const readCurrentProjectTitle = () =>
  String((document.querySelector(PROJECT_TITLE_SELECTOR) as HTMLElement | null)?.innerText || "").trim();

const getUrlRequestedSessionId = () => {
  try {
    return new URL(window.location.href).searchParams.get("AISessionID")?.trim() || "";
  } catch {
    return "";
  }
};

const normalizeProjectCompareText = (value: string) => String(value || "").trim().replace(/\s+/g, " ");

const isSessionInCurrentProjectByIdentity = (
  session: ChatSession | undefined,
  currentProjectId: string,
  currentProjectTitle: string,
) => {
  if (!session) return false;
  const targetProjectId = String(session.projectId || "").trim();
  const currentId = String(currentProjectId || "").trim();
  if (targetProjectId && currentId && targetProjectId === currentId) return true;
  if (!targetProjectId) return false;

  const targetProjectName = normalizeProjectCompareText(session.projectName || "");
  const currentTitle = normalizeProjectCompareText(currentProjectTitle || "");
  return Boolean(targetProjectName && currentTitle && targetProjectName === currentTitle);
};

const openUrlInNewWindow = (url: string) => {
  const link = document.createElement("a");
  link.href = url;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  link.remove();
};

const DEFAULT_FLOATING_POSITION: FloatingPosition = {
  translateX: -1,
  translateY: -1,
};

const RESIZE_DIRECTIONS: ResizeDirection[] = ["n", "e", "s", "w", "ne", "nw", "se", "sw"];
const FLOATING_PANEL_MAX_WIDTH = 560;

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);
const getFloatingControlWidth = (buttonWidth = FLOATING_BUTTON_SIZE_ESTIMATE) => Math.max(156, buttonWidth + 104);
const isPrimaryPointerActivation = (event: React.PointerEvent<HTMLElement>) =>
  event.pointerType !== "mouse" || event.button === 0;

interface FloatingButtonCollisionRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
}

const resolveAssistantWindowMetrics = (rect: AssistantWindowRect, viewport: { width: number; height: number }) => {
  const availableWidth = Math.max(1, viewport.width - WINDOW_MARGIN * 2);
  const availableHeight = Math.max(1, viewport.height - WINDOW_MARGIN * 2);
  const visualWidth = Math.min(rect.width, availableWidth);
  const visualHeight = Math.min(rect.height, availableHeight);
  const compactScale = Math.min(
    1,
    visualWidth / COMPACT_WINDOW_CONTENT_WIDTH,
    visualHeight / COMPACT_WINDOW_CONTENT_HEIGHT,
  );
  const scale = clamp(compactScale < 1 ? Math.max(MIN_COMPACT_WINDOW_SCALE, compactScale) : 1, 0.1, 1);
  const contentWidth = visualWidth / scale;
  const contentHeight = visualHeight / scale;

  return {
    visualWidth,
    visualHeight,
    contentWidth,
    contentHeight,
    scale,
    translateX: clamp(
      rect.translateX,
      WINDOW_MARGIN,
      Math.max(WINDOW_MARGIN, viewport.width - visualWidth - WINDOW_MARGIN),
    ),
    translateY: clamp(
      rect.translateY,
      WINDOW_MARGIN,
      Math.max(WINDOW_MARGIN, viewport.height - visualHeight - WINDOW_MARGIN),
    ),
  };
};

const constrainWindowRect = (rect: AssistantWindowRect): AssistantWindowRect => {
  const maxWidth = Math.max(MIN_WINDOW_WIDTH, window.innerWidth - WINDOW_MARGIN * 2);
  const maxHeight = Math.max(MIN_WINDOW_HEIGHT, window.innerHeight - WINDOW_MARGIN * 2);
  const width = clamp(rect.width, MIN_WINDOW_WIDTH, maxWidth);
  const height = clamp(rect.height, MIN_WINDOW_HEIGHT, maxHeight);
  return {
    width,
    height,
    translateX: clamp(
      rect.translateX,
      WINDOW_MARGIN,
      Math.max(WINDOW_MARGIN, window.innerWidth - width - WINDOW_MARGIN),
    ),
    translateY: clamp(
      rect.translateY,
      WINDOW_MARGIN,
      Math.max(WINDOW_MARGIN, window.innerHeight - height - WINDOW_MARGIN),
    ),
  };
};

const constrainFloatingPosition = (
  position: FloatingPosition,
  controlWidth = getFloatingControlWidth(),
): FloatingPosition => ({
  translateX: clamp(
    position.translateX,
    WINDOW_MARGIN,
    Math.max(WINDOW_MARGIN, window.innerWidth - controlWidth - WINDOW_MARGIN),
  ),
  translateY: clamp(
    position.translateY,
    WINDOW_MARGIN,
    Math.max(WINDOW_MARGIN, window.innerHeight - FLOATING_BUTTON_HEIGHT - WINDOW_MARGIN),
  ),
});

const resolveFloatingPosition = (
  position: FloatingPosition,
  controlWidth = getFloatingControlWidth(),
): FloatingPosition => {
  if (position.translateX >= 0 && position.translateY >= 0) {
    return constrainFloatingPosition(position, controlWidth);
  }

  return constrainFloatingPosition(
    {
      translateX: (window.innerWidth - controlWidth) / 2,
      translateY: window.innerHeight - FLOATING_BUTTON_HEIGHT - 28,
    },
    controlWidth,
  );
};

const getAssistantText = (message: ChatMessage) => {
  const blockText = message.anthropic_content_blocks
    ?.filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();

  return (blockText || message.content || "").trim();
};

const getAssistantTextAfterLastToolUse = (message: ChatMessage) => {
  const blocks = message.anthropic_content_blocks;
  if (!blocks?.length) return getAssistantText(message);

  let lastToolUseIndex = -1;
  blocks.forEach((block, index) => {
    if (block.type === "tool_use") lastToolUseIndex = index;
  });

  const text = blocks
    .slice(lastToolUseIndex + 1)
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();

  return text || getAssistantText(message);
};

const getLatestAssistantText = (messages: ChatMessage[]) => {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role !== "assistant") continue;
    const text = getAssistantTextAfterLastToolUse(message);
    if (text) return text;
  }

  return "";
};

const getCurrentAssistantTurnText = (messages: ChatMessage[]) => {
  const parts: string[] = [];
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role === "user") break;
    if (message.role !== "assistant") continue;
    const text = getAssistantText(message);
    if (text) parts.unshift(text);
  }

  return parts.join("\n\n").trim();
};

const getCurrentAssistantFinalReplyText = (messages: ChatMessage[]) => {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role === "user") break;
    if (message.role !== "assistant") continue;
    const blocks = message.anthropic_content_blocks;
    if (blocks?.some((block) => block.type === "tool_use")) {
      const text = getAssistantTextAfterLastToolUse(message);
      return text === getAssistantText(message) ? "" : text;
    }
    const text = getAssistantText(message);
    if (text) return text;
  }

  return "";
};

const getCurrentAssistantFinalReplyStreamKey = (messages: ChatMessage[]) => {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role === "user") break;
    if (message.role !== "assistant") continue;
    const blocks = message.anthropic_content_blocks;
    if (blocks?.some((block) => block.type === "tool_use")) {
      const text = getAssistantTextAfterLastToolUse(message);
      if (text && text !== getAssistantText(message)) return `text-${message.id || index}`;
      continue;
    }
    const text = getAssistantText(message);
    if (text) return `text-${message.id || index}`;
  }

  return "";
};

const MessageIcon = () => (
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <path
      d="M5.4 5.2h13.2c1.1 0 2 .9 2 2v7.9c0 1.1-.9 2-2 2H11l-4.2 3.1c-.7.5-1.6 0-1.6-.8v-2.3h-.1c-1.1 0-2-.9-2-2V7.2c0-1.1.9-2 2-2Z"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinejoin="round"
    />
    <path d="M7.8 9.6h8.4M7.8 13h5.8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
  </svg>
);

const getResizeHandleClassName = (direction: ResizeDirection) => {
  switch (direction) {
    case "n":
      return styles.assistantResizeHandleN;
    case "e":
      return styles.assistantResizeHandleE;
    case "s":
      return styles.assistantResizeHandleS;
    case "w":
      return styles.assistantResizeHandleW;
    case "ne":
      return styles.assistantResizeHandleNe;
    case "nw":
      return styles.assistantResizeHandleNw;
    case "se":
      return styles.assistantResizeHandleSe;
    case "sw":
      return styles.assistantResizeHandleSw;
  }
};

const AIAssistant: React.FC<PluginContext> = ({ vm, blockly, workspace, utils }) => {
  const [visible, setVisible] = React.useState(false);
  const [isMinimized, setIsMinimized] = React.useState(false);
  const [assistantTransition, setAssistantTransition] = React.useState<AssistantTransition>("idle");
  const [assistantMorphTarget, setAssistantMorphTarget] = React.useState<AssistantMorphTarget>({
    targetX: DEFAULT_CONTAINER_INFO.translateX,
    targetY: DEFAULT_CONTAINER_INFO.translateY,
    targetWidth: FLOATING_BUTTON_SIZE_ESTIMATE,
    targetHeight: FLOATING_BUTTON_HEIGHT,
  });
  const [isWindowRelocating, setIsWindowRelocating] = React.useState(false);
  const [isFloatingInputOpen, setIsFloatingInputOpen] = React.useState(false);
  const [floatingPlacement, setFloatingPlacement] = React.useState<FloatingPlacement>("above");
  const [floatingPanelAlignment, setFloatingPanelAlignment] = React.useState<FloatingPanelAlignment>("center");
  const [floatingPanelWidth, setFloatingPanelWidth] = React.useState<number | null>(null);
  const [isFloatingPanelEntering, setIsFloatingPanelEntering] = React.useState(false);
  const [isFloatingReplyExpanded, setIsFloatingReplyExpanded] = React.useState(false);
  const [isFloatingReplyCollapsing, setIsFloatingReplyCollapsing] = React.useState(false);
  const [isAgentMenuOpen, setIsAgentMenuOpen] = React.useState(false);
  const [isComposerExpanded, setIsComposerExpanded] = React.useState(false);
  const [pendingSessionSwitch, setPendingSessionSwitch] = React.useState<ChatSession | null>(null);
  const [pendingExternalUrl, setPendingExternalUrl] = React.useState<string | null>(null);
  const [themeMode, setThemeMode] = React.useState<ThemeMode>(() => {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isThemeMode(stored) ? stored : "gandi";
  });
  const [resolvedThemeMode, setResolvedThemeMode] = React.useState<ResolvedThemeMode>(() =>
    resolveThemeMode(themeMode),
  );
  const containerRef = React.useRef<HTMLElement | null>(null);
  const windowRef = React.useRef<HTMLDivElement | null>(null);
  const floatingRootRef = React.useRef<HTMLDivElement | null>(null);
  const floatingPanelRef = React.useRef<HTMLDivElement | null>(null);
  const floatingButtonRef = React.useRef<HTMLButtonElement | null>(null);
  const floatingReplyContentRef = React.useRef<HTMLDivElement | null>(null);
  const floatingReplyScrollRef = React.useRef<HTMLDivElement | null>(null);
  const floatingDragStateRef = React.useRef({ didDrag: false });
  const didAutoOpenFinalReplyRef = React.useRef(false);
  const shouldExpandLatestReplyAfterStreamingRef = React.useRef(false);
  const floatingReplyStickyRef = React.useRef(true);
  const floatingReplyDetachedRef = React.useRef(false);
  const floatingReplyLastScrollTopRef = React.useRef(0);
  const floatingReplyScrollSnapshotRef = React.useRef(0);
  const agentMenuRef = React.useRef<HTMLDivElement | null>(null);
  const requestedSessionHandledRef = React.useRef("");
  const [enableReasoning, setEnableReasoning] = useStoredState<boolean>("AI_ASSISTANT_ENABLE_REASONING", false);
  const [reasoningEffort, setReasoningEffort] = useStoredState<ReasoningEffort>(
    "AI_ASSISTANT_REASONING_EFFORT",
    "medium",
  );
  const [conversationMode, setConversationMode] = useStoredState<ConversationMode>(
    "AI_ASSISTANT_CONVERSATION_MODE",
    "code",
  );
  const [allowSubAgents, setAllowSubAgents] = useStoredState<boolean>("AI_ASSISTANT_ALLOW_SUB_AGENTS", true);
  const [defaultCostumeType, setDefaultCostumeType] = useStoredState<DefaultCostumeType>(
    "AI_ASSISTANT_DEFAULT_COSTUME_TYPE",
    "ask",
  );
  const [aiGuideVerificationMode, setAiGuideVerificationMode] = useStoredState<AiGuideVerificationMode>(
    "AI_ASSISTANT_AI_GUIDE_VERIFICATION_MODE",
    "review_code",
  );
  const projectIdentity = React.useMemo(() => getProjectIdentity(vm), [vm]);
  const currentProjectId = projectIdentity.available ? projectIdentity.projectId : "";
  const [currentProjectTitle, setCurrentProjectTitle] = React.useState(() => readCurrentProjectTitle());
  const stageScreenshotModeStorageKey = `${STAGE_SCREENSHOT_MODE_STORAGE_KEY_PREFIX}${currentProjectId || "unsaved"}`;
  const [stageScreenshotMode, setStageScreenshotModeState] = React.useState<StageScreenshotMode>(() =>
    readStageScreenshotMode(stageScreenshotModeStorageKey),
  );
  const setStageScreenshotMode = React.useCallback(
    (mode: StageScreenshotMode) => {
      setStageScreenshotModeState(mode);
      window.localStorage.setItem(stageScreenshotModeStorageKey, JSON.stringify(mode));
    },
    [stageScreenshotModeStorageKey],
  );

  React.useEffect(() => {
    const nextMode = readStageScreenshotMode(stageScreenshotModeStorageKey);
    setStageScreenshotModeState((previous) => (previous === nextMode ? previous : nextMode));
  }, [stageScreenshotModeStorageKey]);

  React.useEffect(() => {
    const updateProjectTitle = () => {
      const nextTitle = readCurrentProjectTitle();
      setCurrentProjectTitle((previous) => (previous === nextTitle ? previous : nextTitle));
    };
    updateProjectTitle();

    let observedElement: HTMLElement | null = null;
    let titleObserver: MutationObserver | null = null;

    const observeTitleElement = () => {
      const nextElement = document.querySelector(PROJECT_TITLE_SELECTOR) as HTMLElement | null;
      if (nextElement === observedElement) return;
      titleObserver?.disconnect();
      observedElement = nextElement;
      if (!observedElement) return;
      titleObserver = new MutationObserver(updateProjectTitle);
      titleObserver.observe(observedElement, {
        childList: true,
        subtree: true,
        characterData: true,
      });
      updateProjectTitle();
    };

    const documentObserver = new MutationObserver(observeTitleElement);
    documentObserver.observe(document.body, { childList: true });
    observeTitleElement();
    const interval = window.setInterval(observeTitleElement, 1000);

    return () => {
      window.clearInterval(interval);
      documentObserver.disconnect();
      titleObserver?.disconnect();
    };
  }, []);

  const [containerInfo, setContainerInfo] = useStoredState<AssistantWindowRect>(
    "AI_ASSISTANT_CONTAINER_INFO",
    DEFAULT_CONTAINER_INFO,
  );

  const [floatingPosition, setFloatingPosition] = useStoredState<FloatingPosition>(
    "AI_ASSISTANT_FLOATING_POSITION",
    DEFAULT_FLOATING_POSITION,
  );
  const [floatingReplyContentHeight, setFloatingReplyContentHeight] = React.useState(0);
  const [isFloatingReplyStickyToBottom, setIsFloatingReplyStickyToBottom] = React.useState(true);
  const [floatingButtonWidth, setFloatingButtonWidth] = React.useState(FLOATING_BUTTON_SIZE_ESTIMATE);
  const [viewportSize, setViewportSize] = React.useState(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }));

  const containerInfoRef = React.useRef(containerInfo);
  const floatingPositionRef = React.useRef(floatingPosition);
  const assistantWindowMetrics = React.useMemo(
    () => resolveAssistantWindowMetrics(containerInfo, viewportSize),
    [containerInfo, viewportSize],
  );
  const useDrawerHistory = assistantWindowMetrics.visualWidth < 760;
  const [extensionGuideVersion, setExtensionGuideVersion] = React.useState(0);

  React.useEffect(() => {
    const handleResize = () => {
      const nextViewportSize = {
        width: window.innerWidth,
        height: window.innerHeight,
      };
      setViewportSize((previous) =>
        previous.width === nextViewportSize.width && previous.height === nextViewportSize.height
          ? previous
          : nextViewportSize,
      );
    };
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  React.useEffect(() => {
    window.localStorage.setItem(THEME_STORAGE_KEY, themeMode);
  }, [themeMode]);

  React.useEffect(() => {
    const updateResolvedThemeMode = () => {
      const nextMode = resolveThemeMode(themeMode);
      setResolvedThemeMode((previous) => (previous === nextMode ? previous : nextMode));
    };
    updateResolvedThemeMode();

    if (themeMode === "system") {
      const mediaQuery = window.matchMedia?.("(prefers-color-scheme: light)");
      mediaQuery?.addEventListener?.("change", updateResolvedThemeMode);
      mediaQuery?.addListener?.(updateResolvedThemeMode);
      return () => {
        mediaQuery?.removeEventListener?.("change", updateResolvedThemeMode);
        mediaQuery?.removeListener?.(updateResolvedThemeMode);
      };
    }

    if (themeMode === "gandi") {
      const observer = new MutationObserver(updateResolvedThemeMode);
      observer.observe(document.documentElement, { attributes: true, attributeFilter: ["style", "class"] });
      const interval = window.setInterval(updateResolvedThemeMode, 1000);
      return () => {
        observer.disconnect();
        window.clearInterval(interval);
      };
    }
  }, [themeMode]);

  React.useEffect(() => {
    if (!vm?.runtime) return;
    const runtime = vm.runtime;
    let lastSignature = getRuntimeExtensionGuideSignature(runtime);
    const refresh = () => {
      const nextSignature = getRuntimeExtensionGuideSignature(runtime);
      if (nextSignature === lastSignature) return;
      lastSignature = nextSignature;
      setExtensionGuideVersion((version) => version + 1);
    };
    const eventNames = ["EXTENSION_ADDED", "EXTENSION_REMOVED", "EXTENSIONS_CHANGED", "BLOCKSINFO_UPDATE"];

    for (const eventName of eventNames) {
      runtime.on?.(eventName, refresh);
    }

    const interval = window.setInterval(refresh, 3000);
    return () => {
      window.clearInterval(interval);
      for (const eventName of eventNames) {
        runtime.off?.(eventName, refresh);
        runtime.removeListener?.(eventName, refresh);
      }
    };
  }, [vm]);

  React.useEffect(() => {
    containerInfoRef.current = containerInfo;
  }, [containerInfo]);

  React.useEffect(() => {
    floatingPositionRef.current = floatingPosition;
  }, [floatingPosition]);

  React.useEffect(() => {
    if (isFloatingReplyExpanded) setIsFloatingReplyCollapsing(false);
  }, [isFloatingReplyExpanded]);

  React.useEffect(() => {
    if (!isFloatingReplyCollapsing) return;
    const timer = window.setTimeout(() => setIsFloatingReplyCollapsing(false), FLOATING_REPLY_COLLAPSE_MS);
    return () => window.clearTimeout(timer);
  }, [isFloatingReplyCollapsing]);

  // Use custom hooks for complex logic
  const {
    agents,
    flattenedModels,
    currentModelId,
    setCurrentModelId,
    currentAgent,
    imageModelId,
    setImageModelId,
    imageGenerationModel,
    showSettings,
    setShowSettings,
    editingAgent,
    setEditingAgent,
    handleSaveAgent,
    handleDeleteAgent,
    handleExportAgent,
    handleImportAgents,
  } = useAgents();
  const {
    subAgents,
    editingSubAgent,
    setEditingSubAgent,
    handleSaveSubAgent,
    handleDeleteSubAgent,
    createEmptySubAgent,
  } = useSubAgents();

  const { userGuides, saveGuide, createAiGuide, deleteGuide, toggleGuide, importGuide } = useGuides();
  const extensionGuides = React.useMemo(() => getRuntimeExtensionGuides(vm?.runtime), [extensionGuideVersion, vm]);
  const allGuides = React.useMemo(() => getAllGuides(userGuides, extensionGuides), [userGuides, extensionGuides]);

  const {
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
  } = useChatSessions(useDrawerHistory, currentProjectId, currentProjectTitle);

  const handleHistorySelectSession = React.useCallback(
    (sessionId: string) => {
      const targetSession = sessions.find((session) => session.id === sessionId);
      if (!targetSession) return;
      const targetProjectId = String(targetSession.projectId || "").trim();
      if (targetProjectId && !isSessionInCurrentProjectByIdentity(targetSession, currentProjectId, currentProjectTitle)) {
        setPendingSessionSwitch(targetSession);
        return;
      }
      if (!targetProjectId) {
        handleSelectSession(sessionId, { allowUnassigned: true });
        return;
      }
      handleSelectSession(sessionId);
    },
    [currentProjectId, currentProjectTitle, handleSelectSession, sessions],
  );

  const handleConfirmSessionSwitch = React.useCallback(() => {
    if (!pendingSessionSwitch) return;
    handleSelectSession(pendingSessionSwitch.id, { allowCrossProject: true });
    setPendingSessionSwitch(null);
  }, [handleSelectSession, pendingSessionSwitch]);

  const handleJumpToSessionProject = React.useCallback(() => {
    if (!pendingSessionSwitch?.projectId) return;
    const projectId = encodeURIComponent(pendingSessionSwitch.projectId);
    const sessionId = encodeURIComponent(pendingSessionSwitch.id);
    window.location.href = `/gandi/project/${projectId}?AISessionID=${sessionId}`;
  }, [pendingSessionSwitch]);

  const handleRequestOpenUrl = React.useCallback((url: string, requiresConfirmation: boolean) => {
    if (requiresConfirmation) {
      setPendingExternalUrl(url);
      return;
    }
    openUrlInNewWindow(url);
  }, []);

  const handleConfirmExternalUrl = React.useCallback(() => {
    if (!pendingExternalUrl) return;
    openUrlInNewWindow(pendingExternalUrl);
    setPendingExternalUrl(null);
  }, [pendingExternalUrl]);

  React.useEffect(() => {
    const requestedSessionId = getUrlRequestedSessionId();
    if (!requestedSessionId) return;
    if (requestedSessionHandledRef.current === requestedSessionId) return;
    const targetSession = sessions.find((session) => session.id === requestedSessionId);
    if (!targetSession) return;
    requestedSessionHandledRef.current = requestedSessionId;
    setVisible(true);
    setIsMinimized(false);
    setPendingSessionSwitch(null);
    handleSelectSession(targetSession.id, { allowCrossProject: true });
  }, [handleSelectSession, sessions]);

  const {
    inputText,
    setInputText,
    isGenerating,
    pendingUserQuestion,
    answerUserQuestion,
    goBackUserQuestion,
    attachments,
    setAttachments,
    queuedUserMessages,
    handleSend,
    handleRetryLastResponse,
    handleCompressContext,
    handleStopGenerating,
    contextUsage,
    isCompressingContext,
    projectIndexStatus,
    projectIndexBuild,
    projectExamplePrompts,
    handleBuildProjectIndex,
    handleStopProjectIndex,
  } = useChat({
    messages,
    currentAgent,
    updateSessionMessages,
    createChatSession,
    appendSessionSnapshot,
    enableReasoning,
    reasoningEffort,
    vm,
    blockly,
    workspace,
    utils,
    userGuides,
    createAiGuide,
    aiGuideVerificationMode,
    subAgents,
    allowSubAgents,
    defaultCostumeType,
    stageScreenshotMode,
    imageGenerationModel,
    conversationMode,
  });

  const examplePrompts = React.useMemo(() => {
    const projectPrompts = projectExamplePrompts?.[conversationMode] || [];
    if (projectPrompts.length) return projectPrompts.slice(0, 4);
    const defaultPool = conversationMode === "chat" ? DEFAULT_CHAT_EXAMPLE_PROMPTS : DEFAULT_CODE_EXAMPLE_PROMPTS;
    return pickExamplePrompts(defaultPool, `${conversationMode}:${currentProjectId || "unsaved-project"}`, 4);
  }, [conversationMode, currentProjectId, projectExamplePrompts]);

  const handleUseExamplePrompt = React.useCallback(
    (prompt: string) => {
      setInputText(prompt);
    },
    [setInputText],
  );

  const { previewAttachment, setPreviewAttachment, handleOpenAttachment } = useAttachmentInteraction(vm, workspace);
  const inlineAttachmentHandlerRef = React.useRef<((attachment: Attachment) => void) | null>(null);
  const handleInlineAttachmentAdded = React.useCallback((handler: (attachment: Attachment) => void) => {
    inlineAttachmentHandlerRef.current = handler;
  }, []);
  const insertInlineAttachment = React.useCallback(
    (attachment: Attachment) => {
      if (inlineAttachmentHandlerRef.current) {
        inlineAttachmentHandlerRef.current(attachment);
        return;
      }
      setAttachments((prev) => [...prev, attachment]);
    },
    [setAttachments],
  );
  const insertInlineTextReference = React.useCallback(
    (text: string) => {
      const reference = String(text || "").trim();
      if (!reference) return;
      setInputText((previous) => {
        const prefix = previous && !/\s$/.test(previous) ? " " : "";
        return `${previous || ""}${prefix}${reference} `;
      });
    },
    [setInputText],
  );
  const { isSelecting, startSelecting, cancelSelecting } = useBlockRangeSelection({
    workspace,
    vm,
    onRangeSelected: insertInlineTextReference,
    onSelectionError: (message) => void showAssistantAlert(message),
  });
  const handleStartBlockSelection = React.useCallback(() => {
    if (projectIndexStatus?.blocked || !projectIndexStatus?.built) {
      void showAssistantAlert("请先构建项目索引，再框选积木。");
      return;
    }
    startSelecting();
  }, [projectIndexStatus?.blocked, projectIndexStatus?.built, startSelecting]);

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
    const wasVisible = visible && !isMinimized;
    setContainerInfo(
      constrainWindowRect({
        ...containerInfoRef.current,
        ...getContainerPosition(),
      }),
    );
    if (wasVisible) {
      setIsWindowRelocating(true);
      window.setTimeout(() => setIsWindowRelocating(false), 180);
    }
    setVisible(true);
    setIsMinimized(false);
    setAssistantTransition("idle");
    setIsFloatingInputOpen(false);
  }, [getContainerPosition, isMinimized, setContainerInfo, visible]);

  const handleClose = () => {
    setVisible(false);
    setIsMinimized(false);
    setAssistantTransition("idle");
    setIsFloatingInputOpen(false);
  };

  const handleRestoreToUserMessage = React.useCallback(
    async (messageId: string, message: { content: string; attachments?: Attachment[] }) => {
      const result = rollbackToMessage(messageId, message.content, message.attachments || []);
      if (!result) {
        return;
      }

      const currentBlockCount = getRuntimeBlockCount(vm);
      const isCurrentProjectLarge =
        typeof currentBlockCount === "number" && currentBlockCount >= LARGE_PROJECT_ROLLBACK_BLOCK_THRESHOLD;

      if (isCurrentProjectLarge) {
        await showAssistantAlert(
          `当前作品包含约 ${currentBlockCount} 个积木，属于大型项目；为避免 Scratch VM 加载大型快照导致角色丢失，本次仅回滚对话，不回滚作品。`,
        );
      } else if (result.snapshot?.projectRollbackSkipped) {
        await showAssistantAlert(result.snapshot.projectRollbackSkipReason || "当前仅回滚对话，不回滚作品。");
      } else {
        const restored = await restoreProjectSnapshot(vm, result.snapshot);
        if (!restored) {
          await showAssistantAlert("项目快照恢复失败，已取消撤回以避免破坏当前作品。");
          return;
        }
      }

      commitRollbackToMessage(messageId);
      setInputText(result.inputText);
      setAttachments(result.attachments);
    },
    [commitRollbackToMessage, rollbackToMessage, setAttachments, setInputText, vm],
  );

  const handleExportConversation = React.useCallback(async () => {
    if (messages.length === 0) {
      await showAssistantAlert("当前会话为空，没有可导出的内容。");
      return;
    }

    const exportText = exportConversationText(currentSession, messages);

    try {
      await navigator.clipboard.writeText(exportText);
      await showAssistantAlert(`会话文本已复制，共 ${exportText.length.toLocaleString()} 字符。`);
      return;
    } catch (error) {
      console.warn("[AI Assistant] Failed to copy conversation export, falling back to download", error);
    }

    const safeTitle = (currentSession?.title || "ai-assistant-session").replace(/[\\/:*?"<>|]+/g, "_").slice(0, 48);
    const blob = new Blob([exportText], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${safeTitle || "ai-assistant-session"}.txt`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    await showAssistantAlert(`剪贴板不可用，已导出为文本文件，共 ${exportText.length.toLocaleString()} 字符。`);
  }, [currentSession, messages]);

  const handleExportProjectIndexBuild = React.useCallback(async () => {
    const exportText = String(projectIndexBuild?.exportText || "").trim();
    if (!exportText) {
      await showAssistantAlert("暂无可导出的项目索引构建记录。");
      return;
    }

    try {
      await navigator.clipboard.writeText(exportText);
      await showAssistantAlert(`项目索引构建记录已复制，共 ${exportText.length.toLocaleString()} 字符。`);
      return;
    } catch (error) {
      console.warn("[AI Assistant] Failed to copy project index build export, falling back to download", error);
    }

    const blob = new Blob([exportText], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `ai-project-index-build-${new Date().toISOString().replace(/[:.]/g, "-")}.txt`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    await showAssistantAlert(`剪贴板不可用，已导出为文本文件，共 ${exportText.length.toLocaleString()} 字符。`);
  }, [projectIndexBuild?.exportText]);

  const handleWindowRectChange = React.useCallback(
    (value: AssistantWindowRect) => {
      const nextValue = constrainWindowRect(value);
      containerInfoRef.current = nextValue;
      setContainerInfo(nextValue);
    },
    [setContainerInfo],
  );

  const handleFloatingPositionChange = React.useCallback(
    (value: FloatingPosition, width = floatingButtonRef.current?.offsetWidth || FLOATING_BUTTON_SIZE_ESTIMATE) => {
      const nextValue = resolveFloatingPosition(value, getFloatingControlWidth(width));
      floatingPositionRef.current = nextValue;
      setFloatingPosition(nextValue);
    },
    [setFloatingPosition],
  );

  const updateAssistantMorphTarget = React.useCallback(
    (buttonWidth = floatingButtonRef.current?.offsetWidth || FLOATING_BUTTON_SIZE_ESTIMATE) => {
      const controlWidth = getFloatingControlWidth(buttonWidth);
      const floatingPosition = resolveFloatingPosition(floatingPositionRef.current, controlWidth);
      const buttonCenterX = floatingPosition.translateX + controlWidth / 2;
      setAssistantMorphTarget({
        targetX: buttonCenterX - buttonWidth / 2,
        targetY: floatingPosition.translateY,
        targetWidth: buttonWidth,
        targetHeight: FLOATING_BUTTON_HEIGHT,
      });
    },
    [],
  );

  const handleMinimize = React.useCallback(() => {
    const buttonWidth = floatingButtonRef.current?.offsetWidth || FLOATING_BUTTON_SIZE_ESTIMATE;
    handleFloatingPositionChange(floatingPositionRef.current, buttonWidth);
    updateAssistantMorphTarget(buttonWidth);
    setIsWindowRelocating(false);
    setAssistantTransition("minimizing");
    setIsComposerExpanded(false);
    setIsFloatingInputOpen(false);
    window.setTimeout(() => {
      setIsMinimized(true);
      setAssistantTransition("idle");
    }, WINDOW_TRANSITION_MS);
  }, [handleFloatingPositionChange, updateAssistantMorphTarget]);

  const handleRestoreWindow = React.useCallback(() => {
    updateAssistantMorphTarget();
    setIsWindowRelocating(false);
    setAssistantTransition("restoring");
    setIsFloatingInputOpen(false);
    setIsFloatingReplyExpanded(false);
    setIsMinimized(false);
    window.setTimeout(() => {
      setAssistantTransition("idle");
    }, WINDOW_TRANSITION_MS);
  }, [updateAssistantMorphTarget]);

  const pluginsWrapper = document.querySelector(".plugins-wrapper") || document.querySelector("#gandi-plugins-wrapper");

  const latestTodoSnapshot = React.useMemo(() => getLatestTodoSnapshot(messages), [messages]);
  const activeTodo = latestTodoSnapshot?.activeTodo || null;
  const shouldRenderFloating =
    visible && (isMinimized || assistantTransition === "minimizing" || assistantTransition === "restoring");
  const shouldShowTaskPill =
    shouldRenderFloating && Boolean(activeTodo) && (isGenerating || latestTodoSnapshot?.isRunning);
  const latestAssistantText = React.useMemo(() => getLatestAssistantText(messages), [messages]);
  const currentAssistantFinalReplyText = React.useMemo(() => getCurrentAssistantFinalReplyText(messages), [messages]);
  const currentAssistantFinalReplyStreamKey = React.useMemo(
    () => getCurrentAssistantFinalReplyStreamKey(messages),
    [messages],
  );
  const floatingReplyText = isGenerating ? currentAssistantFinalReplyText : latestAssistantText;
  const hasFinalReplyStarted = Boolean(currentAssistantFinalReplyText);
  const userQuestionSoundKey = pendingUserQuestion ? pendingUserQuestion.id : "";
  const streamErrorSoundKey = React.useMemo(() => getLatestStreamErrorSoundKey(messages), [messages]);
  const lastUserQuestionSoundKeyRef = React.useRef("");
  const lastStreamErrorSoundKeyRef = React.useRef("");
  const userQuestionAudioRef = React.useRef<HTMLAudioElement | null>(null);
  const streamErrorAudioRef = React.useRef<HTMLAudioElement | null>(null);
  const userQuestionSoundPendingRef = React.useRef(false);
  const streamErrorSoundPendingRef = React.useRef(false);
  const shouldShowFloatingQuestion = isMinimized && Boolean(pendingUserQuestion);
  const shouldShowGeneratingFloatingOutput = isMinimized && isFloatingInputOpen && isGenerating && hasFinalReplyStarted;
  const shouldShowGeneratingFloatingBullet =
    isMinimized && isFloatingInputOpen && isGenerating && !hasFinalReplyStarted;
  const shouldShowFloatingInputPanel = isFloatingInputOpen && (!isGenerating || !pendingUserQuestion);
  const shouldShowFloatingPanel =
    isMinimized &&
    (shouldShowFloatingInputPanel ||
      shouldShowGeneratingFloatingOutput ||
      shouldShowGeneratingFloatingBullet ||
      shouldShowFloatingQuestion);
  const shouldRenderWindow =
    visible && (!isMinimized || assistantTransition === "minimizing" || assistantTransition === "restoring");

  const playSound = React.useCallback(
    async (
      audioRef: React.MutableRefObject<HTMLAudioElement | null>,
      soundDataUrl: string,
      label: string,
      pendingRef: React.MutableRefObject<boolean>,
    ) => {
      const audio = audioRef.current || new Audio(getSoundSource(soundDataUrl));
      audioRef.current = audio;
      if (!audio.src) {
        audio.src = getSoundSource(soundDataUrl);
      }
      audio.volume = 0.72;
      audio.muted = false;
      audio.pause();
      try {
        audio.currentTime = 0;
      } catch (_error) {
        // Some browsers reject seeking until metadata is ready; playback can still start from the beginning.
      }
      try {
        await audio.play();
        pendingRef.current = false;
      } catch (error) {
        console.warn(`[AIAssistant] Failed to play ${label}:`, error);
        pendingRef.current = true;
        throw error;
      }
    },
    [],
  );

  const playUserQuestionSound = React.useCallback(async () => {
    await playSound(userQuestionAudioRef, userQuestionSoundUrl, "user question sound", userQuestionSoundPendingRef);
  }, [playSound]);

  const playStreamErrorSound = React.useCallback(async () => {
    await playSound(streamErrorAudioRef, streamErrorSoundUrl, "stream error sound", streamErrorSoundPendingRef);
  }, [playSound]);

  React.useEffect(() => {
    const userQuestionAudio = new Audio(getSoundSource(userQuestionSoundUrl));
    const streamErrorAudio = new Audio(getSoundSource(streamErrorSoundUrl));
    userQuestionAudio.preload = "auto";
    streamErrorAudio.preload = "auto";
    userQuestionAudio.volume = 0.72;
    streamErrorAudio.volume = 0.72;
    userQuestionAudioRef.current = userQuestionAudio;
    streamErrorAudioRef.current = streamErrorAudio;
    userQuestionAudio.load();
    streamErrorAudio.load();

    const unlockAudio = () => {
      const unlockOne = (
        currentAudio: HTMLAudioElement | null,
        pendingRef: React.MutableRefObject<boolean>,
        replay: () => Promise<void>,
      ) => {
        if (!currentAudio) return;
        currentAudio.muted = true;
        try {
          currentAudio.currentTime = 0;
        } catch (_error) {
          // Metadata may not be ready yet.
        }
        void currentAudio
          .play()
          .then(() => {
            currentAudio.pause();
            try {
              currentAudio.currentTime = 0;
            } catch (_error) {
              // Metadata may not be ready yet.
            }
            currentAudio.muted = false;
            if (pendingRef.current) {
              pendingRef.current = false;
              void replay().catch(() => undefined);
            }
          })
          .catch(() => {
            currentAudio.muted = false;
          });
      };

      unlockOne(userQuestionAudioRef.current, userQuestionSoundPendingRef, playUserQuestionSound);
      unlockOne(streamErrorAudioRef.current, streamErrorSoundPendingRef, playStreamErrorSound);
    };

    document.addEventListener("pointerdown", unlockAudio, true);
    document.addEventListener("keydown", unlockAudio, true);
    return () => {
      document.removeEventListener("pointerdown", unlockAudio, true);
      document.removeEventListener("keydown", unlockAudio, true);
      userQuestionAudio.pause();
      streamErrorAudio.pause();
      if (userQuestionAudioRef.current === userQuestionAudio) {
        userQuestionAudioRef.current = null;
      }
      if (streamErrorAudioRef.current === streamErrorAudio) {
        streamErrorAudioRef.current = null;
      }
    };
  }, [playStreamErrorSound, playUserQuestionSound]);

  React.useEffect(() => {
    if (!userQuestionSoundKey || lastUserQuestionSoundKeyRef.current === userQuestionSoundKey) return;
    lastUserQuestionSoundKeyRef.current = userQuestionSoundKey;
    void playUserQuestionSound().catch(() => undefined);
  }, [playUserQuestionSound, userQuestionSoundKey]);

  React.useEffect(() => {
    if (!streamErrorSoundKey || lastStreamErrorSoundKeyRef.current === streamErrorSoundKey) return;
    lastStreamErrorSoundKeyRef.current = streamErrorSoundKey;
    void playStreamErrorSound().catch(() => undefined);
  }, [playStreamErrorSound, streamErrorSoundKey]);

  React.useLayoutEffect(() => {
    if (isFloatingReplyCollapsing) return;
    if (!floatingReplyContentRef.current) return;
    const updateHeight = () => setFloatingReplyContentHeight(floatingReplyContentRef.current?.scrollHeight || 0);
    updateHeight();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(updateHeight);
    observer.observe(floatingReplyContentRef.current);
    return () => observer.disconnect();
  }, [floatingReplyText, isFloatingReplyExpanded, isFloatingReplyCollapsing]);

  const setFloatingReplyStickyState = React.useCallback((nextSticky: boolean) => {
    floatingReplyStickyRef.current = nextSticky;
    setIsFloatingReplyStickyToBottom(nextSticky);
  }, []);

  const scrollFloatingReplyToBottom = React.useCallback(
    (behavior: ScrollBehavior = "smooth") => {
      const element = floatingReplyScrollRef.current;
      if (!element) return;
      const targetTop = Math.max(0, element.scrollHeight - element.clientHeight);
      floatingReplyDetachedRef.current = false;
      setFloatingReplyStickyState(true);
      if (behavior === "smooth") {
        element.scrollTo({ top: targetTop, behavior });
        return;
      }
      element.scrollTop = targetTop;
    },
    [setFloatingReplyStickyState],
  );

  const restoreFloatingReplyScrollSnapshot = React.useCallback(() => {
    const element = floatingReplyScrollRef.current;
    if (!element) return;
    const maxTop = Math.max(0, element.scrollHeight - element.clientHeight);
    element.scrollTop = Math.min(maxTop, floatingReplyScrollSnapshotRef.current);
    floatingReplyLastScrollTopRef.current = element.scrollTop;
  }, []);

  const handleFloatingReplyScroll = React.useCallback(() => {
    const element = floatingReplyScrollRef.current;
    if (!element) return;
    floatingReplyScrollSnapshotRef.current = element.scrollTop;
    const distanceToBottom = element.scrollHeight - element.scrollTop - element.clientHeight;
    const isScrollingUp = element.scrollTop < floatingReplyLastScrollTopRef.current - 1;
    floatingReplyLastScrollTopRef.current = element.scrollTop;

    if (isScrollingUp) {
      floatingReplyDetachedRef.current = true;
      setFloatingReplyStickyState(false);
      return;
    }

    if (floatingReplyDetachedRef.current) {
      const isBackAtBottom = distanceToBottom <= FLOATING_REPLY_STICKY_BOTTOM_DISTANCE;
      if (isBackAtBottom) {
        floatingReplyDetachedRef.current = false;
      }
      setFloatingReplyStickyState(isBackAtBottom);
      return;
    }

    if (distanceToBottom <= FLOATING_REPLY_STICKY_BOTTOM_DISTANCE) {
      setFloatingReplyStickyState(true);
    }
  }, [setFloatingReplyStickyState]);

  const handleFloatingReplyWheel = React.useCallback(
    (event: React.WheelEvent<HTMLDivElement>) => {
      if (event.deltaY < -1) {
        floatingReplyDetachedRef.current = true;
        setFloatingReplyStickyState(false);
      }
    },
    [setFloatingReplyStickyState],
  );

  React.useLayoutEffect(() => {
    if (!shouldShowGeneratingFloatingOutput) return;
    shouldExpandLatestReplyAfterStreamingRef.current = true;
    if (!floatingReplyScrollRef.current) return;
    if (!floatingReplyStickyRef.current) return;
    window.requestAnimationFrame(() => {
      scrollFloatingReplyToBottom("auto");
      window.requestAnimationFrame(() => scrollFloatingReplyToBottom("auto"));
    });
  }, [floatingReplyText, shouldShowGeneratingFloatingOutput, scrollFloatingReplyToBottom]);

  React.useEffect(() => {
    if (isGenerating) return;
    if (!shouldExpandLatestReplyAfterStreamingRef.current) return;
    shouldExpandLatestReplyAfterStreamingRef.current = false;
    if (!isFloatingInputOpen) return;
    setIsFloatingReplyCollapsing(false);
    setIsFloatingReplyExpanded(true);
    window.requestAnimationFrame(restoreFloatingReplyScrollSnapshot);
  }, [isFloatingInputOpen, isGenerating, restoreFloatingReplyScrollSnapshot]);

  React.useLayoutEffect(() => {
    if (!shouldShowFloatingInputPanel || isGenerating) return;
    if (!isFloatingReplyExpanded) return;
    window.requestAnimationFrame(restoreFloatingReplyScrollSnapshot);
  }, [isFloatingReplyExpanded, isGenerating, shouldShowFloatingInputPanel, restoreFloatingReplyScrollSnapshot]);

  React.useLayoutEffect(() => {
    if (!shouldRenderFloating || !floatingButtonRef.current) return;
    const updateWidth = () =>
      setFloatingButtonWidth(floatingButtonRef.current?.offsetWidth || FLOATING_BUTTON_SIZE_ESTIMATE);
    updateWidth();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(updateWidth);
    observer.observe(floatingButtonRef.current);
    return () => observer.disconnect();
  }, [activeTodo?.title, shouldRenderFloating, shouldShowTaskPill]);

  React.useEffect(() => {
    if (!shouldShowFloatingPanel) {
      setIsFloatingPanelEntering(false);
      return;
    }

    setIsFloatingPanelEntering(true);
    const timeoutId = window.setTimeout(() => setIsFloatingPanelEntering(false), 190);
    return () => window.clearTimeout(timeoutId);
  }, [shouldShowFloatingPanel]);

  const getFloatingButtonCollisionRect = React.useCallback((): FloatingButtonCollisionRect | null => {
    const buttonWidth = floatingButtonRef.current?.offsetWidth || FLOATING_BUTTON_SIZE_ESTIMATE;
    const controlWidth = getFloatingControlWidth(buttonWidth);
    const floatingPosition = resolveFloatingPosition(floatingPositionRef.current, controlWidth);
    return {
      left: floatingPosition.translateX + controlWidth / 2 - buttonWidth / 2,
      right: floatingPosition.translateX + controlWidth / 2 + buttonWidth / 2,
      top: floatingPosition.translateY,
      bottom: floatingPosition.translateY + FLOATING_BUTTON_HEIGHT,
      width: buttonWidth,
    };
  }, []);

  const updateFloatingPlacement = React.useCallback(
    (buttonCollisionRect?: FloatingButtonCollisionRect) => {
      const buttonRect = buttonCollisionRect || getFloatingButtonCollisionRect();
      if (!buttonRect) return;
      const panelElement = floatingPanelRef.current;
      const panelHeight = panelElement?.offsetHeight || FLOATING_PANEL_HEIGHT_ESTIMATE;
      const minLeft = WINDOW_MARGIN;
      const maxRight = window.innerWidth - WINDOW_MARGIN;
      const availableWidth = Math.max(0, maxRight - minLeft);
      const effectivePanelWidth = Math.min(FLOATING_PANEL_MAX_WIDTH, availableWidth);
      const centeredLeft = buttonRect.left + buttonRect.width / 2 - effectivePanelWidth / 2;
      const panelLeftByRightEdge = buttonRect.right - effectivePanelWidth;
      let nextAlignment: FloatingPanelAlignment = "center";

      if (centeredLeft < minLeft) {
        nextAlignment = "left";
      } else if (centeredLeft + effectivePanelWidth > maxRight && panelLeftByRightEdge >= minLeft) {
        nextAlignment = "right";
      } else if (centeredLeft + effectivePanelWidth > maxRight) {
        nextAlignment = "left";
      }

      setFloatingPanelWidth(effectivePanelWidth);
      setFloatingPanelAlignment(nextAlignment);
      setFloatingPlacement(buttonRect.top >= panelHeight + WINDOW_MARGIN ? "above" : "below");
    },
    [getFloatingButtonCollisionRect],
  );

  const toggleFloatingInput = React.useCallback(() => {
    if (pendingUserQuestion) {
      window.requestAnimationFrame(() => updateFloatingPlacement());
      return;
    }
    setFloatingPanelWidth(null);
    setFloatingPanelAlignment("center");
    setIsFloatingInputOpen((previous) => !previous);
    setIsFloatingReplyExpanded(false);
    if (isGenerating) {
      floatingReplyDetachedRef.current = false;
      setFloatingReplyStickyState(true);
      window.requestAnimationFrame(() => scrollFloatingReplyToBottom("auto"));
    }
    window.requestAnimationFrame(() => updateFloatingPlacement());
  }, [
    isGenerating,
    pendingUserQuestion,
    scrollFloatingReplyToBottom,
    setFloatingReplyStickyState,
    updateFloatingPlacement,
  ]);

  const handleFloatingButtonClick = React.useCallback(() => {
    if (!isMinimized) return;
    if (floatingDragStateRef.current.didDrag) return;
    toggleFloatingInput();
  }, [isMinimized, toggleFloatingInput]);

  React.useEffect(() => {
    if (!shouldShowFloatingPanel) return;
    updateFloatingPlacement();
    const handleResize = () => updateFloatingPlacement();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [shouldShowFloatingPanel, updateFloatingPlacement]);

  React.useEffect(() => {
    if (
      !shouldShowFloatingPanel ||
      !floatingPanelRef.current ||
      !floatingButtonRef.current ||
      typeof ResizeObserver === "undefined"
    ) {
      return;
    }

    const observer = new ResizeObserver(() => updateFloatingPlacement());
    observer.observe(floatingPanelRef.current);
    observer.observe(floatingButtonRef.current);
    return () => observer.disconnect();
  }, [shouldShowFloatingPanel, updateFloatingPlacement]);

  React.useEffect(() => {
    if (!shouldShowFloatingPanel) return;
    window.requestAnimationFrame(() => updateFloatingPlacement());
    const timeoutId = window.setTimeout(updateFloatingPlacement, 0);
    return () => window.clearTimeout(timeoutId);
  }, [
    floatingReplyText,
    isFloatingReplyExpanded,
    shouldShowFloatingPanel,
    shouldShowGeneratingFloatingBullet,
    updateFloatingPlacement,
  ]);

  React.useEffect(() => {
    if (!isGenerating) {
      didAutoOpenFinalReplyRef.current = false;
      return;
    }
    if (didAutoOpenFinalReplyRef.current) return;
    if (!isMinimized || !hasFinalReplyStarted || pendingUserQuestion) return;
    didAutoOpenFinalReplyRef.current = true;
    floatingReplyDetachedRef.current = false;
    setFloatingReplyStickyState(true);
    if (isFloatingInputOpen) return;
    setFloatingPanelWidth(null);
    setFloatingPanelAlignment("center");
    setIsFloatingInputOpen(true);
    setIsFloatingReplyExpanded(false);
    window.requestAnimationFrame(() => {
      scrollFloatingReplyToBottom("auto");
      updateFloatingPlacement();
      window.requestAnimationFrame(() => scrollFloatingReplyToBottom("auto"));
    });
  }, [
    hasFinalReplyStarted,
    isFloatingInputOpen,
    isGenerating,
    isMinimized,
    pendingUserQuestion,
    scrollFloatingReplyToBottom,
    setFloatingReplyStickyState,
    updateFloatingPlacement,
  ]);

  React.useEffect(() => {
    if (!isMinimized) return;
    const handleResize = () => {
      handleFloatingPositionChange(
        floatingPositionRef.current,
        floatingButtonRef.current?.offsetWidth || FLOATING_BUTTON_SIZE_ESTIMATE,
      );
      updateFloatingPlacement();
    };

    handleResize();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [handleFloatingPositionChange, isMinimized, updateFloatingPlacement]);

  React.useEffect(() => {
    if (!isMinimized || !isFloatingInputOpen || isSelecting || pendingUserQuestion) return;

    const handlePointerDown = (event: MouseEvent) => {
      if (floatingRootRef.current?.contains(event.target as Node)) return;
      setIsFloatingInputOpen(false);
    };

    window.addEventListener("mousedown", handlePointerDown);
    return () => window.removeEventListener("mousedown", handlePointerDown);
  }, [isFloatingInputOpen, isMinimized, isSelecting, pendingUserQuestion]);

  const startWindowDrag = React.useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!isPrimaryPointerActivation(event)) return;
      const target = event.target as HTMLElement;
      if (target.closest("button, input, textarea, select, a, [data-no-window-drag]")) return;
      event.preventDefault();
      const startX = event.clientX;
      const startY = event.clientY;
      const startRect = containerInfoRef.current;
      const pointerId = event.pointerId;
      event.currentTarget.setPointerCapture(pointerId);

      const handlePointerMove = (moveEvent: PointerEvent) => {
        moveEvent.preventDefault();
        handleWindowRectChange({
          ...startRect,
          translateX: startRect.translateX + moveEvent.clientX - startX,
          translateY: startRect.translateY + moveEvent.clientY - startY,
        });
      };

      const handlePointerUp = () => {
        window.removeEventListener("pointermove", handlePointerMove);
        window.removeEventListener("pointerup", handlePointerUp);
        window.removeEventListener("pointercancel", handlePointerUp);
      };

      window.addEventListener("pointermove", handlePointerMove);
      window.addEventListener("pointerup", handlePointerUp);
      window.addEventListener("pointercancel", handlePointerUp);
    },
    [handleWindowRectChange],
  );

  const startWindowResize = React.useCallback(
    (event: React.PointerEvent<HTMLButtonElement>, direction: ResizeDirection) => {
      if (!isPrimaryPointerActivation(event)) return;
      event.preventDefault();
      event.stopPropagation();
      const startX = event.clientX;
      const startY = event.clientY;
      const startRect = containerInfoRef.current;
      const startWindowMetrics = assistantWindowMetrics;
      const pointerId = event.pointerId;
      event.currentTarget.setPointerCapture(pointerId);

      const handlePointerMove = (moveEvent: PointerEvent) => {
        moveEvent.preventDefault();
        const deltaX = moveEvent.clientX - startX;
        const deltaY = moveEvent.clientY - startY;
        const resizesWest = direction.includes("w");
        const resizesEast = direction.includes("e");
        const resizesNorth = direction.includes("n");
        const resizesSouth = direction.includes("s");
        const nextWidth = resizesWest
          ? Math.max(MIN_WINDOW_WIDTH, startRect.width - deltaX)
          : resizesEast
            ? Math.max(MIN_WINDOW_WIDTH, startRect.width + deltaX)
            : startRect.width;
        const nextHeight = resizesNorth
          ? Math.max(MIN_WINDOW_HEIGHT, startRect.height - deltaY)
          : resizesSouth
            ? Math.max(MIN_WINDOW_HEIGHT, startRect.height + deltaY)
            : startRect.height;
        const nextMetrics = resolveAssistantWindowMetrics(
          {
            ...startRect,
            width: nextWidth,
            height: nextHeight,
          },
          viewportSize,
        );
        const startVisualRight = startWindowMetrics.translateX + startWindowMetrics.visualWidth;
        const startVisualBottom = startWindowMetrics.translateY + startWindowMetrics.visualHeight;

        handleWindowRectChange({
          ...startRect,
          width: nextWidth,
          height: nextHeight,
          translateX: resizesWest ? startVisualRight - nextMetrics.visualWidth : startRect.translateX,
          translateY: resizesNorth ? startVisualBottom - nextMetrics.visualHeight : startRect.translateY,
        });
      };

      const handlePointerUp = () => {
        window.removeEventListener("pointermove", handlePointerMove);
        window.removeEventListener("pointerup", handlePointerUp);
        window.removeEventListener("pointercancel", handlePointerUp);
      };

      window.addEventListener("pointermove", handlePointerMove);
      window.addEventListener("pointerup", handlePointerUp);
      window.addEventListener("pointercancel", handlePointerUp);
    },
    [assistantWindowMetrics, handleWindowRectChange, viewportSize],
  );

  const startFloatingDrag = React.useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      if (!isPrimaryPointerActivation(event)) return;
      event.preventDefault();
      const startX = event.clientX;
      const startY = event.clientY;
      const buttonWidth = floatingButtonRef.current?.offsetWidth || FLOATING_BUTTON_SIZE_ESTIMATE;
      const controlWidth = getFloatingControlWidth(buttonWidth);
      const startPosition = resolveFloatingPosition(floatingPositionRef.current, controlWidth);
      const pointerId = event.pointerId;
      floatingDragStateRef.current.didDrag = false;
      event.currentTarget.setPointerCapture(pointerId);

      const handlePointerMove = (moveEvent: PointerEvent) => {
        moveEvent.preventDefault();
        const deltaX = moveEvent.clientX - startX;
        const deltaY = moveEvent.clientY - startY;
        if (Math.abs(deltaX) > 3 || Math.abs(deltaY) > 3) {
          floatingDragStateRef.current.didDrag = true;
        }
        const nextPosition = constrainFloatingPosition(
          {
            translateX: startPosition.translateX + deltaX,
            translateY: startPosition.translateY + deltaY,
          },
          controlWidth,
        );
        handleFloatingPositionChange(nextPosition, buttonWidth);
        updateFloatingPlacement({
          left: nextPosition.translateX + controlWidth / 2 - buttonWidth / 2,
          right: nextPosition.translateX + controlWidth / 2 + buttonWidth / 2,
          top: nextPosition.translateY,
          bottom: nextPosition.translateY + FLOATING_BUTTON_HEIGHT,
          width: buttonWidth,
        });
      };

      const handlePointerUp = () => {
        window.removeEventListener("pointermove", handlePointerMove);
        window.removeEventListener("pointerup", handlePointerUp);
        window.removeEventListener("pointercancel", handlePointerUp);
        window.setTimeout(() => {
          floatingDragStateRef.current.didDrag = false;
        }, 0);
      };

      window.addEventListener("pointermove", handlePointerMove);
      window.addEventListener("pointerup", handlePointerUp);
      window.addEventListener("pointercancel", handlePointerUp);
    },
    [handleFloatingPositionChange, updateFloatingPlacement],
  );

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
        content?: string;
        referenceText?: string;
        error?: string;
        targetId?: string;
        blockId?: string;
        name?: string;
      }>;
      if (customEvent.detail?.error) {
        void showAssistantAlert(customEvent.detail.error);
        return;
      }
      if (customEvent.detail?.referenceText) {
        insertInlineTextReference(customEvent.detail.referenceText);
        handleShow();
        return;
      }
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
        insertInlineAttachment(attachment);
        handleShow();
      }
    };

    window.addEventListener("ai-assistant-add-context", handleAddContext);

    return () => {
      contextMenuRegistration.dispose();
      window.removeEventListener("ai-assistant-add-context", handleAddContext);
    };
  }, [vm, handleShow, insertInlineAttachment, insertInlineTextReference]);

  const renderProjectIndexBanner = () => {
    const blocked = Boolean(projectIndexStatus?.blocked);
    const running = Boolean(projectIndexBuild?.running);
    const error = projectIndexBuild?.error;
    const hasExportText = Boolean(projectIndexBuild?.exportText);
    if (!blocked && !running && !error && !hasExportText) return null;
    const totalScriptCount = Number(projectIndexStatus?.totalScriptCount || 0);
    const mappedScriptCount = Number(projectIndexStatus?.mappedScriptCount || 0);
    const isIncrementalIndexUpdate = blocked && mappedScriptCount > 0 && mappedScriptCount < totalScriptCount;
    const progress = Math.max(0, Math.min(100, Number(projectIndexBuild?.progress || 0)));
    const phase = projectIndexBuild?.phase || (blocked ? (isIncrementalIndexUpdate ? "需要更新项目索引" : "需要先构建项目索引") : "项目索引");
    const detailText =
      error ||
      (projectIndexBuild?.largeProject && (running || blocked)
        ? "当前作品较大，等待时间较长，去喝杯咖啡吧~"
        : blocked
          ? isIncrementalIndexUpdate
            ? "检测到新增脚本，需要增量更新索引。已有功能文件分组会保留，只整理新增脚本。"
            : "首次编辑前需要把当前 Scratch 脚本整理成功能文件。构建完成前 AI 不能读取或修改虚拟文件、脚本和造型。"
          : "索引已准备就绪。");
    return (
      <div className={shell.projectIndexBanner} data-no-window-drag="true">
        <div
          className={shell.projectIndexProgress}
          style={{ "--project-index-progress": `${progress}%` } as React.CSSProperties}
          aria-label={`项目索引构建进度 ${Math.round(progress)}%`}
        >
          <span>{running ? `${Math.round(progress)}%` : blocked ? "!" : "✓"}</span>
        </div>
        <div className={shell.projectIndexText}>
          <strong>{phase}</strong>
          <span>{detailText}</span>
        </div>
        <div className={shell.projectIndexActions}>
          {hasExportText ? (
            <button type="button" className={shell.secondaryButton} onClick={() => void handleExportProjectIndexBuild()}>
              导出记录
            </button>
          ) : null}
          <button
            type="button"
            className={shell.primaryButton}
            onClick={() => (running ? handleStopProjectIndex() : void handleBuildProjectIndex())}
          >
            {running ? "停止构建" : error ? "重试构建" : isIncrementalIndexUpdate ? "更新项目索引" : "构建项目索引"}
          </button>
        </div>
      </div>
    );
  };

  const renderInputArea = (variant: "dock" | "floating" = "dock", autoFocus = false) => {
    const hideInputHint =
      variant === "dock" ? assistantWindowMetrics.visualWidth < 314 : (floatingPanelWidth || viewportSize.width) < 314;

    return (
      <InputArea
        inputText={inputText}
        setInputText={setInputText}
        subAgents={subAgents}
        guides={allGuides}
        messages={messages}
        attachments={attachments}
        setAttachments={setAttachments}
        onSend={handleSend}
        onStopGenerating={handleStopGenerating}
        queuedUserMessages={queuedUserMessages}
        onStartBlockSelection={handleStartBlockSelection}
        onCancelBlockSelection={cancelSelecting}
        isSelectingBlocks={isSelecting}
        enableReasoning={enableReasoning}
        reasoningEffort={reasoningEffort}
        onToggleReasoning={() => setEnableReasoning((previous) => !previous)}
        onSelectReasoningEffort={(effort) => {
          setReasoningEffort(effort);
          setEnableReasoning(true);
        }}
        onOpenAttachment={handleOpenAttachment}
        onPreviewAttachment={setPreviewAttachment}
        onInlineAttachmentAdded={handleInlineAttachmentAdded}
        isGenerating={isGenerating}
        pendingUserQuestion={pendingUserQuestion}
        onAnswerUserQuestion={answerUserQuestion}
        onGoBackUserQuestion={goBackUserQuestion}
        isExpanded={variant === "dock" && isComposerExpanded}
        onToggleExpanded={() => setIsComposerExpanded((previous) => !previous)}
        vm={vm}
        workspace={workspace}
        blockly={blockly}
        variant={variant}
        autoFocus={autoFocus}
        hideInputHint={hideInputHint}
        conversationMode={conversationMode}
      />
    );
  };

  const renderFloatingReplyPreview = (mode: "latest" | "streaming") => {
    const isStreaming = mode === "streaming";
    const displayReplyText = floatingReplyText || (isStreaming ? "AI 正在回复..." : "");
    if (!displayReplyText) return null;
    const canExpand = displayReplyText.includes("\n") || displayReplyText.length > 80;
    const isExpanded = isStreaming || (canExpand && isFloatingReplyExpanded);
    const shouldKeepExpandedLayout = isExpanded || isFloatingReplyCollapsing;
    const collapsedText = displayReplyText.replace(/\s+/g, " ").trim();
    const useExpandedLayout = shouldKeepExpandedLayout;
    const replyClassName = `${styles.assistantFloatingReply} ${isStreaming ? styles.assistantFloatingReplyStreaming : ""} ${
      useExpandedLayout ? styles.assistantFloatingReplyExpandedState : ""
    } ${isFloatingReplyCollapsing ? styles.assistantFloatingReplyCollapsingState : ""}`;
    const replyTextClassName = `${styles.assistantFloatingReplyText} ${
      shouldKeepExpandedLayout ? styles.assistantFloatingReplyTextExpanded : styles.assistantFloatingReplyTextCollapsed
    }`;
    const replyContentMaxHeight = Math.min(
      Math.max(floatingReplyContentHeight, 0),
      Math.floor(window.innerHeight * 0.34),
      260,
    );

    const toggleFloatingReply = () => {
      if (isExpanded) {
        setFloatingReplyContentHeight(floatingReplyContentRef.current?.scrollHeight || floatingReplyContentHeight);
        window.requestAnimationFrame(() => setIsFloatingReplyCollapsing(true));
        setIsFloatingReplyExpanded(false);
        return;
      }
      setIsFloatingReplyCollapsing(false);
      setIsFloatingReplyExpanded(true);
      window.requestAnimationFrame(restoreFloatingReplyScrollSnapshot);
    };

    return (
      <div className={replyClassName}>
        <div className={styles.assistantFloatingReplyLine}>
          <span className={styles.assistantFloatingReplyLabel}>{isStreaming ? "AI 正在回复" : "AI 最新回复"}</span>
          {!isStreaming ? <span className={styles.assistantFloatingReplyPreviewText}>{collapsedText}</span> : null}
          {!isStreaming && canExpand ? (
            <button
              type="button"
              className={styles.assistantFloatingReplyToggle}
              onClick={toggleFloatingReply}
              aria-label={isExpanded ? "收起 AI 最新回复" : "展开 AI 最新回复"}
              aria-expanded={isExpanded}
            >
              <ChevronRightIcon />
            </button>
          ) : null}
        </div>
        <div
          className={replyTextClassName}
          ref={floatingReplyScrollRef}
          style={{ "--assistant-floating-reply-height": `${replyContentMaxHeight}px` } as React.CSSProperties}
          aria-hidden={!shouldKeepExpandedLayout}
          onScroll={handleFloatingReplyScroll}
          onWheel={handleFloatingReplyWheel}
          onTransitionEnd={(event) => {
            if (event.currentTarget !== event.target || event.propertyName !== "max-height") return;
            if (isFloatingReplyCollapsing) setIsFloatingReplyCollapsing(false);
          }}
        >
          <div className={styles.assistantFloatingReplyTextInner} ref={floatingReplyContentRef}>
            <AssistantMarkdown
              content={displayReplyText}
              isStreaming={isStreaming}
              subAgents={subAgents}
              streamKey={isStreaming ? currentAssistantFinalReplyStreamKey || "floating-streaming-reply" : undefined}
              resumeFromTailOnMount
              vm={vm}
              blockly={blockly}
              workspace={workspace}
              onRequestOpenUrl={handleRequestOpenUrl}
            />
          </div>
        </div>
        {shouldKeepExpandedLayout && !isFloatingReplyStickyToBottom ? (
          <button
            type="button"
            className={styles.assistantFloatingReplyScrollToBottom}
            onClick={() => scrollFloatingReplyToBottom()}
            aria-label="回到 AI 回复底部"
            title="回到底部"
          >
            ↓
          </button>
        ) : null}
      </div>
    );
  };

  const renderFloatingGeneratingBullet = () => (
    <div className={styles.assistantFloatingGeneratingBullet} role="status" aria-live="polite">
      <span className={styles.assistantFloatingGeneratingBulletSpinner} />
      <span className={styles.assistantFloatingGeneratingBulletText}>AI 正在执行</span>
    </div>
  );

  const assistantThemeClass = `${themeStyles.themeRoot} ${
    resolvedThemeMode === "dark" ? themeStyles.themeDark : themeStyles.themeLight
  }`;
  const resolvedFloatingPosition = resolveFloatingPosition(
    floatingPosition,
    getFloatingControlWidth(floatingButtonRef.current?.offsetWidth || FLOATING_BUTTON_SIZE_ESTIMATE),
  );
  const assistantWindowClassName = `${styles.assistantWindow} ${
    assistantTransition === "minimizing"
      ? styles.assistantWindowMinimizing
      : assistantTransition === "restoring"
        ? styles.assistantWindowRestoring
        : ""
  } ${isWindowRelocating ? styles.assistantWindowRelocating : ""}`;
  const assistantFloatingClassName = `${styles.assistantFloatingRoot} ${
    assistantTransition === "minimizing"
      ? styles.assistantFloatingRootEntering
      : assistantTransition === "restoring"
        ? styles.assistantFloatingRootExiting
        : ""
  }`;
  const floatingPanelAlignmentClassName =
    floatingPanelAlignment === "left"
      ? styles.assistantFloatingPanelLeft
      : floatingPanelAlignment === "right"
        ? styles.assistantFloatingPanelRight
        : styles.assistantFloatingPanelCenter;
  const assistantContent = (
    <div className={`${styles.container} ${shell.appShell}`}>
      {!useDrawerHistory && isLeftPanelOpen && (
        <HistoryPanel
          sessions={sessions}
          currentSessionId={currentSessionId}
          currentProjectId={currentProjectId}
          currentProjectName={currentProjectTitle}
          onNewChat={handleNewChat}
          onSelectSession={handleHistorySelectSession}
          onDeleteSession={handleDeleteSession}
          onRenameSession={handleRenameSession}
          onDeleteProject={handleDeleteProject}
          onDeleteProjects={handleDeleteProjects}
        />
      )}

      <div className={shell.mainPanel}>
        <div className={shell.topBar} data-no-window-drag="true">
          <div className={shell.topBarMain}>
            <div className={shell.topBarLeft}>
              <button
                type="button"
                className={shell.iconButton}
                onClick={() => setIsLeftPanelOpen((previous) => !previous)}
                title={isLeftPanelOpen ? "收起历史记录" : "展开历史记录"}
              >
                {useDrawerHistory ? "☰" : isLeftPanelOpen ? "←" : "☰"}
              </button>
              <button
                type="button"
                className={shell.conversationModeSwitch}
                data-mode={conversationMode}
                role="switch"
                aria-checked={conversationMode === "code"}
                aria-label={`当前模式：${conversationMode === "code" ? "Code" : "Chat"}`}
                title={conversationMode === "code" ? "Code 模式：编写代码、修改脚本和处理工作区内容" : "Chat 模式：讨论想法、梳理计划和分析上下文"}
                onClick={() => setConversationMode((previous) => (previous === "code" ? "chat" : "code"))}
              >
                <span className={`${shell.conversationModeLabel} ${shell.conversationModeLabelChat}`}>Chat</span>
                <span className={`${shell.conversationModeLabel} ${shell.conversationModeLabelCode}`}>Code</span>
                <span className={shell.conversationModeThumb} aria-hidden="true">
                  <span className={`${shell.conversationModeIcon} ${shell.conversationModeIconChat}`}>
                    <svg viewBox="0 0 20 20" focusable="false">
                      <path d="M4.2 5.2h11.6c.8 0 1.5.7 1.5 1.5v6.2c0 .8-.7 1.5-1.5 1.5H9.1l-3.2 2.2c-.5.3-1.1 0-1.1-.6v-1.6h-.6c-.8 0-1.5-.7-1.5-1.5V6.7c0-.8.7-1.5 1.5-1.5Z" />
                      <path d="M6.2 8.5h7.6M6.2 11.2h4.9" />
                    </svg>
                  </span>
                  <span className={`${shell.conversationModeIcon} ${shell.conversationModeIconCode}`}>
                    <svg viewBox="0 0 20 20" focusable="false">
                      <path d="m7.4 6.4-3.2 3.5 3.2 3.6M12.6 6.4l3.2 3.5-3.2 3.6" />
                      <path d="m11 5.4-2 9.2" />
                    </svg>
                  </span>
                </span>
              </button>
            </div>
            <div className={shell.topBarCenter}>
              <div className={shell.modelSelector} ref={agentMenuRef}>
                <button
                  type="button"
                  className={`${shell.modelSelectorTrigger} ${isAgentMenuOpen ? shell.modelSelectorTriggerActive : ""}`}
                  onClick={() => setIsAgentMenuOpen((open) => !open)}
                  aria-haspopup="listbox"
                  aria-expanded={isAgentMenuOpen}
                  title={currentAgent?.displayName || "选择模型"}
                >
                  <span className={shell.modelSelectorText}>{currentAgent?.displayName || "未选择模型"}</span>
                  <span
                    className={`${shell.modelSelectorChevron} ${isAgentMenuOpen ? shell.modelSelectorChevronOpen : ""}`}
                  >
                    <ChevronRightIcon aria-hidden="true" />
                  </span>
                </button>
                {isAgentMenuOpen ? (
                  <div className={shell.modelMenu} role="listbox" aria-label="选择模型">
                    {flattenedModels.map((model) => (
                      <button
                        key={model.id}
                        type="button"
                        className={`${shell.modelMenuItem} ${model.id === currentAgent?.id ? shell.modelMenuItemActive : ""}`}
                        onClick={() => {
                          setCurrentModelId(model.id);
                          setIsAgentMenuOpen(false);
                        }}
                        role="option"
                        aria-selected={model.id === currentAgent?.id}
                        title={`${model.displayName} (${model.modelName})`}
                      >
                        <span>{model.displayName}</span>
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            </div>
          </div>
          <div className={shell.topBarActions}>
            <button
              type="button"
              className={shell.secondaryButton}
              onClick={() => void handleExportConversation()}
              title="复制精简会话文本，包含工具调用参数和返回结果"
            >
              导出会话
            </button>
            <button type="button" className={shell.secondaryButton} onClick={() => setShowSettings(true)}>
              设置
            </button>
          </div>
        </div>

        {renderProjectIndexBanner()}

        <ChatArea
          messages={messages}
          isGenerating={isGenerating}
          conversationMode={conversationMode}
          examplePrompts={examplePrompts}
          vm={vm}
          blockly={blockly}
          workspace={workspace}
          subAgents={subAgents}
          guides={allGuides}
          onOpenWorkspaceAttachment={handleOpenAttachment}
          onPreviewAttachment={setPreviewAttachment}
          onRestoreToUserMessage={handleRestoreToUserMessage}
          hasSnapshot={hasSnapshot}
          contextUsage={contextUsage}
          onRetryLastResponse={handleRetryLastResponse}
          onCompressContext={handleCompressContext}
          isCompressingContext={isCompressingContext}
          onUseExamplePrompt={handleUseExamplePrompt}
          onRequestOpenUrl={handleRequestOpenUrl}
        />

        <SelectionHint visible={isSelecting} />
        {renderInputArea("dock")}

        {useDrawerHistory && isLeftPanelOpen && (
          <div className={shell.drawerOverlay} onClick={() => setIsLeftPanelOpen(false)}>
            <div className={shell.historyDrawer} onClick={(e) => e.stopPropagation()}>
              <HistoryPanel
                sessions={sessions}
                currentSessionId={currentSessionId}
                currentProjectId={currentProjectId}
                currentProjectName={currentProjectTitle}
                onNewChat={handleNewChat}
                onSelectSession={handleHistorySelectSession}
                onDeleteSession={handleDeleteSession}
                onRenameSession={handleRenameSession}
                onDeleteProject={handleDeleteProject}
                onDeleteProjects={handleDeleteProjects}
              />
            </div>
          </div>
        )}
      </div>

      {pendingSessionSwitch ? (
        <div className={shell.sessionSwitchOverlay} data-no-window-drag="true">
          <div className={shell.sessionSwitchDialog} role="dialog" aria-modal="true">
            <div className={shell.sessionSwitchMessage}>目标会话不存在于当前项目，确认切换？</div>
            <div className={shell.sessionSwitchActions}>
              <button type="button" className={shell.secondaryButton} onClick={() => setPendingSessionSwitch(null)}>
                取消
              </button>
              <button type="button" className={shell.secondaryButton} onClick={handleConfirmSessionSwitch}>
                确认切换
              </button>
              <button type="button" className={shell.primaryButton} onClick={handleJumpToSessionProject}>
                切换项目
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {showSettings && (
        <SettingsModal
          agents={agents}
          editingAgent={editingAgent}
          onSaveAgent={handleSaveAgent}
          onDeleteAgent={handleDeleteAgent}
          onExportAgent={handleExportAgent}
          onImportAgent={handleImportAgents}
          onEditAgent={setEditingAgent}
          imageModelId={imageModelId}
          onImageModelIdChange={setImageModelId}
          subAgents={subAgents}
          editingSubAgent={editingSubAgent}
          onCreateSubAgent={createEmptySubAgent}
          onEditSubAgent={setEditingSubAgent}
          onSaveSubAgent={handleSaveSubAgent}
          onDeleteSubAgent={handleDeleteSubAgent}
          allowSubAgents={allowSubAgents}
          onAllowSubAgentsChange={setAllowSubAgents}
          defaultCostumeType={defaultCostumeType}
          onDefaultCostumeTypeChange={setDefaultCostumeType}
          aiGuideVerificationMode={aiGuideVerificationMode}
          onAiGuideVerificationModeChange={setAiGuideVerificationMode}
          stageScreenshotMode={stageScreenshotMode}
          onStageScreenshotModeChange={setStageScreenshotMode}
          userGuides={userGuides}
          extensionGuides={extensionGuides}
          onSaveGuide={saveGuide}
          onDeleteGuide={deleteGuide}
          onToggleGuide={toggleGuide}
          onImportGuide={importGuide}
          vm={vm}
          themeMode={themeMode}
          onThemeModeChange={setThemeMode}
          onClose={() => {
            setShowSettings(false);
            setEditingAgent(null);
            setEditingSubAgent(null);
          }}
          isCompact={assistantWindowMetrics.visualWidth < 760 || assistantWindowMetrics.visualHeight < 560}
        />
      )}
    </div>
  );

  if (!pluginsWrapper) {
    console.warn("[AI Assistant] No portal target found (.plugins-wrapper or #gandi-plugins-wrapper)");
  }

  return ReactDOM.createPortal(
    <>
      <AssistantDialogHost />
      <section className={styles.aiAssistantRoot} ref={containerRef}>
        <Tooltip className={styles.icon} icon={<AIAssistantIcon />} onClick={handleShow} tipText={"AI Assistant"} />
      </section>
      {visible &&
        ReactDOM.createPortal(
          <div className={`${styles.aiAssistantOverlayRoot} ${assistantThemeClass}`} data-ai-assistant-ui-root="true">
            {shouldRenderWindow ? (
              <div
                ref={windowRef}
                className={assistantWindowClassName}
                style={
                  {
                    width: assistantWindowMetrics.visualWidth,
                    height: assistantWindowMetrics.visualHeight,
                    "--assistant-window-x": `${assistantWindowMetrics.translateX}px`,
                    "--assistant-window-y": `${assistantWindowMetrics.translateY}px`,
                    "--assistant-window-width": `${assistantWindowMetrics.visualWidth}px`,
                    "--assistant-window-height": `${assistantWindowMetrics.visualHeight}px`,
                    "--assistant-window-content-width": `${assistantWindowMetrics.contentWidth}px`,
                    "--assistant-window-content-height": `${assistantWindowMetrics.contentHeight}px`,
                    "--assistant-window-scale": assistantWindowMetrics.scale,
                    "--assistant-morph-target-x": `${assistantMorphTarget.targetX}px`,
                    "--assistant-morph-target-y": `${assistantMorphTarget.targetY}px`,
                    "--assistant-morph-target-width": `${assistantMorphTarget.targetWidth}px`,
                    "--assistant-morph-target-height": `${assistantMorphTarget.targetHeight}px`,
                    transform: `translate(${assistantWindowMetrics.translateX}px, ${assistantWindowMetrics.translateY}px)`,
                  } as React.CSSProperties
                }
              >
                <div className={styles.assistantWindowSurface}>
                  <div className={styles.assistantWindowContent}>
                    <div className={styles.assistantWindowChrome} onPointerDown={startWindowDrag}>
                      <div className={styles.assistantWindowTitle}>
                        <span className={styles.assistantWindowMark}>AI</span>
                        <span>AI Assistant</span>
                      </div>
                      <div className={styles.assistantWindowActions} data-no-window-drag="true">
                        <button type="button" onClick={handleMinimize} aria-label="缩小 AI Assistant" title="缩小">
                          −
                        </button>
                        <button type="button" onClick={handleClose} aria-label="关闭 AI Assistant" title="关闭">
                          ×
                        </button>
                      </div>
                    </div>
                    <div className={styles.assistantWindowBody}>{assistantContent}</div>
                  </div>
                </div>
                {RESIZE_DIRECTIONS.map((direction) => (
                  <button
                    key={direction}
                    type="button"
                    className={`${styles.assistantResizeHandle} ${getResizeHandleClassName(direction)}`}
                    onPointerDown={(event) => startWindowResize(event, direction)}
                    aria-label="调整 AI Assistant 大小"
                    title="拖拽调整大小"
                  />
                ))}
              </div>
            ) : null}
            {shouldRenderFloating ? (
              <div
                ref={floatingRootRef}
                className={assistantFloatingClassName}
                style={
                  {
                    "--assistant-floating-x": `${resolvedFloatingPosition.translateX}px`,
                    "--assistant-floating-y": `${resolvedFloatingPosition.translateY}px`,
                    "--assistant-floating-button-width": `${Math.max(floatingButtonWidth, FLOATING_BUTTON_SIZE_ESTIMATE)}px`,
                    transform: `translate(${resolvedFloatingPosition.translateX}px, ${resolvedFloatingPosition.translateY}px)`,
                  } as React.CSSProperties
                }
              >
                {shouldShowFloatingPanel ? (
                  <div
                    ref={floatingPanelRef}
                    className={`${styles.assistantFloatingPanel} ${floatingPanelAlignmentClassName} ${
                      floatingPlacement === "below"
                        ? styles.assistantFloatingPanelBelow
                        : styles.assistantFloatingPanelAbove
                    } ${isFloatingPanelEntering ? styles.assistantFloatingPanelEntering : ""}`}
                    style={
                      {
                        "--assistant-floating-panel-width": floatingPanelWidth ? `${floatingPanelWidth}px` : undefined,
                      } as React.CSSProperties
                    }
                  >
                    {pendingUserQuestion ? (
                      <UserQuestionDock
                        question={pendingUserQuestion}
                        onAnswer={answerUserQuestion}
                        onGoBack={goBackUserQuestion}
                      />
                    ) : (
                      <>
                        {isGenerating
                          ? shouldShowGeneratingFloatingOutput
                            ? renderFloatingReplyPreview("streaming")
                            : renderFloatingGeneratingBullet()
                          : renderFloatingReplyPreview("latest")}
                        {renderInputArea("floating", true)}
                      </>
                    )}
                  </div>
                ) : null}
                <div className={styles.assistantFloatingControls}>
                  <button
                    ref={floatingButtonRef}
                    type="button"
                    className={`${styles.assistantFloatingButton} ${isGenerating ? styles.assistantFloatingButtonGenerating : ""} ${
                      shouldShowTaskPill ? styles.assistantFloatingButtonPill : ""
                    }`}
                    onPointerDown={startFloatingDrag}
                    onClick={handleFloatingButtonClick}
                    aria-label={isFloatingInputOpen ? "收起 AI 输入" : "打开 AI 输入"}
                    aria-expanded={shouldShowFloatingPanel}
                  >
                    <span className={styles.assistantFloatingIcon}>{isGenerating ? <span /> : <MessageIcon />}</span>
                    {shouldShowTaskPill ? (
                      <span className={styles.assistantFloatingTaskText}>{activeTodo?.title}</span>
                    ) : null}
                  </button>
                  <button
                    type="button"
                    className={styles.assistantFloatingRestoreButton}
                    onClick={handleRestoreWindow}
                    aria-label="展开完整对话"
                    title="展开完整对话"
                  >
                    ↗
                  </button>
                  <button
                    type="button"
                    className={styles.assistantFloatingCloseButton}
                    onClick={() => {
                      setIsFloatingInputOpen(false);
                      setIsFloatingReplyExpanded(false);
                    }}
                    aria-label="关闭 AI 输入浮层"
                    title="关闭"
                  >
                    ×
                  </button>
                </div>
              </div>
            ) : null}
            {pendingExternalUrl ? (
              <div className={styles.assistantGlobalConfirmOverlay} data-no-window-drag="true">
                <div className={styles.assistantGlobalConfirmDialog} role="dialog" aria-modal="true">
                  <div className={styles.assistantGlobalConfirmMessage}>AI提供的链接可能有风险，确认访问吗？</div>
                  <div className={styles.assistantGlobalConfirmUrl}>{pendingExternalUrl}</div>
                  <div className={styles.assistantGlobalConfirmActions}>
                    <button
                      type="button"
                      className={styles.assistantGlobalConfirmSecondary}
                      onClick={() => setPendingExternalUrl(null)}
                    >
                      取消
                    </button>
                    <button
                      type="button"
                      className={styles.assistantGlobalConfirmPrimary}
                      onClick={handleConfirmExternalUrl}
                    >
                      确认访问
                    </button>
                  </div>
                </div>
              </div>
            ) : null}
            {isMinimized && isSelecting ? <SelectionHint visible /> : null}
          </div>,
          document.body,
        )}
      {previewAttachment
        ? ReactDOM.createPortal(
            <div className={`${styles.aiAssistantOverlayRoot} ${assistantThemeClass}`} data-ai-assistant-ui-root="true">
              <AttachmentInteractionLayer
                previewAttachment={previewAttachment}
                onClosePreview={() => setPreviewAttachment(null)}
              />
            </div>,
            document.body,
          )
        : null}
      {shouldShowConverterDebugger() ? (
        <ConverterDebugger
          vm={vm}
          workspace={workspace}
          blockly={blockly}
          onPlayUserQuestionSound={playUserQuestionSound}
        />
      ) : null}
    </>,
    pluginsWrapper,
  );
};

AIAssistant.displayName = "AIAssistant";

export default AIAssistant;
