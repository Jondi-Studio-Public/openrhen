import { closestNames } from "./agent-error.js";
import { agentGoldenRules, agentPolicySentences } from "./agent-policy-text.js";
import { scopeCovers } from "./agent-scopes.js";
import { contractsExtensions } from "./extensions.js";
import { MCP_TOOL_MANIFEST_DATA } from "./mcp-manifest-data.js";
import type { UntrustedOutputKind } from "./untrusted-fence.js";
import "./private/index.js";

/**
 * The curated tool manifest for the portal's remote `/mcp` endpoint.
 * Each entry is a registry command from `tools/cli` with its name, description, input schema and annotations
 * derived from it by `pnpm --filter @openrhen/cli manifest` (a CLI test fails when this data drifts from the
 * registry), plus the scopes the tool needs to be listed. The remote endpoint serves exactly these tools and nothing
 * else, by running the real command in-process: no command or route is reachable by name and an argument is never
 * a flag, which is what removes the argument-splicing class (A1, A6) by construction. Owner-only commands, the
 * an outward-message command, imports and local-file arguments are never in it; the portal's route wrapper still decides, request
 * by request, what the token may do.
 */

export interface McpToolAnnotations {
  title: string;
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

/** A JSON Schema fragment describing an object argument's fields, generated from a zod schema. */
export type McpJsonSchema = Record<string, unknown>;

export type McpToolProperty =
  | { type: "string"; description: string; enum?: string[]; maxLength?: number }
  | { type: "boolean"; description: string }
  | { type: "integer" | "number"; description: string; minimum?: number; maximum?: number }
  | ({ type: "object"; description: string } & McpJsonSchema)
  | { type: "array"; items: { type: "string" } | ({ type: "object" } & McpJsonSchema); description: string };

export interface McpToolInputSchema {
  type: "object";
  properties: Record<string, McpToolProperty>;
  additionalProperties: false;
  required?: string[];
}

export interface McpToolManifestEntry {
  /** `rhen_<command>`, the name a client calls. */
  name: string;
  /** The `tools/cli` registry command this tool is derived from. */
  command: string;
  description: string;
  inputSchema: McpToolInputSchema;
  annotations: McpToolAnnotations;
  /** Every scope a caller must hold to see and call the tool. */
  scopes: string[];
  /**
   * Set when only part of the tool is gated by `scopes`: a token holding any one of these may see the tool and call it
   * with no arguments (its read mode), while a call with arguments still needs every scope in `scopes`.
   */
  readableWithAnyOf?: string[];
  /**
   * Arguments the tool always passes to its command and leaves out of its schema: a typed save tool
   * (`rhen_save_action`) is `save` with its entity kind fixed.
   */
  fixedArguments?: Record<string, string>;
  /** Set when the tool returns text someone else wrote; the result then goes inside the untrusted fence. */
  untrustedOutput?: UntrustedOutputKind;
}

/** The generated core tools, with each registered extension's tools placed after the tool it names (or last). */
function withExtensionTools(core: readonly McpToolManifestEntry[]): McpToolManifestEntry[] {
  const tools = [...core];
  for (const extension of contractsExtensions()) {
    if (extension.mcpTools === undefined) continue;
    const placements = Array.isArray(extension.mcpTools) ? extension.mcpTools : [extension.mcpTools];
    for (const placement of placements) {
      for (const override of placement.overrides ?? []) {
        const at = tools.findIndex((tool) => tool.name === override.name);
        if (at >= 0) tools[at] = override;
      }
      const anchor = tools.findIndex((tool) => tool.name === placement.after);
      tools.splice(anchor < 0 ? tools.length : anchor + 1, 0, ...placement.tools);
    }
  }
  return tools;
}

export const MCP_TOOL_MANIFEST: readonly McpToolManifestEntry[] = withExtensionTools(MCP_TOOL_MANIFEST_DATA);

/**
 * What the remote server tells a client at `initialize`. The policy sentences come from `agent-policy-text.ts`, the
 * one owner of that prose; keep it under 4.6 KB (a test holds it).
 */
export const MCP_SERVER_INSTRUCTIONS =
  "OpenRhen is the owner's household planning system. Start every session with rhen_status. " +
  "rhen_guide (topics: vocabulary, workflows, writing-data, reading-data, recurrence, limits, coordinating) " +
  "explains any unfamiliar word and what you may change; rhen_skill prints these rules once. " +
  agentGoldenRules("the owner") +
  " Situation -> call. A call fails with reentry_required, or the owner was away a long while: rhen_reenter " +
  "(no arguments first; it reads, you ask, then you answer). Status shows catch-up due: rhen_catch_up, ask, " +
  "then rhen_catch_up_settle. Status shows attention: rhen_attention once (act on nextCall, askOwner and " +
  "the step in why). A check-in is pending: rhen_check_in; deviated and doing something else: " +
  "rhen_disrupt (a call or visitor: rhen_disruption). The owner woke or arrived: rhen_wake, " +
  "rhen_arrive. Work on an action: rhen_session; on a routine step, sleep or deliverable step: " +
  "rhen_activity. One record: rhen_save or its typed tools (rhen_save_action, _project, " +
  "_commitment, _capture); several facts from one message: rhen_changeset; one patch to many rows: " +
  "rhen_bulk; a thought to sort later: rhen_capture; a mistake: rhen_undo. Inbox: rhen_inbox, " +
  "then rhen_inbox_act. Deliverable work: rhen_deliverable. Also writes: rhen_span, " +
  "rhen_review, rhen_routine, rhen_cadence, rhen_recurrence, rhen_recalculate. " +
  "Reads: rhen_list, rhen_show, rhen_search, rhen_map, rhen_state, rhen_forecast, " +
  "rhen_summary, rhen_history, rhen_doctor; rhen_changes shows what changed and by whom " +
  "(start with count or a short since); rhen_proposals shows what you proposed and what was decided. " +
  agentPolicySentences("the person", "brief").join(" ") +
  " Drive the plan yourself: rhen_propose only when unsure and you cannot ask, never as a habit. " +
  "Give basis and evidence on a write, and a command-id so a repeat after a timeout is applied once " +
  "(rhen_undo takes none: retry it with id).";

export function mcpManifestTool(name: string): McpToolManifestEntry | undefined {
  return MCP_TOOL_MANIFEST.find((tool) => tool.name === name);
}

/** Whether a token holding `held` may see and call the tool. */
export function mcpToolAllowed(tool: McpToolManifestEntry, held: readonly string[]): boolean {
  const holds = (required: string) => held.some((scope) => scopeCovers(scope, required));
  return tool.readableWithAnyOf ? tool.readableWithAnyOf.some(holds) : tool.scopes.every(holds);
}

/** Whether the token holds every scope the tool's writes need (`mcpToolAllowed` may list it for its read mode alone). */
export function mcpToolWritable(tool: McpToolManifestEntry, held: readonly string[]): boolean {
  return tool.scopes.every((required) => held.some((scope) => scopeCovers(scope, required)));
}

/** The tools `tools/list` shows a token: a read-only token never sees a write tool. */
export function mcpToolsForScopes(held: readonly string[]): McpToolManifestEntry[] {
  return MCP_TOOL_MANIFEST.filter((tool) => mcpToolAllowed(tool, held));
}

export type ToolArgumentsResult = { ok: true; args: Record<string, unknown> } | { ok: false; error: string };

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A JSON text's value, or undefined when it is not JSON. */
function parsedJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * The value as its declared type when a client sent the text form these arguments used to take (`limit: "10"`, a
 * JSON object as a string, a flag as "true" or "false", one text where a list is expected), or an enum value in
 * another case: clients and agents that learned the old schema keep working. Anything else is returned
 * as it was, for `propertyProblem` to refuse.
 */
function fromOldTextForm(property: McpToolProperty, value: unknown): unknown {
  if (typeof value !== "string") return value;
  // "true" and "false" exactly, so a flag sent as text means what it says; any other text is refused.
  if (property.type === "boolean") return value === "true" ? true : value === "false" ? false : value;
  // One non-empty text where a list of text is expected (`where: "a=b"`), as the stdio server used to take it.
  if (property.type === "array" && property.items.type === "string") return value === "" ? value : [value];
  if (property.type === "integer" || property.type === "number")
    return /^-?\d+(\.\d+)?$/.test(value.trim()) ? Number(value) : value;
  // An enum value in another case (`Sleep-Log-Entry`), as the CLI itself lowercases a kind.
  if (property.type === "string" && property.enum && !property.enum.includes(value))
    return property.enum.find((option) => option.toLowerCase() === value.trim().toLowerCase()) ?? value;
  if (property.type === "object" || (property.type === "array" && property.items.type === "object"))
    return parsedJson(value) ?? value;
  return value;
}

/**
 * What is wrong with one argument's value, or undefined. An object's own fields are checked by the command it
 * runs (its zod schema), which names the field; here it only has to be an object.
 */
function propertyProblem(property: McpToolProperty, value: unknown): string | undefined {
  switch (property.type) {
    case "array":
      if (!Array.isArray(value)) return "must be a list";
      if (property.items.type === "string")
        return value.every((item) => typeof item === "string") ? undefined : "must be a list of strings";
      return value.every(isPlainObject) ? undefined : "must be a list of objects";
    case "object":
      return isPlainObject(value) ? undefined : "must be an object";
    case "integer":
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) return "must be a number";
      if (property.type === "integer" && !Number.isInteger(value)) return "must be a whole number";
      if (property.minimum !== undefined && value < property.minimum) return `must be at least ${property.minimum}`;
      if (property.maximum !== undefined && value > property.maximum) return `must be at most ${property.maximum}`;
      return undefined;
    }
    case "boolean":
      return typeof value === "boolean" ? undefined : "must be a boolean";
    case "string":
      if (typeof value !== "string") return "must be a string";
      if (property.enum && !property.enum.includes(value)) return `must be one of ${property.enum.join(", ")}`;
      if (property.maxLength !== undefined && value.length > property.maxLength)
        return `is longer than ${property.maxLength} characters`;
      return undefined;
  }
}

/**
 * Checks a call's arguments against the tool's own schema, which is all the stdio and remote servers accept: an
 * unknown argument, a wrong type, a missing required one or a value over `maxLength` is refused, never passed on.
 * A `null` value means unset, as many clients send it, and is dropped before the check.
 */
export function validateToolArguments(
  schema: McpToolInputSchema,
  raw: unknown,
  toolName?: string
): ToolArgumentsResult {
  const prefix = toolName === undefined ? "" : `${toolName}: `;
  const valid = () =>
    ` Valid arguments: ${Object.keys(schema.properties)
      .map((name) => ((schema.required ?? []).includes(name) ? `${name} (required)` : name))
      .join(", ")}.`;
  const fail = (error: string, withValid = false): { ok: false; error: string } => ({
    ok: false,
    error: toolName === undefined ? error : `${prefix}${error}${withValid ? valid() : ""}`
  });
  const args = raw === undefined ? {} : raw;
  if (args === null || typeof args !== "object" || Array.isArray(args))
    return fail('arguments must be an object, for example {"name":"value"}.', true);
  const given = Object.fromEntries(Object.entries(args).filter(([, value]) => value !== null));
  for (const name of Object.keys(given))
    if (!Object.hasOwn(schema.properties, name)) {
      const near = closestNames(name, Object.keys(schema.properties))[0];
      return fail(
        `"${name}" is not an argument${toolName === undefined ? " of this tool" : ""}.` +
          (toolName !== undefined && near !== undefined ? ` Did you mean "${near}"?` : ""),
        true
      );
    }
  for (const name of schema.required ?? []) if (given[name] === undefined) return fail(`"${name}" is required.`, true);
  const typed: Record<string, unknown> = {};
  for (const [name, raw] of Object.entries(given)) {
    if (raw === undefined) continue;
    const property = schema.properties[name] as McpToolProperty;
    const value = fromOldTextForm(property, raw);
    const problem = propertyProblem(property, value);
    if (problem)
      return fail(
        `"${name}" ${problem}.` +
          (toolName === undefined ? "" : ` Repeat the same ${toolName} call with "${name}" corrected.`)
      );
    typed[name] = value;
  }
  return { ok: true, args: typed };
}
