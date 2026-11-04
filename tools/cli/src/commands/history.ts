import type { PortalState } from "../client.js";
import { stringOption, type CommandContext, type CommandSpec } from "../command.js";
import type { AnyRecord } from "../entities.js";
import { CliError, EXIT } from "../errors.js";
import { renderTable, toJson } from "../output.js";
import { parseWhen } from "../when.js";

/**
 * How far back the portal keeps sessions, sleep and closed occurrences in its state
 * (`HISTORY_WINDOW_DAYS` in `portal/shared/history-window.ts`). Spans reach a year either side of today.
 */
export const SESSION_WINDOW_DAYS = 30;
// The CLI cannot import the portal's constants; keep both in step with `HISTORY_WINDOW_DAYS` and
// `SPAN_STATE_BOUND_DAYS` (platform/contracts/src/planning/span.ts).
const SPAN_WINDOW_DAYS = 365;

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A calendar day (YYYY-MM-DD), or any `parseWhen` word or offset (`-7d`, `yesterday`, `today`) as the local day it
 * falls on. The refusal names today's date, so the caller has a real example to copy.
 */
export function resolveDay(raw: string, flag: string, now: Date, timeZone: string, tool = "call"): string {
  const text = raw.trim();
  const refuse = (): never => {
    const today = localDay(now, timeZone);
    throw new CliError(
      `${flag} "${raw}" is not a day I can read. Send a calendar day written YYYY-MM-DD in the portal's time zone ` +
        `(today there is ${today}, so ${flag} ${today}), or today, yesterday or an offset in days such as -7d. ` +
        `Repeat the same ${tool} with ${flag} corrected.`,
      EXIT.usage
    );
  };
  if (DAY.test(text)) {
    const real =
      !Number.isNaN(Date.parse(`${text}T00:00:00Z`)) && new Date(`${text}T00:00:00Z`).toISOString().startsWith(text);
    return real ? text : refuse();
  }
  try {
    return localDay(parseWhen(text, now, timeZone), timeZone);
  } catch {
    return refuse();
  }
}

export function shiftDay(day: string, days: number): string {
  return new Date(new Date(`${day}T00:00:00Z`).getTime() + days * 86_400_000).toISOString().slice(0, 10);
}

export function localDay(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

/** Everything the calendar shows for `from`..`to` (inclusive local days), as one record. */
export function buildHistory(state: PortalState, from: string, to: string, now: Date) {
  const timeZone = state.settings.timezone;
  const sessionsFrom = shiftDay(localDay(now, timeZone), -SESSION_WINDOW_DAYS);
  const spansFrom = shiftDay(localDay(now, timeZone), -SPAN_WINDOW_DAYS);
  const effectiveFrom = from > sessionsFrom ? from : sessionsFrom;
  const inRange = (day: string) => day >= effectiveFrom && day <= to;
  const sessionRows = state.completedToday
    .map((session): AnyRecord => ({
      ...(session as unknown as AnyRecord),
      date: localDay(new Date(session.endedAt), timeZone)
    }))
    .filter((row) => inRange(String(row.date)))
    .sort((a, b) => String(a.endedAt).localeCompare(String(b.endedAt)));
  // Sleep is the sleep sessions plus completed sleep plans no session covers (nights logged by hand). A sleep
  // session's `actionId` is its plan's id; a plan row is dated by the day it ended, like a session.
  const sleepSessions = sessionRows.filter((row) => row.targetType === "sleep");
  const coveredPlanIds = new Set(
    state.completedToday.filter((item) => item.targetType === "sleep").map((item) => item.actionId)
  );
  const sleep = [
    ...sleepSessions.map((row): AnyRecord => ({
      ...row,
      source: "session",
      actualStartAt: row.startedAt,
      actualWakeAt: row.endedAt,
      minutes: row.activeMinutes,
      manual: false
    })),
    ...state.sleepPlans.flatMap((plan): AnyRecord[] => {
      if (plan.status !== "completed" || !plan.actualStartAt || !plan.actualWakeAt || coveredPlanIds.has(plan.id))
        return [];
      const date = localDay(new Date(plan.actualWakeAt), timeZone);
      if (!inRange(date)) return [];
      return [
        {
          id: plan.id,
          source: "sleep_plan",
          date,
          result: plan.manual ? "logged" : "completed",
          actualStartAt: plan.actualStartAt,
          actualWakeAt: plan.actualWakeAt,
          minutes: Math.max(0, Math.round((Date.parse(plan.actualWakeAt) - Date.parse(plan.actualStartAt)) / 60_000)),
          manual: plan.manual === true
        }
      ];
    })
  ].sort((a, b) => Date.parse(String(a.actualWakeAt)) - Date.parse(String(b.actualWakeAt)));
  const actionTitle = (id: string) => state.actions.find((action) => action.id === id)?.title;
  return {
    from,
    to,
    timezone: timeZone,
    sessionsFrom,
    spansFrom,
    sessions: sessionRows.filter((row) => row.targetType !== "sleep"),
    sleep,
    occurrences: state.occurrences
      .filter((item) => (item.status === "completed" || item.status === "missed") && inRange(item.localDate))
      .map((item) => ({ ...item, actionTitle: actionTitle(item.actionId) }))
      .sort((a, b) => a.localDate.localeCompare(b.localDate)),
    spans: state.spans.filter((span) => span.endDate >= from && span.startDate <= to)
  };
}

export const historyCommand: CommandSpec = {
  name: "history",
  summary: "Show what happened between two days: sessions, sleep, closed occurrences and spans",
  description:
    "Reads the History calendar's data for the days --from to --to inclusive (YYYY-MM-DD in the portal's time " +
    "zone, today, yesterday or an offset in days such as -30d; default the last 30 days). It looks backwards only: for what is coming " +
    "up use `list commitments --from today --to +7d` and `forecast`. Returns sessions, sleep (tracked sleep sessions and nights logged by hand, " +
    "each with a source of session or sleep_plan), closed recurring occurrences and spans. Spans are " +
    "returned back to spansFrom (a year); the portal keeps sessions, sleep and occurrences only for the last 30 days, " +
    "so those are clamped to that window: the output names the clamped start as sessionsFrom and a one-line " +
    "notice is printed when --from is earlier. A day before sessionsFrom with no rows is not a day with no activity.",
  positionals: [],
  options: {
    from: {
      type: "string",
      placeholder: "day",
      description:
        "First day: YYYY-MM-DD in the portal's time zone, today, yesterday or an offset in days such as -30d (default: 30 days ago)"
    },
    to: {
      type: "string",
      placeholder: "day",
      description: "Last day, inclusive: YYYY-MM-DD, today, yesterday or an offset in days such as -1d (default: today)"
    }
  },
  mutates: false,
  examples: ["history --from 2026-09-27 --to 2026-10-03", "history --from 2026-09-01 --to 2026-09-30 --json"],
  async run(context: CommandContext, args) {
    const state = await context.client.getState();
    const now = context.now();
    const today = localDay(now, state.settings.timezone);
    const timeZone = state.settings.timezone;
    const fromRaw = stringOption(args.values, "from");
    const toRaw = stringOption(args.values, "to");
    const tool = "rhen_history call";
    const from =
      fromRaw !== undefined ? resolveDay(fromRaw, "from", now, timeZone, tool) : shiftDay(today, -SESSION_WINDOW_DAYS);
    const to = toRaw !== undefined ? resolveDay(toRaw, "to", now, timeZone, tool) : today;
    if (from > today)
      throw new CliError(
        `from ${from} is after today (${today}), and history looks backwards only. For what is coming up call ` +
          `rhen_list with entity commitments, from today and to +7d. For the past, repeat the same ${tool} ` +
          `with from ${today} or earlier.`,
        EXIT.usage
      );
    if (to < from)
      throw new CliError(
        `to ${to} is before from ${from}, and to is the last day, inclusive. Repeat the same ${tool} with to ${from} ` +
          `or later (to ${today} for today), or with from ${to} or earlier.`,
        EXIT.usage
      );
    const history = buildHistory(state, from, to, now);
    if (from < history.sessionsFrom)
      context.stderr(
        `rhen: sessions, sleep and occurrences are only kept for the last ${SESSION_WINDOW_DAYS} days; showing them from ${history.sessionsFrom} (sessionsFrom). Spans are kept for a year.`
      );
    if (from < history.spansFrom)
      context.stderr(
        `rhen: spans are only kept for the last ${SPAN_WINDOW_DAYS} days; showing them from ${history.spansFrom} (spansFrom).`
      );
    if (context.mode !== "table") {
      context.stdout(toJson(history, context.mode === "json"));
      return;
    }
    const sections: [string, readonly unknown[], string[]][] = [
      ["Spans", history.spans, ["title", "startDate", "endDate", "window.localStartTime", "window.localEndTime"]],
      ["Sessions", history.sessions, ["date", "actionTitle", "result", "activeMinutes"]],
      ["Sleep", history.sleep, ["date", "result", "minutes", "source"]],
      ["Occurrences", history.occurrences, ["localDate", "actionTitle", "windowName", "status"]]
    ];
    context.stdout(
      [`${history.from} to ${history.to} (${history.timezone}); sessions from ${history.sessionsFrom}`]
        .concat(
          sections.map(([title, rows, columns]) =>
            rows.length ? `\n${title} (${rows.length})\n${renderTable(rows, columns)}` : `\n${title}: none`
          )
        )
        .join("\n")
    );
  }
};
