/**
 * Registry of what a feature the OpenRhen export leaves out adds to the import review: the conflict
 * wording, the relationship keys and the held-cancel rules its records carry. Pure, so the server (validation) and the
 * client (the review screen) read the same answers. `private/index.ts` registers each extension on import; the export
 * excludes that folder and ships an empty `index.ts`, so every lookup answers "nothing".
 */
export interface ImportHold {
  id: string;
  /** Whether an error on a conflict record is one of this extension's own diff explanations. */
  isConflictMessage(message: string): boolean;
  /** Relationship keys a held overlap or hold sets; "Apply anyway" drops them. */
  overlapRelationshipKeys: readonly string[];
  /** Error line prefixes "Apply anyway" clears. */
  overlapErrorPrefixes: readonly string[];
  /** Relationship keys that mark a cancel held because the commitment was edited since; "Cancel anyway" drops them. */
  heldCancelKeys: readonly string[];
  /** Error line prefixes a held cancel carries that "Cancel anyway" clears. */
  heldCancelPrefixes: readonly string[];
  /** Relationship keys the review screen manages itself. */
  managedRelationshipKeys: readonly string[];
}

const holds: ImportHold[] = [];

export function registerImportHold(hold: ImportHold): void {
  if (!holds.some((existing) => existing.id === hold.id)) holds.push(hold);
}

export const isHoldConflictMessage = (message: string): boolean =>
  holds.some((hold) => hold.isConflictMessage(message));
export const holdOverlapRelationshipKeys = (): string[] => holds.flatMap((hold) => [...hold.overlapRelationshipKeys]);
export const holdOverlapErrorPrefixes = (): string[] => holds.flatMap((hold) => [...hold.overlapErrorPrefixes]);
export const holdCancelKeys = (): string[] => holds.flatMap((hold) => [...hold.heldCancelKeys]);
export const holdCancelPrefixes = (): string[] => holds.flatMap((hold) => [...hold.heldCancelPrefixes]);
export const holdManagedRelationshipKeys = (): string[] => holds.flatMap((hold) => [...hold.managedRelationshipKeys]);
