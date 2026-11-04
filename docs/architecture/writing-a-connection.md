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
| `model_provider` | `extract`, `stream`, `embed`, `probe` | Language-model calls |
| `status_publish` | `config`, `publish` | Sending a redacted on-plan/off-plan reading to an endpoint you run |

The host serves each operation at `POST /capabilities/<capability>/<connection id>/<operation>` and lists installed connections at `GET /connections`.

## The manifest

Every connection has a manifest, validated by `connectionManifestSchema`:

- `id` and `label`.
- `capabilities`, and optionally `ops` to declare only some of a capability's operations.
- `secrets.anyOf`: groups of environment variable names; the connection is configured when every name in at least one group is set. Use several groups for alternative sign-in methods.
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
- Read secrets from the `env` passed to `create`. Never log or return one.
- A failure returns a status of 400 or more with a body that matches `capabilityFailureSchema`, so the portal can show a safe, specific reason.
- Return a real, specific error for a missing configuration; do not throw.
- Set `rate: "ai"` or `"embedding"` on operations that should use the host's rate limiter.

## Registering and testing

1. Add the manifest to the connection registry in `platform/contracts/src/connections/builtin-connections.ts`.
2. Put your code in `integrations/outbound-proxy/src/connections/<id>/` and bind it in the `CORE_CONNECTIONS` list in `src/host/bundled-connections.ts`, or keep it out of the core by registering it from a drop-in: a folder `src/drop-ins/<id>/register.ts` that calls `registerConnection` (`src/host/connection-registry.ts`) is loaded at start, and the proxy builds and runs without it. A connection may import only `platform/contracts`, its own folder and the host's `connection-api`, `http` and `cookie-jar`; `structure:check` enforces it.
3. Write a `connection.test.ts` next to it with a fake `fetch`.
4. Run the conformance test (`src/host/conformance.test.ts`). It checks that every registered manifest is bound exactly once, that each connection implements exactly its declared capabilities and operations, and that every operation answers an empty body, an empty environment and a failing network without throwing and with a well-formed failure.
5. Document the environment variables in `.env.example` and the user-visible behaviour in [Settings and connections](../product/settings-and-connections.md).

## Design guidance

- Treat everything a service returns as untrusted input. Calendar events, messages and model output become proposals that wait in the Inbox; a connection never writes planning records directly.
- Prefer reading to writing. If a connection can change something outside the app, make the write opt-in and bound the damage (for example, require approval when a sync would delete more than a set number of items).
- Do not add a connection that needs a scraped or unofficial interface unless you are prepared to maintain it when the interface changes.
- Keep provider-specific wording out of core code. Core talks in capabilities; the provider's name appears only in its manifest and folder.
