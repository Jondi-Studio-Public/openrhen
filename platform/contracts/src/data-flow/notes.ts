import type { DatasetNote } from "./types.js";

const infrastructure = (table: string, why: string): DatasetNote => ({ ref: `pg:${table}`, infrastructure: why });

/** Tables that are machinery, not data about the person's life, and the one that is dead. */
export const CORE_DATASET_NOTES: readonly DatasetNote[] = [
  infrastructure("writes", "change ledger for plan writes"),
  infrastructure("write_rows", "row-level change ledger"),
  infrastructure("jobs", "recalculation job queue"),
  infrastructure("app_secrets", "saved provider keys"),
  infrastructure("agent_tokens", "agent credentials"),
  infrastructure("agent_access_tokens", "remote agent access credentials"),
  infrastructure("owner_credentials", "owner sign-in credentials"),
  infrastructure("oauth_clients", "remote agent sign-in registrations"),
  infrastructure("oauth_authorization_codes", "remote agent sign-in codes"),
  infrastructure("oauth_refresh_tokens", "remote agent sign-in tokens"),
  infrastructure("provider_call_telemetry", "outbound call counts"),
  infrastructure("integration_sync_runs", "sync run history"),
  infrastructure("agent_wakes", "queue of wakes to send"),
  infrastructure("derived_settings", "the owner's mail-understanding settings, read by the model tier when it lands"),
  infrastructure(
    "derived_model_calls",
    "audit of mail-understanding model calls; its writer lands with the model tier"
  ),
  infrastructure("activity_source_state", "per-source content gate and retention settings"),
  infrastructure("consequence_comparisons", "learning data for the consequence model refits"),
  infrastructure("consequence_groups_issued", "learning data for the consequence model refits"),
  infrastructure("travel_lookup_budget", "daily lookup spend counter"),
  infrastructure("youtube_quota_use", "daily quota counter"),
  infrastructure("plan_shadow_log", "shadow-mode comparison log"),
  { ref: "pg:photo_checkin_stage", dead: "no writer and no reader" }
];
