import { withRoute } from "@/server/logging";
import { sqlPool } from "@/server/persistence/postgres/sql-pool";
import { databaseUrl } from "@/server/runtime-env";
import {
  PlanSearchInputError,
  SEARCH_DEFAULT_LIMIT,
  SEARCH_MAX_LIMIT,
  parseKinds,
  searchPlan,
  type SearchMode
} from "@/server/search/plan-search";

const SEARCH_MAX_QUERY_LENGTH = 500;
const MODES: readonly SearchMode[] = ["hybrid", "words", "meaning"];

/**
 * Plan search:
 * `?q=&kinds=&status=open|any|a,b&under=&mode=hybrid|words|meaning&like=&limit=` (limit 1-50, default 10).
 * Best match first across every kind, words and meaning fused. 400 for a request the caller can fix.
 */
export const GET = withRoute("/api/plan/search", async (request: Request) => {
  const connectionString = databaseUrl();
  if (!connectionString) return Response.json({ error: "Plan search requires PostgreSQL." }, { status: 503 });
  const params = new URL(request.url).searchParams;
  const q = params.get("q")?.trim() ?? "";
  const like = params.get("like")?.trim() || undefined;
  if (!q && !like)
    return Response.json({ error: "Give a search in ?q=, or ?like= with a record id." }, { status: 400 });
  if (q.length > SEARCH_MAX_QUERY_LENGTH)
    return Response.json(
      { error: `The search is too long: at most ${SEARCH_MAX_QUERY_LENGTH} characters.` },
      { status: 400 }
    );
  const mode = (params.get("mode")?.trim() || "hybrid") as SearchMode;
  if (!MODES.includes(mode))
    return Response.json({ error: `mode must be one of ${MODES.join(", ")}.` }, { status: 400 });
  const rawStatus = params.get("status")?.trim() || "open";
  const status =
    rawStatus === "open" || rawStatus === "any"
      ? rawStatus
      : rawStatus
          .split(",")
          .map((value) => value.trim())
          .filter((value) => value !== "");
  const rawLimit = params.get("limit");
  const limitValue = Number(rawLimit);
  const limit =
    rawLimit !== null && rawLimit !== "" && Number.isInteger(limitValue)
      ? Math.min(Math.max(limitValue, 1), SEARCH_MAX_LIMIT)
      : SEARCH_DEFAULT_LIMIT;
  try {
    const kinds = params.get("kinds") ? parseKinds(params.get("kinds")!) : undefined;
    const under = params.get("under")?.trim() || undefined;
    return Response.json(
      await searchPlan(sqlPool(connectionString), {
        ...(q ? { query: q } : {}),
        ...(kinds ? { kinds } : {}),
        status,
        ...(under ? { under } : {}),
        mode,
        ...(like ? { like } : {}),
        limit
      })
    );
  } catch (error) {
    if (error instanceof PlanSearchInputError) return Response.json({ error: error.message }, { status: 400 });
    throw error;
  }
});
