export type ReferencePackScopeType =
  "all" | "plan" | "area" | "outcome" | "project" | "deliverable" | "action" | "fixed_commitments" | "fixed_commitment";
export type ReferencePackScope = { type: ReferencePackScopeType; id?: string };
export type ReferencePackScopes = ReferencePackScope[];

/**
 * What a pack is for. An add-only pack carries empty import sheets so an external tool can only
 * create; an editing pack pre-fills them with current records so the whole workbook updates.
 */
export type ReferencePackMode = "add" | "roundtrip";
