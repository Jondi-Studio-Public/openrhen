import {
  parsePositiveInt,
  stringOption,
  validateIsoDateTime,
  requirePositional,
  type CommandSpec
} from "../command.js";
import { CliError, EXIT } from "../errors.js";
import { renderTable, toJson } from "../output.js";

/** What `GET /api/drift-report` returns, as far as this command reads it. */
interface Report {
  generatedAt: string;
  window: { from: string; to: string };
  legacyBefore: string | null;
  truncated: boolean;
  counts: {
    episodes: number;
    pinned: number;
    byType: Record<string, { episodes: number; pinned: number }>;
    bySignal: Record<string, number>;
  };
  episodes: Array<{
    id: string;
    type: string;
    occurredAt: string;
    knownAt: string;
    pinned: boolean;
    evidence: unknown[];
  }>;
}

const ACTIONS = ["report"] as const;

function lines(report: Report): string[] {
  const out = [
    `Drift episodes ${report.window.from} to ${report.window.to}: ${report.counts.episodes} (${report.counts.pinned} pinned).`,
    ...Object.entries(report.counts.byType).map(
      ([type, count]) => `  ${type}: ${count.episodes} (${count.pinned} pinned)`
    ),
    `Raw signals: ${Object.entries(report.counts.bySignal)
      .map(([signal, count]) => `${signal} ${count}`)
      .join(", ")}.`
  ];
  if (report.legacyBefore === null)
    out.push("Old sessions with no sanction count as drift; pass --legacy-before to skip rows from before the column.");
  if (report.truncated) out.push("A table hit the row limit, so some episodes are missing. Narrow --from and --to.");
  if (report.episodes.length > 0)
    out.push(
      renderTable(
        report.episodes.map((episode) => ({
          occurredAt: episode.occurredAt,
          type: episode.type,
          pinned: episode.pinned ? "yes" : "no",
          signals: episode.evidence.length,
          id: episode.id
        })),
        ["occurredAt", "type", "pinned", "signals", "id"]
      )
    );
  return out;
}

export const driftCommand: CommandSpec = {
  name: "drift",
  summary: "Count the moments the plan and what happened came apart (owner only)",
  description:
    "`drift report` reads the portal's drift episodes: one per drift however many signals saw it, either a deviated check-in " +
    "answered outside a session or a session started with no sanction. An episode is pinned when its time was recorded live; " +
    "only pinned episodes count toward a go/no-go. --days looks back from now (default 30, at most 90); --from and --to pick a window " +
    "of at most 90 days; --legacy-before skips sessions created before that time. Measurement only: it changes nothing. " +
    "Needs the live portal. Not offered over MCP.",
  positionals: [{ name: "action", required: true, description: ACTIONS.join(", ") }],
  options: {
    days: {
      type: "string",
      placeholder: "n",
      description: "Look back this many days from now (default 30, at most 90)"
    },
    from: { type: "string", placeholder: "iso", description: "Window start, an ISO 8601 time" },
    to: { type: "string", placeholder: "iso", description: "Window end, an ISO 8601 time (default now)" },
    "legacy-before": {
      type: "string",
      placeholder: "iso",
      description:
        "Skip sessions created before this time, where a missing sanction only means the column was not there"
    }
  },
  mutates: false,
  // Not a tool: counts for the owner's own go/no-go, not something an agent needs to call.
  ownerOnly: true,
  examples: [
    "drift report",
    "drift report --days 14 --json",
    "drift report --from 2026-01-01T00:00:00Z --to 2026-02-01T00:00:00Z"
  ],
  async run(context, args) {
    const action = requirePositional(driftCommand, args, 0);
    if (!(ACTIONS as readonly string[]).includes(action))
      throw new CliError(`drift ${action} is not a subcommand; use ${ACTIONS.join(", ")}.`, EXIT.usage);
    if (args.values["state-file"] !== undefined)
      throw new CliError("drift report reads the portal's database; it needs the live portal.", EXIT.usage);
    const query = new URLSearchParams();
    const days = parsePositiveInt(args, "days");
    if (days !== undefined) query.set("days", String(days));
    for (const [option, param] of [
      ["from", "from"],
      ["to", "to"],
      ["legacy-before", "legacyBefore"]
    ] as const) {
      const value = stringOption(args.values, option);
      if (value !== undefined) query.set(param, validateIsoDateTime(value, option));
    }
    const suffix = query.size > 0 ? `?${query.toString()}` : "";
    const report = await context.client.get<Report>(`/api/drift-report${suffix}`);
    if (!report || !report.counts || !Array.isArray(report.episodes))
      throw new CliError(
        "The portal's drift report had an unexpected shape. Update the portal to the same build as this CLI, then run `rhen drift report` again.",
        EXIT.unavailable
      );
    if (context.mode !== "table") {
      context.stdout(toJson(report, true));
      return;
    }
    context.stdout(lines(report).join("\n"));
  }
};
