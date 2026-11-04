/**
 * The agent skill for working with OpenRhen through its CLI or MCP tools. It lives here, not as a
 * file under `.claude/skills/`, so the built `rhen` binary can print it (`rhen skill`,
 * or the `rhen_skill` MCP tool) and the copy an agent installs always matches the build that
 * serves it. It stays thin on purpose: the vocabulary, recipes and write rules belong to
 * `guide-content.ts`, and this only says where to start and what never to skip. The policy lines (what applies,
 * what is filed, what is refused, what the person keeps) are rendered from `agent-policy-text.ts` in
 * `@openrhen/contracts`. The text has two renderings, stdio and remote (`surface-text.ts`): the remote `/mcp`
 * serves no schema, help, version, skill, import or email-draft tool, so the remote rendering names none.
 */
import { agentContractLine, agentPolicyBullets } from "@openrhen/contracts";
import { commandModules, registeredInboxActRooms } from "./command-modules.js";
import { surfaceText, type TextSurface } from "./surface-text.js";

/** What the registered Inbox rooms add to the skill's Inbox section (each room's `skillNote`), indented, or nothing. */
const roomNotes = (): string =>
  registeredInboxActRooms()
    .flatMap((room) => (room.skillNote === undefined ? [] : [room.skillNote]))
    .map((note) => `\n${note}`)
    .join("");

/** What each registered command module adds to the Inbox section (its `skillNote`), after a blank line each. */
const moduleNotes = (): string =>
  commandModules()
    .flatMap((module) => (module.skillNote === undefined ? [] : [module.skillNote]))
    .map((note) => `\n\n${note}`)
    .join("");

const skillSource = (): string => `---
name: openrhen
<stdio>
description: Read and change the household plan in OpenRhen (areas, outcomes, projects, actions, commitments, deliverables, check-ins) through the rhen CLI or its MCP tools. Use when asked what to work on now, to look something up in the plan, to capture or update planning records, or to coordinate a deliverable.
</stdio>
<remote>
description: Read and change the household plan in OpenRhen (areas, outcomes, projects, actions, commitments, deliverables, check-ins) through its MCP tools. Use when asked what to work on now, to look something up in the plan, to capture or update planning records, or to work a deliverable.
</remote>
---

# Working with OpenRhen

OpenRhen is the household planning system.
${agentContractLine()}
<stdio>
You reach it through the \`rhen\` command line or, if your client has the OpenRhen MCP server connected,
through tools named \`rhen_<command>\` (the same commands, same options). Over MCP, pass options by their flag
name without the leading \`--\`, for example \`dry-run\`.
</stdio>
<remote>
You reach it through the OpenRhen MCP server, with tools named \`rhen_<command>\` (the command line's commands
with hyphens as underscores). Pass options by their flag name without the leading \`--\`, for example \`dry-run\`.
</remote>

## Start here

1. Call \`rhen_status\` (CLI: \`rhen status --json\`) for the present moment: the current
   directive with why it and why not the runner-up, the risks and today's plan, and whether a check-in is pending.
   Tell the person \`answer\`: it is the one thing to do now. \`recommendation.headline\` speaks only for the ranked task
   list, so it can say nothing fits while the directive is a routine step.
   Read status, not state, for why and for risks; \`rhen_forecast\` gives every project's health, margin and
   pace, and \`rhen_summary\` what got done over past days. Its \`needs\` lists facts that have aged out (a wake, a running or
   paused session, energy, a place, or the time left on an action in an at-risk project: answer that with a save of
   the action's remainingMinutes; giving the same figure again confirms it): ask the person each \`question\` and
   settle it with its \`answer\` (tool, action and the fields to give; a paused session is settled with a plain
   finish). Until then the plan treats that fact as unknown (an aged time left is still planned, at lower
   confidence), so do not repeat the old value.
2. Read the guide before acting on anything unfamiliar: \`rhen_guide\` with a topic of
   \`vocabulary\`, \`workflows\`, \`writing-data\`, \`reading-data\`, \`recurrence\`, \`limits\` or \`coordinating\`.
   Do not guess terms or recipes; the guide is generated from the build you are talking to.
<stdio>
3. Call \`rhen_schema\` with an entity or payload name before your first write of that type, so field
   names come from the contract and not from memory.
4. \`rhen_help\` with {"command": "<name>"} gives one command's options (with {} it returns every command, about 256 KB). \`rhen_version\` says which build is
   answering.
</stdio>
<remote>
3. Read a tool's input schema before its first use; the typed save tools list every field of their kind.
</remote>

## Reading

- Prefer \`rhen_list\` filters, \`--fields\`, \`--limit\` and \`--count\` to fetching everything.
  Over MCP a list with no limit is capped at 50 rows; the result tells you how to continue.
- Filters such as \`--project\` accept a title as well as an id.
- Search finds only what is still in play. Something that already happened (a past appointment, a finished
  action) is only found with \`status: any\` (CLI \`--status any\`), or by listing a time window; check that before
  deciding a record does not exist.
- \`rhen_map\` returns one item's neighbourhood (cards and edges) in one call; use it before walking
  relations by hand.

## Writing

- Run every write with \`dry-run\` first and check the payload it prints. A dry run checks only the shape of your
  arguments (field names, types, formats): it does not check that ids exist, duplicates, the version, evidence or your
  token's scopes, so a clean dry run is not a promise the write applies.
- A save carries the version it read. When a \`save\` updates a record you read, pass that version as
  \`expected-version\` (a new record has none, and other commands don't take it): if the record changed since,
  the save is refused (exit code 3, naming the current version). Any write can come back with a conflict:
  re-read the record, check the change still holds, and retry from the fresh copy; never force the old value
  through.
- A write that times out, loses its connection or gets a server error (5xx) may have landed. The tool
  retries a lost connection once with the same command id; if it still fails, repeat the call with the
  \`command-id\` its error names, so the portal applies it at most once. A 503 marked retryable that says
  "Saved" means the write is in and only the answer could not be read: repeat with the same key to read it.
  Never repeat a failed write without that key.
- A change that touches more than one record needs \`yes\`. Do not add it unless you meant the fan-out.
- There is no delete. Removal is a status change made through \`rhen_save\` (\`archived\`,
  \`cancelled\`, \`ended\` or \`ignored\`, depending on the entity; \`guide writing-data\` has the table).
  Ending a recurrence is still guarded: set its end date instead (\`guide recurrence\`).
- To start work in the past, pass \`started-at\` to \`session start\` or \`activity start\`, within the last 24
  hours. To end it in the past, pass \`ended-at\` to \`session finish\`; that also works once a forgotten session
  is awaiting feedback (its clock stopped at the planned end). A night is \`save sleep-log-entry --set sleepAt=... --set wakeAt=...\`; a wake is \`wake --at ...\`
  (with \`--slept-at\` when the bedtime is known), which settles last night's sleep as well and, with nothing to
  settle, records the wake alone. Correct a night by its id, never by logging a second one.
- A trip or any block of days is a span (\`span add --title ... --start ... --end ...\`), shown on the History
  calendar and never affecting the plan; work you did is a session. \`history --from --to\` reads a range.
- \`disruption\` is how to log anything unplanned you are doing now, interruption or not, a meal included
  (\`disruption start --title "Lunch" --duration 30\`). Never invent routine steps for it.
- When the person is running late or a task ran over there is no "late" command: log what ate the time with
  \`disruption start --title ... --when HH:MM --duration ...\` (the clock time it began; "-30m" is not accepted), or
  end a tracked task with \`session finish --outcome progress --remaining <minutes>\`, then \`recalculate\` and re-read
  \`status\`.
- Re-read after a write to confirm the plan now says what you intended.

## Saving records

<remote>
- Prefer the typed tools \`rhen_save_action\`, \`rhen_save_project\`,
  \`rhen_save_commitment\` and \`rhen_save_capture\`: \`rhen_save\` with the kind fixed, and their
  \`fields\` object has a JSON Schema listing every field, type and allowed value. For other kinds use
  \`rhen_save\` with \`entityType\` and \`fields\` as one object; \`set key=value\` still works for dotted edits.
</remote>
<stdio>
- Use \`rhen_save\` with \`entityType\` and \`fields\` as one object (CLI: \`--fields '<json>'\`); \`set key=value\`
  still works for dotted edits. The portal's remote /mcp also offers typed save tools per kind.
</stdio>
<stdio>
  \`rhen schema save-<kind>\` prints a kind's fields.
</stdio>
- No id creates. An id updates that record, your fields merged over the stored ones. An id that names no record
  is refused (exit 4, "No <kind> has the id ...") rather than creating a duplicate. To make a record with an id
  you chose, pass \`create: true\` (CLI \`--create\`); it updates that record if the id exists. Kinds whose create
  needs a chosen id (\`condition_definition\`, places) need \`create: true\`.
- A field the kind does not take is refused with the kind's field list; \`createdAt\` and \`updatedAt\` from an
  echoed read are dropped, and an echoed \`version\` is checked like \`expected-version\`. Read-only joined
  fields (a project's area or value, a commitment's sources) cannot be saved.
- Status synonyms map to the kind's own word (completed becomes done on an action, done becomes completed on a
  routine step, canceled becomes cancelled); a status the kind lacks is refused with its allowed list.
- Over MCP numbers (\`limit\`, \`depth\`, \`minutes\`) are real numbers, and \`payload-json\`, \`verdicts-json\` and
  \`targets-json\` take real objects or arrays (strings are still accepted).
- A done action takes \`completedAt\`, when it was really finished. \`blockingReason\` (why it waits) and \`note\`
  can go in an action's fields; both are kept in the change log.
- An action create fills what you leave out with defaults and lists them in \`assumedFields\`; one estimate figure
  (say \`expectedMinutes\` 45) fills the other two with it. A save that names a field takes it off that list, so
  ask for real figures rather than echoing the defaults back.

## Inbox

- \`rhen_inbox\` lists everything open in the Inbox by room (From people, Captured, Calendar & imports,
  Plan map, Someday & reference), each item with the command that acts on it. Start there when asked what is
  waiting, then go room by room with the person.
- Use \`rhen_inbox_act\` for its rooms (captured, kept, people, map), once the person agrees to
  the specific item or a confirm is plainly right (\`rhen_undo\` puts a confirm back; an ignore cannot be undone).
<stdio>
  Calendar & imports go through \`import\`.
</stdio>${roomNotes()}${moduleNotes()}

## Catch-up after a break

- \`rhen_status\` shows \`catchUp.state: "due"\` when the person has been away. Read \`rhen_catch_up\`,
  ask them what happened, then \`rhen_catch_up_settle\` only what they answered. It applies directly when your
  token holds \`write:catch-up\` and direct writes are on, otherwise it lands as a proposal for them to confirm in the Inbox. \`guide workflows\` recipe 12 has the verdict forms.
- \`rhen_status\` shows \`attention\`: call \`rhen_attention\` once (again only if a count rose), act on
  \`nextCall\`, \`askOwner\` and the step in \`why\`, and raise an owner item (\`who: owner\` or \`askOwner\`) once, only while
  the owner is present.
- A call that fails with \`reentry_required\` means the pulse lapsed: nothing else works until re-entry is done.
  \`rhen_reenter\` with no arguments reads the tier, the gap, what is missing, the items to review and the
  place and context ids. Ask the person where they are, their energy, their contexts and what happened in the
  window (never guess), then call it once with everything. It is all or nothing, a bulk answer never means done
  (mark done only what they confirmed), and \`rhen_undo\` reverses it.
- A 'doing something else' answer stays on plan only if you then call \`rhen_disrupt\` with all five:
  doing (or target), until, location, contexts (at least one) and exclusive (true if it takes all of them,
  false if they could still do other things). Ask the person for any you don't know; don't guess. A deviation
  with no disruption lapses at once and needs \`rhen_reenter\`. \`rhen_disrupt --end\` ends it early, a
  new on-track check-in also ends it, and undo reverses it. With no options it only reads what is in force and
  the place and context ids. It is not the older schedule-disruption tool (\`rhen_disruption\`).

## Limits

${agentPolicyBullets("the person", "full")}
- The server may be running read-only: write tools are then absent from the tool list. Say so and stop.
  When a refusal names a command, run it; otherwise tell the person what it says.
- \`save deliverable --set status=completed\` skips the workspace's completion gate. Drive a deliverable
  through its own \`rhen_deliverable\` subcommands instead (\`rhen_guide\` topic \`coordinating\`).
- Do not print, store or send the portal's contents anywhere the person did not ask for.
`;

export const SKILL_FLAVOURS = ["claude", "openclaw"] as const;
export type SkillFlavour = (typeof SKILL_FLAVOURS)[number];

/** The one line the openclaw flavour adds: which copy this is and where its version comes from. */
const OPENCLAW_HEADER =
  "Flavour: openclaw. This is the live text behind the OpenRhen OpenClaw plugin's own copy, which records the " +
  "contract version it was written for; if the version above is newer, tell the owner the plugin needs repacking.";

/** The skill as one surface serves it, for one agent flavour (claude is the base text). */
export function skillTextFor(surface: TextSurface, flavour: SkillFlavour = "claude"): string {
  const text = surfaceText(skillSource(), surface);
  if (flavour === "claude") return `${text}\n`;
  const marker = agentContractLine();
  return `${text.replace(marker, `${marker}\n${OPENCLAW_HEADER}`)}\n`;
}
