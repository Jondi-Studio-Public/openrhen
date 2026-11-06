import { secretsRefusalMessage } from "@openrhen/contracts";
import { ownerAuthMode } from "@/server/owner-auth";
import { loadMasterKey, type MasterKey } from "./secrets-crypto";

/**
 * Whether a key may be saved or removed right now. Both must hold: a master key to seal under (otherwise there is no
 * encryption, and there is no plaintext fallback) and owner sign-in on (otherwise anyone who can reach the address
 * could replace or delete a key). The refusal text says exactly what to set.
 */
export interface SecretsPolicy {
  master: MasterKey;
  masterKeyConfigured: boolean;
  ownerAuthRequired: boolean;
  canWrite: boolean;
  /** Empty when `canWrite`. */
  refusal: string;
}

export function secretsPolicy(): SecretsPolicy {
  const master = loadMasterKey(process.env);
  const masterKeyConfigured = master.status === "ok";
  const ownerAuthRequired = ownerAuthMode() === "require";
  const refusal =
    secretsRefusalMessage({ masterKeyConfigured, ownerAuthRequired }) +
    (master.status === "invalid" ? ` ${master.reason}` : "");
  return {
    master,
    masterKeyConfigured,
    ownerAuthRequired,
    canWrite: masterKeyConfigured && ownerAuthRequired,
    refusal: masterKeyConfigured && ownerAuthRequired ? "" : refusal
  };
}
