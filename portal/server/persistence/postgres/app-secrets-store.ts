import { SECRET_NAMES, type SecretName, type SecretStatus } from "@openrhen/contracts";
import { CURRENT_KEY_VERSION, decryptSecret, encryptSecret, type MasterKey } from "@/server/secrets/secrets-crypto";
import type { Sql } from "./sql-pool";

/**
 * The write side of Settings, Passwords and keys, and the status read. A value goes in sealed and is never returned:
 * `secretStatuses` opens each row only to learn whether this build's master key can, and throws the plaintext away.
 * Reading a value for use lives in `@/server/secrets/read-secret`, which only the proxy-call helper may import.
 * Rows are in `REGENERABLE_TABLES`, so no backup carries them.
 */

/** Seals `value` for `name` and stores it, replacing any earlier one. Returns when it was saved. */
export async function putSecret(
  sql: Sql,
  userId: string,
  name: SecretName,
  value: string,
  master: Extract<MasterKey, { status: "ok" }>
): Promise<{ updatedAt: Date }> {
  const sealed = encryptSecret(master.key, { userId, name, keyVersion: CURRENT_KEY_VERSION }, value);
  const [row] = await sql<{ updated_at: Date }[]>`
    INSERT INTO app_secrets (user_id, name, ciphertext, nonce, key_version, updated_at)
    VALUES (${userId}, ${name}, ${sealed.ciphertext}, ${sealed.nonce}, ${CURRENT_KEY_VERSION}, now())
    ON CONFLICT (user_id, name) DO UPDATE
      SET ciphertext = EXCLUDED.ciphertext, nonce = EXCLUDED.nonce, key_version = EXCLUDED.key_version, updated_at = now()
    RETURNING updated_at
  `;
  return { updatedAt: row!.updated_at };
}

/** Removes a saved secret. False when there was none. */
export async function deleteSecret(sql: Sql, userId: string, name: SecretName): Promise<boolean> {
  const removed = await sql`DELETE FROM app_secrets WHERE user_id = ${userId} AND name = ${name} RETURNING name`;
  return removed.length > 0;
}

/** One status per allowed name: unset, set (and readable), or saved but unreadable. Never a value. */
export async function secretStatuses(sql: Sql, userId: string, master: MasterKey): Promise<SecretStatus[]> {
  const rows = await sql<
    { name: string; ciphertext: string; nonce: string; key_version: number; updated_at: Date }[]
  >`SELECT name, ciphertext, nonce, key_version, updated_at FROM app_secrets WHERE user_id = ${userId}`;
  const byName = new Map(rows.map((row) => [row.name, row]));
  return SECRET_NAMES.map((name) => {
    const row = byName.get(name);
    if (!row) return { name, isSet: false, updatedAt: null, state: "unset" as const };
    const opened =
      master.status === "ok"
        ? decryptSecret(
            master.key,
            { userId, name, keyVersion: row.key_version },
            { ciphertext: row.ciphertext, nonce: row.nonce }
          )
        : ({ kind: "unreadable" } as const);
    return {
      name,
      isSet: true,
      updatedAt: row.updated_at.toISOString(),
      state: opened.kind === "ok" ? ("set" as const) : ("unreadable" as const)
    };
  });
}
