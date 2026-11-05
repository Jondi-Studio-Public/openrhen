/**
 * A stored requirement is a condition id, optionally tagged for a person: `pete@with` (physically
 * with you) or `pete@remote` (contactable). A bare id keeps exactly the meaning it always had, so
 * no stored row changes. Every reader of `action_requirements.context_key` and every pathway's
 * `contextIds` goes through `parseRequirementKey`, so the tag is split in one place only.
 */

export const REQUIREMENT_TAGS = ["with", "remote"] as const;
export type RequirementTag = (typeof REQUIREMENT_TAGS)[number];

export interface ParsedRequirementKey {
  /** The condition id with any tag removed. */
  id: string;
  tag: RequirementTag | null;
  /** The key as given. */
  key: string;
}

/**
 * Splits on the last `@`, and only when what follows is one of the closed tags. A defined condition
 * id wins: a contact whose real id is `anna@remote` still resolves as itself, which is why a caller
 * that has the definitions passes `isDefined`. Without it the key is read purely by its suffix.
 */
export function parseRequirementKey(key: string, isDefined?: (id: string) => boolean): ParsedRequirementKey {
  const bare: ParsedRequirementKey = { id: key, tag: null, key };
  if (isDefined?.(key)) return bare;
  const at = key.lastIndexOf("@");
  if (at <= 0) return bare;
  const suffix = key.slice(at + 1);
  const tag = REQUIREMENT_TAGS.find((candidate) => candidate === suffix);
  return tag ? { id: key.slice(0, at), tag, key } : bare;
}

export function formatRequirementKey(id: string, tag: RequirementTag | null): string {
  return tag ? `${id}@${tag}` : id;
}

/** The condition id a stored requirement key refers to, for a reader that only wants to find the definition. */
export function baseConditionId(key: string, isDefined?: (id: string) => boolean): string {
  return parseRequirementKey(key, isDefined).id;
}

/** True when `id` ends in a reserved tag, so it could never be told apart from a tagged requirement. */
export function idUsesReservedSuffix(id: string): boolean {
  return REQUIREMENT_TAGS.some((tag) => id.endsWith(`@${tag}`));
}
