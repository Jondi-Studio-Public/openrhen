import { portalHostAllowed, portalPublicUrl } from "@/server/security/allowed-hosts";

/**
 * The origin a QR tells a phone to use. It comes from `PORTAL_PUBLIC_URL` when that is set, otherwise from the https
 * address the owner typed on the Devices page for that one QR (nothing is stored). It never comes from the request's
 * Host header, which a caller can choose. Either way it must be an https address a phone could reach, and its host
 * must pass the portal's own host check, so a QR is never shown that the phone could not use.
 */
export type PairingOrigin =
  { ok: true; origin: string; host: string } | { ok: false; status: 400 | 422; error: string; needsOrigin?: true };

const LOOPBACK = /^(localhost|.*\.localhost)$/i;

function unusableHost(hostname: string): string | null {
  const bare = hostname.replace(/^\[|\]$/g, "").replace(/\.+$/, "");
  if (LOOPBACK.test(bare)) return "localhost is only reachable from this computer";
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(bare) || bare.includes(":"))
    return "a bare IP address cannot carry an https certificate a phone will accept";
  if (!bare.includes(".")) return "a single-word host name is only reachable from inside the server's own network";
  return null;
}

/** Judges one candidate address. `source` names the setting in the message. */
function judge(raw: string, source: string): PairingOrigin {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, status: 400, error: `${source} is not a web address.` };
  }
  if (url.protocol !== "https:")
    return {
      ok: false,
      status: 422,
      error: `${source} must be an https address; a phone will not connect to ${url.protocol.replace(":", "")} here. Serve the portal over https and use that address.`
    };
  if (url.username || url.password || (url.pathname !== "/" && url.pathname !== "") || url.search || url.hash)
    return { ok: false, status: 400, error: `${source} must be just the address, such as https://portal.example.com.` };
  const unusable = unusableHost(url.hostname);
  if (unusable) return { ok: false, status: 422, error: `${url.host} cannot be used for a phone: ${unusable}.` };
  if (!portalHostAllowed(url.host))
    return {
      ok: false,
      status: 422,
      error: `The portal does not accept requests for ${url.host}. Add it to PORTAL_ALLOWED_HOSTS (or set PORTAL_PUBLIC_URL to it), then try again.`
    };
  return { ok: true, origin: url.origin, host: url.host };
}

export function pairingOrigin(typed: string | undefined): PairingOrigin {
  const configured = portalPublicUrl();
  if (configured) return judge(configured, "PORTAL_PUBLIC_URL");
  if (!typed?.trim())
    return {
      ok: false,
      status: 422,
      needsOrigin: true,
      error: "Type the https address your phone will use to reach this portal (or set PORTAL_PUBLIC_URL)."
    };
  return judge(typed.trim(), "That address");
}
