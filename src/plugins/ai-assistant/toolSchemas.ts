export const scratchToolSchemas = [
  {
    type: "function",
    function: {
      name: "observeStage",
      description:
        "Game Agent only. Capture the visible Scratch stage DOM as an image and report whether the project appears to be running. The image is supplied to the model as image input, not text content.",
      parameters: {
        type: "object",
        properties: {},
      },
    },
  },
  {
    type: "function",
    function: {
      name: "runStageScript",
      description:
        "Game Agent only. Execute a short player-action script against the visible stage DOM. Coordinates default to Scratch coordinates: center is (0,0), y increases upward, height is 360, and width follows the current stage aspect ratio. Use screenshot(); inside the script to capture intermediate stage images; captured images are supplied to the model as image inputs. Supported calls: greenFlag(); stopAll(); wait(ms); screenshot(); click({x,y,button}); doubleClick({x,y,button}); mouseMove({x,y,durationMs}); mouseDown({x,y,button}); mouseUp({x,y,button}); keyDown({key}); keyUp({key}); keyPress({key,durationMs}); typeText({text,intervalMs}). mouseMove durationMs moves in about 20ms steps. click button defaults to left and may be left, middle, or right.",
      parameters: {
        type: "object",
        properties: {
          script: {
            type: "string",
            description: "Semicolon-separated stage action script, for example greenFlag(); wait(1000); click({x:0,y:0});",
          },
        },
        required: ["script"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "updateTodoList",
      description:
        "Update the visible todo list for non-trivial work. Always pass the full ordered list; keep at most one item in_progress.",
      parameters: {
        type: "object",
        properties: {
          todos: {
            type: "array",
            description: "Full ordered todo list for the current user request.",
            items: {
              type: "object",
              properties: {
                id: {
                  type: "string",
                  description: "Stable todo id. Reuse the same id when updating status.",
                },
                title: {
                  type: "string",
                  description: "Short task title shown in the message flow.",
                },
                status: {
                  type: "string",
                  enum: ["pending", "in_progress", "completed", "cancelled"],
                },
              },
              required: ["title", "status"],
            },
          },
        },
        required: ["todos"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "askUser",
      description:
        "Ask concise question(s) when missing information would change the result. The tool returns the user's answers together.",
      parameters: {
        type: "object",
        properties: {
          question: {
            type: "string",
            description: "The concise question shown above the chat input.",
          },
          questions: {
            type: "array",
            description: "Optional ordered list of questions to ask one by one.",
            items: {
              type: "object",
              properties: {
                id: {
                  type: "string",
                  description: "Optional stable question id.",
                },
                question: {
                  type: "string",
                  description: "The concise question text.",
                },
                questionType: {
                  type: "string",
                  enum: ["choice", "input"],
                  description: "Optional type: choice shows options first; input opens text input directly.",
                },
                options: {
                  type: "array",
                  items: {
                    type: "string",
                  },
                },
                placeholder: {
                  type: "string",
                },
                customOptionLabel: {
                  type: "string",
                },
                allowCustomInput: {
                  type: "boolean",
                },
              },
              required: ["question"],
            },
          },
          options: {
            type: "array",
            description: "Optional short choices; UI adds a custom-input option automatically.",
            items: {
              type: "string",
            },
          },
          placeholder: {
            type: "string",
            description: "Optional placeholder for free-form user input.",
          },
          customOptionLabel: {
            type: "string",
            description: "Optional label for the appended custom-input option.",
          },
          allowCustomInput: {
            type: "boolean",
            description: "Whether the user can provide a custom answer. Defaults to true.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "insertCostume",
      description:
        "Create a sprite costume or stage backdrop from a name and visual description. The user's default costume type controls ask/vector/bitmap; bitmap uses the configured image model and falls back to SVG on failure.",
      parameters: {
        type: "object",
        properties: {
          targetId: {
            type: "string",
            description: "Optional target id. Omit to use the currently selected target; stage targets create backdrops.",
          },
          costumeName: {
            type: "string",
            description: "Name for the new costume.",
          },
          costumeDescription: {
            type: "string",
            description: "Visual style and content of the new costume.",
          },
          referenceCostumeId: {
            type: "string",
            description: "Optional existing Scratch costume/backdrop id to use as a visual reference.",
          },
          referenceCostumePath: {
            type: "string",
            description: "Optional existing Scratch costume/backdrop VFS path, for example /Sprite1/custom/costume1.svg.",
          },
          referenceCostumeName: {
            type: "string",
            description: "Optional existing Scratch costume/backdrop name or file name to use as a visual reference.",
          },
          referenceCostumeIndex: {
            type: "number",
            description: "Optional zero-based costume/backdrop index on the reference target.",
          },
          referenceImageName: {
            type: "string",
            description:
              "Backward-compatible alias for referenceCostumePath/referenceCostumeName. It refers to an existing Scratch costume, not an uploaded image attachment.",
          },
          imageSize: {
            type: "string",
            description:
              "Optional bitmap generation size like 1024x1024, 1024x1792, or 1792x1024. Used only when bitmap generation is selected; defaults to 1024x1024.",
          },
        },
        required: ["costumeName", "costumeDescription"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "updateCostume",
      description:
        "Update an existing costume or stage backdrop. SVG assets are edited through a temporary SVG AI; bitmap assets use the configured image model through /images/edits. Identify it with costumeId, costumeName, or zero-based costumeIndex.",
      parameters: {
        type: "object",
        properties: {
          targetId: {
            type: "string",
            description: "Optional target id. Omit to use the currently selected target; stage targets update backdrops.",
          },
          costumeId: {
            type: "string",
            description: "Existing costume id.",
          },
          costumeName: {
            type: "string",
            description: "Existing costume name.",
          },
          costumeIndex: {
            type: "number",
            description: "Zero-based existing costume index.",
          },
          updateDescription: {
            type: "string",
            description: "Description of the requested visual changes.",
          },
          referenceCostumeId: {
            type: "string",
            description: "Optional existing Scratch costume/backdrop id to use as a visual reference.",
          },
          referenceCostumePath: {
            type: "string",
            description: "Optional existing Scratch costume/backdrop VFS path, for example /Sprite1/custom/costume1.svg.",
          },
          referenceCostumeName: {
            type: "string",
            description: "Optional existing Scratch costume/backdrop name or file name to use as a visual reference.",
          },
          referenceCostumeIndex: {
            type: "number",
            description: "Optional zero-based costume/backdrop index on the reference target.",
          },
          referenceImageName: {
            type: "string",
            description:
              "Backward-compatible alias for referenceCostumePath/referenceCostumeName. It refers to an existing Scratch costume, not an uploaded image attachment.",
          },
          imageSize: {
            type: "string",
            description:
              "Optional bitmap edit size like 1024x1024, 1024x1792, or 1792x1024. Used only when updating bitmap costumes; defaults to 1024x1024.",
          },
        },
        required: ["updateDescription"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "deleteCostume",
      description:
        "Delete an existing sprite costume or stage backdrop. Prefer applyPatch Delete File under /<target>/custom. Identify by costumeId, costumeName, or zero-based costumeIndex.",
      parameters: {
        type: "object",
        properties: {
          targetId: {
            type: "string",
            description: "Optional target id. Omit to use the currently selected target; stage targets delete backdrops.",
          },
          costumeId: {
            type: "string",
            description: "Existing costume id.",
          },
          costumeName: {
            type: "string",
            description: "Existing costume name.",
          },
          costumeIndex: {
            type: "number",
            description: "Zero-based existing costume index.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "runSubAgent",
      description:
        "Delegate one independent subtask to a configured child AI. @AgentName means a sub agent name for this tool, not a Scratch file/extension. Use Game Agent for visual stage testing when available. For non-simple Scratch work, prefer child AIs for project inspection or block/menu research plus script/resource drafting. Do not delegate steps that need user judgment, shared sequential state, or final integration decisions. Child AIs cannot ask the user, use todos/memory, or launch children.",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Configured child AI display name exactly as listed, for example Game Agent, search Agent, or code Agent.",
          },
          task: {
            type: "string",
            description: "Concrete delegated task for the child AI to execute.",
          },
          context: {
            type: "string",
            description: "Optional extra context, constraints, or relevant findings for the child AI.",
          },
          successCriteria: {
            type: "string",
            description: "Optional explicit definition of done for the delegated task.",
          },
        },
        required: ["name", "task"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "listMemoryBlocks",
      description:
        "Low risk. List long-term or current-project memory blocks; project memory exists only for saved projects.",
      parameters: {
        type: "object",
        properties: {
          scope: {
            type: "string",
            enum: ["longTerm", "project"],
            description: "Optional scope filter: longTerm global, project current saved project.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "getMemoryBlock",
      description: "Low risk. Get the full content of one persistent memory block by id.",
      parameters: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description: "Memory block id returned by listMemoryBlocks or setMemoryBlock.",
          },
          scope: {
            type: "string",
            enum: ["longTerm", "project"],
            description: "Optional scope filter for faster lookup.",
          },
        },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "setMemoryBlock",
      description:
        "Medium risk. Create/overwrite memory. Use project for learned understanding of the current saved project; use longTerm for stable user-stated rules/preferences.",
      parameters: {
        type: "object",
        properties: {
          scope: {
            type: "string",
            enum: ["longTerm", "project"],
            description: "Memory scope. Defaults to longTerm if omitted.",
          },
          id: {
            type: "string",
            description: "Optional existing memory block id to overwrite. Omit to create a new memory block.",
          },
          description: {
            type: "string",
            description: "Short human-readable description, such as user_info or project_rules.",
          },
          content: {
            type: "string",
            description: "Memory content. Maximum 5000 characters.",
          },
        },
        required: ["content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "replaceMemoryBlockText",
      description:
        "Medium risk. Replace exact text inside a persistent memory block without rewriting the whole block.",
      parameters: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description: "Memory block id.",
          },
          oldText: {
            type: "string",
            description: "Exact text to find in the memory block.",
          },
          newText: {
            type: "string",
            description: "Replacement text.",
          },
          scope: {
            type: "string",
            enum: ["longTerm", "project"],
            description: "Optional scope filter.",
          },
        },
        required: ["id", "oldText", "newText"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "deleteMemoryBlock",
      description: "High risk. Permanently delete one persistent memory block by id.",
      parameters: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description: "Memory block id to delete.",
          },
          scope: {
            type: "string",
            enum: ["longTerm", "project"],
            description: "Optional scope filter.",
          },
        },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "listFiles",
      description:
        "List virtual Scratch files: target roots, writable scripts/*.js, read-only legacy script.js, custom, audio, data, and docs.",
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
        "Compact Scratch overview: stage, coordinates, targets, paths, scripts, assets, variables, lists, and health. Prefer for orientation.",
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
        "Get a concise Scratch JS DSL guide by topic/name, including built-in guides, enabled user/AI guides, and built-in extension guides even when that extension is not installed.",
      parameters: {
        type: "object",
        properties: {
          topic: {
            type: "string",
            description:
              "Optional topic/name: extension-index, quickstart, events, data, control, procedures, custom-args, dynamic-blocks, rendering, menus, pen, patching, debugging, user/AI guide, extension-<extensionId>, or <extensionId>. Defaults to quickstart.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "runGuideTool",
      description:
        "Run a tool provided by an enabled user/AI guide or installed extension guide. Use this when memory or a guide says a persistent behavior applies, or when a guide tool can perform a reusable same-scenario action. Tool names use skillName.toolName format.",
      parameters: {
        type: "object",
        properties: {
          tool: {
            type: "string",
            description: "Full guide tool name, for example skillName.toolName.",
          },
          args: {
            type: "object",
            description: "Arguments passed to the guide tool as one object.",
            additionalProperties: true,
          },
        },
        required: ["tool"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "createAiGuide",
      description:
        "Create or update an AI-created guide for future conversations when a repeated scenario or persistent user preference would benefit from reusable guidance or an executable guide tool. The description must state when to use it and what it helps with. Optional indexJs tools should be simple top-level async functions; each function becomes skillName.functionName. If the user asks for a future recurring assistant-side behavior, prefer a real executable tool when possible, and return explicit unavailable/denied results instead of pretending the behavior happened.",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Stable short skill name using English letters, numbers, hyphens, or underscores.",
          },
          title: {
            type: "string",
            description: "Optional human-readable guide title. Defaults to name.",
          },
          description: {
            type: "string",
            description: "Short description of when this guide should be called and what it helps with.",
          },
          content: {
            type: "string",
            description:
              "Markdown guide content. Keep it concise and focused on when the AI should use the guide, what steps to follow, and which guide tool to call if one is provided.",
          },
          indexJs: {
            type: "string",
            description:
              "Optional guide tool JavaScript. Easiest template: async function toolName(args) { return { result: '...' }; }. You may also use export default { tools: { toolName: { async execute(args) { return { result: '...' }; } } } }. Use an empty string when no tool is needed. Tool code should actually perform the reusable action when possible; if the environment cannot do it, return { result: { success:false, reason:'...' } }.",
          },
        },
        required: ["name", "description", "content", "indexJs"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "searchBlocks",
      description:
        "Search Scratch blocks by opcode, Chinese/English keyword, or DSL term; returns compact examples, fields, inputs, menus, and notes.",
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
      name: "getBlocksHelp",
      description:
        "Get exact help for multiple Scratch block opcodes, dotted DSL calls, or aliases in one call. Use only for unfamiliar blocks or uncertain fields/menus; do not batch-query common core blocks you already know.",
      parameters: {
        type: "object",
        properties: {
          opcodes: {
            type: "array",
            description:
              "Opcode or dotted DSL calls, for example control_start_as_clone, data.showvariable, pen.setPenColorParamTo. Maximum 40.",
            items: {
              type: "string",
            },
          },
          includeSuggestions: {
            type: "boolean",
            description: "Whether failed lookups include search suggestions. Defaults to true.",
          },
        },
        required: ["opcodes"],
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
            description:
              "Virtual path: /stage|<target>/scripts/*.js, /<target>/custom/*.svg, /<target>/custom/order.json, /<target>/audio/*, /variables.json, /lists.json, /docs/*. Data aliases and Chinese aliases are accepted; /<target>/script.js is read-only legacy aggregate.",
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
        "Apply Codex-style patches to writable Scratch VFS files: scripts, global data JSON/aliases, sprite roots, SVG costumes/backdrops, /<target>/custom/order.json costume ordering, renames, and deletions. SVG data-rotation-center-x/y controls pivot and may normalize. Script variable/list references auto-create globals. Invalid drafts are preserved; valid script/SVG/data patches sync to Scratch.",
      parameters: {
        type: "object",
        properties: {
          patch: {
            type: "string",
            description:
              "Patch text beginning with *** Begin Patch and containing Add File, Delete File, or Update File hunks.",
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
            description: "Optional virtual path. If omitted, validates writable Scratch JS, SVG, and data JSON files.",
          },
          verbose: {
            type: "boolean",
            description:
              "If true and path is omitted, include read-only legacy aggregate views/directories. Default focuses on writable scripts and editable SVG.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "discardDraft",
      description:
        "Discard an invalid preserved draft for a /<target>/scripts/*.js file and restore the last synced virtual content. Does not change Scratch blocks.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Virtual script file path, for example /stage/scripts/sound-play.js.",
          },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "getAllExtensions",
      description:
        "List installed Scratch extensions. If an extension provides aiAssistant guide data, the result includes guide metadata and guide tools. If an extension has dynamic argument blocks, the result includes a hint to read getScratchGuide({ topic: \"dynamic-blocks\" }).",
      parameters: {
        type: "object",
        properties: {},
      },
    },
  },
  {
    type: "function",
    function: {
      name: "searchExtensions",
      description:
        'Precisely search approved Scratch extensions after reading getScratchGuide({ topic: "extension-index" }) or when the user gives a concrete extension keyword, name, or id. For broad questions about available extensions or feature feasibility, read getScratchGuide({ topic: "extension-index" }) first.',
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search keyword. Omit or leave empty to list approved extensions.",
          },
          limit: {
            type: "number",
            description: "Maximum number of results. Defaults to 10, maximum 50.",
          },
          includeDisabled: {
            type: "boolean",
            description: "Whether to include disabled/offline extensions in the search results. Defaults to false.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "addExtension",
      description:
        "Add an approved Scratch extension to the current project by extension id. The extension id must come from searchExtensions or the approved extension index.",
      parameters: {
        type: "object",
        properties: {
          extensionId: {
            type: "string",
            description: "Approved extension id, for example moreDataTypes, GandiJoystick, or CCWAdvance.",
          },
        },
        required: ["extensionId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "getExtensionBlocks",
      description:
        "Get block details for one installed extension. If the extension provides aiAssistant guide data, the result includes its read-only guide content and tools. Dynamic argument blocks include dynamicArgsInfo and a hint to read getScratchGuide({ topic: \"dynamic-blocks\" }).",
      parameters: {
        type: "object",
        properties: {
          extensionId: {
            type: "string",
            description: "Extension id, with or without ext_ prefix.",
          },
        },
        required: ["extensionId"],
      },
    },
  },
];
