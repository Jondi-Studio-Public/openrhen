# Auth per seam

Who may call what, and where each secret lives. Under the default `OPENRHEN_OWNER_AUTH=off` trust is the network boundary; the table is about `require`. Setup steps are in [Locking down the API](../operations/locking-down.md).

| Seam | Credential | Where it lives |
|---|---|---|
| Engine wire | A bearer token in the `Authorization` header, compared in constant time. A missing or wrong token is `401 unauthorised`. | `PLAN_FORECAST_SERVICE_TOKEN`, held by the portal and worker and by the engine service |
| Portal API, agent surface (CLI, MCP) | An owner credential, or a scoped agent token | Owner: browser cookie or owner token. Agent: shown once at creation |
| Connections | None from the portal's side beyond the proxy bearer token. Third-party secrets are read by the connection from the proxy's environment | `OUTBOUND_PROXY_TOKEN` (portal to proxy); each connection's own variables, named in its manifest, in the proxy's environment only |
| Worker routes | A route-specific worker token | Worker environment |

## Getting an agent token

```text
rhen agent-token create --name my-tool --scopes read:plan,propose:capture
```

Scopes have the form `<verb>:<resource>[:<qualifier>]`; `write` also covers `propose`, and a token that only holds `propose` files its change in the Inbox for the owner. A missing scope is a `403` naming it; an unknown, revoked or expired token is `401`. Revoke with `rhen agent-token revoke`. The vocabulary is in `platform/contracts/src/agent-scopes.ts`.

## Connection secrets stay in the host

A connection never receives a credential from a caller, and the portal never holds one. A connection author reads secrets from the `env` passed to `create` and never logs or returns them. Keep owner tokens out of any place an agent or automation runs.
