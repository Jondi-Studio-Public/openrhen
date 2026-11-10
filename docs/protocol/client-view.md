# Client view

What an installed app (or any other owner client) reads to show "what is on, what is next, what is waiting", and the one write it makes when a surface shows a check-in. Both routes are for the owner's own clients: an agent token is refused (`owner-only`), and both are open to a limited device credential (neither is `owner-admin`; see [Auth](auth.md#adding-a-phone-device-sign-in)). `GET /api/device/now`, the handheld's poll, is a different contract and is untouched.

## `GET /api/client/view?parts=now,day,pending`

`parts` is a comma list of `now`, `day` and `pending`; it defaults to all three, and an unknown part is a 400 that names it. A part appears only when asked for.

| Part | Holds | Built by |
|---|---|---|
| `now` | The Now answer: the directive and its why, running anchors, stale facts to ask about (`needs`), the stretch offer and the energy cost line. | `buildNowAnswer`, the function the web's Now and `rhen status` use |
| `day` | The day plan through local midnight: what is running and every block that starts today. | `buildDay`, as `rhen status` |
| `pending` | `checkIn` (the waiting one), `session` (the active one), `leaveBy` (the leg to leave for, only in its remind or leave phase and not suppressed) and `placeSuggestion` (a "move" suggestion from a phone reading). Each is `null` when there is none. | the check-in read, the state, `leaveByPrompts` (as the handheld) |

The envelope also carries `schemaVersion`, `timezone`, `planCurrent` and `validUntil` (when the plan behind `now` and `day` stops being current), so a cache can say "as of" and dim itself past it. Every instant is ISO 8601 with an offset; `Z` is the zero offset.

The response has an `ETag` over the whole body and answers `304` to a matching `If-None-Match` (quotes, a `W/` prefix, a list and `*` are all read). It is `Cache-Control: no-store`: revalidating by tag is the only caching wanted. Nothing in the body is a server clock reading, so a 304 means none of it changed.

**It never starts a check-in's timeout.** `pending.checkIn` is read without stamping `prompted_at`, so a widget or background refresh is not mistaken for the owner being shown the question. Without PostgreSQL `pending.checkIn` is `null` and the rest still answers.

## `POST /api/check-ins/{id}/shown`

No body. A surface calls it when it actually shows the check-in (a sheet opens, a local notification is posted). It stamps `prompted_at` once. The timeout rule is unchanged: it still counts from `prompted_at ?? created_at`, so a check-in no surface reached can still time out.

Answers `{ id, status, promptedAt, stamped }`. `stamped` is `true` on the call that recorded the time and `false` on any repeat, or for a check-in that is no longer pending, which changes nothing and returns what is stored. An id that is not the owner's check-in is a 404.

## Types and fixtures

The request and response types are zod schemas in `platform/contracts/src/client-view.ts` (`ClientView`, `CheckInShown`), exported as JSON Schema to `platform/contracts/client-view-schema.v1.json` (one `$defs` entry per type) with one or more examples per type in `platform/contracts/client-view-fixtures.v1.json`. A client decodes every fixture with its own types, so a change that breaks it fails in the same pull request. `portal/server/client-view-schema.test.ts` fails when either file is stale and parses each fixture with its schema; the commands to regenerate them are in the file's comments. Objects may gain fields, so a client ignores the ones it does not know.
