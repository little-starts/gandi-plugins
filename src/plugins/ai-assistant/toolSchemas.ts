export const scratchToolSchemas = [
  {
    type: "function",
    function: {
      name: "listTargets",
      description: "List all stage and sprite targets in the current project.",
      parameters: {
        type: "object",
        properties: {},
      },
    },
  },
  {
    type: "function",
    function: {
      name: "getTopLevelScripts",
      description: "Get a structured list of top-level scripts for a target.",
      parameters: {
        type: "object",
        properties: {
          targetId: {
            type: "string",
            description: "The ID of the target. If omitted, uses the current editing target.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "getScriptUCF",
      description: "Get the UCF for a specific top-level script by scriptId.",
      parameters: {
        type: "object",
        properties: {
          scriptId: {
            type: "string",
            description: "The top-level script ID.",
          },
          targetId: {
            type: "string",
            description: "The ID of the target. If omitted, uses the current editing target.",
          },
        },
        required: ["scriptId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "findBlocks",
      description: "Find blocks by opcode, keyword, target, or top-level script scope.",
      parameters: {
        type: "object",
        properties: {
          targetId: {
            type: "string",
            description: "Limit search to a specific target.",
          },
          opcode: {
            type: "string",
            description: "Match a specific opcode exactly.",
          },
          keyword: {
            type: "string",
            description: "Match keyword text against opcode info and field values.",
          },
          scriptId: {
            type: "string",
            description: "Limit search to a specific top-level script.",
          },
          limit: {
            type: "number",
            description: "Maximum number of results to return. Defaults to 50.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "getAllPrimitiveBlocks",
      description: "Get a list of all native/primitive Scratch opcodes and their text representations.",
      parameters: {
        type: "object",
        properties: {},
      },
    },
  },
  {
    type: "function",
    function: {
      name: "getAllExtensions",
      description: "Get all loaded Scratch extensions in the current environment.",
      parameters: {
        type: "object",
        properties: {},
      },
    },
  },
  {
    type: "function",
    function: {
      name: "getExtensionBlocks",
      description: "Get all blocks available in a specific Scratch extension.",
      parameters: {
        type: "object",
        properties: {
          extensionId: {
            type: "string",
            description: "The ID of the extension.",
          },
        },
        required: ["extensionId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "searchBlocks",
      description: "Search for Scratch blocks by keyword.",
      parameters: {
        type: "object",
        properties: {
          keyword: {
            type: "string",
            description: "The keyword to search for.",
          },
        },
        required: ["keyword"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "getBlockInfo",
      description: "Get detailed information about a specific Scratch block by its opcode.",
      parameters: {
        type: "object",
        properties: {
          opcode: {
            type: "string",
            description: "The opcode of the block.",
          },
        },
        required: ["opcode"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "cleanUpBlocks",
      description: "Clean up and auto-arrange the blocks in the workspace.",
      parameters: {
        type: "object",
        properties: {
          targetId: {
            type: "string",
            description: "The ID of the target. If omitted, uses the current editing target.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "getWorkspaceUCF",
      description: "Get the current blocks of the workspace in UCF format.",
      parameters: {
        type: "object",
        properties: {
          targetId: {
            type: "string",
            description: "The ID of the target. If omitted, uses the current editing target.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "getCustomBlocks",
      description: "Get all currently available custom block definitions in the target.",
      parameters: {
        type: "object",
        properties: {
          targetId: {
            type: "string",
            description: "The ID of the target. If omitted, uses the current editing target.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "getBlocksRangeUCF",
      description: "Get the UCF of a continuous selected block range by its start and end block IDs.",
      parameters: {
        type: "object",
        properties: {
          startBlockId: {
            type: "string",
            description: "The first block ID in the continuous range.",
          },
          endBlockId: {
            type: "string",
            description: "The last block ID in the continuous range.",
          },
        },
        required: ["startBlockId", "endBlockId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "replaceBlocksRangeByUCF",
      description:
        "Replace a continuous existing block range with new UCF blocks while reconnecting the surrounding chain.",
      parameters: {
        type: "object",
        properties: {
          startBlockId: {
            type: "string",
            description: "The first block ID in the range to replace.",
          },
          endBlockId: {
            type: "string",
            description: "The last block ID in the range to replace.",
          },
          ucfString: {
            type: "string",
            description: "The replacement UCF for the selected range.",
          },
        },
        required: ["startBlockId", "endBlockId", "ucfString"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "generateCodeFromUCF",
      description: "Generate and insert Scratch blocks from UCF code into the workspace.",
      parameters: {
        type: "object",
        properties: {
          ucfString: {
            type: "string",
            description: "The UCF code representing the blocks.",
          },
          targetId: {
            type: "string",
            description: "The ID of the target. If omitted, uses the current editing target.",
          },
          x: {
            type: "number",
            description: "X coordinate offset.",
          },
          y: {
            type: "number",
            description: "Y coordinate offset.",
          },
        },
        required: ["ucfString"],
      },
    },
  },
];
