import { z } from "zod";
import { withRoute } from "@/server/logging";
import { findHandEntryMatch } from "@/server/persistence/postgres/hand-entry-match";
import { sqlPool } from "@/server/persistence/postgres/sql-pool";
import { databaseUrl } from "@/server/runtime-env";

const querySchema = z
  .object({
    title: z.string().trim().min(1).max(500),
    startsAt: z.string().datetime({ offset: true }),
    endsAt: z.string().datetime({ offset: true })
  })
  .refine((value) => Date.parse(value.startsAt) < Date.parse(value.endsAt), "A commitment must end after it starts.");

/**
 * The hand-entry check: does an existing commitment
 * near these times look like the one being typed in? `GET ?title&startsAt&endsAt` (ISO instants).
 * Response: `{ match: null | { kind: "strong" | "possible", id, title, startsAt } }`. Read-only, and
 * advisory: the editor never blocks on it.
 */
export const GET = withRoute("/api/commitments/matches", async (request) => {
  const url = new URL(request.url);
  const parsed = querySchema.safeParse({
    title: url.searchParams.get("title"),
    startsAt: url.searchParams.get("startsAt"),
    endsAt: url.searchParams.get("endsAt")
  });
  if (!parsed.success)
    return Response.json({ error: parsed.error.issues[0]?.message ?? "Invalid request." }, { status: 400 });
  const connectionString = databaseUrl();
  if (!connectionString) return Response.json({ error: "Matching requires PostgreSQL." }, { status: 503 });
  const match = await findHandEntryMatch(sqlPool(connectionString), parsed.data);
  return Response.json({ match }, { headers: { "cache-control": "no-store" } });
});
