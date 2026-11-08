import {
  DERIVED_SETTINGS_DEFAULTS,
  type DerivedSettings,
  type DerivedSettingsPatch
} from "@/server/derived/derived-settings";
import { ensureUser } from "./ensure-user";
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

export async function readDerivedSettings(sql: PoolSql): Promise<DerivedSettingsView> {
  const userId = await ensureUser(sql);
  const [row] = await sql<SettingsRow[]>`
    SELECT ollama_url, t2_model, t3_model, t3_daily_message_cap, t3_daily_token_cap, backfill_days, updated_at
    FROM derived_settings WHERE user_id = ${userId}`;
  return toView(row);
}

export async function saveDerivedSettings(sql: PoolSql, patch: DerivedSettingsPatch): Promise<DerivedSettingsView> {
  const userId = await ensureUser(sql);
  return sql.begin(async (tx) => {
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
      INSERT INTO derived_settings
        (user_id, ollama_url, t2_model, t3_model, t3_daily_message_cap, t3_daily_token_cap, backfill_days, updated_at)
      VALUES (${userId}, ${next.ollamaUrl}, ${next.t2Model}, ${next.t3Model}, ${next.t3DailyMessageCap},
              ${next.t3DailyTokenCap}, ${next.backfillDays}, now())
      ON CONFLICT (user_id) DO UPDATE SET
        ollama_url = EXCLUDED.ollama_url, t2_model = EXCLUDED.t2_model, t3_model = EXCLUDED.t3_model,
        t3_daily_message_cap = EXCLUDED.t3_daily_message_cap, t3_daily_token_cap = EXCLUDED.t3_daily_token_cap,
        backfill_days = EXCLUDED.backfill_days, updated_at = EXCLUDED.updated_at
      RETURNING ollama_url, t2_model, t3_model, t3_daily_message_cap, t3_daily_token_cap, backfill_days, updated_at`;
    return toView(saved);
  });
}
