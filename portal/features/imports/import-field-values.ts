import type { ImportEntityType, ImportField } from "@openrhen/contracts";
import { convertImportValue } from "@/features/imports/import-csv";
import { importFieldKind, importFieldSpec } from "@/features/imports/import-spec";
import { formatImportWeekdays } from "@/features/imports/import-weekdays";

/**
 * The value the review screen is allowed to fill in for a field the source left blank, or undefined
 * when the field has none. A field only offers "Apply default" when its column spec carries one, so
 * the spec is the single description of what the import review may invent on the user's behalf.
 */
export function importDefault(type: ImportEntityType, name: string): unknown {
  return importFieldSpec(type, name)?.default;
}

/**
 * A field the user typed during review: blank clears back to missing, everything else is explicit.
 * Either way it is now a cell the user has touched — an absent column that is typed into, or
 * cleared, is no longer left alone on commit. The text is read the way the column's kind says, the
 * same reading a cell in a file gets, except that a number that is not one is kept as NaN (which
 * the batch stores as null) rather than as text.
 */
export function userField(raw: string, name: string): ImportField {
  if (!raw.trim())
    return { value: null, basis: "missing", confidence: null, evidence: [], needsReview: true, source: "cell" };
  const kind = importFieldKind(name);
  const value =
    kind === "number"
      ? Number(raw)
      : kind === "boolean"
        ? ["true", "yes", "1"].includes(raw.toLowerCase())
        : kind === "list" || kind === "weekdays" || kind === "pathwayGroups" || kind === "requirementPathways"
          ? convertImportValue(raw, { header: name, name, kind })
          : raw;
  return {
    value,
    basis: "explicit",
    confidence: "high",
    evidence: ["Entered by user during import review"],
    needsReview: false,
    source: "cell"
  };
}

/**
 * A buffer carried over from a saved location rather than typed, so the evidence names the source.
 * Choosing the place is an act of filling the cell in, so it counts as one: the value is written on
 * commit rather than left alone the way an untouched absent column would be.
 */
export function derivedField(value: number, location: string): ImportField {
  return {
    value,
    basis: "default",
    confidence: "high",
    evidence: [`Applied from saved location ${location}`],
    needsReview: false,
    source: "cell"
  };
}

/** How a field's value reads in a text box: lists pipe-joined, pathway routes in their `+`/`|` syntax. */
export const displayFieldValue = (value: unknown, kind?: string): string => {
  if (value === null || value === undefined) return "";
  if (kind === "weekdays" && Array.isArray(value)) return formatImportWeekdays(value);
  if (Array.isArray(value))
    return value
      .map((item) =>
        Array.isArray(item)
          ? item.join("+")
          : item && typeof item === "object" && Array.isArray((item as { contextIds?: unknown }).contextIds)
            ? (item as { contextIds: unknown[] }).contextIds.join("+")
            : String(item)
      )
      .join(Array.isArray(value[0]) || (value[0] && typeof value[0] === "object") ? " | " : "|");
  return String(value);
};
