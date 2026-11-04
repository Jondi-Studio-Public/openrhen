import type { SnapshotTable, WriteSnapshot } from "./write-snapshot";
import type { TxSql } from "./sql-pool";

/**
 * Registry of what a feature the OpenRhen export leaves out adds to the entity commands: the rows it
 * settles when a commitment or a capture is decided, the captures an agent may not decide for the person, the source
 * types whose text stays out of a model, the snapshot rows its tables need and the references that keep a context from
 * being deleted. `private/index.ts` registers each extension on import; the export excludes that folder and ships an
 * empty `private/index.ts`.
 */

/** A row set an undo must keep: the table and the condition, with `t` the table alias. */
export interface SnapshotWatch {
  table: SnapshotTable;
  where: string;
  params: readonly unknown[];
}

export type SnapshotEvent =
  /** A series ends: `going` is the sub-select of the occurrences deleted, `$1` the rule id. */
  | { kind: "series-end"; ruleId: string; going: string }
  /** A save drops routine steps: `dropped` is the sub-select of their ids. */
  | { kind: "steps-dropped"; dropped: string; params: readonly unknown[] }
  /** A commitment is saved (cancelled or confirmed). */
  | { kind: "commitment"; id: string }
  /** A capture proposal is decided. */
  | { kind: "capture"; id: string };

export interface CaptureDecision {
  sourceType: string;
  externalId: string | null;
}

/** What an extension that owns a proposal type is given to confirm one. */
export interface ProposalConfirmation {
  tx: TxSql;
  userId: string;
  proposalId: string;
  sourceId: string;
  sourceType: string;
  /** The stored `proposed_fields`. */
  fields: Record<string, unknown>;
  /** The answers to its open questions, text only. */
  answers: Record<string, string>;
  /** An agent's confirm keeps the rows it touches so it can be undone; null for the person's own confirm. */
  snap: WriteSnapshot | null;
}

export interface EntityExtension {
  id: string;
  /** Proposal types this extension confirms itself (`confirmProposal`) instead of the generic draft. */
  proposalTypes?: readonly string[];
  /** Source types whose captured text is never given to a model or a pack. */
  textlessSourceTypes?: readonly string[];
  /** SQL that makes a context (`t`) in use, joined with OR into the delete guard. */
  contextInUse?: string;
  /** A refusal when an agent decides a capture of this source type for the person, else undefined. */
  agentCaptureRefusal?(sourceType: string, action: "confirm" | "decline"): string | undefined;
  /** A commitment was saved with this status. */
  afterCommitmentSaved?(tx: TxSql, args: { id: string; status: string }): Promise<void>;
  /** A capture proposal was confirmed into a record. */
  afterCaptureConfirmed?(
    tx: TxSql,
    args: CaptureDecision & { tentative: boolean; proposalType: string; targetId: string }
  ): Promise<void>;
  /**
   * A refusal when an agent confirms a stored proposal of `stored` type with a body that says `requested`, else
   * undefined. `forbidden` is the hard floor (a scope the route did not check); otherwise the body is just wrong.
   */
  agentProposalTypeRefusal?(
    stored: string,
    requested: string | undefined
  ): { forbidden: boolean; message: string } | undefined;
  /**
   * Confirms a proposal of one of `proposalTypes`, inside the command's transaction: writes the plan rows, marks the
   * capture confirmed and returns what the change feed records as evidence.
   */
  confirmProposal?(args: ProposalConfirmation): Promise<{ evidence: Record<string, unknown> }>;
  /** A capture proposal was ignored. */
  afterCaptureIgnored?(
    tx: TxSql,
    args: CaptureDecision & {
      userId: string;
      /** The stored `proposed_fields` before the ignore, and whether the proposal was still pending. */
      proposedFields: unknown;
      wasPending: boolean;
      snap: WriteSnapshot | null;
    }
  ): Promise<void>;
  snapshotWatches?(event: SnapshotEvent): SnapshotWatch[];
}

const extensions: EntityExtension[] = [];

export function registerEntityExtension(extension: EntityExtension): void {
  if (!extensions.some((existing) => existing.id === extension.id)) extensions.push(extension);
}

export function entityExtensions(): readonly EntityExtension[] {
  return extensions;
}

export function isTextlessSourceType(sourceType: string): boolean {
  return extensions.some((extension) => extension.textlessSourceTypes?.includes(sourceType));
}

export function contextInUseClauses(): string {
  return extensions
    .map((extension) => extension.contextInUse)
    .filter(Boolean)
    .map((clause) => `\n      OR ${clause}`)
    .join("");
}

export function agentCaptureRefusal(sourceType: string | undefined, action: "confirm" | "decline"): string | undefined {
  if (!sourceType) return undefined;
  for (const extension of extensions) {
    const refusal = extension.agentCaptureRefusal?.(sourceType, action);
    if (refusal) return refusal;
  }
  return undefined;
}

export function extensionSnapshotWatches(event: SnapshotEvent): SnapshotWatch[] {
  return extensions.flatMap((extension) => extension.snapshotWatches?.(event) ?? []);
}

/** The extension that confirms proposals of this type itself, if any. */
export function proposalOwner(proposalType: string): EntityExtension | undefined {
  return extensions.find((extension) => extension.proposalTypes?.includes(proposalType));
}

/** An agent's confirm whose body disagrees with the stored proposal's type, else undefined. */
export function agentProposalTypeRefusal(
  stored: string,
  requested: string | undefined
): { forbidden: boolean; message: string } | undefined {
  for (const extension of extensions) {
    const refusal = extension.agentProposalTypeRefusal?.(stored, requested);
    if (refusal) return refusal;
  }
  return undefined;
}
