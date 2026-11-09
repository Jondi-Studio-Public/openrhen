import type { PlanForecastResponse } from "@openrhen/contracts";
import { readJourneySummary } from "@openrhen/database";
import { redact, withRoute } from "@/server/logging";
import { ensureUser } from "@/server/persistence/postgres/ensure-user";
import { recordRun } from "@/server/persistence/postgres/run-log";
import { getStateStore } from "@/server/persistence/state-store";
import { sqlPool } from "@/server/persistence/postgres/sql-pool";
import { databaseUrl } from "@/server/runtime-env";
import {
  buildTravelLookupPlan,
  deriveTodayLegOrigins,
  type TravelLookupRequestGroup
} from "@/server/travel/lookup-plan";
import { TravelBudgetRefusedError, readTravelLookupsRemaining, spendTravelLookup } from "@/server/travel/travel-spend";
import type { PortalState } from "@/state/portal-state";

/**
 * Runs the travel lookup schedule (the travel time model design note, "Spending the budget (T5)"):
 * the worker's five-minute tick posts here with `{trigger:"scheduled"}`. Reachable like `connections/<id>/sync` —
 * it has to be safe for an outside POST to call early, so every request the planner proposes goes
 * through the one spender, which is itself idempotent and budget-bound. A refused spend (the day's
 * budget exhausted, or the reserve protected before 21:00 local) just stops this tick's own list
 * early; nothing here retries or accumulates state across calls beyond what the spender itself wrote.
 */
export const POST = withRoute("/api/integrations/travel/tick", async (request, _context, log) => {
  const body = (await request.json().catch(() => null)) as { trigger?: unknown } | null;
  const trigger = body?.trigger === "manual" || body?.trigger === "scheduled" ? body.trigger : "manual";

  const connectionString = databaseUrl();
  if (!connectionString) return Response.json({ status: "skipped", reason: "no_database", trigger });
  const sql = sqlPool(connectionString);
  const userId = await ensureUser(sql);

  const state = (await getStateStore()
    .get()
    .catch(() => null)) as PortalState | null;
  if (!state) return Response.json({ status: "skipped", reason: "no_state", trigger });

  const now = new Date();
  const timeZone = state.settings.timezone;
  const startedAt = now;

  try {
    const [journeySummary, planningRunRows, budget] = await Promise.all([
      readJourneySummary(sql, userId, now, timeZone),
      sql<{ result: unknown }[]>`
        SELECT result FROM planning_runs WHERE user_id=${userId} AND superseded_at IS NULL
        ORDER BY calculated_at DESC LIMIT 1
      `,
      readTravelLookupsRemaining(sql, userId, timeZone, now)
    ]);

    const result = planningRunRows[0]?.result as PlanForecastResponse | undefined;
    const commitmentTimelines = result?.derivedState.commitmentTimelines ?? [];
    const dayPlan = result?.dayPlan;

    const groups = buildTravelLookupPlan({
      now,
      timeZone,
      budgetRemaining: budget.remaining,
      commitmentTimelines,
      ...(dayPlan ? { dayPlan } : {}),
      journeySummary,
      todayLegOrigins: deriveTodayLegOrigins(dayPlan)
    });

    const locationsById = new Map(
      state.conditionDefinitions
        .filter((definition) => definition.kind === "location")
        .map((definition) => [definition.id, definition])
    );

    const outcomes: Array<{
      step: TravelLookupRequestGroup["step"];
      spent: number;
      remaining: number;
      refused?: string;
    }> = [];
    for (const group of groups) {
      const origin = locationsById.get(group.originLocationId);
      if (origin?.latitude === undefined || origin?.longitude === undefined) continue;
      const destinations = group.destinationLocationIds.flatMap((locationId) => {
        const place = locationsById.get(locationId);
        return place?.latitude !== undefined && place?.longitude !== undefined
          ? [{ locationId, latitude: place.latitude, longitude: place.longitude }]
          : [];
      });
      if (!destinations.length) continue;

      try {
        const spend = await spendTravelLookup(
          sql,
          userId,
          timeZone,
          {
            originLocationId: group.originLocationId,
            origin: { latitude: origin.latitude, longitude: origin.longitude },
            destinations,
            mode: group.mode,
            departureAt: group.departureAt
          },
          { allowReserve: group.allowReserve, now }
        );
        outcomes.push({ step: group.step, spent: destinations.length, remaining: spend.remaining });
      } catch (error) {
        if (error instanceof TravelBudgetRefusedError) {
          outcomes.push({ step: group.step, spent: 0, remaining: error.remaining, refused: error.reason });
          // Exhausted means nothing later in this same tick can succeed either; a reserve refusal is
          // specific to this one request (a non-live step asked while the reserve still applies), so
          // later requests — which may themselves already respect the reserve — are still worth trying.
          if (error.reason === "exhausted") break;
          continue;
        }
        throw error;
      }
    }

    // A tick that spent nothing (no plan, or the budget said no) is the normal five-minute case and leaves no row.
    const spent = outcomes.reduce((total, outcome) => total + outcome.spent, 0);
    if (spent > 0)
      await recordRun({
        provider: "job:travel-lookup",
        trigger,
        status: "synced",
        startedAt,
        finishedAt: new Date(),
        summary: { groups: groups.length, spent, remaining: outcomes[outcomes.length - 1]!.remaining }
      });
    return Response.json({ status: "ok", trigger, groups: groups.length, outcomes });
  } catch (error) {
    log.setError(error);
    const message = error instanceof Error ? redact(error.message) : "The travel lookup tick failed.";
    await recordRun({
      provider: "job:travel-lookup",
      trigger,
      status: "failed",
      startedAt,
      finishedAt: new Date(),
      summary: { error: message.slice(0, 500) }
    });
    return Response.json({ error: message, trigger }, { status: 502 });
  }
});
