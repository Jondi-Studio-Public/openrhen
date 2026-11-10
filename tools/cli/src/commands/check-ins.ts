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

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

interface AnsweredRow {
  id: string;
  answeredAt: string | null;
  status: string;
  deviationNote: string | null;
  tags: { tag: string; mark: string }[];
}

interface AnsweredResponse {
  checkIns: AnsweredRow[];
  next: string | null;
}

async function timeZoneOf(context: CommandContext): Promise<string | undefined> {
  try {
    return (await context.client.getState()).settings.timezone;
  } catch {
    return undefined;
  }
}

export const checkInsCommand: CommandSpec = {
  name: "check-ins",
  summary: "Answered check-ins and their ids, to tag",
  description:
    "Lists check-ins the owner has answered, newest answer first, with each id, status, his words " +
    "(deviationNote) and tags: the ids `check-in-tag` needs. --untagged keeps those with no tag yet and " +
    "--with-words those where he left words, so `--untagged --with-words` is the work still to do. 20 rows by " +
    "default; when more remain the result ends with a next cursor: repeat with --cursor <next>. --since and " +
    "--before are ISO 8601 times on the answer time; --before can skip rows that share an instant, so page " +
    "with --cursor, which cannot, and do not send both. Read-only. Needs the live portal, so it refuses --state-file.",
  positionals: [],
  options: {
    since: { type: "string", placeholder: "time", description: "Only answers at or after this ISO 8601 time" },
    before: { type: "string", placeholder: "time", description: "Only answers before this ISO 8601 time" },
    cursor: { type: "string", placeholder: "cursor", description: "Page on: the next value of the previous result" },
    limit: {
      type: "string",
      mcp: { type: "integer", minimum: 1, maximum: MAX_LIMIT },
      placeholder: "n",
      description: `At most n rows (default ${DEFAULT_LIMIT}, max ${MAX_LIMIT})`
    },
    untagged: { type: "boolean", description: "Only check-ins with no tag" },
    "with-words": { type: "boolean", description: "Only check-ins where the owner left words" }
  },
  mutates: false,
  examples: ["check-ins --untagged --with-words", "check-ins --untagged --with-words --cursor <next>"],
  async run(context, args: ParsedArgs) {
    if (args.values["state-file"] !== undefined)
      throw new CliError(
        "check-ins reads the portal's check-in table, which a --state-file snapshot does not hold; it needs the live portal.",
        EXIT.usage
      );
    const limit = parsePositiveInt(args, "limit");
    if (limit !== undefined && limit > MAX_LIMIT)
      throw new CliError(`--limit must be at most ${MAX_LIMIT}.`, EXIT.usage);

    const query = new URLSearchParams({ limit: String(limit ?? DEFAULT_LIMIT) });
    const cursor = stringOption(args.values, "cursor");
    const before = stringOption(args.values, "before");
    if (cursor !== undefined && before !== undefined)
      throw new CliError(
        "Send --cursor or --before, not both: --cursor is the next value from the previous result.",
        EXIT.usage
      );
    if (cursor !== undefined) query.set("cursor", cursor);
    if (before !== undefined) query.set("before", before);
    const since = stringOption(args.values, "since");
    if (since !== undefined) query.set("since", since);
    if (booleanOption(args.values, "untagged")) query.set("untagged", "1");
    if (booleanOption(args.values, "with-words")) query.set("with-words", "1");

    const response = await context.client.get<AnsweredResponse>(`/api/check-ins/answered?${query.toString()}`);
    const timeZone = await timeZoneOf(context);
    if (context.mode === "json" || context.mode === "jsonl") {
      const printed = timeZone ? localiseInstants(response, timeZone) : response;
      if (context.mode === "json") context.stdout(toJson(printed, true));
      else for (const row of (printed as AnsweredResponse).checkIns) context.stdout(toJson(row));
      return;
    }
    emitRows(
      { mode: context.mode, stdout: context.stdout },
      response.checkIns.map((row) => ({ ...row, tags: row.tags.map((entry) => entry.tag).join(",") })),
      ["id", "answeredAt", "status", "tags", "deviationNote"],
      { timeZone }
    );
    if (response.next)
      context.stdout(
        context.mcp === true
          ? `More: call rhen_check_ins again with the same arguments and "cursor": ${JSON.stringify(response.next)}`
          : `More: --cursor ${response.next}`
      );
  }
};
