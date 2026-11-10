# Auth per seam

Who may call what, and where each secret lives. Under the default `OPENRHEN_OWNER_AUTH=off` trust is the network boundary; the table is about `require`. Setup steps are in [Locking down the API](../operations/locking-down.md).

| Seam | Credential | Where it lives |
|---|---|---|
| Engine wire | A bearer token in the `Authorization` header, compared in constant time. A missing or wrong token is `401 unauthorised`. | `PLAN_FORECAST_SERVICE_TOKEN`, held by the portal and worker and by the engine service |
| Portal API, agent surface (CLI, MCP) | An owner credential, or a scoped agent token | Owner: browser cookie or owner token. Agent: shown once at creation |
| Connections | None from the portal's side beyond the proxy bearer token. Third-party secrets are read by the connection from the proxy's environment | `OUTBOUND_PROXY_TOKEN` (portal to proxy); each connection's own variables, named in its manifest, in the proxy's environment only |
| Worker routes | A route-specific worker token | Worker environment |

## Adding a phone (device sign-in)

A signed-in owner adds a phone from Settings > Sign-in and devices: **Add a phone** shows a QR (`POST /api/owner/devices/pairings`) that holds the portal's public origin and a one-time secret good for ten minutes. The origin is `PORTAL_PUBLIC_URL`, or an https address the owner types for that one QR; it must pass the portal's host check and is never read from the request's Host header. The phone sends the secret to `POST /api/owner/devices/redeem` with a name, a lowercase `installId` and a `platform`, and gets back `{ token, credential }`: a kind-`token` owner credential that is **limited**. **Enter a code** is the fallback for a phone with no signed-in screen: the phone calls `POST /api/owner/devices/code`, shows the 8-letter code, and the owner types it on the approval page (`POST /api/owner/devices/code/approve`, never a link); the phone polls `POST /api/owner/devices/code/token`, which answers with RFC 8628's error names (`authorization_pending`, `slow_down`, `expired_token`, `access_denied`, HTTP 400) until it hands over the same `{ token, credential }` once. Codes and secrets are single use, and unrecognised guesses are throttled per address.

A limited credential is refused the `owner-admin` routes (`ownerAdminRoutes()` in `platform/contracts/src/agent-routes.ts`): enrolling a browser, minting or revoking credentials and agent tokens (it may revoke only itself), pairing and approving devices, consent for a remote agent, saved passwords and keys, connection setup and purging a source. Every other classified route is open to it, planning writes included, and a route nothing classifies is refused. This holds only under `OPENRHEN_OWNER_AUTH=require`; under `off` and `shadow` no credential is checked, so the limit protects nothing (the Devices page says so). `POST /api/owner/web-session` trades the device's header token for a cookie session for its web view: a child of the device credential that inherits `limited`, is revoked with it, does not count toward the browser cap, needs no `Origin`, and is reused (its secret rotated) on each launch. Pairings, redemptions, approvals and revokes are recorded in `owner_credential_events` and listed on the Devices page; each credential also keeps the address it was last used from.

## Getting an agent token

```text
rhen agent-token create --name my-tool --scopes read:plan,propose:capture
```

Scopes have the form `<verb>:<resource>[:<qualifier>]`; `write` also covers `propose`, and a token that only holds `propose` files its change in the Inbox for the owner. A missing scope is a `403` naming it; an unknown, revoked or expired token is `401`. Revoke with `rhen agent-token revoke`. The vocabulary is in `platform/contracts/src/agent-scopes.ts`.

## Connection secrets stay in the host

A connection reads operator-configured credentials from the `env` passed to `create` and never logs or returns them. The one exception is a key the person typed into Settings > Passwords and keys: the portal holds it sealed, and the single helper that decrypts it puts it in the body of the proxy call that needs it (`credentialSource: "request"`). No agent route or tool exposes a saved key or the list of them: `GET /api/settings/secrets`, `PUT` and `DELETE /api/settings/secrets/[name]` and `POST /api/review/watch-history/lengths` are owner-only, so an agent token gets `403`, and none appears in the tool manifest. Saving a key needs `OPENRHEN_OWNER_AUTH=require` and `OPENRHEN_SECRETS_KEY`; otherwise the write is refused with `409` and the message says what to set. Keep owner tokens out of any place an agent or automation runs.
