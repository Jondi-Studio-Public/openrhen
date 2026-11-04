/**
 * Response headers every page and API response of the portal carries (C6). The portal has no login by
 * decision, and its origin holds an owner secret for the length of a tab (K5), so a page that
 * could be framed or made to load a plugin, or a stray `<base>`, would be a way to act as the owner.
 *
 * Only the directives that cannot break a page are set here: `frame-ancestors 'none'` stops any site
 * framing the portal (clickjacking a People action), `object-src 'none'` blocks plugins, `base-uri 'none'`
 * stops an injected `<base>` retargeting relative URLs. `default-src` and `script-src` are deliberately
 * left out: the framework streams inline scripts for hydration that need per-request nonces, which no
 * header here can supply. A separate portal, which renders its own HTML, carries the strict
 * `default-src 'none'` policy (its own server).
 */
export const PORTAL_CONTENT_SECURITY_POLICY = "frame-ancestors 'none'; object-src 'none'; base-uri 'none'";

export function portalSecurityHeaders() {
  return [
    {
      source: "/(.*)",
      headers: [
        { key: "Content-Security-Policy", value: PORTAL_CONTENT_SECURITY_POLICY },
        // Older browsers read this instead of `frame-ancestors`.
        { key: "X-Frame-Options", value: "DENY" }
      ]
    }
  ];
}
