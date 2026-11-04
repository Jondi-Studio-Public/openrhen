import { describe, expect, it } from "vitest";
import { AGENT_CONTRACT_VERSION, agentContractSnapshot } from "./agent-contract.js";
import { AGENT_CONTRACT_SNAPSHOT as committed } from "./agent-contract-committed.js";
import { MCP_TOOL_MANIFEST } from "./mcp-manifest.js";

const REGENERATE = "corepack pnpm --filter @openrhen/cli contract-snapshot";

describe("the agent contract version", () => {
  it("is a positive integer", () => {
    expect(Number.isInteger(AGENT_CONTRACT_VERSION)).toBe(true);
    expect(AGENT_CONTRACT_VERSION).toBeGreaterThan(0);
  });

  it("matches the committed snapshot's version", () => {
    expect(
      committed.version,
      `agent-contract-snapshot.ts is for version ${committed.version}, not ${AGENT_CONTRACT_VERSION}: regenerate with ${REGENERATE}`
    ).toBe(AGENT_CONTRACT_VERSION);
  });

  it("changes whenever a served tool's name or required arguments change", () => {
    const current = agentContractSnapshot(MCP_TOOL_MANIFEST).tools;
    const was = committed.tools;
    const added = Object.keys(current).filter((name) => !(name in was));
    const removed = Object.keys(was).filter((name) => !(name in current));
    const changed = Object.keys(current).filter(
      (name) => name in was && JSON.stringify(current[name]) !== JSON.stringify(was[name])
    );
    const problems = [
      ...added.map((name) => `added ${name}`),
      ...removed.map((name) => `removed ${name}`),
      ...changed.map((name) => `${name} required [${was[name]!.join(", ")}] -> [${current[name]!.join(", ")}]`)
    ];
    expect(
      problems,
      `The served tools changed without a new contract version: ${problems.join("; ")}. ` +
        `Bump AGENT_CONTRACT_VERSION (platform/contracts/src/agent-contract.ts) and regenerate with ${REGENERATE}`
    ).toEqual([]);
  });
});
