import { scratchToUCF } from "./ucf";

const BLOCK_ID_COMMENT_PREFIX = "// blockId:";

const splitTopLevelSegments = (value: string, delimiter: string) => {
  const result: string[] = [];
  let current = "";
  let depth = 0;

  for (let index = 0; index < value.length; index++) {
    const char = value[index];
    if (char === "[") depth++;
    if (char === "]") depth = Math.max(0, depth - 1);

    let matchesDelimiter = true;
    for (let offset = 0; offset < delimiter.length; offset++) {
      if (value[index + offset] !== delimiter[offset]) {
        matchesDelimiter = false;
        break;
      }
    }

    if (matchesDelimiter && depth === 0) {
      result.push(current);
      current = "";
      index += delimiter.length - 1;
      continue;
    }

    current += char;
  }

  result.push(current);
  return result;
};

const annotateSingleSequence = (ucf: string, blockIds: string[]) => {
  const lines = splitTopLevelSegments(ucf, "\n");
  let blockIndex = 0;

  return lines
    .map((line) => {
      const trimmedLine = line.trim();
      if (!trimmedLine) {
        return line;
      }

      if (trimmedLine === "]") {
        return line;
      }

      const blockId = blockIds[blockIndex++];
      if (!blockId) {
        return line;
      }

      return `${line} ${BLOCK_ID_COMMENT_PREFIX} ${blockId}`;
    })
    .join("\n");
};

export const toAnnotatedUCF = (sequences: Array<{ blocks: any[]; statementBlockIds: string[] }>) =>
  sequences
    .map(({ blocks, statementBlockIds }) => annotateSingleSequence(scratchToUCF(blocks), statementBlockIds))
    .join("\n\n");

export const stripAnnotatedUCFComments = (ucf: string) =>
  ucf
    .split("\n")
    .map((line) => line.replace(/\s*\/\/\s*blockId:\s*[^\s]+\s*$/i, ""))
    .join("\n");
