import type { ZodError } from "zod";

/**
 * Exit codes a caller can branch on. They are part of the CLI's contract with the AI tools that
 * drive it, so a shell or an agent can tell "the portal refused this" from "the network is down"
 * without parsing prose.
 */
export const EXIT = {
  ok: 0,
  /** Bad arguments, an unknown command, or an unusable configuration. */
  usage: 1,
  /** The portal rejected the payload (HTTP 400); `details` carries its issues. */
  validation: 2,
  /** The entity changed since it was read (HTTP 409). Re-read and try again. */
  conflict: 3,
  /** The entity or route does not exist. */
  notFound: 4,
  /** The portal is unreachable, timed out, or failed (network error or HTTP 5xx). */
  unavailable: 5,
  /** The pulse lapsed (HTTP 428 `reentryRequired`): call `reenter` and complete it before anything else. */
  reentry: 6
} as const;

/**
 * What a failure adds for an agent beyond its exit code (`AgentError` in the contracts): `guarded` when the portal
 * refused the agent's token the write (the 403 that is not a missing scope), `scope` when a scope is missing, the
 * command to run instead, the version a conflict is now at, the command id a doubtful write must be retried with.
 * It travels in the `--json` error as fields beside `error`, `exitCode` and `details`.
 */
export interface CliErrorAgentFields {
  code?: "guarded" | "scope" | "auth";
  suggestedPath?: string;
  currentVersion?: number;
  /** The exact tool call that resolves the refusal (list the ids, read the open session), when the portal names one. */
  nextCall?: { tool: string; arguments: Record<string, unknown>; note?: string };
  /** The values the refused argument accepts, when the portal names them. */
  validValues?: Record<string, string[]>;
  commandId?: string;
  /**
   * A 5xx on a keyed write: `doubtful` (it may have landed) or `committed` (the portal says it saved the write and
   * only the answer failed). `plainMessage` is then the portal's own text without the CLI's `--command-id` tail, so
   * each surface can add its own instruction (a flag for the CLI, the `"command-id"` argument for MCP).
   */
  retry?: "doubtful" | "committed";
  plainMessage?: string;
}

export class CliError extends Error {
  readonly exitCode: number;
  readonly details: unknown;
  readonly agent: CliErrorAgentFields;

  constructor(message: string, exitCode: number = EXIT.usage, details?: unknown, agent: CliErrorAgentFields = {}) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
    this.details = details;
    this.agent = agent;
  }
}

/**
 * The request never got an HTTP answer: the connection failed or the timeout fired. For a write this is
 * the ambiguous case, because the portal may have applied it before the answer was lost.
 */
export class NetworkError extends CliError {
  constructor(message: string) {
    super(message, EXIT.unavailable);
    this.name = "NetworkError";
  }
}

/** The portal answered with a 5xx. For a write that says nothing about whether it landed: the portal saves first and can fail while answering. */
export class ServerError extends CliError {
  readonly status: number;

  constructor(message: string, status: number, details?: unknown) {
    super(message, EXIT.unavailable, details);
    this.name = "ServerError";
    this.status = status;
  }
}

/** The first issue of a payload the contracts schema rejected, as one line naming its field. */
export function firstIssueMessage(error: ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "The command payload is invalid.";
  const path = issue.path.join(".");
  return path ? `${path}: ${issue.message}` : issue.message;
}
