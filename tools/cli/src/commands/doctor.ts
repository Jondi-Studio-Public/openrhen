import { DEFAULT_TIMEZONE } from "@openrhen/contracts";
import { DOCTOR_AREAS, DOCTOR_TIERS, type DoctorItem, type DoctorReport } from "@openrhen/contracts";
import { parsePositiveInt, stringOption, type CommandSpec } from "../command.js";
import { CliError, EXIT } from "../errors.js";
import { localiseInstants, renderTable, toJson } from "../output.js";

const DEFAULT_LIMIT = 10;

function summaryLine(report: DoctorReport): string {
  if (report.healthy) return "Data is healthy: every check that exists found nothing.";
  const { blocking, degrading, tidy } = report.counts;
  return `${report.items.length} to fix: ${blocking} blocking, ${degrading} degrading, ${tidy} tidy.`;
}

function fixText(item: DoctorItem): string {
  const { fix } = item;
  if (fix.who === "person") return `ask: ${fix.question ?? "the person"}${fix.cli ? ` (${fix.cli})` : ""}`;
  return fix.cli ?? fix.tool ?? "";
}

export const doctorCommand: CommandSpec = {
  name: "doctor",
  summary: "Check the quality of the plan data and rank what to fix",
  description:
    "Checks the DATA (not the connection; `openclaw mcp doctor` does that) and ranks what to fix so the engine works at its best: " +
    "stale wake, session or place, failing syncs, calendar events held or missing a place or travel mode, actions with no or an assumed " +
    "estimate, empty or idle projects, lapsed routines, overdue reviews, and counts of catch-up entries and findings. Tiers: blocking, " +
    "degrading, tidy. Each item's `fix`: who `agent` means do it now with the named command; who `person` means ask the question first. " +
    "Never pause or drop a project unasked. Never writes. --area and --tier filter; --limit (default 10, 0 for all). Needs the live portal.",
  positionals: [],
  options: {
    area: { type: "string", placeholder: DOCTOR_AREAS.join("|"), description: "Only this area" },
    tier: { type: "string", placeholder: DOCTOR_TIERS.join("|"), description: "Only this tier" },
    limit: {
      type: "string",
      mcp: { type: "integer", minimum: 0 },
      placeholder: "n",
      description: "How many items to show (default 10, 0 for all)"
    }
  },
  mutates: false,
  // Titles come from calendar imports and email, so the whole result is fenced as data over MCP.
  untrustedOutput: "file",
  examples: ["doctor", "doctor --tier blocking --json", "doctor --area calendar --limit 0"],
  async run(context, args) {
    if (args.values["state-file"] !== undefined)
      throw new CliError("doctor reads the portal's data; it needs the live portal.", EXIT.usage);
    const area = stringOption(args.values, "area");
    if (area !== undefined && !(DOCTOR_AREAS as readonly string[]).includes(area))
      throw new CliError(`--area must be one of ${DOCTOR_AREAS.join(", ")}.`, EXIT.usage);
    const tier = stringOption(args.values, "tier");
    if (tier !== undefined && !(DOCTOR_TIERS as readonly string[]).includes(tier))
      throw new CliError(`--tier must be one of ${DOCTOR_TIERS.join(", ")}.`, EXIT.usage);
    const limitRaw = stringOption(args.values, "limit");
    const limit = limitRaw === "0" ? 0 : (parsePositiveInt(args, "limit") ?? DEFAULT_LIMIT);

    const report = await context.client.get<DoctorReport>("/api/doctor");
    if (!report || !Array.isArray(report.items))
      throw new CliError("The portal's doctor report had an unexpected shape.", EXIT.unavailable);
    const matching = report.items.filter(
      (item) => (area === undefined || item.area === area) && (tier === undefined || item.tier === tier)
    );
    const shown = limit === 0 ? matching : matching.slice(0, limit);
    let timeZone: string = DEFAULT_TIMEZONE;
    try {
      timeZone = (await context.client.getState()).settings.timezone;
    } catch {
      /* instants stay as the portal sent them */
    }
    const remaining = matching.length - shown.length;
    if (context.mode !== "table") {
      context.stdout(toJson(localiseInstants({ ...report, items: shown, remaining }, timeZone), true));
      return;
    }
    const lines = [summaryLine(report)];
    if (shown.length > 0) {
      lines.push(
        renderTable(
          shown.map((item) => ({
            id: item.id,
            tier: item.tier,
            area: item.area,
            title: item.title,
            fix: fixText(item)
          })),
          ["tier", "area", "title", "fix", "id"],
          { timeZone }
        )
      );
    }
    if (remaining > 0) lines.push(`${remaining} more: repeat with --limit 0.`);
    if (report.notChecked.length > 0)
      lines.push("Not checked: " + report.notChecked.map((n) => `${n.check} (${n.reason})`).join("; "));
    context.stdout(lines.join("\n"));
  }
};
