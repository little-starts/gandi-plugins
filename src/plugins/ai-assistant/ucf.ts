/**
 * Ultra Compact Format (UCF) Converter for Scratch Blocks - V3 (AI-Friendly & Formatted)
 * Discards all IDs (block IDs, variable IDs, list IDs).
 * Supports multiline formatting, indentation, and spaces for human/AI readability.
 *
 * Syntax Rules:
 * - \n (Newline) separates blocks in a sequence.
 * - | (Pipe) separates attributes within a single block.
 * - [] (Brackets) encapsulate nested input sequences (like SUBSTACK).
 *
 * Format per line:
 * opcode | flags | fields | inputs | mutation
 * flags: S (Shadow), C:x:y (Coordinates), R (legacy compatibility for reporter-like blocks; usually optional)
 * fields: F:key=value,key2=value2
 * inputs: I:key=[nested_blocks],key2=...
 * mutation: M:key=value
 */

function esc(str) {
  return String(str)
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\p")
    .replace(/\[/g, "\\b")
    .replace(/\]/g, "\\B")
    .replace(/\n/g, "\\n")
    .replace(/,/g, "\\c")
    .replace(/=/g, "\\e");
}

function unesc(str) {
  return String(str)
    .replace(/\\e/g, "=")
    .replace(/\\c/g, ",")
    .replace(/\\n/g, "\n")
    .replace(/\\B/g, "]")
    .replace(/\\b/g, "[")
    .replace(/\\p/g, "|")
    .replace(/\\\\/g, "\\");
}

export function scratchToUCF(blocksArray: any[]) {
  const blocksObj: any = {};
  blocksArray.forEach((b) => (blocksObj[b.id] = b));

  const topLevelIds = blocksArray.filter((b) => b.topLevel).map((b) => b.id);

  function serializeBlock(blockId, indent) {
    const block = blocksObj[blockId];
    if (!block) return "";

    const parts = [block.opcode];

    const flags = [];
    if (block.shadow) flags.push("S");

    if (block.topLevel && block.x !== undefined && block.y !== undefined) {
      flags.push(`C:${Math.round(block.x)}:${Math.round(block.y)}`);
    }
    parts.push(flags.join(","));

    let fieldsStr = "";
    if (block.fields && Object.keys(block.fields).length > 0) {
      const fArr = [];
      for (const [key, field] of Object.entries(block.fields) as any) {
        const f = field as any;
        fArr.push(`${esc(key)}=${esc(f.value)}`);
      }
      fieldsStr = "F:" + fArr.join(",");
    }
    parts.push(fieldsStr);

    let inputsStr = "";
    if (block.inputs && Object.keys(block.inputs).length > 0) {
      const iArr = [];
      for (const [key, input] of Object.entries(block.inputs) as any) {
        const activeId = (input as any).block;
        const shadowId = (input as any).shadow;

        let valStr = "";
        const isSubstack = key.includes("SUBSTACK");
        const innerIndent = indent + "  ";

        const wrapSequence = (id) => {
          if (isSubstack) {
            return `[\n${serializeSequence(id, innerIndent)}\n${indent}]`;
          } else {
            return `[${serializeSequence(id, "")}]`;
          }
        };

        if (activeId === shadowId && activeId) {
          valStr = wrapSequence(activeId);
        } else if (activeId && shadowId) {
          valStr = `B${wrapSequence(activeId)}S${wrapSequence(shadowId)}`;
        } else if (activeId) {
          valStr = wrapSequence(activeId);
        } else if (shadowId) {
          valStr = wrapSequence(shadowId);
        }
        iArr.push(`${esc(key)}=${valStr}`);
      }
      inputsStr = "I:" + iArr.join(", ");
    }
    parts.push(inputsStr);

    let mutStr = "";
    if (block.mutation && Object.keys(block.mutation).length > 0) {
      const mArr = [];
      for (const [key, val] of Object.entries(block.mutation)) {
        if (key === "dynamicargids" || key === "dynamicargtypes") continue;
        if (key === "children" && Array.isArray(val) && val.length === 0) continue;

        let valStr = typeof val === "object" ? JSON.stringify(val) : String(val);
        // Custom block mutation array cleanup for readability
        if (
          ["argumentids", "argumentnames", "argumentdefaults"].includes(key) &&
          valStr.startsWith("[") &&
          valStr.endsWith("]")
        ) {
          try {
            const arr = JSON.parse(valStr);
            valStr = arr.map((a) => String(a).replace(/;/g, "\\;")).join(";"); // Use semicolon separated string instead of JSON array string
          } catch (e) {
            void e;
          }
        }

        mArr.push(`${esc(key)}=${esc(valStr)}`);
      }
      if (mArr.length > 0) {
        mutStr = "M:" + mArr.join(",");
      }
    }
    parts.push(mutStr);

    while (parts.length > 1 && parts[parts.length - 1] === "") {
      parts.pop();
    }

    return indent + parts.join(" | ");
  }

  function serializeSequence(firstBlockId, indent = "") {
    const lines = [];
    let currentId = firstBlockId;

    while (currentId) {
      lines.push(serializeBlock(currentId, indent));
      const block = blocksObj[currentId];
      currentId = block ? block.next : null;
    }
    return lines.join("\n");
  }

  const finalStr = [];
  for (let i = 0; i < topLevelIds.length; i++) {
    finalStr.push(serializeSequence(topLevelIds[i]));
  }

  return finalStr.join("\n\n");
}

export function ucfToScratch(ucfString: string) {
  const blocksArray: any[] = [];
  const varIdMap: any = {}; // Maps variable/list names to 20-char random IDs

  const reporterOpcodeSet = new Set([
    "control_get_counter",
    "colour_picker",
    "data_itemnumoflist",
    "data_itemoflist",
    "data_lengthoflist",
    "data_listcontainsitem",
    "data_listcontents",
    "data_variable",
    "looks_backdropnumbername",
    "looks_costumenumbername",
    "looks_size",
    "math_angle",
    "math_integer",
    "math_number",
    "math_positive_number",
    "math_whole_number",
    "motion_direction",
    "motion_xposition",
    "motion_yposition",
    "procedures_call_with_return",
    "procedures_prototype",
    "sensing_answer",
    "sensing_coloristouchingcolor",
    "sensing_current",
    "sensing_dayssince2000",
    "sensing_distanceto",
    "sensing_keypressed",
    "sensing_loud",
    "sensing_loudness",
    "sensing_mousedown",
    "sensing_mousex",
    "sensing_mousey",
    "sensing_of",
    "sensing_timer",
    "sensing_touchingcolor",
    "sensing_touchingobject",
    "sensing_userid",
    "sensing_username",
    "sound_volume",
    "text",
  ]);

  const isReporterLikeBlock = (block: any) => {
    if (!block) return false;
    if (block._isReporter) return true;
    if (block.opcode?.startsWith("operator_")) return true;
    if (block.opcode?.startsWith("argument_reporter_")) return true;
    if (reporterOpcodeSet.has(block.opcode)) return true;
    if (block.mutation && String(block.mutation.isreporter) === "true") return true;
    return false;
  };

  // Auto-balance brackets to prevent parser failures from AI hallucinations
  let openCount = (ucfString.match(/\[/g) || []).length;
  let closeCount = (ucfString.match(/\]/g) || []).length;
  while (openCount > closeCount) {
    ucfString += "]";
    closeCount++;
  }
  while (closeCount > openCount) {
    ucfString = "[" + ucfString;
    openCount++;
  }

  // Fix AI-generated formatting: remove newlines/spaces between = and [
  ucfString = ucfString.replace(/=\s+\[/g, "=[");
  ucfString = ucfString.replace(/=\s+B\s*\[/g, "=B[");
  ucfString = ucfString.replace(/\]\s*S\s*\[/g, "]S[");

  // Auto-correct AI hallucinations where it incorrectly uses inputs instead of fields for variables/lists
  ucfString = ucfString.replace(/I:VARIABLE=\[text\s*\|\s*S\s*\|\s*F:TEXT=([^\]]+)\]/g, "F:VARIABLE=$1");
  ucfString = ucfString.replace(/I:LIST=\[text\s*\|\s*S\s*\|\s*F:TEXT=([^\]]+)\]/g, "F:LIST=$1");
  ucfString = ucfString.replace(/I:BROADCAST_INPUT=\[text\s*\|\s*S\s*\|\s*F:TEXT=([^\]]+)\]/g, "F:BROADCAST_INPUT=$1");

  function generateId() {
    const chars = "!#%()*+,-./:;=?@[]^_`{|}~ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let id = "";
    for (let i = 0; i < 20; i++) id += chars.charAt(Math.floor(Math.random() * chars.length));
    return id;
  }

  function splitRespectingBrackets(str, delimiter) {
    const result = [];
    let current = "";
    let depth = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str[i];

      // Track bracket depth, but ignore escaped brackets like \b or \B if they were to exist
      // Our escaper uses \b and \B but since this parses the raw string before unesc,
      // actual '[' and ']' characters DO represent structural depth.
      if (char === "[") depth++;
      else if (char === "]") depth--;

      if (depth < 0) depth = 0; // Prevent catastrophic parsing failures from mismatched brackets

      // If we are at depth 0 and see the delimiter, split it.
      // Wait, what if delimiter is multiple characters? (like '\n\n')
      // In our usage here, delimiter is either '\n' or '|' or ','
      let matchDelimiter = true;
      for (let j = 0; j < delimiter.length; j++) {
        if (str[i + j] !== delimiter[j]) {
          matchDelimiter = false;
          break;
        }
      }

      if (matchDelimiter && depth === 0) {
        result.push(current);
        current = "";
        i += delimiter.length - 1; // skip the rest of the delimiter
      } else {
        current += char;
      }
    }
    result.push(current);
    return result;
  }

  function parseSequence(seqStr, parentId = null, isTopLevel = false) {
    if (!seqStr || seqStr.trim() === "") return null;

    let cleanSeqStr = seqStr.trim();
    let changed = true;
    while (cleanSeqStr && changed) {
      changed = false;
      if (cleanSeqStr.endsWith("|")) {
        cleanSeqStr = cleanSeqStr.substring(0, cleanSeqStr.length - 1).trim();
        changed = true;
      }
      if (cleanSeqStr.startsWith("[") && cleanSeqStr.endsWith("]")) {
        cleanSeqStr = cleanSeqStr.substring(1, cleanSeqStr.length - 1).trim();
        changed = true;
      }
    }

    const blockLines = splitRespectingBrackets(cleanSeqStr, "\n")
      .map((l) => l.trim())
      .filter((l) => l !== "");
    if (blockLines.length === 0) return null;

    let firstId = null;
    let prevId = null;

    for (let i = 0; i < blockLines.length; i++) {
      const line = blockLines[i];
      const parts = splitRespectingBrackets(line, "|").map((p) => p.trim());
      let opcode = parts[0].trim();

      // Extra fault tolerance: if opcode still starts with '[' due to imbalanced brackets, strip it
      if (opcode.startsWith("[")) opcode = opcode.substring(1).trim();

      const currentId = generateId();
      if (i === 0) firstId = currentId;

      const block: any = {
        id: currentId,
        opcode: opcode,
        parent: i === 0 ? parentId : prevId,
        next: null,
        topLevel: isTopLevel && i === 0,
        shadow: false,
        inputs: {},
        fields: {},
        _isReporter: false, // Mark reporter flag
      };

      for (let j = 1; j < parts.length; j++) {
        const part = parts[j];
        if (!part) continue;

        if (part === "S" || part.startsWith("S,") || part.startsWith("C:") || part === "R" || part.startsWith("R,")) {
          const flags = part.split(",");
          for (const flag of flags) {
            if (flag === "S") block.shadow = true;
            else if (flag === "R") block._isReporter = true;
            else if (flag.startsWith("C:")) {
              const [, x, y] = flag.split(":");
              block.x = parseFloat(x);
              block.y = parseFloat(y);
            }
          }
        } else if (part.startsWith("F:")) {
          const fieldsStr = part.substring(2);
          if (fieldsStr) {
            const pairs = splitRespectingBrackets(fieldsStr, ",");
            for (const pair of pairs) {
              const eqIdx = pair.indexOf("=");
              if (eqIdx !== -1) {
                const key = unesc(pair.substring(0, eqIdx).trim());
                const val = unesc(pair.substring(eqIdx + 1).trim());

                // For Scratch variables and lists, the 'id' field must not conflict with other things,
                // but if we use the name as ID, it usually auto-binds in Scratch if the variable exists.
                // Alternatively, we can let Scratch generate the ID if it's missing, but Scratch expects an ID.
                const fieldObj: any = { name: key, value: val };
                if (key === "LIST" || key === "LIST_MENU") {
                  if (!varIdMap[`list_${val}`]) varIdMap[`list_${val}`] = generateId();
                  fieldObj.id = varIdMap[`list_${val}`];
                  fieldObj.variableType = "list";
                } else if (key === "VARIABLE") {
                  if (!varIdMap[`var_${val}`]) varIdMap[`var_${val}`] = generateId();
                  fieldObj.id = varIdMap[`var_${val}`];
                  fieldObj.variableType = "";
                } else {
                  fieldObj.id = val;
                }

                block.fields[key] = fieldObj;
              }
            }
          }
        } else if (part.startsWith("I:")) {
          const inputsStr = part.substring(2);
          if (inputsStr) {
            // Because AI sometimes puts a space after commas (e.g. `I:A=..., I:B=...`)
            // which becomes ` I:B=...` after splitRespectingBrackets, we need to make sure we handle it
            const pairs = splitRespectingBrackets(inputsStr, ",");
            for (let pair of pairs) {
              pair = pair.trim();
              if (pair.startsWith("I:")) pair = pair.substring(2); // Strip accidental 'I:' if AI repeated it after comma

              const eqIdx = pair.indexOf("=");
              if (eqIdx !== -1) {
                const key = unesc(pair.substring(0, eqIdx).trim());
                const valStr = pair.substring(eqIdx + 1).trim();

                if (valStr.startsWith("B[") && valStr.includes("]S[")) {
                  const splitIdx = valStr.lastIndexOf("]S[");
                  const bContent = valStr.substring(1, splitIdx + 1);
                  const sContent = valStr.substring(splitIdx + 2);

                  const blockId = parseSequence(bContent, currentId, false);
                  const shadowId = parseSequence(sContent, currentId, false);
                  block.inputs[key] = { name: key, block: blockId, shadow: shadowId };
                } else if (valStr.startsWith("[")) {
                  const childId = parseSequence(valStr, currentId, false);

                  let isChildShadow = false;
                  const childBlock = blocksArray.find((b) => b.id === childId);
                  if (childBlock && childBlock.shadow) {
                    isChildShadow = true;
                  }
                  block.inputs[key] = { name: key, block: childId, shadow: isChildShadow ? childId : null };
                }
              }
            }
          }
        } else if (part.startsWith("M:")) {
          const mutStr = part.substring(2);
          if (mutStr) {
            block.mutation = {};
            const pairs = splitRespectingBrackets(mutStr, ",");
            for (const pair of pairs) {
              const eqIdx = pair.indexOf("=");
              if (eqIdx !== -1) {
                const key = unesc(pair.substring(0, eqIdx).trim());
                const valRaw = unesc(pair.substring(eqIdx + 1).trim());

                if (["argumentids", "argumentnames", "argumentdefaults"].includes(key)) {
                  // Restore arrays for custom blocks, handling escaped semicolons
                  if (valRaw.startsWith("[") && valRaw.endsWith("]")) {
                    try {
                      JSON.parse(valRaw);
                      block.mutation[key] = valRaw;
                    } catch (e) {
                      block.mutation[key] = "[]";
                    }
                  } else {
                    const arr = valRaw === "" ? [] : valRaw.split(/(?<!\\);/).map((s) => s.replace(/\\;/g, ";"));
                    block.mutation[key] = JSON.stringify(arr);
                  }
                } else {
                  try {
                    block.mutation[key] = JSON.parse(valRaw);
                  } catch (e) {
                    block.mutation[key] = valRaw;
                  }
                }
              }
            }
          }
        }
      }

      blocksArray.push(block);

      if (prevId) {
        const prevBlock = blocksArray.find((b) => b.id === prevId);
        // Reporter-like blocks cannot have a next block.
        // Explicit R remains supported for compatibility, but should not be required.
        if (prevBlock) {
          if (!isReporterLikeBlock(prevBlock)) {
            prevBlock.next = currentId;
          }
        }
      }

      // Make sure ANY block with a mutation has a tagName
      if (block.mutation && !block.mutation.tagName) {
        block.mutation.tagName = "mutation";
      }
      if (block.mutation && block.mutation.children === undefined) {
        block.mutation.children = [];
      }

      // Auto-reconstruct Gandi dynamic arguments
      const dynamicKeys = Object.keys(block.inputs).filter((k) => k.startsWith("DYNAMIC_ARGS"));
      if (dynamicKeys.length > 0) {
        dynamicKeys.sort((a, b) => {
          const numA = parseInt(a.replace("DYNAMIC_ARGS", ""), 10);
          const numB = parseInt(b.replace("DYNAMIC_ARGS", ""), 10);
          return (isNaN(numA) ? 0 : numA) - (isNaN(numB) ? 0 : numB);
        });
        block.mutation.dynamicargids = dynamicKeys;
        block.mutation.dynamicargtypes = dynamicKeys.map(() => "s");
      }

      // Auto-reconstruct Scratch custom block mutations
      if (
        block.opcode === "procedures_prototype" ||
        block.opcode === "procedures_call" ||
        block.opcode === "procedures_call_with_return" ||
        block.opcode === "procedures_return"
      ) {
        if (!block.mutation) block.mutation = {};
        block.mutation.tagName = "mutation";
        if (block.mutation.children === undefined) block.mutation.children = [];

        if (block.mutation.argumentids === undefined) block.mutation.argumentids = "[]";
        if (block.mutation.argumentnames === undefined && block.opcode === "procedures_prototype")
          block.mutation.argumentnames = "[]";
        if (block.mutation.argumentdefaults === undefined && block.opcode === "procedures_prototype")
          block.mutation.argumentdefaults = "[]";

        if (block.mutation.warp === undefined) block.mutation.warp = "false";
        // Convert boolean true/false to strings as expected by Blockly XML parser
        if (typeof block.mutation.warp === "boolean") block.mutation.warp = String(block.mutation.warp);

        if (
          block.opcode === "procedures_prototype" ||
          block.opcode === "procedures_call" ||
          block.opcode === "procedures_call_with_return"
        ) {
          if (block.mutation.isreporter === undefined)
            block.mutation.isreporter = block.opcode === "procedures_call_with_return" ? "true" : "false";
          if (typeof block.mutation.isreporter === "boolean")
            block.mutation.isreporter = String(block.mutation.isreporter);

          if (block.mutation.isglobal === undefined) block.mutation.isglobal = "false";
          if (typeof block.mutation.isglobal === "boolean") block.mutation.isglobal = String(block.mutation.isglobal);

          if (block.mutation.targetid === undefined) block.mutation.targetid = "null";
          if (block.opcode === "procedures_prototype" && block.mutation.type === undefined)
            block.mutation.type = "procedures_prototype";
        }

        if (block.opcode === "procedures_prototype") {
          try {
            const argIds = JSON.parse(block.mutation.argumentids || "[]");
            const argNames = JSON.parse(block.mutation.argumentnames || "[]");
            const proccode = block.mutation.proccode || "";

            const argTypes = [];
            let match;
            const regex = /(%[sbn])/g;
            while ((match = regex.exec(proccode)) !== null) {
              argTypes.push(match[1]);
            }

            for (let i = 0; i < argIds.length; i++) {
              const argId = argIds[i];
              if (!block.inputs[argId]) {
                const argName = argNames[i] || "";
                const argType = argTypes[i] || "%s";
                const reporterOpcode =
                  argType === "%b" ? "argument_reporter_boolean" : "argument_reporter_string_number";
                const reporterId = generateId();

                const reporterBlock = {
                  id: reporterId,
                  opcode: reporterOpcode,
                  parent: block.id,
                  next: null,
                  topLevel: false,
                  shadow: true,
                  inputs: {},
                  fields: {
                    VALUE: {
                      name: "VALUE",
                      value: argName,
                    },
                  },
                };
                blocksArray.push(reporterBlock);
                block.inputs[argId] = {
                  name: argId,
                  block: reporterId,
                  shadow: reporterId,
                };
              }
            }
          } catch (e) {
            // Ignore parse errors
          }
        }
      }

      prevId = currentId;
      if (block._isReporter !== undefined) {
        delete block._isReporter;
      }
    }

    return firstId;
  }

  const topLevelScripts = splitRespectingBrackets(ucfString, "\n\n");
  for (const script of topLevelScripts) {
    const cleanScript = script
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    if (cleanScript.trim()) {
      parseSequence(cleanScript, null, true);
    }
  }

  // Clean up missing references to prevent 'Cannot read properties of undefined (reading 'xml')'
  const validIds = new Set(blocksArray.map((b) => b.id));
  for (const block of blocksArray) {
    if (block.next && !validIds.has(block.next)) block.next = null;
    if (block.parent && !validIds.has(block.parent)) block.parent = null;
    if (block.inputs) {
      for (const key in block.inputs) {
        const input = block.inputs[key];
        if (input.block && !validIds.has(input.block)) input.block = null;
        if (input.shadow && !validIds.has(input.shadow)) input.shadow = null;
      }
    }

    // Auto-fill missing fields for primitive reporters
    if (block.opcode === "text" && !block.fields.TEXT) {
      block.fields.TEXT = { name: "TEXT", value: "" };
    } else if (
      ["math_number", "math_positive_number", "math_whole_number", "math_integer", "math_angle"].includes(
        block.opcode,
      ) &&
      !block.fields.NUM
    ) {
      block.fields.NUM = { name: "NUM", value: "0" };
    } else if (block.opcode === "colour_picker" && !block.fields.COLOUR) {
      block.fields.COLOUR = { name: "COLOUR", value: "#9966FF" };
    }

    // Auto-fill missing required inputs for common statement blocks
    const ensureInputShadow = (key, shadowOpcode, fieldName, defaultValue) => {
      if (!block.inputs[key]) {
        const shadowId = generateId();
        const shadowBlock = {
          id: shadowId,
          opcode: shadowOpcode,
          parent: block.id,
          next: null,
          topLevel: false,
          shadow: true,
          inputs: {},
          fields: {
            [fieldName]: { name: fieldName, value: defaultValue },
          },
        };
        blocksArray.push(shadowBlock);
        validIds.add(shadowId);
        block.inputs[key] = { name: key, block: shadowId, shadow: shadowId };
        return;
      }

      if (!block.inputs[key].shadow) {
        const shadowId = generateId();
        const shadowBlock = {
          id: shadowId,
          opcode: shadowOpcode,
          parent: block.id,
          next: null,
          topLevel: false,
          shadow: true,
          inputs: {},
          fields: {
            [fieldName]: { name: fieldName, value: defaultValue },
          },
        };
        blocksArray.push(shadowBlock);
        validIds.add(shadowId);
        block.inputs[key].shadow = shadowId;
        if (!block.inputs[key].block) {
          block.inputs[key].block = shadowId;
        }
      }
    };

    if (block.opcode === "data_setvariableto" || block.opcode === "data_changevariableby") {
      ensureInputShadow(
        "VALUE",
        block.opcode === "data_setvariableto" ? "text" : "math_number",
        block.opcode === "data_setvariableto" ? "TEXT" : "NUM",
        block.opcode === "data_setvariableto" ? "" : "1",
      );
    } else if (block.opcode === "data_addtolist") {
      ensureInputShadow("ITEM", "text", "TEXT", "thing");
    } else if (block.opcode === "data_insertatlist") {
      ensureInputShadow("ITEM", "text", "TEXT", "thing");
      ensureInputShadow("INDEX", "math_integer", "NUM", "1");
    } else if (block.opcode === "data_replaceitemoflist") {
      ensureInputShadow("INDEX", "math_integer", "NUM", "1");
      ensureInputShadow("ITEM", "text", "TEXT", "thing");
    } else if (block.opcode === "data_itemoflist" || block.opcode === "data_deleteoflist") {
      ensureInputShadow("INDEX", "math_integer", "NUM", "1");
    } else if (block.opcode === "data_itemnumoflist") {
      ensureInputShadow("ITEM", "text", "TEXT", "thing");
    } else if (block.opcode === "looks_say" || block.opcode === "looks_think") {
      ensureInputShadow("MESSAGE", "text", "TEXT", "Hello!");
    } else if (block.opcode === "procedures_return") {
      ensureInputShadow("RETURN", "text", "TEXT", "");
    } else if (block.opcode === "procedures_call" || block.opcode === "procedures_call_with_return") {
      if (block.mutation && block.mutation.argumentids) {
        try {
          const argIds = JSON.parse(block.mutation.argumentids);
          for (const argId of argIds) {
            ensureInputShadow(argId, "text", "TEXT", "");
          }
        } catch (e) {
          // ignore
        }
      }
    } else if (block.opcode.startsWith("operator_")) {
      const op = block.opcode;
      if (
        [
          "operator_add",
          "operator_subtract",
          "operator_multiply",
          "operator_divide",
          "operator_mod",
          "operator_random",
        ].includes(op)
      ) {
        ensureInputShadow("NUM1", "math_number", "NUM", "");
        ensureInputShadow("NUM2", "math_number", "NUM", "");
      } else if (["operator_gt", "operator_lt", "operator_equals"].includes(op)) {
        ensureInputShadow("OPERAND1", "text", "TEXT", "");
        ensureInputShadow("OPERAND2", "text", "TEXT", "");
      } else if (["operator_and", "operator_or"].includes(op)) {
        // these usually take boolean blocks, but we can't easily auto-fill boolean shadow, Scratch uses empty holes, so we can skip
      } else if (op === "operator_not") {
        // skip
      } else if (["operator_join", "operator_contains"].includes(op)) {
        ensureInputShadow("STRING1", "text", "TEXT", "");
        ensureInputShadow("STRING2", "text", "TEXT", "");
      } else if (op === "operator_letter_of") {
        ensureInputShadow("LETTER", "math_whole_number", "NUM", "1");
        ensureInputShadow("STRING", "text", "TEXT", "apple");
      } else if (op === "operator_length") {
        ensureInputShadow("STRING", "text", "TEXT", "apple");
      } else if (op === "operator_round" || op === "operator_mathop") {
        ensureInputShadow("NUM", "math_number", "NUM", "");
      }
    }
  }

  return blocksArray;
}
