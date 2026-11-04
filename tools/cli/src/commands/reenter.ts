import { REENTRY_ENERGIES, reenterCommandSchema, type PulseReentryView } from "@openrhen/contracts";
import { booleanOption, stringOption, type CommandSpec } from "../command.js";
import { CliError, EXIT, firstIssueMessage } from "../errors.js";
import { toJson } from "../output.js";
import { DRY_RUN_NOTICE, newCommandId, recordServerChecked, sendCommand, stampCommandId } from "../write.js";

interface Named {
  id: string;
  name: string;
}
interface ReentryLook {
  pulse: PulseReentryView | null;
  lapsed: boolean;
  review?: {
    tier: string;
    reviewable: number;
    lapsing: number;
    days: { day: string; entryIds: string[] }[];
    projects: { projectId: string | null; title: string | null; entryIds: string[] }[];
    entries: { id: string; kind: string; title: string; plannedAt: string; version: number | null }[];
  };
  choices?: { places: Named[]; contexts: Named[] };
  answer?: {
    energies: { value: string; meaning: string }[];
    nothingToReview: boolean;
    toAnswer: string;
    settlementExample: string | null;
    call: string;
  };
}

/** An id, or a name matched exactly (ignoring case), against what the portal lists. */
function resolveNamed(kind: string, query: string, choices: Named[] | undefined): string {
  if (!choices) return query;
  const byId = choices.find((item) => item.id === query);
  if (byId) return byId.id;
  const wanted = query.trim().toLowerCase();
  const byName = choices.find((item) => item.name.toLowerCase() === wanted);
  if (byName) return byName.id;
  throw new CliError(
    `No ${kind} with id or name "${query}". Run \`reenter\` with no answers to list them: ${choices
      .map((item) => `${item.id} (${item.name})`)
      .join(", ")}.`,
    EXIT.notFound
  );
}

function parseSettlement(raw: string | undefined): unknown {
  if (raw === undefined) return {};
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new CliError(
      `--settlement-json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      EXIT.usage
    );
  }
}

function describeLook(look: ReentryLook): string {
  if (!look.pulse) return "The pulse has not been recorded yet; there is nothing to re-enter.";
  if (!look.lapsed)
    return `The pulse is ${look.pulse.state}${look.pulse.reason ? ` (${look.pulse.reason})` : ""}; there is nothing to re-enter.`;
  const lines = [
    `The pulse lapsed: last confirmed ${look.pulse.lastConfirmedAt ?? "never"}, a gap of ${
      look.pulse.reentry.gapMinutes === null ? "unknown length" : `${Math.round(look.pulse.reentry.gapMinutes)} minutes`
    } (${look.pulse.reentry.tier}).`,
    `Still needed: ${look.pulse.reentry.missing.join("; ")}.`
  ];
  if (look.choices)
    lines.push(
      `Places: ${look.choices.places.map((place) => `${place.id} (${place.name})`).join(", ") || "none"}.`,
      `Contexts: ${look.choices.contexts.map((item) => `${item.id} (${item.name})`).join(", ") || "none"}.`
    );
  if (look.answer)
    lines.push(
      `Energies: ${look.answer.energies.map((energy) => `${energy.value} (${energy.meaning})`).join(", ")}.`,
      look.answer.toAnswer,
      ...(look.answer.settlementExample ? [`Example settlement-json: ${look.answer.settlementExample}`] : []),
      `Call: ${look.answer.call}`
    );
  for (const entry of look.review?.entries ?? [])
    lines.push(
      `  ${entry.id} ${entry.kind} "${entry.title}" planned ${entry.plannedAt} (version ${entry.version ?? "-"})`
    );
  return lines.join("\n");
}

export const reenterCommand: CommandSpec = {
  name: "reenter",
  summary: "End a lapsed pulse: tell the plan where you are and settle the gap",
  description:
    "With no answers, reads what re-entry needs (read-only). With answers, ends the lapse: --location, --energy " +
    `(${REENTRY_ENERGIES.join("|")}) and --contexts (ids or names, or "none") are all required; --settlement-json ` +
    "settles the gap as the read describes. All or nothing: an incomplete answer is refused, naming each gap. " +
    "Ask the person, do not guess; an agent must send --basis stated and --evidence (the person's own words) with the three facts, " +
    "and if the person cannot be reached, stop. `undo` reverses it while the pulse has not moved on.",
  positionals: [],
  options: {
    location: {
      type: "string",
      placeholder: "place",
      description: "Where the person is now: a place's id or name"
    },
    energy: { type: "string", placeholder: REENTRY_ENERGIES.join("|"), description: "Energy now" },
    contexts: {
      type: "string",
      placeholder: "id,id|none",
      description: "Contexts available now: ids or names, comma-separated, or none"
    },
    "settlement-json": {
      type: "string",
      mcp: { type: "object" },
      placeholder: "json",
      description: "Settlement: items, days, projects, startFresh"
    },
    note: { type: "string", placeholder: "text", description: "What happened instead (max 2000 chars)" },
    "dry-run": { type: "boolean", description: "Print the command instead of sending it" }
  },
  mutates: true,
  examples: [
    "reenter",
    'reenter --location home --energy medium --contexts laptop,quiet --settlement-json \'{"items":[{"entryId":"deadline:p1","verdict":"pending"}]}\'',
    'reenter --location Campus --energy low --contexts none --settlement-json \'{"days":[{"day":"2026-10-12","answer":"nothing_recorded"}]}\' --basis stated --evidence "nothing that week"'
  ],
  async run(context, args) {
    const location = stringOption(args.values, "location");
    const energy = stringOption(args.values, "energy");
    const contextsRaw = stringOption(args.values, "contexts");
    const settlementRaw = stringOption(args.values, "settlement-json");
    const note = stringOption(args.values, "note");
    const look = await context.client.get<ReentryLook>("/api/commands/reenter");
    const answering = [location, energy, contextsRaw, settlementRaw].some((value) => value !== undefined);
    if (!answering) {
      context.stdout(context.mode === "table" ? describeLook(look) : toJson(look, true));
      return;
    }
    if (!look.lapsed) throw new CliError(describeLook(look), EXIT.conflict);

    const contexts =
      contextsRaw === undefined
        ? undefined
        : contextsRaw.trim().toLowerCase() === "none"
          ? []
          : contextsRaw
              .split(",")
              .map((entry) => entry.trim())
              .filter((entry) => entry !== "")
              .map((entry) => resolveNamed("context", entry, look.choices?.contexts));
    const request: Record<string, unknown> = {
      commandId: newCommandId(),
      ...(location !== undefined ? { locationId: resolveNamed("place", location, look.choices?.places) } : {}),
      ...(energy !== undefined ? { energy } : {}),
      ...(contexts !== undefined ? { contexts } : {}),
      settlement: parseSettlement(settlementRaw),
      ...(note !== undefined ? { note } : {}),
      ...(stringOption(args.values, "basis") !== undefined ? { basis: stringOption(args.values, "basis") } : {}),
      ...(stringOption(args.values, "evidence") !== undefined
        ? { evidence: stringOption(args.values, "evidence") }
        : {})
    };
    const checked = reenterCommandSchema.safeParse(request);
    if (!checked.success) throw new CliError(`Re-entry is invalid: ${firstIssueMessage(checked.error)}`, EXIT.usage);
    const stamped = stampCommandId(context, args, request);
    context.stderr("rhen: reenter");
    if (booleanOption(args.values, "dry-run")) {
      context.stdout(
        toJson({ dryRun: true, ...DRY_RUN_NOTICE, path: "/api/commands/reenter", payload: stamped.payload }, true)
      );
      return;
    }
    // The portal refuses an incomplete answer with 422, which `sendCommand` raises as a validation error naming each gap.
    const done = await sendCommand<{ result: Record<string, unknown>; revertible?: string }>(
      context.client,
      "/api/commands/reenter",
      stamped.payload,
      stamped.key
    );
    recordServerChecked(context, done, {
      path: "/api/commands/reenter",
      sent: stamped.payload,
      summary: "reenter"
    });
    const result = done.result;
    if (context.mode !== "table") {
      context.stdout(toJson({ ...result, revertible: done.revertible ?? result.revertible }, true));
      return;
    }
    context.stdout(
      `Back on plan. ${String(result.lapsed ?? 0)} recurring item(s) lapsed as missed, ${String(
        result.unrecorded ?? 0
      )} answered in bulk (skipped, not done). \`rhen undo\` reverses this.${typeof result.next === "string" ? ` ${result.next}` : ""}`
    );
  }
};
