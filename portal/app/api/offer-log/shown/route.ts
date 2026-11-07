import { offerLogShownSchema } from "@openrhen/contracts";
import { withRoute } from "@/server/logging";
import { ensureUser } from "@/server/persistence/postgres/ensure-user";
import { logOfferShown } from "@/server/persistence/postgres/offer-log-writer";
import { sqlPool } from "@/server/persistence/postgres/sql-pool";
import { databaseUrl } from "@/server/runtime-env";

/**
 * What the open Now page resolved to, for the offer log (event `shown`).
 *
 * Same gate as every portal route (`withRoute`: same-origin check, then the owner gate). Append-only and write-only:
 * nothing here feeds back into a plan.
 *
 * `POST /api/offer-log/shown`, JSON body validated by `offerLogShownSchema` (`clientId` uuid, `surface: "portal"`,
 * `resolutionKind`, `targetType`, `targetId`, `label`, optional `executionOptionId` and `suppressedBy`).
 *
 * `200 { "recorded": boolean }`: `false` when the row was dropped as an identical (surface, target, resolution kind)
 * repeat inside five minutes, or when `clientId` was already recorded. `400` on a body that fails validation.
 * `shown` is a lower bound on exposure (background tabs, several surfaces, polling).
 */
export const POST = withRoute("/api/offer-log/shown", async (request, _context, log) => {
  const parsed = offerLogShownSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success)
    return Response.json(
      { error: "The shown event failed validation.", issues: parsed.error.issues.slice(0, 20) },
      { status: 400 }
    );
  log.setCommandType("offer-shown");
  const connectionString = databaseUrl();
  if (!connectionString) return Response.json({ error: "The database is unavailable." }, { status: 503 });
  const sql = sqlPool(connectionString);
  const userId = await ensureUser(sql);
  const { clientId, ...shown } = parsed.data;
  const recorded = await logOfferShown(sql, userId, { ...shown, commandId: clientId });
  return Response.json({ recorded });
});
