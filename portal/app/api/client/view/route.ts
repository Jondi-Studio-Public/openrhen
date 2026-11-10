import { withRoute } from "@/server/logging";
import {
  buildClientView,
  clientViewETag,
  clientViewETagMatches,
  parseClientViewParts
} from "@/server/client/client-view";
import { ensureUser } from "@/server/persistence/postgres/ensure-user";
import { readCurrentCheckIn } from "@/server/persistence/postgres/readers/check-in-read";
import { sqlPool } from "@/server/persistence/postgres/sql-pool";
import { getStateStore } from "@/server/persistence/state-store";
import { databaseUrl } from "@/server/runtime-env";
import type { PortalState } from "@/state/portal-state";

/**
 * What an installed app and its widgets read: `GET /api/client/view?parts=now,day,pending` (default all three).
 * Owner only, and open to a limited device credential (a read, so not `owner-admin`). The payload is built by the
 * functions the web and `rhen status` use (`server/client/client-view.ts`); the types are in
 * `platform/contracts/src/client-view.ts` and published as JSON Schema beside it. The `ETag` covers the whole body and
 * `If-None-Match` answers 304. `/api/device/now` is a different, frozen contract and is not touched.
 *
 * The waiting check-in is read with `stamp: false`: a widget or background refresh is not the owner being shown the
 * question, so it must not start the timeout. The app reports a surface actually showing it with
 * `POST /api/check-ins/{id}/shown`. Without PostgreSQL the check-in is absent and the rest still answers.
 *
 * `no-store` because the body is a live reading; revalidation by `ETag` is the only caching wanted.
 */
const HEADERS = { "Cache-Control": "no-store" } as const;

export const GET = withRoute("/api/client/view", async (request) => {
  const parsed = parseClientViewParts(new URL(request.url).searchParams.get("parts"));
  if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400, headers: HEADERS });
  const state = (await getStateStore().get()) as PortalState | null;
  if (!state) return Response.json({ error: "State is unavailable." }, { status: 503, headers: HEADERS });
  let checkIn = null;
  const connectionString = databaseUrl();
  if (parsed.parts.includes("pending") && connectionString) {
    const sql = sqlPool(connectionString);
    checkIn = await readCurrentCheckIn(sql, await ensureUser(sql), { stamp: false });
  }
  const body = JSON.stringify(buildClientView(state, new Date(), parsed.parts, checkIn));
  const etag = clientViewETag(body);
  if (clientViewETagMatches(request.headers.get("if-none-match"), etag))
    return new Response(null, { status: 304, headers: { ...HEADERS, ETag: etag } });
  return new Response(body, { headers: { ...HEADERS, ETag: etag, "Content-Type": "application/json" } });
});
