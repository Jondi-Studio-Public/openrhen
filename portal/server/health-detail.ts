import { AGENT_TOKEN_HEADER } from "./agent-tokens";
import { ownerAuthMode, verifyOwnerCredential } from "./owner-auth";

/**
 * Whether a health caller may see more than ok / not ok. With owner auth `off` everyone does (unchanged). Under
 * `shadow` or `require` only a caller with a credential does: `withRoute` has already refused an invalid agent
 * token, so a non-empty one here is valid; an owner credential is checked again. The health routes stay open to
 * anonymous callers because the container healthcheck and the deploy gate poll them with no credential.
 */
export async function detailedHealth(request: Request): Promise<boolean> {
  if (ownerAuthMode() === "off") return true;
  if (request.headers.get(AGENT_TOKEN_HEADER)?.trim()) return true;
  return (await verifyOwnerCredential(request)).kind === "ok";
}
