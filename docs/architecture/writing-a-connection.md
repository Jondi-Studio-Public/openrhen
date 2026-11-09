# Writing a connection

A connection is how OpenRhen talks to an outside service: a calendar, a routing provider, a language model, a status endpoint. Connections live in the outbound proxy so that their credentials never reach the portal.

## Capabilities

A connection declares one or more capabilities, each with a fixed set of operations (`platform/contracts/src/connections/capabilities.ts`):

| Capability | Operations | What it is for |
|---|---|---|
| `calendar_source` | `proof`, `list_calendars`, `read_events` | Reading events into the Inbox for review |
| `calendar_sink` | `status`, `create`, `update`, `remove`, `write_proof` | Publishing confirmed commitments out |
| `travel_time` | `matrix` | Journey durations |
| `geocoding` | `geocode` | Turning a place name into coordinates |
| `model_provider` | `extract`, `stream`, `embed`, `complete`, `probe` | Language-model calls (`complete`: one plain chat completion, from DeepInfra with the typed key or from Ollama on your own machine) |
| `status_publish` | `config`, `publish` | Sending a redacted on-plan/off-plan reading to an endpoint you run |
| `video_metadata` | `durations` | Video lengths for watch history (YouTube Data API) |

The host serves each operation at `POST /capabilities/<capability>/<connection id>/<operation>` and lists installed connections at `GET /connections`.

## The manifest

Every connection has a manifest, validated by `connectionManifestSchema`:

- `id` and `label`.
- `capabilities`, and optionally `ops` to declare only some of a capability's operations.
- `secrets.anyOf`: groups of environment variable names; the connection is configured when every name in at least one group is set. Use several groups for alternative sign-in methods.
- `credentialSource`: `env` (the default) reads the credential from the proxy's environment. `request` is for a key the person typed into the app: `secrets.anyOf` is empty, the connection is always ready, and each call carries the key in its body (`youtube_data` does: `body.apiKey`). Such a connection sends the key to the provider in a header only, never in a URL, returns only fixed failure messages (a thrown error can quote a header), and logs nothing that could hold it.
- `config`: other environment variables, each `required` or not, with an optional default.
- `telemetryName`: the name used in the Connections page's call statistics.
- `calendarSource` (required exactly when the connection has `calendar_source`): the `role`, the `sourceType` written on imported records, the `diffProfile` that decides how events are compared, which failures count as a sign-in problem, and the `schedule`, either an interval or a daily local time, each read from an environment variable with a default.

The portal and worker learn about a connection from its manifest, so a new calendar source needs no portal code for scheduling or for its Connections row.

## The implementation

An implementation is a `BoundConnection`: its manifest plus a `create(env)` function returning, for each capability, an object of operations. Each operation is either a JSON operation or a stream operation:

```ts
export const exampleConnection: BoundConnection = {
  manifest,
  create: (env) => ({
    geocoding: {
      geocode: {
        kind: "json",
        async run(call) {
          const key = env.EXAMPLE_API_KEY;
          if (!key) return { status: 400, body: { error: "EXAMPLE_API_KEY is not configured." } };
          const response = await call.fetch(`https://api.example.test/geocode`, { signal: call.signal });
          return { status: 200, body: await response.json() };
        }
      }
    }
  })
};
```

Rules an operation follows:

- Use `call.fetch` and `call.signal`, so a client disconnect or timeout cancels the upstream request and the host can record timing.
- Read secrets from the `env` passed to `create` (or, for `credentialSource: "request"`, from the call's body). Never log or return one, and never include a thrown error's message in a response: scrub it.
- A failure returns a status of 400 or more with a body that matches `capabilityFailureSchema`, so the portal can show a safe, specific reason.
- Return a real, specific error for a missing configuration; do not throw.
- Set `rate` (`"ai"`, `"embedding"`, `"local"` for a model on the person's own machine, `"hosted"` for a paid provider keyed from the body) on operations that should use the host's rate limiter, and `timeoutMs` on one that legitimately runs past the default 60 seconds (Ollama: 190 s, with its own 180 s clock inside, so it answers `timeout` itself).

## `model_provider.complete`

Both providers take `{model, messages: [{role, content}], maxTokens?, temperature?, format?}` (`format` is `"json"` or a JSON schema) and answer `{outcome: "ok", text, model, tokensIn, tokensOut}` or `{outcome, message}` with `outcome` one of `unreachable | timeout | bad_output | rate_limited | bad_key` (HTTP 502, 504, 502, 429, 502). Each `message` names the fix. Ollama adds `baseUrl` (and `withDigest` to read the model digest from `/api/tags`); DeepInfra adds `apiKey` (and the model id must be `org/name`). Messages are capped at 16, 96,000 characters and 4,096 output tokens; a reply is read to 1 MiB. Nothing is logged: the proxy's request log carries the path only, and no message text, model output or key goes into an outcome or error. A 5xx other than 502, 503 and 504, an empty, truncated or non-JSON reply (when `format` was set) and a reply over the cap are `bad_output`; a host that cannot be reached, a missing model and a redirect are `unreachable`.

Ollama also takes `withDigest`: the model's digest from `GET /api/tags` (`models[].digest`, matched on `name` or `model`, with and without `:latest`), or `null` when it is not listed. Only one call runs at a time per proxy; two more may wait, and a further one is answered `rate_limited`. Time spent waiting counts against the 180 s clock.

The Ollama address is the opposite of the calendar-feed guard (`connections/ollama/guard.ts`): the proxy sits beside `postgres` and `engine-service`, so a typed address may reach only the person's LAN or tailnet.

- Only an IP literal is accepted (`http://192.168.1.20:11434`); host names are refused, so there is no lookup to rebind and no compose service name to resolve. Text form is matched strictly first: `http://IP[:port]` only, no login, path, query or fragment, no https. Decimal, hex, octal and short IPv4 spellings, IPv6 zone ids and trailing dots are refused.
- Only port 11434 (the default when omitted) is open. An operator adds more with `OUTBOUND_OLLAMA_EXTRA_PORTS` (comma list, each 1024 to 65535), validated at start: a malformed value fails the connection to load and logs why. A static list of ports the stack and host use (4100, 4200, 5432, 8787, 55432 and common services) is refused even then. One open port keeps the outcome messages from working as a port scanner.
- Only 10/8, 172.16/12, 192.168/16, 100.64/10 (tailnet) and fc00::/7 are allowed. Loopback, link-local, the metadata addresses (169.254.169.254, 100.100.100.200, fd00:ec2::/32), every public address and every subnet of the proxy's own interfaces (read at start; this is where `postgres`, `engine-service` and the host gateway are) are denied. IPv4-mapped IPv6 is judged as the IPv4.
- Accepted limits: 100.64/10 is allowed because tailnets use it, so the guard cannot see other internal CGNAT services on a cloud host. The allowed private ranges include the Docker host's own LAN address, where its published ports listen, which is why the port is restricted to Ollama's.
- Redirects are refused and never followed, the only paths are `/api/chat` (POST) and `/api/tags` (GET), and the connection uses a private HTTP agent so no proxy setting can reroute it. A server that answers an invalid HTTP status is `bad_output`.

## Registering and testing

1. Add the manifest to the connection registry in `platform/contracts/src/connections/builtin-connections.ts`.
2. Put your code in `integrations/outbound-proxy/src/connections/<id>/` and bind it in the `CORE_CONNECTIONS` list in `src/host/bundled-connections.ts`, or keep it out of the core by registering it from a drop-in: a folder `src/drop-ins/<id>/register.ts` that calls `registerConnection` (`src/host/connection-registry.ts`) is loaded at start, and the proxy builds and runs without it. A connection may import only `platform/contracts`, its own folder and the host's `connection-api`, `http`, `cookie-jar`, `ip-address` and `model-complete`; `structure:check` enforces it.
3. Write a `connection.test.ts` next to it with a fake `fetch`.
4. Run the conformance test (`src/host/conformance.test.ts`). It checks that every registered manifest is bound exactly once, that each connection implements exactly its declared capabilities and operations, and that every operation answers an empty body, an empty environment and a failing network without throwing and with a well-formed failure.
5. Document the environment variables in `.env.example` and the user-visible behaviour in [Settings and connections](../product/settings-and-connections.md).
6. Add the connection's entry to the [data-flow registry](data-flow-registry.md), so where its data goes is recorded and checked.

## Design guidance

- Treat everything a service returns as untrusted input. Calendar events, messages and model output become proposals that wait in the Inbox; a connection never writes planning records directly.
- Prefer reading to writing. If a connection can change something outside the app, make the write opt-in and bound the damage (for example, require approval when a sync would delete more than a set number of items).
- Do not add a connection that needs a scraped or unofficial interface unless you are prepared to maintain it when the interface changes.
- Keep provider-specific wording out of core code. Core talks in capabilities; the provider's name appears only in its manifest and folder.
