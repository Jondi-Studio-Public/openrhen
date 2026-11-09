import type { DataFlowContribution } from "./data-flow/types.js";
import type { ActivitySourceEntry } from "./activity-events.js";
import type { McpToolManifestEntry } from "./mcp-manifest.js";

/**
 * Registry of what an optional feature adds to the shared contracts (P4-13, the seam rule in
 * the design notes). The agent route tables, the scope vocabulary, the MCP manifest, the source
 * labels and the untrusted-text fence are core code; a feature the OpenRhen export leaves out
 * registers its share here from `private/`, so the same source builds with and without it.
 *
 * `private/index.ts` lists every extension and registers each on import; the export excludes that folder and
 * ships an empty `private/index.ts`. Every consumer imports `./private/index.js` before it reads a table, so a
 * table is complete the first time it is read. This file imports nothing at run time, which keeps that safe.
 */

/** A write route that is one `WriteCall`, decided by the route alone. */
export interface FixedWriteRoute {
  tool: string;
  room?: string;
  action?: string;
}

/** A floor rule: a call that lands as a proposal, with where the person does it and why. */
export interface FloorRule {
  matches(call: { tool: string; room?: string | undefined; action?: string | undefined }): boolean;
  place: string;
  message(path: string): string;
}

export interface RouteExtension {
  /** `METHOD route` to what the owner-only write is called. */
  ownerRoutes?: Record<string, string>;
  /** `METHOD route` to where the person does it (for the routes with a clear home). */
  ownerWhere?: Record<string, string>;
  /** Owner write routes that are jobs or device reports, `METHOD route`. */
  ownerRunsItself?: string[];
  /** Owner-only reads, by route. */
  ownerReads?: string[];
  /** Read route to the scope it needs. */
  readRules?: Record<string, string>;
  /** `METHOD route` to the single write call the route is. */
  fixedWrites?: Record<string, FixedWriteRoute>;
  /** Routes the worker may call with a worker token (GET and POST). */
  workerRoutes?: string[];
}

/**
 * Where an extension's MCP tools sit in the manifest, and the core entries it changes (by name).
 *
 * `overrides` is either the replacement entries, written out, or a function that derives them from the core entries
 * (`MCP_CORE_TOOL_MANIFEST`, before any extension). Prefer the function: it copies nothing from core, so a core text
 * change reaches the replacement without anyone regenerating it. It runs once, when the extended manifest is built,
 * and must be pure; it receives the core entries only, so it cannot read the manifest it is part of.
 */
export interface McpToolPlacement {
  after: string;
  tools: McpToolManifestEntry[];
  overrides?: McpToolManifestEntry[] | McpToolOverrides;
}

/** Derives the replacement entries from the core entries; each replaces the core entry of the same name. */
export type McpToolOverrides = (coreEntries: readonly McpToolManifestEntry[]) => McpToolManifestEntry[];

/** How often a worker runs a provider, and how late its last success may be before doctor says so. */
export interface SyncCadence {
  intervalMs: number;
  lateAfterMs: number;
}

export interface ContractsExtension {
  /** Stable name; registering the same id twice is a no-op. */
  id: string;
  /** Source ids that share the id column with connection ids and so are reserved, each with its display label. */
  sourceIds?: Record<string, string>;
  /**
   * Activity sources the extension adds, by name. Each name starts with the extension id plus `-`, matches the core
   * source-name rule, names an existing family, and must not shadow a core source; the merged readers
   * (`isKnownActivitySource`, `activityKindsOf`) throw on a source that breaks this.
   */
  activitySources?: Record<string, ActivitySourceEntry>;
  /** What each extra `untrustedOutput` value is called in the fence. */
  untrustedLabels?: Record<string, string>;
  /** Extra read scopes. */
  readScopes?: string[];
  /** Other scopes the vocabulary knows. */
  knownScopes?: string[];
  /** Scopes an `inbox-act` call needs, when the extension owns the room; undefined passes. */
  inboxActScopes?: (call: { room?: string | undefined; action?: string | undefined }) => string[] | undefined;
  floorRules?: FloorRule[];
  routes?: RouteExtension;
  /** MCP tools the extension adds, with the manifest entry they follow, and the core entries it changes (by name). */
  mcpTools?: McpToolPlacement | McpToolPlacement[];
  /** Write tools whose scopes are fixed by the tool alone, by tool name (the CLI tool the extension adds). */
  toolScopes?: Record<string, readonly string[]>;
  /**
   * The write call an agent's confirm of a capture proposal is, when the extension owns that proposal type (the
   * entity's `proposalType`); undefined passes to the core `inbox-act` confirm.
   */
  captureConfirmCall?: (
    entity: Record<string, unknown>
  ) => { tool: string; room?: string; action?: string } | undefined;
  /** How often the worker runs each provider the extension adds, by provider name (doctor's late-sync check). */
  syncCadence?: Record<string, SyncCadence>;
  /**
   * What the extension adds to the data-flow registry (`data-flow/`): entries, dataset notes, overrides on core
   * entries and the `composedBuild` flag. A function, so a client bundle never evaluates the entries. Each extension
   * that supplies one uses its own id (`data-flow-<name>`).
   */
  dataFlow?: () => DataFlowContribution;
  /** The required arguments of each tool it adds, as the contract snapshot records them. */
  contractSnapshotTools?: Record<string, string[]>;
  /** What the extension adds to the agent policy prose (agent-policy-text.ts), each in its full and brief wording. */
  policy?: {
    /** Kinds of Inbox item an agent may confirm beyond the core ones, each with the tool that does it. */
    confirmKinds?: { noun: string; tool: string }[];
    /** Things that stay the person's to confirm, joined into the first sentence of the confirm exceptions. */
    confirmExceptions?: string[];
    /** Outward actions that are refused, e.g. "replying to X" / "X replies". */
    refusedOutward?: { full: string; brief: string }[];
    /** Kinds of text from other people that the untrusted-text line names. */
    outsideText?: { full: string; brief: string }[];
  };
}

const extensions = new Map<string, ContractsExtension>();

export function registerContractsExtension(extension: ContractsExtension): void {
  if (!extensions.has(extension.id)) extensions.set(extension.id, extension);
}

export function contractsExtensions(): readonly ContractsExtension[] {
  return [...extensions.values()];
}

/** Empties the registry and returns the function that puts it back (see `withoutContractsExtensions`). */
export function suspendContractsExtensions(): () => void {
  const held = [...extensions];
  extensions.clear();
  return () => {
    // Whatever was registered meanwhile (a test's fixture) goes too, so the registry is exactly as it was.
    extensions.clear();
    for (const [id, extension] of held) extensions.set(id, extension);
  };
}

/** The record entries of one field across every extension, merged. */
export function mergedRecord<T>(
  pick: (extension: ContractsExtension) => Record<string, T> | undefined
): Record<string, T> {
  return Object.assign({}, ...contractsExtensions().map((extension) => pick(extension) ?? {}));
}

/** The list entries of one field across every extension, concatenated. */
export function mergedList<T>(pick: (extension: ContractsExtension) => readonly T[] | undefined): T[] {
  return contractsExtensions().flatMap((extension) => [...(pick(extension) ?? [])]);
}

/** The required arguments of every tool an extension adds, for the contract snapshot. */
export function extensionContractSnapshotTools(): Record<string, string[]> {
  return mergedRecord((extension) => extension.contractSnapshotTools);
}
