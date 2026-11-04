import type { ImportField } from "@openrhen/contracts";
import { localiseIsoText } from "@/shared/date-format";

const OVERRIDES: Record<string, string> = {
  setupBeforeMinutes: "Setup time before (min)",
  transitionAfterMinutes: "Wind-down time after (min)"
};

/**
 * A field's stored column name as a person reads it: "endsAt" becomes "Ends", "setupBeforeMinutes"
 * "Setup time before (min)". Only the display changes; the name stays the key the batch stores under.
 */
export function importFieldLabel(name: string): string {
  const override = OVERRIDES[name];
  if (override) return override;
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(" ");
  // A time column ("endsAt") reads as the event itself: "Ends", "Starts", "Due".
  if (words.length > 1 && words[words.length - 1] === "at") words.pop();
  if (words.length > 1 && words[words.length - 1] === "minutes") words.splice(-1, 1, "(min)");
  const text = words.join(" ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const BASIS_WORDS: Record<ImportField["basis"], string> = {
  explicit: "as given",
  inferred: "guessed",
  default: "default used",
  missing: "blank"
};

const BASIS_HINTS: Record<ImportField["basis"], string> = {
  explicit: "This value was in the file or typed by you.",
  inferred: "The importer worked this value out rather than reading it, so check it.",
  default: "The file left this blank, so a standard value was filled in.",
  missing: "Nothing was given for this."
};

/** Where a field's value came from, in words ("as given", "guessed · medium confidence"). */
export function importBasisLabel(field: Pick<ImportField, "basis" | "confidence" | "source">): string {
  if (field.source === "absent") return "not in file · left as is";
  const word = BASIS_WORDS[field.basis];
  // Confidence adds nothing to a value that was simply given or defaulted with full confidence.
  const sure = field.confidence === "high" && field.basis !== "inferred";
  return field.confidence && !sure ? `${word} · ${field.confidence} confidence` : word;
}

export const importBasisHint = (field: Pick<ImportField, "basis" | "source">): string =>
  field.source === "absent"
    ? "The file has no column for this, so the stored value is left alone."
    : BASIS_HINTS[field.basis];

/**
 * A validation message with the stored column names it quotes ("endsAt must be after startsAt.")
 * swapped for their plain labels. Only camelCase names are swapped: a one-word name already reads
 * as a word in a sentence.
 */
export function plainFieldMessage(message: string, names: readonly string[]): string {
  return names
    .filter((name) => /[a-z][A-Z]/.test(name))
    .reduce(
      (text, name) =>
        text.replace(new RegExp(`\\b${escapeRegExp(name)}\\b`, "g"), (match, offset: number) =>
          offset === 0 ? importFieldLabel(name) : importFieldLabel(name).toLowerCase()
        ),
      message
    );
}

/**
 * A record's validation message as a person reads it, in the card and the table alike: plain field
 * labels for the column names it quotes, and its instants in the batch's zone.
 */
export function plainImportMessage(message: string, names: readonly string[], timezone: string): string {
  return localiseIsoText(plainFieldMessage(message, names), timezone);
}

// A record's field names come from the file, so one can carry characters a pattern would read as syntax.
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
