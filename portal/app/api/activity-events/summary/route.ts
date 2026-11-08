import { estimateBackfill } from "@openrhen/communication-readers";
import { withRoute } from "@/server/logging";
import { readActivitySummary } from "@/server/persistence/postgres/activity-store";
import { readEvalReport } from "@/server/persistence/postgres/eval-report-store";
import { sqlPool } from "@/server/persistence/postgres/sql-pool";
import { databaseUrl } from "@/server/runtime-env";

/**
 * Counts and the last event per source, each source's content gate and retention, and recent imports. The owner's own
 * read. `?report=eval` adds `eval`: how each extractor version agrees with the person's own labels (precision and recall
 * with intervals, wrong automatic actions, the T0 share), computed only when asked for. With `tokens_per_message` and
 * `seconds_per_message` (both, bounded) it also sizes a model backfill of the raw mail still held.
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
  const sql = sqlPool(connectionString);
  const summary = await readActivitySummary(sql);
  return Response.json(report === "eval" ? { ...summary, eval: await readEvalReport(sql, { backfill }) } : summary, {
    headers: { "cache-control": "no-store" }
  });
});
