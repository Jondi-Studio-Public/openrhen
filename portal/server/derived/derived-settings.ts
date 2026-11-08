/**
 * Mail-understanding settings (communication understanding, slice 2b-2): the pure part. The defaults mirror the
 * settings table's column defaults and the bounds mirror its CHECK constraints (migration 0150), so a value that
 * passes here cannot be refused by the database. The store (`derived-settings-store.ts`) does the reading and writing.
 *
 * The hosted API key is deliberately not a field: it is a sealed secret saved under Settings > Passwords and keys.
 */

export interface DerivedSettings {
  ollamaUrl: string | null;
  t2Model: string | null;
  t3Model: string | null;
  t3DailyMessageCap: number;
  t3DailyTokenCap: number;
  backfillDays: number;
}

export type DerivedSettingsPatch = Partial<DerivedSettings>;

export const DERIVED_SETTINGS_DEFAULTS: DerivedSettings = {
  ollamaUrl: null,
  t2Model: null,
  t3Model: null,
  t3DailyMessageCap: 50,
  t3DailyTokenCap: 200_000,
  backfillDays: 90
};

export const DERIVED_SETTINGS_LIMITS = {
  t3DailyMessageCap: { min: 0, max: 10_000 },
  t3DailyTokenCap: { min: 0, max: 100_000_000 },
  backfillDays: { min: 1, max: 3650 }
} as const;

const OLLAMA_URL_MAX = 2048;
const MODEL_ID_MAX = 200;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/;
const FIELDS = ["ollamaUrl", "t2Model", "t3Model", "t3DailyMessageCap", "t3DailyTokenCap", "backfillDays"] as const;
const KEY_NAMES = new Set(["apiKey", "api_key", "key", "deepinfraApiKey", "deepinfra_api_key", "t3ApiKey", "token"]);

export type ParsedDerivedSettings = { ok: true; patch: DerivedSettingsPatch } | { ok: false; problems: string[] };

function parseUrl(value: unknown): { value: string | null } | { problem: string } {
  if (value === null) return { value: null };
  if (typeof value !== "string")
    return { problem: 'ollamaUrl must be text such as "http://192.168.1.20:11434", or null to clear it.' };
  const typed = value.trim();
  if (typed === "") return { value: null };
  if (typed.length > OLLAMA_URL_MAX)
    return { problem: `ollamaUrl is too long (at most ${OLLAMA_URL_MAX} characters). Send just the address and port.` };
  if (!/^https?:\/\//i.test(typed))
    return {
      problem:
        'ollamaUrl must start with http:// or https://, for example "http://192.168.1.20:11434" (an IP address and port).'
    };
  let parsed: URL;
  try {
    parsed = new URL(typed);
  } catch {
    return {
      problem: 'ollamaUrl is not a valid address. Send it as "http://192.168.1.20:11434" (scheme, IP address, port).'
    };
  }
  if (parsed.username !== "" || parsed.password !== "")
    return {
      problem:
        "ollamaUrl must not contain credentials (a user name or password before the @). Remove them and send only the address and port; the local model needs no login."
    };
  if (parsed.hostname === "") return { problem: 'ollamaUrl needs a host. Send it as "http://192.168.1.20:11434".' };
  if (
    (parsed.pathname !== "/" && parsed.pathname !== "") ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    /[?#]/.test(typed)
  )
    return {
      problem:
        'ollamaUrl must be only the address and port, with no path, query or fragment, for example "http://192.168.1.20:11434"; the paths the portal calls are fixed.'
    };
  return { value: typed.replace(/\/$/, "") };
}

function parseModel(field: "t2Model" | "t3Model", value: unknown): { value: string | null } | { problem: string } {
  if (value === null) return { value: null };
  if (typeof value !== "string")
    return { problem: `${field} must be text (a model id such as "qwen3:8b"), or null to clear it.` };
  const typed = value.trim();
  if (typed === "") return { value: null };
  if (typed.length > MODEL_ID_MAX)
    return { problem: `${field} is too long (at most ${MODEL_ID_MAX} characters). Send just the model id.` };
  if (!MODEL_ID.test(typed))
    return {
      problem: `${field} must be a model id with no spaces or control characters, using letters, digits and . _ : / @ + - (for example "qwen3:8b").`
    };
  return { value: typed };
}

function parseCount(
  field: "t3DailyMessageCap" | "t3DailyTokenCap" | "backfillDays",
  value: unknown
): { value: number } | { problem: string } {
  const { min, max } = DERIVED_SETTINGS_LIMITS[field];
  const hint = field === "backfillDays" ? "" : " Send 0 to turn hosted sends off.";
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max)
    return {
      problem: `${field} must be a whole number from ${min} to ${max} (it cannot be cleared; the default is ${DERIVED_SETTINGS_DEFAULTS[field]}).${hint}`
    };
  return { value };
}

/** Checks a PUT body. Absent fields keep their stored value; `null` or an empty string clears the text fields. */
export function parseDerivedSettingsPatch(body: unknown): ParsedDerivedSettings {
  if (body === null || typeof body !== "object" || Array.isArray(body))
    return {
      ok: false,
      problems: [`Send a JSON object with at least one of: ${FIELDS.join(", ")}.`]
    };
  const input = body as Record<string, unknown>;
  const problems: string[] = [];
  const patch: Record<string, string | number | null> = {};
  for (const key of Object.keys(input)) {
    if ((FIELDS as readonly string[]).includes(key)) continue;
    problems.push(
      KEY_NAMES.has(key)
        ? `"${key}" is not a setting here: the hosted API key is saved under Settings > Passwords and keys, never in these settings.`
        : `"${key}" is not a setting. The settings are: ${FIELDS.join(", ")}.`
    );
  }
  for (const field of FIELDS) {
    if (!(field in input) || input[field] === undefined) continue;
    const result =
      field === "ollamaUrl"
        ? parseUrl(input[field])
        : field === "t2Model" || field === "t3Model"
          ? parseModel(field, input[field])
          : parseCount(field, input[field]);
    if ("problem" in result) problems.push(result.problem);
    else patch[field] = result.value;
  }
  if (problems.length) return { ok: false, problems };
  if (Object.keys(patch).length === 0) return { ok: false, problems: [`Send at least one of: ${FIELDS.join(", ")}.`] };
  return { ok: true, patch: patch as DerivedSettingsPatch };
}
