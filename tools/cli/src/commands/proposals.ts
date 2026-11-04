import { parsePositiveInt, stringOption, type CommandSpec } from "../command.js";
import { CliError, EXIT } from "../errors.js";
import { emitRows } from "../output.js";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 200;
const STATUSES = ["pending", "confirmed", "rejected", "expired", "stale"];

interface ProposalRow {
  id: string;
  agent: string;
  kind: string;
  summary: string;
  basis: string;
  status: string;
  createdAt: string;
  resolvedAt: string | null;
  resolutionNote: string | null;
}

export const proposalsCommand: CommandSpec = {
  name: "proposals",
  summary: "Your proposed changes, and what the person decided",
  description:
    "Lists the proposals this agent made with `propose` (or any agent's, when run as the person), newest first, " +
    "with status (pending, confirmed, rejected, expired or stale) and the person's resolution note. Read it " +
    "to learn what was accepted or rejected and stop proposing rejected shapes; `stale` means the record " +
    "changed after you proposed, so read it again and propose again. 20 rows by default. Needs the live " +
    "portal, so it refuses --state-file.",
  positionals: [],
  options: {
    status: { type: "string", placeholder: "status", description: `Only ${STATUSES.join(", ")}` },
    limit: {
      type: "string",
      mcp: { type: "integer", minimum: 1, maximum: 200 },
      placeholder: "n",
      description: `At most n rows (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT})`
    }
  },
  mutates: false,
  examples: ["proposals", "proposals --status pending --limit 5"],
  async run(context, args) {
    if (args.values["state-file"] !== undefined)
      throw new CliError("proposals reads the portal's proposal queue; it needs the live portal.", EXIT.usage);
    const status = stringOption(args.values, "status");
    if (status !== undefined && !STATUSES.includes(status))
      throw new CliError(`--status must be one of ${STATUSES.join(", ")}, got "${status}".`, EXIT.usage);
    const limit = parsePositiveInt(args, "limit") ?? DEFAULT_LIMIT;
    if (limit > MAX_LIMIT) throw new CliError(`--limit must be at most ${MAX_LIMIT}.`, EXIT.usage);

    const query = new URLSearchParams({ limit: String(limit) });
    if (status !== undefined) query.set("status", status);
    const { proposals } = await context.client.get<{ proposals: ProposalRow[] }>(
      `/api/agent-proposals?${query.toString()}`
    );
    let timeZone: string | undefined;
    try {
      timeZone = (await context.client.getState()).settings.timezone;
    } catch {
      timeZone = undefined;
    }
    emitRows(
      { mode: context.mode, stdout: context.stdout },
      context.mode === "table" ? proposals.map((row) => ({ ...row, note: row.resolutionNote ?? "" })) : proposals,
      ["createdAt", "status", "kind", "summary", "note", "id"],
      { timeZone }
    );
  }
};
