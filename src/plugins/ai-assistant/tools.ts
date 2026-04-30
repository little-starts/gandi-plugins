import { scratchToUCF, ucfToScratch } from "./ucf";
import { normalizeModelUCF, toAnnotatedUCF } from "./annotatedUcf";
import { getBlocksRangeUCF, replaceBlocksRangeByUCF, replaceScriptByUCF } from "./workspaceRangeTools";
import { setGetBlockInfoTool, setRuntime } from "./converter";
import scratchBlocksCatalog from "./scratch_blocks.json";

// This file contains tools for the AI assistant to interact with Scratch.

const NativeScratchBlockCatalog: Record<string, { block: any; menus: Record<string, any> }> = (() => {
  const result: Record<string, { block: any; menus: Record<string, any> }> = {};
  const root = scratchBlocksCatalog as any;

  for (const categoryGroup of Object.values(root?.categories || {})) {
    for (const categoryInfo of Object.values(categoryGroup as Record<string, any>)) {
      const blocks = Array.isArray((categoryInfo as any)?.blocks) ? (categoryInfo as any).blocks : [];
      const menus = (categoryInfo as any)?.menus && typeof (categoryInfo as any).menus === "object" ? (categoryInfo as any).menus : {};
      for (const block of blocks) {
        const opcode = String((block as any)?.opcode || "").trim();
        if (!opcode) continue;
        result[opcode] = { block, menus };
      }
    }
  }

  return result;
})();

export class AITools {
  static AllBlockInfo: Record<string, string> = {
    control_repeat: "重复执行 [TIMES] 次（TIMES：number）",
    control_repeat_until: "重复执行直到 [CONDITION]（CONDITION：Boolean）",
    control_while: "当 [CONDITION] 重复执行（CONDITION：Boolean）",
    control_for_each: "对 [VARIABLE] 遍历 [VALUE]（VARIABLE：string, VALUE：string）",
    control_forever: "重复执行",
    control_wait: "等待 [DURATION] 秒（DURATION：number）",
    control_wait_until: "等待直到 [CONDITION]（CONDITION：Boolean）",
    control_if: "如果 [CONDITION] 那么（CONDITION：Boolean）",
    control_if_else: "如果 [CONDITION] 那么 否则（CONDITION：Boolean）",
    control_stop: "停止 [STOP_OPTION]（STOP_OPTION：string）",
    control_start_as_clone: "当作为克隆体启动时",
    control_create_clone_of: "克隆 [CLONE_OPTION]（CLONE_OPTION：string）",
    control_delete_this_clone: "删除此克隆体",
    control_get_counter: "计数器",
    control_incr_counter: "计数器加 1",
    control_clear_counter: "计数器归零",
    control_all_at_once: "一口气执行",
    event_whentouchingobject: "当碰到 [TOUCHINGOBJECTMENU]（TOUCHINGOBJECTMENU：string）",
    event_broadcast: "广播 [BROADCAST_INPUT]（BROADCAST_INPUT：string）",
    event_broadcastandwait: "广播 [BROADCAST_INPUT] 并等待（BROADCAST_INPUT：string）",
    event_whengreaterthan: "当 [WHENGREATERTHANMENU] > [VALUE]（WHENGREATERTHANMENU：string, VALUE：number）",
    looks_say: "说 [MESSAGE]（MESSAGE：string）",
    looks_sayforsecs: "说 [MESSAGE] [SECS] 秒（MESSAGE：string, SECS：number）",
    looks_think: "思考 [MESSAGE]（MESSAGE：string）",
    looks_thinkforsecs: "思考 [MESSAGE] [SECS] 秒（MESSAGE：string, SECS：number）",
    looks_show: "显示",
    looks_hide: "隐藏",
    looks_hideallsprites: "隐藏所有角色",
    looks_switchcostumeto: "换成造型 [COSTUME]（COSTUME：string）",
    looks_switchbackdropto: "换成背景 [BACKDROP]（BACKDROP：string）",
    looks_switchbackdroptoandwait: "换成背景 [BACKDROP] 并等待（BACKDROP：string）",
    looks_nextcostume: "下一个造型",
    looks_nextbackdrop: "下一个背景",
    looks_changeeffectby: "将 [EFFECT] 特效增加 [CHANGE]（EFFECT：string, CHANGE：number）",
    looks_seteffectto: "将 [EFFECT] 特效设为 [VALUE]（EFFECT：string, VALUE：number）",
    looks_cleargraphiceffects: "清除图形特效",
    looks_changesizeby: "将大小增加 [CHANGE]（CHANGE：number）",
    looks_setsizeto: "将大小设为 [SIZE]（SIZE：number）",
    looks_changestretchby: "将伸缩增加 [CHANGE]（CHANGE：number）",
    looks_setstretchto: "将伸缩设为 [STRETCH]（STRETCH：number）",
    looks_gotofrontback: "移到最 [FRONT_BACK]（FRONT_BACK：string）",
    looks_goforwardbackwardlayers: "向 [FORWARD_BACKWARD] 移动 [NUM] 层（FORWARD_BACKWARD：string, NUM：number）",
    looks_size: "大小",
    looks_costumenumbername: "造型 [NUMBER_NAME]（NUMBER_NAME：string）",
    looks_backdropnumbername: "背景 [NUMBER_NAME]（NUMBER_NAME：string）",
    motion_movesteps: "移动 [STEPS] 步（STEPS：number）",
    motion_movegrids: "移动 [STEPS] 格（STEPS：number）",
    motion_gotoxy: "移到 x:[X] y:[Y]（X：number, Y：number）",
    motion_goto: "移到 [TO]（TO：string）",
    motion_turnright: "右转 [DEGREES] 度（DEGREES：number）",
    motion_turnleft: "左转 [DEGREES] 度（DEGREES：number）",
    motion_pointindirection: "面向 [DIRECTION] 度（DIRECTION：number）",
    motion_pointtowards: "面向 [TOWARDS]（TOWARDS：string）",
    motion_glidesecstoxy: "在 [SECS] 秒内滑行到 x:[X] y:[Y]（SECS：number, X：number, Y：number）",
    motion_glideto: "在 [SECS] 秒内滑行到 [TO]（SECS：number, TO：string）",
    motion_ifonedgebounce: "碰到边缘就反弹",
    motion_setrotationstyle: "将旋转方式设为 [STYLE]（STYLE：string）",
    motion_changexby: "将 x 增加 [DX]（DX：number）",
    motion_setx: "将 x 设为 [X]（X：number）",
    motion_changeyby: "将 y 增加 [DY]（DY：number）",
    motion_sety: "将 y 设为 [Y]（Y：number）",
    motion_xposition: "x 坐标",
    motion_yposition: "y 坐标",
    motion_direction: "方向",
    motion_scroll_right: "向右滚动 [DISTANCE]（DISTANCE：number）",
    motion_scroll_up: "向上滚动 [DISTANCE]（DISTANCE：number）",
    motion_align_scene: "对齐场景 [ALIGNMENT]（ALIGNMENT：string）",
    motion_xscroll: "场景 x 滚动",
    motion_yscroll: "场景 y 滚动",
    operator_add: "[NUM1] + [NUM2]（NUM1：number, NUM2：number）",
    operator_subtract: "[NUM1] - [NUM2]（NUM1：number, NUM2：number）",
    operator_multiply: "[NUM1] * [NUM2]（NUM1：number, NUM2：number）",
    operator_divide: "[NUM1] / [NUM2]（NUM1：number, NUM2：number）",
    operator_lt: "[OPERAND1] < [OPERAND2]（OPERAND1：null, OPERAND2：null）",
    operator_equals: "[OPERAND1] = [OPERAND2]（OPERAND1：null, OPERAND2：null）",
    operator_gt: "[OPERAND1] > [OPERAND2]（OPERAND1：null, OPERAND2：null）",
    operator_and: "[OPERAND1] 且 [OPERAND2]（OPERAND1：Boolean, OPERAND2：Boolean）",
    operator_or: "[OPERAND1] 或 [OPERAND2]（OPERAND1：Boolean, OPERAND2：Boolean）",
    operator_not: "不成立 [OPERAND]（OPERAND：Boolean）",
    operator_random: "在 [FROM] 到 [TO] 之间取随机数（FROM：number, TO：number）",
    operator_join: "连接 [STRING1] 和 [STRING2]（STRING1：string, STRING2：string）",
    operator_letter_of: "[STRING] 的第 [LETTER] 个字符（STRING：string, LETTER：number）",
    operator_length: "[STRING] 的长度（STRING：string）",
    operator_contains: "[STRING1] 包含 [STRING2]？（STRING1：string, STRING2：string）",
    operator_mod: "[NUM1] 除以 [NUM2] 的余数（NUM1：number, NUM2：number）",
    operator_round: "四舍五入 [NUM]（NUM：number）",
    operator_mathop: "[OPERATOR] [NUM]（OPERATOR：string, NUM：number）",
    sound_play: "播放声音 [SOUND_MENU]（SOUND_MENU：string）",
    sound_playuntildone: "播放声音 [SOUND_MENU] 等待播放完成（SOUND_MENU：string）",
    sound_stopallsounds: "停止所有声音",
    sound_seteffectto: "将 [EFFECT] 音效设为 [VALUE]（EFFECT：string, VALUE：number）",
    sound_changeeffectby: "将 [EFFECT] 音效增加 [VALUE]（EFFECT：string, VALUE：number）",
    sound_cleareffects: "清除音效",
    sound_sounds_menu: "声音 [SOUND_MENU]（SOUND_MENU：string）",
    sound_beats_menu: "节拍 [BEATS]（BEATS：number）",
    sound_effects_menu: "音效 [EFFECT]（EFFECT：string）",
    sound_setvolumeto: "将音量设为 [VOLUME]（VOLUME：number）",
    sound_changevolumeby: "将音量增加 [VOLUME]（VOLUME：number）",
    sound_volume: "音量",
    sensing_touchingobject: "碰到 [TOUCHINGOBJECTMENU]？（TOUCHINGOBJECTMENU：string）",
    sensing_touchingcolor: "碰到颜色 [COLOR]？（COLOR：string）",
    sensing_coloristouchingcolor: "颜色 [COLOR] 碰到 [COLOR2]？（COLOR：string, COLOR2：string）",
    sensing_distanceto: "到 [DISTANCETOMENU] 的距离（DISTANCETOMENU：string）",
    sensing_timer: "计时器",
    sensing_resettimer: "计时器归零",
    sensing_of: "[OBJECT] 的 [PROPERTY]（OBJECT：string, PROPERTY：string）",
    sensing_mousex: "鼠标 x",
    sensing_mousey: "鼠标 y",
    sensing_setdragmode: "将拖动方式设为 [DRAG_MODE]（DRAG_MODE：string）",
    sensing_mousedown: "鼠标按下？",
    sensing_keypressed: "按下 [KEY_OPTION] 键？（KEY_OPTION：string）",
    sensing_current: "当前 [CURRENTMENU]（CURRENTMENU：string）",
    sensing_dayssince2000: "距 2000 年的天数",
    sensing_loudness: "响度",
    sensing_loud: "响吗？",
    sensing_askandwait: "询问 [QUESTION] 并等待（QUESTION：string）",
    sensing_answer: "回答",
    sensing_username: "用户名",
    sensing_userid: "用户 id",
    data_variable: "变量 [VARIABLE]（VARIABLE：string）",
    data_setvariableto: "将 [VARIABLE] 设为 [VALUE]（VARIABLE：string, VALUE：string）",
    data_changevariableby: "将 [VARIABLE] 增加 [VALUE]（VARIABLE：string, VALUE：number）",
    data_hidevariable: "隐藏变量 [VARIABLE]（VARIABLE：string）",
    data_showvariable: "显示变量 [VARIABLE]（VARIABLE：string）",
    data_listcontents: "列表 [LIST]（LIST：string）",
    data_addtolist: "将 [ITEM] 加入列表 [LIST]（ITEM：string, LIST：string）",
    data_deleteoflist: "删除列表 [LIST] 的第 [INDEX] 项（LIST：string, INDEX：string）",
    data_deletealloflist: "删除列表 [LIST] 的全部项目（LIST：string）",
    data_insertatlist: "在列表 [LIST] 的第 [INDEX] 项前插入 [ITEM]（LIST：string, INDEX：string, ITEM：string）",
    data_replaceitemoflist: "将列表 [LIST] 的第 [INDEX] 项替换为 [ITEM]（LIST：string, INDEX：string, ITEM：string）",
    data_itemoflist: "列表 [LIST] 的第 [INDEX] 项（LIST：string, INDEX：string）",
    data_itemnumoflist: "[ITEM] 在列表 [LIST] 中的编号（ITEM：string, LIST：string）",
    data_lengthoflist: "列表 [LIST] 的长度（LIST：string）",
    data_listcontainsitem: "列表 [LIST] 包含 [ITEM]？（LIST：string, ITEM：string）",
    data_hidelist: "隐藏列表 [LIST]（LIST：string）",
    data_showlist: "显示列表 [LIST]（LIST：string）",
    procedures_definition: "自定义积木定义",
    procedures_call: "调用自定义积木 [PROCEDURE]（PROCEDURE：string）",
    procedures_call_with_return: "调用自定义积木 [PROCEDURE] 并返回（PROCEDURE：string）",
  };

  static BlockSearchAliases: Record<string, string[]> = {
    event_whenflagclicked: ["当绿旗被点击", "绿旗", "开始", "启动"],
    event_whenbroadcastreceived: ["当接收到广播", "接收到广播", "收到广播", "广播触发"],
    event_broadcast: ["广播", "发送广播", "广播消息"],
    event_broadcastandwait: ["广播并等待", "发送广播并等待"],
    procedures_definition: ["自定义积木定义", "定义积木", "定义函数"],
    procedures_call: ["调用自定义积木", "调用函数", "执行自定义积木"],
    procedures_call_with_return: ["调用自定义积木并返回", "返回值积木", "返回值函数"],
  };

  vm: any;

  constructor(vm: any) {
    this.vm = vm;
    if (vm && vm.runtime) {
      setRuntime(vm.runtime);
    }
    setGetBlockInfoTool((opcode: string) => this.getBlockInfo(opcode));
  }

  private _getTarget(targetId?: string) {
    return targetId ? this.vm.runtime.getTargetById(targetId) : this.vm.editingTarget;
  }

  private _getBlocks(targetId?: string) {
    const target = this._getTarget(targetId);
    if (!target?.blocks?._blocks) {
      return null;
    }

    return {
      target,
      blocks: target.blocks._blocks as Record<string, any>,
    };
  }

  private _getTopLevelBlocks(blocks: Record<string, any>) {
    return Object.values(blocks).filter((block: any) => block?.topLevel && !block?.parent);
  }

  private _collectScriptBlockIds(blocks: Record<string, any>, topBlockId: string) {
    const visited = new Set<string>();
    const order: string[] = [];
    const walkChain = (blockId?: string) => {
      let currentId = blockId;

      while (currentId && !visited.has(currentId)) {
        visited.add(currentId);
        order.push(currentId);
        const block = blocks[currentId];
        if (!block) {
          break;
        }

        if (block.inputs) {
          for (const input of Object.values(block.inputs) as any[]) {
            const inputBlockId = input?.block;
            if (inputBlockId && !visited.has(inputBlockId)) {
              walkChain(inputBlockId);
            }
          }
        }

        currentId = block.next;
      }
    };

    walkChain(topBlockId);
    return order;
  }

  private _collectStatementBlocks(blocks: Record<string, any>, topBlockId: string) {
    const statementBlockIds = this._collectScriptBlockIds(blocks, topBlockId);
    return {
      statementBlockIds,
      blocks: statementBlockIds.map((blockId) => blocks[blockId]).filter(Boolean),
    };
  }

  private _buildScriptSummary(blocks: Record<string, any>, topBlock: any, targetId: string) {
    const blockIds = this._collectScriptBlockIds(blocks, topBlock.id);
    const firstStatements = blockIds
      .slice(0, 6)
      .map((blockId) => blocks[blockId])
      .filter(Boolean)
      .map((block: any) => AITools.AllBlockInfo[block.opcode] || block.opcode);

    return {
      scriptId: topBlock.id,
      targetId,
      hatOpcode: topBlock.opcode,
      blockCount: blockIds.length,
      blockIds,
      summary: firstStatements.join(" -> "),
    };
  }

  private _resolveTopLevelScriptId(blocks: Record<string, any>, blockId?: string) {
    let currentId = blockId;
    while (currentId) {
      const block = blocks[currentId];
      if (!block) {
        break;
      }
      if (block.topLevel || !block.parent) {
        return currentId;
      }
      currentId = block.parent;
    }
    return null;
  }

  private _normalizeBlockText(value: any) {
    if (typeof value === "string") {
      return value;
    }

    if (Array.isArray(value)) {
      return value.join(" ");
    }

    return "";
  }

  private _matchKeyword(candidate: string, keyword?: string) {
    if (!keyword?.trim()) return true;
    const keywords = keyword.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const haystack = candidate.toLowerCase();
    return keywords.every((item) => haystack.includes(item));
  }

  private _getSearchTextForOpcode(opcode: string) {
    return [AITools.AllBlockInfo[opcode] || "", ...(AITools.BlockSearchAliases[opcode] || [])].join(" ");
  }

  listTargets() {
    const targets = Array.isArray(this.vm.runtime?.targets) ? this.vm.runtime.targets : [];
    return targets.map((target: any) => ({
      id: target.id,
      originalTargetId: target.originalTargetId || target.id,
      name: target.getName?.() || target.sprite?.name || target.id,
      isStage: Boolean(target.isStage),
      isEditingTarget: this.vm.editingTarget?.id === target.id,
    }));
  }

  getTopLevelScripts(targetId?: string) {
    const result = this._getBlocks(targetId);
    if (!result) return [];

    return this._getTopLevelBlocks(result.blocks)
      .map((block: any) => this._buildScriptSummary(result.blocks, block, result.target.id))
      .sort((left: any, right: any) => left.scriptId.localeCompare(right.scriptId));
  }

  getScriptUCF(scriptId: string, targetId?: string) {
    const result = this._getBlocks(targetId);
    if (!result) {
      return {
        found: false,
        error: "Target not found",
      };
    }

    const topBlock = result.blocks[scriptId];
    if (!topBlock) {
      return {
        found: false,
        error: "Script not found",
      };
    }

    const scriptBlockIds = this._collectScriptBlockIds(result.blocks, scriptId);
    const scriptBlocks = scriptBlockIds.map((blockId) => result.blocks[blockId]).filter(Boolean);

    return {
      found: true,
      scriptId,
      targetId: result.target.id,
      hatOpcode: topBlock.opcode,
      blockCount: scriptBlocks.length,
      ucf: toAnnotatedUCF([
        {
          blocks: scriptBlocks,
          statementBlockIds: scriptBlockIds,
        },
      ], this.vm.runtime),
    };
  }

  findBlocks(options?: { targetId?: string; opcode?: string; keyword?: string; scriptId?: string; limit?: number }) {
    const { targetId, opcode, keyword, scriptId, limit = 50 } = options || {};
    const targets = targetId
      ? [this._getTarget(targetId)].filter(Boolean)
      : this.listTargets().map((item) => this._getTarget(item.id));
    const matches: any[] = [];

    for (const target of targets) {
      if (!target?.blocks?._blocks) {
        continue;
      }

      const blocks = target.blocks._blocks as Record<string, any>;
      for (const block of Object.values(blocks) as any[]) {
        if (!block?.id || !block.opcode) {
          continue;
        }

        const topLevelScriptId = this._resolveTopLevelScriptId(blocks, block.id);
        if (scriptId && topLevelScriptId !== scriptId) {
          continue;
        }

        if (opcode && block.opcode !== opcode) {
          continue;
        }

        const fieldsText = Object.values(block.fields || {})
          .map((field: any) => this._normalizeBlockText(field?.value))
          .filter(Boolean)
          .join(" ");
        const procedureText = [
          block.mutation?.proccode,
          block.mutation?.argumentnames,
          block.mutation?.argumentdefaults,
        ]
          .map((value: any) => this._normalizeBlockText(value))
          .filter(Boolean)
          .join(" ");
        const textCandidate = [
          block.opcode,
          this._getSearchTextForOpcode(block.opcode),
          fieldsText,
          procedureText,
        ].join(" ");
        if (!this._matchKeyword(textCandidate, keyword)) {
          continue;
        }

        matches.push({
          blockId: block.id,
          opcode: block.opcode,
          targetId: target.id,
          targetName: target.getName?.() || target.sprite?.name || target.id,
          topLevelScriptId,
          parentId: block.parent || null,
          nextId: block.next || null,
          isTopLevel: Boolean(block.topLevel),
          fields: Object.fromEntries(
            Object.entries(block.fields || {}).map(([fieldName, fieldValue]: [string, any]) => [
              fieldName,
              fieldValue?.value,
            ]),
          ),
          text: AITools.AllBlockInfo[block.opcode] || block.opcode,
        });

        if (matches.length >= limit) {
          return matches;
        }
      }
    }

    return matches;
  }

  getAllExtensions() {
    const result = [];
    if (this.vm.runtime._blockInfo) {
      for (const extInfo of this.vm.runtime._blockInfo) {
        result.push({
          id: extInfo.id,
          name: extInfo.name,
        });
      }
    }
    return result;
  }

  getExtensionBlocks(extensionId: string) {
    const result = [];
    if (this.vm.runtime._blockInfo) {
      for (const extInfo of this.vm.runtime._blockInfo) {
        if (extInfo.id === extensionId && extInfo.blocks) {
          for (const block of extInfo.blocks) {
            if (block.info) {
              result.push({
                opcode: `${extInfo.id}_${block.info.opcode}`,
                text: block.info.text,
                blockType: block.info.blockType,
                arguments: block.info.arguments || {},
              });
            }
          }
        }
      }
    }
    return result;
  }

  private _getAllBlockIds() {
    const resultMap = new Map<string, string>();
    if (this.vm.runtime._primitives) {
      for (const [opcode, text] of Object.entries(AITools.AllBlockInfo)) {
        resultMap.set(opcode, text);
      }
    }

    if (this.vm.runtime._blockInfo) {
      for (const extInfo of this.vm.runtime._blockInfo) {
        const extId = extInfo.id;
        if (extInfo.blocks) {
          for (const block of extInfo.blocks) {
            if (block.info && block.info.opcode) {
              const fullOpcode = `${extId}_${block.info.opcode}`;
              const text = block.info.text || "";
              const args: string[] = [];
              if (block.info.arguments) {
                for (const [argName, argInfo] of Object.entries(block.info.arguments)) {
                  args.push(`${argName}：${(argInfo as any).type}`);
                }
              }
              const argsStr = args.length > 0 ? `（${args.join(", ")}）` : "";
              resultMap.set(fullOpcode, `${text}${argsStr}`);
            }
          }
        }
      }
    }
    return Object.fromEntries(resultMap);
  }

  private _normalizeBlockType(value: any) {
    const raw = String(value || "").toLowerCase();
    if (raw === "hat" || raw === "event") return "hat";
    if (raw === "reporter" || raw === "value") return "reporter";
    if (raw === "boolean" || raw === "predicate") return "boolean";
    if (raw === "command" || raw === "statement" || raw === "loop" || raw === "conditional") return "command";
    return "command";
  }

  private _getArgumentTypeMeta(typeValue: any) {
    const raw = String(typeValue || "").toLowerCase();
    if (!raw) return { inferred: undefined, asField: false };
    if (raw === "variable") return { inferred: "variable", asField: true };
    if (raw === "list") return { inferred: "list", asField: true };
    if (raw === "broadcast") return { inferred: "broadcast", asField: true };
    if (raw === "number" || raw === "n") return { inferred: "number", asField: false };
    if (raw === "boolean" || raw === "bool" || raw === "b") return { inferred: "boolean", asField: false };
    if (raw === "string" || raw === "s") return { inferred: "string", asField: false };
    return { inferred: raw, asField: false };
  }

  private _inferFieldType(fieldName: string, field: any) {
    const upperName = String(fieldName || "").toUpperCase();
    if (upperName.includes("VARIABLE")) return "variable";
    if (upperName.includes("LIST")) return "list";
    if (upperName.includes("BROADCAST")) return "broadcast";

    const ctorName = String(field?.constructor?.name || "").toLowerCase();
    if (ctorName.includes("variable")) return "variable";
    if (ctorName.includes("dropdown")) return "string";
    if (ctorName.includes("number")) return "number";
    return undefined;
  }

  private _normalizeMenuOptions(rawOptions: any) {
    if (!Array.isArray(rawOptions)) return null;
    const normalized = [];
    for (const item of rawOptions) {
      if (Array.isArray(item)) {
        normalized.push({ text: String(item[0] ?? ""), value: item[1] });
        continue;
      }
      if (item && typeof item === "object") {
        const text = (item as any).text ?? (item as any).label ?? (item as any).name ?? (item as any).value ?? "";
        const value = (item as any).value ?? text;
        normalized.push({ text: String(text), value });
        continue;
      }
      normalized.push({ text: String(item ?? ""), value: item });
    }
    return normalized;
  }

  private _readFieldMenuOptions(field: any) {
    if (!field || typeof field.getOptions !== "function") return null;
    try {
      return this._normalizeMenuOptions(field.getOptions(false));
    } catch {
      try {
        return this._normalizeMenuOptions(field.getOptions());
      } catch {
        return null;
      }
    }
  }

  private _createScratchWorkspace(scratchBlocks: any) {
    const mainWorkspace = scratchBlocks?.getMainWorkspace?.();
    if (mainWorkspace) {
      return { workspace: mainWorkspace, ownsWorkspace: false };
    }
    if (typeof scratchBlocks?.Workspace === "function") {
      return { workspace: new scratchBlocks.Workspace(), ownsWorkspace: true };
    }
    return { workspace: null, ownsWorkspace: false };
  }

  private _readMenuFieldMetaFromBlockOpcode(blockOpcode: string, preferredFieldName?: string) {
    const scratchBlocks = (window as any)?.Blockly || (window as any)?.ScratchBlocks || this.vm?.runtime?.scratchBlocks;
    if (!blockOpcode || !scratchBlocks?.Blocks?.[blockOpcode]) return null;

    const { workspace, ownsWorkspace } = this._createScratchWorkspace(scratchBlocks);
    if (!workspace || typeof workspace.newBlock !== "function") return null;

    let block: any = null;
    try {
      block = workspace.newBlock(blockOpcode);
      const inputList = Array.isArray(block?.inputList) ? block.inputList : [];
      let firstMeta: any = null;

      for (const input of inputList) {
        const fieldRow = Array.isArray(input?.fieldRow) ? input.fieldRow : [];
        for (const field of fieldRow) {
          if (typeof field?.getOptions !== "function") continue;

          let defaultValue: any;
          try {
            defaultValue = typeof field.getValue === "function" ? field.getValue() : undefined;
          } catch {
            defaultValue = undefined;
          }

          const fieldName = String(field?.name || preferredFieldName || "");
          const meta = {
            fieldName,
            type: this._inferFieldType(fieldName, field) || "string",
            menu: fieldName || preferredFieldName || null,
            defaultValue,
            menuOptions: this._readFieldMenuOptions(field),
          };
          if (preferredFieldName && fieldName === preferredFieldName) {
            return meta;
          }
          firstMeta = firstMeta || meta;
        }
      }
      return firstMeta;
    } catch {
      return null;
    } finally {
      try {
        block?.dispose?.();
      } catch {
        // ignore temp block disposal failures
      }
      if (ownsWorkspace) {
        try {
          workspace.dispose?.();
        } catch {
          // ignore temp workspace disposal failures
        }
      }
    }
  }

  private _menuConfigToOptions(menuConfig: any) {
    if (!menuConfig) return null;
    if (Array.isArray(menuConfig)) return this._normalizeMenuOptions(menuConfig);
    if (typeof menuConfig === "object") {
      if (Array.isArray((menuConfig as any).items)) {
        return this._normalizeMenuOptions((menuConfig as any).items);
      }
      if (Array.isArray((menuConfig as any).options)) {
        return this._normalizeMenuOptions((menuConfig as any).options);
      }
    }
    return null;
  }

  private _getNativeBlockCatalogEntry(opcode: string) {
    return NativeScratchBlockCatalog[opcode] || null;
  }

  private _fillFromNativeCatalog(opcode: string, result: any) {
    const entry = this._getNativeBlockCatalogEntry(opcode);
    if (!entry) return;

    result.found = true;
    result.extensionId = null;
    if (!result.blockType) {
      result.blockType = this._normalizeBlockType(entry.block?.blockType);
    }
    if (!result.text) {
      result.text = AITools.AllBlockInfo[opcode] || entry.block?.text || "";
    }

    const argumentsMap = entry.block?.arguments && typeof entry.block.arguments === "object" ? entry.block.arguments : {};
    for (const [argName, argInfo] of Object.entries(argumentsMap)) {
      const typedArg = argInfo as any;
      const typeMeta = this._getArgumentTypeMeta(typedArg?.type);
      const normalized = {
        type: typeMeta.inferred,
        defaultValue: typedArg?.defaultValue,
        menu: typedArg?.menu || null,
      };

      if (String(argName).startsWith("SUBSTACK")) {
        result.inputs[argName] = {
          ...normalized,
          type: normalized.type || "substack",
        };
        if (!result.substacks.includes(argName)) {
          result.substacks.push(argName);
        }
        continue;
      }

      const shouldUseField = Boolean(typedArg?.menu || typeMeta.asField);
      const target = shouldUseField ? result.fields : result.inputs;
      target[argName] = normalized;

      if (typedArg?.menu && entry.menus?.[typedArg.menu]) {
        result.menus = result.menus || {};
        result.menus[typedArg.menu] = {
          menuType: entry.menus[typedArg.menu]?.acceptReporters ? "placeable" : "non_placeable",
          options: this._menuConfigToOptions(entry.menus[typedArg.menu]),
          sources: [{ sourceType: shouldUseField ? "field" : "input", sourceName: argName }],
        };

        if (shouldUseField) {
          target[argName] = {
            ...target[argName],
            menuType: result.menus[typedArg.menu].menuType,
            menuOptions: result.menus[typedArg.menu].options,
          };
        }
      }
    }
  }

  private _hasMenuShadowBlock(opcode: string, menuName: string, activeRuntime: any) {
    const candidates = [`${opcode}_menu`, menuName, `${menuName}_menu`];
    return candidates.some((candidate) =>
      Boolean(
        (activeRuntime?._primitives && activeRuntime._primitives[candidate]) ||
          (activeRuntime?.scratchBlocks?.Blocks && activeRuntime.scratchBlocks.Blocks[candidate]) ||
          ((window as any)?.ScratchBlocks?.Blocks && (window as any).ScratchBlocks.Blocks[candidate]) ||
          ((window as any)?.Blockly?.Blocks && (window as any).Blockly.Blocks[candidate]),
      ),
    );
  }

  private _readMenuOptionsFromShadowBlock(opcode: string, menuName: string, activeRuntime: any) {
    const scratchBlocks =
      activeRuntime?.scratchBlocks || (window as any)?.Blockly || (window as any)?.ScratchBlocks;
    if (!scratchBlocks?.Blocks) return null;

    const candidates = [`${opcode}_menu`, menuName, `${menuName}_menu`].filter(
      (candidate) => scratchBlocks.Blocks[candidate],
    );
    if (candidates.length === 0) return null;
    const meta = this._readMenuFieldMetaFromBlockOpcode(candidates[0], menuName);
    return meta?.menuOptions || null;
  }

  private _readMenuFieldMetaFromInput(inputName: string, input: any) {
    const targetBlock =
      (typeof input?.connection?.targetBlock === "function" ? input.connection.targetBlock() : null) ||
      input?.connection?.targetConnection?.sourceBlock_ ||
      null;
    if (!targetBlock) return null;

    const inputList = Array.isArray(targetBlock.inputList) ? targetBlock.inputList : [];
    for (const targetInput of inputList) {
      const fieldRow = Array.isArray(targetInput?.fieldRow) ? targetInput.fieldRow : [];
      for (const field of fieldRow) {
        if (typeof field?.getOptions !== "function") continue;

        let defaultValue: any;
        try {
          defaultValue = typeof field.getValue === "function" ? field.getValue() : undefined;
        } catch {
          defaultValue = undefined;
        }

        return {
          type: this._inferFieldType(inputName, field) || "string",
          menu: String(field?.name || inputName),
          defaultValue,
          menuOptions: this._readFieldMenuOptions(field),
        };
      }
    }
    return null;
  }

  private _promoteNativeMenuInputsToFields(opcode: string, result: any) {
    const menuOpcode = `${opcode}_menu`;
    const menuMeta = this._readMenuFieldMetaFromBlockOpcode(menuOpcode);
    const fieldName = String(menuMeta?.fieldName || "").trim();
    if (!fieldName || !result.inputs[fieldName] || result.substacks.includes(fieldName)) {
      return;
    }

    const inputMeta = result.inputs[fieldName];
    result.fields[fieldName] = {
      ...(result.fields[fieldName] || {}),
      type: menuMeta?.type || inputMeta?.type || "string",
      menu: menuMeta?.menu || fieldName,
      defaultValue: menuMeta?.defaultValue,
      menuOptions: menuMeta?.menuOptions || null,
      menuType: "non_placeable",
    };
    delete result.inputs[fieldName];
  }

  private _moveMenuInputsToFields(result: any) {
    for (const [inputName, inputMeta] of Object.entries({ ...(result.inputs || {}) })) {
      const menuName = typeof (inputMeta as any)?.menu === "string" ? (inputMeta as any).menu : null;
      if (!menuName || result.substacks.includes(inputName)) {
        continue;
      }

      result.fields[inputName] = {
        ...(result.fields[inputName] || {}),
        ...(inputMeta as any),
      };
      delete result.inputs[inputName];
    }
  }

  private _dedupeFieldAndInputNames(result: any) {
    const fieldNames = new Set(Object.keys(result.fields || {}));
    for (const inputName of Object.keys({ ...(result.inputs || {}) })) {
      if (fieldNames.has(inputName)) {
        delete result.inputs[inputName];
      }
    }
  }

  private _isKnownOpcode(opcode: string) {
    if (!opcode) return false;
    if (this._getNativeBlockCatalogEntry(opcode)) return true;
    if (this.vm?.runtime?._primitives?.[opcode]) return true;
    if (AITools.AllBlockInfo[opcode]) return true;

    const scratchBlocks = (window as any)?.Blockly || (window as any)?.ScratchBlocks || this.vm?.runtime?.scratchBlocks;
    if (scratchBlocks?.Blocks && typeof scratchBlocks.Blocks[opcode] !== "undefined") {
      return true;
    }

    for (const extInfo of this.vm?.runtime?._blockInfo || []) {
      for (const block of extInfo?.blocks || []) {
        const fullOpcode = `${extInfo.id}_${block.info?.opcode}`;
        if (fullOpcode === opcode || block.info?.opcode === opcode) {
          return true;
        }
      }
    }
    return false;
  }

  private _enrichMenuMeta(opcode: string, result: any, extMenus: any, activeRuntime: any) {
    const menuSummary: Record<string, any> = result.menus && typeof result.menus === "object" ? result.menus : {};
    const ensureMeta = (entry: any, sourceType: "field" | "input", sourceName: string) => {
      if (!entry || typeof entry !== "object") return;
      const menuName = typeof entry.menu === "string" ? entry.menu : null;
      if (!menuName) return;

      const existingOptions = Array.isArray(entry.menuOptions) ? entry.menuOptions : null;
      const existingMenuType = typeof entry.menuType === "string" ? entry.menuType : null;
      const fromExt = this._menuConfigToOptions(extMenus?.[menuName]);
      const fromShadow = this._readMenuOptionsFromShadowBlock(opcode, menuName, activeRuntime);
      const menuOptions = existingOptions || fromExt || fromShadow || null;
      const placeable =
        existingMenuType === "placeable" ||
        (existingMenuType !== "non_placeable" &&
          (sourceType === "input" || this._hasMenuShadowBlock(opcode, menuName, activeRuntime)));

      entry.menuType = placeable ? "placeable" : "non_placeable";
      entry.menuOptions = menuOptions;

      if (!menuSummary[menuName]) {
        menuSummary[menuName] = {
          menuType: entry.menuType,
          options: menuOptions,
          sources: [],
        };
      } else {
        if (!menuSummary[menuName].options && menuOptions) {
          menuSummary[menuName].options = menuOptions;
        }
        if (menuSummary[menuName].menuType !== "placeable" && entry.menuType === "placeable") {
          menuSummary[menuName].menuType = "placeable";
        }
      }
      const hasSameSource = menuSummary[menuName].sources.some(
        (source: any) => source?.sourceType === sourceType && source?.sourceName === sourceName,
      );
      if (!hasSameSource) {
        menuSummary[menuName].sources.push({ sourceType, sourceName });
      }
    };

    for (const [fieldName, fieldMeta] of Object.entries(result.fields || {})) {
      ensureMeta(fieldMeta, "field", fieldName);
    }
    for (const [inputName, inputMeta] of Object.entries(result.inputs || {})) {
      ensureMeta(inputMeta, "input", inputName);
    }

    if (Object.keys(menuSummary).length > 0) {
      result.menus = menuSummary;
    }
  }

  private _fillFromScratchBlocks(opcode: string, result: any) {
    const scratchBlocks = (window as any)?.Blockly || (window as any)?.ScratchBlocks || this.vm?.runtime?.scratchBlocks;
    if (!scratchBlocks?.Blocks || typeof scratchBlocks?.Blocks?.[opcode] === "undefined") {
      return;
    }

    const mainWorkspace = scratchBlocks?.getMainWorkspace?.();
    let workspace = mainWorkspace;
    let ownsWorkspace = false;
    if (!workspace && typeof scratchBlocks?.Workspace === "function") {
      workspace = new scratchBlocks.Workspace();
      ownsWorkspace = true;
    }
    if (!workspace || typeof workspace.newBlock !== "function") {
      return;
    }

    let block: any = null;
    try {
      block = workspace.newBlock(opcode);
    } catch {
      return;
    }
    if (!block) return;

    try {
      if (!result.blockType) {
        if (block.outputConnection) {
          const outputChecks = block.outputConnection.check_ as string[] | null | undefined;
          const hasBooleanOutput = Array.isArray(outputChecks)
            ? outputChecks.some((v) => String(v).toLowerCase() === "boolean")
            : false;
          result.blockType = hasBooleanOutput ? "boolean" : "reporter";
        } else if (!block.previousConnection && block.nextConnection) {
          result.blockType = "hat";
        } else {
          result.blockType = "command";
        }
      }

      const inputList = Array.isArray(block.inputList) ? block.inputList : [];
      for (const input of inputList) {
        const inputName = input?.name ? String(input.name) : "";
        const fieldRow = Array.isArray(input?.fieldRow) ? input.fieldRow : [];

        for (const field of fieldRow) {
          const fieldName = field?.name ? String(field.name) : "";
          if (!fieldName) continue;

          let defaultValue: any;
          try {
            defaultValue = typeof field.getValue === "function" ? field.getValue() : undefined;
          } catch {
            defaultValue = undefined;
          }

          const hasMenu = typeof field?.getOptions === "function";
          result.fields[fieldName] = {
            type: this._inferFieldType(fieldName, field),
            menu: hasMenu ? fieldName : null,
            defaultValue,
            menuOptions: hasMenu ? this._readFieldMenuOptions(field) : null,
            menuType: hasMenu ? "non_placeable" : undefined,
          };
        }

        if (!inputName) continue;
        const existingFieldMeta = result.fields[inputName];
        if (existingFieldMeta && typeof existingFieldMeta === "object" && existingFieldMeta.menu) {
          delete result.inputs[inputName];
          continue;
        }

        const menuFieldMeta = this._readMenuFieldMetaFromInput(inputName, input);
        if (menuFieldMeta) {
          result.fields[inputName] = {
            ...(result.fields[inputName] || {}),
            ...menuFieldMeta,
          };
          delete result.inputs[inputName];
          continue;
        }

        const inputMeta: any = result.inputs[inputName] || { type: undefined, menu: null, defaultValue: undefined };
        const statementInputType =
          typeof scratchBlocks?.NEXT_STATEMENT === "number" ? scratchBlocks.NEXT_STATEMENT : undefined;
        const inputTypeText = String(input?.type ?? "").toLowerCase();
        const isStatementInput =
          inputName.startsWith("SUBSTACK") ||
          (statementInputType !== undefined && input?.type === statementInputType) ||
          inputTypeText.includes("statement");
        if (isStatementInput) {
          inputMeta.type = inputMeta.type || "substack";
          if (!result.substacks.includes(inputName)) {
            result.substacks.push(inputName);
          }
        } else {
          const check = input?.connection?.check_;
          if (Array.isArray(check) && check.length > 0) {
            inputMeta.type = check.join("|");
          } else if (!inputMeta.type) {
            inputMeta.type = "string|number";
          }
        }
        result.inputs[inputName] = inputMeta;
      }

      if (Object.keys(result.fields).length > 0 || Object.keys(result.inputs).length > 0) {
        result.found = true;
      }
    } finally {
      try {
        block.dispose?.();
      } catch {
        // ignore temp block disposal failures
      }
      if (ownsWorkspace) {
        try {
          workspace.dispose?.();
        } catch {
          // ignore temp workspace disposal failures
        }
      }
    }
  }

  private _fillFromAllBlockInfo(opcode: string, result: any) {
    const text = AITools.AllBlockInfo[opcode];
    if (!text) return;
    result.text = text;
    result.found = true;
    if (!result.blockType) {
      result.blockType = "command";
    }

    const matches = [...text.matchAll(/[（(]([^）)]*)[）)]/g)];
    if (matches.length === 0) return;
    const inside = String(matches[matches.length - 1]?.[1] ?? "").trim();
    if (!inside) return;

    const parts = inside.split(/[，,]/).map((x) => x.trim()).filter(Boolean);
    for (const part of parts) {
      const kv = part.split(/[：:]/);
      if (kv.length !== 2) continue;
      const argName = kv[0].trim();
      const typeMeta = this._getArgumentTypeMeta(kv[1].trim());
      const target = typeMeta.asField ? result.fields : result.inputs;
      target[argName] = {
        type: typeMeta.inferred,
        menu: typeMeta.asField ? argName : null,
        defaultValue: undefined,
      };
    }
  }

  private _applyNativeSubstackFallback(opcode: string, result: any) {
    const fallback: Record<string, string[]> = {
      control_repeat: ["SUBSTACK"],
      control_repeat_until: ["SUBSTACK"],
      control_while: ["SUBSTACK"],
      control_forever: ["SUBSTACK"],
      control_for_each: ["SUBSTACK"],
      control_if: ["SUBSTACK"],
      control_if_else: ["SUBSTACK", "SUBSTACK2"],
    };
    const names = fallback[opcode];
    if (!names) return;
    for (const name of names) {
      if (!result.substacks.includes(name)) {
        result.substacks.push(name);
      }
      result.inputs[name] = {
        ...(result.inputs[name] || {}),
        type: result.inputs[name]?.type || "substack",
        menu: result.inputs[name]?.menu ?? null,
      };
    }
  }

  searchBlocks(keyword: string) {
    const keywords = keyword.trim().toLowerCase().split(/\s+/);
    if (keywords.length === 0 || keywords[0] === "") return [];

    const blockIds = this._getAllBlockIds();
    const matches = [];

    for (const [opcode, rawText] of Object.entries(blockIds)) {
      const text = [String(rawText || ""), ...(AITools.BlockSearchAliases[opcode] || [])].join(" ").toLowerCase();
      const opcodeLower = opcode.toLowerCase();

      // 检查是否所有关键词都被包含在内
      const isMatch = keywords.every((kw) => text.includes(kw) || opcodeLower.includes(kw));

      if (isMatch) {
        matches.push({ opcode, text: rawText });
      }
    }
    return matches;
  }

  getAllPrimitiveBlocks() {
    // Return the whole native primitive blocks directly
    const result = [];
    for (const [opcode, text] of Object.entries(AITools.AllBlockInfo)) {
      result.push({ opcode, text });
    }
    return result;
  }

  getBlockInfo(opcode: string) {
    const requestedOpcode = String(opcode ?? "").trim();
    if (!requestedOpcode) {
      throw new Error("getBlockInfo: opcode 不能为空");
    }

    let resolvedOpcode = requestedOpcode;
    if (requestedOpcode.includes(".") && !this._isKnownOpcode(requestedOpcode)) {
      const fallbackOpcode = requestedOpcode.replace(/\./g, "_");
      if (fallbackOpcode !== requestedOpcode && this._isKnownOpcode(fallbackOpcode)) {
        resolvedOpcode = fallbackOpcode;
      }
    }

    const result: any = {
      opcode: resolvedOpcode,
      found: false,
      type: null,
      blockType: null,
      fields: {},
      inputs: {},
      substacks: [],
      text: null,
      extensionId: null,
    };

    if (this.vm.runtime._primitives && this.vm.runtime._primitives[resolvedOpcode]) {
      result.found = true;
    }

    this._fillFromNativeCatalog(resolvedOpcode, result);
    this._fillFromAllBlockInfo(resolvedOpcode, result);

    if (this.vm.runtime._blockInfo) {
      for (const extInfo of this.vm.runtime._blockInfo) {
        if (extInfo.blocks) {
          for (const block of extInfo.blocks) {
            const fullOpcode = `${extInfo.id}_${block.info?.opcode}`;
            if (fullOpcode === resolvedOpcode || block.info?.opcode === resolvedOpcode) {
              result.found = true;
              result.blockType = this._normalizeBlockType(block.info?.blockType);
              result.extensionId = extInfo.id || null;
              result.text = block.info?.text || "";

              if (block.info?.arguments) {
                for (const [argName, argInfo] of Object.entries(block.info.arguments)) {
                  const typedArg = argInfo as any;
                  const typeMeta = this._getArgumentTypeMeta(typedArg?.type);
                  const normalized = {
                    type: typeMeta.inferred,
                    defaultValue: typedArg?.defaultValue,
                    menu: typedArg?.menu || null,
                  };
                  if (String(argName).startsWith("SUBSTACK")) {
                    result.inputs[argName] = {
                      ...normalized,
                      type: normalized.type || "substack",
                    };
                    if (!result.substacks.includes(argName)) {
                      result.substacks.push(argName);
                    }
                  } else {
                    const shouldUseField = Boolean(typedArg?.menu || typeMeta.asField);
                    const target = shouldUseField ? result.fields : result.inputs;
                    target[argName] = normalized;
                  }
                }
              }

              if (extInfo?.menus && typeof extInfo.menus === "object") {
                const usedMenuNames = new Set<string>();
                for (const meta of Object.values(result.fields)) {
                  const menuName = (meta as any)?.menu;
                  if (typeof menuName === "string" && menuName) usedMenuNames.add(menuName);
                }
                for (const meta of Object.values(result.inputs)) {
                  const menuName = (meta as any)?.menu;
                  if (typeof menuName === "string" && menuName) usedMenuNames.add(menuName);
                }
                for (const menuName of usedMenuNames) {
                  if (extInfo.menus[menuName] !== undefined) {
                    result.menus = result.menus || {};
                    result.menus[menuName] = extInfo.menus[menuName];
                  }
                }
              }

              this._enrichMenuMeta(resolvedOpcode, result, extInfo?.menus, this.vm.runtime);
              break;
            }
          }
        }
      }
    }

    if (result.found && !result.extensionId) {
      this._fillFromScratchBlocks(resolvedOpcode, result);
      this._promoteNativeMenuInputsToFields(resolvedOpcode, result);
      this._applyNativeSubstackFallback(resolvedOpcode, result);
      this._moveMenuInputsToFields(result);
      this._enrichMenuMeta(resolvedOpcode, result, null, this.vm.runtime);
    }

    this._moveMenuInputsToFields(result);
    this._dedupeFieldAndInputNames(result);

    if (!result.found) {
      if (resolvedOpcode !== requestedOpcode) {
        throw new Error(`getBlockInfo: 未找到积木 opcode "${requestedOpcode}"，已自动尝试 "${resolvedOpcode}"`);
      }
      throw new Error(`getBlockInfo: 未找到积木 opcode "${requestedOpcode}"`);
    }

    result.type = result.found ? result.blockType : null;
    return result;
  }

  cleanUpBlocks(targetId?: string) {
    const target = targetId ? this.vm.runtime.getTargetById(targetId) : this.vm.editingTarget;
    if (!target) return false;

    const workspace = window.Blockly.getMainWorkspace() as Blockly.WorkspaceSvg | null;
    if (workspace && typeof workspace.cleanUp === "function") {
      try {
        workspace.cleanUp();
        return true;
      } catch (e) {
        console.error("Cleanup error:", e);
        return false;
      }
    }
    return false;
  }

  getWorkspaceUCF(targetId?: string) {
    const target = targetId ? this.vm.runtime.getTargetById(targetId) : this.vm.editingTarget;
    if (!target) return "";

    const blocks = target.blocks?._blocks as Record<string, any>;
    if (!blocks) return "";

    const sequences = this._getTopLevelBlocks(blocks).map((block: any) =>
      this._collectStatementBlocks(blocks, block.id),
    );
    return toAnnotatedUCF(sequences, this.vm.runtime);
  }

  getCustomBlocks(targetId?: string) {
    const target = targetId ? this.vm.runtime.getTargetById(targetId) : this.vm.editingTarget;
    if (!target) return [];

    const result = [];
    for (const block of Object.values(target.blocks._blocks) as any[]) {
      if (block.opcode !== "procedures_prototype") continue;

      result.push({
        opcode: block.opcode,
        proccode: block.mutation?.proccode || "",
        argumentids: (() => {
          try {
            return JSON.parse(block.mutation?.argumentids || "[]");
          } catch {
            return [];
          }
        })(),
        argumentnames: (() => {
          try {
            return JSON.parse(block.mutation?.argumentnames || "[]");
          } catch {
            return [];
          }
        })(),
        argumentdefaults: (() => {
          try {
            return JSON.parse(block.mutation?.argumentdefaults || "[]");
          } catch {
            return [];
          }
        })(),
        warp: String(block.mutation?.warp) === "true",
        isreporter: String(block.mutation?.isreporter) === "true",
        isglobal: String(block.mutation?.isglobal) === "true",
      });
    }

    return result;
  }

  getBlocksRangeUCF(startBlockId: string, endBlockId: string) {
    return getBlocksRangeUCF(
      this.vm,
      window.Blockly.getMainWorkspace() as Blockly.WorkspaceSvg,
      startBlockId,
      endBlockId,
    );
  }

  async replaceBlocksRangeByUCF(startBlockId: string, endBlockId: string, ucfString: string) {
    return replaceBlocksRangeByUCF(
      this.vm,
      window.Blockly.getMainWorkspace() as Blockly.WorkspaceSvg,
      startBlockId,
      endBlockId,
      ucfString,
    );
  }

  async replaceScriptByUCF(scriptId: string, ucfString: string) {
    return replaceScriptByUCF(this.vm, window.Blockly.getMainWorkspace() as Blockly.WorkspaceSvg, scriptId, ucfString);
  }

  async generateCodeFromUCF(ucfString: string, targetId?: string, x?: number, y?: number) {
    const target = targetId ? this.vm.runtime.getTargetById(targetId) : this.vm.editingTarget;
    if (!target) {
      return {
        success: false,
        error: "Target not found",
      };
    }

    console.log("[AI Tool Call] generateCodeFromUCF started. UCF String:", ucfString);
    let newBlocks;
    try {
      newBlocks = ucfToScratch(normalizeModelUCF(ucfString), { runtime: this.vm.runtime });
      console.log("[AI Tool Call] Parsed blocks array:", newBlocks);
    } catch (e) {
      console.error("[AI Tool Call] Error parsing UCF string:", e);
      return {
        success: false,
        error: e instanceof Error ? e.message : "Failed to parse UCF string",
      };
    }

    // Add blocks to target safely using the same method as block-sharing plugin
    const targetIdToUse = target.originalTargetId || target.id;
    console.log("[AI Tool Call] Sharing blocks to target:", targetIdToUse);

    try {
      await this.vm.shareBlocksToTarget(newBlocks, targetIdToUse);
      console.log("[AI Tool Call] Successfully shared blocks to target!");
      if (typeof this.vm.refreshWorkspace === "function") {
        this.vm.refreshWorkspace();
      } else {
        this.vm.emit("workspaceUpdate");
      }

      return {
        success: true,
        blockCount: newBlocks.length,
        ignoredPosition: x !== undefined || y !== undefined,
      };
    } catch (e) {
      console.error("[AI Tool Call] Failed to share blocks to target:", e);
      console.error("[AI Tool Call] Failing UCF String:", ucfString);
      console.error("[AI Tool Call] Failing Parsed Blocks:", newBlocks);
      return {
        success: false,
        error: e instanceof Error ? e.message : "Failed to share blocks to target",
      };
    }
  }
}
