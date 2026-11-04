import { resolveQuestion, unansweredQuestions } from "@openrhen/contracts";
import { type CommandContext, type CommandSpec, type ParsedArgs } from "../command.js";
import { CliError, EXIT } from "../errors.js";
import { toJson } from "../output.js";
import { registeredInboxRooms, type InboxItemSpec } from "../command-modules.js";

/**
 * Everything open in the Inbox, room by room, as the portal's Inbox tabs group it (the design notes,
 * the design notes). Read-only: it lists what is waiting and which existing command acts on it.
 */

/** The rooms the core owns. A command module may add rooms ahead of them (`CommandModule.inboxRooms`). */
const CORE_ROOMS = [
  ["captured", "Captured"],
  ["calendar", "Calendar & imports"],
  ["map", "Plan map"],
  ["kept", "Someday & reference"]
] as const;
type RoomId = string;

function roomLabels(): Map<RoomId, string> {
  const registered = registeredInboxRooms();
  const entries: (readonly [RoomId, string])[] = registered
    .filter((room) => !room.before)
    .map((room) => [room.id, room.label] as const);
  for (const [id, label] of CORE_ROOMS) {
    entries.push(...registered.filter((room) => room.before === id).map((room) => [room.id, room.label] as const));
    entries.push([id, label]);
  }
  return new Map(entries);
}

type InboxItem = InboxItemSpec;

interface InboxRoom {
  room: RoomId;
  label: string;
  /** Items needing a decision; for Someday & reference, items kept. */
  count: number;
  items: InboxItem[];
  error?: string;
}

type Capture = {
  id: string;
  status: string;
  proposalType: string;
  sourceType?: string;
  text?: string;
  createdAt?: string;
  questions?: unknown[];
  proposedFields?: Record<string, unknown>;
};

function short(text: string | undefined, max = 140): string {
  const clean = (text ?? "").replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

async function attempt(room: RoomId, label: string, load: () => Promise<InboxItem[]>): Promise<InboxRoom> {
  try {
    const items = await load();
    return { room, label, count: items.length, items };
  } catch (error) {
    return {
      room,
      label,
      count: 0,
      items: [],
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

/** How an item says to act on it: the shell command on the CLI, the tool call (or the person) on either MCP server. */
function actHint(context: CommandContext, cli: string, remote: string): string {
  return context.mcp === true ? remote : cli;
}

export const inboxCommand: CommandSpec = {
  name: "inbox",
  summary: "List everything open in the Inbox, by room",
  // A getter, not a literal: a room a command module adds describes itself (`InboxRoomSpec.about`).
  get description() {
    // The rooms listed ahead of Captured: those with no `before`, then those placed directly before it.
    const rooms = registeredInboxRooms().filter((room) => room.about);
    const added = [...rooms.filter((room) => !room.before), ...rooms.filter((room) => room.before === "captured")]
      .map((room) => `${room.about}, `)
      .join("");
    return (
      "Read-only. Lists what is waiting in each Inbox room: " +
      added +
      "Captured (thoughts and extractions to classify), Calendar & imports (batches " +
      "held for review), Plan map (open findings and suggested links) and Someday & reference (kept items). Each item " +
      "names the command that acts on it. Pass a room to list only that one. A room whose source cannot be read " +
      "reports an error instead of hiding the rest. Go through the rooms with the person; act only on their say-so."
    );
  },
  // A getter, not a literal: the rooms a command module adds register after this file loads.
  get positionals() {
    return [
      {
        name: "room",
        required: false,
        description: `One of ${[...roomLabels().keys()].join(", ")}; default all`,
        enum: [...roomLabels().keys()]
      }
    ];
  },
  options: {},
  mutates: false,
  get untrustedOutput() {
    return registeredInboxRooms().find((room) => room.untrustedOutput)?.untrustedOutput ?? "mail";
  },
  examples: ["inbox", "inbox captured", "inbox --json"],
  async run(context: CommandContext, args: ParsedArgs) {
    const only = args.positionals[0] as RoomId | undefined;
    const labels = roomLabels();
    if (only !== undefined && !labels.has(only))
      throw new CliError(`Unknown room "${only}". Rooms: ${[...labels.keys()].join(", ")}.`, EXIT.usage);
    const wanted = (room: RoomId) => only === undefined || only === room;
    const state = await context.client.getState();
    const captures = state.captures as unknown as Capture[];

    const rooms: InboxRoom[] = [];
    for (const room of registeredInboxRooms())
      if (!room.before && wanted(room.id))
        rooms.push(await attempt(room.id, room.label, () => room.load(context, captures as readonly unknown[])));
    for (const room of registeredInboxRooms())
      if (room.before === "captured" && wanted(room.id))
        rooms.push(await attempt(room.id, room.label, () => room.load(context, captures as readonly unknown[])));
    if (wanted("captured"))
      rooms.push(
        await attempt("captured", labels.get("captured")!, async () =>
          captures
            .filter((c) => c.status === "pending" && c.proposalType !== "email_change")
            .map((c) => ({
              id: c.id,
              title: short(c.text, 100) || "(empty capture)",
              detail: c.proposalType,
              openQuestions: unansweredQuestions((c.questions ?? []).map((q) => resolveQuestion(q as never))).length,
              act: actHint(
                context,
                "inbox-act captured confirm --type T|ignore <id>",
                'rhen_inbox_act {"room":"captured","action":"confirm","id":"<id>","type":"<outcome|project|action|fixed_commitment|deliverable|someday|reference>"}, or with "action":"ignore" and no type'
              )
            }))
        )
      );
    if (wanted("calendar"))
      rooms.push(
        await attempt("calendar", labels.get("calendar")!, async () => {
          const response = await context.client.get<{
            batches: {
              id: string;
              sourceType: string;
              inputKind: string;
              status: string;
              filename: string | null;
              recordCount: number;
              blockingCount: number;
            }[];
          }>("/api/imports");
          return response.batches.map((b) => ({
            id: b.id,
            title: `${b.sourceType} ${b.inputKind}${b.filename ? ` (${b.filename})` : ""}`,
            detail: `${b.status}, ${b.recordCount} records, ${b.blockingCount} blocking`,
            act: actHint(
              context,
              "import show|update|commit|delete <id>",
              "no tool: batches are the owner's, in the portal's Inbox > Calendar; tell the person it is waiting"
            )
          }));
        })
      );
    if (wanted("map"))
      rooms.push(
        await attempt("map", labels.get("map")!, async () => {
          const map = await context.client.get<{
            findings: { id: string; checkName: string; text: string; status: string; questions?: unknown[] }[];
            links: {
              id: string;
              status: string;
              kind: string;
              fromType: string;
              fromId: string;
              toType: string;
              toId: string;
            }[];
          }>("/api/plan-map");
          const findings = map.findings
            .filter((f) => f.status === "open")
            .map((f) => ({
              id: f.id,
              title: short(f.text, 120),
              detail: `finding: ${f.checkName}`,
              openQuestions: unansweredQuestions((f.questions ?? []).map((q) => resolveQuestion(q as never))).length,
              act: actHint(
                context,
                "inbox-act map finding <id> accept|dismiss",
                'rhen_inbox_act {"room":"map","action":"finding","id":"<id>","decision":"accept|dismiss"}'
              )
            }));
          const links = map.links
            .filter((l) => l.status === "suggested")
            .map((l) => ({
              id: l.id,
              title: `${l.kind}: ${l.fromType}:${l.fromId} → ${l.toType}:${l.toId}`,
              detail: "suggested link",
              act: actHint(
                context,
                "inbox-act map link <id> confirm|reject",
                'rhen_inbox_act {"room":"map","action":"link","id":"<id>","decision":"confirm|reject"}'
              )
            }));
          return [...findings, ...links];
        })
      );
    if (wanted("kept"))
      rooms.push(
        await attempt("kept", labels.get("kept")!, async () =>
          captures
            .filter((c) => c.status === "confirmed" && (c.proposalType === "someday" || c.proposalType === "reference"))
            .map((c) => ({
              id: c.id,
              title: short(c.text, 100),
              detail: c.proposalType,
              act: actHint(
                context,
                "inbox-act kept reopen|drop <id>",
                'rhen_inbox_act {"room":"kept","action":"reopen|drop","id":"<id>"}'
              )
            }))
        )
      );

    if (context.mode !== "table") {
      context.stdout(toJson(rooms, true));
      return;
    }
    const lines: string[] = [];
    for (const room of rooms) {
      lines.push(
        `${room.label}: ${room.count}${room.room === "kept" ? " kept" : ""}${room.error ? ` (could not read: ${room.error})` : ""}`
      );
      for (const item of room.items.slice(0, 20))
        lines.push(
          `  - ${item.title}${item.detail ? ` — ${item.detail}` : ""}${item.openQuestions ? ` [${item.openQuestions} open question(s)]` : ""}  [${item.id}]`
        );
      if (room.items.length > 20) lines.push(`  … ${room.items.length - 20} more (use --json or inbox ${room.room})`);
    }
    context.stdout(lines.join("\n"));
  }
};
