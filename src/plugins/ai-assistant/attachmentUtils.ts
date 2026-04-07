import { AITools } from "./tools";
import { Attachment } from "./types";

const MAX_BLOCK_LABEL_COUNT = 3;

interface RuntimeBlockInfoItem {
  id: string;
  blocks?: Array<{
    info?: {
      opcode?: string;
      text?: string;
    };
  }>;
}

interface RuntimeWithBlockInfo {
  _blockInfo?: RuntimeBlockInfoItem[];
}

const getOpcodeLines = (content: string) =>
  content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("//") && line.includes("|"));

export const getAttachmentOpcodes = (attachment: Attachment) => {
  if (attachment.kind !== "workspace-ucf" && attachment.kind !== "workspace-ucf-range") {
    return [];
  }

  return getOpcodeLines(attachment.content)
    .map((line) => line.split("|")[0].trim())
    .filter(Boolean);
};

const resolveOpcodeText = (opcode: string, vm: PluginContext["vm"]) => {
  if (AITools.AllBlockInfo[opcode]) {
    return AITools.AllBlockInfo[opcode];
  }

  const runtime = vm.runtime as RuntimeWithBlockInfo;

  if (runtime._blockInfo) {
    for (const extInfo of runtime._blockInfo) {
      if (!extInfo.blocks) continue;
      for (const block of extInfo.blocks) {
        const fullOpcode = `${extInfo.id}_${block.info?.opcode}`;
        if (fullOpcode === opcode || block.info?.opcode === opcode) {
          return block.info?.text || opcode;
        }
      }
    }
  }

  return opcode;
};

const stripInterpolationPlaceholders = (text: string) => text.replace(/%\d+/g, "").replace(/\s+/g, " ").trim();

export const getAttachmentDisplayName = (attachment: Attachment, vm: PluginContext["vm"]) => {
  if (attachment.kind !== "workspace-ucf" && attachment.kind !== "workspace-ucf-range") {
    return attachment.name;
  }

  const opcodes = getAttachmentOpcodes(attachment);
  if (!opcodes.length) {
    return attachment.name;
  }

  const labels = opcodes
    .slice(0, MAX_BLOCK_LABEL_COUNT)
    .map((opcode) => stripInterpolationPlaceholders(resolveOpcodeText(opcode, vm)))
    .filter(Boolean);

  if (!labels.length) {
    return attachment.name;
  }

  return opcodes.length > 1 ? `${labels[0]}...` : labels[0];
};
