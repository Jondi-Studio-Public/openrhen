import { requestAgent, requestAgentAuthenticated, requestScopes } from "@/server/agent-actor";
import { withRoute } from "@/server/logging";
import { FACT_LISTING_LIMIT_DEFAULT, readFactListing } from "@/server/persistence/postgres/fact-listing-store";
import { OpenFactsTimeoutError } from "@/server/persistence/postgres/open-facts-store";
import { sqlPool } from "@/server/persistence/postgres/sql-pool";
import { databaseUrl } from "@/server/runtime-env";

/**
 * The open mail facts for `rhen_inbox` room `facts` (communication understanding, slice 2b-9): the folded open facts with
 * their ids and, for the first five only, a sanitised quote (untrusted mail text; the caller fences it), and the marks
 * the asking agent made that it can still take back. `canAct` says whether this caller may mark facts at all (an agent
 * token that holds `write:inbox`), so the listing never offers a call the token cannot make. Read only; the answer is
 * about who asks, so no cache may keep it.
 */
const HEADERS = {
  "cache-control": "private, no-store",
  vary: "Cookie, Authorization, X-OpenRhen-Token, X-OpenRhen-Agent"
};
const reply = (body: unknown, status = 200) => Response.json(body, { status, headers: HEADERS });

export const GET = withRoute("/api/facts", async (request) => {
  const params = new URL(request.url).searchParams;
  const rawLimit = params.get("limit");
  const limit = rawLimit === null ? FACT_LISTING_LIMIT_DEFAULT : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200)
    return reply(
      {
        error:
          'limit must be a whole number from 1 to 200. Call rhen_inbox {"room":"facts"} (it sends the default, 20), or GET /api/facts?limit=20.'
      },
      400
    );
  const connectionString = databaseUrl();
  if (!connectionString)
    return reply(
      {
        error:
          'The open mail items need PostgreSQL, and the portal has no database right now. Nothing was changed. Tell the owner, then call rhen_inbox {"room":"facts"} again once the portal has its database.'
      },
      503
    );
  const agent = requestAgent();
  const scopes = requestScopes();
  try {
    const listing = await readFactListing(sqlPool(connectionString), { now: new Date(), limit, agent, shared: true });
    return reply({
      ...listing,
      // A named agent with a database token needs write:inbox; the owner's session marks nothing through this route.
      canAct: agent !== null && requestAgentAuthenticated() && (scopes === undefined || scopes.includes("write:inbox"))
    });
  } catch (error) {
    if (error instanceof OpenFactsTimeoutError)
      return reply(
        {
          error:
            'Reading the open mail items ran past the time limit and was cancelled. Nothing was changed. Wait a minute, then call rhen_inbox {"room":"facts"} again.'
        },
        503
      );
    throw error;
  }
});
