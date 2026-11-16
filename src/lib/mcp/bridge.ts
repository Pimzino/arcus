// This window's side of the MCP server (src-tauri mcp/): it registers the tools once it has loaded, runs each
// `mcp:call` and answers it. Arguments are checked against the tool's input schema first, so a tool only ever
// sees what its schema promises; a wrong argument goes back to the agent as a tool error it can correct.
// A call that changes something shows as a toast, and the pages' cached reads are refreshed, so what an agent
// did is in front of the person at the window.

import { toast } from "../../components/ui/Toast";
import { queryClient } from "../queryClient";
import { api, isTauri, listen } from "../tauri";
import { errorMessage } from "../types";
import { TOOLS, type Schema, type Tool } from "./tools";

type Call = { id: string; name: string; arguments: Record<string, unknown>; client: string };

const byName = new Map(TOOLS.map((t) => [t.name, t]));

function definition(tool: Tool) {
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.input,
    annotations: {
      title: tool.title,
      readOnlyHint: !!tool.readOnly,
      destructiveHint: !tool.readOnly && !!tool.destructive,
      idempotentHint: !!tool.readOnly,
      openWorldHint: true,
    },
  };
}

/** Why `value` does not fit `schema` (the subset of JSON Schema the tools use), or null. */
export function mismatch(value: unknown, schema: Schema, at = "arguments"): string | null {
  switch (schema.type) {
    case "object": {
      if (!value || typeof value !== "object" || Array.isArray(value)) return `${at} must be an object`;
      const obj = value as Record<string, unknown>;
      for (const key of schema.required ?? []) if (obj[key] === undefined || obj[key] === null) return `${at}.${key} is required`;
      for (const [key, v] of Object.entries(obj)) {
        if (v === undefined || v === null) continue;
        const sub = schema.properties?.[key] ?? (typeof schema.additionalProperties === "object" ? schema.additionalProperties : undefined);
        if (!sub) {
          if (schema.additionalProperties === true) continue;
          return `${at}.${key} is not a parameter here`;
        }
        const why = mismatch(v, sub, `${at}.${key}`);
        if (why) return why;
      }
      return null;
    }
    case "array":
      if (!Array.isArray(value)) return `${at} must be an array`;
      for (let i = 0; i < value.length; i++) {
        const why = schema.items ? mismatch(value[i], schema.items, `${at}[${i}]`) : null;
        if (why) return why;
      }
      return null;
    case "string":
      if (typeof value !== "string") return `${at} must be a string`;
      if (schema.enum && !schema.enum.includes(value)) return `${at} must be one of ${schema.enum.join(", ")}`;
      return null;
    case "integer":
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value) || (schema.type === "integer" && !Number.isInteger(value))) return `${at} must be ${schema.type === "integer" ? "a whole number" : "a number"}`;
      if (schema.minimum !== undefined && value < schema.minimum) return `${at} must be at least ${schema.minimum}`;
      if (schema.maximum !== undefined && value > schema.maximum) return `${at} must be at most ${schema.maximum}`;
      return null;
    case "boolean":
      return typeof value === "boolean" ? null : `${at} must be true or false`;
    default:
      return null;
  }
}

/** What the toast says the call was about. */
function subject(a: Record<string, unknown>): string | undefined {
  if (typeof a.source === "string" && typeof a.destination === "string") return `${a.source} → ${a.destination}`;
  if (typeof a.from === "string" && typeof a.to === "string") return `${a.from} → ${a.to}`;
  for (const key of ["path", "name", "remote", "mountPoint", "id", "command", "method"]) if (typeof a[key] === "string") return a[key] as string;
  return undefined;
}

async function run(call: Call) {
  const tool = byName.get(call.name);
  // The backend only forwards names this window registered, so this is a bug in one of the two.
  if (!tool) return api.mcpReply(call.id, { error: `Arcus has no tool ${call.name}` });
  const why = mismatch(call.arguments, tool.input);
  if (why) return api.mcpReply(call.id, { error: `Invalid arguments: ${why}.` });
  try {
    const result = await tool.run(call.arguments, { client: call.client });
    await api.mcpReply(call.id, { result: result ?? null });
    if (!tool.readOnly) {
      toast({ tone: "info", title: `${call.client}: ${tool.title}`, description: subject(call.arguments) });
      // Without cancelling a listing in flight: a slow remote would start it over.
      void queryClient.invalidateQueries(undefined, { cancelRefetch: false });
    }
  } catch (e) {
    await api.mcpReply(call.id, { error: errorMessage(e) });
  }
}

let started = false;

/** Register the tools and answer calls, for as long as the window's page lives. */
export async function startMcpBridge() {
  if (started || !isTauri) return;
  started = true;
  await listen<Call>("mcp:call", (call) => {
    run(call).catch((e) => console.error("could not answer an MCP call", e));
  });
  await api.mcpRegisterTools(TOOLS.map((t) => ({ definition: definition(t), commands: !!t.commands })));
}
