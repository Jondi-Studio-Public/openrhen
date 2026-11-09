import { parseDerivedSettingsPatch } from "@/server/derived/derived-settings";
import { withRoute } from "@/server/logging";
import { readDerivedSettings, saveDerivedSettings } from "@/server/persistence/postgres/derived-settings-store";
import { sqlPool } from "@/server/persistence/postgres/sql-pool";
import { databaseUrl } from "@/server/runtime-env";

/**
 * The hosted key is not part of these settings; this note travels with every answer so the owner (and the settings
 * card) never has to guess where it went.
 */
const KEY_NOTE =
  "The hosted (DeepInfra) API key is not stored here. It is a saved key under Settings > Passwords and keys, and a restore from a backup empties saved keys, so enter it again after one. This setting only stores the address: the outbound proxy refuses loopback, link-local and metadata addresses, compose-service names and its own subnets when it makes the call, not here.";

/**
 * Mail-understanding settings: the local model's address (`ollamaUrl`), the models the next extractor version is pinned
 * to (`t2Model`, `t3Model`), the hosted tier's daily caps and how many days back the model tier backfills. The owner's
 * own read and write: the URL is a network address and the settings decide where mail text is sent, so no agent token
 * reaches either (`OWNER_READS`, `OWNER_ROUTES`).
 */
export const GET = withRoute("/api/derived-settings", async () => {
  const connectionString = databaseUrl();
  if (!connectionString) return Response.json({ error: "Mail understanding requires PostgreSQL." }, { status: 503 });
  return Response.json(
    { settings: await readDerivedSettings(sqlPool(connectionString)), note: KEY_NOTE },
    { headers: { "cache-control": "no-store" } }
  );
});

/** Saves any of the settings: a field left out keeps its value; a text field sent as null (or empty) is cleared. */
export const PUT = withRoute("/api/derived-settings", async (request: Request) => {
  const parsed = parseDerivedSettingsPatch(await request.json().catch(() => null));
  if (!parsed.ok)
    return Response.json({ error: parsed.problems.join(" "), problems: parsed.problems }, { status: 400 });
  const connectionString = databaseUrl();
  if (!connectionString) return Response.json({ error: "Mail understanding requires PostgreSQL." }, { status: 503 });
  return Response.json(
    { settings: await saveDerivedSettings(sqlPool(connectionString), parsed.patch), note: KEY_NOTE },
    { headers: { "cache-control": "no-store" } }
  );
});
