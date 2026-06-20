import { createVirtualBlockLineReference, isProjectIndexCompleteForBlockReferences } from "./blockReferenceUtils";

export const registerContextMenu = (vm: any) => {
  const menuItemId = window.Blockly.ContextMenu.addDynamicMenuItem(
    (items: any[], target: any) => {
      const projectIndexReady = isProjectIndexCompleteForBlockReferences(vm);
      items.push({
        id: "ai-assistant-add-context",
        text: "加入对话",
        enabled: projectIndexReady,
        callback: () => {
          if (!target || !target.id || !projectIndexReady) return;

          const reference = createVirtualBlockLineReference(vm, target.id);
          window.dispatchEvent(
            new CustomEvent("ai-assistant-add-context", {
              detail: {
                referenceText: reference.text,
                error: reference.text ? undefined : reference.reason || "无法添加积木引用。",
                blockId: target.id,
              },
            }),
          );
        },
      });
      return items;
    },
    {
      targetNames: ["blocks"],
    },
  );

  return {
    dispose: () => {
      window.Blockly.ContextMenu.deleteDynamicMenuItem(menuItemId);
    },
  };
};
