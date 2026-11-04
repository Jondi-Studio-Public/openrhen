import {
  agedInputIdsFromSchedule,
  displayHealth,
  forecastsOf,
  projectHealthFromSchedule,
  resolveFreshness,
  worstFirst,
  type FactFreshness,
  type WireForecast
} from "@openrhen/contracts";
import { booleanOption, stringOption, type CommandContext, type CommandSpec, type ParsedArgs } from "../command.js";
import type { PortalState } from "../client.js";
import { CliError, EXIT } from "../errors.js";
import { localiseInstants, renderTable, toJson } from "../output.js";
import { minutesBetween } from "../when.js";

interface WeekOutlook {
  capacityMinutes?: number;
  reservedMinutes?: number;
  freeMinutes?: number;
  projects?: { projectId: string; paceShortfallMinutes?: number }[];
}

interface Intervention {
  kind: string;
  actionIds?: string[];
  minutes: number;
  proposedDeadlineAt?: unknown;
  reason: string;
}

/** The forecast fields the wire type leaves out because only this command reads them. */
type StoredForecast = WireForecast & {
  proposal?: { deadlineOwner?: string };
  interventions?: Intervention[];
  agedInputs?: { actionId: string; title: string; setAt: unknown }[];
};

const iso = (value: unknown): string | undefined =>
  value === undefined || value === null ? undefined : value instanceof Date ? value.toISOString() : String(value);

/** Whether a forecast belongs in the default answer: behind, at risk, past its date, or unknown with a date to miss. */
function needsAttention(forecast: WireForecast): boolean {
  const health = displayHealth(forecast);
  return (
    health === "behind" ||
    health === "at_risk" ||
    forecast.overdue === true ||
    (health === "unknown" && forecast.internalDeadlineAt !== undefined && forecast.internalDeadlineAt !== null)
  );
}

/**
 * What the stored plan rests on. The inputs come from the same freshness rule Now and `doctor` read
 * (`resolveFreshness`), so each one carries the same stale verdict there; an age in minutes is added wherever the
 * fact has a time.
 */
function buildAssumptions(state: PortalState, now: Date) {
  const planning = state.planning;
  const result = planning?.result;
  const freshness = resolveFreshness(
    { ...state, actions: state.actions.filter((action) => action.projectId !== undefined) } as Parameters<
      typeof resolveFreshness
    >[0],
    now,
    {
      projectHealth: projectHealthFromSchedule(result?.schedule),
      agedActionIds: agedInputIdsFromSchedule(result?.schedule)
    }
  );
  // `at` is when the fact was told; a session's `asOf` is its planned end, so it is dated by its start instead.
  const fact = (input: string, item: FactFreshness, at: string | undefined = item.asOf) => ({
    input,
    stale: item.stale,
    ...(at !== undefined ? { at, ageMinutes: minutesBetween(new Date(at), now) } : {}),
    ...(item.staleAt !== undefined ? { staleAt: item.staleAt } : {})
  });
  // A journey time the engine had no measurement for: a stored stand-in, or a guess from the place or mode.
  const assumedTravel = (result?.derivedState.commitmentTimelines ?? [])
    .flatMap((timeline) => [timeline.journeyBefore, timeline.journeyAfter])
    .filter((edge) => edge?.source === "assumed" || edge?.source === "fallback").length;
  return {
    planStatus: planning?.status ?? "unavailable",
    calculatedAt: result?.calculatedAt ?? planning?.lastSuccessfulAt ?? null,
    validUntil: result?.validUntil ?? planning?.validUntil ?? null,
    awaitingRecalculation: planning?.awaitingRecalculation ?? false,
    engineVersion: result?.engineVersion ?? null,
    inputs: [
      fact("wake", freshness.wake),
      fact("energy", freshness.energy),
      fact("location", freshness.location),
      // Only while a session is open: with none there is nothing to age.
      ...(state.activeSession ? [fact("openSession", freshness.session, state.activeSession.startedAt)] : [])
    ],
    // Estimates of time left the forecast aged (at-risk projects only), oldest first.
    agedEstimates: freshness.effort.map((item) => ({
      actionId: item.actionId,
      title: item.title,
      projectId: item.projectId,
      remainingMinutes: item.remainingMinutes,
      setAt: item.asOf,
      stale: item.stale
    })),
    assumedTravel
  };
}

export function buildForecast(state: PortalState, now: Date, options: { projectId?: string; all: boolean }) {
  const result = state.planning?.result;
  const titleById = new Map(state.projects.map((project) => [project.id, project.title]));
  const outlook = (result?.weekOutlook ?? null) as WeekOutlook | null;
  const shortfallById = new Map((outlook?.projects ?? []).map((item) => [item.projectId, item.paceShortfallMinutes]));
  const all = forecastsOf(result?.schedule) as StoredForecast[];
  const known = options.projectId === undefined ? all : all.filter((item) => item.projectId === options.projectId);
  if (options.projectId !== undefined && known.length === 0)
    throw new CliError(
      `No forecast for project "${options.projectId}". \`forecast --all\` lists the projects that have one.`,
      EXIT.usage
    );
  const shown = (options.projectId !== undefined || options.all ? known : known.filter(needsAttention)).sort(
    worstFirst
  );
  const projects = shown.map((forecast) => {
    const shortfall = shortfallById.get(forecast.projectId);
    const deadline = iso(forecast.internalDeadlineAt);
    return {
      id: forecast.projectId,
      title: titleById.get(forecast.projectId) ?? forecast.projectId,
      health: displayHealth(forecast),
      // The flags and every absent figure are left out rather than sent as false or null.
      // A self-set date that passed is lapsed, not overdue: one flag or the other.
      ...(forecast.overdue === true
        ? forecast.proposal?.deadlineOwner === "internal"
          ? { lapsed: true }
          : { overdue: true }
        : {}),
      ...(forecast.expectedMarginMinutes != null ? { marginMinutes: forecast.expectedMarginMinutes } : {}),
      ...(forecast.pessimisticMarginMinutes != null ? { pessimisticMinutes: forecast.pessimisticMarginMinutes } : {}),
      ...(forecast.requiredPaceMinutesPerWeek != null
        ? { paceMinutesPerWeek: forecast.requiredPaceMinutesPerWeek }
        : {}),
      ...(shortfall ? { paceShortfallMinutes: shortfall } : {}),
      ...(forecast.confidence ? { confidence: forecast.confidence } : {}),
      // The old estimates that lowered that confidence.
      ...(forecast.agedInputs?.length
        ? {
            agedInputs: forecast.agedInputs.map((input) => ({
              actionId: input.actionId,
              title: input.title,
              setAt: iso(input.setAt)
            }))
          }
        : {}),
      ...(forecast.forecastBand ? { band: forecast.forecastBand } : {}),
      ...(deadline !== undefined ? { deadlineAt: deadline } : {}),
      ...(forecast.reasons.length ? { reasons: forecast.reasons } : {}),
      // Smallest first, as the engine sent them.
      ...(forecast.interventions?.length ? { interventions: forecast.interventions } : {})
    };
  });
  return {
    projects,
    // Forecasts the default filter left out (on track, ahead, or unknown with no date); --all shows them.
    leftOut: known.length - shown.length,
    ...(outlook
      ? {
          week: {
            capacityMinutes: outlook.capacityMinutes ?? null,
            reservedMinutes: outlook.reservedMinutes ?? null,
            freeMinutes: outlook.freeMinutes ?? null
          }
        }
      : {}),
    assumptions: buildAssumptions(state, now)
  };
}

export const forecastCommand: CommandSpec = {
  name: "forecast",
  summary: "How each live project is doing against its deadline, and what the plan rests on",
  description:
    "Plan health per live project, worst first: health, margin (expected and pessimistic), the pace it needs a " +
    "week, confidence, the engine's reasons and its smallest fixes. By default only projects that are behind, at " +
    "risk, overdue or unknown with a date (--all adds the rest; --project narrows to one). Then the assumptions: " +
    "when the plan was calculated, the wake, energy, location and open-session readings behind it (age, and " +
    "whether each is stale by the same rule as status), the aged time-left estimates, and how many travel times " +
    "the engine assumed. Read this rather than state.",
  positionals: [],
  options: {
    project: { type: "string", placeholder: "id", description: "Only this project" },
    all: { type: "boolean", description: "Include projects that are on track, ahead or undated" }
  },
  mutates: false,
  examples: ["forecast", "forecast --all --json", "forecast --project project-thesis"],
  async run(context: CommandContext, args: ParsedArgs) {
    const state = await context.client.getState();
    const projectId = stringOption(args.values, "project");
    const forecast = buildForecast(state, context.now(), {
      ...(projectId !== undefined ? { projectId } : {}),
      all: booleanOption(args.values, "all")
    });
    if (context.mode !== "table") {
      // Compact on purpose: an agent reads this, and the indentation is a fifth of a thirty-project answer.
      context.stdout(toJson(localiseInstants(forecast, state.settings.timezone)));
      return;
    }
    const { assumptions } = forecast;
    const rows = forecast.projects.map((item) => ({
      ...item,
      flag: "lapsed" in item ? "lapsed" : "overdue" in item ? "overdue" : ""
    }));
    context.stdout(
      [
        rows.length
          ? renderTable(rows, ["id", "title", "health", "flag", "marginMinutes", "paceMinutesPerWeek", "confidence"])
          : "No projects to report.",
        forecast.leftOut ? `${forecast.leftOut} more on track, ahead or undated (--all).` : "",
        `Plan ${assumptions.planStatus}, calculated ${assumptions.calculatedAt ?? "never"}` +
          `${assumptions.awaitingRecalculation ? " (recalculation pending)" : ""}, engine ${assumptions.engineVersion ?? "unknown"}.`,
        ...assumptions.inputs.map(
          (item) =>
            `${item.input}: ${"ageMinutes" in item ? `${item.ageMinutes} min old` : "never told"}${item.stale ? " (stale)" : ""}`
        ),
        ...assumptions.agedEstimates.map(
          (item) => `time left on ${item.title}: set ${item.setAt}${item.stale ? " (stale)" : ""}`
        ),
        `${assumptions.assumedTravel} travel figure(s) assumed or fallback.`
      ]
        .filter(Boolean)
        .join("\n")
    );
  }
};
