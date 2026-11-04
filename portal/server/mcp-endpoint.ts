import { randomUUID } from "node:crypto";
import {
  AGENT_CONTRACT_VERSION,
  agentErrorResult,
  doubtfulWriteMessage,
  MAX_RETRY_ATTEMPTS,
  RETRY_WAIT_SECONDS,
  unknownToolMessage,
  scopeCovers,
  type AgentError,
  MCP_SERVER_INSTRUCTIONS,
  mcpManifestTool,
  mcpToolAllowed,
  mcpToolWritable,
  mcpToolsForScopes,
  validateToolArguments
} from "@openrhen/contracts";
import { findCommand, toolInvocation, toolResult } from "@openrhen/cli/in-process";
import type { AgentPrincipal } from "./agent-tokens";
import { databaseJournalStore, runCliWithAgentJournal, type JournalStore } from "./agent-journal-runner";
import type { CliRunResult, RouteLoader } from "./mcp-cli-runner";
import { authenticateBearer, databaseOauthDeps, insufficientScope, originRefusal, type OauthDeps } from "./mcp-oauth";

/**
 * `POST /mcp`: the remote MCP endpoint, Streamable HTTP with plain
 * JSON answers (nothing here pushes a message the client did not ask for, so there is no event stream: GET is a
 * 405). Bearer access tokens only. A `tools/call` runs the tool's real CLI command in-process as the token's agent
 * (`mcp-cli-runner.ts`), every request it makes going through the same wrapper every API request goes through, so
 * nothing the token may not do is reachable here.
 */

export const MAX_BODY_BYTES = 1024 * 1024;
const SUPPORTED_PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const LATEST_PROTOCOL = SUPPORTED_PROTOCOLS[0] as string;

export interface McpDeps {
  oauth: OauthDeps;
  /** Where route handlers come from: the generated route table when absent. Tests inject stubs. */
  loadRoute?: RouteLoader | undefined;
  /** Where each agent's undo journal (its ledger writes) is read from; an empty journal for the call (undo finds nothing) when absent. */
  journalStore?: (() => Promise<JournalStore | undefined>) | undefined;
  serverVersion: string;
}

export function databaseMcpDeps(): McpDeps {
  return {
    oauth: databaseOauthDeps(),
    journalStore: databaseJournalStore,
    serverVersion: process.env.OPENRHEN_BUILD_COMMIT?.trim() || "dev"
  };
}

const rpcResult = (id: unknown, result: unknown) => Response.json({ jsonrpc: "2.0", id, result });
const rpcError = (id: unknown, code: number, message: string, status = 200) =>
  Response.json({ jsonrpc: "2.0", id, error: { code, message } }, { status });

/** A failed call as a normal tool result: `isError` with `structuredContent.error`, never a JSON-RPC error. */
const toolError = (id: unknown, error: AgentError) => rpcResult(id, agentErrorResult(error));

/**
 * The token lacks a scope for a tool that exists. The HTTP 403 with the OAuth challenge stays (a client can ask the
 * person for more), and its body is a tool result with code `scope` naming the missing scope, for a client that
 * shows the model the body.
 */
/** The tools whose change rhen_propose can replay (an entity_command), so a scope refusal may offer it. */
const PROPOSABLE_TOOLS: ReadonlySet<string> = new Set([
  "rhen_save",
  "rhen_save_action",
  "rhen_save_project",
  "rhen_save_commitment",
  "rhen_save_capture"
]);

function scopeRefusal(
  inbound: Request,
  id: unknown,
  toolName: string,
  required: string[],
  held: readonly string[]
): Response {
  const missing = required.filter((scope) => !held.some((have) => scopeCovers(have, scope)));
  const named = (missing.length > 0 ? missing : required).join(" ");
  const challenge = insufficientScope(inbound, required);
  const holds = held.length > 0 ? held.join(", ") : "no scopes";
  // Only a record save can be replayed by a proposal (rhen_propose files entity_command): the other writes (a session,
  // a reply to a person who wrote in, a bulk) have no proposal to file, so offering one would send the agent to a refusal.
  const proposeTool = mcpManifestTool("rhen_propose");
  const mayPropose = PROPOSABLE_TOOLS.has(toolName) && proposeTool !== undefined && mcpToolAllowed(proposeTool, held);
  const tell = `Please give this agent the ${named} scope (Settings > Add-ons and sign-in, then issue a new token).`;
  const message =
    `${toolName} cannot be called with this token: it needs ${named}, and the token holds ${holds}. ` +
    (mayPropose
      ? "You can still file this change for the person to approve with rhen_propose (kind entity_command, payload-json: the save to replay). "
      : toolName === "rhen_inbox_act"
        ? "Nothing can be filed instead. If you were replying to a person who wrote in, you cannot send it from this token: agree the wording with the owner, who sends it from the portal. "
        : "This change cannot be filed as a proposal either, so nothing can be done with this tool from this token. ") +
    `Do not retry it. Tell the person: "${tell}"`;
  return Response.json(
    {
      jsonrpc: "2.0",
      id,
      result: agentErrorResult({
        code: "scope",
        message,
        retryable: false,
        tellThePerson: tell,
        ...(mayPropose
          ? {
              nextCall: {
                tool: "rhen_propose",
                arguments: { kind: "entity_command", "payload-json": "<the save to replay>" }
              }
            }
          : {})
      })
    },
    { status: 403, headers: challenge.headers }
  );
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

async function callTool(
  inbound: Request,
  principal: AgentPrincipal,
  id: unknown,
  params: unknown,
  deps: McpDeps
): Promise<Response> {
  const record = isRecord(params) ? params : {};
  const tool = typeof record.name === "string" ? mcpManifestTool(record.name) : undefined;
  const spec = tool ? findCommand(tool.command) : undefined;
  if (!tool || !spec || spec.ownerOnly === true)
    return rpcError(
      id,
      -32602,
      unknownToolMessage(
        record.name,
        mcpToolsForScopes(principal.scopes ?? []).map((entry) => entry.name)
      )
    );
  // One challenge naming every scope the tool needs; `tools/list` already hides what the token cannot call.
  if (!mcpToolAllowed(tool, principal.scopes ?? []))
    return scopeRefusal(inbound, id, tool.name, tool.scopes, principal.scopes ?? []);
  // A tool that lists for its read mode alone (`readableWithAnyOf`): arguments mean a write, so they need every scope.
  const callArguments = isRecord(record.arguments) ? Object.keys(record.arguments) : [];
  if (tool.readableWithAnyOf && callArguments.length > 0 && !mcpToolWritable(tool, principal.scopes ?? []))
    return toolError(id, {
      code: "scope",
      message:
        `${tool.name} read mode works with this token (call it with no arguments), but sending answers needs the ` +
        `${tool.scopes.join(" ")} scope, which it does not hold. Nothing was sent. Do not retry with arguments: tell the owner ` +
        `"This agent needs the ${tool.scopes.join(" ")} scope to submit answers; please issue it a new token that has it ` +
        `(Settings > Add-ons and sign-in)." Then ask the owner the questions the read returned.`,
      retryable: false
    });
  // A bad argument is the model's mistake to read and fix, so it is a tool result, not a protocol error.
  const checked = validateToolArguments(tool.inputSchema, record.arguments, tool.name);
  if (!checked.ok) return toolError(id, { code: "validation", message: checked.error, retryable: false });

  // A write the caller gave no command id gets one here, so a doubtful answer can name the id to retry with.
  const given = checked.args["command-id"];
  const commandId =
    spec.mutates && Object.hasOwn(tool.inputSchema.properties, "command-id")
      ? typeof given === "string"
        ? given
        : randomUUID()
      : undefined;
  const callArgs = commandId === undefined ? checked.args : { ...checked.args, "command-id": commandId };
  // The stdio server's own command line: options as --name=value, then --json, then positionals after `--`.
  const { argv, injectedLimit } = toolInvocation(spec, { ...callArgs, ...tool.fixedArguments });
  // `retryId` is the id a repeat must carry, when the write may have run; none when nothing ran.
  const retryable = (message?: string, retryId: string | null = commandId ?? null) => {
    const base = (message ?? `The portal could not run ${tool.name} just now.`).replace(/\s*Try again\.$/, "");
    const error: AgentError = {
      code: "unavailable",
      message:
        retryId !== null
          ? doubtfulWriteMessage(base, retryId, tool.name)
          : `${base} Nothing was applied, so repeating is safe: wait ${RETRY_WAIT_SECONDS} seconds and repeat the same ` +
            `${tool.name} call (up to ${MAX_RETRY_ATTEMPTS} attempts), then tell the person the portal is unwell.`,
      retryable: true,
      retryAfterSeconds: RETRY_WAIT_SECONDS,
      ...(retryId === null ? {} : { commandId: retryId })
    };
    return rpcResult(id, { ...agentErrorResult(error), _meta: { retryable: true } });
  };
  let run: CliRunResult;
  try {
    run = await runCliWithAgentJournal({
      argv,
      actor: { kind: "agent", principal },
      inbound,
      loadRoute: deps.loadRoute,
      agent: principal.name,
      store: await deps.journalStore?.().catch(() => undefined)
    });
  } catch {
    return retryable();
  }
  if (run.exitCode !== 0) {
    // A route said the token lacks a scope the manifest did not name (an entity type, a room): the OAuth challenge,
    // so a client can ask the person for more.
    if (run.insufficientScopes)
      return scopeRefusal(inbound, id, tool.name, run.insufficientScopes, principal.scopes ?? []);
    // A refusal made before the command ran (the undo record could not be read) has nothing to deduplicate; otherwise
    // a repeat is safe only with the id the CLI says its writes carried.
    if (run.failed)
      return run.retryMessage !== undefined
        ? retryable(run.retryMessage, null)
        : // A write whose failure names no id may still have run: fall back to the id this call carried.
          retryable(undefined, reportedCommandId(run.stdout) ?? commandId ?? null);
  }
  // An id this endpoint added is not the caller's to be told "--command-id had no effect" about.
  const stderr =
    commandId !== undefined && given === undefined
      ? run.stderr.filter((line) => !line.includes("--command-id had no effect"))
      : run.stderr;
  const result = toolResult(spec, callArgs, { ...run, stderr }, injectedLimit);
  // A route answered 503 (a saved write whose answer could not be read back): the text says to repeat with the same command id.
  return rpcResult(id, run.exitCode !== 0 && run.retryable ? { ...result, _meta: { retryable: true } } : result);
}

/** The command id in the CLI's `--json` error, if it names one: the key its writes really carried. */
function reportedCommandId(stdout: readonly string[]): string | null {
  try {
    const parsed: unknown = JSON.parse(stdout.join("\n"));
    return isRecord(parsed) && typeof parsed.commandId === "string" ? parsed.commandId : null;
  } catch {
    return null;
  }
}

/** Handles `POST /mcp`. See the file comment. */
export async function handleMcpRequest(request: Request, deps: McpDeps = databaseMcpDeps()): Promise<Response> {
  const refused = originRefusal(request);
  if (refused) return refused;
  if (request.method.toUpperCase() !== "POST")
    return Response.json({ error: "Only POST is supported." }, { status: 405, headers: { allow: "POST" } });
  const auth = await authenticateBearer(request, deps.oauth);
  if (!auth.ok) return auth.response;

  const version = request.headers.get("mcp-protocol-version");
  if (version !== null && !SUPPORTED_PROTOCOLS.includes(version))
    return Response.json({ error: `Unsupported MCP-Protocol-Version ${version}.` }, { status: 400 });
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY_BYTES)
    return Response.json({ error: `The request body is over ${MAX_BODY_BYTES} bytes.` }, { status: 413 });
  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES)
    return Response.json({ error: `The request body is over ${MAX_BODY_BYTES} bytes.` }, { status: 413 });
  let message: unknown;
  try {
    message = JSON.parse(raw);
  } catch {
    return rpcError(null, -32700, "Parse error", 400);
  }
  if (Array.isArray(message)) return rpcError(null, -32600, "JSON-RPC batches are not supported.", 400);
  if (!isRecord(message) || message.jsonrpc !== "2.0") return rpcError(null, -32600, "Invalid request", 400);

  const hasId = Object.hasOwn(message, "id");
  const id = hasId ? (message.id ?? null) : null;
  const method = message.method;
  // A notification, or the client's answer to something: acknowledged, nothing to say back.
  if (typeof method !== "string" || !hasId) return new Response(null, { status: 202 });

  switch (method) {
    case "initialize": {
      const params = isRecord(message.params) ? message.params : {};
      const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : undefined;
      return rpcResult(id, {
        protocolVersion: asked && SUPPORTED_PROTOCOLS.includes(asked) ? asked : LATEST_PROTOCOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "rhen", version: deps.serverVersion, contractVersion: AGENT_CONTRACT_VERSION },
        instructions: MCP_SERVER_INSTRUCTIONS
      });
    }
    case "ping":
      return rpcResult(id, {});
    case "tools/list":
      return rpcResult(id, {
        tools: mcpToolsForScopes(auth.principal.scopes ?? []).map(
          ({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, annotations })
        )
      });
    case "tools/call":
      return callTool(request, auth.principal, id, message.params, deps);
    default:
      return rpcError(id, -32601, "Method not found");
  }
}
