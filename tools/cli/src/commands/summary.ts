import type { PortalState } from "../client.js";
import { stringOption, type CommandContext, type CommandSpec } from "../command.js";
import { CliError, EXIT } from "../errors.js";
import { localiseInstants, renderTable, toJson } from "../output.js";
import { buildHistory, localDay, resolveDay, shiftDay } from "./history.js";

/** The longest window one call rolls up, in days. The portal keeps 30 days of sessions and sleep anyway. */
export const MAX_SUMMARY_DAYS = 31;

const RESULTS = ["completed", "stopped", "blocked", "skipped", "did_not_start"] as const;

/** A session that is not an action's work falls under the kind of thing it was. */
const KIND_LABEL: Record<string, string> = {
  routine_step: "Routines",
  routine_instance: "Routines",
  fixed_commitment: "Commitments",
  deliverable: "Deliverables"
};

const hhmm = (iso: string, timeZone: string) =>
  new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(
    new Date(iso)
  );

/** A daily rollup of the portal's history reads (`buildHistory`), for local days `from`..`to` inclusive. */
export function buildSummary(state: PortalState, from: string, to: string, now: Date) {
  const timeZone = state.settings.timezone;
  const history = buildHistory(state, from, to, now);
  const actionById = new Map(state.actions.map((action) => [action.id, action]));
  const projectTitle = new Map(state.projects.map((project) => [project.id, project.title]));
  const planById = new Map(state.sleepPlans.map((plan) => [plan.id, plan]));
  const projectOf = (session: { actionId: string; targetType?: string }): string => {
    if (session.targetType !== undefined && session.targetType !== "action")
      return KIND_LABEL[session.targetType] ?? session.targetType;
    const projectId = actionById.get(session.actionId)?.projectId;
    return (projectId ? projectTitle.get(projectId) : undefined) ?? "No project";
  };

  const days = [];
  for (let day = from; day <= to; day = shiftDay(day, 1)) {
    const sessions = history.sessions.filter((row) => row.date === day) as unknown as {
      actionId: string;
      actionTitle: string;
      result: (typeof RESULTS)[number];
      targetType?: string;
      activeMinutes: number;
      remainingAfterMinutes: number;
    }[];
    const minutesByProject = new Map<string, number>();
    const byResult: Record<string, number> = {};
    // Keyed by action id, so two finished actions that share a title both count.
    const finished = new Map<string, string>();
    for (const session of sessions) {
      byResult[session.result] = (byResult[session.result] ?? 0) + 1;
      const project = projectOf(session);
      minutesByProject.set(project, (minutesByProject.get(project) ?? 0) + session.activeMinutes);
      // A completed session that left nothing remaining finished its action.
      if (
        session.result === "completed" &&
        (session.targetType === undefined || session.targetType === "action") &&
        session.remainingAfterMinutes === 0
      )
        finished.set(session.actionId, session.actionTitle);
    }
    const nights = history.sleep
      .filter((row) => row.date === day)
      .map((row) => {
        const plan = planById.get(String(row.source === "session" ? row.actionId : row.id));
        return {
          ...(plan ? { plannedStart: plan.plannedStartAt, plannedWake: plan.plannedWakeAt } : {}),
          actualStart: String(row.actualStartAt),
          actualWake: String(row.actualWakeAt),
          minutes: Number(row.minutes)
        };
      });
    days.push({
      date: day,
      focusedMinutes: [...minutesByProject.values()].reduce((sum, minutes) => sum + minutes, 0),
      projects: [...minutesByProject]
        .map(([title, minutes]) => ({ title, minutes }))
        .sort((a, b) => b.minutes - a.minutes || a.title.localeCompare(b.title)),
      sessions: byResult,
      actionsFinished: [...finished.values()],
      sleep: nights
    });
  }

  const totalByProject = new Map<string, number>();
  const totalSessions: Record<string, number> = {};
  for (const day of days) {
    for (const item of day.projects)
      totalByProject.set(item.title, (totalByProject.get(item.title) ?? 0) + item.minutes);
    for (const [result, count] of Object.entries(day.sessions))
      totalSessions[result] = (totalSessions[result] ?? 0) + count;
  }
  return {
    from,
    to,
    timezone: timeZone,
    // Sessions and sleep before this day are not in the portal's state, so a day before it with no rows is not a quiet day.
    sessionsFrom: history.sessionsFrom,
    totals: {
      focusedMinutes: days.reduce((sum, day) => sum + day.focusedMinutes, 0),
      projects: [...totalByProject]
        .map(([title, minutes]) => ({ title, minutes }))
        .sort((a, b) => b.minutes - a.minutes || a.title.localeCompare(b.title)),
      sessions: totalSessions,
      actionsFinished: days.reduce((sum, day) => sum + day.actionsFinished.length, 0),
      sleepNights: days.reduce((sum, day) => sum + day.sleep.length, 0)
    },
    days
  };
}

export const summaryCommand: CommandSpec = {
  name: "summary",
  summary: "A daily rollup of a past window: focus by project, sessions, actions finished, sleep",
  description:
    "For each local day from --from to --to (YYYY-MM-DD in the planning time zone, or an offset such as -7d; both " +
    "default to today; at most 31 days): focused minutes by project and in total, sessions by result (completed, " +
    "stopped, blocked, skipped, did_not_start), the actions those sessions finished, and sleep nights with planned " +
    "and actual times. The portal keeps 30 days of sessions and sleep; sessionsFrom names the first day it covers. " +
    "Check-in answers are not in the state and are not summarised. Read this rather than state. " +
    "It looks backwards only: for what is coming up use `list commitments --from today --to +7d` and `forecast`.",
  positionals: [],
  options: {
    from: {
      type: "string",
      placeholder: "day",
      description: "First day: YYYY-MM-DD or an offset such as -7d (default today)"
    },
    to: { type: "string", placeholder: "day", description: "Last day, inclusive (default today)" }
  },
  mutates: false,
  examples: ["summary", "summary --from -7d", "summary --from 2026-09-01 --to 2026-09-07 --json"],
  async run(context: CommandContext, args) {
    const state = await context.client.getState();
    const now = context.now();
    const timeZone = state.settings.timezone;
    const fromRaw = stringOption(args.values, "from");
    const toRaw = stringOption(args.values, "to");
    const today = localDay(now, timeZone);
    const from = fromRaw !== undefined ? resolveDay(fromRaw, "from", now, timeZone, "rhen_summary call") : today;
    const to = toRaw !== undefined ? resolveDay(toRaw, "to", now, timeZone, "rhen_summary call") : today;
    if (to < from)
      throw new CliError(
        `to ${to} is before from ${from}, and to is the last day, inclusive. Repeat the same rhen_summary call ` +
          `with to ${from} or later, or with from ${to} or earlier.`,
        EXIT.usage
      );
    const span = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
    if (span > MAX_SUMMARY_DAYS)
      throw new CliError(`summary covers at most ${MAX_SUMMARY_DAYS} days; ${from} to ${to} is ${span}.`, EXIT.usage);
    const summary = buildSummary(state, from, to, now);
    if (from < summary.sessionsFrom)
      context.stderr(`rhen: sessions and sleep are only kept from ${summary.sessionsFrom} (sessionsFrom).`);
    if (context.mode !== "table") {
      // Compact on purpose: an agent reads this, and the indentation is a fifth of the answer.
      context.stdout(toJson(localiseInstants(summary, timeZone)));
      return;
    }
    const sleepText = (day: (typeof summary.days)[number]) =>
      day.sleep
        .map((night) => `${hhmm(night.actualStart, timeZone)}-${hhmm(night.actualWake, timeZone)} ${night.minutes}m`)
        .join(", ");
    const sessionText = (counts: Record<string, number>) =>
      RESULTS.filter((result) => counts[result])
        .map((result) => `${counts[result]} ${result}`)
        .join(", ");
    context.stdout(
      [
        `${summary.from} to ${summary.to} (${timeZone}); sessions from ${summary.sessionsFrom}`,
        renderTable(
          summary.days.map((day) => ({
            date: day.date,
            focused: day.focusedMinutes,
            sessions: sessionText(day.sessions),
            finished: day.actionsFinished.length,
            sleep: sleepText(day)
          })),
          ["date", "focused", "sessions", "finished", "sleep"]
        ),
        summary.totals.projects.length
          ? `\nProjects\n${renderTable(summary.totals.projects, ["title", "minutes"])}`
          : ""
      ]
        .filter(Boolean)
        .join("\n")
    );
  }
};
