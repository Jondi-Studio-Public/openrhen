/**
 * The three refusals a command handler raises most: a record that is gone,
 * a record in the wrong state, a value outside its allowed set. Each is built here so a handler site stays one line and
 * every one says the same four things: what went wrong, which id or value, what is valid, and the exact next call.
 * The message reads fine to a person in the browser; `nextCall` and `validValues` ride beside it and the MCP surface
 * appends the call to the text, so an agent never has to guess.
 */
import type { AgentCall } from "./agent-error";

export interface Refusal {
  message: string;
  nextCall?: AgentCall;
  validValues?: Record<string, string[]>;
}

/**
 * Kinds of record a handler can find missing. `list` is the `entity` argument of `rhen_list` that shows the
 * owner's rows of that kind; a kind without one is looked up with `rhen_status` or by asking the person.
 */
const KINDS = {
  area: { label: "Area", list: "areas" },
  outcome: { label: "Outcome", list: "outcomes" },
  project: { label: "Project", list: "projects" },
  action: { label: "Action", list: "actions" },
  deliverable: { label: "Deliverable", list: "deliverables" },
  commitment: { label: "Commitment", list: "commitments" },
  "recurring commitment": { label: "Recurring commitment", list: "recurrence-rules" },
  routine: { label: "Routine", list: "routine-presets" },
  "routine step": { label: "Routine step", list: "routine-steps" },
  "sleep plan": { label: "Sleep plan", list: "sleep-plans" },
  "logged sleep": { label: "Logged sleep", list: "sleep" },
  span: { label: "Span", list: "spans" },
  session: { label: "Session", list: "sessions" },
  occurrence: { label: "Occurrence", list: "occurrences" },
  place: { label: "Place", list: "places" },
  context: { label: "Context", list: "condition-definitions" },
  capture: { label: "Capture", list: "captures" },
  "check-in": { label: "Check-in", status: true },
  proposal: { label: "Proposal", tool: "rhen_proposals" },
  submission: { label: "Submission", none: true },
  "photo check-in": { label: "Photo check-in", none: true },
  photo: { label: "Photo", none: true },
  "import batch": { label: "Import batch", none: true },
  "source file": { label: "Source file", none: true },
  "email thread": { label: "Email thread", none: true }
} as const satisfies Record<string, { label: string; list?: string; status?: true; tool?: string; none?: true }>;

export type RefusalKind = keyof typeof KINDS;

type KindEntry = { label: string; list?: string; status?: true; tool?: string; none?: true };
const entryFor = (kind: string): KindEntry => {
  const spaced = kind.replace(/[_-]+/g, " ");
  const table = KINDS as Record<string, KindEntry>;
  return (
    table[kind] ??
    table[spaced] ??
    table[spaced.replace(/ /g, "-")] ?? {
      label: `${spaced[0]?.toUpperCase() ?? ""}${spaced.slice(1)}`
    }
  );
};

export const REFUSAL_KINDS = Object.keys(KINDS) as RefusalKind[];

const cap = (text: string): string => (text.length > 80 ? `${text.slice(0, 80)}...` : text);
const quote = (value: unknown): string => {
  const text = typeof value === "string" ? value : value === null || value === undefined ? "" : String(value);
  return text === "" ? "(none given)" : `"${text.length > 80 ? `${text.slice(0, 80)}...` : text}"`;
};

/** The call that shows the ids of `kind`, or undefined when the kind has no list the agent can read. */
export function listCallFor(kind: RefusalKind | (string & {})): AgentCall | undefined {
  const entry = entryFor(kind);
  if (entry.none) return undefined;
  if (entry.list)
    return {
      tool: "rhen_list",
      arguments: { entity: entry.list, limit: 20 },
      note: "use an id from the rows returned"
    };
  if (entry.status) return { tool: "rhen_status", arguments: {}, note: "the pending check-in is shown there" };
  if (entry.tool) return { tool: entry.tool, arguments: {}, note: "use an id from the rows returned" };
  return undefined;
}

/** "Project "p1" no longer exists (it was removed, or the id is wrong)." plus the call that lists the real ids. */
export function notFoundRefusal(kind: RefusalKind | (string & {}), id: unknown, what?: string): Refusal {
  const label = what ?? entryFor(kind).label;
  const call = listCallFor(kind);
  // Ids are never matched by title. A value with spaces is a title that was sent where an id belongs: say so, and give the
  // search that turns the words into an id, instead of calling a title a record that "no longer exists".
  if (typeof id === "string" && /\s/.test(id.trim()) && !entryFor(kind).none)
    return {
      message:
        `${label} ${quote(id)} is not an id: it looks like a title, and records are named by id, never by title (nothing was matched or changed). ` +
        `Find the id with rhen_search ${JSON.stringify({ query: id.trim().slice(0, 80) })}` +
        (call !== undefined && call.tool === "rhen_list"
          ? ` or by listing with rhen_list ${JSON.stringify({ entity: call.arguments.entity })}`
          : "") +
        ", then repeat the call with that id.",
      ...(call === undefined ? {} : { nextCall: call })
    };
  return {
    message:
      // `null`: the handler only has a hashed id, so the text points at what the caller sent instead of showing it.
      `${label} ${id === null ? "you named" : quote(id)} no longer exists, or never existed (the id may be wrong).` +
      (call !== undefined
        ? ""
        : entryFor(kind).none
          ? " Ask the person which one they mean."
          : ' Find it by words with rhen_search, setting "query" to words from its title.'),
    ...(call === undefined ? {} : { nextCall: call })
  };
}

/**
 * A record in a state the command cannot act on. `state` is what it is now, `allowed` what the command accepts; `instead`
 * is the one call that moves it on (finish the open session, reopen the item), when there is one.
 */
export function wrongStateRefusal(input: {
  kind: string;
  id?: unknown;
  state: string;
  allowed?: readonly string[];
  /** What the command needs, when it is not a list of states ("a running session"). */
  needs?: string;
  nextCall?: AgentCall;
}): Refusal {
  const who = input.id === undefined ? input.kind : `${input.kind} ${quote(input.id)}`;
  const allowed = input.allowed ?? [];
  const need =
    allowed.length > 0
      ? ` This command needs it to be ${allowed.join(" or ")}.`
      : input.needs
        ? ` This command needs ${input.needs}.`
        : "";
  return {
    message: `${who[0]?.toUpperCase() ?? ""}${who.slice(1)} is ${input.state} now, so this cannot be done.${need}`,
    ...(input.nextCall === undefined ? {} : { nextCall: input.nextCall }),
    ...(allowed.length > 0 ? { validValues: { state: [...allowed] } } : {})
  };
}

/**
 * A value outside its allowed set. `field` is the argument or field name as the agent sends it, `valid` the allowed
 * values; `nextCall` reads them from the owner's data when they are not a fixed list (places, contexts).
 */
export function invalidChoiceRefusal(
  field: string,
  got: unknown,
  valid: readonly string[],
  options: { label?: string; nextCall?: AgentCall } = {}
): Refusal {
  const label = options.label ?? field;
  const shown =
    valid.length > 12 ? `${valid.slice(0, 12).join(", ")} (and ${valid.length - 12} more)` : valid.join(", ");
  return {
    message:
      `${label[0]?.toUpperCase() ?? ""}${label.slice(1)} ${quote(got)} is not valid.` +
      (valid.length > 0 ? ` Use one of: ${shown}.` : " Nothing is available to choose from yet."),
    validValues: { [field]: [...valid] },
    ...(options.nextCall === undefined ? {} : { nextCall: options.nextCall })
  };
}

/** The refusal as one string with its next call spelled out, for the places that return only a message (the catch-up settle outcomes). */
export function refusalText(refusal: Refusal): string {
  const call = refusal.nextCall;
  return call === undefined
    ? refusal.message
    : `${refusal.message} Next call: ${call.tool} ${JSON.stringify(call.arguments)}${call.note ? ` (${call.note})` : ""}.`;
}

const shown = (value: unknown): string =>
  typeof value === "string"
    ? quote(value)
    : value === undefined
      ? "(not given)"
      : cap(JSON.stringify(value) ?? String(value));

/** A number outside its allowed range: names the field, the value sent, the range, and what to do. */
export function outOfRangeRefusal(label: string, got: unknown, min: number, max: number, unit = ""): Refusal {
  const range = `${min.toLocaleString("en-US")} to ${max.toLocaleString("en-US")}${unit === "" ? "" : ` ${unit}`}`;
  return {
    message: `${label} ${shown(got)} is out of range: send a whole number from ${range}. Repeat the same call with the corrected value.`
  };
}

/** A value of the wrong shape: names the field, the value sent, what is expected and an example. */
export function badValueRefusal(label: string, got: unknown, expected: string, example?: string): Refusal {
  return {
    message:
      `${label} ${shown(got)} is not valid: ${expected}.` +
      (example === undefined ? "" : ` For example ${example}.`) +
      " Repeat the same call with the corrected value."
  };
}

/** A required value that was not sent. */
export function requiredRefusal(label: string, example?: string): Refusal {
  return {
    message: `${label} is required but was empty or not sent.${example === undefined ? "" : ` For example ${example}.`} Repeat the same call with it set.`
  };
}

/**
 * The `entity` argument of `rhen_show` for a kind of record named in a version conflict, so the refusal can send the
 * exact read call. Every value must be an entity the show command resolves (checked in the CLI tests); a kind with no
 * entry (the check-in) has no show call and is read with `rhen_status`.
 */
export const SHOW_ENTITIES: Readonly<Record<string, string>> = {
  action: "action",
  area: "area",
  outcome: "outcome",
  project: "project",
  deliverable: "deliverable",
  commitment: "commitment",
  "recurring commitment": "commitment-rule",
  "routine step": "routine-step",
  "sleep plan": "sleep-plan",
  session: "session"
};
