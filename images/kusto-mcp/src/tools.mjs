// MCP tool surface: the azure-mcp-compatible `kusto` namespace router plus one
// flat tool per command.
import { commandByName, Context, enabledCommands, execute } from "./commands.mjs";

export const ROUTER_NAME = "kusto";

// azure-mcp NamespaceToolLoader: group description + router suffix.
export const ROUTER_DESCRIPTION = `Kusto operations - Commands for managing and querying Azure Data Explorer (Kusto) resources. Includes operations for listing clusters and databases, executing KQL queries, retrieving table schemas, and working with Kusto data analytics workloads.

This tool is a hierarchical MCP command router.
To invoke a command, set "command" and wrap its args in "parameters".
Set "learn=true" to discover available sub commands.`;

// azure-mcp NamespaceToolLoader s_toolSchema, property order included.
export const ROUTER_SCHEMA = {
  type: "object",
  properties: {
    intent: { type: "string", description: "The intent of the operation to perform." },
    command: { type: "string", description: "The command to execute against the specified tool." },
    parameters: { type: "object", description: "The parameters to pass to the tool command." },
    learn: { type: "boolean", description: "To learn about the tool and its supported child tools and parameters.", default: false },
  },
  required: ["intent"],
  additionalProperties: false,
};

const LEARN_HEADER = `Here are the available commands and their input schema for 'kusto' tool.
If you do not find a suitable "command", run again with the "learn=true" to get a list of available commands and their parameters.
Next, identify the command you want to execute and run again with the "command" and "parameters" arguments, respecting "required" parameters if present.

`;

const HELP = `The "command" parameter is required when not learning.
Run again with the "learn" argument to get a list of available tools and their parameters.
To learn about a specific tool, use the "command" argument with the name of the tool.`;

export const INSTRUCTIONS = "Azure Data Explorer (Kusto) data-plane tools. The `kusto` tool is the azure-mcp-compatible command router (set command and parameters, or learn=true); the kusto_* tools are the same commands as separate tools. Pass cluster-uri (https://<cluster>.<region>.kusto.windows.net), or cluster plus subscription. Queries run read-only. Results use the azure-mcp envelope {status, message, results, duration}.";

const META_KEYS = new Set(["intent", "command", "learn", "parameters"]);
const MISSING = /Missing required options/i;

export class Tools {
  /**
   * @param {object} options
   * @param {import("./kusto.mjs").KustoClient} options.kusto
   * @param {import("./arm.mjs").ArmClient} options.arm
   * @param {object} options.config
   * @param {"both"|"namespace"|"all"} [options.mode]
   */
  constructor({ kusto, arm, config, mode = "both" }) {
    this.ctx = new Context({ kusto, arm, config });
    this.mode = mode;
    this.commands = enabledCommands({ enableWrites: config.enableWrites });
    this.routed = this.commands.filter((command) => command.router);
  }

  list() {
    const tools = [];
    if (this.mode !== "all") {
      tools.push({
        name: ROUTER_NAME,
        title: "Kusto",
        description: ROUTER_DESCRIPTION,
        inputSchema: ROUTER_SCHEMA,
        annotations: { title: "Kusto", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      });
    }
    if (this.mode !== "namespace") {
      // Write tools are flat-only, so they show in namespace mode too.
      for (const command of this.commands) tools.push(toolFor(command));
    } else {
      for (const command of this.commands.filter((candidate) => candidate.write)) tools.push(toolFor(command));
    }
    return tools;
  }

  learnText() {
    const entries = this.routed.map((command) => ({ command: command.name, description: command.description, inputSchema: command.inputSchema }));
    return LEARN_HEADER + JSON.stringify(entries);
  }

  /** Returns an MCP CallToolResult. signal cancels the Kusto and ARM requests. */
  async call(name, args = {}, { signal } = {}) {
    if (name === ROUTER_NAME && this.mode !== "all") return this.#route(args ?? {}, signal);
    const command = commandByName.get(name);
    if (!command || !this.commands.includes(command) || (this.mode === "namespace" && !command.write)) {
      return errorResult(`Unknown tool: ${name}`);
    }
    const response = await execute(this.ctx, command, args, { signal });
    return envelopeResult(response);
  }

  async #route(args, signal) {
    if (args === null || typeof args !== "object" || Array.isArray(args)) return errorResult("Arguments must be an object.");
    const intent = typeof args.intent === "string" ? args.intent : undefined;
    const commandName = typeof args.command === "string" ? args.command.trim() : undefined;
    let learn = args.learn === true;
    if (!learn && intent && !commandName) learn = true;
    if (learn) return textResult(this.learnText());
    if (!commandName) return textResult(HELP);
    const command = this.routed.find((candidate) => candidate.name.toLowerCase() === commandName.toLowerCase());
    if (!command) {
      // azure-mcp BaseToolLoader.CreateUnknownCommandResult.
      const names = this.routed.map((candidate) => candidate.name).sort();
      return errorResult(`The command '${commandName}' is not available for the '${ROUTER_NAME}' tool.
Available commands: ${names.join(", ")}
Select the command that best matches the current intent. Use "learn=true" with an empty "intent" to get command descriptions and parameter schemas without executing a command.`);
    }
    const response = await execute(this.ctx, command, routerParameters(args), { signal });
    if (response.plainText) return errorResult(response.plainText);
    if (MISSING.test(response.message)) {
      // azure-mcp ToolCommandInfo: {command, description, inputSchema}.
      const spec = JSON.stringify({ command: command.name, description: command.description, inputSchema: command.inputSchema });
      return {
        content: [
          {
            type: "text",
            text: `${response.message}

- Review the following command spec and identify the required arguments from the input schema.
- Omit any arguments that are not required or do not apply to your use case.
- Wrap all command arguments into the root "parameters" argument.
- If required data is missing infer the data from your context or prompt the user as needed.
- Run the tool again with the "command" and root "parameters" object.

Command Spec:
${spec}`,
          },
          { type: "text", text: JSON.stringify(response) },
        ],
        isError: true,
      };
    }
    return envelopeResult(response);
  }
}

/**
 * azure-mcp NamespaceToolLoader.GetParametersFromArgs: a "parameters" object
 * (any key case) wins; otherwise every non-meta argument is a parameter.
 */
function routerParameters(args) {
  const key = Object.keys(args).find((candidate) => candidate.toLowerCase() === "parameters");
  const nested = key === undefined ? undefined : args[key];
  if (nested !== null && typeof nested === "object" && !Array.isArray(nested)) return { ...nested };
  return Object.fromEntries(Object.entries(args).filter(([name]) => !META_KEYS.has(name.toLowerCase())));
}

function toolFor(command) {
  return {
    name: command.name,
    title: command.title,
    description: command.description,
    inputSchema: command.inputSchema,
    annotations: { title: command.title, ...command.annotations },
  };
}

const textResult = (text) => ({ content: [{ type: "text", text }] });
const errorResult = (text) => ({ content: [{ type: "text", text }], isError: true });

function envelopeResult(response) {
  if (response.plainText) return errorResult(response.plainText);
  const isError = response.status < 200 || response.status >= 300;
  return { content: [{ type: "text", text: JSON.stringify(response) }], ...(isError ? { isError: true } : {}) };
}
