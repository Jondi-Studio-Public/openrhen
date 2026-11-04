import type { ImportEntityType } from "@openrhen/contracts";

type KeyedImportEntityType = Exclude<ImportEntityType, "dependency" | "deliverable_dependency" | "entity_prerequisite">;
export type ReferenceKeyCandidate = { entityType: KeyedImportEntityType; entityId: string; label: string };
export type ReferenceKeyMap = Partial<Record<KeyedImportEntityType, Record<string, string>>>;

export function fallbackReferenceKey(candidate: ReferenceKeyCandidate) {
  const suffix = candidate.entityId.replaceAll("-", "").slice(0, 8).toLowerCase() || "record";
  return `manual-${slugify(candidate.label).slice(0, 92)}-${suffix}`.slice(0, 120);
}

function slugify(value: string) {
  return (
    value
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "record"
  );
}
