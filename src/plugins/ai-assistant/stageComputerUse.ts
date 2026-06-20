import html2canvas from "html2canvas";
import { GameAgentLimits, StageScreenshotMode } from "./types";
import { DEFAULT_GAME_AGENT_LIMITS } from "./subAgentConfig";

interface StageCaptureOptions {
  signal?: AbortSignal;
  mode?: StageScreenshotMode;
  maxScreenshotBytes?: GameAgentLimits["maxScreenshotBytes"];
}

type StageAction =
  | { type: "greenFlag" }
  | { type: "stopAll" }
  | { type: "wait"; ms: number }
  | { type: "mouseMove"; x: number; y: number; durationMs?: number }
  | { type: "mouseDown"; x?: number; y?: number; button?: MouseButton }
  | { type: "mouseUp"; x?: number; y?: number; button?: MouseButton }
  | { type: "click"; x: number; y: number; button?: MouseButton }
  | { type: "doubleClick"; x: number; y: number; button?: MouseButton }
  | { type: "keyDown"; key: string }
  | { type: "keyUp"; key: string }
  | { type: "keyPress"; key: string; durationMs?: number }
  | { type: "typeText"; text: string; intervalMs?: number }
  | { type: "screenshot" };

class StageScriptExecutionError extends Error {
  partialResult: any;

  constructor(message: string, partialResult: any) {
    super(message);
    this.name = "StageScriptExecutionError";
    this.partialResult = partialResult;
  }
}

type MouseButton = "left" | "middle" | "right";
type LimitValue = number | "infinite";
type StagePoint = { clientX: number; clientY: number; x: number; y: number };

const BUTTON_INDEX: Record<MouseButton, number> = { left: 0, middle: 1, right: 2 };
const BUTTONS_MASK: Record<MouseButton, number> = { left: 1, middle: 4, right: 2 };
const SCRATCH_STAGE_LOGICAL_HEIGHT = 360;
const DEFAULT_MOUSE_MOVE_STEP_MS = 20;
const STAGE_SCREENSHOT_MAX_WIDTH = 640;
const STAGE_SCREENSHOT_MAX_HEIGHT = 360;
const MIN_STAGE_SCREENSHOT_WIDTH = 120;
const MIN_STAGE_SCREENSHOT_HEIGHT = 68;
const DATA_URL_PREFIX_PATTERN = /^data:[^;]+;base64,/;
const STAGE_TAKEOVER_ATTRIBUTE = "data-ai-assistant-stage-takeover";
const STAGE_TAKEOVER_STYLE_ID = "ai-assistant-stage-takeover-style";
const AI_ASSISTANT_UI_ROOT_SELECTOR = "[data-ai-assistant-ui-root='true']";
const USER_POINTER_EVENT_TYPES = [
  "pointerdown",
  "pointermove",
  "pointerup",
  "mousedown",
  "mousemove",
  "mouseup",
  "click",
  "dblclick",
  "contextmenu",
  "touchstart",
  "touchmove",
  "touchend",
  "wheel",
] as const;
const USER_KEY_EVENT_TYPES = ["keydown", "keypress", "keyup"] as const;
const KEY_ALIASES: Record<string, { key: string; code: string }> = {
  space: { key: " ", code: "Space" },
  "space bar": { key: " ", code: "Space" },
  enter: { key: "Enter", code: "Enter" },
  return: { key: "Enter", code: "Enter" },
  escape: { key: "Escape", code: "Escape" },
  esc: { key: "Escape", code: "Escape" },
  tab: { key: "Tab", code: "Tab" },
  backspace: { key: "Backspace", code: "Backspace" },
  delete: { key: "Delete", code: "Delete" },
  left: { key: "ArrowLeft", code: "ArrowLeft" },
  "left arrow": { key: "ArrowLeft", code: "ArrowLeft" },
  arrowleft: { key: "ArrowLeft", code: "ArrowLeft" },
  right: { key: "ArrowRight", code: "ArrowRight" },
  "right arrow": { key: "ArrowRight", code: "ArrowRight" },
  arrowright: { key: "ArrowRight", code: "ArrowRight" },
  up: { key: "ArrowUp", code: "ArrowUp" },
  "up arrow": { key: "ArrowUp", code: "ArrowUp" },
  arrowup: { key: "ArrowUp", code: "ArrowUp" },
  down: { key: "ArrowDown", code: "ArrowDown" },
  "down arrow": { key: "ArrowDown", code: "ArrowDown" },
  arrowdown: { key: "ArrowDown", code: "ArrowDown" },
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const normalizeLimit = (value: LimitValue | undefined, fallback: number): LimitValue =>
  value === "infinite" ? "infinite" : typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;

export const normalizeStageComputerUseLimits = (limits?: Partial<GameAgentLimits>) => ({
  maxActionsPerScript: normalizeLimit(limits?.maxActionsPerScript, DEFAULT_GAME_AGENT_LIMITS.maxActionsPerScript as number),
  maxWaitMs: normalizeLimit(limits?.maxWaitMs, DEFAULT_GAME_AGENT_LIMITS.maxWaitMs as number),
  maxScriptDurationMs: normalizeLimit(limits?.maxScriptDurationMs, DEFAULT_GAME_AGENT_LIMITS.maxScriptDurationMs as number),
  maxToolTurns: normalizeLimit(limits?.maxToolTurns, DEFAULT_GAME_AGENT_LIMITS.maxToolTurns as number),
  maxScreenshotBytes: normalizeLimit(limits?.maxScreenshotBytes, DEFAULT_GAME_AGENT_LIMITS.maxScreenshotBytes as number),
});

const enforceNumberLimit = (label: string, value: number, limit: LimitValue) => {
  if (limit !== "infinite" && value > limit) {
    throw new Error(`${label} exceeds limit ${limit}.`);
  }
};

const wait = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      signal?.removeEventListener("abort", handleAbort);
      resolve();
    }, Math.max(0, ms));
    const handleAbort = () => {
      window.clearTimeout(timeout);
      reject(new DOMException("Stage action aborted", "AbortError"));
    };
    if (signal?.aborted) {
      handleAbort();
      return;
    }
    signal?.addEventListener("abort", handleAbort, { once: true });
  });

const isVisibleStageLikeElement = (element: Element | null): element is HTMLElement => {
  if (!(element instanceof HTMLElement)) return false;
  const rect = element.getBoundingClientRect();
  return rect.width >= 100 && rect.height >= 100;
};

const getCanvasCaptureRoot = (canvas: HTMLCanvasElement) => {
  let element: HTMLElement | null = canvas;
  for (let index = 0; index < 3; index += 1) {
    element = element.parentElement;
    if (!element) break;
  }
  return isVisibleStageLikeElement(element) ? element : null;
};

const getRendererCanvas = (vm?: any): HTMLCanvasElement | null => {
  const canvas = vm?.runtime?.renderer?.canvas || vm?.renderer?.canvas || vm?.runtime?.renderer?._gl?.canvas || vm?.renderer?._gl?.canvas;
  return canvas instanceof HTMLCanvasElement ? canvas : null;
};

const getInteractionRect = (vm: any, fallbackElement: HTMLElement) => {
  const canvas = getRendererCanvas(vm);
  const rect = canvas?.getBoundingClientRect();
  if (rect && rect.width > 0 && rect.height > 0) return rect;
  return fallbackElement.getBoundingClientRect();
};

const getStageCaptureCrop = (vm: any, element: HTMLElement) => {
  const elementRect = element.getBoundingClientRect();
  const captureRect = getInteractionRect(vm, element);
  const x = Math.max(0, captureRect.left - elementRect.left);
  const y = Math.max(0, captureRect.top - elementRect.top);
  return {
    x,
    y,
    width: Math.max(1, Math.min(captureRect.width, elementRect.width - x || captureRect.width)),
    height: Math.max(1, Math.min(captureRect.height, elementRect.height - y || captureRect.height)),
  };
};

const getStageCaptureScale = (width: number, height: number) =>
  Math.min(1, STAGE_SCREENSHOT_MAX_WIDTH / Math.max(1, width), STAGE_SCREENSHOT_MAX_HEIGHT / Math.max(1, height));

const getScratchStageBounds = (rect: DOMRect | { width: number; height: number }) => {
  const aspectRatio = rect.height > 0 ? rect.width / rect.height : 4 / 3;
  const width = SCRATCH_STAGE_LOGICAL_HEIGHT * aspectRatio;
  const height = SCRATCH_STAGE_LOGICAL_HEIGHT;
  return {
    width,
    height,
    minX: -width / 2,
    maxX: width / 2,
    minY: -height / 2,
    maxY: height / 2,
  };
};

const findStageElement = (vm?: any) => {
  const rendererCanvas = getRendererCanvas(vm);
  const rendererRoot = rendererCanvas ? getCanvasCaptureRoot(rendererCanvas) : null;
  if (rendererRoot) return rendererRoot;

  const selectors = [
    "[class*='stage-wrapper_stage-wrapper']",
    "[class*='stage_stage-wrapper']",
    "[class*='stage-wrapper']",
    "[class*='stageWrapper']",
    "[class*='stage_stage']",
  ];
  for (const selector of selectors) {
    const elements = Array.from(document.querySelectorAll(selector));
    const element = elements.find(isVisibleStageLikeElement);
    if (element) return element;
  }

  const canvases = Array.from(document.querySelectorAll("canvas"));
  for (const canvas of canvases) {
    if (!isVisibleStageLikeElement(canvas)) continue;
    const wrapper = canvas.closest("[class*='stage-wrapper']") || canvas.closest("[class*='stage']") || canvas.parentElement;
    if (isVisibleStageLikeElement(wrapper)) {
      return wrapper;
    }
  }
  throw new Error("Unable to locate the Scratch stage element.");
};

const ensureStageTakeoverStyle = () => {
  if (document.getElementById(STAGE_TAKEOVER_STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STAGE_TAKEOVER_STYLE_ID;
  style.textContent = `
    @keyframes aiAssistantStageTakeoverGlow {
      0%, 100% { box-shadow: 0 0 0 2px rgba(56, 189, 248, 0.85), 0 0 18px rgba(59, 130, 246, 0.42), 0 0 44px rgba(37, 99, 235, 0.28); }
      50% { box-shadow: 0 0 0 3px rgba(125, 211, 252, 0.95), 0 0 28px rgba(59, 130, 246, 0.72), 0 0 70px rgba(37, 99, 235, 0.4); }
    }
    @keyframes aiAssistantStageTakeoverShimmer {
      0% { background-position: 180% 50%; }
      100% { background-position: -180% 50%; }
    }
    [${STAGE_TAKEOVER_ATTRIBUTE}] {
      position: fixed;
      z-index: 9999;
      pointer-events: none;
      overflow: visible;
      contain: layout style;
    }
    [${STAGE_TAKEOVER_ATTRIBUTE}] .ai-assistant-stage-takeover-ring {
      position: absolute;
      inset: -9px;
      border: 2px solid rgba(14, 165, 233, 0.82);
      border-radius: 10px;
      animation: aiAssistantStageTakeoverGlow 1.8s ease-in-out infinite;
    }
    [${STAGE_TAKEOVER_ATTRIBUTE}] .ai-assistant-stage-takeover-badge {
      position: absolute;
      left: 50%;
      bottom: calc(100% + 12px);
      transform: translateX(-50%);
      white-space: nowrap;
      border-radius: 999px;
      padding: 7px 16px;
      background: rgba(15, 23, 42, 0.86);
      border: 1px solid rgba(125, 211, 252, 0.5);
      box-shadow: 0 10px 26px rgba(15, 23, 42, 0.24), 0 0 24px rgba(14, 165, 233, 0.28);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      font: 600 13px/1.35 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    [${STAGE_TAKEOVER_ATTRIBUTE}] .ai-assistant-stage-takeover-text {
      color: transparent;
      background-image: linear-gradient(90deg, #dbeafe 0%, #7dd3fc 24%, #ffffff 48%, #38bdf8 70%, #dbeafe 100%);
      background-size: 220% 100%;
      -webkit-background-clip: text;
      background-clip: text;
      animation: aiAssistantStageTakeoverShimmer 2.4s linear infinite;
    }
  `;
  document.head.appendChild(style);
};

const isEditableTarget = (target: EventTarget | null) => {
  const element = target instanceof HTMLElement ? target : null;
  if (!element) return false;
  return Boolean(
    element.closest("input, textarea, select, [contenteditable='true'], [contenteditable=''], [role='textbox']"),
  );
};

const isAssistantUiTarget = (target: EventTarget | null) => {
  const element = target instanceof HTMLElement ? target : target instanceof Node ? target.parentElement : null;
  return Boolean(element?.closest(AI_ASSISTANT_UI_ROOT_SELECTOR));
};

const isAssistantUiFocused = () => isAssistantUiTarget(document.activeElement);

const isTrustedUserEvent = (event: Event) => event.isTrusted !== false;

const escapeStageTakeoverText = (value: string) =>
  String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

export const activateStageTakeover = (vm?: any, agentName = "Game Agent") => {
  const stageElement = findStageElement(vm);
  const overlay = document.createElement("div");
  overlay.setAttribute(STAGE_TAKEOVER_ATTRIBUTE, "true");
  overlay.setAttribute("aria-hidden", "true");
  overlay.innerHTML = `
    <div class="ai-assistant-stage-takeover-ring"></div>
    <div class="ai-assistant-stage-takeover-badge"><span class="ai-assistant-stage-takeover-text">${escapeStageTakeoverText(agentName)} 正在接管舞台</span></div>
  `;
  ensureStageTakeoverStyle();
  document.body.appendChild(overlay);

  let disposed = false;
  let frameId: number | null = null;

  const updateOverlayPosition = () => {
    if (disposed) return;
    const rect = getInteractionRect(vm, stageElement);
    overlay.style.left = `${Math.round(rect.left)}px`;
    overlay.style.top = `${Math.round(rect.top)}px`;
    overlay.style.width = `${Math.round(rect.width)}px`;
    overlay.style.height = `${Math.round(rect.height)}px`;
  };

  const scheduleOverlayPosition = () => {
    if (frameId !== null) return;
    frameId = window.requestAnimationFrame(() => {
      frameId = null;
      updateOverlayPosition();
    });
  };

  const blockUserEvent = (event: Event) => {
    if (!isTrustedUserEvent(event)) return;
    if (isAssistantUiTarget(event.target)) return;
    if (isEditableTarget(event.target)) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
  };

  const blockUserPointerEvent = (event: Event) => {
    if (!isTrustedUserEvent(event)) return;
    if (isAssistantUiTarget(event.target)) return;
    blockUserEvent(event);
  };

  const blockUserKeyEvent = (event: Event) => {
    if (!isTrustedUserEvent(event) || isAssistantUiTarget(event.target) || isAssistantUiFocused() || isEditableTarget(event.target)) return;
    blockUserEvent(event);
  };

  const pointerListenerOptions: AddEventListenerOptions = { capture: true, passive: false };
  const keyListenerOptions: AddEventListenerOptions = { capture: true };
  USER_POINTER_EVENT_TYPES.forEach((type) => {
    window.addEventListener(type, blockUserPointerEvent, pointerListenerOptions);
    document.addEventListener(type, blockUserPointerEvent, pointerListenerOptions);
  });
  USER_KEY_EVENT_TYPES.forEach((type) => {
    window.addEventListener(type, blockUserKeyEvent, keyListenerOptions);
    document.addEventListener(type, blockUserKeyEvent, keyListenerOptions);
  });
  window.addEventListener("resize", scheduleOverlayPosition);
  window.addEventListener("scroll", scheduleOverlayPosition, true);

  const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(scheduleOverlayPosition) : null;
  observer?.observe(stageElement);
  updateOverlayPosition();

  return () => {
    disposed = true;
    if (frameId !== null) window.cancelAnimationFrame(frameId);
    observer?.disconnect();
    USER_POINTER_EVENT_TYPES.forEach((type) => {
      window.removeEventListener(type, blockUserPointerEvent, pointerListenerOptions);
      document.removeEventListener(type, blockUserPointerEvent, pointerListenerOptions);
    });
    USER_KEY_EVENT_TYPES.forEach((type) => {
      window.removeEventListener(type, blockUserKeyEvent, keyListenerOptions);
      document.removeEventListener(type, blockUserKeyEvent, keyListenerOptions);
    });
    window.removeEventListener("resize", scheduleOverlayPosition);
    window.removeEventListener("scroll", scheduleOverlayPosition, true);
    overlay.remove();
  };
};

const waitAnimationFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

const toDataUrlFromCanvas = (canvas: HTMLCanvasElement | OffscreenCanvas | undefined | null) => {
  try {
    if (canvas instanceof HTMLCanvasElement) return canvas.toDataURL("image/png");
  } catch (_error) {
    return "";
  }
  return "";
};

const estimateDataUrlBytes = (dataUrl: string) => {
  const base64 = dataUrl.replace(DATA_URL_PREFIX_PATTERN, "");
  return Math.ceil((base64.length * 3) / 4);
};

const resolveScreenshotByteLimit = (limit: GameAgentLimits["maxScreenshotBytes"] | undefined) =>
  limit === "infinite" ? "infinite" : typeof limit === "number" && Number.isFinite(limit) && limit > 0 ? limit : DEFAULT_GAME_AGENT_LIMITS.maxScreenshotBytes;

const getRendererSnapshotDataUrl = async (vm?: any) => {
  const renderer = vm?.renderer || vm?.runtime?.renderer;
  await waitAnimationFrame();

  if (typeof renderer?.requestSnapshot === "function") {
    const snapshot = await new Promise<string>((resolve) => {
      const timeout = window.setTimeout(() => resolve(""), 2000);
      try {
        renderer.requestSnapshot((dataUrl: string) => {
          window.clearTimeout(timeout);
          resolve(typeof dataUrl === "string" ? dataUrl : "");
        });
      } catch (_error) {
        window.clearTimeout(timeout);
        resolve("");
      }
    });
    if (snapshot) return snapshot;
  }

  return (
    toDataUrlFromCanvas(renderer?.canvas) ||
    toDataUrlFromCanvas(renderer?._gl?.canvas) ||
    toDataUrlFromCanvas(document.querySelector("[class*='stage'] canvas") as HTMLCanvasElement | null) ||
    toDataUrlFromCanvas(document.querySelector("canvas") as HTMLCanvasElement | null)
  );
};

const loadImage = (dataUrl: string) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Unable to load stage screenshot image."));
    image.src = dataUrl;
  });

const resizeStageImageDataUrl = async (dataUrl: string, maxWidth = STAGE_SCREENSHOT_MAX_WIDTH, maxHeight = STAGE_SCREENSHOT_MAX_HEIGHT, maxBytes?: GameAgentLimits["maxScreenshotBytes"]) => {
  const image = await loadImage(dataUrl);
  const sourceWidth = image.naturalWidth || image.width || maxWidth;
  const sourceHeight = image.naturalHeight || image.height || maxHeight;
  const output = document.createElement("canvas");
  const context = output.getContext("2d");
  if (!context) return dataUrl;
  const byteLimit = resolveScreenshotByteLimit(maxBytes);
  let scale = Math.min(1, maxWidth / sourceWidth, maxHeight / sourceHeight);
  let result = dataUrl;

  for (let attempt = 0; attempt < 16; attempt += 1) {
    const width = Math.max(MIN_STAGE_SCREENSHOT_WIDTH, Math.round(sourceWidth * scale));
    const height = Math.max(MIN_STAGE_SCREENSHOT_HEIGHT, Math.round(sourceHeight * scale));
    output.width = width;
    output.height = height;
    context.clearRect(0, 0, width, height);
    context.drawImage(image, 0, 0, width, height);
    result = output.toDataURL("image/jpeg", 0.82);
    if (byteLimit === "infinite" || estimateDataUrlBytes(result) <= byteLimit) return result;
    if (width <= MIN_STAGE_SCREENSHOT_WIDTH || height <= MIN_STAGE_SCREENSHOT_HEIGHT) break;
    scale *= 0.82;
  }

  return result;
};

const captureStageCanvasOnly = async (vm?: any, maxScreenshotBytes?: GameAgentLimits["maxScreenshotBytes"]) => {
  const rendererDataUrl = await getRendererSnapshotDataUrl(vm);
  if (!rendererDataUrl) {
    throw new Error("Unable to capture the Scratch renderer canvas.");
  }
  return resizeStageImageDataUrl(rendererDataUrl, STAGE_SCREENSHOT_MAX_WIDTH, STAGE_SCREENSHOT_MAX_HEIGHT, maxScreenshotBytes);
};

const compositeRendererAndDomOverlay = async (rendererDataUrl: string, overlayCanvas: HTMLCanvasElement) => {
  const baseImage = await loadImage(rendererDataUrl);
  const width = overlayCanvas.width || baseImage.naturalWidth || 480;
  const height = overlayCanvas.height || baseImage.naturalHeight || 360;
  const output = document.createElement("canvas");
  output.width = width;
  output.height = height;
  const context = output.getContext("2d");
  if (!context) return rendererDataUrl;
  context.drawImage(baseImage, 0, 0, width, height);
  context.drawImage(overlayCanvas, 0, 0, width, height);
  return output.toDataURL("image/png");
};

const clampScratchPoint = (vm: any, element: HTMLElement, x: number, y: number): StagePoint => {
  const rect = getInteractionRect(vm, element);
  const bounds = getScratchStageBounds(rect);
  const scratchX = Math.min(Math.max(Number(x) || 0, bounds.minX), bounds.maxX);
  const scratchY = Math.min(Math.max(Number(y) || 0, bounds.minY), bounds.maxY);
  const localX = ((scratchX - bounds.minX) / bounds.width) * rect.width;
  const localY = ((bounds.maxY - scratchY) / bounds.height) * rect.height;
  return {
    clientX: rect.left + localX,
    clientY: rect.top + localY,
    x: scratchX,
    y: scratchY,
  };
};

const interpolatePoint = (from: StagePoint, to: StagePoint, progress: number): StagePoint => ({
  clientX: from.clientX + (to.clientX - from.clientX) * progress,
  clientY: from.clientY + (to.clientY - from.clientY) * progress,
  x: from.x + (to.x - from.x) * progress,
  y: from.y + (to.y - from.y) * progress,
});

const isProjectRunning = (vm?: any) => {
  const runtime = vm?.runtime;
  const threads = Array.isArray(runtime?.threads) ? runtime.threads : [];
  return Boolean(runtime?.running || runtime?._stepping || threads.some((thread: any) => thread && thread.status !== 4));
};

const dispatchPointerMouseEvent = (
  element: HTMLElement,
  type: string,
  point: { clientX: number; clientY: number },
  button: MouseButton = "left",
) => {
  const target = (document.elementFromPoint(point.clientX, point.clientY) as HTMLElement | null) || element;
  const common = {
    bubbles: true,
    cancelable: true,
    composed: true,
    clientX: point.clientX,
    clientY: point.clientY,
    button: BUTTON_INDEX[button],
    buttons: type.endsWith("down") ? BUTTONS_MASK[button] : 0,
  };
  if (typeof PointerEvent !== "undefined" && type.startsWith("pointer")) {
    target.dispatchEvent(new PointerEvent(type, { ...common, pointerId: 1, pointerType: "mouse", isPrimary: true }));
    return;
  }
  target.dispatchEvent(new MouseEvent(type.replace(/^pointer/, "mouse"), common));
};

const normalizeKey = (key: string) => {
  const raw = String(key || "");
  const alias = KEY_ALIASES[raw.trim().toLowerCase()];
  if (alias) return alias;
  if (/^f\d{1,2}$/i.test(raw)) return { key: raw.toUpperCase(), code: raw.toUpperCase() };
  if (raw.length === 1 && /[a-z]/i.test(raw)) return { key: raw.toLowerCase(), code: `Key${raw.toUpperCase()}` };
  if (raw.length === 1 && /\d/.test(raw)) return { key: raw, code: `Digit${raw}` };
  return { key: raw, code: raw };
};

const dispatchKeyboardEvent = (type: "keydown" | "keyup", key: string) => {
  const target = (document.activeElement as HTMLElement | null) || document.body;
  const normalized = normalizeKey(key);
  const event = new KeyboardEvent(type, {
    key: normalized.key,
    code: normalized.code,
    bubbles: true,
    cancelable: true,
    composed: true,
  });
  target.dispatchEvent(event);
  document.dispatchEvent(new KeyboardEvent(type, event));
  window.dispatchEvent(new KeyboardEvent(type, event));
};

const parseObjectArgument = (text: string): Record<string, unknown> => {
  if (!text.trim()) return {};
  try {
    const json = text
      .replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":')
      .replace(/'([^']*)'/g, (_, value) => JSON.stringify(value));
    const parsed = JSON.parse(json);
    if (!isRecord(parsed)) throw new Error("argument must be an object");
    return parsed;
  } catch (error) {
    throw new Error(`Invalid stage action arguments: ${error instanceof Error ? error.message : String(error)}`);
  }
};

const splitStageScriptCalls = (script: string) => {
  const calls: string[] = [];
  let current = "";
  let quote: string | null = null;
  let escaped = false;
  let depth = 0;

  for (const char of String(script || "")) {
    current += char;

    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "(" || char === "{" || char === "[") depth += 1;
    if (char === ")" || char === "}" || char === "]") depth = Math.max(0, depth - 1);
    if (char === ";" && depth === 0) {
      const call = current.slice(0, -1).trim();
      if (call) calls.push(call);
      current = "";
    }
  }

  const tail = current.trim();
  if (tail) calls.push(tail);
  return calls;
};

const requiredNumber = (value: unknown, label: string) => {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) throw new Error(`${label} must be a finite number.`);
  return numberValue;
};

const optionalNumber = (value: unknown, label: string) => {
  if (value === undefined || value === null || value === "") return undefined;
  return requiredNumber(value, label);
};

const optionalDuration = (value: unknown, fallback: number, label: string) => {
  const numberValue = value === undefined || value === null || value === "" ? fallback : Number(value);
  if (!Number.isFinite(numberValue) || numberValue < 0) throw new Error(`${label} must be a non-negative finite number.`);
  return numberValue;
};

const optionalButton = (value: unknown) => {
  if (value === undefined || value === null || value === "") return undefined;
  if (value === "left" || value === "middle" || value === "right") return value;
  throw new Error(`button must be left, middle, or right.`);
};

const parseStageScript = (script: string): StageAction[] => {
  const actions: StageAction[] = [];
  const calls = splitStageScriptCalls(script);

  for (const call of calls) {
    const match = /^([A-Za-z_$][\w$]*)\s*\((.*)\)$/.exec(call);
    if (!match) throw new Error(`Invalid stage action syntax: ${call}`);
    const [, name, rawArg] = match;
    const argText = rawArg.trim();
    const objectArg = argText.startsWith("{") ? parseObjectArgument(argText) : {};
    const numberArg = argText && !argText.startsWith("{") ? Number(argText) : undefined;

    if (name === "greenFlag" || name === "stopAll") actions.push({ type: name });
    else if (name === "wait") actions.push({ type: "wait", ms: optionalDuration(objectArg.ms ?? objectArg.durationMs ?? numberArg, 0, "wait duration") });
    else if (name === "mouseMove")
      actions.push({
        type: "mouseMove",
        x: requiredNumber(objectArg.x, "x"),
        y: requiredNumber(objectArg.y, "y"),
        durationMs: optionalDuration(objectArg.durationMs, 0, "mouseMove duration"),
      });
    else if (name === "mouseDown") actions.push({ type: "mouseDown", x: optionalNumber(objectArg.x, "x"), y: optionalNumber(objectArg.y, "y"), button: optionalButton(objectArg.button) });
    else if (name === "mouseUp") actions.push({ type: "mouseUp", x: optionalNumber(objectArg.x, "x"), y: optionalNumber(objectArg.y, "y"), button: optionalButton(objectArg.button) });
    else if (name === "click") actions.push({ type: "click", x: requiredNumber(objectArg.x, "x"), y: requiredNumber(objectArg.y, "y"), button: optionalButton(objectArg.button) });
    else if (name === "doubleClick") actions.push({ type: "doubleClick", x: requiredNumber(objectArg.x, "x"), y: requiredNumber(objectArg.y, "y"), button: optionalButton(objectArg.button) });
    else if (name === "keyDown" || name === "keyUp") actions.push({ type: name, key: String(objectArg.key || "") });
    else if (name === "keyPress") actions.push({ type: "keyPress", key: String(objectArg.key || ""), durationMs: optionalDuration(objectArg.durationMs, 120, "keyPress duration") });
    else if (name === "typeText") actions.push({ type: "typeText", text: String(objectArg.text || ""), intervalMs: optionalDuration(objectArg.intervalMs, 30, "typeText interval") });
    else if (name === "screenshot") actions.push({ type: "screenshot" });
    else throw new Error(`Unsupported stage action: ${name}`);
  }

  return actions;
};

export const observeStage = async (vm?: any, options?: StageCaptureOptions | AbortSignal) => {
  const signal = options instanceof AbortSignal ? options : options?.signal;
  const mode = options instanceof AbortSignal ? "fast" : options?.mode || "fast";
  const maxScreenshotBytes = options instanceof AbortSignal ? undefined : options?.maxScreenshotBytes;
  const stageElement = findStageElement(vm);
  if (signal?.aborted) throw new DOMException("Stage observation aborted", "AbortError");

  if (mode === "fast") {
    return {
      success: true,
      isRunning: isProjectRunning(vm),
      image: {
        mimeType: "image/jpeg",
        dataUrl: await captureStageCanvasOnly(vm, maxScreenshotBytes),
      },
    };
  }

  const rendererDataUrl = await getRendererSnapshotDataUrl(vm);
  const crop = getStageCaptureCrop(vm, stageElement);
  const canvas = await html2canvas(stageElement, {
    backgroundColor: null,
    useCORS: true,
    logging: false,
    scale: getStageCaptureScale(crop.width, crop.height),
    x: crop.x,
    y: crop.y,
    width: crop.width,
    height: crop.height,
    windowWidth: Math.ceil(stageElement.getBoundingClientRect().width),
    windowHeight: Math.ceil(stageElement.getBoundingClientRect().height),
    ignoreElements: (element) =>
      Boolean(
        element instanceof HTMLElement &&
          (element.hasAttribute(STAGE_TAKEOVER_ATTRIBUTE) || element.closest(`[${STAGE_TAKEOVER_ATTRIBUTE}]`)),
      ) || Boolean(rendererDataUrl && element instanceof HTMLCanvasElement),
  });
  const rawDataUrl = rendererDataUrl ? await compositeRendererAndDomOverlay(rendererDataUrl, canvas) : canvas.toDataURL("image/png");
  const dataUrl = await resizeStageImageDataUrl(rawDataUrl, STAGE_SCREENSHOT_MAX_WIDTH, STAGE_SCREENSHOT_MAX_HEIGHT, maxScreenshotBytes);
  return {
    success: true,
    isRunning: isProjectRunning(vm),
    image: {
      mimeType: "image/jpeg",
      dataUrl,
    },
  };
};

export const runStageScript = async (
  vm: any,
  script: string,
  limits: Partial<GameAgentLimits> | undefined,
  options?: StageCaptureOptions | AbortSignal,
) => {
  const signal = options instanceof AbortSignal ? options : options?.signal;
  const mode = options instanceof AbortSignal ? "fast" : options?.mode || "fast";
  const normalizedLimits = normalizeStageComputerUseLimits(limits);
  const maxScreenshotBytes = options instanceof AbortSignal ? normalizedLimits.maxScreenshotBytes : options?.maxScreenshotBytes ?? normalizedLimits.maxScreenshotBytes;
  const stageElement = findStageElement(vm);
  const actions = parseStageScript(script);
  enforceNumberLimit("Action count", actions.length, normalizedLimits.maxActionsPerScript);

  const startedAt = Date.now();
  const checkDuration = () => enforceNumberLimit("Stage script duration", Date.now() - startedAt, normalizedLimits.maxScriptDurationMs);
  let executedActions = 0;
  let lastPoint = clampScratchPoint(vm, stageElement, 0, 0);
  const screenshots: Array<{ mimeType: string; dataUrl: string }> = [];

  const createPartialResult = (error?: unknown, failedActionIndex?: number, failedAction?: StageAction) => ({
    success: !error,
    actions: executedActions,
    elapsedMs: Date.now() - startedAt,
    screenshots,
    ...(error
      ? {
          error: error instanceof Error ? error.message : String(error),
          failedActionIndex,
          failedAction: failedAction?.type,
        }
      : {}),
  });

  for (let actionIndex = 0; actionIndex < actions.length; actionIndex += 1) {
    const action = actions[actionIndex];
    try {
      if (signal?.aborted) throw new DOMException("Stage action aborted", "AbortError");
      checkDuration();
    if (action.type === "greenFlag") vm?.greenFlag?.();
    if (action.type === "stopAll") vm?.stopAll?.();
    if (action.type === "wait") {
      enforceNumberLimit("Wait duration", action.ms, normalizedLimits.maxWaitMs);
      await wait(action.ms, signal);
    }
    if (action.type === "mouseMove") {
      const startPoint = lastPoint;
      const targetPoint = clampScratchPoint(vm, stageElement, action.x, action.y);
      const durationMs = action.durationMs || 0;
      if (durationMs <= 0) {
        dispatchPointerMouseEvent(stageElement, "pointermove", targetPoint);
        dispatchPointerMouseEvent(stageElement, "mousemove", targetPoint);
      } else {
        const steps = Math.max(1, Math.ceil(durationMs / DEFAULT_MOUSE_MOVE_STEP_MS));
        for (let step = 1; step <= steps; step += 1) {
          const point = interpolatePoint(startPoint, targetPoint, step / steps);
          dispatchPointerMouseEvent(stageElement, "pointermove", point);
          dispatchPointerMouseEvent(stageElement, "mousemove", point);
          if (step < steps) await wait(Math.min(DEFAULT_MOUSE_MOVE_STEP_MS, durationMs / steps), signal);
        }
      }
      lastPoint = targetPoint;
    }
    if (action.type !== "mouseMove" && "x" in action && "y" in action && typeof action.x === "number" && typeof action.y === "number") {
      lastPoint = clampScratchPoint(vm, stageElement, action.x, action.y);
    }
    if (action.type === "mouseDown") {
      dispatchPointerMouseEvent(stageElement, "pointermove", lastPoint, action.button || "left");
      dispatchPointerMouseEvent(stageElement, "mousemove", lastPoint, action.button || "left");
      dispatchPointerMouseEvent(stageElement, "pointerdown", lastPoint, action.button || "left");
      dispatchPointerMouseEvent(stageElement, "mousedown", lastPoint, action.button || "left");
    }
    if (action.type === "mouseUp") {
      dispatchPointerMouseEvent(stageElement, "pointerup", lastPoint, action.button || "left");
      dispatchPointerMouseEvent(stageElement, "mouseup", lastPoint, action.button || "left");
    }
    if (action.type === "click") {
      const button = action.button || "left";
      dispatchPointerMouseEvent(stageElement, "pointermove", lastPoint, button);
      dispatchPointerMouseEvent(stageElement, "pointerdown", lastPoint, button);
      dispatchPointerMouseEvent(stageElement, "mousedown", lastPoint, button);
      dispatchPointerMouseEvent(stageElement, "pointerup", lastPoint, button);
      dispatchPointerMouseEvent(stageElement, "mouseup", lastPoint, button);
      if (button === "right") dispatchPointerMouseEvent(stageElement, "contextmenu", lastPoint, button);
      else dispatchPointerMouseEvent(stageElement, "click", lastPoint, button);
    }
    if (action.type === "doubleClick") {
      const button = action.button || "left";
      for (let index = 0; index < 2; index += 1) {
        dispatchPointerMouseEvent(stageElement, "pointermove", lastPoint, button);
        dispatchPointerMouseEvent(stageElement, "mousemove", lastPoint, button);
        dispatchPointerMouseEvent(stageElement, "pointerdown", lastPoint, button);
        dispatchPointerMouseEvent(stageElement, "mousedown", lastPoint, button);
        dispatchPointerMouseEvent(stageElement, "pointerup", lastPoint, button);
        dispatchPointerMouseEvent(stageElement, "mouseup", lastPoint, button);
        dispatchPointerMouseEvent(stageElement, "click", lastPoint, button);
      }
      dispatchPointerMouseEvent(stageElement, "dblclick", lastPoint, action.button || "left");
    }
    if (action.type === "keyDown" || action.type === "keyUp") {
      if (!action.key) throw new Error(`${action.type} requires key.`);
      dispatchKeyboardEvent(action.type === "keyDown" ? "keydown" : "keyup", action.key);
    }
    if (action.type === "keyPress") {
      if (!action.key) throw new Error("keyPress requires key.");
      enforceNumberLimit("Key press duration", action.durationMs || 120, normalizedLimits.maxWaitMs);
      dispatchKeyboardEvent("keydown", action.key);
      await wait(action.durationMs || 120, signal);
      dispatchKeyboardEvent("keyup", action.key);
    }
    if (action.type === "typeText") {
      for (const char of action.text) {
        dispatchKeyboardEvent("keydown", char);
        dispatchKeyboardEvent("keyup", char);
        await wait(action.intervalMs || 30, signal);
      }
    }
    if (action.type === "screenshot") {
      const observation = await observeStage(vm, { signal, mode, maxScreenshotBytes });
      screenshots.push(observation.image);
    }
      executedActions += 1;
    } catch (error) {
      if ((error as any)?.name === "AbortError") throw error;
      throw new StageScriptExecutionError(
        error instanceof Error ? error.message : String(error),
        createPartialResult(error, actionIndex + 1, action),
      );
    }
  }

  return createPartialResult();
};

export const getStageScriptPartialResult = (error: unknown) =>
  error instanceof StageScriptExecutionError ? error.partialResult : undefined;
