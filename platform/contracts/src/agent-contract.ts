/**
 * The version of what an agent may rely on by name: which tools the server serves and which arguments each one
 * requires. It is a positive integer, bumped by hand whenever a served tool is added, removed or renamed, or a tool's
 * required-argument list changes (`agent-contract.test.ts` fails until it is, and the committed snapshot in
 * `agent-contract-snapshot.ts` is regenerated). Servers report it as `contractVersion` (the remote `initialize`
 * result's `serverInfo`, the stdio server's too), at the top of `rhen_guide` and in the skill text, and the
 * OpenClaw plugin's SKILL.md carries the number it was written for, so an installed copy can tell it is behind.
 * A renamed tool keeps its old name as an alias for one contract version (`aliases` in `remote-manifest.ts`).
 */
export const AGENT_CONTRACT_VERSION = 9;

/** The line that states the version, as shown in the guide overview and the skill. */
export function agentContractLine(): string {
  return `Contract version: ${AGENT_CONTRACT_VERSION}`;
}

export interface AgentContractSnapshot {
  version: number;
  /** Each served tool name and its required arguments, both sorted. */
  tools: Record<string, string[]>;
}

/** What the snapshot records for a manifest: tool names and required-argument lists. */
export function agentContractSnapshot(
  tools: readonly { name: string; inputSchema: { required?: string[] } }[],
  version = AGENT_CONTRACT_VERSION
): AgentContractSnapshot {
  const entries = tools
    .map((tool): [string, string[]] => [tool.name, [...(tool.inputSchema.required ?? [])].sort()])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return { version, tools: Object.fromEntries(entries) };
}
