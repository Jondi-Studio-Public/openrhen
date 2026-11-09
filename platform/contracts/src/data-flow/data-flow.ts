import "../private/index.js";
import { contractsExtensions } from "../extensions.js";
import { AGENT_ENTRIES } from "./entries/agents.js";
import { CALENDAR_ENTRIES } from "./entries/calendar.js";
import { DERIVED_ENTRIES } from "./entries/derived.js";
import { DEVICE_ENTRIES } from "./entries/devices.js";
import { FILE_ENTRIES } from "./entries/files.js";
import { MANUAL_ENTRIES } from "./entries/manual.js";
import { PLANNED_ENTRIES } from "./entries/planned.js";
import { READER_ENTRIES } from "./entries/readers.js";
import { buildFlowGraph, type FlowRegistry, type GraphOptions } from "./graph.js";
import { CORE_DATASET_NOTES } from "./notes.js";
import type { DataFlowContribution, FlowEntry } from "./types.js";

/**
 * The public module of the data-flow registry (the `@openrhen/contracts/data-flow` subpath). It assembles core's entries
 * and whatever the registered extensions add through `ContractsExtension.dataFlow`, then applies their `amend`
 * overrides. Everything else is re-exported so a consumer needs one import.
 */
export * from "./graph.js";
export { CORE_DATASET_NOTES } from "./notes.js";
export * from "./surfaces.js";
export * from "./types.js";

/** Core's entries: generic systems and code facts only. Anything naming a person's providers or devices is overlay. */
export const CORE_FLOW_ENTRIES: readonly FlowEntry[] = [
  ...FILE_ENTRIES,
  ...CALENDAR_ENTRIES,
  ...DEVICE_ENTRIES,
  ...MANUAL_ENTRIES,
  ...AGENT_ENTRIES,
  ...DERIVED_ENTRIES,
  ...READER_ENTRIES,
  ...PLANNED_ENTRIES
];

export interface DataFlowRegistryParts extends FlowRegistry {
  /** Amend keys the extensions supplied, so check S6 can name the ones that match no core entry. */
  amendKeys: readonly string[];
  /** Ids of the extensions that supplied a `dataFlow`, for check X1. */
  extensionIds: readonly string[];
}

function applyAmend(entry: FlowEntry, amend: NonNullable<DataFlowContribution["amend"]>[string]): FlowEntry {
  const { freshness, device, credentials, external, tokenName } = amend;
  return {
    ...entry,
    ...(freshness !== undefined ? { freshness } : {}),
    ...(device !== undefined ? { device } : {}),
    ...(credentials !== undefined ? { credentials } : {}),
    ...(external ? { code: { ...entry.code, external: [...(entry.code.external ?? []), ...external] } } : {}),
    ...(tokenName !== undefined && entry.health.kind === "last-used" ? { health: { ...entry.health, tokenName } } : {})
  };
}

/** Core plus every registered extension's share, stamped with its owner. Call it at use time, not at import. */
export function dataFlowRegistry(): DataFlowRegistryParts {
  const contributions = contractsExtensions().flatMap((extension) =>
    extension.dataFlow ? [{ id: extension.id, ...extension.dataFlow() }] : []
  );
  const amend = Object.assign({}, ...contributions.map((c) => c.amend ?? {})) as NonNullable<
    DataFlowContribution["amend"]
  >;
  const core = CORE_FLOW_ENTRIES.map((entry) => {
    const stamped: FlowEntry = { ...entry, owner: "core" };
    const override = amend[entry.id];
    return override ? applyAmend(stamped, override) : stamped;
  });
  const added = contributions.flatMap((c) => (c.entries ?? []).map((entry): FlowEntry => ({ ...entry, owner: c.id })));
  return {
    entries: [...core, ...added],
    datasets: [...CORE_DATASET_NOTES, ...contributions.flatMap((c) => c.datasets ?? [])],
    composedBuild: contributions.some((c) => c.composedBuild === true),
    amendKeys: Object.keys(amend),
    extensionIds: contributions.map((c) => c.id)
  };
}

/**
 * The graph of the registry as built now. `tables` is the schema's own table list (the portal passes the Drizzle
 * tables), so contracts never depends on the database package.
 */
export function dataFlowGraph(
  tables: readonly string[],
  options: GraphOptions = {},
  registry: FlowRegistry = dataFlowRegistry()
) {
  return buildFlowGraph(tables, registry, options);
}
