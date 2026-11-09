import { MODEL_PROVIDERS } from "@openrhen/contracts";
import { createModelTransport } from "@/integrations/models/model-proxy-client";
import { processPolicyState, type PolicyDeps } from "@/server/derived/call-policy";
import { runConnectionTest } from "@/server/derived/connection-test";
import { withRoute } from "@/server/logging";
import { hostedUsageLast24Hours, recordModelCall } from "@/server/persistence/postgres/derived-model-calls-store";
import { readDerivedSettings } from "@/server/persistence/postgres/derived-settings-store";
import { ensureUser } from "@/server/persistence/postgres/ensure-user";
import { sqlPool } from "@/server/persistence/postgres/sql-pool";
import { databaseUrl } from "@/server/runtime-env";

/**
 * The Test button in Settings > Mail understanding: one small call to the local or the hosted model with fixed
 * synthetic text (never mail), using the saved address, model and key. Always answers 200 with the outcome in
 * `result`, so the card can show the proxy's own sentence; a bad request is a 400. Owner-only like the settings:
 * the call spends the hosted allowance and reaches a LAN address.
 */
export const POST = withRoute("/api/derived-settings/test", async (request: Request) => {
  const body = (await request.json().catch(() => null)) as { tier?: unknown } | null;
  const tier = body?.tier;
  if (tier !== "t2" && tier !== "t3")
    return Response.json(
      { error: 'Send {"tier":"t2"} to test the local model or {"tier":"t3"} for the hosted one.' },
      { status: 400 }
    );
  const connectionString = databaseUrl();
  if (!connectionString) return Response.json({ error: "Mail understanding requires PostgreSQL." }, { status: 503 });
  const sql = sqlPool(connectionString);
  const userId = await ensureUser(sql);
  const settings = await readDerivedSettings(sql);
  const policy: PolicyDeps = {
    hosted: MODEL_PROVIDERS.hosted,
    transport: createModelTransport({ sql, userId, localAddress: settings.ollamaUrl }),
    settings,
    usage: () => hostedUsageLast24Hours(sql, userId),
    recordCall: (row) => recordModelCall(sql, userId, row),
    isHostedEligible: async () => ({ eligible: true }),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    state: processPolicyState
  };
  const result = await runConnectionTest(policy, tier, tier === "t2" ? settings.t2Model : settings.t3Model);
  return Response.json({ result }, { headers: { "cache-control": "no-store" } });
});
