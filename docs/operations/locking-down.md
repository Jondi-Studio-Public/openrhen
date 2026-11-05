# Locking down the API

You need this when you want to reach OpenRhen from another device, or give a tool or agent access.

With `OPENRHEN_OWNER_AUTH=off` (the default) the portal trusts its network, which is only safe when it listens on loopback. Before reaching it from other devices, switch to `require`.

Under `require`, every API call needs one of: an owner credential (a signed-in browser's cookie, or an owner token in the `X-OpenRhen-Owner` header), a scoped agent token, or the route's own token (the worker's `X-OpenRhen-Worker` token on the few routes only it calls).

## Steps

1. **Make the secrets.** Run `node scripts/setup/init-env.mjs --lockdown` (with Docker: `docker compose run --rm setup node scripts/setup/init-env.mjs --docker --lockdown`). It adds the worker token pair and an owner recovery token to `.env`. The plain recovery token is written to `var/owner-recovery-token.txt` and only the path is printed; store the token somewhere safe, then delete the file. A pair that already exists is skipped, so a rerun changes nothing.
2. **Check the service tokens.** `PLAN_FORECAST_SERVICE_TOKEN` and `OUTBOUND_PROXY_TOKEN` must be real values; the planning service refuses to start on the placeholder once `require` is set. `setup` generates them.
3. **Narrow the network.** Set `PORTAL_ALLOWED_HOSTS` to the host names you serve (unset, the portal accepts only localhost, the service name and `PORTAL_PUBLIC_URL`), and restrict the published port to the machines that need it. Ports published by Docker bypass many host firewalls, so use a rule that applies to Docker traffic, or bind to a specific address with `PORTAL_HOST_IP`.
4. **Revoke what was minted while sign-in was off.** Under `off`, anyone who could reach the portal could make an owner token, and those never expire; they keep working under `require`. Run `rhen owner-token list`, revoke every credential you did not create yourself (`rhen owner-token revoke <label-or-id>`), and check `rhen agent-token list` the same way.
5. **Deploy with `off`, then flip.** Start the stack with the new secrets while still `off`, confirm it works, then set `OPENRHEN_OWNER_AUTH=require` and run `docker compose up -d`.
6. **Sign in.** Every browser now shows a Sign in page. Paste your recovery token (or another owner token you created with `rhen owner-token create --label laptop`) once; that browser keeps a cookie. Do the same on each device. Keep owner tokens out of any place an agent or automation runs.

## Rollback

Set `OPENRHEN_OWNER_AUTH=off` and redeploy. If you are locked out of every browser, the Sign in page also accepts the recovery token.

## What still answers without an owner credential

A few routes check their own secret instead: sign-in and session, the phone location ping ([Location ping](location-ping.md)), the MCP endpoint and its OAuth routes (which grant nothing without an owner credential). Everything else is refused.

## Agent tokens

For tools and AI clients, create a scoped token instead of sharing an owner credential. Creating, scoping and revoking them is described in [Auth](../protocol/auth.md#getting-an-agent-token).
