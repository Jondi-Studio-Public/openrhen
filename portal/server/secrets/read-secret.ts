import { type SecretName } from "@openrhen/contracts";
import type { Sql } from "@/server/persistence/postgres/sql-pool";
import { decryptSecret, loadMasterKey } from "./secrets-crypto";

/**
 * Reads a saved secret's plaintext, for one purpose: handing it to the outbound proxy in a request body. The
 * structure check (`scripts/repository/secret-reader-rule.mjs`) lets only the proxy-call helper import this file, so
 * no route, page, log line or agent tool can reach a value. Callers must not store, log or return what it gives.
 *
 * - `ok`: the value.
 * - `unset`: nothing saved.
 * - `unreadable`: saved, but the master key is missing or wrong, or the row was altered. The person must enter it again.
 */
export type SecretRead = { kind: "ok"; value: string } | { kind: "unset" } | { kind: "unreadable" };

export async function readSecret(
  sql: Sql,
  userId: string,
  name: SecretName,
  env: Record<string, string | undefined> = process.env
): Promise<SecretRead> {
  const [row] = await sql<{ ciphertext: string; nonce: string; key_version: number }[]>`
    SELECT ciphertext, nonce, key_version FROM app_secrets WHERE user_id = ${userId} AND name = ${name}
  `;
  if (!row) return { kind: "unset" };
  const master = loadMasterKey(env);
  if (master.status !== "ok") return { kind: "unreadable" };
  const opened = decryptSecret(
    master.key,
    { userId, name, keyVersion: row.key_version },
    { ciphertext: row.ciphertext, nonce: row.nonce }
  );
  return opened.kind === "ok" ? { kind: "ok", value: opened.value } : { kind: "unreadable" };
}
