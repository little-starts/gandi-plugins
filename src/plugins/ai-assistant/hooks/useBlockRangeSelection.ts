import * as React from "react";
import { createRangeTextReference } from "../blockRangeUtils";

interface UseBlockRangeSelectionOptions {
  workspace: Blockly.WorkspaceSvg;
  vm: PluginContext["vm"];
  onRangeSelected: (text: string) => void;
  onSelectionError: (message: string) => void;
}

type SelectionPointerEvent = PointerEvent | MouseEvent | TouchEvent;

const getTargetClassName = (target: EventTarget | null) => {
  const className = (target as SVGElement | null)?.className;
  if (!className) return "";
  return typeof className === "string" ? className : className.baseVal || "";
};

const isBlocklySelectionTarget = (target: EventTarget | null) => {
  const targetClassName = getTargetClassName(target);
  return ["blocklyMainBackground", "blocklyBubbleCanvas"].includes(targetClassName) || targetClassName.includes("blockly");
};

const getClientPoint = (event: SelectionPointerEvent) => {
  if ("clientX" in event && typeof event.clientX === "number") {
    return { x: event.clientX, y: event.clientY };
  }
  const touch = "changedTouches" in event ? event.changedTouches[0] : "touches" in event ? event.touches[0] : null;
  return touch ? { x: touch.clientX, y: touch.clientY } : null;
};

export const useBlockRangeSelection = ({
  workspace,
  vm,
  onRangeSelected,
  onSelectionError,
}: UseBlockRangeSelectionOptions) => {
  const [isSelecting, setIsSelecting] = React.useState(false);
  const rectNodeRef = React.useRef<SVGRectElement | null>(null);
  const startPointRef = React.useRef<{ x: number; y: number } | null>(null);
  const svgNodeRef = React.useRef<Element | null>(null);
  const moveCountRef = React.useRef(0);
  const activePointerIdRef = React.useRef<number | null>(null);
  const previousTouchActionRef = React.useRef<string | null>(null);
  const previousUserSelectRef = React.useRef<string | null>(null);

  const restoreTouchInteraction = React.useCallback(() => {
    if (previousTouchActionRef.current !== null) {
      document.body.style.touchAction = previousTouchActionRef.current;
      previousTouchActionRef.current = null;
    }
    if (previousUserSelectRef.current !== null) {
      document.body.style.userSelect = previousUserSelectRef.current;
      previousUserSelectRef.current = null;
    }
  }, []);

  const lockTouchInteraction = React.useCallback(() => {
    if (previousTouchActionRef.current === null) {
      previousTouchActionRef.current = document.body.style.touchAction;
    }
    if (previousUserSelectRef.current === null) {
      previousUserSelectRef.current = document.body.style.userSelect;
    }
    document.body.style.touchAction = "none";
    document.body.style.userSelect = "none";
  }, []);

  const clearRect = React.useCallback(() => {
    if (rectNodeRef.current?.parentNode) {
      rectNodeRef.current.parentNode.removeChild(rectNodeRef.current);
    }
    rectNodeRef.current = null;
  }, []);

  const resetSelectionGesture = React.useCallback(() => {
    clearRect();
    startPointRef.current = null;
    moveCountRef.current = 0;
    activePointerIdRef.current = null;
    document.body.style.cursor = "";
    restoreTouchInteraction();
  }, [clearRect, restoreTouchInteraction]);

  const cancelSelecting = React.useCallback(() => {
    resetSelectionGesture();
    setIsSelecting(false);
  }, [resetSelectionGesture]);

  const startSelecting = React.useCallback(() => {
    setIsSelecting(true);
  }, []);

  React.useEffect(() => {
    svgNodeRef.current = document.querySelector(".blocklySvg");
  }, []);

  React.useEffect(() => {
    if (!isSelecting || !svgNodeRef.current) return;

    const shouldIgnorePointer = (event: SelectionPointerEvent) => {
      if ("pointerId" in event && activePointerIdRef.current !== null && event.pointerId !== activePointerIdRef.current) {
        return true;
      }
      if ("button" in event && event.type === "pointerdown" && event.button !== 0) return true;
      if ("button" in event && event.type === "mousedown" && event.button !== 0) return true;
      return false;
    };

    const beginSelection = (event: SelectionPointerEvent) => {
      if (shouldIgnorePointer(event) || !isBlocklySelectionTarget(event.target)) return;
      const point = getClientPoint(event);
      const workspaceRect = svgNodeRef.current?.getBoundingClientRect();
      if (!point || !workspaceRect) return;

      event.preventDefault();
      event.stopPropagation();
      document.body.style.cursor = "crosshair";
      lockTouchInteraction();

      if ("pointerId" in event) {
        activePointerIdRef.current = event.pointerId;
        (event.target as Element | null)?.setPointerCapture?.(event.pointerId);
      } else {
        activePointerIdRef.current = null;
      }

      moveCountRef.current = 0;
      startPointRef.current = {
        x: point.x - workspaceRect.left,
        y: point.y - workspaceRect.top,
      };

      const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      rect.setAttribute("x", String(startPointRef.current.x));
      rect.setAttribute("y", String(startPointRef.current.y));
      rect.setAttribute("width", "0");
      rect.setAttribute("height", "0");
      rect.setAttribute("fill", "rgba(76, 151, 255, 0.15)");
      rect.setAttribute("stroke", "#4c97ff");
      rect.setAttribute("stroke-width", "2");
      rect.setAttribute("pointer-events", "none");
      rectNodeRef.current = rect;
      svgNodeRef.current?.appendChild(rect);
    };

    const updateSelection = (event: SelectionPointerEvent) => {
      if (shouldIgnorePointer(event) || !rectNodeRef.current || !startPointRef.current || !svgNodeRef.current) return;
      const point = getClientPoint(event);
      if (!point) return;

      event.preventDefault();
      event.stopPropagation();
      moveCountRef.current += 1;

      const workspaceRect = svgNodeRef.current.getBoundingClientRect();
      const offsetX = point.x - workspaceRect.left;
      const offsetY = point.y - workspaceRect.top;

      const width = offsetX - startPointRef.current.x;
      const height = offsetY - startPointRef.current.y;

      rectNodeRef.current.setAttribute("width", `${Math.abs(width)}`);
      rectNodeRef.current.setAttribute("height", `${Math.abs(height)}`);
      rectNodeRef.current.setAttribute("x", `${width < 0 ? offsetX : startPointRef.current.x}`);
      rectNodeRef.current.setAttribute("y", `${height < 0 ? offsetY : startPointRef.current.y}`);
    };

    const finishSelection = (event: SelectionPointerEvent) => {
      if (shouldIgnorePointer(event)) return;
      event.preventDefault();
      event.stopPropagation();

      if ("pointerId" in event) {
        (event.target as Element | null)?.releasePointerCapture?.(event.pointerId);
      }

      if (!rectNodeRef.current || !svgNodeRef.current || moveCountRef.current <= 1) {
        resetSelectionGesture();
        return;
      }

      const rectBounds = rectNodeRef.current.getBoundingClientRect();
      const { text, reason } = createRangeTextReference(vm, workspace, rectBounds);
      resetSelectionGesture();

      if (text) {
        onRangeSelected(text);
        setIsSelecting(false);
        return;
      }

      if (reason) {
        onSelectionError(reason);
      }
    };

    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        cancelSelecting();
      }
    };

    const supportsPointerEvents = typeof window.PointerEvent !== "undefined";
    if (supportsPointerEvents) {
      document.addEventListener("pointerdown", beginSelection, { capture: true });
      document.addEventListener("pointermove", updateSelection, { capture: true });
      document.addEventListener("pointerup", finishSelection, { capture: true });
      document.addEventListener("pointercancel", finishSelection, { capture: true });
    } else {
      document.addEventListener("mousedown", beginSelection, { capture: true });
      document.addEventListener("mousemove", updateSelection, { capture: true });
      document.addEventListener("mouseup", finishSelection, { capture: true });
      document.addEventListener("touchstart", beginSelection, { capture: true, passive: false });
      document.addEventListener("touchmove", updateSelection, { capture: true, passive: false });
      document.addEventListener("touchend", finishSelection, { capture: true, passive: false });
      document.addEventListener("touchcancel", finishSelection, { capture: true, passive: false });
    }
    document.addEventListener("keydown", keydown);

    return () => {
      if (supportsPointerEvents) {
        document.removeEventListener("pointerdown", beginSelection, { capture: true });
        document.removeEventListener("pointermove", updateSelection, { capture: true });
        document.removeEventListener("pointerup", finishSelection, { capture: true });
        document.removeEventListener("pointercancel", finishSelection, { capture: true });
      } else {
        document.removeEventListener("mousedown", beginSelection, { capture: true });
        document.removeEventListener("mousemove", updateSelection, { capture: true });
        document.removeEventListener("mouseup", finishSelection, { capture: true });
        document.removeEventListener("touchstart", beginSelection, { capture: true });
        document.removeEventListener("touchmove", updateSelection, { capture: true });
        document.removeEventListener("touchend", finishSelection, { capture: true });
        document.removeEventListener("touchcancel", finishSelection, { capture: true });
      }
      document.removeEventListener("keydown", keydown);
      resetSelectionGesture();
    };
  }, [cancelSelecting, isSelecting, lockTouchInteraction, onRangeSelected, onSelectionError, resetSelectionGesture, vm, workspace]);

  return {
    isSelecting,
    startSelecting,
    cancelSelecting,
  };
};
