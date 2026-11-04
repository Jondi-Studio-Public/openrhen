import { DEFAULT_TIMEZONE } from "@openrhen/contracts";
import { catchUpLedgerSchema, type CatchUpEntry, type CatchUpLedger } from "@openrhen/contracts";
import { stringOption, type CommandSpec } from "../command.js";
import { CliError, EXIT } from "../errors.js";
import { localiseInstants, renderTable, toJson } from "../output.js";
import { formatWhen } from "../when.js";

/** One line saying whether a catch-up is wanted, shared with the `status` digest. */
export function catchUpDue(ledger: Pick<CatchUpLedger, "due">): boolean {
  return ledger.due;
}

function describeWindow(ledger: CatchUpLedger, timeZone: string, now: Date): string {
  const since = ledger.since === null ? "never" : formatWhen(ledger.since, timeZone, now);
  const mode = catchUpDue(ledger) ? "Catch-up is due." : "Catch-up is not due.";
  return `${mode} Since ${since}: ${ledger.unsettled} unsettled, ${ledger.staleDates} stale date${ledger.staleDates === 1 ? "" : "s"}.`;
}

const WAKE_SETTLE_HINT =
  'rhen_wake {"at":"<ISO time the person woke>"}, or rhen_catch_up_settle with {"entryId":"wake","verdict":"done","at":"<same ISO time>"}';

export const catchUpCommand: CommandSpec = {
  name: "catch-up",
  summary: "What should have an outcome after a break, and has none",
  description:
    "Reads the catch-up ledger: the window (`since`, the last time anything was recorded), whether a catch-up is " +
    "due, how many entries are unsettled, how many deadlines the person set themselves have lapsed (stale dates), " +
    "and one page of entries (occurrences and lapsed deadlines, each with the id and version a verdict names). " +
    "Never writes. Read it, ask the person what happened, then settle only what they answered with " +
    "`catch-up-settle`. " +
    "--since narrows or widens the occurrence window (an ISO date-time); --offset pages when `remaining` is above 0. " +
    "Needs the live portal, so it refuses --state-file.",
  positionals: [],
  options: {
    since: {
      type: "string",
      placeholder: "iso-datetime",
      description: "Window start, an ISO date-time (default: the portal's own `since`)"
    },
    offset: {
      type: "string",
      mcp: { type: "integer", minimum: 0 },
      placeholder: "n",
      description: "Skip the first n entries (page through `remaining`)"
    }
  },
  mutates: false,
  examples: ["catch-up", "catch-up --json", "catch-up --since 2026-10-01T00:00:00+10:00 --offset 50"],
  async run(context, args) {
    if (args.values["state-file"] !== undefined)
      throw new CliError("catch-up reads the portal's ledger; it needs the live portal.", EXIT.usage);
    const query = new URLSearchParams();
    const since = stringOption(args.values, "since");
    if (since !== undefined) {
      if (Number.isNaN(new Date(since).getTime()))
        throw new CliError(`--since must be an ISO date-time, got "${since}".`, EXIT.usage);
      query.set("since", since);
    }
    const offsetRaw = stringOption(args.values, "offset");
    if (offsetRaw !== undefined) {
      const offset = Number(offsetRaw);
      if (!Number.isInteger(offset) || offset < 0)
        throw new CliError("--offset must be a whole number of entries to skip.", EXIT.usage);
      query.set("offset", String(offset));
    }
    const raw = await context.client.get<unknown>(`/api/catch-up${query.size ? `?${query.toString()}` : ""}`);
    const parsed = catchUpLedgerSchema.safeParse(raw);
    if (!parsed.success) throw new CliError("The portal's catch-up ledger had an unexpected shape.", EXIT.unavailable);
    const ledger = parsed.data;
    let timeZone: string = DEFAULT_TIMEZONE;
    try {
      timeZone = (await context.client.getState()).settings.timezone;
    } catch {
      /* instants stay as the portal sent them */
    }
    if (context.mode !== "table") {
      // The stale wake is the one entry two tools can settle; say which, so nobody has to guess.
      const entries = ledger.entries.map((entry) =>
        entry.kind === "stale_wake" ? { ...entry, settleWith: WAKE_SETTLE_HINT } : entry
      );
      context.stdout(toJson(localiseInstants({ ...ledger, entries, due: catchUpDue(ledger) }, timeZone), true));
      return;
    }
    const lines = [describeWindow(ledger, timeZone, context.now())];
    if (ledger.entries.length > 0) {
      const rows = ledger.entries.map((entry: CatchUpEntry) => ({
        ...entry,
        plannedAt: formatWhen(entry.plannedAt, timeZone, context.now()),
        version: entry.version ?? "",
        verdicts: entry.verdicts
          .map((verdict) => (entry.atRequired.includes(verdict) ? `${verdict}*` : verdict))
          .join(" ")
      }));
      lines.push(renderTable(rows, ["id", "kind", "plannedAt", "title", "version", "verdicts"], { timeZone }));
      const questions = ledger.entries.filter((entry) => entry.question !== null);
      if (questions.length > 0) lines.push("Ask:", ...questions.map((entry) => `  ${entry.id}: ${entry.question}`));
      if (ledger.entries.some((entry) => entry.atRequired.length > 0))
        lines.push('* needs "at": when it stopped or when the person woke.');
    }
    if (ledger.remaining > 0 && ledger.nextOffset !== null)
      lines.push(`${ledger.remaining} more: repeat with --offset ${ledger.nextOffset}.`);
    context.stdout(lines.join("\n"));
  }
};
