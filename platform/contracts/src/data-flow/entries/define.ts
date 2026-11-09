import type { FlowEntry } from "../types.js";

type Required = Pick<FlowEntry, "id" | "name" | "role" | "category" | "method" | "trigger">;

/** An entry with the empty defaults filled in, so the entry files read as the facts they record. */
export function flow(entry: Required & Partial<FlowEntry>): FlowEntry {
  return {
    code: {},
    from: [],
    to: [],
    health: { kind: "none", reason: "no live signal; the source's own probe shows its health" },
    ...entry
  };
}
