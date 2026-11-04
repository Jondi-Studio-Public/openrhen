# Engine conformance runner

A dependency-free Node script (Node 22 or later) that sends a named list of wire fixtures to any
plan-and-forecast engine and checks the portable part of what comes back. Use it to see whether another
implementation of `POST /v1/plan-and-forecast` agrees with the reference engine on the cases the
reference engine is held to.

## Run it

```sh
PLAN_FORECAST_SERVICE_TOKEN=... node engine/service/conformance/run.mjs --url http://127.0.0.1:4000
```

`--token-env NAME` reads the bearer token from a different environment variable. The token is never
printed. `--fixtures DIR` points at a copy of the `snapshot-replay` directory. Exit code 0 means every
fixture passed, 1 means a fixture failed, 2 means a usage error.

```text
PASS  leave-by-allows-for-variability.json
PASS  tracked-overtime-keeps-return-leg.json
FAIL  travel-leg-protects-the-journey.json
        primary action: expected "write-chapter", got "other-action"
PASS  synthetic/after-work-steps-follow-overtime-finish.json
...

16/17 fixtures passed (portable assertions only)
```

## What it checks

The corpus is the named list `FIXTURES` in `run.mjs`: the three top-level fixtures and every file in
`synthetic/` under `engine/core/test/snapshot-replay/`. It is never a directory scan, so a private
capture cannot be picked up. For each fixture the runner sends its `request` and checks:

| Portable (required) | Reference-only (not checked) |
| --- | --- |
| HTTP 200 | `dayPlan` lines (exact blocks, minutes, order) |
| Response has the expected top-level shape | Directive `title` and `recommendedMinutes` |
| `requestId` echoed, `contractVersion` matches | Numeric `prepPace` fields (only its `status` is checked) |
| Primary recommended action id | |
| Critical tier of each named candidate | |
| Forecast health of each named project | |
| Current directive `kind` and `targetId` | |

The runner stays dependency-free, so it does only a shape check of the top-level fields a consumer reads.
The committed JSON Schemas in `platform/contracts/engine-wire/` (`plan-forecast-request.v1.schema.json` and
`plan-forecast-response.v1.schema.json`) are the authority: a conforming engine should validate against them
with any JSON Schema validator. A valid shape is necessary, not sufficient; the server is the authority.

## What a pass does not mean

A pass does not mean the engine is a drop-in replacement for the portal. The request is the portal state
shape (the `state` object the portal builds for the reference engine), so an engine that passes still has
to read that shape, and the exact day plan, wording and minutes remain the reference engine's policy.
