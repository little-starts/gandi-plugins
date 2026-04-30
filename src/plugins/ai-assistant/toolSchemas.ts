export const scratchToolSchemas = [
  {
    type: "function",
    function: {
      name: "listFiles",
      description: "List virtual Scratch project files, including writable stage/sprite JS files and read-only docs.",
      parameters: {
        type: "object",
        properties: {},
      },
    },
  },
  {
    type: "function",
    function: {
      name: "getProjectOverview",
      description:
        "Get a compact overview of Scratch targets, virtual file paths, scripts, variables, and lists. Prefer this before reading full files when orienting.",
      parameters: {
        type: "object",
        properties: {},
      },
    },
  },
  {
    type: "function",
    function: {
      name: "getScratchGuide",
      description:
        "Get a concise task-oriented Scratch JS DSL guide. Use this instead of reading long docs for common patterns.",
      parameters: {
        type: "object",
        properties: {
          topic: {
            type: "string",
            description:
              "Optional topic: quickstart, events, data, control, procedures, custom-args, rendering, menus, pen, patching, debugging. Defaults to quickstart.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "searchBlocks",
      description:
        "Search Scratch blocks by opcode, Chinese/English keyword, or DSL term and return compact JS DSL examples, fields, inputs, menus, and notes.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Keyword or opcode, such as pen color, broadcast, start_as_clone, data_replaceitemoflist.",
          },
          maxResults: {
            type: "number",
            description: "Maximum number of matches. Defaults to 12.",
          },
          includeExamples: {
            type: "boolean",
            description: "Whether to include JS DSL examples. Defaults to true.",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "getBlockHelp",
      description:
        "Get exact help for one Scratch opcode, dotted DSL call, or common alias (for example operator.less / pen.down), including JS syntax, fields, inputs, menus, substacks, and a ready-to-copy example.",
      parameters: {
        type: "object",
        properties: {
          opcode: {
            type: "string",
            description: "Opcode or dotted DSL call, for example control_start_as_clone or pen.setPenColorParamTo.",
          },
        },
        required: ["opcode"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "readFile",
      description: "Read a virtual Scratch file. Supports optional 1-based line ranges.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Virtual path such as /stage.js, /sprites/Cat.<targetId>.js, or /docs/scratch-agent.md.",
          },
          startLine: {
            type: "number",
            description: "Optional 1-based start line.",
          },
          endLine: {
            type: "number",
            description: "Optional 1-based end line.",
          },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "searchFiles",
      description: "Search virtual Scratch JS files and read-only docs by keyword.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Keyword or opcode to search for.",
          },
          path: {
            type: "string",
            description: "Optional virtual path to restrict the search.",
          },
          maxResults: {
            type: "number",
            description: "Maximum number of matches. Defaults to 50.",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "applyPatch",
      description:
        "Apply a Codex-style patch to writable virtual Scratch JS files. Supports standard +/- hunks and full replacement content after Update File. Successful patches immediately sync changed scripts back to Scratch blocks.",
      parameters: {
        type: "object",
        properties: {
          patch: {
            type: "string",
            description: "Patch text beginning with *** Begin Patch and containing one or more *** Update File hunks.",
          },
        },
        required: ["patch"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "getDiagnostics",
      description: "Validate current virtual Scratch JS files and report parser/block diagnostics.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Optional virtual path. If omitted, validates all virtual Scratch JS files.",
          },
        },
      },
    },
  },
];
