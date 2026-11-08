import { estimateBackfill } from "@openrhen/communication-readers";
import { withRoute } from "@/server/logging";
import { readActivitySummary } from "@/server/persistence/postgres/activity-store";
import {
  EVAL_STATEMENT_TIMEOUT,
  EVAL_WINDOW_DEFAULT,
  EVAL_WINDOW_MAX,
  EVAL_WINDOW_MIN,
  readEvalReport
} from "@/server/persistence/postgres/eval-report-store";
import { sqlPool } from "@/server/persistence/postgres/sql-pool";
import { databaseUrl } from "@/server/runtime-env";

/**
 * Counts and the last event per source, each source's content gate and retention, and recent imports. The owner's own
 * read. `?report=eval` adds `eval`: how each extractor version agrees with the person's own labels (precision and recall
 * with intervals, wrong automatic actions, the T0 share), computed only when asked for. With `tokens_per_message` and
 * `seconds_per_message` (both, bounded) it also sizes a model backfill of the raw mail still held. `window` (rows the
 * bounded reads look at; default 100000) narrows or widens the report. A report that outruns its statement timeout is a
 * 503 with Retry-After and the fix, never an opaque 500.
 */
export const GET = withRoute("/api/activity-events/summary", async (request) => {
  const connectionString = databaseUrl();
  if (!connectionString) return Response.json({ error: "The activity store requires PostgreSQL." }, { status: 503 });
  const report = new URL(request.url).searchParams.get("report");
  if (report !== null && report !== "eval")
    return Response.json(
      {
        error: `report "${report}" is not a report this route has. The only value is "eval" (GET /api/activity-events/summary?report=eval). Remove the report parameter for the plain summary.`
      },
      { status: 400 }
    );
  const params = new URL(request.url).searchParams;
  const sizing = ["tokens_per_message", "seconds_per_message"].map((name) => ({ name, raw: params.get(name) }));
  if (sizing.some((item) => item.raw !== null) && report !== "eval")
    return Response.json(
      {
        error:
          "tokens_per_message and seconds_per_message size a backfill and belong to the eval report. Add report=eval (GET /api/activity-events/summary?report=eval&tokens_per_message=800&seconds_per_message=2), or remove them."
      },
      { status: 400 }
    );
  let backfill: { tokensPerMessage: number; secondsPerMessage: number } | undefined;
  if (sizing.some((item) => item.raw !== null)) {
    const missing = sizing.find((item) => item.raw === null);
    if (missing)
      return Response.json(
        { error: `${missing.name} is missing. Send both tokens_per_message and seconds_per_message, or neither.` },
        { status: 400 }
      );
    const [tokens, seconds] = sizing.map((item) => (item.raw === "" ? Number.NaN : Number(item.raw)));
    for (const [item, value] of [
      [sizing[0]!, tokens!],
      [sizing[1]!, seconds!]
    ] as const)
      if (!Number.isFinite(value))
        return Response.json(
          { error: `${item.name} "${item.raw}" is not a number. Send the measured figure, such as ${item.name}=800.` },
          { status: 400 }
        );
    backfill = { tokensPerMessage: tokens!, secondsPerMessage: seconds! };
    try {
      // The pure calculator owns the bounds; a dry run states them in its own words.
      estimateBackfill({ messages: 0, ...backfill });
    } catch (error) {
      return Response.json(
        { error: error instanceof Error ? error.message : "The sizing figures are not usable." },
        { status: 400 }
      );
    }
  }
  const rawWindow = params.get("window");
  let window: number | undefined;
  if (rawWindow !== null) {
    if (report !== "eval")
      return Response.json(
        {
          error:
            "window sizes the eval report. Add report=eval (GET /api/activity-events/summary?report=eval&window=50000), or remove it."
        },
        { status: 400 }
      );
    window = rawWindow === "" ? Number.NaN : Number(rawWindow);
    if (!Number.isInteger(window) || window < EVAL_WINDOW_MIN || window > EVAL_WINDOW_MAX)
      return Response.json(
        {
          error: `window "${rawWindow}" is not a whole number of rows from ${EVAL_WINDOW_MIN} to ${EVAL_WINDOW_MAX}. Send the number of rows the report may look at, such as window=50000 (default ${EVAL_WINDOW_DEFAULT}).`
        },
        { status: 400 }
      );
  }
  const sql = sqlPool(connectionString);
  try {
    const summary = await readActivitySummary(sql);
    return Response.json(
      report === "eval" ? { ...summary, eval: await readEvalReport(sql, { backfill, window }) } : summary,
      { headers: { "cache-control": "no-store" } }
    );
  } catch (error) {
    // 57014 is Postgres cancelling a statement that ran past its statement timeout.
    if ((error as { code?: unknown } | null)?.code !== "57014") throw error;
    return Response.json(
      {
        error: `The eval report timed out: a query ran longer than ${EVAL_STATEMENT_TIMEOUT} and Postgres cancelled it, so nothing was returned. The report is heavy on a large store. Nothing was changed. Retry in a minute (Retry-After: 60); if it times out again, narrow it with a smaller window, such as ?report=eval&window=20000 (it is ${EVAL_WINDOW_DEFAULT} by default and can go down to ${EVAL_WINDOW_MIN}), and tell the owner if even that times out.`
      },
      { status: 503, headers: { "retry-after": "60", "cache-control": "no-store" } }
    );
  }
});
