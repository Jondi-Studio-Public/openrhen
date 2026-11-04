import { reentryAnswerGuide, reentryReviewable } from "@openrhen/contracts";
import {
  readEnergyMeanings,
  readPulseReentryView,
  readReentryChoices,
  readReentryReview
} from "@/server/persistence/postgres/reenter";
import { sqlPool } from "@/server/persistence/postgres/sql-pool";
import { databaseUrl } from "@/server/runtime-env";

/**
 * The read behind `GET /api/pulse/reentry` (scope `read:plan`, for `status` and `wake`) and `GET /api/commands/reenter`
 * (scope `write:catch-up`, for a token that can only re-enter): the pulse, and while it is lapsed the items the gap
 * asks about, the places and contexts that can be named, and `answer`: the energy options with their meanings, what to
 * answer for this gap (or that nothing needs reviewing, so the settlement may be omitted) and an exact example call.
 * `?brief=1` leaves the review out.
 */
export async function reentryLook(request: Request): Promise<Response> {
  const connectionString = databaseUrl();
  if (!connectionString) return Response.json({ error: "The pulse requires PostgreSQL." }, { status: 503 });
  const sql = sqlPool(connectionString);
  const read = await readPulseReentryView(sql);
  if (!read) return Response.json({ pulse: null, lapsed: false });
  const brief = new URL(request.url).searchParams.get("brief") === "1";
  if (!read.lapsed || brief) return Response.json({ pulse: read.view, lapsed: read.lapsed });
  const review = await readReentryReview(sql);
  const choices = await readReentryChoices(sql);
  const entries = review?.entries.filter(reentryReviewable) ?? [];
  return Response.json({
    pulse: read.view,
    lapsed: true,
    review: review && { ...review.reentry, entries },
    choices,
    answer: reentryAnswerGuide({
      tier: review?.reentry.tier ?? read.view.reentry.tier,
      entries,
      days: review?.reentry.days ?? [],
      energyMeanings: await readEnergyMeanings(sql),
      places: choices.places,
      contexts: choices.contexts
    })
  });
}
