import {
  DERIVED_SETTINGS_DEFAULTS,
  LOCAL_ADDRESS_FIELD,
  type DerivedSettings,
  type DerivedSettingsPatch
} from "@/server/derived/derived-settings";
import { FACT_LLM } from "@/server/derived/fact-llm";
import { ensureUser } from "./ensure-user";
import { pinModelVersionTx } from "./extractor-state-store";
import type { PoolSql } from "./sql-pool";

/**
 * Mail-understanding settings (`derived_settings`, one row per person, communication understanding slice 2b-2). An
 * absent row reads as the defaults, so nothing needs seeding. A PUT merges into what is held: a field left out keeps
 * its value, and a text field sent as null is cleared. Values are checked by `parseDerivedSettingsPatch` before they get
 * here; the table's CHECK constraints are the backstop. The hosted API key is not stored here (it is an `app_secrets` row).
 */

export interface DerivedSettingsView extends DerivedSettings {
  /** When the settings were last saved; null while none have been (the defaults are in force). */
  updatedAt: string | null;
}

interface SettingsRow {
  ollama_url: string | null;
  t2_model: string | null;
  t3_model: string | null;
  t3_daily_message_cap: number;
  t3_daily_token_cap: number;
  backfill_days: number;
  updated_at: Date;
}

const toView = (row: SettingsRow | undefined): DerivedSettingsView =>
  row
    ? {
        ollamaUrl: row.ollama_url,
        t2Model: row.t2_model,
        t3Model: row.t3_model,
        t3DailyMessageCap: row.t3_daily_message_cap,
        t3DailyTokenCap: row.t3_daily_token_cap,
        backfillDays: row.backfill_days,
        updatedAt: row.updated_at.toISOString()
      }
    : { ...DERIVED_SETTINGS_DEFAULTS, updatedAt: null };

/** Said when saving settings made (or re-pinned) a version of the fact extractor, so the owner is told what happens next. */
export interface PinnedVersionNote {
  extractor: string;
  version: string;
  action: "created" | "repinned";
  note: string;
}
export interface DerivedSettingsSaved extends DerivedSettingsView {
  pinnedVersion?: PinnedVersionNote;
}

export async function readDerivedSettings(sql: PoolSql): Promise<DerivedSettingsView> {
  const userId = await ensureUser(sql);
  const [row] = await sql<SettingsRow[]>`
    SELECT ollama_url, t2_model, t3_model, t3_daily_message_cap, t3_daily_token_cap, backfill_days, updated_at
    FROM derived_settings WHERE user_id = ${userId}`;
  return toView(row);
}

/**
 * Saves the settings. When the saved models differ from every version of the fact extractor, the next version is
 * created in the same transaction, inactive and pinned to them (`pinModelVersionTx`), and the answer says so in
 * `pinnedVersion`. Nothing is promoted: the owner reads `GET /api/activity-events/summary?report=eval` for it and
 * promotes it deliberately. The active version keeps the models it was pinned to.
 */
export async function saveDerivedSettings(sql: PoolSql, patch: DerivedSettingsPatch): Promise<DerivedSettingsSaved> {
  const userId = await ensureUser(sql);
  return sql.begin(async (tx) => {
    // Make the row exist first (a no-op when it does), so the FOR UPDATE below always has a row to lock and two first
    // saves take turns instead of both seeing "no row" and the later overwriting the earlier's field.
    await tx`INSERT INTO derived_settings (user_id) VALUES (${userId}) ON CONFLICT (user_id) DO NOTHING`;
    const [current] = await tx<SettingsRow[]>`
      SELECT ollama_url, t2_model, t3_model, t3_daily_message_cap, t3_daily_token_cap, backfill_days, updated_at
      FROM derived_settings WHERE user_id = ${userId} FOR UPDATE`;
    const held = toView(current);
    const next = {
      ollamaUrl: patch.ollamaUrl === undefined ? held.ollamaUrl : patch.ollamaUrl,
      t2Model: patch.t2Model === undefined ? held.t2Model : patch.t2Model,
      t3Model: patch.t3Model === undefined ? held.t3Model : patch.t3Model,
      t3DailyMessageCap: patch.t3DailyMessageCap ?? held.t3DailyMessageCap,
      t3DailyTokenCap: patch.t3DailyTokenCap ?? held.t3DailyTokenCap,
      backfillDays: patch.backfillDays ?? held.backfillDays
    };
    const [saved] = await tx<SettingsRow[]>`
      UPDATE derived_settings SET
        ollama_url = ${next.ollamaUrl}, t2_model = ${next.t2Model}, t3_model = ${next.t3Model},
        t3_daily_message_cap = ${next.t3DailyMessageCap}, t3_daily_token_cap = ${next.t3DailyTokenCap},
        backfill_days = ${next.backfillDays}, updated_at = now()
      WHERE user_id = ${userId}
      RETURNING ollama_url, t2_model, t3_model, t3_daily_message_cap, t3_daily_token_cap, backfill_days, updated_at`;
    const view = toView(saved);
    // A version needs the local host and model both (the same rule as the extractor's `notConfigured`).
    if (!view[LOCAL_ADDRESS_FIELD] || !view.t2Model) return view;
    const outcome = await pinModelVersionTx(tx, userId, FACT_LLM, {
      t2: { id: view.t2Model, digest: null },
      t3: view.t3Model ? { id: view.t3Model } : null
    });
    if (outcome.action !== "created" && outcome.action !== "repinned") return view;
    const hosted = view.t3Model ? ` and hosted model ${view.t3Model}` : " and no hosted model";
    return {
      ...view,
      pinnedVersion: {
        extractor: FACT_LLM,
        version: outcome.version,
        action: outcome.action,
        note:
          outcome.action === "created"
            ? `Saving a different model made version ${outcome.version} of ${FACT_LLM}, pinned to local model ${view.t2Model}${hosted}. It starts INACTIVE: it shadow-reads your labelled messages and new mail, and nothing reads its facts. Compare it in GET /api/activity-events/summary?report=eval, then promote it deliberately (promoteExtractorVersion). The active version keeps the models it was pinned to.`
            : `Version ${outcome.version} of ${FACT_LLM} had not run yet, so it is now pinned to local model ${view.t2Model}${hosted} instead. It is still inactive; promote it deliberately after reading GET /api/activity-events/summary?report=eval.`
      }
    };
  });
}
