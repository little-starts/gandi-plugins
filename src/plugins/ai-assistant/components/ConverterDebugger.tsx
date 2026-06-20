import * as React from "react";
import ReactDOM from "react-dom";
import { useBlockRangeSelection } from "../hooks/useBlockRangeSelection";
import { ucfToScratch } from "../ucf";
import { callGetBlockInfo } from "../converter";
import { observeStage } from "../stageComputerUse";
import { insertScriptByUCF, replaceScriptByUCF } from "../workspaceRangeTools";
import { showAssistantAlert } from "./AssistantDialogHost";

interface ConverterDebuggerProps {
  vm: any;
  workspace: any;
  blockly?: any;
  onPlayUserQuestionSound?: () => void | Promise<void>;
}

export const ConverterDebugger: React.FC<ConverterDebuggerProps> = ({ vm, workspace, blockly, onPlayUserQuestionSound }) => {
  const [dslInput, setDslInput] = React.useState("");
  const [stageScreenshot, setStageScreenshot] = React.useState("");
  const [isCapturingStage, setIsCapturingStage] = React.useState(false);
  const [isTestingInsert, setIsTestingInsert] = React.useState(false);
  const [isTestingReplace, setIsTestingReplace] = React.useState(false);
  const [insertTestResult, setInsertTestResult] = React.useState("");
  const [replaceTestResult, setReplaceTestResult] = React.useState("");
  const [position, setPosition] = React.useState({ x: 20, y: 20 });
  const insertTestBlockIdRef = React.useRef("");
  const dragStateRef = React.useRef<{
    pointerId: number;
    offsetX: number;
    offsetY: number;
    panelWidth: number;
    panelHeight: number;
  } | null>(null);

  const { isSelecting, startSelecting, cancelSelecting } = useBlockRangeSelection({
    workspace,
    vm,
    onRangeSelected: (referenceText) => {
      console.group("=== [ConverterDebugger] Selected Blocks ===");
      console.log(referenceText);
      console.groupEnd();
    },
    onSelectionError: (message) => {
      console.error("[ConverterDebugger] Selection Error:", message);
    }
  });

  const handleParseDsl = () => {
    console.group("=== [ConverterDebugger] Parsing DSL ===");
    try {
      const json = ucfToScratch(dslInput, { runtime: vm.runtime });
    } catch (e) {
      console.error("[ConverterDebugger] Parse Error:", e);
    }
    console.groupEnd();
  };

  const handlePreviewStage = async () => {
    if (isCapturingStage) return;
    setIsCapturingStage(true);
    try {
      const result = await observeStage(vm);
      setStageScreenshot(result.image.dataUrl);
    } catch (error) {
      console.error("[ConverterDebugger] Stage Screenshot Error:", error);
      await showAssistantAlert(`舞台截图失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setIsCapturingStage(false);
    }
  };

  const handlePlayUserQuestionSound = () => {
    if (!onPlayUserQuestionSound) return;
    Promise.resolve(onPlayUserQuestionSound())
      .then(() => {
        console.info("[ConverterDebugger] User question sound played.");
      })
      .catch((error) => {
        console.error("[ConverterDebugger] User question sound failed:", error);
      });
  };

  const handleInternalInsertTest = async () => {
    if (isTestingInsert) return;
    setIsTestingInsert(true);
    setInsertTestResult("Running...");
    const target = vm?.editingTarget || vm?.runtime?.getEditingTarget?.();
    const targetId = target?.id || "";
    const testDsl = [
      'event.whenflagclicked({ $xy: { x: 80, y: 80 } }, () => {',
      '  looks.say({ MESSAGE: "AI insert sync test" });',
      "});",
    ].join("\n");
    console.group("=== [ConverterDebugger] Internal AI Insert Sync Test ===");
    try {
      const result: any = await insertScriptByUCF(vm, workspace, targetId, testDsl, {
        includeComments: true,
        blockly,
      });
      console.info("[ConverterDebugger] Internal insert result:", result);
      if (result?.success && result.insertedTopBlockId) {
        insertTestBlockIdRef.current = result.insertedTopBlockId;
      }
      setInsertTestResult(result?.success ? `Success: ${result.insertedTopBlockId || ""}` : `Failed: ${result?.stage || "unknown"}`);
    } catch (error) {
      console.error("[ConverterDebugger] Internal insert error:", error);
      setInsertTestResult(`Error: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      console.groupEnd();
      setIsTestingInsert(false);
    }
  };

  const ensureInternalInsertTestScript = async () => {
    const existingId = insertTestBlockIdRef.current;
    const target = vm?.editingTarget || vm?.runtime?.getEditingTarget?.();
    if (existingId && target?.blocks?._blocks?.[existingId]) {
      return existingId;
    }
    const targetId = target?.id || "";
    const testDsl = [
      'event.whenflagclicked({ $xy: { x: 120, y: 120 } }, () => {',
      '  looks.say({ MESSAGE: "AI replace seed" });',
      "});",
    ].join("\n");
    const result: any = await insertScriptByUCF(vm, workspace, targetId, testDsl, {
      includeComments: true,
      blockly,
    });
    if (!result?.success || !result.insertedTopBlockId) {
      throw new Error(`Failed to create replace seed: ${result?.stage || result?.error || "unknown"}`);
    }
    insertTestBlockIdRef.current = result.insertedTopBlockId;
    setInsertTestResult(`Success: ${result.insertedTopBlockId}`);
    return result.insertedTopBlockId;
  };

  const handleInternalReplaceTest = async () => {
    if (isTestingReplace) return;
    setIsTestingReplace(true);
    setReplaceTestResult("Running...");
    const testDsl = [
      'event.whenflagclicked({ $xy: { x: 140, y: 140 } }, () => {',
      '  looks.say({ MESSAGE: "AI replace sync test" });',
      "});",
    ].join("\n");
    console.group("=== [ConverterDebugger] Internal AI Replace Sync Test ===");
    try {
      const scriptId = await ensureInternalInsertTestScript();
      const result: any = await replaceScriptByUCF(vm, workspace, scriptId, testDsl, {
        includeComments: true,
        blockly,
      });
      console.info("[ConverterDebugger] Internal replace result:", result);
      if (result?.success && result.insertedTopBlockId) {
        insertTestBlockIdRef.current = result.insertedTopBlockId;
      }
      setReplaceTestResult(result?.success ? `Success: ${result.insertedTopBlockId || ""}` : `Failed: ${result?.stage || "unknown"}`);
    } catch (error) {
      console.error("[ConverterDebugger] Internal replace error:", error);
      setReplaceTestResult(`Error: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      console.groupEnd();
      setIsTestingReplace(false);
    }
  };

  const clampPosition = React.useCallback((x: number, y: number, width = 320, height = 200) => {
    const maxX = Math.max(0, window.innerWidth - width);
    const maxY = Math.max(0, window.innerHeight - height);
    return {
      x: Math.min(Math.max(0, x), maxX),
      y: Math.min(Math.max(0, y), maxY),
    };
  }, []);

  const handleHeaderPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    const panel = event.currentTarget.closest("[data-converter-debugger-panel]") as HTMLElement | null;
    const rect = panel?.getBoundingClientRect();
    dragStateRef.current = {
      pointerId: event.pointerId,
      offsetX: event.clientX - (rect?.left ?? position.x),
      offsetY: event.clientY - (rect?.top ?? position.y),
      panelWidth: rect?.width ?? 320,
      panelHeight: rect?.height ?? 200,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  };

  const handleHeaderPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const dragState = dragStateRef.current;
    if (!dragState || dragState.pointerId !== event.pointerId) return;
    const next = clampPosition(
      event.clientX - dragState.offsetX,
      event.clientY - dragState.offsetY,
      dragState.panelWidth,
      dragState.panelHeight,
    );
    setPosition(next);
  };

  const handleHeaderPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    const dragState = dragStateRef.current;
    if (dragState?.pointerId === event.pointerId) {
      dragStateRef.current = null;
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const modalStyle: React.CSSProperties = {
    position: "fixed",
    top: `${position.y}px`,
    left: `${position.x}px`,
    width: "320px",
    backgroundColor: "#ffffff",
    border: "1px solid #ccc",
    boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
    padding: "16px",
    zIndex: 999999,
    borderRadius: "8px",
    display: "flex",
    flexDirection: "column",
    gap: "12px",
    color: "#333",
    fontFamily: "sans-serif"
  };

  return ReactDOM.createPortal(
    <div style={modalStyle} data-converter-debugger-panel>
      <div
        style={{ display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "move", userSelect: "none" }}
        onPointerDown={handleHeaderPointerDown}
        onPointerMove={handleHeaderPointerMove}
        onPointerUp={handleHeaderPointerUp}
        onPointerCancel={handleHeaderPointerUp}
      >
        <h3 style={{ margin: 0, fontSize: "16px", fontWeight: "bold" }}>Converter Debugger</h3>
        <span style={{ fontSize: "12px", color: "#999" }}>Drag to move</span>
      </div>
      
      <div>
        <button 
          onClick={isSelecting ? cancelSelecting : startSelecting}
          style={{ 
            width: "100%", 
            padding: "8px", 
            cursor: "pointer", 
            backgroundColor: isSelecting ? "#ff4d4f" : "#1890ff",
            color: "#fff",
            border: "none",
            borderRadius: "4px",
            fontWeight: "bold"
          }}
        >
          {isSelecting ? "Cancel Selection" : "Select Blocks (Box Select)"}
        </button>
        {isSelecting && <div style={{ fontSize: "12px", color: "gray", marginTop: "4px" }}>Draw a box around blocks on workspace...</div>}
      </div>

      <hr style={{ borderTop: "1px solid #eee", margin: "4px 0" }} />

      <div>
        <button
          onClick={handleInternalInsertTest}
          disabled={isTestingInsert}
          style={{
            width: "100%",
            padding: "8px",
            cursor: isTestingInsert ? "wait" : "pointer",
            backgroundColor: "#1677ff",
            color: "#fff",
            border: "none",
            borderRadius: "4px",
            fontWeight: "bold",
            opacity: isTestingInsert ? 0.75 : 1,
          }}
        >
          {isTestingInsert ? "Testing Internal Insert..." : "AI Insert Sync Test"}
        </button>
        {insertTestResult ? (
          <div style={{ fontSize: "12px", color: "#555", marginTop: "6px", wordBreak: "break-word" }}>
            {insertTestResult}
          </div>
        ) : null}
      </div>

      <div>
        <button
          onClick={handleInternalReplaceTest}
          disabled={isTestingReplace}
          style={{
            width: "100%",
            padding: "8px",
            cursor: isTestingReplace ? "wait" : "pointer",
            backgroundColor: "#13a8a8",
            color: "#fff",
            border: "none",
            borderRadius: "4px",
            fontWeight: "bold",
            opacity: isTestingReplace ? 0.75 : 1,
          }}
        >
          {isTestingReplace ? "Testing Internal Replace..." : "AI Replace Sync Test"}
        </button>
        {replaceTestResult ? (
          <div style={{ fontSize: "12px", color: "#555", marginTop: "6px", wordBreak: "break-word" }}>
            {replaceTestResult}
          </div>
        ) : null}
      </div>

      <hr style={{ borderTop: "1px solid #eee", margin: "4px 0" }} />

      <div>
        <button
          onClick={handlePlayUserQuestionSound}
          disabled={!onPlayUserQuestionSound}
          style={{
            width: "100%",
            padding: "8px",
            cursor: onPlayUserQuestionSound ? "pointer" : "not-allowed",
            backgroundColor: "#fa8c16",
            color: "#fff",
            border: "none",
            borderRadius: "4px",
            fontWeight: "bold",
            opacity: onPlayUserQuestionSound ? 1 : 0.6,
          }}
        >
          Play Question Sound
        </button>
      </div>

      <hr style={{ borderTop: "1px solid #eee", margin: "4px 0" }} />

      <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
        <button
          onClick={handlePreviewStage}
          disabled={isCapturingStage}
          style={{
            width: "100%",
            padding: "8px",
            cursor: isCapturingStage ? "wait" : "pointer",
            backgroundColor: "#722ed1",
            color: "#fff",
            border: "none",
            borderRadius: "4px",
            fontWeight: "bold",
            opacity: isCapturingStage ? 0.75 : 1,
          }}
        >
          {isCapturingStage ? "Capturing Stage..." : "Preview Stage Screenshot"}
        </button>
        {stageScreenshot ? (
          <div style={{ maxHeight: "240px", overflow: "auto", border: "1px solid #eee", borderRadius: "6px", background: "#111" }}>
            <img src={stageScreenshot} alt="Stage screenshot preview" style={{ display: "block", width: "100%" }} />
          </div>
        ) : null}
      </div>

      <hr style={{ borderTop: "1px solid #eee", margin: "4px 0" }} />

      <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
        <textarea 
          placeholder="Paste DSL here..."
          value={dslInput}
          onChange={(e) => setDslInput(e.target.value)}
          style={{ 
            width: "100%", 
            height: "120px", 
            resize: "vertical", 
            fontFamily: "monospace", 
            padding: "8px",
            boxSizing: "border-box",
            border: "1px solid #ccc",
            borderRadius: "4px"
          }}
        />
        <button 
          onClick={handleParseDsl}
          style={{ 
            width: "100%", 
            padding: "8px", 
            cursor: "pointer",
            backgroundColor: "#52c41a",
            color: "#fff",
            border: "none",
            borderRadius: "4px",
            fontWeight: "bold"
          }}
        >
          Parse DSL to JSON
        </button>
      </div>
    </div>,
    document.body
  );
};
