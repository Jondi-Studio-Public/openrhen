/**
 * The one machine-readable shape an agent gets when a tool call fails.
 * Every tool result with `isError: true`, on stdio and over `/mcp`, carries `structuredContent: { error: AgentError }`
 * next to the text it always had. The CLI's exit codes map onto it (`agentErrorCodeForExit`); a guarded refusal
 * (the hard floor, a route the token's agent may not use) is `guarded` and names the command to run instead.
 */

export const AGENT_ERROR_CODES = [
  "guarded",
  "conflict",
  "validation",
  "not_found",
  "scope",
  "unavailable",
  "usage",
  "reentry_required"
] as const;

export type AgentErrorCode = (typeof AGENT_ERROR_CODES)[number];

export interface AgentError {
  code: AgentErrorCode;
  message: string;
  /** True when repeating the call (with `commandId` when given) is safe and may succeed. */
  retryable: boolean;
  /** A `rhen` command to run in place of the refused one, or where the person does it. */
  suggestedPath?: string;
  /** A conflict: the version the record has now, when the answer says. */
  currentVersion?: number;
  /** A doubtful write: the only command id to retry with, so the retry cannot apply twice. */
  commandId?: string;
  /** The exact tool call to make next, when there is one (arguments may hold `<placeholders>` the agent fills). */
  nextCall?: AgentCall;
  /** The accepted values for the arguments the failure names (energies, place ids, entity types, statuses). */
  validValues?: Record<string, string[]>;
  /** What to say to the person when only they can fix this. */
  tellThePerson?: string;
  /** Seconds to wait before the next call (a rate limit, a lock). */
  retryAfterSeconds?: number;
}

/** A tool call an agent can send as it stands: the tool name and its arguments. */
export interface AgentCall {
  tool: string;
  arguments: Record<string, unknown>;
  note?: string;
}

/** The call as the exact text to send: `rhen_span {"subcommand":"set",...}`. */
export function formatAgentCall(call: AgentCall): string {
  return `${call.tool} ${JSON.stringify(call.arguments)}`;
}

const isAgentCall = (value: unknown): value is AgentCall =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as AgentCall).tool === "string" &&
  (value as AgentCall).tool !== "" &&
  typeof (value as AgentCall).arguments === "object" &&
  (value as AgentCall).arguments !== null &&
  !Array.isArray((value as AgentCall).arguments);

const isValidValues = (value: unknown): value is Record<string, string[]> =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  Object.values(value).every((list) => Array.isArray(list) && list.every((item) => typeof item === "string"));

/**
 * The CLI's `EXIT` map (tools/cli/src/errors.ts): usage 1, validation 2, conflict 3, not found 4, unavailable 5,
 * and 6 when the pulse lapsed and `reenter` must be completed first.
 */
const CODE_BY_EXIT: Readonly<Record<number, AgentErrorCode>> = {
  1: "usage",
  2: "validation",
  3: "conflict",
  4: "not_found",
  5: "unavailable",
  6: "reentry_required"
};

export function agentErrorCodeForExit(exitCode: number): AgentErrorCode {
  return CODE_BY_EXIT[exitCode] ?? "usage";
}

const isCode = (value: unknown): value is AgentErrorCode =>
  typeof value === "string" && (AGENT_ERROR_CODES as readonly string[]).includes(value);

export interface AgentErrorInput {
  message: string;
  /** The CLI exit code, when the failure came from a command. */
  exitCode?: number;
  /** An explicit code (the CLI's JSON error names `guarded` and `scope`); wins over the exit code. */
  code?: unknown;
  suggestedPath?: unknown;
  currentVersion?: unknown;
  commandId?: unknown;
  nextCall?: unknown;
  validValues?: unknown;
  tellThePerson?: unknown;
  retryAfterSeconds?: unknown;
  /** True for a read: repeating it cannot apply anything twice. */
  safeToRepeat?: boolean;
}

/** Builds an `AgentError`: the code from `code` or the exit code; `retryable` only for `unavailable` with a safe repeat. */
export function toAgentError(input: AgentErrorInput): AgentError {
  const code = isCode(input.code) ? input.code : agentErrorCodeForExit(input.exitCode ?? 1);
  // A command id only matters for a retry, which only `unavailable` allows.
  const commandId =
    code === "unavailable" && typeof input.commandId === "string" && input.commandId !== ""
      ? input.commandId
      : undefined;
  return {
    code,
    message: input.message,
    retryable: code === "unavailable" && (input.safeToRepeat === true || commandId !== undefined),
    ...(typeof input.suggestedPath === "string" && input.suggestedPath !== ""
      ? { suggestedPath: input.suggestedPath }
      : {}),
    ...(typeof input.currentVersion === "number" ? { currentVersion: input.currentVersion } : {}),
    ...(commandId === undefined ? {} : { commandId }),
    ...(isAgentCall(input.nextCall) ? { nextCall: input.nextCall } : {}),
    ...(isValidValues(input.validValues) ? { validValues: input.validValues } : {}),
    ...(typeof input.tellThePerson === "string" && input.tellThePerson !== ""
      ? { tellThePerson: input.tellThePerson }
      : {}),
    ...(typeof input.retryAfterSeconds === "number" && input.retryAfterSeconds > 0
      ? { retryAfterSeconds: Math.ceil(input.retryAfterSeconds) }
      : {})
  };
}

/** How many times an agent repeats a failed call before it stops and tells the person. */
export const MAX_RETRY_ATTEMPTS = 3;
/** Seconds to wait between those repeats. */
export const RETRY_WAIT_SECONDS = 2;

/**
 * The message for a write the portal could not confirm. It says the one safe repeat (the SAME call, the SAME
 * command-id), how long to wait, when to stop, and that a changed call or a conflict needs a new id. `tool` is the
 * MCP tool name (`rhen_save`); without it the text says "call".
 */
export function doubtfulWriteMessage(message: string, commandId: string, tool?: string, takesCommandId = true): string {
  const call = tool ?? "the same tool";
  const keyed = takesCommandId
    ? ` and "command-id":"${commandId}"; the portal applies it at most once and replays the result if it already landed. `
    : `. ${call} takes no command-id, so first read the record to see whether the change landed, and repeat only if it did not. `;
  return (
    `${message} The portal could not say whether this change was saved, so do not send it as a new change. ` +
    `Wait ${RETRY_WAIT_SECONDS} seconds, then repeat the SAME ${tool ?? "tool"} call with the SAME arguments${keyed}` +
    `After ${MAX_RETRY_ATTEMPTS} attempts stop and tell the person: "${call} failed with command-id ${commandId}; ` +
    `please check the portal."` +
    (takesCommandId
      ? " If you change any argument, or a repeat comes back as a conflict, use a new command-id (omit it and the portal makes one)."
      : "")
  );
}

/** The message for a write the portal says it saved but could not read back: do not make the change again. */
export function committedWriteMessage(
  message: string,
  commandId: string,
  tool?: string,
  takesCommandId = true
): string {
  return (
    `${message} Your change WAS saved (command-id ${commandId}), but the portal could not read the result back. ` +
    "Do not make the change again. " +
    (takesCommandId
      ? `Call ${tool ?? "the same tool"} with the same arguments and "command-id":"${commandId}" to fetch the result.`
      : "Read the record to see the result.")
  );
}

/**
 * The message for a version conflict: someone changed the record after the agent read it, so nothing was changed.
 * Re-read, check the change still holds, then repeat with the new version and a NEW command-id (the old id belongs
 * to the refused attempt).
 */
export function conflictMessage(
  message: string,
  tool?: string,
  currentVersion?: number,
  accepts: { expectedVersion?: boolean; commandId?: boolean } = { expectedVersion: true, commandId: true }
): string {
  // Only name an argument the tool really has: advising one it lacks sends the agent into a validation error.
  const withVersion = accepts.expectedVersion === true && currentVersion !== undefined;
  const id = accepts.commandId === true ? ' and a new "command-id" (omit it and the portal makes one)' : "";
  const tail = withVersion ? ` with "expected-version":${currentVersion}${id}` : id === "" ? "" : ` with${id.slice(4)}`;
  return (
    `${message} Nothing was changed. Read the record again (rhen_show with its entity and id), check your ` +
    `change still applies, then repeat ${tool ?? "the call"}${tail}.`
  );
}

/** True for the portal's "that record is gone" family ("no longer exists", "does not exist"). */
export function saysRecordMissing(message: string): boolean {
  return /\b(no longer exists|does not exist|is no longer linked)\b/i.test(message);
}

/** The message for a record that is gone: find the right id, or ask before creating it again. */
export function missingRecordMessage(message: string): string {
  return (
    `${message} Nothing was changed. Find the right id with rhen_search or rhen_list, or ask the ` +
    "person before creating it again."
  );
}

/** The message for a failed read: nothing was written, so a repeat is always safe. */
export function readFailureMessage(message: string, tool?: string): string {
  return (
    `${message} Nothing was changed. Wait ${RETRY_WAIT_SECONDS} seconds and repeat the same ${tool ?? "call"} ` +
    `(up to ${MAX_RETRY_ATTEMPTS} attempts), then tell the person the portal is unwell.`
  );
}

/** The 429 text: the wait is in the sentence, not only in a header. */
export function rateLimitMessage(seconds: number, what = "failed attempts"): string {
  const wait = Math.max(1, Math.ceil(seconds));
  return (
    `Too many ${what} from this address. Wait ${wait} seconds (the Retry-After header says the same) before ` +
    "any further request, and check that you are sending the current access token."
  );
}

/** Edit distance, for "did you mean". */
function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = row[0] as number;
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const above = row[j] as number;
      row[j] = Math.min(above + 1, (row[j - 1] as number) + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return row[b.length] as number;
}

const squash = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Up to three of `candidates` that look like what was typed (same letters ignoring case and `-`/`_`, or a few typos away). */
export function closestNames(typed: string, candidates: readonly string[]): string[] {
  const wanted = squash(typed);
  return candidates
    .map((name) => ({
      name,
      score: squash(name) === wanted ? 0 : distance(wanted, squash(name))
    }))
    .filter((item) => item.score <= Math.max(2, Math.floor(wanted.length / 4)))
    .sort((a, b) => a.score - b.score)
    .slice(0, 3)
    .map((item) => item.name);
}

/** The text for a tool name that is not one of this token's tools: the closest valid names and where the list is. */
export function unknownToolMessage(name: unknown, valid: readonly string[]): string {
  const shown = typeof name === "string" && name !== "" ? `"${name.slice(0, 80)}"` : "(no name given)";
  const near = typeof name === "string" ? closestNames(name, valid) : [];
  return (
    `Unknown tool ${shown}: it is not a tool you can call here. ` +
    (near.length > 0 ? `Closest valid names: ${near.join(", ")}. ` : "") +
    'Call tools/list for the names you may use; they all start with "rhen_" and use underscores ' +
    "(rhen_catch_up, rhen_inbox_act). Send the name as params.name in tools/call."
  );
}

const issueLine = (issue: unknown): string | undefined => {
  if (typeof issue !== "object" || issue === null) return undefined;
  const { path, message } = issue as { path?: unknown; message?: unknown };
  if (typeof message !== "string") return undefined;
  const where = Array.isArray(path) ? path.join(".") : typeof path === "string" ? path : "";
  return where === "" ? message : `${where}: ${message}`;
};

/**
 * The failure message with what a client that shows only `structuredContent.error.message` would otherwise lose:
 * the first schema issue (and how many more) and the `Still needed:` lines of a re-entry refusal, from the error
 * document's `details`. Nothing is added that the message already says.
 */
export function selfContainedMessage(message: string, details: unknown): string {
  if (typeof details !== "object" || details === null || Array.isArray(details)) return message;
  const record = details as { issues?: unknown; missing?: unknown };
  const parts: string[] = [];
  if (Array.isArray(record.issues) && record.issues.length > 0) {
    const first = issueLine(record.issues[0]);
    if (first !== undefined && !message.includes(first)) {
      const more = record.issues.length - 1;
      parts.push(`First problem: ${first}.${more > 0 ? ` ${more} more problem${more === 1 ? "" : "s"} follow.` : ""}`);
    }
  }
  if (Array.isArray(record.missing) && record.missing.length > 0) {
    const lines = record.missing.filter((line): line is string => typeof line === "string");
    const text = `Still needed: ${lines.join("; ")}.`;
    if (lines.length > 0 && !message.includes(lines.join("; "))) parts.push(text);
  }
  return parts.length === 0 ? message : `${message} ${parts.join(" ")}`;
}

/** A tool result for a failure: the message as text, the shape as `structuredContent`. */
export function agentErrorResult(error: AgentError): {
  content: { type: "text"; text: string }[];
  isError: true;
  structuredContent: { error: AgentError };
} {
  return { content: [{ type: "text", text: error.message }], isError: true, structuredContent: { error } };
}
