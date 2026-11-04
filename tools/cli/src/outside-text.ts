import { UNTRUSTED_SOURCE_LABELS, calendarSourceConnections } from "@openrhen/contracts";
import { fenceUntrusted } from "./untrusted.js";

/**
 * Text someone else wrote that reaches an agent through the general read tools (list, show, search, state,
 * status, changes). The tools built for outside text (email, inbox, and any a command module adds) fence their whole result;
 * these read the portal's own plan, where only some records carry outside text, so the fence goes on the
 * field, not the tool: a capture or proposal that came from mail or another person, and a commitment imported
 * from a calendar. What the person or the portal wrote stays plain, and a plan with no outside text prints
 * exactly as before. Only the MCP result path calls this; CLI output for a person is never fenced.
 */

/** The tools whose result goes through `fenceOutsideText`. */
export const OUTSIDE_TEXT_READ_TOOLS: ReadonlySet<string> = new Set([
  "list",
  "show",
  "search",
  "state",
  "status",
  "changes"
]);

/** Source types the person's own hands or uploads produce; anything else unknown is treated as outside text. */
const ORDINARY_SOURCE_TYPES: ReadonlySet<string> = new Set([
  "manual_capture",
  "manual",
  "csv",
  "xlsx",
  "ai_text",
  "ai_image",
  "fixture",
  "import",
  "own_trip",
  "deliverable_text",
  "deliverable_upload"
]);

/** What a `sourceType` (or a commitment source link's provider) says about who wrote the text, as the fence label. */
export function outsideSourceLabel(sourceType: unknown): string | undefined {
  if (typeof sourceType !== "string") return undefined;
  const type = sourceType.toLowerCase();
  // A kind of outside text an extension registers names itself in the source type.
  for (const kind of Object.keys(UNTRUSTED_SOURCE_LABELS))
    if (kind !== "mail" && kind !== "file" && type.includes(kind)) return kind;
  if (type.includes("mail")) return "email";
  // A registered calendar source (its id or its `sources.source_type`) or any calendar-looking id.
  if (
    calendarSourceConnections().some(
      (manifest) => manifest.id === type || manifest.calendarSource?.sourceType === type
    ) ||
    // The primary (roster) source also writes other ids that start with its own.
    calendarSourceConnections().some(
      (manifest) => manifest.calendarSource?.role === "primary" && type.startsWith(manifest.id)
    ) ||
    type.includes("calendar")
  )
    return "calendar";
  if (ORDINARY_SOURCE_TYPES.has(type)) return undefined;
  // An id this build does not know (a connection added later) still wrote outside text: fence it, never trust it.
  return "external";
}

type Rec = Record<string, unknown>;
const isRec = (value: unknown): value is Rec => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The outside source a capture, proposal or commitment record names, or undefined when it names none or an
 * ordinary one (manual_capture, csv, xlsx, ai_text, ai_image). A commitment with no recorded source reads as
 * the person's own.
 */
export function outsideSourceOf(record: Rec): { type: string; label: string } | undefined {
  const candidates: unknown[] = [record.sourceType];
  if (Array.isArray(record.sources)) for (const link of record.sources) if (isRec(link)) candidates.push(link.provider);
  for (const candidate of candidates) {
    const label = outsideSourceLabel(candidate);
    if (label !== undefined) return { type: candidate as string, label };
  }
  return undefined;
}

/**
 * Re-adds `sourceType` to a row a caller projected down to a few fields (`list --fields`, `show` relations,
 * `search` hits) when the full record came from outside, so the fencing step can still tell. Rows from the
 * person's own records are returned as they were.
 */
export function keepProvenance<T extends object>(full: Rec, projected: T): T {
  const source = outsideSourceOf(full);
  if (source === undefined || (projected as Rec).sourceType !== undefined) return projected;
  return { ...projected, sourceType: source.type };
}

/** Text fields of a record that came from outside. */
// `value` is a `list --count --by <field>` group, which carries the source of its rows.
const TEXT_KEYS = ["text", "title", "name", "notes", "details", "location", "sourceTitle", "snippet", "body", "value"];
/** Fields whose whole value is outside text, with the leaves inside them fenced one by one. */
const DEEP_KEYS = ["proposedFields", "questions"];
/**
 * Values in a deep field that an agent has to use as they are: an id, an ISO time, or an enum-looking token. The
 * test is on the value, never the key, so free text under any key (`dueDate`, `status`) is fenced. A token with
 * no whitespace and only id characters cannot carry a sentence.
 */
const PLAIN_VALUE = /^[A-Za-z0-9_.:/+-]{1,64}$/;

/**
 * The key `status` adds beside its digest, for the MCP fence only (the fence removes it): the ids and titles of
 * commitments that came from outside, for places the digest names a commitment without its source.
 */
export const OUTSIDE_IDS_KEY = "outsideText";

/**
 * `status` shows commitment titles in many places (the directive, the day, upcoming) that carry an id but not
 * a source; the command lists the ids that came from outside here so the fence can find them. Ended
 * commitments are left out so the list stays as short as what the digest can show.
 */
export function outsideCommitments(
  commitments: readonly Rec[],
  endsAfter: Date
): { commitmentIds: string[]; commitmentTitles: string[] } {
  const outside = commitments.filter(
    (commitment) =>
      commitment.status !== "cancelled" &&
      typeof commitment.id === "string" &&
      typeof commitment.endsAt === "string" &&
      new Date(commitment.endsAt) >= endsAfter &&
      outsideSourceOf(commitment) !== undefined
  );
  return {
    commitmentIds: outside.map((commitment) => commitment.id as string),
    commitmentTitles: [
      ...new Set(outside.map((commitment) => commitment.title).filter((t): t is string => typeof t === "string"))
    ]
  };
}

/**
 * Wraps the outside-sourced text fields of a JSON tool result in the untrusted fence, string by string, so
 * the document stays valid JSON. `fenced` says whether anything was wrapped; the caller then sets
 * `_meta.untrusted`. Text that is not JSON is returned untouched.
 */
export function fenceOutsideText(text: string): { text: string; fenced: boolean } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { text, fenced: false };
  }
  const labelById = new Map<string, string>();
  const labelByTitle = new Map<string, string>();
  const marked = isRec(parsed) ? parsed[OUTSIDE_IDS_KEY] : undefined;
  if (isRec(marked)) {
    if (Array.isArray(marked.commitmentIds))
      for (const id of marked.commitmentIds) if (typeof id === "string") labelById.set(id, "calendar");
    if (Array.isArray(marked.commitmentTitles))
      for (const title of marked.commitmentTitles) if (typeof title === "string") labelByTitle.set(title, "calendar");
  }
  collectLabels(parsed, labelById, labelByTitle);

  let fenced = false;
  const fence = (label: string, value: string): string => {
    if (value === "") return value;
    fenced = true;
    return fenceUntrusted(label, value);
  };
  const fenceLeaves = (label: string, value: unknown): unknown => {
    if (typeof value === "string") return PLAIN_VALUE.test(value) ? value : fence(label, value);
    if (Array.isArray(value)) return value.map((entry) => fenceLeaves(label, entry));
    if (isRec(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fenceLeaves(label, v)]));
    return value;
  };
  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(walk);
    if (!isRec(value)) return value;
    const own = outsideSourceOf(value)?.label ?? labelFor(value, labelById);
    // A commitment named by id (`fitsBefore`, `wakeConstraint`) or as an anchor, or by title alone (a boundary).
    const linked = typeof value.commitmentId === "string" ? labelById.get(value.commitmentId) : undefined;
    const anchor = typeof value.anchorId === "string" ? labelById.get(value.anchorId) : undefined;
    const boundary = typeof value.boundaryTitle === "string" ? labelByTitle.get(value.boundaryTitle) : undefined;
    const out: Rec = {};
    for (const [key, entry] of Object.entries(value)) {
      const text = typeof entry === "string" ? entry : undefined;
      if (
        own !== undefined &&
        text !== undefined &&
        TEXT_KEYS.includes(key) &&
        !(key === "value" && PLAIN_VALUE.test(text))
      )
        out[key] = fence(own, text);
      else if (own !== undefined && DEEP_KEYS.includes(key)) out[key] = fenceLeaves(own, entry);
      else if (linked !== undefined && text !== undefined && key === "title") out[key] = fence(linked, text);
      else if (anchor !== undefined && text !== undefined && key === "anchorTitle") out[key] = fence(anchor, text);
      else if (boundary !== undefined && text !== undefined && (key === "boundaryTitle" || key === "title"))
        out[key] = fence(boundary, text);
      else if (text !== undefined && key === "anchorTitle" && labelByTitle.has(text))
        out[key] = fence(labelByTitle.get(text)!, text);
      else out[key] = walk(entry);
    }
    return out;
  };
  const result = walk(parsed);
  const hadMarker = isRec(parsed) && OUTSIDE_IDS_KEY in parsed;
  if (isRec(result)) delete result[OUTSIDE_IDS_KEY];
  if (!fenced && !hadMarker) return { text, fenced: false };
  return { text: JSON.stringify(result, null, text.includes("\n") ? 2 : undefined), fenced };
}

/** Every record in `value` with an outside source, by id, so a projection of the same record elsewhere is found. */
function collectLabels(value: unknown, into: Map<string, string>, titles: Map<string, string>): void {
  if (Array.isArray(value)) {
    for (const entry of value) collectLabels(entry, into, titles);
    return;
  }
  if (!isRec(value)) return;
  const source = outsideSourceOf(value);
  if (source !== undefined && typeof value.id === "string") {
    into.set(value.id, source.label);
    // A commitment (it has a start) is also named by title elsewhere, where no id rides along.
    if (typeof value.title === "string" && typeof value.startsAt === "string") titles.set(value.title, source.label);
  }
  for (const entry of Object.values(value)) collectLabels(entry, into, titles);
}

/** The label for a record shown without its source but with an id (`id`, or `targetId`) the output knows came from outside. */
function labelFor(record: Rec, labelById: ReadonlyMap<string, string>): string | undefined {
  for (const key of ["id", "targetId"]) {
    const id = record[key];
    if (typeof id === "string" && labelById.has(id)) return labelById.get(id);
  }
  return undefined;
}
