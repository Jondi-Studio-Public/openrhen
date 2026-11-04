import { createHash } from "node:crypto";
import { BASIS_HEADER, EVIDENCE_HEADER, encodeEvidenceHeader, parseBasis, parseEvidence } from "@openrhen/contracts";
import type { AgentBasis } from "@openrhen/contracts";
import { stringOption, type CommandSpec, type OptionValues } from "./command.js";
import { CliError, EXIT } from "./errors.js";

/** The HTTP header every request carries when an agent name is set. */
export const AGENT_HEADER = "X-OpenRhen-Agent";

/** The HTTP header carrying an agent token; the portal then names the actor from the token itself. */
export const TOKEN_HEADER = "X-OpenRhen-Token";

/** The agent token for this process: `OPENRHEN_TOKEN` only (never a flag, so it stays out of history and ps). Empty means none. */
export function resolveToken(env: NodeJS.ProcessEnv): string | undefined {
  return env.OPENRHEN_TOKEN?.trim() || undefined;
}

/** The HTTP header carrying the owner's token (the design notes, decision D2). */
export const OWNER_TOKEN_HEADER = "X-OpenRhen-Owner";

/**
 * The owner token for this process: `OPENRHEN_OWNER_TOKEN` only, and only for a run that is not an agent. A run
 * that names itself or holds an agent token never sends it, so a stray variable cannot turn an agent into the owner.
 */
export function resolveOwnerToken(env: NodeJS.ProcessEnv, agent: string | undefined): string | undefined {
  if (agent !== undefined || resolveToken(env) !== undefined) return undefined;
  return env.OPENRHEN_OWNER_TOKEN?.trim() || undefined;
}

/** `env` without the owner token: what an MCP server hands the tool calls it dispatches for an agent. */
export function withoutOwnerToken(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const rest = { ...env };
  delete rest.OPENRHEN_OWNER_TOKEN;
  return rest;
}

/** Names the portal stamps itself: `system` for writers with no request, `human` for the portal's own user. */
const RESERVED_AGENT_NAMES = new Set(["system", "human"]);

/**
 * An agent name is a self-declared label (1 to 32 characters of a-z 0-9 _ -, lower-cased), not a
 * credential. Throws a usage error for anything else, and for the reserved names.
 */
export function parseAgentName(raw: string, source = "--agent"): string {
  const name = raw.trim().toLowerCase();
  if (!/^[a-z0-9_-]{1,32}$/.test(name))
    throw new CliError(`${source} must be 1 to 32 characters of a-z, 0-9, _ or -; got "${raw}".`, EXIT.usage);
  if (RESERVED_AGENT_NAMES.has(name))
    throw new CliError(`${source} "${name}" is reserved; pick another name for this agent.`, EXIT.usage);
  return name;
}

/**
 * The identity a run declares: `--agent`, then `OPENRHEN_AGENT`; undefined when neither is set.
 * `changes` is the one command whose own `--agent` is a filter (who made the change), so for it only
 * the environment names the caller.
 */
export function resolveAgent(values: OptionValues, env: NodeJS.ProcessEnv, command: string): string | undefined {
  const flag = command === "changes" ? undefined : stringOption(values, "agent");
  if (flag !== undefined) return parseAgentName(flag);
  const fromEnv = env.OPENRHEN_AGENT?.trim();
  return fromEnv ? parseAgentName(fromEnv, "OPENRHEN_AGENT") : undefined;
}

/** The owner label of writes made by a caller that declared no agent name and has no token. They cannot be told apart from each other. */
export const UNLABELED_OWNER = "unlabeled";

/**
 * Who a recorded write belongs to, for `undo`, in the order the portal names the actor
 * (`identifyRequest`): a token wins and the self-declared agent name is then ignored, so the owner is a
 * short fingerprint of the token (a one-way hash, safe to store and print); else the declared agent
 * name; else `unlabeled`. The CLI knows no more than this about its caller; a process id would change
 * on every run and make a person's own `rhen undo` a stranger to their last write.
 */
export function resolveOwner(agent: string | undefined, env: NodeJS.ProcessEnv): string {
  const token = resolveToken(env);
  if (token !== undefined) return `token:${createHash("sha256").update(token).digest("hex").slice(0, 8)}`;
  if (agent !== undefined) return `agent:${agent}`;
  return UNLABELED_OWNER;
}

/** What a write claims about itself: where it comes from, and the person's words for `stated`. */
export interface WriteClaim {
  basis?: AgentBasis | undefined;
  evidence?: string | undefined;
}

/** Validates a basis and evidence pair; a bad value is a usage error before anything is sent. */
export function parseClaim(basis: string | undefined, evidence: string | undefined): WriteClaim {
  const parsedBasis = parseBasis(basis);
  if (!parsedBasis.ok) throw new CliError(`--basis: ${parsedBasis.reason}`, EXIT.usage);
  const parsedEvidence = parseEvidence(evidence);
  if (!parsedEvidence.ok) throw new CliError(`--evidence: ${parsedEvidence.reason}`, EXIT.usage);
  return { basis: parsedBasis.value, evidence: parsedEvidence.value };
}

/**
 * The claim for one run. `propose`, `changes` and `deliverable` declare a `basis` or `evidence` option of
 * their own, which wins, so a global value is read only when the command has no such option. The claim only
 * applies to a command that changes portal state.
 */
export function resolveClaim(spec: CommandSpec, values: OptionValues): WriteClaim {
  const basis = "basis" in spec.options ? undefined : stringOption(values, "basis");
  const evidence = "evidence" in spec.options ? undefined : stringOption(values, "evidence");
  if (!spec.mutates && (basis !== undefined || evidence !== undefined))
    throw new CliError(
      `--basis and --evidence only apply to commands that change portal state; "${spec.name}" does not.`,
      EXIT.usage
    );
  return parseClaim(basis, evidence);
}

/** The request headers for a claim; the evidence is percent-encoded so any text fits in a header. */
export function claimHeaders(claim: WriteClaim): Record<string, string> {
  const { basis, evidence } = parseClaim(claim.basis, claim.evidence);
  return {
    ...(basis ? { [BASIS_HEADER]: basis } : {}),
    ...(evidence ? { [EVIDENCE_HEADER]: encodeEvidenceHeader(evidence) } : {})
  };
}
