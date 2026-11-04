import {
  ENTITY_FIELD_SCHEMAS,
  type McpToolInputSchema,
  type McpToolManifestEntry,
  type SaveEntityKind
} from "@openrhen/contracts";
import { z } from "zod";
import type { CommandSpec } from "./command.js";
import { commandModules } from "./command-modules.js";
import { toolAnnotations, toolDescription, toolInputSchema, toolName } from "./commands/mcp.js";
import { COMMON_PARAMS, REMOTE_TOOL_TEXT, type RemoteToolText } from "./remote-text.js";

/**
 * The commands the portal's remote `/mcp` endpoint serves, and how each differs from its stdio tool
 *. One definition: name, description, schema and annotations come
 * from the registry; this table only picks the commands, drops options that make no sense off the machine (a
 * local file path, `pretty`), rewords the few that a remote client reads differently, and says which scopes the
 * tool needs to appear in `tools/list`. The endpoint runs the real command in-process, so the tool behaves as its
 * stdio twin does; the portal's route wrapper decides, request by request, what the token may actually do (the
 * scopes here only hide what a token could never call). The result is written to
 * `platform/contracts/src/mcp-manifest-data.ts` by `pnpm manifest`.
 *
 * Not served, by design: `agent-token` and `owner-token` (owner only), `import` (files), an outward-message command,
 * `self-update`, `mcp`, `help`, `version`
 * and `schema` (the guide covers vocabulary and recipes). Every text served to a remote agent (the guide, the
 * skill, the instructions, the plugin's SKILL.md, these descriptions) may name only what is served: a test
 * (`agent-text-drift.test.ts`) fails when one names a tool or command that is not in this table.
 */
export interface RemoteTool {
  command: string;
  /** For a command module's tool: the core tool it is placed after, in place of the module's `remoteAfter`. */
  after?: string;
  /** The tool's name when it is not the command's own: a typed save tool is `rhen_save_<kind>`. */
  name?: string;
  /**
   * Earlier names of this tool, kept for one contract version after a rename (`AGENT_CONTRACT_VERSION`). Each is served
   * as an extra tool that runs the same command with the same schema and scopes, whose description says it was renamed;
   * delete the alias when the contract version is next bumped.
   */
  aliases?: string[];
  /** Arguments always sent and left out of the schema (a typed save tool's entity kind). */
  fixed?: Record<string, string>;
  /** For a typed save tool: the kind whose zod field schema types its `fields` argument. */
  fieldsOf?: SaveEntityKind;
  /**
   * Every scope a caller must hold to see and call the tool, so `tools/list` never shows a tool that would only 403.
   * A write lists the tool's own scope from the scope table (`requiredScopes`), the scope its routes ask for when that
   * differs (`arrive` saves a `current_availability`), and `read:plan` when the command reads the plan first (most do).
   * `save` and `bulk` list the broad `propose:entity`, since the real scope depends on the entity type and the route
   * decides per request. Empty only for a command that never reads or writes portal data.
   */
  scopes: string[];
  /** A token holding any one of these may list the tool and call it with no arguments (see `McpToolManifestEntry.readableWithAnyOf`). */
  readableWithAnyOf?: string[];
  /** The remote wording (description, arguments, enums, schemas) for a tool of a command module; core tools use `REMOTE_TOOL_TEXT`. */
  text?: RemoteToolText;
  omit?: string[];
  /** Narrows an argument's enum to these values (a subcommand that needs the machine, like a file export, is left out). */
  only?: Record<string, string[]>;
  describe?: Record<string, string>;
  /** Replaces the registry description, for a command whose CLI text names flags a remote client cannot pass. */
  description?: string;
  /** Exact phrases of the registry description to reword for a remote client (each must occur once), when `description` would copy too much. */
  rewrite?: [from: string, to: string][];
}

/**
 * `undo` over `/mcp`: the registry text also covers `--any-owner` and `--force`, which are left out here (the
 * person's Agent changes list is the door for those), and it takes no `command-id` because each undo sends its own
 * fresh write: repeating the call reverses the next older entry, so a retry names the entry by `id`.
 */
const UNDO_DESCRIPTION =
  "Reverses your latest recorded write (redo: true reapplies the one you just undid). Covers your saves (new " +
  "records included), skip-step/unskip-step, pause/resume, arrive, review keep, span add/set, recurrence, cadence " +
  "and activity writes, a deliverable move, an Inbox confirm, a wake, a disrupt, a disruption and a re-entry, and a session, check-in or catch-up settle: the portal restores the rows " +
  "the write touched exactly as they were, and removes a record it added, spans included. list: true shows what is " +
  "recorded, with each entry's id. Without id this reverses your newest write, so repeating the call goes one write " +
  "further back; to retry after a timeout or a doubtful answer, pass id (from list) so the same entry is not " +
  "reversed twice. Only your own writes are reversed. If anything the write touched changed since, nothing is " +
  "overwritten and the answer says so: leave it to the person. Writes of other kinds (email, imports, " +
  "a deliverable's notes) are not recorded; a bulk edit is recorded row by row, so each call reverses one row. Anything the " +
  "person undid from their Agent changes list is theirs to put back, not yours.";

/**
 * `deliverable` over `/mcp`: the same coordination the CLI has, with the payload as an object argument instead of a
 * file. `handoff` (builds a prompt for a CLI user; `pick-up` is the remote start) and `export-sources` (writes files
 * on the machine) are left out.
 */
const DELIVERABLE_DESCRIPTION =
  "Drives a deliverable (a piece of work with a contract of criteria and a plan of steps) from pick-up to drop-off. " +
  "Start with pick-up <id> (the exact title works): it records that you took it and returns the pack (criteria, " +
  "steps and which are executable, blockers, sources, transcript, rules); pack re-reads it; next (no id) names what " +
  "to work on. Moves, each applied at once: add-to-breakdown, extend-plan (payload: steps and criteria to add), " +
  "approve (approves the contract and plan together and starts carry-out), complete-steps (steps, evidence), begin-review, " +
  "record-review (payload: a verdict per required criterion), record-blocker (description, category, steps), " +
  "resolve-blocker (blocker: the exact description; note; feedback is kept as a source), submit (waiting-for). " +
  "note records progress; drop-off ends the handoff with what was decided, done and left open. rhen_guide " +
  "coordinating has the rules, payload shapes and revision loop. Every answer arrives fenced as data. " +
  "rhen_undo reverses a move (a source kept by resolve-blocker feedback and the note, pick-up and drop-off " +
  "rows stay). Reviewing proposed contract requirements and completing the deliverable are the person's.";

/**
 * The kinds agents save most get a tool each, whose `fields` argument carries the kind's own JSON Schema (built from
 * its zod schema in `@openrhen/contracts`), so a client sees every field, its type and its allowed values without
 * reading the guide. The other kinds use `rhen_save`, where `fields` is an open object and a wrong field name
 * is refused with the kind's list.
 */
const TYPED_SAVE_KINDS: { kind: SaveEntityKind; what: string; required: string; defaults: string }[] = [
  {
    kind: "action",
    what: "an action (a step of work under a project)",
    required: "projectId and title",
    defaults:
      "status planned, a 60-minute estimate (listed in assumedFields), importance and consequence 3 (1-5), medium energy. " +
      "Minutes are whole numbers; times are ISO 8601 with an offset. contexts and dependencyIds are ids from " +
      "rhen_list conditions and actions"
  },
  {
    kind: "project",
    what: "a project",
    required: "outcomeId and title",
    defaults:
      "status active, uncertainty some (pads action estimates), consequence 3. internalDeadlineAt is the owner's own " +
      "target (it can lapse); externalDeadlineAt is a real outside date"
  },
  {
    kind: "commitment",
    what: "a commitment (a fixed time: an appointment, a shift, a class)",
    required: "title, startsAt and endsAt (ISO 8601 with an offset) and status",
    defaults: "Statuses are listed in rhen_guide writing-data"
  },
  {
    kind: "capture",
    what: "a capture (an Inbox item waiting to be reviewed)",
    required: "text",
    defaults: "status pending. To file a new one-line thought use rhen_capture; use this to edit or restore one"
  }
];

function typedSaveDescription(kind: SaveEntityKind, what: string, required: string, defaults: string): string {
  return (
    `Creates or updates ${what}: rhen_save with entityType ${kind}, every field checked (its rules for id, ` +
    `create, expected-version and removal by status apply). Required on create: ${required}. Defaults: ${defaults}. ` +
    "Returns and undoes as rhen_save does."
  );
}

/** Short hints for the fields an agent most often has to guess at, added where the kind's schema has no description. */
const FIELD_HINTS: Record<string, string> = {
  importance: "1-5: how much the owner cares (default 3).",
  consequence: "1-5: what happens if it is missed (default 3).",
  energy: "high, medium, low or recovery: the energy the work needs.",
  contexts: "Ids of the conditions that must hold (rhen_list conditions).",
  dependencyIds: "Ids of actions that must finish first (rhen_list actions).",
  schedulingMode: "one_off, recurring or cadence.",
  uncertainty: "known, some or high: how unsure the estimates are; pads them.",
  internalDeadlineAt: "The owner's own target date; it can lapse. ISO 8601 with offset.",
  externalDeadlineAt: "A real outside deadline. ISO 8601 with offset.",
  expectedMinutes:
    "Whole minutes expected. On a create, optimistic and pessimistic are filled from it if left out; on an update they are NOT: send optimisticMinutes, expectedMinutes and pessimisticMinutes together (optimistic <= expected <= pessimistic)."
};

/**
 * Drops the long pattern zod writes beside a `date-time` (or other) format: the format says the same thing to a
 * client, and the pattern alone would be most of the tool list's size. The CLI's zod check still applies it.
 */
function withoutFormatPatterns(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutFormatPatterns);
  if (value === null || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(record)
      .filter(([key]) => !(key === "pattern" && typeof record.format === "string"))
      .map(([key, item]) => [key, withoutFormatPatterns(item)])
  );
}

/** The kind's fields as a JSON Schema object property. Nothing is required: an update names only what changes. */
export function fieldsProperty(kind: SaveEntityKind): Record<string, unknown> {
  const generated = z.toJSONSchema(ENTITY_FIELD_SCHEMAS[kind], { io: "input", unrepresentable: "any" }) as Record<
    string,
    unknown
  >;
  const {
    $schema: _schema,
    required: _required,
    ...rest
  } = withoutFormatPatterns(generated) as Record<string, unknown>;
  const properties = Object.fromEntries(
    Object.entries((rest.properties ?? {}) as Record<string, Record<string, unknown>>).map(([field, schema]) => [
      field,
      schema.description === undefined && field in FIELD_HINTS ? { ...schema, description: FIELD_HINTS[field] } : schema
    ])
  );
  return {
    ...rest,
    properties,
    type: "object",
    description: `The ${kind}'s fields. On create, give what the kind needs; on update, only what changes.`
  };
}

/** The commands that need the live portal say so by naming --state-file, which a remote client cannot pass. */
const SNAPSHOT_REWRITE: [string, string] = [
  "so it refuses --state-file.",
  "so it does not work from a saved snapshot."
];

export const REMOTE_TOOLS: RemoteTool[] = [
  // Reads
  { command: "status", scopes: ["read:plan"] },
  { command: "forecast", scopes: ["read:plan"] },
  { command: "summary", scopes: ["read:plan"] },
  { command: "list", scopes: ["read:plan"] },
  { command: "show", scopes: ["read:plan"] },
  { command: "search", scopes: ["read:plan"] },
  { command: "map", scopes: ["read:plan"] },
  { command: "state", scopes: ["read:plan"], omit: ["pretty"] },
  {
    command: "changes",
    scopes: ["read:changes"],
    rewrite: [SNAPSHOT_REWRITE],
    describe: {
      since: "Only changes after this time: an ISO 8601 date-time, or an offset such as -1d, -2h or -30m"
    }
  },
  { command: "proposals", scopes: ["read:proposals"], rewrite: [SNAPSHOT_REWRITE] },
  { command: "catch-up", scopes: ["read:plan"], rewrite: [SNAPSHOT_REWRITE] },
  { command: "doctor", scopes: ["read:plan"] },
  { command: "history", scopes: ["read:plan"] },
  // Each room reads what its source allows; a room the token cannot read reports an error and the rest still show.
  { command: "inbox", scopes: ["read:plan"] },
  {
    command: "guide",
    scopes: [],
    description:
      "Teaches the domain OpenRhen operates in: the hierarchy, the entities, how commands compose into recipes, and " +
      "what an agent may change directly, file as a proposal or not touch. With no topic, prints an overview and the " +
      "list of topics. With a topic, prints that topic: vocabulary, workflows, writing-data, reading-data, recurrence " +
      "or limits. This teaches the domain, not the arguments; each tool's input schema lists those.",
    describe: {
      topic: "vocabulary, workflows, writing-data, reading-data, recurrence, or limits; omit for the overview"
    }
  },
  {
    command: "skill",
    scopes: [],
    omit: ["remote"],
    description:
      "Prints the current rules for driving OpenRhen as a SKILL.md document: where to start, what never to skip " +
      "and the write rules, always matching the server you are connected to. Call it at the start of a session. It " +
      "starts with the contract version; if that is newer than the one your own saved copy of the skill records, tell " +
      "the person the copy is out of date. flavour openclaw adds a header for the OpenClaw plugin's copy.",
    describe: { flavour: "claude (the default) or openclaw" }
  },
  // Writes
  {
    command: "save",
    scopes: ["propose:entity", "read:plan"],
    omit: ["from"],
    describe: { fields: "The entity's fields, as one object (under set)" },
    rewrite: [
      ["with --fields, from --from <file.json>, with repeated", "with --fields, with repeated"],
      ["--fields applies over --from and --set over both", "--set applies over --fields"],
      ["the ones it does; `schema save-<kind>` prints them with their types.", "the ones it does."]
    ]
  },
  ...TYPED_SAVE_KINDS.map(({ kind, what, required, defaults }): RemoteTool => ({
    command: "save",
    name: `rhen_save_${kind}`,
    fixed: { entityType: kind },
    fieldsOf: kind,
    scopes: ["propose:entity", "read:plan"],
    omit: ["from", "set"],
    description: typedSaveDescription(kind, what, required, defaults)
  })),
  // One message of facts: each write inside is held to its own route's scope by the portal.
  { command: "changeset", scopes: ["propose:entity", "read:plan"] },
  {
    command: "capture",
    scopes: ["propose:capture", "read:plan"],
    describe: { area: "Id of the area this probably belongs to (a review hint)" }
  },
  {
    command: "propose",
    scopes: ["propose:agent-change"],
    omit: ["from"],
    // Over /mcp the token names the agent.
    rewrite: [["Needs a named agent (--agent or OPENRHEN_AGENT). ", ""]]
  },
  {
    command: "catch-up-settle",
    scopes: ["propose:catch-up"],
    omit: ["from"],
    rewrite: [
      [`'[...]', or --from file.json holding {"verdicts":[...]}, or --bulk.`, "'[...]' or --bulk."],
      [
        "otherwise undo refuses unless `--force`.",
        "otherwise undo refuses and the person reverses it from Review > Agent changes."
      ]
    ]
  },
  // Ends a lapsed pulse. With no answers it only reads what re-entry needs, so it also holds read:plan.
  // Answers need write:catch-up; the no-argument read also opens to a token that can only read or propose, who must be
  // able to see the questions to ask the owner.
  {
    command: "reenter",
    scopes: ["write:catch-up"],
    readableWithAnyOf: ["read:plan", "write:catch-up", "propose:catch-up"]
  },
  { command: "disrupt", scopes: ["write:check-in", "read:plan"] },
  { command: "arrive", scopes: ["write:arrival", "write:entity:current_availability", "read:plan"] },
  // Settles last night around a wake: finishes a running sleep, completes the planned one or logs the night, all
  // under the sleep log's scope. It reads nothing first; the portal does it in one transaction.
  { command: "wake", scopes: ["write:entity:sleep_log_entry"] },
  { command: "session", scopes: ["write:session", "read:plan"] },
  {
    command: "span",
    scopes: ["write:entity:span", "read:plan"],
    rewrite: [["under --read-only use `list spans` instead", "on a read-only run use `list spans` instead"]]
  },
  { command: "review", scopes: ["write:entity:project", "read:plan"] },
  { command: "activity", scopes: ["write:activity", "read:plan"] },
  { command: "check-in", scopes: ["write:check-in", "read:plan"] },
  { command: "disruption", scopes: ["write:disruption", "write:entity:commitment", "write:activity", "read:plan"] },
  { command: "routine", scopes: ["write:routine", "write:entity:commitment", "read:plan"] },
  { command: "recalculate", scopes: ["write:recalculate"] },
  { command: "cadence", scopes: ["write:cadence", "read:plan"] },
  { command: "recurrence", scopes: ["write:recurrence", "read:plan"], omit: ["from"] },
  // The rooms' confirm actions are an agent's (undoable from a row snapshot); another person's capture the portal still refuses.
  {
    command: "inbox-act",
    scopes: ["write:inbox", "read:plan"],
    // Imports are not served remotely: calendar clashes are the person's, in the portal.
    rewrite: [
      [
        "calendar: use `import show|commit|delete` (an import's Apply anyway / Don't add clash decisions are edits to the batch: `import update`). ",
        "calendar: imports and their clash decisions are the person's, in Inbox > Calendar. "
      ]
    ]
  },
  // Inline selectors and `targets-json` only; the two file options are left out.
  {
    command: "bulk",
    scopes: ["propose:entity", "read:plan"],
    omit: ["targets", "patch"],
    rewrite: [
      ['; run "rhen help list" for the full set)', ")"],
      ["(--targets file.json or --targets-json '[...]', each entry", "(--targets-json '[...]', each entry"],
      ["(repeatable) and/or --patch file.json.", "(repeatable)."]
    ]
  },
  // A pack carries the retained source text, which is why it is a `read:files` read; a move is `write:deliverable`.
  {
    command: "deliverable",
    scopes: ["read:plan", "read:files", "write:deliverable"],
    omit: ["from", "dir", "inline"],
    only: {
      subcommand: [
        "next",
        "pick-up",
        "pack",
        "note",
        "drop-off",
        "add-to-breakdown",
        "approve",
        "extend-plan",
        "complete-steps",
        "begin-review",
        "record-review",
        "record-blocker",
        "resolve-blocker",
        "submit"
      ]
    },
    describe: {
      tool: "Your name as it should show on the deliverable's handoff rows (pick-up, note, drop-off), such as the app you run in",
      transcript: "Cap the pack's transcript to the last N rows (pack; default 30)"
    },
    description: DELIVERABLE_DESCRIPTION
  },
  // Reverses the agent's own recorded writes. The reversal replays a save, so the route asks for that entity's scope too.
  {
    command: "undo",
    scopes: ["write:undo", "read:plan"],
    omit: ["any-owner", "force", "command-id"],
    description: UNDO_DESCRIPTION
  }
];

/** The registry description with this tool's rewrites applied. */
function remoteDescription(remote: RemoteTool, spec: CommandSpec): string {
  let text = remote.description ?? spec.description;
  for (const [from, to] of remote.rewrite ?? []) {
    if (text.split(from).length !== 2)
      throw new Error(`${remote.command}'s description does not contain "${from}" exactly once.`);
    text = text.replace(from, to);
  }
  return text;
}

/** The remote wording for a tool's description: a full replacement, or the registry text with phrases reworded and a closing line added. */
function remoteToolDescription(name: string, text: RemoteToolText, registry: string, mutates: boolean): string {
  if (text.description !== undefined)
    return `${mutates ? "WRITES DATA. " : ""}${typeof text.description === "function" ? text.description() : text.description}`;
  let result = registry;
  for (const [from, to] of text.rewrite ?? []) {
    if (result.split(from).length !== 2)
      throw new Error(`${name}'s description does not contain "${from}" exactly once.`);
    result = result.replace(from, to);
  }
  return `${result}${text.append ?? ""}`;
}

/** The remote wording for a tool's arguments: descriptions, allowed values and the shape of a JSON argument. */
function applyRemoteParams(name: string, text: RemoteToolText, properties: McpToolInputSchema["properties"]): void {
  const known = (argument: string) => {
    if (!(argument in properties)) throw new Error(`${name} has no argument ${argument} to reword.`);
    return properties[argument]! as Record<string, unknown>;
  };
  for (const [argument, description] of Object.entries(text.params ?? {}))
    properties[argument] = { ...known(argument), description } as never;
  for (const [argument, values] of Object.entries(text.enums ?? {}))
    properties[argument] = {
      ...known(argument),
      type: "string",
      enum: [...(typeof values === "function" ? values() : values)]
    } as never;
  for (const [argument, schema] of Object.entries(text.schemas ?? {})) {
    const property = known(argument);
    properties[argument] = { ...schema, description: property.description } as never;
  }
}

/** The core's remote tools, plus the ones each registered command module serves, placed after the tool it names. */
export function remoteTools(): RemoteTool[] {
  const tools = [...REMOTE_TOOLS];
  const known = (anchor: string | undefined) => tools.some((other) => other.command === anchor);
  let waiting = commandModules().flatMap((module) =>
    (module.remoteTools ?? []).map((tool) => ({ tool, anchor: tool.after ?? module.remoteAfter }))
  );
  // A tool may follow another module's tool, whichever module registered first: place what has its anchor, repeat,
  // and append what is left (an anchor from a module that is not loaded).
  while (waiting.length > 0) {
    const ready = waiting.filter(({ anchor }) => anchor === undefined || known(anchor));
    if (ready.length === 0) break;
    for (const { tool, anchor } of [...ready].reverse()) {
      const at = tools.findIndex((other) => other.command === anchor);
      tools.splice(at < 0 ? tools.length : at + 1, 0, tool);
    }
    waiting = waiting.filter((entry) => !ready.includes(entry));
  }
  tools.push(...waiting.map(({ tool }) => tool));
  return tools;
}

export function buildRemoteManifest(
  commands: readonly CommandSpec[],
  tools: readonly RemoteTool[] = remoteTools()
): McpToolManifestEntry[] {
  const manifest = tools.flatMap((remote) => {
    const spec = commands.find((candidate) => candidate.name === remote.command);
    if (!spec) throw new Error(`The remote manifest names ${remote.command}, which is not a registry command.`);
    if (spec.ownerOnly === true || spec.name === "mcp")
      throw new Error(`${remote.command} is owner-only and cannot be served remotely.`);
    const schema = toolInputSchema(spec) as unknown as McpToolInputSchema;
    const properties = { ...schema.properties };
    for (const name of remote.omit ?? []) {
      if (!(name in properties)) throw new Error(`${remote.command} has no argument ${name} to omit.`);
      delete properties[name];
    }
    // A file path the server would read or write can never be a remote argument, whatever the table above says.
    for (const [name, option] of Object.entries(spec.options))
      if (option.localPath === true && name in properties)
        throw new Error(`${remote.command} --${name} names a local file; omit it from the remote tool.`);
    for (const name of Object.keys(remote.fixed ?? {})) {
      if (!(name in properties)) throw new Error(`${remote.command} has no argument ${name} to fix.`);
      delete properties[name];
    }
    if (remote.fieldsOf !== undefined) properties.fields = fieldsProperty(remote.fieldsOf) as never;
    for (const [name, description] of Object.entries(remote.describe ?? {})) {
      const property = properties[name];
      if (!property) throw new Error(`${remote.command} has no argument ${name} to describe.`);
      properties[name] = { ...property, description };
    }
    for (const [name, values] of Object.entries(remote.only ?? {})) {
      const property = properties[name] as { enum?: string[] } | undefined;
      const allowed = property?.enum;
      if (!allowed) throw new Error(`${remote.command} has no enum argument ${name} to narrow.`);
      for (const value of values)
        if (!allowed.includes(value)) throw new Error(`${remote.command} --${name} has no value ${value}.`);
      properties[name] = { ...property, enum: values } as never;
    }
    const required = (schema.required ?? []).filter((name) => name in properties);
    const name = remote.name ?? toolName(spec);
    const text = remote.text ?? REMOTE_TOOL_TEXT[name];
    if (spec.mutates)
      for (const [argument, description] of Object.entries(COMMON_PARAMS))
        if (argument in properties) properties[argument] = { ...properties[argument]!, description } as never;
    if (text) applyRemoteParams(name, text, properties);
    const registryDescription = toolDescription({ ...spec, description: remoteDescription(remote, spec) }, false);
    const entry: McpToolManifestEntry = {
      name,
      command: spec.name,
      description: text
        ? remoteToolDescription(name, text, registryDescription, spec.mutates === true)
        : registryDescription,
      inputSchema: {
        type: "object",
        properties,
        additionalProperties: false,
        ...(required.length > 0 ? { required } : {})
      },
      annotations: toolAnnotations(spec),
      scopes: remote.scopes,
      ...(remote.readableWithAnyOf ? { readableWithAnyOf: remote.readableWithAnyOf } : {}),
      ...(remote.fixed ? { fixedArguments: remote.fixed } : {}),
      ...(spec.untrustedOutput === undefined ? {} : { untrustedOutput: spec.untrustedOutput })
    };
    const renamed = (alias: string): McpToolManifestEntry => ({
      ...entry,
      name: alias,
      description: `Renamed to ${entry.name}; this name goes away in the next contract version. ${entry.description}`
    });
    return [entry, ...(remote.aliases ?? []).map(renamed)];
  });
  const seen = new Set<string>();
  for (const { name } of manifest) {
    if (seen.has(name)) throw new Error(`The remote manifest serves the name ${name} twice (an alias must be unused).`);
    seen.add(name);
  }
  return manifest;
}
