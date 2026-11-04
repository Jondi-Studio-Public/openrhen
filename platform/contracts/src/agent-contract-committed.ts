import "./private/index.js";
import type { AgentContractSnapshot } from "./agent-contract.js";
import { CORE_AGENT_CONTRACT_SNAPSHOT } from "./agent-contract-snapshot.js";
import { extensionContractSnapshotTools } from "./extensions.js";

/**
 * The committed snapshot of the served tools: the generated core snapshot plus the tools the registered
 * extensions add, sorted by name as `agentContractSnapshot` sorts them.
 */
export const AGENT_CONTRACT_SNAPSHOT: AgentContractSnapshot = {
  version: CORE_AGENT_CONTRACT_SNAPSHOT.version,
  tools: Object.fromEntries(
    Object.entries({ ...CORE_AGENT_CONTRACT_SNAPSHOT.tools, ...extensionContractSnapshotTools() }).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0
    )
  )
};
