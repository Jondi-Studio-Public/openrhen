import { z } from "zod";

/**
 * Passwords and keys the person enters in the web app: the names allowed, the write-only request, and the status
 * answer. A value goes in and never comes back; no response, log line or agent route carries one. Stored encrypted
 * with `OPENRHEN_SECRETS_KEY` (portal only) and read only by the proxy-call helper.
 */

/** Every secret the app can hold. A new one is added here and nowhere else decides what may be stored. */
export const SECRET_NAMES = ["youtube_data_api_key", "hosted_model_api_key"] as const;
export type SecretName = (typeof SECRET_NAMES)[number];

export const secretNameSchema = z.enum(SECRET_NAMES);

/** What each secret is for, shown on the Passwords and keys page. */
export const SECRET_LABELS: Record<SecretName, { label: string; help: string }> = {
  youtube_data_api_key: {
    label: "YouTube Data API key",
    help: "Lets Review look up how long your watched videos are. Create a key for the YouTube Data API v3 in the Google Cloud console."
  },
  hosted_model_api_key: {
    label: "Hosted model API key",
    help: "Lets mail understanding send the few messages the local model cannot read to the hosted model provider chosen for it, within the daily caps set in Settings > Mail understanding. Mail understanding reads the key from here only and ignores any provider key set as an environment variable. A restore from a backup empties it, so enter it again afterwards."
  }
};

/** The longest value accepted; real API keys are well under a hundred characters. */
export const SECRET_MAX_LENGTH = 2048;

export const putSecretSchema = z.object({ value: z.string().trim().min(1).max(SECRET_MAX_LENGTH) }).strict();
export type PutSecret = z.infer<typeof putSecretSchema>;

/** `unset`: nothing saved. `set`: saved and readable. `unreadable`: saved, but this build's master key cannot open it. */
export const secretStateSchema = z.enum(["set", "unreadable", "unset"]);
export type SecretState = z.infer<typeof secretStateSchema>;

export const secretStatusSchema = z.object({
  name: secretNameSchema,
  isSet: z.boolean(),
  updatedAt: z.string().nullable(),
  state: secretStateSchema
});
export type SecretStatus = z.infer<typeof secretStatusSchema>;

export const secretStatusResponseSchema = z.object({
  /** Whether `OPENRHEN_SECRETS_KEY` is set to 32 random bytes (base64) in the portal's environment. */
  masterKeyConfigured: z.boolean(),
  /** Whether `OPENRHEN_OWNER_AUTH` is `require`. */
  ownerAuthRequired: z.boolean(),
  /** Both of the above: only then can a key be saved or removed. */
  canWrite: z.boolean(),
  secrets: z.array(secretStatusSchema)
});
export type SecretStatusResponse = z.infer<typeof secretStatusResponseSchema>;

/**
 * The message a write gets when it cannot be accepted: it names each missing setting and the exact way to set it,
 * so neither a person nor an agent has to guess. Returns an empty string when nothing is missing.
 */
export function secretsRefusalMessage(state: { masterKeyConfigured: boolean; ownerAuthRequired: boolean }): string {
  const steps: string[] = [];
  if (!state.masterKeyConfigured)
    steps.push(
      "OPENRHEN_SECRETS_KEY is not set. It must be 32 random bytes, base64 encoded, in the portal's environment (the .env file next to compose.yaml). " +
        "Run `node scripts/setup/init-env.mjs` (it generates one and never overwrites an existing value), or make one yourself with `openssl rand -base64 32`, " +
        "put OPENRHEN_SECRETS_KEY=<that value> in .env, then restart the portal (`docker compose up -d portal`). Set it once and keep it: " +
        "if it changes, saved keys become unreadable and must be entered again."
    );
  if (!state.ownerAuthRequired)
    steps.push(
      "OPENRHEN_OWNER_AUTH is not `require`. Without sign-in anyone who can reach this address could replace or remove a saved key. " +
        "Run `node scripts/setup/init-env.mjs --lockdown` to make the recovery token, set OPENRHEN_OWNER_AUTH=require in .env, " +
        "restart the portal, and sign in with the recovery token (see docs/operations/locking-down.md)."
    );
  return steps.length === 0 ? "" : `Passwords and keys cannot be saved yet. ${steps.join(" ")}`;
}
