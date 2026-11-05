import {
  booleanOption,
  parsePositiveInt,
  stringOption,
  type CommandContext,
  type CommandSpec,
  type ParsedArgs
} from "../command.js";
import { CliError, EXIT } from "../errors.js";
import { emitRows, localiseInstants, toJson } from "../output.js";
import { parseWhen } from "../when.js";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 200;

interface ChangeRow {
  id: string;
  at: string;
  entityType: string;
  entityId: string;
  operation: string;
  actor: string | null;
  commandId: string;
  beforeRecorded: boolean;
  evidence?: Record<string, unknown>;
}

interface ChangesResponse {
  changes: ChangeRow[];
  cursor: string | null;
}

interface CountResponse {
  total: number;
  counts: { value: string; count: number }[];
}

/** The `--agent` filter: a name in the agent-name alphabet, or one of the two stamps the portal writes itself. */
function agentFilter(raw: string): string {
  const name = raw.trim().toLowerCase();
  if (!/^[a-z0-9_-]{1,32}$/.test(name))
    throw new CliError(`--agent must be 1 to 32 characters of a-z, 0-9, _ or -, got "${raw}".`, EXIT.usage);
  return name;
}

async function timeZoneOf(context: CommandContext): Promise<string | undefined> {
  try {
    return (await context.client.getState()).settings.timezone;
  } catch {
    return undefined;
  }
}

export const changesCommand: CommandSpec = {
  name: "changes",
  summary: "What changed in the plan, and who changed it",
  description:
    "The audit trail and change feed: one row per plan-input write, newest first, with when, who (an agent " +
    "name, `human` for the portal's own user, or `system`), the operation, and the entity. Cheap by default " +
    "(20 rows): start with --count (optionally --by agent or --by entity) for a few numbers, or a short " +
    "--since such as -1d to read only what is new; --before <cursor> pages on. --evidence adds the stored " +
    "before-image (an agent's project and action saves only, the changed fields as they were; other agent " +
    "writes show beforeMissing), the recommendation, and the basis and quoted words an agent gave. Covers plan-input writes only: check-in answers and session starts " +
    "appear through answered_by and started_by on `list sessions` and the check-in record. Needs the live " +
    "portal, so it refuses --state-file.",
  positionals: [],
  options: {
    since: { type: "string", placeholder: "when", description: "Only changes after this time (-1d, today, ISO)" },
    agent: {
      type: "string",
      placeholder: "name",
      description: "Only changes by this agent name, or `human` (the portal) or `system`"
    },
    entity: { type: "string", placeholder: "type", description: "Only changes to this entity type" },
    limit: {
      type: "string",
      mcp: { type: "integer", minimum: 1, maximum: 200 },
      placeholder: "n",
      description: `At most n rows (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT})`
    },
    before: { type: "string", placeholder: "cursor", description: "Page on from the cursor of a previous result" },
    count: { type: "boolean", description: "Return counts instead of rows" },
    by: { type: "string", placeholder: "agent|entity", description: "With --count: group by agent or entity" },
    evidence: { type: "boolean", description: "Include each change's stored evidence (before-image, recommendation)" }
  },
  mutates: false,
  examples: ["changes --count --by agent --since -1d", "changes --agent mark --since today --limit 10"],
  async run(context, args: ParsedArgs) {
    if (args.values["state-file"] !== undefined)
      throw new CliError(
        "changes reads the portal's change log, which a --state-file snapshot does not hold; it needs the live portal.",
        EXIT.usage
      );
    const count = booleanOption(args.values, "count");
    const by = stringOption(args.values, "by");
    if (by !== undefined && !count) throw new CliError("--by only applies with --count.", EXIT.usage);
    if (by !== undefined && by !== "agent" && by !== "entity")
      throw new CliError(`--by must be agent or entity, got "${by}".`, EXIT.usage);
    const limit = parsePositiveInt(args, "limit") ?? DEFAULT_LIMIT;
    if (limit > MAX_LIMIT) throw new CliError(`--limit must be at most ${MAX_LIMIT}.`, EXIT.usage);

    const query = new URLSearchParams();
    const sinceRaw = stringOption(args.values, "since");
    if (sinceRaw !== undefined) {
      // Only the calendar words depend on the portal's timezone, so only they cost a state read.
      const calendarWord = /^(today|tomorrow|yesterday)$/i.test(sinceRaw.trim());
      const zone = calendarWord ? await timeZoneOf(context) : undefined;
      query.set("since", parseWhen(sinceRaw, context.now(), zone).toISOString());
    }
    const agent = stringOption(args.values, "agent");
    if (agent !== undefined) query.set("agent", agentFilter(agent));
    const entity = stringOption(args.values, "entity");
    if (entity !== undefined) query.set("entity", entity);
    if (count) {
      query.set("count", "1");
      if (by !== undefined) query.set("by", by);
    } else {
      query.set("limit", String(limit));
      const before = stringOption(args.values, "before");
      if (before !== undefined) query.set("before", before);
      if (booleanOption(args.values, "evidence")) query.set("evidence", "1");
    }

    const response = await context.client.get<ChangesResponse | CountResponse>(`/api/changes?${query.toString()}`);
    const timeZone = await timeZoneOf(context);
    if (context.mode === "json" || context.mode === "jsonl") {
      const printed = timeZone ? localiseInstants(response, timeZone) : response;
      if (context.mode === "json" || count) context.stdout(toJson(printed, context.mode === "json"));
      else for (const row of (printed as ChangesResponse).changes) context.stdout(toJson(row));
      return;
    }
    if (count) {
      const counted = response as CountResponse;
      emitRows({ mode: context.mode, stdout: context.stdout }, counted.counts, ["value", "count"]);
      context.stdout(`total ${counted.total}`);
      return;
    }
    const rows = response as ChangesResponse;
    const withEvidence = booleanOption(args.values, "evidence");
    const text = (value: unknown) => (typeof value === "string" ? value : "");
    // With --evidence, an agent write also shows the basis it claimed and the person's words it quoted.
    const table = rows.changes.map((row) => ({
      ...row,
      actor: row.actor ?? "human",
      ...(withEvidence ? { basis: text(row.evidence?.basis), quote: text(row.evidence?.statedEvidence) } : {})
    }));
    emitRows(
      { mode: context.mode, stdout: context.stdout },
      table,
      ["at", "actor", "operation", "entityType", "entityId", ...(withEvidence ? ["basis", "quote"] : [])],
      { timeZone }
    );
    if (rows.cursor)
      context.stdout(
        context.mcp === true
          ? `More: call rhen_changes again with the same arguments and "before": ${JSON.stringify(rows.cursor)}`
          : `More: --before ${rows.cursor}`
      );
  }
};
